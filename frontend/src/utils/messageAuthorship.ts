import {targetInvestmentDimension,type MessageStakes} from '@gonglun/core';
import type {CorrectionVersion,DemoMessage} from './modelBridge';

export interface InvestmentPair {truth:number;value:number}
export interface AuthorInvestment {total:InvestmentPair;initial?:InvestmentPair;additional?:InvestmentPair}
const amount=(value:number|undefined)=>Number.isFinite(value)?Math.max(0,value!):0;

/** Sender investments in this message, including later positions; never use community totals. */
export function messageAuthorInvestment(message:DemoMessage,stakes?:MessageStakes,fallbackTruth=0):AuthorInvestment {
  if(!stakes&&message.authorInvestment)return message.authorInvestment;
  const dimension=targetInvestmentDimension(message.relationType??'');
  const initial=message.spending?{truth:dimension?0:amount(message.spending.wager),
    value:dimension==='VALUE'?0:amount(message.spending.recommendation)}:undefined;
  const own=message.authorId?stakes?.stakes.filter(stake=>stake.user.id===message.authorId)??[]:[];
  const truth=own.filter(stake=>stake.settlementType!=='VALUE').reduce((sum,stake)=>sum+amount(stake.amount),0);
  const value=own.filter(stake=>stake.settlementType==='VALUE').reduce((sum,stake)=>sum+amount(stake.amount),0);
  const total={truth:Math.max(initial?.truth??0,stakes?truth:amount(fallbackTruth)),value:(initial?.value??0)+value};
  return {total,...(initial?{initial,additional:{truth:Math.max(0,total.truth-initial.truth),value:Math.max(0,total.value-initial.value)}}:{})};
}

export interface AuthorContribution {
  message:DemoMessage;kind:'original'|'TEXT'|'MEANING';content:string;contributes:boolean;investment:AuthorInvestment;
}
export interface BodyAuthor {key:string;name:string;contributions:AuthorContribution[]}
export interface MessageAuthorship {original:AuthorContribution;authors:BodyAuthor[];hasCorrections:boolean}

/** The name label totals this person's displayed contributions, counting each source message once. */
export function bodyAuthorInvestment(author:BodyAuthor):AuthorInvestment {
  const sources=[...new Map(author.contributions.map(source=>[source.message.id,source.investment])).values()];
  const sum=(field:'total'|'initial'|'additional'):InvestmentPair=>sources.reduce((total,source)=>({
    truth:total.truth+(source[field]?.truth??0),value:total.value+(source[field]?.value??0),
  }),{truth:0,value:0});
  return {total:sum('total'),...(sources.every(source=>source.initial&&source.additional)?{initial:sum('initial'),additional:sum('additional')}:{})};
}

/** Attribution follows the exact composition being displayed, including partial replacements and deletions. */
export function deriveMessageAuthorship(message:DemoMessage,entry:{current?:CorrectionVersion;versions:CorrectionVersion[]}|undefined,
  records:ReadonlyMap<string,DemoMessage>=new Map([[message.id,message]]),fallbackTruth=0):MessageAuthorship {
  const originalMessage=records.get(message.id)??message,base=originalMessage.content,current=entry?.current;
  const changes=current?(current.changes??[{start:0,end:base.length,replacement:current.content}]).map((change,index)=>({
    ...change,id:current.appliedCorrectionIds?.[index]??current.correctionId,
  })).filter(change=>change.start>=0&&change.end>=change.start&&change.end<=base.length&&base.slice(change.start,change.end)!==change.replacement)
    .sort((a,b)=>a.start-b.start||a.end-b.end):[];
  const retained:string[]=[];let cursor=0;
  for(const change of changes){if(change.start>cursor)retained.push(base.slice(cursor,change.start));cursor=Math.max(cursor,change.end);}
  if(cursor<base.length)retained.push(base.slice(cursor));
  const original:AuthorContribution={message:originalMessage,kind:'original',content:changes.length?retained.join('…'):base,
    contributes:!changes.length||retained.some(text=>text.length>0),investment:messageAuthorInvestment(originalMessage,undefined,fallbackTruth)};
  const contributions=[original,...changes.flatMap(change=>{
    const source=records.get(change.id);if(!source)return [];
    const version=entry?.versions.find(version=>version.correctionId===change.id);
    return [{message:source,kind:version?.correctionKind??'TEXT',content:change.replacement,contributes:true,investment:messageAuthorInvestment(source)} as AuthorContribution];
  })];
  const authors=new Map<string,BodyAuthor>();
  for(const contribution of contributions){
    if(!contribution.contributes)continue;
    const source=contribution.message;
    // Names can change or be shared; a source without an ID cannot establish a shared identity.
    const key=source.authorId?`id:${source.authorId}`:`message:${source.id}`;
    const author=authors.get(key)??{key,name:source.author,contributions:[]};author.contributions.push(contribution);authors.set(key,author);
  }
  return {original,authors:[...authors.values()],hasCorrections:changes.length>0};
}
