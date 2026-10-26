import {useRef,useState} from 'react';
import {contributionFor,contributionLabel,primaryContributionType,type ContributionDrafts} from '../pages/workbench/model/contributions';

interface StakeCalculationDeps {
  relationType:string|null;secondaryRelationType?:string;subType:string;
  draftUnits:Array<{messageId:string}>;targetUnits:Array<{messageId:string}>;sourceUnits?:Array<{messageId:string}>;
  newMessageContent:string;stakeAmount:number|'';relStakeAmount:number|'';recommendationAmount?:number|'';
  contributions?:ContributionDrafts;scopeParentId?:string|null;parentByMessageId?:ReadonlyMap<string,string>;
  relationContributionTypes?:string[];
  organizationMemberIds?:string[];existingJoinMemberIds?:ReadonlySet<string>;additionalJoinCount?:number;
  relationStakeMap:React.MutableRefObject<Record<string,number>>;subTypeStakeMap:React.MutableRefObject<Record<string,number>>;
  existingJoinCount?:number;joinOnlyAction?:boolean;reclassificationJoinCount?:number;
  onRelStakeChange:(min:number)=>void;stakeDefaultLoaded:React.MutableRefObject<boolean>;
}
type CostInput=Pick<StakeCalculationDeps,'relationType'|'secondaryRelationType'|'draftUnits'|'targetUnits'|'sourceUnits'|'newMessageContent'|'stakeAmount'|'relStakeAmount'|'recommendationAmount'|'joinOnlyAction'|'contributions'|'scopeParentId'|'parentByMessageId'|'organizationMemberIds'|'existingJoinMemberIds'|'additionalJoinCount'|'relationContributionTypes'>;
const amount=(value:number|''|undefined)=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,value):0;
export function calculateSendCost(deps:CostInput,protocolFee:number){
  const targets=deps.draftUnits.length?deps.draftUnits:deps.targetUnits,relation=deps.relationType;
  const content=deps.newMessageContent.trim().length>0;
  const embedded=new Set(['classify','summary','tag','proposal','delegation','code_change','operations','correct','authorize']);
  const usesSources=!!deps.sourceUnits?.length&&(relation==='notify'||!deps.draftUnits.length&&!!deps.targetUnits.length)&&!['classify','merge','arrange'].includes(relation??'');
  const hasText=!deps.joinOnlyAction&&content&&!usesSources&&(!relation||!embedded.has(relation));
  const sourceCount=usesSources?['agree','disagree'].includes(relation??'')?new Set(deps.sourceUnits!.map(source=>source.messageId)).size:deps.sourceUnits!.length:1;
  const multi=new Set(['annotation','reference','reply','notify','agree','disagree','tag','authorize']);
  const multiplier=['annotation','reference','reply','notify','agree','disagree'].includes(relation??'')?sourceCount:1;
  const relCount=relation&&!deps.joinOnlyAction?(multi.has(relation)?Math.max(1,targets.length)*multiplier:1):0;
  const refCount=!usesSources&&['proposal','code_change','operations'].includes(relation??'')?targets.length:0;
  const parent=deps.scopeParentId&&deps.scopeParentId!=='root'?deps.scopeParentId:null;
  const memberIds=[...new Set(deps.organizationMemberIds??targets.map(target=>target.messageId))];
  let joinCount=(deps.joinOnlyAction?memberIds.filter(id=>!deps.existingJoinMemberIds?.has(id)).length:0)+(deps.additionalJoinCount??0);
  if(!deps.joinOnlyAction){
    if(hasText&&parent)joinCount++;
    if(['classify','summary','merge','arrange'].includes(relation??'')){
      const includesNewText=relation==='arrange'&&hasText;
      joinCount+=memberIds.length+Number(includesNewText);
      const parents=memberIds.map(id=>deps.parentByMessageId?.has(id)?deps.parentByMessageId.get(id)!:null);
      if(includesNewText)parents.push(parent);
      if(parents.length?parents[0]&&parents.every(value=>value===parents[0]):parent)joinCount++;
    }else if(parent&&['proposal','operations','code_change','delegation'].includes(relation??''))joinCount+=relCount;
  }
  if(!hasText&&!relation)return null;
  const counts=new Map<string,number>();
  const add=(type:string,count:number)=>{if(count)counts.set(type,(counts.get(type)??0)+count);};
  const primary=primaryContributionType(relation,deps.secondaryRelationType);
  add('TEXT',Number(hasText));
  if(relCount&&deps.relationContributionTypes?.length)for(const type of deps.relationContributionTypes)add(type,multiplier);
  else add(primary,relCount);
  add('REFERENCE',refCount);add('JOIN',joinCount);
  const groups=[...counts].map(([type,count])=>{
    const fallback={truth:type==='TEXT'?deps.stakeAmount:type===primary?deps.relStakeAmount:1,value:type===primary?deps.recommendationAmount??0:0};
    const investment=contributionFor(type,deps.contributions,fallback),truth=amount(investment.truth),value=amount(investment.value);
    const error=investment.truth===''||investment.value===''?`请输入${contributionLabel(type)}消息的真假和价值投入`
      :!Number.isSafeInteger(investment.truth)||!Number.isSafeInteger(investment.value)||investment.truth<0||investment.value<0?`${contributionLabel(type)}消息的投入须为非负整数`
      :truth===0&&value===0?'真假和价值至少一项须大于 0':null;
    return {type,label:contributionLabel(type),count,truth:investment.truth,value:investment.value,
      stakeTotal:truth*count,recommendationTotal:value*count,protocolFeeTotal:protocolFee*count,total:(truth+value+protocolFee)*count,error};
  });
  const stakeTotal=groups.reduce((sum,group)=>sum+group.stakeTotal,0),recommendationTotal=groups.reduce((sum,group)=>sum+group.recommendationTotal,0);
  const messageCount=groups.reduce((sum,group)=>sum+group.count,0),protocolFeeTotal=messageCount*protocolFee;
  const reward=relation==='delegation'&&deps.secondaryRelationType==='create'?deps.newMessageContent.match(/(?:报酬数量|数量)\s*[=:：]\s*(\d+)/):null;
  const delegationRewardStake=reward?Number(reward[1]):0;
  const group=(type:string)=>groups.find(group=>group.type===type);
  return {groups,messageCount,stakeTotal,recommendationTotal,protocolFeeTotal,delegationRewardStake,
    contributionError:groups.find(group=>group.error)?.error??null,total:stakeTotal+recommendationTotal+protocolFeeTotal+delegationRewardStake,
    perStake:amount(group(primary)?.truth),textStake:amount(group('TEXT')?.truth),relCount,joinCount,hasText,hasRel:relCount>0,
    joinStakeTotal:group('JOIN')?.stakeTotal??0,joinFeeTotal:joinCount*protocolFee,refCount,refStakeTotal:group('REFERENCE')?.stakeTotal??0,
    newJoinCount:joinCount,existingJoinAgreeCount:0};
}
export default function useStakeCalculation(deps:StakeCalculationDeps){
  const [protocolFee,setProtocolFee]=useState(1),stakeFeeAmountRef=useRef(protocolFee);
  stakeFeeAmountRef.current=protocolFee;
  const totalConsumption=calculateSendCost(deps,protocolFee);
  return {effectiveMinStake:0,totalConsumption,stakeFeeAmountRef,setProtocolFee,multiTargetCount:totalConsumption?.relCount??0,
    isTextInPayload:!totalConsumption?.hasText,hasTextContentForTotal:totalConsumption?.hasText??false};
}
