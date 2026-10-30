import type { Relation } from "../../../types";
import { getPresentationSpec } from "../../../types";
import type {
  DemoEdge,
  DemoMessage
} from "../../../utils/modelBridge";
import { isContentKind } from "../../../utils/modelBridge";
import { applyTraceFrameVisibility, buildTraceProjection, type TraceContainerMembership } from "../../../utils/traceProjection";
import { collectContainerVisibleIds,collectOwnedByRelation,type ContainerOwnership } from '../model/ownership';
import { filterMessageListContext } from './messageListContext';
import type { TraceEntry } from "../types";
import type {TraceDirection} from '../../../utils/traceRange';
import { edgeDisplayDependencyIds } from '../../../utils/displayDependency';

interface DeriveGraphMessagesToRenderInput {
  frameScopeIds?: ReadonlySet<string>;
  containerOwnership?: ContainerOwnership;
  traceEntries: TraceEntry[];
  messagesToShow: DemoMessage[];
  messages: DemoMessage[];
  edgesToShow: DemoEdge[];
  edges: DemoEdge[];
  traceContainerMemberships: TraceContainerMembership[];
  effectiveSuppressedRelIdsForLayout: Set<string>;
  traceDistance: number;
  traceDepths?: import('../../../utils/traceRange').TraceDepths;
  traceDirection?: TraceDirection;
  traceExpandedFrameIds: Set<string>;
  isInsideClassify: boolean;
  currentClassifyRelMsgId: string | null;
  relationById: Map<string, Relation>;
  relations: Relation[];
  rejectedContainerIds: Set<string>;
  rejectedJoinRelationIds: Set<string>;
  msgMap: Map<string, DemoMessage>;
  activeClassifyOwnership: { textIds: Set<string>; relationIds: Set<string>; };
  classifiedTargetSummaryRelMsgIds: Set<string>;
  listExclusiveRelMsgIds: Set<string>;
  replacedRelationMsgIds: Set<string>;
  classifiedTargetTextIds: Set<string>;
  graphOwnedRelationIds: Set<string>;
  traceRelationMsgIds: Set<string>;
  classifiedTargetClassifyRelMsgIds: Set<string>;
  classifiedTargetMergeRelMsgIds: Set<string>;
  classifiedTargetARRANGERelMsgIds: Set<string>;
  activeSummaryOwnership: { textIds: Set<string>; relationIds: Set<string>; };
  graphExclusiveRelMsgIds: Set<string>;
  graphHiddenTextIds: Set<string>;
}

