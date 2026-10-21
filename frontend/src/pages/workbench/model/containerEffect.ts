import type { Relation } from '../../../types';
import { computeEffectiveSuppressedRelIds, computeTransitiveVoteStats, type DemoEdge, type DemoMessage } from '../../../utils/modelBridge';
import { filterContainerEdgesByEffectiveJoins, getEffectiveJoinByTarget, getJoinStatusByMessage, getRejectedJoinRelationIds, projectJoinMembershipEdges } from './membership';
import { createContainerOwnership } from './ownership';
import type { TraceContainerMembership } from '../../../utils/traceProjection';
import { resolveJoinDisplay, type JoinStakeCounts } from './joinDisplay';

export const isContainerType = (type: string | undefined) => ['CLASSIFY','SUMMARY','MERGE','ARRANGE'].includes(type?.toUpperCase() ?? '');
export type EffectAssumption = { messageId: string; side: 'agree' | 'disagree' };

/** Pure organization state shared by normal view, preview and both comparison sides. */
export function deriveContainerEffect(input: {
  messages: DemoMessage[]; relations: Relation[]; edges: DemoEdge[];
  username: string | null; assumption?: EffectAssumption;
  /** User-facing views supply counts (including {}); omission projects the protocol index for import/reconciliation. */
  stakeCounts?: JoinStakeCounts;
}) {
  const { assumption, username } = input;
  let messages = assumption ? input.messages.map(message => message.id === assumption.messageId ? {
    ...message,
    state: {
      messageId: message.id, revision: message.revision ?? 1,
      supportCount: 0, oppositionCount: 0, recommendationTotal: 0,
      ...message.state, suppressed: assumption.side === 'disagree',
    },
  } : message) : input.messages;
  let msgMap = new Map(messages.map(message => [message.id,message]));
  let relations = assumption ? input.relations.map(relation => relation.id === assumption.messageId
    ? {...relation,state:msgMap.get(relation.id)?.state} : relation) : input.relations;
  let relationById = new Map(relations.map(relation => [relation.id,relation]));
  let suppressed = computeEffectiveSuppressedRelIds(input.edges,messages,username);
  const display = input.stakeCounts ? resolveJoinDisplay({relations,messages,edges:input.edges,username,
    stakes:input.stakeCounts,suppressed,assumption}) : null;
  if(display)suppressed=display.suppressed;
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
  // Retirement is administrative history, not a stance that previews or votes can reverse.
  for (const message of messages) if (message.state?.organizationRetired || message.state?.membershipDisabled) suppressed.add(message.id);
  const rejectedContainerIds = new Set(relations.filter(relation => isContainerType(relation.relationType)&&suppressed.has(relation.id)).map(relation => relation.id));
  const rejectedJoinRelationIds = new Set(getRejectedJoinRelationIds(relations,computeTransitiveVoteStats(input.edges,messages)));
  // Native state and personal rejection must affect ownership as well as edges.
  for(const relation of relations)if(relation.relationType.toUpperCase()==='JOIN'){
    if(suppressed.has(relation.id))rejectedJoinRelationIds.add(relation.id);
    else if(msgMap.get(relation.id)?.state||assumption?.messageId===relation.id)rejectedJoinRelationIds.delete(relation.id);
  }
  const joinByTarget = display?.byTarget??getEffectiveJoinByTarget(relations,rejectedContainerIds,rejectedJoinRelationIds,suppressed);
  const effectiveJoinIds = new Set(joinByTarget.values());
  if(display){
    messages=messages.map(message=>{
      const relation=relationById.get(message.id),join=relation?.relationType.toUpperCase()==='JOIN';
      if(!join&&!isContainerType(relation?.relationType))return message;
      return {...message,state:{messageId:message.id,revision:message.revision??1,supportCount:0,oppositionCount:0,recommendationTotal:0,
        ...message.state,suppressed:suppressed.has(message.id),...(join?{membershipActive:effectiveJoinIds.has(message.id)}:{})}};
    });
    msgMap=new Map(messages.map(message=>[message.id,message]));
    relations=relations.map(relation=>({...relation,state:msgMap.get(relation.id)?.state??relation.state}));
    relationById=new Map(relations.map(relation=>[relation.id,relation]));
  }
  const ownership = createContainerOwnership(relations,rejectedContainerIds,rejectedJoinRelationIds,display?.byTarget);
  const containerIds = new Set(relations.filter(relation=>isContainerType(relation.relationType)).map(relation=>relation.id));
  const projectEdges = (edges:DemoEdge[],visibleContainers:ReadonlySet<string>) => projectJoinMembershipEdges(
    filterContainerEdgesByEffectiveJoins(edges,relations,effectiveJoinIds,joinByTarget),relations,effectiveJoinIds,visibleContainers,joinByTarget,
  ).filter(edge=>!suppressed.has(edge.relationMessageId));
  // Trace uses the same winning membership edges as the canvas, retaining
  // suppressed relations here so an explicit trace anchor can still reach them.
  const traceEdges = projectJoinMembershipEdges(
    filterContainerEdgesByEffectiveJoins(input.edges,relations,effectiveJoinIds,joinByTarget),relations,effectiveJoinIds,containerIds,joinByTarget,
  );
  const edges = traceEdges.filter(edge=>!suppressed.has(edge.relationMessageId));
  // Resolve each target independently, including older multi-target JOINs.
  // Use declarations for this index: display edges may already point at a
  // corrected version while the original message still owns the membership.
  const memberships:TraceContainerMembership[] = [...containerIds].map(containerId=>{
    const direct = ownership.direct(containerId);
    return {containerId,relationType:relationById.get(containerId)!.relationType.toLowerCase() as DemoEdge['relationType'],
      targetIds:[...direct.textIds,...direct.relationIds]};
  });
  const context = {
    relatedMessages: messages, relatedEdges: edges, rejectedContainerIds,
    joinStatusByMessage: getJoinStatusByMessage(relations,effectiveJoinIds,rejectedContainerIds,rejectedJoinRelationIds),
    joinEffectSourcesByMessage: display?.sourcesByJoin,
  };
  return {messages,relations,edges,traceEdges,msgMap,relationById,suppressed,rejectedContainerIds,rejectedJoinRelationIds,effectiveJoinIds,joinByTarget,ownership,memberships,projectEdges,context,stakeCounts:input.stakeCounts};
}

export type ContainerEffect=ReturnType<typeof deriveContainerEffect>;
