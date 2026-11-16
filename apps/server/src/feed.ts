import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FeedItem, FeedMode, FeedPage, FeedPreview } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { inaccessibleMessages } from './moderation-visibility.js';
import { retiredOrganizationIds } from './retired-organizations.js';
import { recommendedAncestors } from './recommended-memberships.js';

export const feedQuerySchema = z.object({ mode: z.enum(['recommended', 'following', 'latest']).default('recommended'),
  limit: z.coerce.number().int().min(1).max(30).default(20), cursor: z.string().max(1000).optional() }).strict();
export const feedRefreshSchema = feedQuerySchema.omit({ cursor: true }).extend({
  limit: z.number().int().min(1).max(400).default(20), retain: z.array(z.string().min(1).max(200)).max(400).default([]),
});
export const feedHiddenSchema = z.object({ messageId: z.string().min(1).max(200), hidden: z.boolean() }).strict();
type Query = z.infer<typeof feedQuerySchema> & { retain?: string[] };
interface Entry extends FeedPreview { authorId: string; sequence: number; groupId: string }
interface Signals { followed: Set<string>; related: Set<string>; hidden: Set<string>; read: Set<string>; ancestors: Map<string, string[]> }
interface Group { id: string; updates: string[]; score: number; sequence: number; authorId: string }
interface Session { userId: string; mode: FeedMode; expires: number; groups: Group[] }
const sessions = new WeakMap<Store, Map<string, Session>>();
const SESSION_TTL = 10 * 60_000;
const CANDIDATES = 180;

const select = `SELECT e.*,COALESCE(mm."parentId",e."contextId",e.id) AS "groupId",COALESCE(u.name,'与会者') AS username,
  EXISTS(SELECT 1 FROM feed_corrections c WHERE c."targetId"=e.id) AS "hasCorrections"
  FROM feed_entries e LEFT JOIN recommended_memberships mm ON mm."memberId"=e.id LEFT JOIN users u ON u.id=e."authorId"`;
function entries(rows: Array<Record<string, any>>): Entry[] {
  return rows.map(row => ({ ...row, author: { id: row.authorId, username: row.username } } as Entry));
}
async function loadEntries(store: Store, ids: string[]) {
  return ids.length ? entries(await store.db.prepare(`${select} WHERE e.id=ANY($1::text[])`).all(ids)) : [];
}
function preview(entry: Entry): FeedPreview {
  return { id: entry.id, revision: entry.revision, excerpt: entry.excerpt, kind: entry.kind, author: entry.author,
    createdAt: entry.createdAt, updatedAt: entry.updatedAt, hasCorrections: entry.hasCorrections };
}
async function signals(store: Store, userId: string, rows: Entry[]): Promise<Signals> {
  const ancestors = await recommendedAncestors(store, rows.map(row => row.id));
  const ids = [...new Set(rows.flatMap(row => [row.id, row.groupId, ...ancestors.get(row.id) ?? []]))];
  const result: Signals = { followed: new Set(), related: new Set(), hidden: new Set(), read: new Set(), ancestors };
  if (!ids.length) return result;
  const marks = await store.db.prepare(`SELECT "targetId",family,action FROM personal_marks
    WHERE "authorId"=$1 AND "targetId"=ANY($2::text[]) AND family IN ('follow','block','read','archive')`).all(userId, ids);
  for (const mark of marks) {
    if (mark.action === 'block' || mark.action === 'archive') result.hidden.add(String(mark.targetId));
    if (mark.action === 'read') result.read.add(String(mark.targetId));
  }
  const following = new Map(marks.filter(mark => mark.family === 'follow').map(mark => [String(mark.targetId), mark.action === 'follow']));
  for (const row of rows) {
    // The nearest explicit decision wins, so unfollowing a child excludes that subtree.
    const decision = [row.id, ...ancestors.get(row.id) ?? [], row.groupId].find(id => following.has(id));
    if (decision && following.get(decision)) result.followed.add(row.id);
  }
  const hidden = await store.db.prepare('SELECT "messageId" FROM feed_hidden WHERE "userId"=$1 AND "messageId"=ANY($2::text[])').all(userId, ids);
  for (const row of hidden) result.hidden.add(String(row.messageId));
  for (const id of await retiredOrganizationIds(store)) result.hidden.add(id);
  if ((await store.rules()).moderation?.enabled) {
    const rejected = await store.db.prepare(`SELECT target.id FROM unnest($2::text[]) AS target(id)
      JOIN LATERAL (SELECT id,round FROM moderation_cases WHERE "messageId"=target.id ORDER BY revision DESC LIMIT 1) c ON TRUE
      JOIN LATERAL (SELECT verdict FROM moderation_votes WHERE "caseId"=c.id AND round=c.round AND "userId"=$1 ORDER BY position DESC LIMIT 1) v ON TRUE
      WHERE v.verdict='reject'`).all<{ id: string }>(userId, ids);
    for (const row of rejected) result.hidden.add(row.id);
  }
  const reading = await store.db.prepare(`SELECT "messageId",body FROM reading_marks
    WHERE "userId"=$1 AND "messageId"=ANY($2::text[]) AND scope='message'`).all(userId, ids);
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of reading) {
    result.read.delete(String(row.messageId));
    if (row.body.state !== 'UNREAD' && row.body.version?.revision === byId.get(String(row.messageId))?.revision) result.read.add(String(row.messageId));
  }
  const related = await store.db.prepare(`SELECT "sourceId","targetId",body->>'navigationId' AS navigation FROM (
    SELECT "sourceId","targetId",body FROM notifications WHERE "userId"=$1 AND "deletedAt" IS NULL ORDER BY id DESC LIMIT 120
  ) recent`).all(userId);
  for (const row of related) for (const id of [row.sourceId, row.targetId, row.navigation]) if (typeof id === 'string') result.related.add(id);
  for (const row of rows) if (row.authorId === userId) result.related.add(row.id);
  return result;
}
const follows = (row: Entry, state: Signals) => state.followed.has(row.id);
const relevant = (row: Entry, state: Signals) => state.related.has(row.id) || state.related.has(row.groupId);
const excluded = (row: Entry, state: Signals) => [row.id, row.groupId, ...state.ancestors.get(row.id) ?? []].some(id => state.hidden.has(id));
const reasons = (row: Entry, state: Signals, mode: FeedMode): string[] => mode === 'latest' ? ['按发布时间和更新顺序展示']
  : [follows(row, state) ? '你关注的消息或分类' : relevant(row, state) ? '与你的参与有关' : '近期讨论，发现新的内容'];

