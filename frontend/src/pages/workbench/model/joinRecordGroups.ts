import type {Relation} from '../../../types';
import type {ContainerEffect} from './containerEffect';

export type JoinTargetLocation='container'|'nested'|'outside';
export const JOIN_TARGET_LOCATION_LABELS:Record<JoinTargetLocation,string>={container:'本容器',nested:'嵌套容器中',outside:'范围外'};
export type JoinRecordEntry={id:string;adopted:boolean;targets:{id:string;adopted:boolean;location:JoinTargetLocation}[]};

/** Record adoption and target location are separate facts, both from current ownership. */
export function groupContainerJoinRecords(containerId:string,records:readonly Relation[],effect:Pick<ContainerEffect,'memberships'|'joinByTarget'>){
  const members=new Map(effect.memberships.map(membership=>[membership.containerId,membership.targetIds]));
  const direct=new Set(members.get(containerId)??[]),nested=new Set<string>(),visited=new Set([containerId]),queue=[...direct];
  for(let index=0;index<queue.length;index++){
    const id=queue[index];if(visited.has(id))continue;visited.add(id);
    for(const child of members.get(id)??[]){
      if(child!==containerId&&!direct.has(child))nested.add(child);
      if(!visited.has(child))queue.push(child);
    }
  }
  const adopted:JoinRecordEntry[]=[],unadopted:JoinRecordEntry[]=[];
  for(const record of records){
    if(record.relationType.toUpperCase()!=='JOIN'||record.sourceMessageId!==containerId)continue;
    const ids=[...new Set(record.targetRefs.map(ref=>ref.kind==='relation'?ref.relationId:ref.messageId))];
    const targets=ids.map(id=>({id,adopted:effect.joinByTarget.get(id)===record.id,
      location:(id!==containerId&&direct.has(id)?'container':nested.has(id)?'nested':'outside') as JoinTargetLocation}));
    const entry={id:record.id,adopted:targets.some(target=>target.adopted),targets};
    (entry.adopted?adopted:unadopted).push(entry);
  }
  return {adopted,unadopted};
}
