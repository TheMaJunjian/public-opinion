import type {DemoMessage} from './modelBridge';
import type {Reference} from '@gonglun/core';
export interface RelatedMessage {message:DemoMessage;target?:Reference}
const containers=new Set(['classify','summary','merge','arrange']);
export function isRejectedContainer(message:DemoMessage,ids?:ReadonlySet<string>) {
 return containers.has(message.relationType??'')&&!!(ids?ids.has(message.id):message.state?.suppressed);
}
/** Retain rejected organization records beside the messages released from them.
 * Pure votes and round records already have graph presentations.
 */
export function indexRelatedMessages(messages:DemoMessage[],rejectedIds?:ReadonlySet<string>) {
  const rejected=new Map(messages.filter(message=>isRejectedContainer(message,rejectedIds)).map(message=>[message.id,message]));
  const targets=new Map<string,Set<string>>();
  const add=(container:string,target:string)=>{if(target===container)return;const ids=targets.get(container)??new Set<string>();ids.add(target);targets.set(container,ids);};
  for(const message of rejected.values()) {
    for(const ref of [...message.targetRefs??[],...message.declaredTargetRefs??[]])add(message.id,ref.kind==='relation'?ref.relationId:ref.messageId);
    for(const part of message.parts??[])if(part.type==='relation'&&containers.has(part.relation))for(const binding of part.roles.members??[])add(message.id,binding.reference.messageId);
  }
  for(const message of messages) {
    const parent=message.joinInfo?.containerId??(String(message.relationType)==='join'?message.sourceMessageId:undefined);
    if(parent&&rejected.has(parent))for(const ref of message.targetRefs??[])add(parent,ref.kind==='relation'?ref.relationId:ref.messageId);
    // Native member-of may be present even on a compound message, without a JOIN view.
    for(const part of message.parts??[])if(part.type==='relation'&&part.relation==='member-of')for(const binding of part.roles.parent??[])if(rejected.has(binding.reference.messageId))for(const member of part.roles.member??[{id:'self',reference:{messageId:message.id}}])add(binding.reference.messageId,member.reference.messageId);
  }
  const result=new Map<string,RelatedMessage[]>();
  for(const [id,members] of targets) {
    const released=new Set(members),visited=new Set<string>([id]),queue=[...members];
    for(let cursor=0;cursor<queue.length;cursor++) {
      const child=queue[cursor];if(visited.has(child)||!rejected.has(child))continue;visited.add(child);
      for(const member of targets.get(child)??[])if(member!==id&&!released.has(member)){released.add(member);queue.push(member);}
    }
    for(const target of released){const rows=result.get(target)??[];rows.push({message:rejected.get(id)!,target:{messageId:target}});result.set(target,rows);}
  }
  return result;
}
