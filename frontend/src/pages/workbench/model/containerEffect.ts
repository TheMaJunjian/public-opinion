import type { Relation } from '../../../types';
import { computeEffectiveSuppressedRelIds, computeTransitiveVoteStats, type DemoEdge, type DemoMessage } from '../../../utils/modelBridge';
import { filterContainerEdgesByEffectiveJoins, getEffectiveJoinRelationIds, getRejectedJoinRelationIds, projectJoinMembershipEdges } from './membership';
import { createContainerOwnership } from './ownership';
import type { TraceContainerMembership } from '../../../utils/traceProjection';

export const isContainerType = (type: string | undefined) => ['CLASSIFY','SUMMARY','MERGE','ARRANGE'].includes(type?.toUpperCase() ?? '');
export type EffectAssumption = { messageId: string; side: 'agree' | 'disagree' };

/** Pure organization state shared by normal view, preview and both comparison sides. */
export function deriveContainerEffect(input: {
  messages: DemoMessage[]; relations: Relation[]; edges: DemoEdge[];
  username: string | null; assumption?: EffectAssumption;
}) {
  const { assumption, username } = input;
  const messages = assumption ? input.messages.map(message => message.id === assumption.messageId ? {
    ...message,
    state: {
      messageId: message.id, revision: message.revision ?? 1,
      supportCount: 0, oppositionCount: 0, recommendationTotal: 0,
      ...message.state, suppressed: assumption.side === 'disagree',
    },
  } : message) : input.messages;
  const msgMap = new Map(messages.map(message => [message.id,message]));
  const relations = assumption ? input.relations.map(relation => relation.id === assumption.messageId
    ? {...relation,state:msgMap.get(relation.id)?.state} : relation) : input.relations;
  const relationById = new Map(relations.map(relation => [relation.id,relation]));
  const suppressed = computeEffectiveSuppressedRelIds(input.edges,messages,username);
  if(assumption){
    if(assumption.side === 'agree')suppressed.delete(assumption.messageId);
    else suppressed.add(assumption.messageId);
    // Dependent annotations follow the same assumed state, including chains.
    let changed=true;
    while(changed){
      changed=false;
      for(const edge of input.edges){
        if(edge.relationType !== 'annotation'||suppressed.has(edge.relationMessageId))continue;
        if(suppressed.has(edge.from.messageId)||suppressed.has(edge.to.messageId)){
          suppressed.add(edge.relationMessageId);changed=true;
        }
      }
    }
  }
  const rejectedContainerIds = new Set(relations.filter(relation => isContainerType(relation.relationType)&&suppressed.has(relation.id)).map(relation => relation.id));
  const rejectedJoinRelationIds = new Set(getRejectedJoinRelationIds(relations,computeTransitiveVoteStats(input.edges,messages)));
  // Native state and personal rejection must affect ownership as well as edges.
  for(const relation of relations)if(relation.relationType.toUpperCase()==='JOIN'){
    if(suppressed.has(relation.id))rejectedJoinRelationIds.add(relation.id);
    else if(msgMap.get(relation.id)?.state||assumption?.messageId===relation.id)rejectedJoinRelationIds.delete(relation.id);
  }
  const effectiveJoinIds = getEffectiveJoinRelationIds(relations,rejectedContainerIds,rejectedJoinRelationIds,suppressed);
  const ownership = createContainerOwnership(relations,rejectedContainerIds,rejectedJoinRelationIds);
  const containerIds = new Set(relations.filter(relation=>isContainerType(relation.relationType)).map(relation=>relation.id));
  const projectEdges = (edges:DemoEdge[],visibleContainers:ReadonlySet<string>) => projectJoinMembershipEdges(
    filterContainerEdgesByEffectiveJoins(edges,relations,effectiveJoinIds),relations,effectiveJoinIds,visibleContainers,
  ).filter(edge=>!suppressed.has(edge.relationMessageId));
  const edges = projectEdges(input.edges,containerIds);
  const memberships:TraceContainerMembership[] = relations.filter(relation=>
    effectiveJoinIds.has(relation.id)&&relation.sourceMessageId&&containerIds.has(relation.sourceMessageId),
  ).map(relation=>({containerId:relation.sourceMessageId!,relationType:relationById.get(relation.sourceMessageId!)!.relationType.toLowerCase() as DemoEdge['relationType'],targetIds:relation.targetRefs.map(ref=>ref.kind==='relation'?ref.relationId:ref.messageId)}));
  const context = {
    relatedMessages: messages, rejectedContainerIds,
    joinStatusByMessage: new Map([...effectiveJoinIds].map(id=>[id,'valid' as const])),
  };
  return {messages,relations,edges,msgMap,relationById,suppressed,rejectedContainerIds,rejectedJoinRelationIds,effectiveJoinIds,ownership,memberships,projectEdges,context};
}

export type ContainerEffect=ReturnType<typeof deriveContainerEffect>;
