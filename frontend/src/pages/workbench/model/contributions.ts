import {getPresentationSpec} from '../../../types';
import {annotationAtReference,oppositeAnnotation,resolveStance,targetInvestmentDimension,type Reference,type Message} from '@gonglun/core';

export interface ContributionDraft { truth:number|''; value:number|'' }
export type ContributionDrafts=Record<string,ContributionDraft>;
export function annotationActionForTarget(type:string,message:Parameters<typeof annotationAtReference>[0]|undefined,reference:Reference,resolver?:(id:string,revision?:number)=>Message|undefined){
  if(!['AGREE','DISAGREE'].includes(type.toUpperCase())||!message)return;
  let original=annotationAtReference(message,reference);
  if(!original&&resolver){const resolved=resolveStance(reference,type.toUpperCase()==='AGREE'?'pro':'con',resolver),target=resolver(resolved.target.messageId,resolved.target.revision);if(target)original=annotationAtReference(target,resolved.target);}
  return original&&(type.toUpperCase()==='AGREE'?original:oppositeAnnotation(original));
}
export function contributionTypeForTarget(type:string,message:Parameters<typeof annotationAtReference>[0]|undefined,reference:Reference,resolver?:(id:string,revision?:number)=>Message|undefined):string{
  const action=annotationActionForTarget(type,message,reference,resolver);
  return action?(action.relation==='follow'?'ATTENTION':action.relation.toUpperCase()):type.toUpperCase();
}
export function primaryContributionType(relationType:string|null,secondary?:string):string{
  if(!relationType)return 'TEXT';
  if(relationType==='tag')return ['recommend','archive','read','unread','block','attention'].includes(secondary??'')
    ? secondary==='attention'?'ATTENTION':secondary!.toUpperCase():'TAG';
  return relationType.toUpperCase();
}
export function contributionLabel(type:string):string{
  return type==='TEXT'?'文本':type==='JOIN'?'加入':getPresentationSpec(type).label;
}
export function contributionFor(type:string,drafts:ContributionDrafts|undefined,fallback:ContributionDraft={truth:1,value:0}):ContributionDraft{
  const draft=drafts?.[type],investment=draft??fallback,dimension=targetInvestmentDimension(type);
  if(dimension==='TRUTH')return {truth:investment.truth,value:0};
  if(dimension==='VALUE')return {truth:0,value:draft?draft.value:investment.value===''||investment.value>0?investment.value:1};
  return investment;
}
