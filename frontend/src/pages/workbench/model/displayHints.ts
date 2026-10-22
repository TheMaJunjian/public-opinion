import { computeCorrectionVersions, computeGloballySuppressedRelIds, computeUserActiveStanceRelIds, buildStanceTargetMap,
  resolveDisplayedStance, type DemoMessage } from '../../../utils/modelBridge';
import { deriveContainerEffect, isContainerType } from './containerEffect';
import { parentsFor, snapshot, sameDisplay, displaySignature, messageDisplay, correctionDisplay, type DisplayHint, type DisplayHintsInput } from './displayHintSnapshot';
export { sameDisplay, displaySignature, getMessageDisplaySignature, getMessageDisplayParts, displayHintDestination } from './displayHintSnapshot';
export type { DisplaySnapshot, DisplayHint, DisplayHintsInput } from './displayHintSnapshot';
const readAnnotation = (message: DemoMessage) => ['read','unread'].includes(message.relationType ?? '');
/** Viewer-only explanations. This module never creates relations or changes read status. */
export function deriveDisplayHints(input: DisplayHintsInput) {
  const { messages, relations, edges, username, readStatus, personalEffect, corrections } = input;
  const msgMap = new Map(messages.map(message => [message.id,message]));
  const recommendedEffect = deriveContainerEffect({messages,relations,edges,username:null,stakeCounts:personalEffect.stakeCounts});
  const recommendedCorrections = computeCorrectionVersions(messages,edges,computeGloballySuppressedRelIds(edges,messages));
  const personalParents = parentsFor(personalEffect), recommendedParents = parentsFor(recommendedEffect);
  const displayedEffect=input.displayEffect??personalEffect,displayedParents=input.displayEffect?parentsFor(displayedEffect):personalParents;
  const readDisplays=new Map<string,{signature?:string;parts?:{message:string;corrections?:string};time:string;sequence:number}>();
  for(const relation of relations){
    if(relation.relationType.toUpperCase()!=='READ'||relation.createdBy.username!==username)continue;
    for(const ref of relation.targetRefs){
      const id=ref.kind==='relation'?ref.relationId:ref.messageId,signature=relation.payload?.readDisplay?.[id],previous=readDisplays.get(id);
      if(!previous||(relation.sequence&&previous.sequence?relation.sequence>previous.sequence:relation.createdAt>=previous.time))
        readDisplays.set(id,{signature:typeof signature==='string'?signature:undefined,parts:relation.payload?.readDisplayParts?.[id],time:relation.createdAt,sequence:relation.sequence??0});
    }
  }
  const stances = computeUserActiveStanceRelIds(edges,messages,username);
  const stanceMap = buildStanceTargetMap(edges,msgMap);
  const links = new Map<string,Set<string>>(), containerChildren = new Map<string,Set<string>>();
  const stanceTargets = new Map<string,{targetId:string;type:'agree'|'disagree'}>();
  const add = (map: Map<string,Set<string>>,id: string,target: string) => {
    if (!msgMap.has(target) || id === target) return;
    const targets = map.get(id) ?? new Set<string>(); targets.add(target); map.set(id,targets);
  };
  for (const edge of edges) {
    if (['read','unread'].includes(edge.relationType)) continue;
    add(links,edge.relationMessageId,edge.to.messageId);
    add(links,edge.relationMessageId,edge.from.messageId);
    if (edge.relationType === 'agree' || edge.relationType === 'disagree') {
      const resolved = resolveDisplayedStance(edge,msgMap,stanceMap);
      if (resolved) {add(links,edge.relationMessageId,resolved.targetId);stanceTargets.set(edge.relationMessageId,resolved);}
    }
    if (isContainerType(edge.relationType)) add(containerChildren,edge.relationMessageId,edge.to.messageId);
  }
  for (const relation of relations) if (relation.relationType.toUpperCase() === 'JOIN' && relation.sourceMessageId) {
    add(links,relation.id,relation.sourceMessageId);
    if (!relation.state?.membershipDisabled) for (const ref of relation.targetRefs) {
      add(containerChildren,relation.sourceMessageId,ref.kind === 'relation' ? ref.relationId : ref.messageId);
    }
  }
  const pending = new Set(messages.filter(message => !readAnnotation(message) && !!username &&
    (readStatus.get(message.id) === 'UNREAD' || readStatus.get(message.id) !== 'READ' && message.author !== username)).map(message => message.id));
  const related = new Map<string,Set<string>>();
  for (const eventId of pending) {
    const affected = new Set<string>(), queue = [eventId,...(links.get(eventId) ?? [])];
    const stance = stanceTargets.get(eventId);
    // A stance on a correction also concerns its original message.
    for (let index=0;index<queue.length;index++) {
      const id = queue[index];
      if (affected.has(id)) continue;
      affected.add(id);
      const message = msgMap.get(id);
      if (message?.relationType === 'correct') queue.push(...(links.get(id) ?? []));
      if (stance?.type === 'disagree' && stance.targetId === id && isContainerType(message?.relationType)
        && !personalEffect.rejectedContainerIds.has(id) && !recommendedEffect.rejectedContainerIds.has(id)) continue;
      // Container changes concern members and the containers that currently
      // manage them, including fallback ownership after a rejection.
      if (isContainerType(message?.relationType) && (id === eventId || links.get(eventId)?.has(id))) {
        queue.push(...(containerChildren.get(id) ?? []));
      }
      queue.push(...(personalParents.get(id) ?? []),...(recommendedParents.get(id) ?? []));
    }
    for (const id of affected) if (id !== eventId) add(related,id,eventId);
  }
  const hints = new Map<string,DisplayHint>();
  const correctionHints = new Map<string,DisplayHint>();
  const correctionEvents=new Map<string,Set<string>>();
  const correctionTargets=new Map<string,string>();
  for(const edge of edges)if(edge.relationType==='correct'){
    const events=correctionEvents.get(edge.to.messageId)??new Set<string>();
    events.add(edge.relationMessageId);
    correctionTargets.set(edge.relationMessageId,edge.to.messageId);
    correctionEvents.set(edge.to.messageId,events);
  }
  for(const [id,stance] of stanceTargets){
    const target=correctionTargets.get(stance.targetId);if(target)correctionEvents.get(target)!.add(id);
  }
  for (const message of messages) {
    if (readAnnotation(message)) continue;
    const personal = snapshot(message,personalEffect,personalParents,corrections.get(message.id)?.current);
    const recommended = snapshot(message,recommendedEffect,recommendedParents,recommendedCorrections.get(message.id)?.current);
    const displayed=snapshot(message,displayedEffect,displayedParents,(input.displayCorrections??corrections).get(message.id)?.current);
    const different = !sameDisplay(personal,recommended);
    const hasPersonal = stances.has(message.id) || (corrections.get(message.id)?.versions.some(version => stances.has(version.correctionId)) ?? false)
      || personal.parentIds.some(id => {
        const joinId = personalEffect.joinByTarget.get(message.id);
        return joinId && personalEffect.context.joinEffectSourcesByMessage?.get(joinId)?.has('personal') && !!id;
      }) || isContainerType(message.relationType) && message.author === username;
    const hasRecommendation = !!personal.correctionIds.length || !!personal.parentIds.length || stances.has(message.id)
      || isContainerType(message.relationType) || personal.suppressed;
    const hint:DisplayHint={unread:pending.has(message.id),explicitlyUnread:readStatus.get(message.id) === 'UNREAD',
      relatedUnreadIds:[...(related.get(message.id) ?? [])].sort((a,b) => (msgMap.get(b)?.createdAt ?? '').localeCompare(msgMap.get(a)?.createdAt ?? '') || b.localeCompare(a)),
      source:different ? 'personal' : hasRecommendation && !hasPersonal ? 'recommended' : undefined,
      different,personal,recommended,matchesPersonal:sameDisplay(displayed,personal),matchesRecommended:sameDisplay(displayed,recommended),
      readChanged:readDisplays.get(message.id)?.signature!==undefined?readDisplays.get(message.id)!.signature!==displaySignature(displayed):undefined};
    const hasCorrections=!!corrections.get(message.id)?.versions.length;
    if(hasCorrections){
      const events=correctionEvents.get(message.id)??new Set<string>(),previous=readDisplays.get(message.id);
      const bodyChanged=previous?.parts?.corrections!==undefined?previous.parts.corrections!==displaySignature(correctionDisplay(displayed)):undefined;
      correctionHints.set(message.id,{...hint,unread:false,explicitlyUnread:false,
        relatedUnreadIds:hint.relatedUnreadIds.filter(id=>events.has(id)),readChanged:bodyChanged,
        matchesPersonal:displayed.content===personal.content,matchesRecommended:displayed.content===recommended.content,
        source:personal.content!==recommended.content?'personal':personal.correctionIds.length&&!corrections.get(message.id)?.versions.some(version=>stances.has(version.correctionId))?'recommended':undefined});
      const ownPersonal=messageDisplay(personal,message,true),ownRecommended=messageDisplay(recommended,message,true),ownDisplayed=messageDisplay(displayed,message,true);
      hint.relatedUnreadIds=hint.relatedUnreadIds.filter(id=>!events.has(id));
      hint.matchesPersonal=sameDisplay(ownDisplayed,ownPersonal);hint.matchesRecommended=sameDisplay(ownDisplayed,ownRecommended);
      hint.different=!sameDisplay(ownPersonal,ownRecommended);
      hint.source=hint.different?'personal':isContainerType(message.relationType)&&message.author!==username&&!stances.has(message.id)?'recommended':undefined;
      hint.readChanged=previous?.parts?.message!==undefined?previous.parts.message!==displaySignature(ownDisplayed):undefined;
    }else if(readDisplays.get(message.id)?.parts?.message!==undefined){
      hint.readChanged=readDisplays.get(message.id)!.parts!.message!==displaySignature(displayed);
    }
    hints.set(message.id,hint);
  }
  return { hints, correctionHints, recommendedEffect, recommendedCorrections, readDisplays };
}

/** The existing correction viewer shows this record's complete replacement body. */
export function correctionRecordHint(input:DisplayHintsInput,data:ReturnType<typeof deriveDisplayHints>,id:string) {
  const version=[...input.corrections.values()].flatMap(entry=>entry.versions).find(item=>item.correctionId===id);
  const original=version?data.hints.get(version.targetId):undefined;
  if(!version||!original)return;
  const ownRead=data.readDisplays.get(id),previous=ownRead??data.readDisplays.get(version.targetId);
  const displayed={...(ownRead?data.hints.get(id)!.personal:original.personal),content:version.content};
  return {matchesPersonal:version.content===original.personal.content,matchesRecommended:version.content===original.recommended.content,
    readChanged:previous?.signature!==undefined?previous.signature!==displaySignature(displayed):undefined};
}
