import { computeTransitiveVoteStats, convertMessagesToDemoModel } from '../../../frontend/src/utils/modelBridge.js';
import type { Message, Relation } from '../../../frontend/src/types/index.js';

/** Reuse the pure legacy view rules; never execute a funding/organization command. */
export function legacyOrganizationState(rows:Record<string,any>[], users:Record<string,any>[]) {
  const identities=new Map(users.map(user=>[user.id,{id:user.id,username:user.username}]));
  const active=rows.filter(row=>!row.supersededBy);
  const messages=active.map(row=>({...row,createdBy:identities.get(row.createdById)})) as Message[];
  const relations=active.filter(row=>row.relationType).map(row=>({...row,sourceMessageId:row.relSourceId,targetRefs:row.targetRefs??[],payload:row.relationPayload??{},createdBy:identities.get(row.createdById)})) as Relation[];
  const model=convertMessagesToDemoModel(messages,relations);
  const stats=computeTransitiveVoteStats(model.edges,model.messages);
  const rejected=new Set(Object.entries(stats).filter(([,value])=>value.disagreeCount>value.agreeCount).map(([id])=>id));
  const latest=new Map<string,{id:string;time:number}>();
  for(const relation of relations){
    if(relation.relationType!=='JOIN'||!relation.sourceMessageId||rejected.has(relation.id)||rejected.has(relation.sourceMessageId))continue;
    const time=Date.parse(relation.createdAt)||0;
    for(const ref of relation.targetRefs){
      const target=ref.kind==='relation'?ref.relationId:ref.messageId,previous=latest.get(target);
      if(!previous||time>previous.time)latest.set(target,{id:relation.id,time});
    }
  }
  const effectiveJoins=new Set([...latest.values()].map(record=>record.id));
  return {stats,rejected,effectiveJoins};
}
