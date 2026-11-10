import type { DemoEdge, DemoMessage } from './modelBridge';
import { computeCorrectedEdgeMap, isCardMessage, isContentKind, isSettlementRecord, presentationTarget } from './modelBridge';
import { getSummaryCoveredIds, hasActiveDisplayEffect, needsSeparateStanceCard } from './messageDisplay';
import { projectStanceLayoutEdges } from './stanceLayout';
import {projectAnnotationLayoutEdges} from './annotationLayout';
import { projectDiscussionLayoutEdges } from './discussionLayoutEdges';
import { buildFrameBlocks } from './graphOrganizations';
import {isRejectedContainer,isRejectedRelation} from './relatedMessages';
import { getPresentationSpec } from '../types';
import { hasManualDiscussionOrder } from './discussionTypes';
import { computeMinColumnsForAnnoRefRule1, applyReplyLayoutAdjustmentsWithConstraints, applyAgreeDisagreeColumnOverride, applyGroupingColumnOverride } from './graphColumnRules';

export interface GraphProjectionInput {
  messages: DemoMessage[];
  edges: DemoEdge[];
  traceExpandedFrameIds: Set<string>;
  isTraceWindow: boolean;
  /** Explicit contextual expansion without changing trace or stance semantics. */
  expandedFrameIds?: ReadonlySet<string>;
  showJoinRecords?: boolean;
  standaloneMessageIds?:ReadonlySet<string>;
  /** A reviewed message must remain a card even when its normal form is a badge. */
  forceCardMessageIds?:ReadonlySet<string>;
  rejectedContainerIds?:ReadonlySet<string>;
  rejectedRelationIds?:ReadonlySet<string>;
  hiddenMessageIds?:ReadonlySet<string>;
  cardFrameIds?:ReadonlySet<string>;
  /** Relationship records with their own discussion need a selectable card as an anchor. */
  discussionTargetIds?:ReadonlySet<string>;
}

/** Explicit member ordering has no automatic inner regions, so its direct
 * targets must not become hidden behind a fold that has no local reopening entry.
 * Descendants of nested automatic frames keep their own discussion controls. */
export function manualDiscussionTargets({ messages, edges, traceMode = false }: { messages: DemoMessage[]; edges: DemoEdge[]; traceMode?: boolean }): Set<string> {
  const explicitFrames = new Set(messages.filter(message => hasManualDiscussionOrder(message, traceMode)).map(message => message.id));
  const targets = new Set<string>();
  if (!explicitFrames.size) return targets;
  const visibleCardIds = new Set(messages.filter(message => !isSettlementRecord(message) && message.kind !== 'join').map(message => message.id));
  const frames = buildFrameBlocks({ edges, visibleCardIds, msgMap: new Map(messages.map(message => [message.id, message])) });
  for (const frame of frames) if (explicitFrames.has(frame.relMsgId)
    && (frame.targetLayout === 'single-row' || frame.targetLayout === 'single-column')) {
    for (const id of frame.directCardIds) targets.add(id);
  }
  return targets;
}

