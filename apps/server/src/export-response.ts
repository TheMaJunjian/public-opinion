import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { archiveChangeFingerprint, type ArchiveCheckpoint, type Change, type JournalManifest, type Message } from '@gonglun/core';
import { currentSession } from './auth.js';
import { DomainError, type Store } from './db.js';
import { attentionUsers, scopeSql, scopeView, stakesFor, tagCountsFor, usersFor, viewsFor } from './ui-projections.js';

export async function journalManifest(store: Store): Promise<JournalManifest> {
  const row = (await store.db.prepare('SELECT COUNT(*) AS count,COALESCE(MAX(sequence),0) AS last FROM changes').get())!;
  return { version: 1, entryCount: Number(row.count), lastSequence: Number(row.last) };
}

async function verifyCheckpoint(store: Store, base: ArchiveCheckpoint): Promise<void> {
  if (base.regionId !== await store.setting('region') || base.ledgerId !== 'local') {
    throw new DomainError('旧文件来自另一份公论数据，请回到原服务更新', 409);
  }
  const hash = createHash('sha256');
  let after = 0, count = 0;
  while (after < base.sequence) {
    const rows = await store.db.prepare('SELECT sequence,body FROM changes WHERE sequence>$1 AND sequence<=$2 ORDER BY sequence LIMIT 100').all(after, base.sequence);
    if (!rows.length) break;
    for (const row of rows) {
      hash.update(archiveChangeFingerprint(JSON.parse(String(row.body)) as Change));
      after = Number(row.sequence);
      count++;
    }
  }
  if (after !== base.sequence || count !== base.entryCount || hash.digest('hex') !== base.hash) {
    throw new DomainError('旧文件与当前执行历史不一致，请重新完整导出', 409);
  }
}

/** One repeatable-read snapshot, bounded pages and socket backpressure throughout the export. */
export async function sendExport(store: Store, req: Request, res: Response, parent: string, base?: ArchiveCheckpoint): Promise<void> {
  if (base) await verifyCheckpoint(store, base);
  const scope = await scopeView(store, parent), journal = await journalManifest(store);
  const metadata = { format: base ? 'gonglun-2-update' : 'gonglun-2', formatVersion: 3, exportedAt: new Date().toISOString(), scope,
    viewerUsername: (await currentSession(store, req))?.user.username ?? null, rules: await store.rules(),
    regionId: await store.setting('region'), ledgerId: 'local', programVersion: '2.0.0',
    sequence: journal.lastSequence, auditScope: 'region', viewScope: { parent }, journal, ...(base ? { base } : {}) };
  const write = async (value: string) => {
    if (res.destroyed || res.writableEnded) throw new Error('导出连接已关闭');
    if (res.write(value)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('导出连接已关闭')); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      res.once('drain', drained); res.once('close', closed); res.once('error', failed);
    });
  };
  async function array(name: string, values: AsyncIterable<unknown>) {
    await write(`,${JSON.stringify(name)}:[`);
    let separator = '';
    for await (const value of values) { await write(separator + JSON.stringify(value)); separator = ','; }
    await write(']');
  }
  async function* messagePages() {
    const selected = scopeSql(parent);
    let cursor: { at: string; id: string } | undefined;
    while (!res.destroyed) {
      const params: unknown[] = [...selected.params];
      const after = cursor ? ` AND (m."createdAt",m.id)>($${params.length + 1},$${params.length + 2})` : '';
      if (cursor) params.push(cursor.at, cursor.id);
      const rows = await store.db.prepare(`${selected.cte} SELECT m.body FROM messages m WHERE ${selected.predicate}${after} ORDER BY m."createdAt",m.id LIMIT 200`).all(...params);
      if (!rows.length) return;
      const messages = rows.map(row => JSON.parse(String(row.body)) as Message);
      yield messages;
      const last = messages.at(-1)!; cursor = { at: last.createdAt, id: last.id };
    }
    throw new Error('导出连接已关闭');
  }
  async function* messageViews(onlyRelations: boolean) {
    for await (const messages of messagePages()) {
      for (const view of await viewsFor(store, messages, parent)) {
        if (!onlyRelations || view.relationType) yield { ...view, authorId: view.createdBy.id, author: view.createdBy.username };
      }
    }
  }
  async function map(name: string, project: (ids: string[]) => Promise<Record<string, unknown>>) {
    await write(`,${JSON.stringify(name)}:{`);
    let separator = '';
    for await (const messages of messagePages()) {
      for (const [key, value] of Object.entries(await project(messages.map(message => message.id)))) {
        await write(separator + JSON.stringify(key) + ':' + JSON.stringify(value)); separator = ',';
      }
    }
    await write('}');
  }
  async function* changes() {
    let after = base?.sequence ?? 0;
    while (!res.destroyed) {
      const rows = await store.db.prepare('SELECT sequence,body FROM changes WHERE sequence>$1 ORDER BY sequence LIMIT 100').all(after);
      if (!rows.length) return;
      for (const row of rows) { yield JSON.parse(String(row.body)); after = Number(row.sequence); }
    }
    throw new Error('导出连接已关闭');
  }
  async function* users() {
    let after = 0;
    while (!res.destroyed) {
      const rows = await store.db.prepare('SELECT id,position FROM users WHERE position>$1 ORDER BY position LIMIT 200').all(after);
      if (!rows.length) return;
      yield* await usersFor(store, rows.map(row => String(row.id)));
      after = Number(rows.at(-1)!.position);
    }
    throw new Error('导出连接已关闭');
  }
  async function* rules() {
    let after = 0;
    while (!res.destroyed) {
      const rows = await store.db.prepare('SELECT * FROM rule_versions WHERE version>$1 ORDER BY version LIMIT 100').all(after);
      if (!rows.length) return;
      for (const { body, ...row } of rows) { yield { ...row, rules: JSON.parse(String(body)) }; after = Number(row.version); }
    }
    throw new Error('导出连接已关闭');
  }
  async function* signatures() {
    let at = '', id = '';
    while (!res.destroyed) {
      const rows = await store.db.prepare('SELECT * FROM signatures WHERE ("createdAt","messageId")>($1,$2) ORDER BY "createdAt","messageId" LIMIT 100').all(at, id);
      if (!rows.length) return;
      yield* rows;
      const last = rows.at(-1)!; at = String(last.createdAt); id = String(last.messageId);
    }
    throw new Error('导出连接已关闭');
  }
  res.type('json').set('Cache-Control', 'no-store');
  try {
    await write(JSON.stringify(metadata).slice(0, -1));
    await array('messages', messageViews(false));
    await array('relations', messageViews(true));
    await array('users', users());
    await map('stakes', ids => stakesFor(store, ids));
    await map('tagCounts', ids => tagCountsFor(store, ids));
    await map('attentionUsers', ids => attentionUsers(store, ids));
    await array('ruleHistory', rules());
    await array('changes', changes());
    await array('signatures', signatures());
    await write('}');
    res.end();
  } catch (error) { res.destroy(); throw error; }
}
