import { computeCorrectionVersions, computeGloballySuppressedRelIds, computeUserActiveStanceRelIds, computeUserCorrectionChoices, buildStanceTargetMap,
  resolveDisplayedStance, type DemoMessage } from '../../../utils/modelBridge';
import { deriveContainerEffect, isContainerType } from './containerEffect';
import {deriveReadingProgress} from './readingProgress';
import {effectiveCardWidths} from '../../../utils/cardWidth';
import { parentsFor, snapshot, sameDisplay, displaySignature, messageDisplay, correctionDisplay, type DisplayHint, type DisplayHintsInput } from './displayHintSnapshot';
export { sameDisplay, displaySignature, getMessageDisplaySignature, getMessageDisplayParts, displayHintDestination } from './displayHintSnapshot';
export type { DisplaySnapshot, DisplayHint, DisplayHintsInput } from './displayHintSnapshot';
const readAnnotation = (message: DemoMessage) => ['read','unread'].includes(message.relationType ?? '');
/** Viewer-only explanations. This module never creates relations or changes read status. */
export function deriveDisplayHints(input: DisplayHintsInput) {
  const { messages, relations, edges, username, readStatus, personalEffect, corrections } = input;
  const msgMap = new Map(messages.map(message => [message.id,message]));
  const recommendedEffect = deriveContainerEffect({messages,relations,edges,username:null,stakeCounts:personalEffect.stakeCounts});
  const recommendedCorrections = input.recommendedCorrections??computeCorrectionVersions(messages,edges,computeGloballySuppressedRelIds(edges,messages));
  const personalParents = parentsFor(personalEffect), recommendedParents = parentsFor(recommendedEffect);
  const displayedEffect=input.displayEffect??personalEffect,displayedParents=input.displayEffect?parentsFor(displayedEffect):personalParents;
  const personalWidths=effectiveCardWidths(messages,edges,username),recommendedWidths=effectiveCardWidths(messages,edges);
  const readDisplays=new Map<string,{signature?:string;parts?:{message:string;corrections?:string};time:string;sequence:number}>();
  const privateDisplays=new Map<string,NonNullable<DisplayHintsInput['readingMarks']>[number]>(),privatelyViewedIds=new Set<string>();
  for(const mark of input.readingMarks??[])if(mark.format===3&&mark.scope==='message'&&!mark.unknownContext){
    const key=mark.messageId,previous=privateDisplays.get(key);privatelyViewedIds.add(mark.messageId);
    if(!previous||(mark.updatedAt??'')>=(previous.updatedAt??''))privateDisplays.set(key,mark);
  }
  const stances = computeUserActiveStanceRelIds(edges,messages,username);
  const correctionChoices = computeUserCorrectionChoices(edges,messages,username,stances);
  const stanceMap = buildStanceTargetMap(edges,msgMap);
  const stanceEffects = new Map<string,Array<{targetId:string;type:'agree'|'disagree'}>>();
  for(const edge of edges)if(edge.relationType==='agree'||edge.relationType==='disagree'){
    const resolved=resolveDisplayedStance(edge,msgMap,stanceMap);
    if(resolved){
      const targets=stanceEffects.get(edge.relationMessageId)??[];targets.push(resolved);stanceEffects.set(edge.relationMessageId,targets);
    }
  }
  const displays=new Map(messages.map(message=>[message.id,{...snapshot(message,displayedEffect,displayedParents,(input.displayCorrections??corrections).get(message.id)?.current),width:personalWidths[message.id]??320}]));
  const reading=deriveReadingProgress({messages,relations,edges,username,readStatus,marks:input.readingMarks,displays,
    corrections:input.displayCorrections??corrections,effectiveCorrections:corrections,memberships:displayedEffect.memberships});
  const pending=reading.pendingBodies;
  const related=new Map([...reading.pendingInfluences].map(([id,items])=>[id,new Set(items.map(item=>item.messageId))]));
  const hints = new Map<string,DisplayHint>();
  const correctionHints = new Map<string,DisplayHint>();
  const correctionTargets=new Map<string,string>();
  const personalCorrectionChoices=new Set<string>();
  for(const edge of edges)if(edge.relationType==='correct'){
    correctionTargets.set(edge.relationMessageId,edge.to.messageId);
  }
  for (const message of messages) {
    if (readAnnotation(message)) continue;
    const personal = {...snapshot(message,personalEffect,personalParents,corrections.get(message.id)?.current),width:personalWidths[message.id]??320};
    const recommended = {...snapshot(message,recommendedEffect,recommendedParents,recommendedCorrections.get(message.id)?.current),width:recommendedWidths[message.id]??320};
    const displayed=displays.get(message.id)!;
    const different = !sameDisplay(personal,recommended);
    const hasPersonal = stances.has(message.id) || (corrections.get(message.id)?.versions.some(version => correctionChoices.has(version.correctionId)) ?? false)
      || personal.parentIds.some(id => {
        const joinId = personalEffect.joinByTarget.get(message.id);
        return joinId && personalEffect.context.joinEffectSourcesByMessage?.get(joinId)?.has('personal') && !!id;
      }) || isContainerType(message.relationType) && message.author === username;
    const hasRecommendation = !!personal.correctionIds.length || !!personal.parentIds.length || stances.has(message.id)
      || isContainerType(message.relationType) || personal.suppressed;
    const hint:DisplayHint={unreadCorrectionIds:reading.pendingCorrections.get(message.id)??[],selectionChanged:reading.selectionChanges.has(message.id),otherVersionInfluenceCount:reading.otherVersionInfluences.get(message.id)?.length??0,unread:pending.has(message.id),originalUnread:reading.pendingOriginals.has(message.id),explicitlyUnread:readStatus.get(message.id) === 'UNREAD',
      pendingInfluences:reading.pendingInfluences.get(message.id)??[],otherVersionUnreadCount:reading.otherVersionUnread.get(message.id)?.size??0,
      unreadMemberCount:reading.pendingMembers.get(message.id)?.size??0,
      relatedUnreadIds:[...(related.get(message.id) ?? [])].sort((a,b) => (msgMap.get(b)?.createdAt ?? '').localeCompare(msgMap.get(a)?.createdAt ?? '') || b.localeCompare(a)),
      source:different ? 'personal' : hasRecommendation && !hasPersonal ? 'recommended' : undefined,
      different,personal,recommended,displayed,matchesPersonal:sameDisplay(displayed,personal),matchesRecommended:sameDisplay(displayed,recommended),
      personalActive:personal.membershipActive??!personal.suppressed,recommendedActive:recommended.membershipActive??!recommended.suppressed,
      readChanged:readDisplays.get(message.id)?.signature!==undefined?readDisplays.get(message.id)!.signature!==displaySignature(displayed):undefined};
    const hasCorrections=!!corrections.get(message.id)?.versions.length;
    if(hasCorrections){
      if(corrections.get(message.id)!.versions.some(version=>correctionChoices.has(version.correctionId)))personalCorrectionChoices.add(message.id);
      const previous=readDisplays.get(message.id);
      const bodyChanged=previous?.parts?.corrections!==undefined?previous.parts.corrections!==displaySignature(correctionDisplay(displayed)):undefined;
      correctionHints.set(message.id,{...hint,unread:false,explicitlyUnread:false,unreadMemberCount:0,
        readChanged:bodyChanged,
        matchesPersonal:displayed.content===personal.content,matchesRecommended:displayed.content===recommended.content,
        source:personal.content!==recommended.content?'personal':personal.correctionIds.length&&!personalCorrectionChoices.has(message.id)?'recommended':undefined});
      const ownPersonal=messageDisplay(personal,message,true),ownRecommended=messageDisplay(recommended,message,true),ownDisplayed=messageDisplay(displayed,message,true);
      hint.matchesPersonal=sameDisplay(ownDisplayed,ownPersonal);hint.matchesRecommended=sameDisplay(ownDisplayed,ownRecommended);
      hint.different=!sameDisplay(ownPersonal,ownRecommended);
      hint.source=hint.different?'personal':isContainerType(message.relationType)&&message.author!==username&&!stances.has(message.id)?'recommended':undefined;
      hint.readChanged=previous?.parts?.message!==undefined?previous.parts.message!==displaySignature(ownDisplayed):undefined;
    }else if(readDisplays.get(message.id)?.parts?.message!==undefined){
      hint.readChanged=readDisplays.get(message.id)!.parts!.message!==displaySignature(displayed);
    }
    const previous=privateDisplays.get(message.id);
    if(privatelyViewedIds.has(message.id)&&!previous){hint.readChanged=undefined;readDisplays.delete(message.id);}
    if(previous?.signature){
      hint.readChanged=previous.signature!==displaySignature(displayed);
      readDisplays.set(message.id,{signature:previous.signature,time:previous.updatedAt??'',sequence:0});
    }
    const correctionHint=correctionHints.get(message.id);
    if(correctionHint){correctionHint.unread=hint.unread;if(privatelyViewedIds.has(message.id))correctionHint.readChanged=hint.readChanged;}
    hints.set(message.id,hint);
  }
  // A stance describes its resolved target's outcome, not whether the stance
  // record itself is suppressed. Use the same personal/statistical projections
  // for every marker, including JOIN selection and chained stances.
  const active=(id:string,side:'personal'|'recommended')=>{
    const value=hints.get(id)?.[side];
    if(!value || value.suppressed)return false;
    if(value.membershipActive!==undefined)return value.membershipActive;
    const target=correctionTargets.get(id),version=target&&hints.get(target)?.[side];
    if(target && version && corrections.get(target)?.versions.some(item=>item.correctionId===id))return version.correctionIds.includes(id);
    return true;
  };
  for(const [id,hint] of hints){
    const targets=stanceEffects.get(id)?.filter(target=>hints.has(target.targetId));
    hint.personalActive=active(id,'personal')&&(!targets?.length||targets.every(target=>active(target.targetId,'personal')===(target.type==='agree')));
    hint.recommendedActive=active(id,'recommended')&&(!targets?.length||targets.every(target=>active(target.targetId,'recommended')===(target.type==='agree')));
  }
  return { hints, correctionHints, recommendedEffect, recommendedCorrections, readDisplays, personalCorrectionChoices,reading };
}

/** The existing correction viewer shows this record's complete replacement body. */
export function correctionRecordHint(input:DisplayHintsInput,data:ReturnType<typeof deriveDisplayHints>,id:string) {
  const version=[...input.corrections.values()].flatMap(entry=>entry.versions).find(item=>item.correctionId===id);
  const original=version?data.hints.get(version.targetId):undefined;
  if(!version||!original)return;
  return {matchesPersonal:version.content===original.personal.content,matchesRecommended:version.content===original.recommended.content,
    readChanged:data.hints.get(id)?.readChanged};
}