/** Derive visible cards, organization ownership and relative columns without DOM or UI state. */
export function projectGraphScene({ messages, edges, traceExpandedFrameIds, isTraceWindow,expandedFrameIds,showJoinRecords=false,standaloneMessageIds,forceCardMessageIds,rejectedContainerIds,rejectedRelationIds,hiddenMessageIds,cardFrameIds,discussionTargetIds }: GraphProjectionInput) {
  if(!isTraceWindow)traceExpandedFrameIds=new Set();
  traceExpandedFrameIds = new Set([...traceExpandedFrameIds, ...expandedFrameIds ?? []].filter(id => !rejectedContainerIds?.has(id)));
  const msgMap = new Map(messages.map(message => [message.id, message]));
  const edgesByRelMsg = new Map<string, DemoEdge[]>();
  const classifyRelMsgIds = new Set<string>();
  const summaryRelMsgIds = new Set<string>();
  const correctionsByTargetMsgId = new Map<string, Array<{ relMsgId: string; targetMsgId: string }>>();
  for (const message of messages) {
    if (message.kind !== 'relation') continue;
    if (message.relationType === 'classify') classifyRelMsgIds.add(message.id);
    if (message.relationType === 'summary') summaryRelMsgIds.add(message.id);
  }
  const discussionRelationCardIds = new Set(messages.filter(message => message.kind === 'relation'
    && discussionTargetIds?.has(message.id) && !['classify','summary','merge','arrange'].includes(message.relationType??'')
    && getPresentationSpec(message.relationType??'').kind !== 'inline-badge'
    && !message.parts?.some(part=>part.type==='display'&&part.layout==='relation'))
    .map(message=>message.id));
  for (const edge of edges) {
    const own = edgesByRelMsg.get(edge.relationMessageId) ?? [];
    own.push(edge); edgesByRelMsg.set(edge.relationMessageId, own);
    if (edge.relationType === 'classify') classifyRelMsgIds.add(edge.relationMessageId);
    if (edge.relationType === 'summary') summaryRelMsgIds.add(edge.relationMessageId);
    if (edge.relationType === 'correct') {
      const versions = correctionsByTargetMsgId.get(edge.to.messageId) ?? [];
      versions.push({ relMsgId: edge.relationMessageId, targetMsgId: edge.to.messageId });
      correctionsByTargetMsgId.set(edge.to.messageId, versions);
    }
  }
  const relationCardMsgIds = new Set([...classifyRelMsgIds, ...summaryRelMsgIds]);
  for (const id of discussionRelationCardIds) relationCardMsgIds.add(id);
  for (const message of messages) {
    if (message.kind === 'relation' && (isCardMessage(message) || needsSeparateStanceCard(message, msgMap)
      || forceCardMessageIds?.has(message.id) || standaloneMessageIds?.has(message.id)&&['agree','disagree'].includes(message.relationType??'')
      || isRejectedContainer(message,rejectedContainerIds)||isRejectedRelation(message,rejectedRelationIds))) {
      relationCardMsgIds.add(message.id);
    }
  }
  // A converted annotation keeps its exact address. Some addressed fields have
  // no badge host, so retain the annotation as a reachable card in those cases.
  for (const edge of edges) {
    const annotation = msgMap.get(edge.relationMessageId);
    if (!annotation?.relationPayload?.annotationStance) continue;
    const kind = getPresentationSpec(edge.relationType).kind;
    if (!['inline-badge','decoration-label'].includes(kind)) continue;
    const target = msgMap.get(edge.to.messageId), targetKind = getPresentationSpec(target?.relationType ?? '').kind;
    const host = target && (isContentKind(target.kind) || relationCardMsgIds.has(target.id)
      || ['arrange-frame','frame-group','replace-overlay'].includes(targetKind)
      || kind === 'decoration-label' && targetKind === 'edge-label' && edgesByRelMsg.has(target.id));
    if (edge.to.selection.kind !== 'whole' || !host) relationCardMsgIds.add(annotation.id);
  }
  // Losing an annotation's visual anchor does not give its bodyless votes a
  // body card. Explicit inspection above can still open the vote's record.
  const tracedSummaryMembers = new Set<string>();
  for (const edge of edges) {
    if (edge.relationType !== 'summary' || !traceExpandedFrameIds.has(edge.relationMessageId)) continue;
    tracedSummaryMembers.add(edge.from.messageId);
    tracedSummaryMembers.add(edge.to.messageId);
  }
  const hiddenTargetIds = new Set([...getSummaryCoveredIds(msgMap, edges)]
    .filter(id => !summaryRelMsgIds.has(id) && !tracedSummaryMembers.has(id) && !standaloneMessageIds?.has(id)));
  const normals = messages.filter(message => !isSettlementRecord(message) && (message.kind !== 'join' || showJoinRecords) && !hiddenMessageIds?.has(message.id) && !traceExpandedFrameIds.has(message.id) && !hiddenTargetIds.has(message.id)
    && (!presentationTarget(message) || forceCardMessageIds?.has(message.id) || discussionRelationCardIds.has(message.id) || showJoinRecords && message.kind === 'join') && (isContentKind(message.kind)
      || message.kind === 'relation' && relationCardMsgIds.has(message.id)));
  const normalIds = normals.map(message => message.id);
  const relIds = new Set(messages.filter(message => message.kind === 'relation' && !relationCardMsgIds.has(message.id)).map(message => message.id));
  const activeLayoutEdges = edges.filter(edge =>
    ![edge.relationMessageId,edge.from.messageId,edge.to.messageId].some(id=>isSettlementRecord(msgMap.get(id))||!showJoinRecords&&msgMap.get(id)?.kind==='join')
    && !hiddenMessageIds?.has(edge.relationMessageId) && (isTraceWindow || hasActiveDisplayEffect(edge, msgMap)));
  const layoutEdges = projectAnnotationLayoutEdges(messages,discussionTargetIds
    ? projectDiscussionLayoutEdges(messages,activeLayoutEdges,discussionRelationCardIds)
    : projectStanceLayoutEdges(messages,activeLayoutEdges), !!discussionTargetIds);
  const columns = discussionTargetIds ? {col:Object.fromEntries(normalIds.map(id=>[id,0])),maxCol:0} : (()=>{
    const base = computeMinColumnsForAnnoRefRule1(normalIds, layoutEdges, relIds);
    const reply = applyReplyLayoutAdjustmentsWithConstraints({ normals, edges: layoutEdges, baseCol: base.col, baseMaxCol: base.maxCol, relIds });
    const stance = applyAgreeDisagreeColumnOverride({ normals, edges: layoutEdges, ...reply });
    return applyGroupingColumnOverride({ normals, edges: layoutEdges, ...stance });
  })();
  const keepEmptyFrameIds = new Set(traceExpandedFrameIds);
  for (const message of messages) {
    if (['merge', 'arrange'].includes(message.relationType ?? '') && !isRejectedContainer(message, rejectedContainerIds)
      && !hiddenMessageIds?.has(message.id) && !hiddenTargetIds.has(message.id)
      && !(edgesByRelMsg.get(message.id) ?? []).some(edge => edge.relationType === message.relationType
        && hasActiveDisplayEffect(edge, msgMap))) keepEmptyFrameIds.add(message.id);
  }
  const frameBlocks = buildFrameBlocks({ edges:edges.filter(edge=>!hiddenMessageIds?.has(edge.relationMessageId)), visibleCardIds: new Set(normalIds), msgMap,
    opaqueFrameIds:new Set([...classifyRelMsgIds,...summaryRelMsgIds].filter(id=>!traceExpandedFrameIds.has(id))),
    keepEmptyFrameIds, cardFrameIds, traceMode: isTraceWindow }).filter(block =>
    !['classify', 'summary'].includes(msgMap.get(block.relMsgId)?.relationType ?? '')
    || traceExpandedFrameIds.has(block.relMsgId));
  const blocksById = new Map(frameBlocks.map(block => [block.relMsgId, block]));
  const childIds = new Set(frameBlocks.flatMap(block => block.childRelMsgIds));
  const frameDepthMap = new Map<string, number>();
  const queue = frameBlocks.filter(block => !childIds.has(block.relMsgId)).map(block => ({ id: block.relMsgId, depth: 0 }));
  for (let index = 0; index < queue.length; index++) {
    const { id, depth } = queue[index];
    if (frameDepthMap.has(id)) continue;
    frameDepthMap.set(id, depth);
    for (const child of blocksById.get(id)?.childRelMsgIds ?? []) queue.push({ id: child, depth: depth + 1 });
  }
  return { msgMap, edgesByRelMsg, classifyRelMsgIds, relationCardMsgIds, normals, normalIds, layoutEdges,
    hiddenTargetIds, correctionsByTargetMsgId, frameBlocks, frameDepthMap,
    correctedEdgeIdsByRelMsg: computeCorrectedEdgeMap(edges), pipelineCol: columns.col, pipelineMaxCol: columns.maxCol };
}
