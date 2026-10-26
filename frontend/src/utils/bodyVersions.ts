import {bodyVersion,bodyVersionKey,type BodyVersion,type Reference} from '@gonglun/core';
import type {CorrectionVersion,DemoMessage} from './modelBridge';

export function displayedBodyVersion(message:DemoMessage,current?:CorrectionVersion):BodyVersion {
  return current?.bodyVersion??bodyVersion(message.id,message.revision??1,current?(current.appliedCorrectionIds??[current.correctionId]).map(messageId=>({messageId,revision:1,kind:current.correctionKind??'TEXT'})):[]);
}
export const correctionVersionIdentity=(version:CorrectionVersion|undefined,original?:BodyVersion)=>version?.bodyVersion?bodyVersionKey(version.bodyVersion):!version&&original?bodyVersionKey(original):JSON.stringify([...(version?.appliedCorrectionIds??(version?[version.correctionId]:[]))].sort());

export function bindViewedReference(reference:Reference,type:string,message:DemoMessage|undefined,current?:CorrectionVersion,_source=false):Reference {
  void _source;
  if(!message)return reference;
  if(['join','classify','summary','merge','arrange'].includes(type))return {...reference,context:{kind:'MESSAGE'}};
  if(type==='correct'){
    if(reference.range&&(current||(reference.context&&'version' in reference.context&&reference.context.version?.corrections.length)))throw new Error('请切回原文重新选择更正片段，避免更正位置变化');
    const base={...reference};delete base.context;return base;
  }
  if(['attention','block'].includes(type))return {...reference,context:{kind:'MESSAGE'}};
  const whole=!reference.range&&!reference.partId&&!reference.path?.length&&!reference.memberId;
  if(whole&&(message.kind==='join'||['classify','summary','merge','arrange'].includes(message.relationType??'')))return {...reference,context:{kind:'MESSAGE'}};
  if(['agree','disagree'].includes(type)&&['agree','disagree'].includes(message.relationType??'')&&!reference.range&&!reference.memberId&&(!reference.partId||message.parts?.some(part=>part.type==='relation'&&part.id===reference.partId&&['agree','disagree'].includes(part.relation)))&&(!reference.path?.length||reference.path.length===1&&reference.path[0]==='relation'))return reference;
  if(message.relationType==='correct'&&(whole||message.parts?.some(part=>part.id===reference.partId&&part.type==='relation'&&part.relation==='correct')))return {...reference,context:{kind:'MESSAGE'}};
  const version=reference.context&&'version' in reference.context&&reference.context.version?reference.context.version:displayedBodyVersion(message,current);
  return {...reference,revision:version.revision,context:{kind:'MESSAGE',version}};
}