/** Every content message competes independently, regardless of classification depth. */
async function createSession(store: Store, userId: string, mode: FeedMode, retained: string[] = []): Promise<Session> {
  const recent = mode === 'following' ? [] : entries(await store.db.prepare(`${select} ORDER BY e.sequence DESC,e.id DESC LIMIT $1`).all(CANDIDATES));
  const followed = await store.db.prepare(`WITH RECURSIVE watched AS (
    SELECT "targetId" FROM personal_marks WHERE "authorId"=$1 AND family='follow' AND action='follow' ORDER BY sequence DESC LIMIT 200
  ), tree(id) AS (
    SELECT "targetId" FROM watched
    UNION SELECT mm."memberId" FROM tree t JOIN recommended_memberships mm ON mm."parentId"=t.id
      WHERE NOT EXISTS(SELECT 1 FROM personal_marks p WHERE p."authorId"=$1 AND p.family='follow' AND p.action='unfollow' AND p."targetId"=mm."memberId")
  ), ids AS (
    SELECT e.id FROM tree t JOIN feed_entries e ON e.id=t.id
    UNION SELECT e.id FROM tree t JOIN feed_entries e ON e."contextId"=t.id
  ) SELECT e.id FROM ids JOIN feed_entries e ON e.id=ids.id ORDER BY e.sequence DESC,e.id DESC LIMIT 120`).all<{ id: string }>(userId);
  const relevantIds = mode === 'following' ? [] : await store.db.prepare(`WITH recent AS (
    SELECT "sourceId","targetId",body->>'navigationId' AS navigation FROM notifications
    WHERE "userId"=$1 AND "deletedAt" IS NULL ORDER BY id DESC LIMIT 80
  ) SELECT DISTINCT e.id FROM recent n JOIN feed_entries e ON e.id=n."sourceId" OR e.id=n."targetId" OR e.id=n.navigation`).all<{ id: string }>(userId);
  const candidates = [...new Map([...recent, ...await loadEntries(store, [...new Set([...followed, ...relevantIds].map(row => row.id).concat(retained))])].map(row => [row.id, row])).values()]
    .sort((a, b) => b.sequence - a.sequence || b.id.localeCompare(a.id));
  const state = await signals(store, userId, candidates), blocked = await inaccessibleMessages(store, candidates.map(row => row.id), userId);
  const available = new Map(candidates.filter(row => !blocked.has(row.id) && !excluded(row, state)).map(row => [row.id, row]));
  const groups = new Map<string, Group>();
  for (const row of candidates) {
    if (!available.has(row.id) || mode === 'following' && !follows(row, state)) continue;
    const age = Math.max(0, (Date.now() - Date.parse(row.updatedAt)) / 86400000);
    const score = (follows(row, state) ? 60 : 0) + (relevant(row, state) ? 30 : 0) + (!state.read.has(row.id) ? 8 : 0) + 14 / (1 + (Number.isFinite(age) ? age : 0));
    groups.set(row.id, { id: row.id, updates: [], score, sequence: row.sequence, authorId: row.authorId });
  }
  const remaining = [...groups.values()].sort((a, b) => (mode === 'recommended' ? b.score - a.score : 0) || b.sequence - a.sequence || b.id.localeCompare(a.id));
  const ordered: Group[] = [];
  while (remaining.length) {
    // Reserve discovery positions and avoid long runs from one author. This does not change truth or stance.
    const discovery = mode === 'recommended' && ordered.length % 5 === 4 ? remaining.findIndex(group => group.score < 30) : -1;
    const differentAuthor = mode === 'recommended' && ordered.length >= 2 && ordered.at(-1)!.authorId === ordered.at(-2)!.authorId
      ? remaining.findIndex(group => group.authorId !== ordered.at(-1)!.authorId) : -1;
    const index = differentAuthor >= 0 ? differentAuthor : discovery >= 0 ? discovery : 0;
    ordered.push(remaining.splice(index, 1)[0]!);
  }
  return { userId, mode, expires: Date.now() + SESSION_TTL, groups: ordered };
}
function remember(store: Store, session: Session): string {
  let cache = sessions.get(store);
  if (!cache) { cache = new Map(); sessions.set(store, cache); }
  for (const [key, value] of cache) if (value.expires <= Date.now()) cache.delete(key);
  while (cache.size >= 128) cache.delete(cache.keys().next().value!);
  const key = randomUUID(); cache.set(key, session); return key;
}

