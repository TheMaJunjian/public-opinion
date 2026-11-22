import type { DemoEdge, DemoMessage, UnitSelection } from './modelBridge';
import type { DiscussionRegionGeometry } from './discussionLayout';
import { hasDiscussionText, isDiscussionType } from './discussionTypes';
import { projectStanceLayoutEdges } from './stanceLayout';
import { hasActiveDisplayEffect } from './messageDisplay';
import { getPresentationSpec } from '../types';

export interface DiscussionSummary {
  region: DiscussionRegionGeometry;
  edges: DemoEdge[];
  recordIds: string[];
}

/** A pinned current whole-message address still belongs to its region. */
function isCurrentWholeTarget(unit: UnitSelection, catalog: ReadonlyMap<string, DemoMessage>): boolean {
  if (unit.selection.kind !== 'whole') return false;
  const ref = unit.reference;
  if (!ref) return true;
  if (ref.partId || ref.memberId || ref.path?.length || ref.range) return false;
  const target = catalog.get(unit.messageId), revision = target?.revision ?? 1;
  if (ref.revision !== undefined && ref.revision !== revision) return false;
  const context = ref.context;
  if (!context) return true;
  if (!['MESSAGE', 'BODY', 'MEANING'].includes(context.kind)) return false;
  const version = 'version' in context ? context.version : undefined;
  if (!version) return true;
  return version.messageId === unit.messageId && version.revision === revision
    && JSON.stringify(version.corrections) === JSON.stringify(target?.bodyVersion?.corrections ?? []);
}

/** Merge only direct, whole-message relationships owned by this exact region.
 * Native IDs and records stay intact; fragment/version-specific edges stay individual.
 */
export function summarizeDiscussionEdges({ messages, edges, regions, ownerRegions, parents = {} }: {
  messages: DemoMessage[]; edges: DemoEdge[]; regions: readonly DiscussionRegionGeometry[];
  ownerRegions: Readonly<Record<string, string>>;
  parents?: Readonly<Record<string, string>>;
}) {
  const catalog = new Map(messages.map(message => [message.id, message]));
  const byKey = new Map(regions.map(region => [region.key, region]));
  const summaries = new Map<string, DiscussionSummary>(), hiddenEdgeIds = new Set<string>(), hiddenRecordIds = new Set<string>();
  const placements = projectStanceLayoutEdges(messages, edges);
  // Membership and decoration records do not need the individual edge label
  // as an arrow endpoint. Keep it only for a genuinely directed dependency.
  const referenced = new Set(edges.filter(edge => getPresentationSpec(edge.relationType).kind === 'edge-label'
    && !edge.from.messageId.startsWith('anon:') && catalog.has(edge.from.messageId))
    .map(edge => edge.to.messageId));
  for (let index = 0; index < edges.length; index++) {
    const original = edges[index], edge = placements[index];
    if (!isDiscussionType(edge.relationType)) continue;
    const source = edge.from.messageId.startsWith('anon:') && hasDiscussionText(catalog.get(edge.relationMessageId))
      ? edge.relationMessageId : edge.from.messageId;
    // An arrangement owns its members' coordinates. Direct relations emitted
    // by those members still belong to the surrounding automatic region.
    let region: DiscussionRegionGeometry | undefined;
    const seen = new Set<string>();
    for (let id: string | undefined = source; id && !seen.has(id); id = parents[id]) {
      seen.add(id);
      const candidate = byKey.get(ownerRegions[id]);
      if (candidate?.type === edge.relationType && candidate.targetId === edge.to.messageId) { region = candidate; break; }
    }
    if (!region || region.type !== edge.relationType || region.targetId !== edge.to.messageId
      || original.proposalOnly || !hasActiveDisplayEffect(original, catalog)
      || referenced.has(original.relationMessageId) && !ownerRegions[original.relationMessageId] && !parents[original.relationMessageId]
      || !isCurrentWholeTarget(edge.to, catalog)) continue;
    const summary = summaries.get(region.key) ?? { region, edges: [], recordIds: [] };
    summary.edges.push(original);
    if (!summary.recordIds.includes(original.relationMessageId)) summary.recordIds.push(original.relationMessageId);
    summaries.set(region.key, summary);
    hiddenEdgeIds.add(original.id); hiddenRecordIds.add(original.relationMessageId);
  }
  return { summaries: [...summaries.values()], hiddenEdgeIds, hiddenRecordIds };
}
