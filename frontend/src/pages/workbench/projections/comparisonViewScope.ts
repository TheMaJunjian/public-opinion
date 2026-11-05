import { projectGraphScene, type GraphProjectionInput } from '../../../utils/graphProjection';
import { isCorrectionProposal, isSettlementRecord, type DemoEdge, type DemoMessage } from '../../../utils/modelBridge';
import { filterMessageListContext } from './messageListContext';

const displayEffectTypes = new Set([
  'classify', 'summary', 'merge', 'arrange', 'correct',
  'annotation', 'reference', 'reply', 'notify',
  'tag', 'recommend', 'archive', 'attention', 'block',
]);

/** Content and executable proposals keep their display when voted on. */
export function hasComparisonDisplayEffect(message: DemoMessage): boolean {
  if (message.state?.membershipDisabled || message.state?.organizationRetired) return false;
  return message.kind === 'join' || message.kind === 'relation' && displayEffectTypes.has(message.relationType ?? '') && !isCorrectionProposal(message);
}

/** Capture the full view, including labels and frames, before its chooser replaces it. */
export function comparisonViewMessageIds(input: GraphProjectionInput & {
  viewMode: 'graph' | 'list';
  catalogMessages: DemoMessage[];
  catalogEdges: DemoEdge[];
  scopeId?: string | null;
}): Set<string> {
  const listIds = input.viewMode === 'list' ? new Set(filterMessageListContext(
    input.messages,
    input.catalogMessages, input.catalogEdges, input.standaloneMessageIds, input.showJoinRecords,
  ).map(message => message.id)) : null;

  const scene = listIds ? null : projectGraphScene(input);
  const ids = listIds ?? new Set([...scene!.normalIds, ...scene!.frameBlocks.map(frame => frame.relMsgId)]);
  // Labels can themselves host other labels. Add only connections whose
  // anchors are present; a hidden descendant's record is outside this view.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of scene?.layoutEdges ?? []) {
      if (ids.has(edge.relationMessageId) || !ids.has(edge.to.messageId)
        || !edge.from.messageId.startsWith('anon:') && !ids.has(edge.from.messageId)) continue;
      ids.add(edge.relationMessageId);
      changed = true;
    }
  }
  // Membership records are normally folded into badges. Review those attached
  // to this view's cards or category header, without traversing hidden children.
  const visibleIds = new Set(ids);
  if (input.scopeId) ids.add(input.scopeId);
  const catalog = new Map(input.catalogMessages.map(message => [message.id, message]));
  for (const message of input.catalogMessages) if (message.kind === 'join' && message.joinInfo
    && message.joinInfo.targetIds.some(id => catalog.has(id) && !isSettlementRecord(catalog.get(id)))
    && (message.joinInfo.containerId === input.scopeId || !input.scopeId && visibleIds.has(message.joinInfo.containerId)
      || message.joinInfo.targetIds.some(id => visibleIds.has(id)))) ids.add(message.id);
  return ids;
}
