import {comparisonReadingKey,type BodyVersion,type ReadingMark} from '@gonglun/core';
import {displaySignature,type DisplayHintsInput} from './displayHintSnapshot';

const fingerprint=(value:unknown)=>displaySignature({content:JSON.stringify(value),parentIds:[],memberIds:[],correctionIds:[],suppressed:false});

/** Remember each correction's effective/ineffective result, independently of how that result was reached. */
export function createComparisonBasis(input:DisplayHintsInput){
  const children=new Map<string,Set<string>>(),targets=new Map<string,string>(),messages=new Map(input.messages.map(message=>[message.id,message])),cache=new Map<string,string>();
  for(const edge of input.edges)if(edge.relationType==='correct'){
    targets.set(edge.relationMessageId,edge.to.messageId);
    const ids=children.get(edge.to.messageId)??new Set<string>();ids.add(edge.relationMessageId);children.set(edge.to.messageId,ids);
  }
  return (messageId:string)=>{
    const cached=cache.get(messageId);if(cached)return cached;
    const ids=new Set<string>(),queue=[messageId];
    for(let index=0;index<queue.length;index++)for(const id of children.get(queue[index])??[])if(id!==messageId&&!ids.has(id)){ids.add(id);queue.push(id);}
    const corrections=[...ids].sort().map(id=>{
      const target=targets.get(id);
      const entry=target?input.corrections.get(target):undefined;
      const effective=entry?.current?(entry.current.appliedCorrectionIds??[entry.current.correctionId]).includes(id):entry?.versions.find(version=>version.correctionId===id)?.adopted??false;
      return [id,messages.get(id)?.revision??1,effective?'effective':'ineffective'];
    });
    const value=fingerprint(corrections);cache.set(messageId,value);return value;
  };
}

/** Comparing two bodies never acknowledges either the message or its influences. */
export function comparisonReadingMark(version:BodyVersion,before:string,after:string,basis=''):ReadingMark {
  const signature=fingerprint([before,after,basis]);
  return {format:3,messageId:version.messageId,scope:'comparison',key:comparisonReadingKey(version,signature),version,state:'READ',signature};
}

export function isComparisonRead(marks:readonly ReadingMark[],version:BodyVersion,before:string,after:string,basis=''){
  const expected=comparisonReadingMark(version,before,after,basis);
  let latest:ReadingMark|undefined;
  for(const mark of marks){
    if(mark.format!==3||mark.unknownContext||mark.scope!=='comparison'||mark.messageId!==version.messageId||mark.key!==expected.key||mark.signature!==expected.signature)continue;
    if(!latest||(mark.position??0)>(latest.position??0)||(mark.position??0)===(latest.position??0)&&(mark.updatedAt??'')>=(latest.updatedAt??''))latest=mark;
  }
  return !!latest&&latest.state!=='UNREAD';
}
