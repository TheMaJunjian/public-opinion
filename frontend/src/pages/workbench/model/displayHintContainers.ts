import {isContainerType,type ContainerEffect} from './containerEffect';

/** Follow effective ownership without treating a container message as its own owner. */
export function createCurrentContainerLookup(effect:ContainerEffect,currentContainerId?:string|null) {
  const active=(id:string)=>isContainerType(effect.msgMap.get(id)?.relationType)&&!effect.rejectedContainerIds.has(id);
  const parents=new Map<string,Set<string>>();
  for(const membership of effect.memberships)for(const id of membership.targetIds){
    const values=parents.get(id)??new Set<string>();values.add(membership.containerId);parents.set(id,values);
  }
  const ancestors=(anchors:readonly string[])=>{
    const result=new Set<string>(),visited=new Set<string>(),queue=[...anchors];
    for(let index=0;index<queue.length;index++){
      const id=queue[index];if(visited.has(id))continue;visited.add(id);
      if(active(id))result.add(id);
      for(const parent of parents.get(id)??[])queue.push(parent);
    }
    return result;
  };
  const cache=new Map<string,ReadonlySet<string>>();
  return (messageId:string):ReadonlySet<string>=>{
    const previous=cache.get(messageId);if(previous)return previous;
    const message=effect.msgMap.get(messageId),anchors=message?.kind==='join'?message.joinInfo?.targetIds??[]:[messageId];
    const path=ancestors(anchors.flatMap(id=>[...parents.get(id)??[]]));
    // Starting at the parents also keeps outgoing JOIN records from making the
    // message's own container look like part of its containing path.
    for(const id of anchors)path.delete(id);
    const result=!currentContainerId||currentContainerId==='root'||anchors.includes(currentContainerId)||path.has(currentContainerId)?path:new Set<string>();
    cache.set(messageId,result);return result;
  };
}
