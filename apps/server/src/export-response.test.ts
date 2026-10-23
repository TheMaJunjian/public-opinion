import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { replayArchive } from '@gonglun/core';
import { archiveChangeFingerprint, type ArchiveCheckpoint, type Change } from '@gonglun/core';
import { createHash } from 'node:crypto';
import { Mutation } from './db.js';
import { cleanupTestDatabases, createTestApp } from './test-database.js';

afterEach(cleanupTestDatabases);

function checkpoint(archive: { regionId: string; ledgerId: string; changes: Change[] }): ArchiveCheckpoint {
  const hash = createHash('sha256');
  archive.changes.forEach(change => hash.update(archiveChangeFingerprint(change)));
  return { regionId: archive.regionId, ledgerId: archive.ledgerId, sequence: archive.changes.at(-1)?.sequence ?? 0,
    entryCount: archive.changes.length, hash: hash.digest('hex') };
}
const query = (base: ArchiveCheckpoint) => ({ after: base.sequence, baseCount: base.entryCount, baseHash: base.hash, regionId: base.regionId, ledgerId: base.ledgerId });

it('exports every committed record across page boundaries and detects a truncated final page', async () => {
  const app = await createTestApp();
  await app.store.transaction(async () => {
    for (let i = 0; i < 105; i++) {
      const tx = new Mutation(app.store);
      await tx.create('system', [{ id: 'body', type: 'text', text: `记录 ${i}` }]);
      await tx.commit();
    }
  });
  const response = await request(app).get('/api/ui/export');
  expect(response.status, response.text).toBe(200);
  const archive = response.body;
  expect(archive.messages).toHaveLength(105);
  expect(archive.changes).toHaveLength(105);
  expect(replayArchive(archive).changeCount).toBe(105);
  expect(() => replayArchive({ ...archive, changes: archive.changes.slice(0, 100) })).toThrow('不完整');
  expect(() => replayArchive({ ...archive, changes: archive.changes.filter((_: unknown, index: number) => index !== 50) })).toThrow('不连续');
});

it('transfers only missing history while refreshing the full current view, including changes to old messages', async () => {
  const app = await createTestApp();
  let firstId = '';
  await app.store.transaction(async () => {
    for (let i = 0; i < 105; i++) {
      const tx = new Mutation(app.store);
      const message = await tx.create('system', [{ id: 'body', type: 'text', text: `原记录 ${i}` }]);
      if (i === 0) firstId = message.id;
      await tx.commit();
    }
  });
  const original = (await request(app).get('/api/ui/export')).body;
  const base = checkpoint(original);
  await app.store.transaction(async () => {
    const tx = new Mutation(app.store), message = await app.store.message(firstId);
    await tx.put({ ...message, revision: 2, parts: [{ id: 'body', type: 'text', text: '旧消息已更新' }] });
    await tx.create('system', [{ id: 'body', type: 'text', text: '新增消息' }]);
    await tx.commit();
  });
  const response = await request(app).get('/api/ui/export').query(query(base));
  expect(response.status, response.text).toBe(200);
  const delta = response.body;
  expect(delta.format).toBe('gonglun-2-update');
  expect(delta.base).toEqual(base);
  expect(delta.changes).toHaveLength(1);
  expect(delta.changes[0].previousSequence).toBe(base.sequence);
  expect(delta.messages.find((message: { id: string }) => message.id === firstId).content).toBe('旧消息已更新');
  const full = (await request(app).get('/api/ui/export')).body;
  for (const key of ['messages', 'relations', 'users', 'stakes', 'tagCounts', 'attentionUsers', 'ruleHistory', 'signatures', 'journal']) {
    expect(delta[key], key).toEqual(full[key]);
  }
  expect(replayArchive({ ...full, changes: [...original.changes, ...delta.changes] }).changeCount).toBe(106);
  const unchanged = await request(app).get('/api/ui/export').query(query(checkpoint(full)));
  expect(unchanged.status, unchanged.text).toBe(200);
  expect(unchanged.body.changes).toEqual([]);
  expect(unchanged.body.journal).toEqual(full.journal);
});

it('refuses another dataset, changed earlier history, invalid cursors and incomplete checkpoint parameters', async () => {
  const app = await createTestApp();
  await app.store.transaction(async () => {
    for (let i = 0; i < 2; i++) {
      const tx = new Mutation(app.store);
      await tx.create('system', [{ id: 'body', type: 'text', text: `记录 ${i}` }]);
      await tx.commit();
    }
  });
  const archive = (await request(app).get('/api/ui/export')).body;
  const base = checkpoint(archive);
  const altered = structuredClone(archive);
  altered.changes[0].messages[0].parts[0].text = '被替换的早期记录';
  for (const invalid of [{ ...base, regionId: 'another' }, checkpoint(altered), { ...base, sequence: base.sequence + 1 }, { ...base, entryCount: 1 }]) {
    const response = await request(app).get('/api/ui/export').query(query(invalid));
    expect(response.status, response.text).toBe(409);
    expect(response.body).not.toHaveProperty('changes');
  }
  expect((await request(app).get('/api/ui/export').query({ after: 1 })).status).toBe(400);
  expect((await request(app).get('/api/ui/export').query({ ...query(base), after: -1 })).status).toBe(400);
});

it('updates a verified empty archive without requiring a committed cursor', async () => {
  const app = await createTestApp();
  const archive = (await request(app).get('/api/ui/export')).body;
  const response = await request(app).get('/api/ui/export').query(query(checkpoint(archive)));
  expect(response.status, response.text).toBe(200);
  expect(response.body.changes).toEqual([]);
  expect(response.body.journal).toMatchObject({ entryCount: 0, lastSequence: 0 });
});
