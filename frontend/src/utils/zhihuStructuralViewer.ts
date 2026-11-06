import type { ExportData } from '../api/client';
import type { Part } from '@gonglun/core';
import { deriveContainerEffect, isContainerType } from '../pages/workbench/model/containerEffect';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from './workbenchProjection';
import { isCardMessage } from './modelBridge';
import type { TraceDepths } from './traceRange';
import { isNativeZhihuView } from './nativeZhihuView';
import type { TargetRef } from '../types';
import { hydratePagedArchive, pagedArchiveSource } from './pagedZhihuArchive';
import { displayDependencyIds } from './displayDependency';

type Row = ExportData['messages'][number];
type RelationRow = ExportData['relations'][number];
const containers = new Set(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE']);
const scopes = new Set(['CLASSIFY', 'SUMMARY']);
const effects = new Set(['AGREE', 'DISAGREE', 'CORRECT', 'ANNOTATION', 'TAG', 'JOIN']);
const targetIds = (row: { targetRefs?: unknown }) => ((row.targetRefs ?? []) as TargetRef[])
  .map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId).filter(Boolean);
const endpoints = (row: RelationRow) => [...(row.sourceMessageId ? [row.sourceMessageId] : []), ...targetIds(row)];
const typeOf = (row: Row | RelationRow | undefined) => row?.relationType?.toUpperCase() ?? '';

export interface ZhihuViewerScope {
  classificationId: string | null;
  trace?: { ids: string[]; depths: TraceDepths; expandedIds: string[] };
  /** Explicit global filters and simulated organization views need a complete model. */
  full?: boolean;
  /** Selections and navigation targets may belong to another classification. */
  extraIds?: string[];
  /** Relationship history loads records/endpoints, without opening their categories. */
  recordIds?: string[];
  includeJoinRecords?: boolean;
}

export const structuralScopeKey = (scope: ZhihuViewerScope) => JSON.stringify([
  scope.classificationId, !!scope.full, scope.trace?.ids, scope.trace?.depths,
  scope.trace?.expandedIds, [...scope.extraIds ?? []].sort(), [...scope.recordIds ?? []].sort(), !!scope.includeJoinRecords,
]);

export function shouldUseZhihuStructuralViewer(data: ExportData): boolean {
  return (data.messages.length > 10_000 || !!pagedArchiveSource(data)) && isNativeZhihuView(data);
}

// The structural index carries identities, membership and relation endpoints;
// original bodies/source evidence are materialized only for the requested window.
function topologyPart(part: Part): Part {
  switch (part.type) {
    case 'text': return { ...part, text: part.text.trim() ? 'x' : '' };
    case 'data': return { ...part, value: null };
    case 'code': return { ...part, source: '' };
    case 'web': return { ...part, excerpt: '' };
    case 'relation': return containers.has(part.relation.toUpperCase()) ? { ...part, roles: {} } : part;
    default: return part;
  }
}
function topologyRow(row: Row): Row {
  return { ...row, content: row.content?.trim() ? 'x' : '', parts: row.parts?.map(topologyPart) };
}
function indexProjection(data: ExportData, rows: Row[], relations: RelationRow[], omitMembershipEdges = false) {
  // Do not construct the full native editing index to read structural metadata.
  const snapshot = archiveToWorkbenchSnapshot({ formatVersion: data.formatVersion, exportedAt: data.exportedAt,
    scope: data.scope, messages: rows.map(topologyRow), relations, stakes: data.stakes });
  const projected = projectWorkbenchSnapshot(omitMembershipEdges ? { ...snapshot,
    relations: snapshot.relations.map(relation => isContainerType(relation.relationType) ? { ...relation, targetRefs: [] } : relation),
  } : snapshot);
  return { ...projected, relations: snapshot.relations };
}