export async function feedPage(store: Store, userId: string, query: Query): Promise<FeedPage> {
  if (query.mode === 'latest') return latestPage(store, userId, query);
  let session: Session, key: string, offset = 0;
  if (query.cursor) {
    const match = /^([a-f0-9-]{36}):(\d{1,4})$/.exec(query.cursor);
    const cached = match ? sessions.get(store)?.get(match[1]!) : undefined;
    if (!cached || cached.userId !== userId || cached.mode !== query.mode || cached.expires <= Date.now())
      throw new DomainError('这批推荐已更新，请刷新后继续浏览', 409, 'FEED_EXPIRED');
    session = cached; key = match![1]!; offset = Number(match![2]);
    if (offset > session.groups.length) throw new DomainError('分页游标无效');
  } else { session = await createSession(store, userId, query.mode, query.retain); key = remember(store, session); }
  const items: FeedItem[] = [];
  // The cached order contains only IDs. Every page rechecks current preferences and readability.
  while (offset < session.groups.length && items.length < query.limit) {
    const batch = session.groups.slice(offset, offset + query.limit - items.length);
    const rows = await loadEntries(store, [...new Set(batch.flatMap(group => [group.id, ...group.updates]))]);
    const state = await signals(store, userId, rows), blocked = await inaccessibleMessages(store, rows.map(row => row.id), userId);
    const available = new Map(rows.filter(row => !blocked.has(row.id) && !excluded(row, state)).map(row => [row.id, row]));
    for (const group of batch) {
      offset++;
      const root = available.get(group.id); if (!root) continue;
      const updates = group.updates.flatMap(id => { const row = available.get(id); return row && row.groupId === root.id ? [row] : []; });
      if (query.mode === 'following' && ![root, ...updates].some(row => follows(row, state))) continue;
      const reason = [root, ...updates].find(row => follows(row, state)) ?? [root, ...updates].find(row => relevant(row, state)) ?? root;
      items.push({ ...preview(root), reasons: reasons(reason, state, query.mode), updates: updates.map(preview) });
    }
  }
  return { mode: query.mode, items, nextCursor: offset < session.groups.length ? `${key}:${offset}` : null };
}

const latestCursor = z.object({ through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), id: z.string().max(200) }).strict();
async function latestPage(store: Store, userId: string, query: Query): Promise<FeedPage> {
  let cursor: z.infer<typeof latestCursor>;
  try { cursor = query.cursor ? latestCursor.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')))
    : { through: await store.latestSequence(), sequence: Number.MAX_SAFE_INTEGER, id: '' }; }
  catch { throw new DomainError('分页游标无效'); }
  const items: FeedItem[] = [];
  let more = false;
  // Bounded scans also cope with batches of rejected, blocked or hidden content.
  for (let scan = 0; scan < 5 && items.length < query.limit; scan++) {
    const rows = entries(await store.db.prepare(`${select} WHERE e.sequence<=$1 AND (e.sequence,e.id)<($2,$3)
      ORDER BY e.sequence DESC,e.id DESC LIMIT 80`).all(cursor.through, cursor.sequence, cursor.id));
    const state = await signals(store, userId, rows), blocked = await inaccessibleMessages(store, rows.map(row => row.id), userId);
    more = rows.length === 80;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!; cursor = { ...cursor, sequence: row.sequence, id: row.id };
      if (!blocked.has(row.id) && !excluded(row, state)) items.push({ ...preview(row), reasons: reasons(row, state, 'latest'), updates: [] });
      if (items.length === query.limit) { more ||= index < rows.length - 1; break; }
    }
    if (!more) break;
  }
  return { mode: 'latest', items, nextCursor: more ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null };
}

export async function hideFeedMessage(store: Store, userId: string, messageId: string, hidden: boolean) {
  if (hidden) {
    if (!(await store.db.prepare('SELECT 1 FROM feed_entries WHERE id=$1').get(messageId))) throw new DomainError('消息不存在', 404);
    await store.db.prepare('INSERT INTO feed_hidden("userId","messageId") VALUES($1,$2) ON CONFLICT DO NOTHING').run(userId, messageId);
  } else await store.db.prepare('DELETE FROM feed_hidden WHERE "userId"=$1 AND "messageId"=$2').run(userId, messageId);
}
