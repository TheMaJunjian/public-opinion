import type { DemoEdge, DemoMessage } from './modelBridge';
import { computeCorrectedEdgeMap, isCardMessage, isContentKind, presentationTarget } from './modelBridge';
import { getSummaryCoveredIds, hasActiveDisplayEffect, needsSeparateStanceCard } from './messageDisplay';
import { projectStanceLayoutEdges } from './stanceLayout';
import {projectAnnotationLayoutEdges} from './annotationLayout';
import { buildFrameBlocks } from './graphOrganizations';
import {isRejectedContainer,isRejectedRelation} from './relatedMessages';
import { getPresentationSpec } from '../types';
import { computeMinColumnsForAnnoRefRule1, applyReplyLayoutAdjustmentsWithConstraints, applyAgreeDisagreeColumnOverride, applyGroupingColumnOverride } from './graphColumnRules';

export interface GraphProjectionInput {
  messages: DemoMessage[];
  edges: DemoEdge[];
  traceExpandedFrameIds: Set<string>;
  isTraceWindow: boolean;
  standaloneMessageIds?:ReadonlySet<string>;
  rejectedContainerIds?:ReadonlySet<string>;
  rejectedRelationIds?:ReadonlySet<string>;
  hiddenMessageIds?:ReadonlySet<string>;
  cardFrameIds?:ReadonlySet<string>;
}

/** Derive visible cards, organization ownership and relative columns without DOM or UI state. */
export function projectGraphScene({ messages, edges, traceExpandedFrameIds, isTraceWindow,standaloneMessageIds,rejectedContainerIds,rejectedRelationIds,hiddenMessageIds,cardFrameIds }: GraphProjectionInput) {
  if(!isTraceWindow)traceExpandedFrameIds=new Set();
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
  for (const message of messages) {
    if (message.kind === 'relation' && (isCardMessage(message) || needsSeparateStanceCard(message, msgMap)
      || standaloneMessageIds?.has(message.id)&&['agree','disagree'].includes(message.relationType??'')
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
    .filter(id => !summaryRelMsgIds.has(id) && !tracedSummaryMembers.has(id)));
  const normals = messages.filter(message => !hiddenMessageIds?.has(message.id) && !traceExpandedFrameIds.has(message.id) && !hiddenTargetIds.has(message.id)
    && !presentationTarget(message) && (isContentKind(message.kind)
      || message.kind === 'relation' && relationCardMsgIds.has(message.id)));
  const normalIds = normals.map(message => message.id);
  const relIds = new Set(messages.filter(message => message.kind === 'relation' && !relationCardMsgIds.has(message.id)).map(message => message.id));
  const layoutEdges = projectAnnotationLayoutEdges(messages,projectStanceLayoutEdges(messages, edges.filter(edge => !hiddenMessageIds?.has(edge.relationMessageId) && (isTraceWindow || hasActiveDisplayEffect(edge, msgMap)))));
  const base = computeMinColumnsForAnnoRefRule1(normalIds, layoutEdges, relIds);
  const reply = applyReplyLayoutAdjustmentsWithConstraints({ normals, edges: layoutEdges, baseCol: base.col, baseMaxCol: base.maxCol, relIds });
  const stance = applyAgreeDisagreeColumnOverride({ normals, edges: layoutEdges, ...reply });
  const columns = applyGroupingColumnOverride({ normals, edges: layoutEdges, ...stance });
  const keepEmptyFrameIds = new Set(traceExpandedFrameIds);
  for (const message of messages) {
    if (['merge', 'arrange'].includes(message.relationType ?? '') && !isRejectedContainer(message, rejectedContainerIds)
      && !hiddenMessageIds?.has(message.id) && !hiddenTargetIds.has(message.id)
      && !(edgesByRelMsg.get(message.id) ?? []).some(edge => edge.relationType === message.relationType
        && hasActiveDisplayEffect(edge, msgMap))) keepEmptyFrameIds.add(message.id);
  }
  const frameBlocks = buildFrameBlocks({ edges:edges.filter(edge=>!hiddenMessageIds?.has(edge.relationMessageId)), visibleCardIds: new Set(normalIds), msgMap,
    opaqueFrameIds:new Set([...classifyRelMsgIds,...summaryRelMsgIds].filter(id=>!isTraceWindow||!traceExpandedFrameIds.has(id))),
    keepEmptyFrameIds, cardFrameIds, traceMode: isTraceWindow }).filter(block =>
    !['classify', 'summary'].includes(msgMap.get(block.relMsgId)?.relationType ?? '')
    || isTraceWindow && traceExpandedFrameIds.has(block.relMsgId));
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
