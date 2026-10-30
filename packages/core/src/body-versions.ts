import type {BodyVersion, Message, Part, Reference, ReferenceContext} from './types.js';

export const messageReadingKey=(id:string)=>`message:3:${id}`;
export const originalReadingKey=(id:string)=>`original:3:${id}`;
export const comparisonReadingKey=(version:BodyVersion,signature:string)=>`comparison:3:${bodyVersionKey(version)}:${signature}`;
export const referenceVersion=(context:ReferenceContext|undefined)=>context&&'version' in context?context.version:undefined;

export function bodyVersion(messageId:string,revision=1,corrections:BodyVersion['corrections']=[]):BodyVersion {
  const unique=new Map<string,BodyVersion['corrections'][number]>();
  for(const correction of corrections){
    const previous=unique.get(correction.messageId);
    if(previous&&(previous.revision!==correction.revision||previous.kind!==correction.kind))throw new Error('更正版本重复且不一致');
    unique.set(correction.messageId,{...correction});
  }
  return {format:2,messageId,revision,corrections:[...unique.values()].sort((a,b)=>a.messageId.localeCompare(b.messageId))};
}
export function bodyVersionKey(version:BodyVersion):string {
  const value=bodyVersion(version.messageId,version.revision,version.corrections);
  return `body:2:${JSON.stringify([value.messageId,value.revision,value.corrections.map(c=>[c.messageId,c.revision,c.kind])])}`;
}
export const meaningVersion=(version:BodyVersion)=>bodyVersion(version.messageId,version.revision,version.corrections.filter(c=>c.kind==='MEANING'));
export const meaningVersionKey=(version:BodyVersion)=>bodyVersionKey(meaningVersion(version)).replace(/^body:/,'meaning:');
export function contextKey(context:ReferenceContext):string {
  return context.kind==='BODY'?bodyVersionKey(context.version):context.kind==='MEANING'?meaningVersionKey(context.version):context.kind;
}
const readable=(part:Part)=>part.type==='text'?part.text:part.type==='code'?part.source:part.type==='web'?part.excerpt||part.url:undefined;
export function contextMatches(context:ReferenceContext|undefined,version:BodyVersion):boolean {
  if(context?.kind==='UNKNOWN')return false;
  if(context?.kind==='BODY')return bodyVersionKey(context.version)===bodyVersionKey(version);
  if(context?.kind==='MEANING')return meaningVersionKey(context.version)===meaningVersionKey(version);
  return true;
}
const text=(message:Message)=>message.parts.flatMap(part=>{const value=readable(part);return value===undefined?[]:[value];}).join('\n');
export type BodyResolver=(id:string,revision?:number)=>Message|undefined;

/** Reconstruct immutable versions, including rejected edits, without consulting votes. */
export function materializeBodyVersion(version:BodyVersion,resolve:BodyResolver):Message {
  const normalized=bodyVersion(version.messageId,version.revision,version.corrections),base=resolve(normalized.messageId,normalized.revision);
  if(!base||base.revision!==normalized.revision)throw new Error('正文基础版本不存在');
  const before=text(base),changes:Array<{partId:string;start:number;end:number;replacement:string}>=[];
  for(const entry of normalized.corrections){
    const correction=resolve(entry.messageId,entry.revision);
    if(!correction||correction.revision!==entry.revision)throw new Error('更正版本不存在');
    const data=Object.assign({},...correction.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
    const relation=correction.parts.find(part=>part.type==='relation'&&part.relation==='correct');
    const targets=relation?.type==='relation'?relation.roles.target:undefined;
    const target=targets?.[0]?.reference;
    const after=correction.parts.find(part=>part.id==='corrected-body'&&part.type==='text');
    if(targets?.length!==1||!target||target.messageId!==base.id||target.revision!==base.revision||!target.partId||target.memberId
      ||data.correctionKind==='WIDTH'||(data.correctionKind??'TEXT')!==entry.kind||after?.type!=='text'
      ||data.correctionBeforeContent!==before)throw new Error('更正不属于该正文基础版本');
    let offset=0,found=false;
    for(const part of base.parts){
      const value=readable(part);if(value===undefined)continue;
      if(part.id===target.partId){
        const {start,end}=target.range??{start:0,end:value.length};
        if(start<0||end<start||end>value.length||target.path?.some(key=>!['text','source','excerpt'].includes(String(key))))throw new Error('更正地址不匹配');
        const prefix=before.slice(0,offset+start),suffix=before.slice(offset+end);
        if(!after.text.startsWith(prefix)||!after.text.endsWith(suffix)||after.text.length<prefix.length+suffix.length)throw new Error('更正范围与正文不一致');
        const change={partId:part.id,start,end,replacement:after.text.slice(prefix.length,after.text.length-suffix.length)};
        if(changes.some(other=>other.partId===change.partId&&(change.start<other.end&&change.end>other.start||change.start===other.start&&change.end===other.end)))throw new Error('正文更正相互冲突');
        changes.push(change);found=true;break;
      }
      offset+=value.length+1;
    }
    if(!found)throw new Error('更正部件不存在');
  }
  return {...base,parts:base.parts.map(part=>{
    let value=readable(part);if(value===undefined)return part;
    for(const change of changes.filter(change=>change.partId===part.id).sort((a,b)=>b.start-a.start))value=value.slice(0,change.start)+change.replacement+value.slice(change.end);
    return part.type==='text'?{...part,text:value}:part.type==='code'?{...part,source:value}:part.type==='web'?{...part,excerpt:value}:part;
  })};
}

export function scopedReferenceKey(reference:Reference,legacy:unknown[]):string {
  const context=reference.context;
  // UNKNOWN is an explicit migrated legacy contract, never a guessed meaning.
  if(!context||context.kind==='UNKNOWN'||context.kind==='MESSAGE')return JSON.stringify(legacy);
  if(context.kind==='CORRECTION')return JSON.stringify([reference.messageId,reference.revision??null,null,null,[],null,'CORRECTION:2']);
  return JSON.stringify([...legacy,contextKey(context)]);
}