/** One immutable source revision. No projected message from a previous scope is retained. */
export function createZhihuStructuralViewer(data: ExportData, username: string | null,
  hydrate: (selected: ExportData) => Promise<ExportData> = selected => hydratePagedArchive(data, selected)) {
  const byId = new Map(data.messages.map(row => [row.id, row]));
  const order = new Map(data.messages.map((row, index) => [row.id, index]));
  const relations = new Map(data.relations.map(row => [row.id, row]));
  const relationOrder = new Map(data.relations.map((row, index) => [row.id, index]));
  const adjacent = new Map<string, string[]>();
  const affecting = new Map<string, string[]>();
  const addIndex = (index: Map<string, string[]>, key: string, id: string) => {
    const values = index.get(key);
    if (values) values.push(id); else index.set(key, [id]);
  };
  for (const relation of data.relations) {
    if (containers.has(typeOf(relation))) continue;
    for (const id of new Set(endpoints(relation))) {
      if (typeOf(relation) !== 'JOIN') addIndex(adjacent, id, relation.id);
      // JOIN history belongs to the member. Opening its parent must not load
      // every joined child's body merely to compute the parent's count.
      if (effects.has(typeOf(relation)) && (typeOf(relation) !== 'JOIN' || id !== relation.sourceMessageId))
        addIndex(affecting, id, relation.id);
    }
  }
  const structureIds = new Set(data.relations.filter(row => containers.has(typeOf(row))
    || ['JOIN', 'AGREE', 'DISAGREE'].includes(typeOf(row))).map(row => row.id));
  // Stances can address other stance records, parts and executed targets.
  for (const row of data.messages) if (['AGREE', 'DISAGREE'].includes(typeOf(row))) {
    for (const id of [...targetIds(row), row.executedStance?.target.messageId ?? '']) if (byId.has(id)) structureIds.add(id);
  }
  for (const row of data.messages) if (row.state?.suppressed) structureIds.add(row.id);
  const structural = indexProjection(data, [...structureIds].flatMap(id => byId.get(id) ?? []),
    data.relations.filter(row => structureIds.has(row.id)), true);
  const effect = deriveContainerEffect({ ...structural, username, stakeCounts: structural.counts });
  const joinRelations = structural.relations.filter(relation => relation.relationType === 'JOIN');
  const joinsBySource = new Map<string, string[]>(), joinsByTarget = new Map<string, string[]>();
  for (const relation of joinRelations) {
    if (relation.sourceMessageId) addIndex(joinsBySource, relation.sourceMessageId, relation.id);
    for (const id of targetIds(relation)) addIndex(joinsByTarget, id, relation.id);
  }
  const members = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const relation of structural.relations) if (isContainerType(relation.relationType)) {
    const direct = effect.ownership.direct(relation.id);
    const ids = [...direct.textIds, ...direct.relationIds];
    members.set(relation.id, ids);
    for (const id of ids) addIndex(parents, id, relation.id);
  }
  const closed = (id: string) => scopes.has(typeOf(relations.get(id))) && !effect.rejectedContainerIds.has(id);
  const descendants = (starts: Iterable<string>, excludeStarts = false) => {
    const seen = new Set<string>(), pending = [...starts];
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index];
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of members.get(id) ?? []) if (!seen.has(child)) pending.push(child);
    }
    if (excludeStarts) for (const id of starts) seen.delete(id);
    return seen;
  };
  // Mark the union once, rather than retaining a descendant set per category.
  const hiddenAtRoot = new Set<string>();
  const hiddenPending = [...members.keys()].filter(closed).flatMap(id => members.get(id) ?? []);
  for (let index = 0; index < hiddenPending.length; index++) {
    const id = hiddenPending[index]; if (hiddenAtRoot.has(id)) continue;
    hiddenAtRoot.add(id);
    for (const child of members.get(id) ?? []) hiddenPending.push(child);
  }
  const rootIds = data.messages.filter(row => {
    if (hiddenAtRoot.has(row.id) || row.state?.organizationRetired
      || ['JOIN', 'ROUND', 'ROUND_RESULT'].includes(typeOf(row) || row.kind)) return false;
    // Only independent cards seed the overview. A stance on a JOIN, or a
    // settlement of that stance, has no membership of its own; seeding these
    // records would pull every closed category's members back into the window.
    // The adjacency/effect walk below adds records belonging to visible hosts.
    return displayDependencyIds({ ...row, relationType: row.relationType ?? undefined, targetRefs: row.targetRefs as TargetRef[] | undefined }) === null;
  }).map(row => row.id);

  function layer(id: string | null): Set<string> {
    const visible = new Set(id ? members.get(id) ?? [] : rootIds);
    const queue = [...visible], visited = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const child = queue[index]; if (visited.has(child)) continue;
      visited.add(child);
      if (!members.has(child) || closed(child)) continue;
      for (const member of members.get(child)!) { visible.add(member); queue.push(member); }
    }
    // A source index can declare both a question and its answers. The question
    // remains an opaque card even when those answers also occur in its parent.
    const opaque = [...visible].filter(closed);
    const hidden = descendants(opaque, true);
    for (const child of hidden) visible.delete(child);
    if (id) visible.add(id);
    return visible;
  }

  const transparent = new Map<string, boolean>();
  const traceCost = (id: string) => {
    let value = transparent.get(id);
    if (value === undefined) {
      const row = byId.get(id), type = typeOf(row);
      value = !!row && row.kind === 'RELATION' && type !== 'JOIN' && !containers.has(type)
        && !isCardMessage({ id, kind: 'relation', relationType: type.toLowerCase(), parts: row.parts });
      transparent.set(id, value);
    }
    return value ? 0 : 1;
  };
  function traceIds(trace: NonNullable<ZhihuViewerScope['trace']>): Set<string> {
    const starts = new Set(trace.ids), expanded = new Set([...trace.expandedIds, ...starts]);
    const seeds = new Set(starts), selected = new Set(starts);
    // An explicitly entered category seeds its current layer; ancestors found
    // along a trace never seed their other members or create causal shortcuts.
    if (trace.ids.length === 1 && typeOf(relations.get(trace.ids[0])) === 'CLASSIFY') {
      const pending = [...members.get(trace.ids[0]) ?? []];
      for (let i = 0; i < pending.length; i++) {
        const id = pending[i]; if (seeds.has(id)) continue;
        seeds.add(id);
        if (['MERGE', 'ARRANGE'].includes(typeOf(relations.get(id)))) pending.push(...members.get(id) ?? []);
      }
    }
    const context = [...starts], expandedContext = new Set<string>();
    for (let i = 0; i < context.length; i++) {
      const id = context[i];
      if (expandedContext.has(id) || !expanded.has(id) && !['MERGE', 'ARRANGE'].includes(typeOf(relations.get(id)))) continue;
      expandedContext.add(id);
      for (const child of members.get(id) ?? []) { selected.add(child); context.push(child); }
    }
    // Match traceRange's separate directional walks and zero-cost relation
    // records. Walking an undirected neighbourhood would incorrectly load all
    // siblings of an upstream answer while tracing one comment.
    const walk = (direction: 'up' | 'down', maximum: number) => {
      const seen = new Map([...seeds].map(id => [id, 0]));
      const pending: string[][] = [[...seeds]], arrangements = new Set<string>();
      if (maximum <= 0) return;
      for (let depth = 0; depth < pending.length; depth++) for (let i = 0; i < pending[depth].length; i++) {
        const id = pending[depth][i]; if (seen.get(id) !== depth) continue;
        const visit = (target: string, cost = traceCost(target)) => {
          const next = depth + cost;
          if (!byId.has(target) || next > maximum || next >= (seen.get(target) ?? Infinity)) return;
          seen.set(target, next); (pending[next] ??= []).push(target); selected.add(target);
        };
        const records = new Set(adjacent.get(id) ?? []);
        if (relations.has(id)) records.add(id);
        for (const recordId of records) {
          const row = relations.get(recordId)!, type = typeOf(row);
          if (containers.has(type) || ['JOIN', 'READ', 'UNREAD'].includes(type)
            || effect.suppressed.has(recordId) && !starts.has(recordId)) continue;
          const targets = targetIds(row), source = row.sourceMessageId && byId.has(row.sourceMessageId) ? row.sourceMessageId : row.id;
          if (direction === 'up') {
            if (id === source || id === row.id) for (const target of targets) visit(target);
            if (id === row.id && source !== row.id) visit(source);
          } else {
            if (targets.includes(id)) { visit(source); visit(row.id); }
            if (id === source && source !== row.id) visit(row.id);
          }
        }
        const frames = [...parents.get(id) ?? [], ...(typeOf(relations.get(id)) === 'ARRANGE' ? [id] : [])];
        for (const frame of frames) {
          if (typeOf(relations.get(frame)) !== 'ARRANGE' || arrangements.has(frame)
            || effect.suppressed.has(frame) && !starts.has(frame)) continue;
          arrangements.add(frame); visit(frame, 1);
          for (const member of members.get(frame) ?? []) visit(member, 1);
        }
      }
    };
    for (const id of seeds) selected.add(id);
    walk('up', trace.depths.up); walk('down', trace.depths.down);
    return selected;
  }

  function window(scope: ZhihuViewerScope) {
    if (scope.full) return { data, unloadedContainers: new Set<string>() };
    const ids = scope.trace ? traceIds(scope.trace) : layer(scope.classificationId);
    if (scope.includeJoinRecords && !scope.recordIds?.length) for (const id of [...ids]) {
      for (const join of [...joinsBySource.get(id) ?? [], ...joinsByTarget.get(id) ?? []]) ids.add(join);
    }
    for (const id of scope.recordIds ?? []) if (byId.has(id)) ids.add(id);
    for (const id of scope.extraIds ?? []) if (byId.has(id) && !ids.has(id)) {
      ids.add(id);
      // A cross-category jump needs the destination's layer, not just one body.
      const parent = containingClassification(id);
      for (const child of layer(parent)) ids.add(child);
    }
    // Keep cross-canvas records and their immediate endpoints. This does not
    // recursively traverse arbitrary replies; trace distance owns that expansion.
    const seeds = [...ids];
    for (const id of seeds) for (const recordId of adjacent.get(id) ?? []) {
      ids.add(recordId);
      const record = relations.get(recordId)!;
      for (const endpoint of endpoints(record)) if (byId.has(endpoint)) ids.add(endpoint);
    }
    // Membership alternatives, corrections and chains of stances must be loaded
    // together; otherwise a partial window could choose a different winner.
    const pending = [...ids], seen = new Set<string>();
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index]; if (seen.has(id)) continue;
      seen.add(id);
      const add = (next: string) => { if (byId.has(next) && !ids.has(next)) { ids.add(next); pending.push(next); } };
      for (const parent of parents.get(id) ?? []) add(parent);
      for (const recordId of affecting.get(id) ?? []) {
        add(recordId);
        for (const endpoint of endpoints(relations.get(recordId)!)) add(endpoint);
      }
      // Explicitly selected relationship records need their own endpoints too.
      const record = relations.get(id);
      if (record && !containers.has(typeOf(record))) for (const endpoint of endpoints(record)) add(endpoint);
    }
    const rows = [...ids].flatMap(id => byId.get(id) ?? []).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const selectedRelations = [...ids].flatMap(id => relations.get(id) ?? []).sort((a, b) => relationOrder.get(a.id)! - relationOrder.get(b.id)!);
    const unloadedContainers = new Set([...ids].filter(id => (members.get(id) ?? []).some(member => !ids.has(member))));
    return { data: { ...data, messages: rows, relations: selectedRelations }, unloadedContainers };
  }

  function containingClassification(id: string): string | null {
    // Breadth first walks effective membership, including JOIN moves. Cycles
    // and shared source navigation paths cannot turn this into an infinite walk.
    const winner = relations.get(effect.joinByTarget.get(id) ?? '')?.sourceMessageId;
    const pending = [...(winner ? [winner] : []), ...parents.get(id) ?? []], seen = new Set<string>([id]);
    for (let index = 0; index < pending.length; index++) {
      const parent = pending[index]; if (seen.has(parent)) continue;
      seen.add(parent);
      if (closed(parent)) return parent;
      for (const ancestor of parents.get(parent) ?? []) pending.push(ancestor);
    }
    // A relationship's display host determines the destination for ID navigation.
    const record = relations.get(id);
    if (record) for (const endpoint of endpoints(record)) {
      if (endpoint !== id && byId.has(endpoint)) {
        const candidates = parents.get(endpoint) ?? [];
        const parent = candidates.find(closed); if (parent) return parent;
      }
    }
    return null;
  }
  return { source: data, username, window, containingClassification,
    joinRelations, joinStatusByMessage: effect.context.joinStatusByMessage,
    joinRecordIds: (id: string, direction: 'incoming' | 'outgoing') => (direction === 'incoming' ? joinsByTarget : joinsBySource).get(id) ?? [],
    readContext: async (ids: string[]) => {
      if (ids.some(id => !byId.has(id))) throw new Error('这份阅览文件中没有关联消息');
      return archiveToWorkbenchSnapshot(await hydrate(window({ classificationId: null, extraIds: ids }).data));
    },
    has: (id: string) => byId.has(id), memberCounts: effect.ownership.memberCounts,
    knownIds: new Set(byId.keys()) as ReadonlySet<string> };
}

export type ZhihuStructuralViewer = ReturnType<typeof createZhihuStructuralViewer>;
