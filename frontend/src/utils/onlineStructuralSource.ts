import type { WorkbenchSnapshot, SnapshotQuery } from '../data/workbench';
import type { ExportData } from '../api/client';
import { createScopedProjectionCache } from './scopedProjectionCache';
import { startWorkbenchTiming } from './workbenchTiming';
import type { CatalogUpdate } from '../data/globalCatalog';

type Body = { message: WorkbenchSnapshot['messages'][number]; relation?: WorkbenchSnapshot['relations'][number];
  stake?: WorkbenchSnapshot['stakes'][string]; tags?: WorkbenchSnapshot['tagCounts'][string]; attention?: string[] };
type Source = { snapshot: WorkbenchSnapshot; load(query: SnapshotQuery): Promise<WorkbenchSnapshot>;
  bodies: ReturnType<typeof createScopedProjectionCache<Body>>; generation: number; identity?: string };
const sources = new WeakMap<ExportData, Source>();
export function onlineStructuralSource(snapshot: WorkbenchSnapshot, load: Source['load'], seed?: WorkbenchSnapshot,
  reuse?: { identity: string; previous?: ExportData; update?: CatalogUpdate }): ExportData {
  const data = toArchive(snapshot);
  // Entries belong to an immutable index. A verified, complete incremental
  // transition may carry unchanged bodies into a new cache for the same user.
  const handle: Source = { snapshot, load, bodies: createScopedProjectionCache<Body>(), generation: 0, identity: reuse?.identity };
  sources.set(data, handle);
  const previous = reuse?.previous && sources.get(reuse.previous);
  if (previous && reuse.update && previous.identity === reuse.identity && previous.generation === 0
    && snapshot.structureOnly && previous.snapshot.structureOnly && snapshot.regionId && snapshot.regionId === previous.snapshot.regionId
    && snapshot.scope.messageId === previous.snapshot.scope.messageId && snapshot.sequence >= previous.snapshot.sequence
    && reuse.update.previousSequence === previous.snapshot.sequence) inheritBodies(previous, handle, reuse.update.changedIds);
  if (seed && !seed.structureOnly && seed.regionId === snapshot.regionId && seed.sequence === snapshot.sequence) {
    const expected = new Map(snapshot.messages.map(row => [row.id, row]));
    const relations = new Map(seed.relations.map(row => [row.id, row]));
    for (const row of seed.messages) {
      const indexed = expected.get(row.id);
      if (indexed && sameVisibilityAndRevision(row, indexed)) cacheBody(handle, bodyFrom(seed, row, relations.get(row.id)));
    }
  }
  return data;
}
type BodyVersion = Pick<Body['message'], 'revision' | 'restricted' | 'moderation'>;
const sameVisibilityAndRevision = (a: BodyVersion, b: BodyVersion) => a.revision === b.revision
  && !!a.restricted === !!b.restricted && JSON.stringify(a.moderation) === JSON.stringify(b.moderation);
const bodyFrom = (page: WorkbenchSnapshot, message: Body['message'], relation?: Body['relation']): Body => ({ message, relation,
  stake: page.stakes[message.id], tags: page.tagCounts[message.id], attention: page.attentionUsers[message.id] });
function cacheBody(handle: Source, body: Body) {
  // Bound both retained objects and serialized UTF-16 size, including parts,
  // replacement bodies and stake details (not just the displayed content).
  handle.bodies.put(body.message.id, body, JSON.stringify(body).length * 2 + 1024, 2000);
}

