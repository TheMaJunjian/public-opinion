import { afterEach, describe, expect, it } from 'vitest';
import { bindRoles, replayArchive, textOf, type Message } from '@gonglun/core';
import { Mutation } from '../../server/src/db.js';
import { cleanupTestDatabases, createTestStore } from '../../server/src/test-database.js';
import { restoreDelegationBody } from './delegation-format.js';
import { migrateViewFile } from './migrate-view-file.js';
import { completeMessageFormats } from './complete-message-formats.js';
import { financialFingerprint } from './financial-fingerprint.js';

afterEach(cleanupTestDatabases);

describe('historical delegation bodies', () => {
  const parts = (fulfill: boolean): Message['parts'] => [
    { id: 'body', type: 'text', text: fulfill ? '建立关系：DELEGATION；目标：12345678' : '建立关系：DELEGATION' },
    { id: 'relation', type: 'relation', relation: fulfill ? 'fulfill' : 'delegate', roles: bindRoles({ target: fulfill ? [{ messageId: 'task-12345678' }] : [] }) },
    { id: 'data', type: 'data', value: { uiType: 'DELEGATION', delegationKind: fulfill ? 'FULFILL' : 'CREATE', content: fulfill ? '完成说明=已完成' : '报酬数量=100\n委托内容=喝水', ...(fulfill ? {} : { rewardAmount: 100 }) } },
  ];

  it.each([false, true])('converts an offline delegation without native parts and preserves its body address (fulfill=%s)', fulfill => {
    const source = { messages: [{ id: 'task-12345678', kind: 'RELATION', relationType: 'DELEGATION', content: '建立关系：DELEGATION', relationPayload: { delegationKind: 'CREATE', content: '报酬数量=100\n委托内容=喝水' } },
      ...(fulfill ? [{ id: 'completion', kind: 'RELATION', relationType: 'DELEGATION', content: '建立关系：DELEGATION；目标：12345678',
        targetRefs: [{ kind: 'message', messageId: 'task-12345678' }], relationPayload: { delegationKind: 'FULFILL', content: '完成说明=已完成' } }] : [])] };
    const result = migrateViewFile(source), message = result.messages.at(-1);
    expect(message.parts.find((part: Message['parts'][number]) => part.id === 'body').text).toBe(fulfill ? '完成说明=已完成' : '报酬数量=100\n委托内容=喝水');
    expect(message.content).toBe(textOf(message));
    expect(migrateViewFile(result)).toEqual(result);
    expect(source.messages[0].content).toBe('建立关系：DELEGATION');
  });

  it('preserves authored text, a description quoted inside a longer body, and delegations without saved content', () => {
    for (const body of ['手写内容', '建立关系：DELEGATION\n这是手写说明']) {
      const message = { parts: parts(false) } as Message;
      (message.parts[0] as { text: string }).text = body;
      expect(restoreDelegationBody(message)).toBe(false);
      expect(textOf(message)).toBe(body);
    }
    const message = { parts: parts(false).filter(part => part.type !== 'data') } as Message;
    expect(restoreDelegationBody(message)).toBe(false);
  });

  it('repairs current records, revisions, journals and retry results once without changing funds or signed requests', async () => {
    const store = await createTestStore();
    await store.transaction(async () => {
      const tx = new Mutation(store);
      const task = await tx.create('system', parts(false), undefined, 'task-12345678');
      const completion = await tx.create('system', parts(true), undefined, 'completion');
      await tx.commit();
      for (const table of ['requests', 'command_requests']) await store.db.prepare(`INSERT INTO ${table} VALUES($1,$2,$3,$4)`)
        .run('system', 'request', JSON.stringify({ content: '原签名输入' }), JSON.stringify({ messages: [task, completion], input: { content: '原签名输入' } }));
    });
    const before = await financialFingerprint(store.db);
    await store.transaction(() => completeMessageFormats(store));
    expect(await financialFingerprint(store.db)).toBe(before);
    expect(textOf(await store.message('task-12345678'))).toBe('报酬数量=100\n委托内容=喝水');
    expect(textOf(await store.message('completion'))).toBe('完成说明=已完成');
    for (const row of await store.db.prepare('SELECT body FROM revisions').all()) expect(textOf(JSON.parse(String(row.body)))).not.toContain('建立关系');
    for (const table of ['requests', 'command_requests']) {
      const row = (await store.db.prepare(`SELECT input,result FROM ${table}`).get())!;
      expect(JSON.parse(String(row.input))).toEqual({ content: '原签名输入' });
      expect(JSON.parse(String(row.result))).toMatchObject({ input: { content: '原签名输入' } });
      expect(JSON.parse(String(row.result)).messages.map(textOf)).toEqual(['报酬数量=100\n委托内容=喝水', '完成说明=已完成']);
    }
    const changes = (await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row => JSON.parse(String(row.body)));
    const replay = replayArchive({ format: 'gonglun-2', changes });
    expect(replay.messages.map(textOf)).toEqual(['报酬数量=100\n委托内容=喝水', '完成说明=已完成']);
    expect((await store.db.prepare("SELECT body FROM message_format_backups WHERE table_name='messages' AND row_key='completion'").get())?.body).toContain('建立关系');
    await store.transaction(() => completeMessageFormats(store));
    expect((await store.db.prepare('SELECT COUNT(*) n FROM changes').get())?.n).toBe(changes.length);
  });
});
