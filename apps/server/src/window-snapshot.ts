import { isRelationView, relations, type Message, type WorkbenchSnapshot } from '@gonglun/core';
import { z } from 'zod';
import { DomainError, type Store } from './db.js';
import { attentionUsers, scopeSql, scopeView, stakesFor, tagCountsFor, usersFor, viewsFor } from './ui-projections.js';

const input = z.object({
  parent: z.string().min(1).max(100).default('root'), mode: z.literal('window'),
  limit: z.number().int().min(1).max(50).default(50), cursor: z.string().max(1000).optional(),
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  regionId: z.string().max(100).optional(), ids: z.array(z.string().min(1).max(100)).max(50).optional(),
  knownIds: z.array(z.string().min(1).max(100)).max(20000).default([]),
  viewParent: z.string().min(1).max(100).optional(),
  relatedTo: z.string().min(1).max(100).optional(),
});
const cursorSchema = z.object({ sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), id: z.string().max(100) });
const cursorFor = (message: Message) => Buffer.from(JSON.stringify({ sequence: message.sequence, id: message.id })).toString('base64url');

/** One page and bounded context; closed containers do not expand their members. */
export async function windowSnapshot(store: Store, raw: unknown): Promise<WorkbenchSnapshot> {
  const query = input.parse(raw), { parent, limit, knownIds } = query;
  const regionId = await store.setting<string>('region'), sequence = await store.latestSequence();
  if (query.after !== undefined && ((query.regionId !== undefined && query.regionId !== regionId) || query.after > sequence))
    throw new DomainError('本地消息缓存已失效，请重新加载', 409);
  const scope = await scopeView(store, parent);
  const params: unknown[] = [query.relatedTo ?? query.viewParent ?? parent];
  const clauses = [query.relatedTo ? `EXISTS(SELECT 1 FROM refs r WHERE (r."sourceId"=m.id AND r."targetId"=$1) OR (r."targetId"=m.id AND r."sourceId"=$1))`
    : `COALESCE((SELECT membership."parentId" FROM memberships membership WHERE membership."memberId"=m.id),'root')=$1
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.body::jsonb->'parts') part WHERE part->>'relation'='member-of' AND part->'roles' ? 'member')`];
  if (query.cursor) {
    let cursor: z.infer<typeof cursorSchema>;
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString())); }
    catch { throw new DomainError('分页游标无效'); }
    params.push(cursor.sequence, cursor.id);
    clauses.push('(m.sequence<$2 OR (m.sequence=$2 AND m.id<$3))');
  }
  if (query.after !== undefined) {
    params.push(query.after);
    const after = `$${params.length}`;
    // Moving a message changes its membership, not the sequence of its body.
    // Include newly visible old members without expanding any closed container.
    clauses.push(`(m.sequence>${after} OR m.id IN (
      SELECT item->>'memberId' FROM changes c, jsonb_array_elements(c.body::jsonb->'memberships') item WHERE c.sequence>${after}
      UNION SELECT jsonb_array_elements_text(c.body::jsonb->'removedMemberships') FROM changes c WHERE c.sequence>${after}
    ))`);
  }
  params.push(limit + 1);
  const rows = query.ids ? await store.db.prepare('SELECT body FROM messages WHERE id=ANY($1::text[]) ORDER BY sequence DESC,id DESC').all(query.ids)
    : await store.db.prepare(`SELECT m.body FROM messages m WHERE ${clauses.join(' AND ')} ORDER BY m.sequence DESC,m.id DESC LIMIT $${params.length}`).all(...params);
  const selected = rows.slice(0, limit).map(row => JSON.parse(String(row.body)) as Message);
  if (query.ids && selected.length !== new Set(query.ids).size) throw new DomainError('消息不存在', 404);
  const nextCursor = !query.ids && rows.length > limit ? cursorFor(selected.at(-1)!) : null;
  let removedMessageIds: string[] = [];
  if (query.after !== undefined && knownIds.length) {
    const affected = await store.db.prepare(`WITH recent AS (SELECT body::jsonb AS data FROM changes WHERE sequence>$1), affected(id) AS (
      SELECT item->>'id' FROM recent, jsonb_array_elements(data->'messages') item
      UNION SELECT item->>'messageId' FROM recent, jsonb_array_elements(data->'states') item
      UNION SELECT item->>'memberId' FROM recent, jsonb_array_elements(data->'memberships') item
      UNION SELECT item->>'parentId' FROM recent, jsonb_array_elements(data->'memberships') item
      UNION SELECT jsonb_array_elements_text(data->'removedMemberships') FROM recent
    ) SELECT id FROM affected WHERE id=ANY($2::text[])`).all(query.after, knownIds);
    const scoped = scopeSql(parent);
    const present = await store.db.prepare(`${scoped.cte} SELECT m.id FROM messages m WHERE ${scoped.predicate} AND m.id=ANY($${scoped.params.length + 1}::text[])`).all(...scoped.params, knownIds);
    const presentIds = new Set(present.map(row => String(row.id)));
    if (knownIds.includes(parent)) presentIds.add(parent);
    removedMessageIds = knownIds.filter(id => !presentIds.has(id));
    const changedIds = affected.map(row => String(row.id)).filter(id => presentIds.has(id));
    for (let offset = 0; offset < changedIds.length; offset += 200) {
      const changed = await store.db.prepare('SELECT body FROM messages WHERE id=ANY($1::text[])').all(changedIds.slice(offset, offset + 200));
      selected.push(...changed.map(row => JSON.parse(String(row.body)) as Message));
    }
  }
  const messages = new Map(selected.map(message => [message.id, message]));
  const seeds = [...messages.keys()];
  if (seeds.length) {
    const expandable = selected.filter(message => !relations(message).some(part => ['classify', 'summary', 'merge', 'arrange', ...(query.relatedTo ? [] : ['member-of'])].includes(part.relation))).map(message => message.id);
    const context = await store.db.prepare(`SELECT body FROM messages WHERE id IN (
      SELECT "targetId" FROM refs WHERE "sourceId"=ANY($1::text[])
      UNION SELECT "sourceId" FROM memberships WHERE "memberId"=ANY($2::text[])
      UNION SELECT "parentId" FROM memberships WHERE "memberId"=ANY($2::text[])
    ) AND NOT(id=ANY($2::text[])) ORDER BY sequence DESC,id DESC LIMIT 100`).all(expandable, seeds);
    for (const row of context) { const message = JSON.parse(String(row.body)) as Message; messages.set(message.id, message); }
    const attached = await store.db.prepare(`SELECT m.body FROM messages m JOIN refs r ON r."sourceId"=m.id
      WHERE r."targetId"=ANY($1::text[]) AND NOT(m.id=ANY($1::text[]))
      GROUP BY m.id ORDER BY m.sequence DESC,m.id DESC LIMIT 50`).all(seeds);
    for (const row of attached) { const message = JSON.parse(String(row.body)) as Message; messages.set(message.id, message); }
  }
  const records = [...messages.values()], ids = records.map(message => message.id);
  const users = await usersFor(store, records.map(message => message.authorId));
  const views = await viewsFor(store, records, parent, users);
  return { regionId, windowed: true, scope, sequence, messages: views, relations: views.filter(isRelationView), users,
    stakes: await stakesFor(store, ids, users), tagCounts: await tagCountsFor(store, ids), attentionUsers: await attentionUsers(store, ids),
    hasMore: false, removedMessageIds, ...(query.after === undefined || nextCursor ? { nextCursor } : {}),
  };
}
