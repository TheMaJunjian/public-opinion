import type { WorkbenchSnapshot, SnapshotQuery } from '../data/workbench';
import type { ExportData } from '../api/client';

type Source = { snapshot: WorkbenchSnapshot; load(query: SnapshotQuery): Promise<WorkbenchSnapshot> };
const sources = new WeakMap<ExportData, Source>();
export function onlineStructuralSource(snapshot: WorkbenchSnapshot, load: Source['load']): ExportData {
  const data = toArchive(snapshot);
  sources.set(data, { snapshot, load });
  return data;
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
  const ids = window.messages.map(row => row.id), messages = new Map<string, WorkbenchSnapshot['messages'][number]>();
  const relations = new Map<string, WorkbenchSnapshot['relations'][number]>();
  const stakes: WorkbenchSnapshot['stakes'] = {}, tags: WorkbenchSnapshot['tagCounts'] = {}, attention: WorkbenchSnapshot['attentionUsers'] = {};
  const expected = new Map(window.messages.map(row => [row.id, row.revision]));
  for (let offset = 0; offset < ids.length; offset += 150) {
    signal?.throwIfAborted();
    const batches = await Promise.all([0, 50, 100].filter(n => offset + n < ids.length).map(n => handle.load({
      parent: handle.snapshot.scope.messageId ?? 'root', mode: 'window', ids: ids.slice(offset + n, offset + n + 50),
      regionId: handle.snapshot.regionId, signal,
    })));
    signal?.throwIfAborted();
    for (const page of batches) {
      if (page.structureOnly || page.regionId !== handle.snapshot.regionId) throw Object.assign(new Error('讨论结构已更新，正在重新加载'), { status: 409 });
      for (const row of page.messages) if (expected.has(row.id)) {
        if (row.revision !== expected.get(row.id)) throw Object.assign(new Error('消息已更新，正在重新加载'), { status: 409 });
        messages.set(row.id, row);
        if (page.stakes[row.id]) stakes[row.id] = page.stakes[row.id];
        if (page.tagCounts[row.id]) tags[row.id] = page.tagCounts[row.id];
        if (page.attentionUsers[row.id]) attention[row.id] = page.attentionUsers[row.id];
      }
      for (const row of page.relations) if (expected.has(row.id)) relations.set(row.id, row);
    }
  }
  if (ids.some(id => !messages.has(id))) throw Object.assign(new Error('消息已移动或删除，正在重新加载'), { status: 409 });
  return toArchive({ ...handle.snapshot, structureOnly: false, messages: ids.map(id => messages.get(id)!),
    relations: window.relations.flatMap(row => relations.get(row.id) ?? []), stakes, tagCounts: tags, attentionUsers: attention });
}
