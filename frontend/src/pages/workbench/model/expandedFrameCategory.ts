import type {DemoEdge,DemoMessage} from '../../../utils/modelBridge';
import {getPresentationSpec} from '../../../types';
import {edgeDisplayDependencyIds} from '../../../utils/displayDependency';

/** Capture the displayed frame, including nested organizations and attached records. */
export function expandedFrameScope(id:string,messages:DemoMessage[],edges:DemoEdge[]):string[]{
  const visible=new Set(messages.map(message=>message.id)),inside=new Set([id]);
  const owned=new Map<string,DemoEdge[]>();
  for(const edge of edges){const list=owned.get(edge.relationMessageId)??[];list.push(edge);owned.set(edge.relationMessageId,list);}
  let changed=true;
  while(changed){
    changed=false;
    const include=(child:string)=>{if(visible.has(child)&&!inside.has(child)){inside.add(child);changed=true;}};
    for(const parent of inside)for(const edge of owned.get(parent)??[])
      if(getPresentationSpec(edge.relationType).isContainer)include(edge.to.messageId);
    for(const message of messages){
      if(inside.has(message.id))continue;
      if(message.joinInfo&&inside.has(message.joinInfo.containerId)){include(message.id);continue;}
      const hosts=edgeDisplayDependencyIds(message,owned.get(message.id)??[]);
      if(hosts?.length&&hosts.every(host=>inside.has(host)))include(message.id);
    }
  }
  return [...inside];
}