// These are the inputs whose current bodies can supply quoted text, correction
// previews or derived labels. Native role identities alone are not body reads.
function dependencies(row: Body['message'] | Body['relation']) {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && ['messageId', 'relationId', 'targetMessageId', 'subjectId', 'roundId'].includes(key)) ids.add(item);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  if (row) { visit(row.targetRefs); visit(row.declaredTargetRefs); if ('sourceRefs' in row) visit(row.sourceRefs);
    visit('content' in row ? row.relationPayload : row.payload); }
  return ids;
}
function inheritBodies(previous: Source, next: Source, changes: string[]) {
  const oldRows = new Map(previous.snapshot.messages.map(row => [row.id, row]));
  const newRows = new Map(next.snapshot.messages.map(row => [row.id, row]));
  const oldRelations = new Map(previous.snapshot.relations.map(row => [row.id, row]));
  const newRelations = new Map(next.snapshot.relations.map(row => [row.id, row]));
  const dirty = new Set(changes), reverse = new Map<string, Set<string>>();
  // Also check projected metadata: votes/visibility/statistics can change even
  // when the immutable body revision is unchanged.
  for (const [id, row] of oldRows) {
    const current = newRows.get(id);
    // Visibility changes can redact nested legacy data that is absent from the
    // structural index. Revalidate every body across this boundary.
    if (current && (!!current.restricted !== !!row.restricted || JSON.stringify(current.moderation) !== JSON.stringify(row.moderation))) return;
    if (!current || JSON.stringify(bodyFrom(previous.snapshot, row, oldRelations.get(id)))
      !== JSON.stringify(bodyFrom(next.snapshot, current, newRelations.get(id)))) dirty.add(id);
  }
  for (const [id] of newRows) if (!oldRows.has(id)) dirty.add(id);
  for (const snapshot of [previous.snapshot, next.snapshot]) for (const row of [...snapshot.messages, ...snapshot.relations]) {
    for (const id of dependencies(row)) {
      let dependents = reverse.get(id); if (!dependents) reverse.set(id, dependents = new Set());
      dependents.add(row.id);
    }
  }
  // Changed/new relation records can alter the target's detailed stake or
  // attention data even if its aggregate count happens to stay the same.
  for (const id of [...dirty]) for (const row of [oldRows.get(id), newRows.get(id), oldRelations.get(id), newRelations.get(id)])
    for (const target of dependencies(row)) dirty.add(target);
  const pending = [...dirty];
  for (let i = 0; i < pending.length; i++) for (const id of reverse.get(pending[i]) ?? [])
    if (!dirty.has(id)) { dirty.add(id); pending.push(id); }
  const oldUsers = new Map(previous.snapshot.users.map(user => [user.id, user]));
  const users = new Map(next.snapshot.users.map(user => [user.id, user]));
  const changedUsers = new Set([...new Set([...oldUsers.keys(), ...users.keys()])]
    .filter(id => JSON.stringify(oldUsers.get(id)) !== JSON.stringify(users.get(id))));
  const hasChangedUser = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as { id?: string; username?: string };
    // Per-record user views can omit contribution totals. Compare catalog
    // versions, not those different representations. The fixed system author
    // is synthesized by the server and intentionally absent from its user table.
    if (candidate.id && candidate.username) return changedUsers.has(candidate.id) || !users.has(candidate.id) && candidate.id !== 'system';
    return Object.values(value).some(hasChangedUser);
  };
  for (const [id, body, weight] of previous.bodies.entries()) {
    const row = newRows.get(id);
    if (row && !dirty.has(id) && sameVisibilityAndRevision(body.message, row) && !hasChangedUser(body))
      next.bodies.put(id, body, weight, 2000);
  }
}
function toArchive(snapshot: WorkbenchSnapshot): ExportData {
  return { formatVersion: 3, exportedAt: '', scope: snapshot.scope, users: snapshot.users,
    stakes: snapshot.stakes, tagCounts: snapshot.tagCounts, attentionUsers: snapshot.attentionUsers,
    messages: snapshot.messages.map(row => ({ ...row, authorId: row.createdBy.id, author: row.createdBy.username })),
    relations: snapshot.relations.map(row => ({ ...row, payload: row.payload ?? null, supersededBy: null,
      authorId: row.createdBy.id, author: row.createdBy.username })) };
}
export const onlineSourceSnapshot = (source: ExportData) => sources.get(source)?.snapshot;
export async function hydrateOnlineStructure(source: ExportData, window: ExportData, signal?: AbortSignal): Promise<ExportData> {
  const handle = sources.get(source);
  if (!handle) return window;
  const finishTiming = startWorkbenchTiming('body-load');
  const generation = handle.generation;
  const stale = (message: string, reloadCatalog = false) => {
    handle.generation++;
    handle.bodies.select({}, null);
    return Object.assign(new Error(message), { status: 409, reloadCatalog });
  };
  const ids = window.messages.map(row => row.id), messages = new Map<string, WorkbenchSnapshot['messages'][number]>();
  const relations = new Map<string, WorkbenchSnapshot['relations'][number]>();
  const stakes: WorkbenchSnapshot['stakes'] = {}, tags: WorkbenchSnapshot['tagCounts'] = {}, attention: WorkbenchSnapshot['attentionUsers'] = {};
  const expected = new Map(window.messages.map(row => [row.id, row]));
  const accept = (body: Body) => {
    const id = body.message.id;
    messages.set(id, body.message);
    if (body.relation) relations.set(id, body.relation);
    if (body.stake) stakes[id] = body.stake;
    if (body.tags) tags[id] = body.tags;
    if (body.attention) attention[id] = body.attention;
  };
  signal?.throwIfAborted();
  for (const id of ids) {
    const cached = handle.bodies.get(id);
    if (cached) accept(cached);
  }
  const missing = ids.filter(id => !messages.has(id)), fetched: Body[] = [];
  // The index supplies dependencies, so fetch exact bodies in bounded batches
  // instead of paying for overlapping window/context queries on every 50 IDs.
  const batchSize = 200, concurrency = 3;
  for (let offset = 0; offset < missing.length; offset += batchSize * concurrency) {
    signal?.throwIfAborted();
    const batches = await Promise.all([0, batchSize, batchSize * 2].filter(n => offset + n < missing.length).map(n => handle.load({
      parent: handle.snapshot.scope.messageId ?? 'root', mode: 'window', ids: missing.slice(offset + n, offset + n + batchSize), includeContext: false,
      regionId: handle.snapshot.regionId, signal,
    })));
    signal?.throwIfAborted();
    for (const page of batches) {
      if (page.structureOnly || page.regionId !== handle.snapshot.regionId || page.sequence !== handle.snapshot.sequence)
        throw stale('讨论结构已更新，正在重新加载', page.structureOnly || page.regionId !== handle.snapshot.regionId || page.sequence < handle.snapshot.sequence);
      const pageRelations = new Map(page.relations.map(row => [row.id, row]));
      for (const row of page.messages) if (expected.has(row.id)) {
        // A permission change can occur without advancing the public cursor.
        // Rebuild the catalog instead of replaying an unchanged empty delta.
        if (!sameVisibilityAndRevision(row, expected.get(row.id)!)) throw stale('消息已更新，正在重新加载', true);
        const body = bodyFrom(page, row, pageRelations.get(row.id));
        accept(body);
        fetched.push(body);
      }
    }
  }
  if (ids.some(id => !messages.has(id))) throw stale('消息已移动或删除，正在重新加载', true);
  signal?.throwIfAborted();
  if (generation !== handle.generation) throw stale('讨论结构已更新，正在重新加载', true);
  for (const body of fetched) cacheBody(handle, body);
  finishTiming();
  return toArchive({ ...handle.snapshot, structureOnly: false, messages: ids.map(id => messages.get(id)!),
    relations: window.relations.flatMap(row => relations.get(row.id) ?? []), stakes, tagCounts: tags, attentionUsers: attention });
}
