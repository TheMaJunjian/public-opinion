import type {DemoMessage} from '../../../utils/modelBridge';
import {relationTypeName} from '../../../utils/graphTextSelection';
import {groupedReadingInfluence,type ReadingInfluence} from './readingProgress';

export type ReadingInfluenceGroup={key:string;label:string;grouped:boolean;items:ReadingInfluence[]};
const influenceTypeOrder=new Map([
  'selection','correct','agree','disagree',
  'recommend','archive','attention','block','tag',
  'round','round_result','terminate_settlement',
  'reference','reply','annotation','notify','join','classify','summary','arrange','merge',
  'proposal','delegation','code_change','operations','authorize',
].map((type,index)=>[type,index]));
export function readingInfluenceLabel(message:DemoMessage|undefined,type:string|undefined=message?.relationType??message?.kind){
  if(type==='selection')return '正文或显示选择变化';
  if(message?.relationPayload?.operationType==='TERMINATE_SETTLEMENT'||type==='terminate_settlement')return '结算 · 终止结算';
  if(type==='join'||message?.kind==='join')return '被加入';
  if(type==='round')return '结算 · 发起结算';
  if(type==='round_result')return '结算 · 结算结果';
  if(type==='correct')return message?.relationPayload?.correctionKind==='WIDTH'?'显示调整':'更正';
  if(type==='tag')return `标注${message?.relationPayload?.label?`「${message.relationPayload.label}」`:''}`;
  return type&&type!=='normal'?relationTypeName(type):'文本';
}
export function groupReadingInfluences(items:ReadingInfluence[],messages:ReadonlyMap<string,DemoMessage>):ReadingInfluenceGroup[]{
  const groups=new Map<string,ReadingInfluenceGroup>();
  for(const item of items){
    const message=messages.get(item.messageId),grouped=groupedReadingInfluence(item);
    const label=item.type==='reference'&&grouped?'被引用':readingInfluenceLabel(message,item.type);
    const key=grouped?JSON.stringify([item.type,label]):JSON.stringify([item.messageId,item.key]);
    const group=groups.get(key)??{key,label,grouped,items:[]};group.items.push(item);groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>{
    const typeA=a.items[0].type,typeB=b.items[0].type;
    return (influenceTypeOrder.get(typeA)??influenceTypeOrder.size)-(influenceTypeOrder.get(typeB)??influenceTypeOrder.size)
      ||typeA.localeCompare(typeB);
  });
}
