import type {Relation} from '../../../types';
import type {DemoMessage,RelationType,UnitSelection} from '../../../utils/modelBridge';
import {getClassifyTargetRefs,organizationTargetRef,promoteCompleteContainerSelections,resolveEffectiveTargetUnits} from '../actions/targetResolution';
import type {ContainerEffect} from './containerEffect';
import {authorizationJoinCount} from './authorizationContributions';
import {contributionTypeForTarget} from './contributions';
import {unitSelectionToReference} from '../../../utils/modelBridge';

/** Match the target normalization and active-placement checks used by the send actions. */
export function contributionContext(input:{relationType:string|null;draftUnits:UnitSelection[];targetUnits:UnitSelection[];sourceUnits:UnitSelection[];
  relations:Relation[];containerEffect:ContainerEffect;joinOnlyAction:boolean}){
  const {relationType,relations,containerEffect,joinOnlyAction}=input,msgMap:Map<string,DemoMessage>=containerEffect.msgMap;
  const targets=resolveEffectiveTargetUnits({msgMap,promoteCompleteContainerSelections:units=>promoteCompleteContainerSelections({relations,containerEffect},units)},input.draftUnits,input.targetUnits,relationType);
  const parentByMessageId=new Map<string,string>();
  for(const relation of relations)if(relation.relationType.toUpperCase()==='JOIN'&&relation.state?.membershipActive&&relation.sourceMessageId)
    for(const ref of relation.targetRefs)parentByMessageId.set(ref.kind==='relation'?ref.relationId:ref.messageId,relation.sourceMessageId);
  const memberRefs=['classify','summary'].includes(relationType??'')
    ?getClassifyTargetRefs({msgMap,organizationTargetRef:unit=>organizationTargetRef({msgMap},unit),relationTypeByRelMsgId:new Map(relations.map(relation=>[relation.id,relation.relationType.toLowerCase() as RelationType]))},targets)
    :targets.map(unit=>organizationTargetRef({msgMap},unit));
  return {draftUnits:input.draftUnits.length?targets:[],targetUnits:input.draftUnits.length?[]:targets,parentByMessageId,
    relationContributionTypes:['agree','disagree'].includes(relationType??'')?targets.map(target=>contributionTypeForTarget(relationType!,msgMap.get(target.messageId),unitSelectionToReference(target,msgMap),(id,revision)=>{const message=msgMap.get(id);return message?.parts&&(!revision||message.revision===revision)?message as unknown as import('@gonglun/core').Message:undefined;})):undefined,
    additionalJoinCount:relationType==='authorize'?authorizationJoinCount(targets.map(target=>target.messageId),msgMap,parentByMessageId):0,
    organizationMemberIds:memberRefs.map(ref=>ref.kind==='relation'?ref.relationId:ref.messageId),
    existingJoinMemberIds:joinOnlyAction?new Set(relations.filter(relation=>relation.relationType.toUpperCase()==='JOIN'&&containerEffect.effectiveJoinIds.has(relation.id)&&relation.sourceMessageId===input.sourceUnits[0]?.messageId)
      .flatMap(relation=>relation.targetRefs.map(ref=>ref.kind==='relation'?ref.relationId:ref.messageId))):undefined};
}
