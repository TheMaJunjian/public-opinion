import type {DemoMessage,DemoEdge} from '../../../utils/modelBridge';
import {edgeDisplayDependencyIds} from '../../../utils/displayDependency';
import type {ContainerOwnership} from './ownership';

/** Only a classification with no displayed outside message receives a full-size frame. */
export function singleTraceClassification(messages:DemoMessage[],edges:DemoEdge[],ownership:ContainerOwnership):string|null{
  const classifications=messages.filter(message=>message.relationType==='classify');
  if(classifications.length!==1)return null;
  const id=classifications[0].id,members=ownership.owned(id),inside=new Set([id,...members.textIds,...members.relationIds]);
  const byOwner=new Map<string,DemoEdge[]>();
  for(const edge of edges){const own=byOwner.get(edge.relationMessageId)??[];own.push(edge);byOwner.set(edge.relationMessageId,own);}
  let changed=true;
  while(changed){changed=false;for(const message of messages){
    if(inside.has(message.id))continue;
    const hosts=edgeDisplayDependencyIds(message,byOwner.get(message.id)??[]);
    if(hosts?.length&&hosts.every(host=>inside.has(host))){inside.add(message.id);changed=true;}
  }}
  return messages.every(message=>inside.has(message.id))?id:null;
}
