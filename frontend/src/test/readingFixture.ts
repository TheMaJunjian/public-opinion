import {messageReadingKey,type ReadingMark} from '@gonglun/core';
import {displayedBodyVersion} from '../utils/bodyVersions';
import {displaySignature,parentsFor,snapshot,type DisplayHintsInput} from '../pages/workbench/model/displayHintSnapshot';
import {readingInfluences,influenceReadingMarks} from '../pages/workbench/model/readingProgress';
import {effectiveCardWidths} from '../utils/cardWidth';

/** Test shorthand for explicit new-format confirmations, not a runtime converter. */
export function withFixtureReadingMarks(input:DisplayHintsInput):DisplayHintsInput {
  const statuses=new Map(input.readStatus),signatures=new Map<string,string>(),times=new Map<string,string>();
  for(const relation of [...input.relations].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)))if(['READ','UNREAD'].includes(relation.relationType)&&relation.createdBy.username===input.username)for(const ref of relation.targetRefs){
    const id=ref.kind==='relation'?ref.relationId:ref.messageId;statuses.set(id,relation.relationType as 'READ'|'UNREAD');
    times.set(id,relation.createdAt);const signature=relation.payload?.readDisplay?.[id];if(signature)signatures.set(id,signature);else signatures.delete(id);
  }
  const marks:ReadingMark[]=[...input.readingMarks??[]],parents=parentsFor(input.personalEffect),widths=effectiveCardWidths(input.messages,input.edges,input.username);
  const influences=readingInfluences({...input,memberships:input.personalEffect.memberships});
  for(const [id,state] of statuses){
    const message=input.messages.find(message=>message.id===id);if(!message)continue;
    const entry=input.corrections.get(id),current=times.has(id)&&entry?.versions.every(version=>version.createdAt>times.get(id)!)?undefined:entry?.current;
    const version=displayedBodyVersion(message,current),key=messageReadingKey(id);
    marks.push({format:3,version,messageId:id,scope:'message',key,bodySignature:key,state,signature:signatures.get(id)??displaySignature({...snapshot(message,input.personalEffect,parents,input.corrections.get(id)?.current),width:widths[id]??320})});
    if(state==='READ')for(const [target,items] of influences)marks.push(...influenceReadingMarks(target,items.filter(item=>item.messageId===id)));
  }
  return {...input,readingMarks:marks};
}