export function deriveGraphMessagesToRender(input: DeriveGraphMessagesToRenderInput): { graphMessagesToRender: DemoMessage[]; graphEdgesToRender: DemoEdge[]; listMessagesToRender: DemoMessage[]; listEdgesToRender: DemoEdge[]; hideMessageIds?: undefined; } | { graphMessagesToRender: DemoMessage[]; graphEdgesToRender: DemoEdge[]; listMessagesToRender: DemoMessage[]; listEdgesToRender: DemoEdge[]; hideMessageIds: Set<string> | undefined; } {
  const { traceEntries, messagesToShow, messages, edgesToShow, edges, traceContainerMemberships, effectiveSuppressedRelIdsForLayout, traceDistance, traceExpandedFrameIds, isInsideClassify, currentClassifyRelMsgId, relationById, relations, rejectedContainerIds, rejectedJoinRelationIds, msgMap, activeClassifyOwnership, classifiedTargetSummaryRelMsgIds, listExclusiveRelMsgIds, replacedRelationMsgIds, classifiedTargetTextIds, graphOwnedRelationIds, traceRelationMsgIds, classifiedTargetClassifyRelMsgIds, classifiedTargetMergeRelMsgIds, classifiedTargetARRANGERelMsgIds, activeSummaryOwnership, graphExclusiveRelMsgIds, graphHiddenTextIds } = input;
  const directMembers=(id:string)=>input.containerOwnership?.direct(id)??collectContainerVisibleIds(id,relations,rejectedContainerIds,rejectedJoinRelationIds);
  const ownedMembers=(id:string)=>input.containerOwnership?.owned(id)??collectOwnedByRelation(id,relationById,new Set(),rejectedContainerIds,rejectedJoinRelationIds);
  // A trace entry owns the canvas projection immediately. The classify state
  // is cleared asynchronously when entering trace, so checking it here can
  // render the old sub-canvas together with the new trace window.
  const useTraceWindow = traceEntries.length > 0;
  const scope=input.frameScopeIds;
  const baseMessages = (useTraceWindow ? messagesToShow : messages.filter(message => !message.state?.organizationRetired))
    .filter(message=>!scope||scope.has(message.id));
  const baseEdges = (useTraceWindow ? edgesToShow : edges).filter(edge=>!scope||scope.has(edge.relationMessageId)
    &&(edge.from.messageId.startsWith('anon:')||scope.has(edge.from.messageId))&&scope.has(edge.to.messageId));
  if (useTraceWindow) {
    const traceStartIds = traceEntries[traceEntries.length - 1].ids.filter(Boolean);
    const traceProjection = buildTraceProjection({
      messages,
      edges,
      containerMemberships: traceContainerMemberships,
      excludedRelationIds: effectiveSuppressedRelIdsForLayout,
      startIds: traceStartIds,
      distance: traceDistance,
      depths: input.traceDepths,
      direction: input.traceDirection,
      expandedContainerIds:new Set([...traceExpandedFrameIds,...traceStartIds]),
    });
    const listProjection = applyTraceFrameVisibility(
      traceProjection,
      new Set([...traceExpandedFrameIds, ...traceStartIds]),
    );
    return {
      graphMessagesToRender: baseMessages,
      graphEdgesToRender: baseEdges,
      listMessagesToRender: listProjection.messages,
      listEdgesToRender: listProjection.edges,
      hideMessageIds: undefined,
    };
  }
  if (isInsideClassify && currentClassifyRelMsgId && !useTraceWindow) {
    const classificationRelation = relationById.get(currentClassifyRelMsgId);
    const containerVisible = directMembers(currentClassifyRelMsgId);
    const classificationTextIds = new Set<string>(containerVisible.textIds);
    const classificationRelationIds = new Set<string>(containerVisible.relationIds);
    // Nested CLASSIFY/SUMMARY relations are opaque cards in the parent
    // canvas. Remove their full ownership closure, including JOIN descendants.
    for (const nestedRelationId of [...classificationRelationIds]) {
      const nestedRelation = relationById.get(nestedRelationId);
      const nestedType = nestedRelation?.relationType?.toUpperCase();
      if (nestedType !== 'CLASSIFY' && nestedType !== 'SUMMARY') continue;
      if(rejectedContainerIds.has(nestedRelationId)) continue;
      const nestedVisible = ownedMembers(nestedRelationId);
      for (const textId of nestedVisible.textIds) classificationTextIds.delete(textId);
      for (const relationId of nestedVisible.relationIds) classificationRelationIds.delete(relationId);
    }
    if (classificationRelation) {
      const queue = Array.from(classificationRelationIds);
      const visited = new Set<string>();
      while (queue.length > 0) {
        const relId = queue.shift();
        if (!relId || visited.has(relId)) continue;
        visited.add(relId);
        const rel = relationById.get(relId);
        if (!rel) continue;
        const relType = rel.relationType.toUpperCase();
        if (relType !== 'CLASSIFY' && relType !== 'MERGE' && relType !== 'ARRANGE' && relType !== 'SUMMARY') continue;
        // Include the source message of nested relations (not applicable to ARRANGE/CLASSIFY/MERGE/SUMMARY
        // which are user-to-message relations with no sourceMessageId, but may apply to other relation
        // types that appear as nested targets via future extensions).
        if (rel.sourceMessageId) {
          const srcId = rel.sourceMessageId;
          if (!classificationTextIds.has(srcId) && !classificationRelationIds.has(srcId)) {
            const srcMsg = msgMap.get(srcId);
            if (srcMsg && isContentKind(srcMsg.kind)) {
              classificationTextIds.add(srcId);
            } else if (srcMsg?.kind === 'relation') {
              classificationRelationIds.add(srcId);
              queue.push(srcId);
            }
          }
        }
        if (relType === 'ARRANGE' || relType === 'MERGE') {
          // ARRANGE and MERGE are framing relations: all content (text targets and
          // nested framing relations) is expanded inline.
          // CLASSIFY and SUMMARY targets are shown as scope cards but not expanded
          // (user must double-click to enter them).
          const nestedVisible=directMembers(relId);
          nestedVisible.textIds.forEach(id => classificationTextIds.add(id));
          nestedVisible.relationIds.forEach(id => {
            classificationRelationIds.add(id);
            const childRelType = relationById.get(id)?.relationType?.toUpperCase();
            if ((childRelType === 'ARRANGE' || childRelType === 'MERGE' || rejectedContainerIds.has(id)) && !visited.has(id)) {
              queue.push(id);
            }
            // CLASSIFY and SUMMARY remain as opaque scope cards.
          });
        } else {
          // CLASSIFY and SUMMARY: these are opaque scope cards — they are already in
          // classificationRelationIds (added when first encountered as targets), and GraphView
          // will render them as cards.  Their internal targets are NOT expanded into
          // the current view; the user must double-click to enter them.
          // Exception: rejected classifies release their messages into the parent view.
          if (rejectedContainerIds.has(relId)) {
            const nestedVisible=directMembers(relId);
            nestedVisible.textIds.forEach(id => classificationTextIds.add(id));
            nestedVisible.relationIds.forEach(id => {
              classificationRelationIds.add(id);
              const childRelType = relationById.get(id)?.relationType?.toUpperCase();
              if ((childRelType === 'ARRANGE' || childRelType === 'MERGE' || rejectedContainerIds.has(id)) && !visited.has(id)) {
                queue.push(id);
              }
            });
          }
        }
      }
    }
    // Frames can introduce classifications through JOINs during expansion.
    // Their descendants stay behind the classification card, including when
    // an annotation in the surrounding Topic refers to those descendants.
    const opaqueMembers=new Set<string>();
    for(const id of [...classificationRelationIds]) {
      const nested=relationById.get(id);
      if(!nested||!['CLASSIFY','SUMMARY'].includes(nested.relationType.toUpperCase())||rejectedContainerIds.has(id))continue;
      const owned=ownedMembers(id);
      for(const member of owned.textIds){opaqueMembers.add(member);classificationTextIds.delete(member);}
      for(const member of owned.relationIds){opaqueMembers.add(member);classificationRelationIds.delete(member);}
    }
    for (const e of baseEdges) {
      if (!classificationRelationIds.has(e.relationMessageId)) continue;
      const relation = relationById.get(e.relationMessageId);
      if (relation?.relationType.toUpperCase() !== 'ANNOTATION') continue;
      for (const endpointId of [e.from.messageId, e.to.messageId]) {
        const endpoint = msgMap.get(endpointId);
        if (endpoint && isContentKind(endpoint.kind)&&!opaqueMembers.has(endpointId)) classificationTextIds.add(endpointId);
      }
    }
    // Expand classificationTextIds with text messages that have CORRECT (更正) relations
    // with any text message already in the scope, and add the CORRECT relation
    // messages between such pairs to classificationRelationIds.
    // This implements: when T1 is in the scope, CORRECT-related T2 and the
    // CORRECT relation message are automatically included in the scope view.
    {
      const correctQ = Array.from(classificationTextIds);
      const correctVisited = new Set<string>();
      while (correctQ.length > 0) {
        const tid = correctQ.shift()!;
        if (correctVisited.has(tid)) continue;
        correctVisited.add(tid);
        for (const e of baseEdges) {
          if (e.relationType !== 'correct') continue;
          const record = msgMap.get(e.relationMessageId);
          if (record?.parts?.length || record?.relationPayload?.correctionKind === 'WIDTH') continue;
          if (msgMap.get(e.from.messageId)?.kind !== 'normal' || msgMap.get(e.to.messageId)?.kind !== 'normal') continue;
          if (e.from.messageId !== tid && e.to.messageId !== tid) continue;
          classificationRelationIds.add(e.relationMessageId);
          const other = e.from.messageId === tid ? e.to.messageId : e.from.messageId;
          if (!classificationTextIds.has(other)&&!opaqueMembers.has(other)) {
            classificationTextIds.add(other);
            correctQ.push(other);
          }
        }
      }
    }
    const edgesByRel = new Map<string, DemoEdge[]>();
    for (const e of baseEdges) {
      const arr = edgesByRel.get(e.relationMessageId) ?? [];
      arr.push(e);
      edgesByRel.set(e.relationMessageId, arr);
    }
    let attachedAdded = true;
    while (attachedAdded) {
      attachedAdded = false;
      for (const [relMsgId, relEdges] of edgesByRel) {
        if (relMsgId === currentClassifyRelMsgId || classificationRelationIds.has(relMsgId)) continue;
        // Organization membership is explicit. Sharing a visible endpoint must
        // not pull an ancestor container back into its own descendant canvas.
        if(getPresentationSpec(relEdges[0]?.relationType??'').isContainer)continue;
        const hosts = edgeDisplayDependencyIds(msgMap.get(relMsgId), relEdges);
        if (hosts !== null) {
          if (hosts.some(id => classificationTextIds.has(id) || classificationRelationIds.has(id))) {
            classificationRelationIds.add(relMsgId);
            attachedAdded = true;
          }
          continue;
        }
        const textEndpoints = relEdges
          .flatMap(e => [e.from.messageId, e.to.messageId])
          .filter(mid => { const m = msgMap.get(mid); return m && isContentKind(m.kind); });
        if (textEndpoints.length > 0) {
          // Governance/code/ops can be content-like relation targets.
          if (textEndpoints.every(mid => classificationTextIds.has(mid) || classificationRelationIds.has(mid))) {
            classificationRelationIds.add(relMsgId);
            attachedAdded = true;
          }
          continue;
        }
        const relEndpoints = relEdges
          .flatMap(e => [e.from.messageId, e.to.messageId])
          .filter(mid => msgMap.get(mid)?.kind === 'relation');
        if (relEndpoints.some(mid => classificationRelationIds.has(mid))) {
          classificationRelationIds.add(relMsgId);
          attachedAdded = true;
        }
      }
    }
    const visibleIds = new Set<string>([...classificationTextIds, ...classificationRelationIds]);
    const classificationMessages = baseMessages.filter(m => visibleIds.has(m.id));
    // The graph keeps nested SUMMARY targets inside the summary frame, but
    // the message table should list the dependent target messages alongside
    // the summary card in the current classify scope.
    const nestedSummaryTargetIds = new Set<string>();
    for (const nestedRelationId of classificationRelationIds) {
      const nestedRelation = relationById.get(nestedRelationId);
      if (nestedRelation?.relationType.toUpperCase() !== 'SUMMARY') continue;
      const nestedVisible = collectContainerVisibleIds(
        nestedRelationId,
        relations,
        rejectedContainerIds,
        rejectedJoinRelationIds,
      );
      nestedVisible.textIds.forEach(id => nestedSummaryTargetIds.add(id));
    }
    const listVisibleIds = new Set([...visibleIds, ...nestedSummaryTargetIds]);
    // Select from the original stream so summary targets keep their send order.
    const classificationListMessages = filterMessageListContext(
      baseMessages.filter(message => listVisibleIds.has(message.id)), baseMessages, baseEdges);
    // Include edges whose relation message is visible.  For CLASSIFY and SUMMARY
    // edges, keep them even when the target text messages are not in visibleIds —
    // this lets scope cards display correct target counts and lets SUMMARY compute
    // its hiddenTargetIds for covered messages.
    const classificationEdges = baseEdges.filter(e => {
      if (!visibleIds.has(e.relationMessageId)) return false;
      // Keep membership edges for counts and navigation. GraphView already
      // renders nested classifications as opaque cards, not expanded frames.
      if (e.relationType === 'classify' || e.relationType === 'summary') return true;
      const hosts = edgeDisplayDependencyIds(msgMap.get(e.relationMessageId), edgesByRel.get(e.relationMessageId) ?? [e]);
      if (hosts !== null) return hosts.some(id => visibleIds.has(id));
      return (e.from.messageId.startsWith("anon:") || visibleIds.has(e.from.messageId)) &&
        visibleIds.has(e.to.messageId);
    });
    return {
      graphMessagesToRender: classificationMessages,
      graphEdgesToRender: classificationEdges,
      listMessagesToRender: classificationListMessages,
      listEdgesToRender: classificationEdges,
    };
  }

  // listHiddenRelationIds: relation messages to hide in the linear list view.
  // All CLASSIFY-owned relations are hidden — they belong to the CLASSIFY scope
  // and should not appear in the parent scope's flat list.
  // CLASSIFY and SUMMARY relation messages that are owned by CLASSIFY are hidden (they are
  // the classification containers and are shown in the graph view as scope cards).
  // MERGE owned by CLASSIFY is also hidden (intermediate grouping structure).
  // arrange owned by CLASSIFY is unconditionally hidden — its text messages are already
  // classified, and the arrange container itself should not appear in the main view.
  // arrange NOT owned by CLASSIFY is only hidden when ALL its text endpoints
  // are classified (via listExclusiveRelMsgIds).
  //
  // In trace mode, baseMessages is filtered by BFS and frame expansion;
  // ordinary classified-message hiding still applies below.
  const skipClassifyHiding = isInsideClassify;
  const listHiddenRelationIds = new Set<string>([
    ...activeClassifyOwnership.relationIds,
    ...classifiedTargetSummaryRelMsgIds,
    ...listExclusiveRelMsgIds,
    ...replacedRelationMsgIds,
  ]);
  const directlyTracedFrameMemberIds = new Set<string>();
  if (useTraceWindow) {
    for (const edge of edges) {
      if (!traceExpandedFrameIds.has(edge.relationMessageId)) continue;
      if (!isTraceExpandableFrameType(edge.relationType)) continue;
      if (!edge.from.messageId.startsWith('anon:')) directlyTracedFrameMemberIds.add(edge.from.messageId);
      if (!edge.to.messageId.startsWith('anon:')) directlyTracedFrameMemberIds.add(edge.to.messageId);
    }
    for (const edge of edges) {
      if (edge.relationType.toLowerCase() !== 'correct') continue;
      if (!directlyTracedFrameMemberIds.has(edge.from.messageId) && !directlyTracedFrameMemberIds.has(edge.to.messageId)) continue;
      if (!edge.from.messageId.startsWith('anon:')) directlyTracedFrameMemberIds.add(edge.from.messageId);
      if (!edge.to.messageId.startsWith('anon:')) directlyTracedFrameMemberIds.add(edge.to.messageId);
    }
    for (const frameId of traceExpandedFrameIds) {
      const expandedMembers = collectContainerVisibleIds(
        frameId,
        relations,
        rejectedContainerIds,
        rejectedJoinRelationIds,
      );
      expandedMembers.textIds.forEach(messageId => directlyTracedFrameMemberIds.add(messageId));
    }
    // Expansion exposes only the direct members of an explicitly expanded
    // SUMMARY/CLASSIFY frame. MERGE and ARRANGE remain ordinary relations in
    // trace mode and must not recursively expand through this path.
    for (const frameId of traceExpandedFrameIds) {
      for (const edge of edges) {
        if (edge.relationMessageId !== frameId) continue;
        for (const memberId of [edge.from.messageId, edge.to.messageId]) {
          if (memberId.startsWith('anon:')) continue;
          directlyTracedFrameMemberIds.add(memberId);
        }
      }
    }
  }
  const listMessages = skipClassifyHiding
    ? baseMessages
    : baseMessages.filter(m => {
      if (isContentKind(m.kind) && classifiedTargetTextIds.has(m.id)) return false;
      if (m.kind === "relation" && listHiddenRelationIds.has(m.id)) return false;
      // Hide content-kind messages owned by a classify (e.g. governance/ops cards)
      if (isContentKind(m.kind) && graphOwnedRelationIds.has(m.id) && !directlyTracedFrameMemberIds.has(m.id)) return false;
      return true;
    });
  const listVisibleIds = new Set(listMessages.map(m => m.id));
  // Edge is visible in list view when the relation message is visible AND
  // the edge does not connect to a classified (hidden) text endpoint.
  // Edges of directly-traced relation messages are always included
  // so the relation structure is fully visible (fix: REFERENCE edge focus).
  const listEdges = baseEdges.filter(e => {
    if (!listVisibleIds.has(e.relationMessageId) && !traceRelationMsgIds.has(e.relationMessageId)) return false;
    // Edges of traced relations: always visible
    if (traceRelationMsgIds.has(e.relationMessageId)) return true;
    const fromOk = e.from.messageId.startsWith('anon:') || listVisibleIds.has(e.from.messageId);
    const toOk = listVisibleIds.has(e.to.messageId);
    return fromOk && toOk;
  });

  // graphHiddenRelationIds: relation messages to hide in the non-linear graph view.
  // Unconditionally hide CLASSIFY-owned CLASSIFY/SUMMARY/MERGE/arrange containers and replaced relations.
  // arrange owned by CLASSIFY is unconditionally hidden — its text messages are already
  // classified via collectOwnedByRelation, and the arrange container should not appear.
  // arrange NOT owned by CLASSIFY is only hidden when ALL its text endpoints
  // are in the hidden set (via graphExclusiveRelMsgIds).
  //
  // Trace mode uses the same ordinary visibility hiding as the main view.
  const graphHiddenRelationIds = new Set<string>([
    ...activeClassifyOwnership.relationIds,
    ...classifiedTargetClassifyRelMsgIds,
    ...classifiedTargetMergeRelMsgIds,
    ...classifiedTargetSummaryRelMsgIds,
    ...classifiedTargetARRANGERelMsgIds,
    ...activeSummaryOwnership.relationIds,
    ...graphExclusiveRelMsgIds,
    ...replacedRelationMsgIds,
  ]);
  const traceParentClassifyId = useTraceWindow
    ? traceEntries[traceEntries.length - 1]?.classifyRelMsgId
    ?? edges.find(edge =>
      edge.relationMessageId !== traceEntries[traceEntries.length - 1]?.ids[0]
      && getPresentationSpec(edge.relationType).isContainer
      && (edge.from.messageId === traceEntries[traceEntries.length - 1]?.ids[0]
        || edge.to.messageId === traceEntries[traceEntries.length - 1]?.ids[0])
    )?.relationMessageId
    ?? null
    : null;
  const traceParentFrameExpanded = traceParentClassifyId !== null
    && traceExpandedFrameIds.has(traceParentClassifyId);
  const traceNestedOpaqueRelationIds = new Set<string>();
  const traceOpaqueMemberOwners = new Map<string, Set<string>>();
  if (traceParentClassifyId) {
    const parentVisible = collectContainerVisibleIds(
      traceParentClassifyId,
      relations,
      rejectedContainerIds,
      rejectedJoinRelationIds,
    );
    for (const relationId of parentVisible.relationIds) {
      if (relationId === traceParentClassifyId) continue;
      const relation = relationById.get(relationId);
      const relationType = relation?.relationType?.toUpperCase();
      if (relationType === 'CLASSIFY' || relationType === 'SUMMARY') {
        traceNestedOpaqueRelationIds.add(relationId);
        const nestedVisible = collectContainerVisibleIds(
          relationId,
          relations,
          rejectedContainerIds,
          rejectedJoinRelationIds,
        );
        nestedVisible.textIds.forEach(messageId => {
          const owners = traceOpaqueMemberOwners.get(messageId) ?? new Set<string>();
          owners.add(relationId);
          traceOpaqueMemberOwners.set(messageId, owners);
        });
      }
    }
  }
  for (const relationId of traceRelationMsgIds) {
    const relation = relationById.get(relationId);
    const relationType = relation?.relationType?.toUpperCase();
    if (relationType !== 'CLASSIFY' && relationType !== 'SUMMARY') continue;
    const nestedVisible = collectContainerVisibleIds(
      relationId,
      relations,
      rejectedContainerIds,
      rejectedJoinRelationIds,
    );
    nestedVisible.textIds.forEach(messageId => {
      const owners = traceOpaqueMemberOwners.get(messageId) ?? new Set<string>();
      owners.add(relationId);
      traceOpaqueMemberOwners.set(messageId, owners);
    });
  }
  const graphMessages = skipClassifyHiding && !useTraceWindow
    ? baseMessages
    : baseMessages.filter(m => {
      if (isContentKind(m.kind) && graphHiddenTextIds.has(m.id) && !directlyTracedFrameMemberIds.has(m.id)) return false;
      if (useTraceWindow && m.id === traceParentClassifyId) return true;
      if (m.kind === "relation" && graphHiddenRelationIds.has(m.id) && !traceRelationMsgIds.has(m.id)) return false;
      if (useTraceWindow && traceNestedOpaqueRelationIds.has(m.id)
        && !traceExpandedFrameIds.has(m.id) && !traceParentFrameExpanded) return false;
      if (useTraceWindow && isContentKind(m.kind) && traceOpaqueMemberOwners.has(m.id)) {
        const owners = traceOpaqueMemberOwners.get(m.id)!;
        if (![...owners].some(relationId => traceExpandedFrameIds.has(relationId))) return false;
      }
      // Hide content-kind messages owned by a classify (e.g. governance/ops cards)
      if (isContentKind(m.kind) && graphOwnedRelationIds.has(m.id) && !directlyTracedFrameMemberIds.has(m.id)) return false;
      return true;
    });
  if (useTraceWindow) {
    for (const memberId of directlyTracedFrameMemberIds) {
      const member = messages.find(message => message.id === memberId);
      if (member && !graphMessages.some(message => message.id === memberId)) graphMessages.push(member);
    }
  }
  const graphVisibleIds = new Set(graphMessages.map(m => m.id));

  // Edge is visible in graph view when the relation message is visible AND
  // the edge does not connect to a classified (hidden) text endpoint.
  // Edges of directly-traced relation messages are always included
  // so the relation structure is fully visible (fix: REFERENCE edge focus).
  // CLASSIFY / SUMMARY edges are always included so their scope cards can
  // display the correct target count, even when targets are hidden.
  const graphEdges = baseEdges.filter(e => {
    // CORRECT relations are rendered as decorations on their target cards.
    // Keep them when the target is visible even if the relation message is hidden.
    if (e.relationType === 'correct' && graphVisibleIds.has(e.to.messageId)) return true;
    if (!graphVisibleIds.has(e.relationMessageId) && !traceRelationMsgIds.has(e.relationMessageId)) return false;
    // Edges of traced relations: always visible
    if (traceRelationMsgIds.has(e.relationMessageId)) return true;
    // CLASSIFY / SUMMARY: keep edges so scope card target count is correct
    if (e.relationType === 'classify' || e.relationType === 'summary') return true;
    const fromOk = e.from.messageId.startsWith('anon:') || graphVisibleIds.has(e.from.messageId);
    const toOk = graphVisibleIds.has(e.to.messageId);
    return fromOk && toOk;
  });
  // A container relation can be filtered from graphMessages because it belongs
  // to another container while its frame edges are still retained above. Keep
  // that relation message available so frame headers can read its payload.
  const frameRelationIds = new Set(
    graphEdges
      .filter(edge => getPresentationSpec(edge.relationType).isContainer)
      .map(edge => edge.relationMessageId),
  );
  const frameMessages = baseMessages.filter(message =>
    message.kind === 'relation' && frameRelationIds.has(message.id)
    && !(traceNestedOpaqueRelationIds.has(message.id)
      && !traceExpandedFrameIds.has(message.id) && !traceParentFrameExpanded),
  );
  const graphMessagesToRender = [
    ...graphMessages,
    ...frameMessages.filter(message => !graphVisibleIds.has(message.id)),
  ];
  // In trace mode, container-type relation messages are rendered as group
  // frames so their members are shown on the embedded canvas.
  const hiddenFrameMessageIds = frameMessages
    .filter(message => !graphVisibleIds.has(message.id) && (
      !useTraceWindow
      || !isTraceExpandableFrameType(message.relationType ?? '')
      || traceExpandedFrameIds.has(message.id)
      || (traceNestedOpaqueRelationIds.has(message.id) && traceParentFrameExpanded)
    ))
    .map(message => message.id);
  const hideMessageIds = new Set([
    ...(useTraceWindow
      ? graphMessages
        .filter(m => m.kind === 'relation' && m.relationType && getPresentationSpec(m.relationType).isContainer && !isTraceExpandableFrameType(m.relationType))
        .map(m => m.id)
      : []),
    ...hiddenFrameMessageIds,
  ]);

  return {
    graphMessagesToRender: graphMessagesToRender,
    graphEdgesToRender: graphEdges,
    listMessagesToRender: filterMessageListContext(listMessages, baseMessages, baseEdges),
    listEdgesToRender: listEdges,
    hideMessageIds: hideMessageIds.size > 0 ? hideMessageIds : undefined,
  };
}

function isTraceExpandableFrameType(relationType: string): boolean {
  const normalizedType = relationType.toLowerCase();
  return normalizedType === 'summary' || normalizedType === 'classify';
}
