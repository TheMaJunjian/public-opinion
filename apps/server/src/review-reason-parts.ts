import { reviewContextPart, reviewReasonContent, withReviewReasonLinks, type Message, type Part, type Reference, type ReviewContext } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { readReference } from './validation.js';

export function reviewCitationParts(decision:Message) {
  const parts:Part[]=[];
  for(const part of decision.parts){
    if(part.type==='display')parts.push(part);
    if(part.type!=='relation'||!['review','review-appeal'].includes(part.relation))continue;
    // Review targets are navigation. Preserve real sources, fragments and any explicit body-version citations.
    const roles:typeof part.roles={};
    for(const [role,bindings] of Object.entries(part.roles)){
      const references=role==='target'?bindings.filter(({reference:r})=>
        r.partId||r.memberId||r.path?.length||r.range||r.context&&('version' in r.context&&r.context.version||r.context.kind!=='MESSAGE')):bindings;
      if(references.length){
        const name=role==='target'?'target':'source';
        (roles[name]??=[]).push(...references);
      }
    }
    // A display of the review relation itself shows the addressed target.
    if(decision.parts.some(p=>p.type==='display'&&!p.target&&p.relationPartId===part.id))roles.target=part.roles.target!;
    if(Object.keys(roles).length)parts.push({id:part.id,type:'relation',relation:'reference',roles});
  }
  return parts;
}

const textValue=(p:Part)=>p.type==='text'?p.text:p.type==='code'?p.source:p.type==='web'?p.excerpt:undefined;
function selectedText(value:unknown):string[] {
  if(typeof value==='string')return [value];
  if(!value||typeof value!=='object')return [];
  if('parts' in value&&Array.isArray(value.parts))return value.parts.flatMap(selectedText);
  return [textValue(value as Part)].filter((s):s is string=>!!s);
}

/** Preserve the author's surrounding prose when an old text part also copied a selected quotation. */
function withoutQuotes(text:string,quotes:Set<string>){
  const ranges:Array<{start:number;end:number}>=[];
  for(const quote of quotes){
    for(let start=text.indexOf(quote);start!==-1;start=text.indexOf(quote,start+quote.length))
      ranges.push({start,end:start+quote.length});
  }
  if(!ranges.length)return text;
  const pieces:string[]=[];
  let end=0;
  for(const range of ranges.sort((a,b)=>a.start-b.start||b.end-a.end)){
    if(range.end<=end)continue;
    if(range.start>end||!pieces.length)pieces.push(text.slice(end,range.start),'…');
    end=range.end;
  }
  pieces.push(text.slice(end));
  return pieces.join('');
}

export async function splitReviewReasonParts(store:Store,decision:Message,context:ReviewContext,reason:ReviewContext,
    options:{keepUnresolvedCitations?:boolean}={}){
  const content=reviewReasonContent(decision),citations=reviewCitationParts(decision);
  const origin={messageId:decision.id,revision:decision.revision};
  if(!content.length&&!citations.length)return {parts:[]};
  if(!citations.length)return {parts:withReviewReasonLinks(content,context,origin)};
  const refs:Reference[]=citations.flatMap(p=>p.type==='relation'?Object.values(p.roles).flat().map(b=>b.reference):p.type==='display'&&p.target?[p.target]:[]);
  const quotes=new Set<string>();
  for(const ref of refs){
    let selection:unknown;
    try { selection=await readReference(store,ref); }
    catch(error){
      if(!options.keepUnresolvedCitations||!(error instanceof DomainError)||error.status!==404)throw error;
      // Earlier migrations may have removed a cited record. Keep its address with the prose.
      return {parts:withReviewReasonLinks([...content,...citations],context,origin)};
    }
    for(const value of selectedText(selection))if(value.trim())quotes.add(value.trim());
  }
  const data=Object.assign({},...decision.parts.flatMap(p=>p.type==='data'&&p.value&&typeof p.value==='object'&&!Array.isArray(p.value)?[p.value]:[]));
  const authored:Part[]=[],quoted:Part[]=[];
  for(const part of content){
    const text=textValue(part)?.trim();
    // A duplicated selection or a display-only label has no independent authorship evidence.
    // Older UI commands also materialized data.label as an ordinary text part.
    const onlyLabel=text===data.label&&text!==data.content&&text!==data.title;
    if(!text||onlyLabel){quoted.push(part);continue;}
    const prose=withoutQuotes(text,quotes);
    if(prose===text){authored.push(part);continue;}
    quoted.push(part);
    if(part.type==='text'&&/[\p{L}\p{N}]/u.test(prose))authored.push({...part,text:prose});
  }
  if(!authored.length)return {parts:withReviewReasonLinks([...content,...citations],context,origin)};
  const quotedParts=[...quoted,...citations];
  const links:Part[]=[reviewContextPart(context),{id:'reason-source',type:'relation',relation:'reference',
    roles:{target:[{id:'reason',reference:reason}]}}];
  for(const link of links){
    const base=link.id;
    for(let i=1;quotedParts.some(p=>p.id===link.id);i++)link.id=`${base}-${i}`;
    quotedParts.push(link);
  }
  return {parts:withReviewReasonLinks(authored,context,origin),citation:quotedParts};
}
