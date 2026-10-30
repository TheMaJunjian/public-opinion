import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { correctionRecordHint, deriveDisplayHints, displaySignature, type DisplayHintsInput } from '../pages/workbench/model/displayHints';
import { deriveContainerEffect, isContainerType } from '../pages/workbench/model/containerEffect';
import {bodyVersion,bodyVersionKey,messageReadingKey,materializeBodyVersion,textOf,type ReadingMark,type BodyVersion,type Message as CoreMessage} from '@gonglun/core';
import {api} from '../api';
import {influenceAcknowledgementId,influenceReadingMarks,planReadingMarks,type ReadingInput,type ReadingInfluence} from '../pages/workbench/model/readingProgress';
import {readingTasks,type ReadingTask} from '../pages/workbench/model/readingTasks';
import {groupReadingInfluences,readingInfluenceLabel,type ReadingInfluenceGroup} from '../pages/workbench/model/readingInfluenceGroups';
import {relationTypeName} from '../utils/graphTextSelection';
import {getMessageTypeLabel} from '../utils/messageDisplay';
import {createDisplayHintWindow,type DisplayHintWindow} from '../pages/workbench/model/displayHintWindow';
import {createCurrentContainerLookup} from '../pages/workbench/model/displayHintContainers';
import {applyReadingVersions,createReadingVersionHistory,knownReadingBodyVersions,readingVersionChoices,readingVersionLabel,type ReadingVersionHistory} from '../pages/workbench/model/readingVersions';
import {computeCorrectionVersions,computeGloballySuppressedRelIds} from '../utils/modelBridge';
import MessageReadingVersions,{type ReadingVersionAction} from './MessageReadingVersions';
import {captureReadingVersionPosition} from '../utils/readingVersionPosition';
import {useWorkbenchDrawingTask} from '../context/WorkbenchDrawingContext';
import {deriveMessageAuthorship,type MessageAuthorship} from '../utils/messageAuthorship';
import type {DemoMessage} from '../utils/modelBridge';
import {groupContainerJoinRecords,JOIN_TARGET_LOCATION_LABELS,type JoinRecordEntry} from '../pages/workbench/model/joinRecordGroups';
import {displayHintPosition} from '../utils/displayHintPosition';
import JoinEndpointType from './JoinEndpointType';
import MessageAuthors from './MessageAuthors';
import MessageTime from './MessageTime';
import {CurrentBodyComparison} from './CorrectionComparisonPopup';
import {ComparisonReadingContext} from './ComparisonReadingContext';
import {createComparisonBasis,isComparisonRead} from '../pages/workbench/model/comparisonReading';
import {useWorkbenchPortalTarget} from '../context/WorkbenchPortalContext';

type ViewMessage = (messageId: string,event: MouseEvent,record: boolean,affectedId?:string) => void;
type InfluenceVisit={recordId:string;targetId:string;items:ReadingInfluence[]};
type MarkRead=(marks:ReadingMark[])=>Promise<void>;
const influenceIdentity=(item:ReadingInfluence)=>JSON.stringify([item.key,item.eventId,item.resultKey]);
const DisplayHintsContext = createContext<{data:ReturnType<typeof deriveDisplayHints>;input:DisplayHintsInput;onView:ViewMessage;onMarkRead?:MarkRead;readingError?:string|null;
  onReadNavigate?: (id:string,targetId?:string)=>void;
  onReadVisit?: (id:string,tasks:ReadingTask[])=>void;
  influenceVisits:InfluenceVisit[];setInfluenceVisits:Dispatch<SetStateAction<InfluenceVisit[]>>;
  windowState:DisplayHintWindow;windowScope:string;currentContainerId?:string|null;currentContainers:ReturnType<typeof createCurrentContainerLookup>;versionHistory:ReadingVersionHistory;readingInput:ReadingInput;
  navigateVersion:(messageId:string,action:ReadingVersionAction,anchor:HTMLElement|null)=>void;
  versionIdentity:(messageId:string,value:string)=>string|undefined;
  versionContent:(messageId:string,value:string)=>string|undefined}|null>(null);
const noWindow={subscribe:()=>()=>{},getSnapshot:()=>null};
export const useReadingDisplayContext=()=>useContext(DisplayHintsContext);

/** Both reading surfaces confirm the same visible body and exact influence events. */
export function useMessageReadingConfirmation(messageId:string|null,scope:'message'|'corrections'='message',enabled=true){
  const context=useContext(DisplayHintsContext);
  return useMemo(()=>messageReadingConfirmation(context,messageId,scope,enabled),[context,messageId,scope,enabled]);
}
function messageReadingConfirmation(context:React.ContextType<typeof DisplayHintsContext>,messageId:string|null,scope:'message'|'corrections',enabled:boolean){
    const hint=messageId?(scope==='corrections'?context?.data.correctionHints:context?.data.hints)?.get(messageId):undefined;
    if(!context||!messageId||!hint)return {marks:[] as ReadingMark[],pending:false};
    const visits=context.influenceVisits.filter(visit=>visit.recordId===messageId);
    return {marks:enabled?[...planReadingMarks(context.readingInput,messageId,hint.displayed,scope,{influences:hint.pendingInfluences}),
      ...visits.flatMap(visit=>influenceReadingMarks(visit.targetId,visit.items))]:[],
      pending:hint.unread||hint.pendingInfluences.length>0||hint.selectionChanged===true||visits.length>0};
}

export function useMessagesReadingConfirmation(messageIds:readonly string[]){
  const context=useContext(DisplayHintsContext);
  return useMemo(()=>{
    const confirmations=messageIds.map(id=>messageReadingConfirmation(context,id,'message',true));
    const marks=[...new Map(confirmations.flatMap(item=>item.marks).map(mark=>[JSON.stringify(mark),mark])).values()];
    return {marks,pending:confirmations.some(item=>item.pending),ready:messageIds.every(id=>context?.data.hints.has(id))};
  },[context,messageIds]);
}

export function MessageReadingDetails({messageId,disabled=false}:{messageId:string;disabled?:boolean}){
  return <MessageDisplayMarker messageId={messageId} inline disabled={disabled}/>;
}

export function useMessageAuthorship(message:DemoMessage,fallbackTruth=0,provided?:MessageAuthorship){
  const context=useContext(DisplayHintsContext),input=context?.input;
  return useMemo(()=>provided??deriveMessageAuthorship(message,(input?.displayCorrections??input?.corrections)?.get(message.id),input?.personalEffect.msgMap,fallbackTruth),[message,input,fallbackTruth,provided]);
}

export function useViewedBodyReference(messageId:string){
  const context=useContext(DisplayHintsContext),version=context?.data.hints.get(messageId)?.displayed.version;
  const key=version?bodyVersionKey(version):undefined;
  return useMemo(()=>version?{messageId,revision:version.revision,context:{kind:'MESSAGE' as const,version}}:undefined,[key,messageId]);
}

/** One compact marker opens status details; the View tag keeps the existing viewer entry. */
export function MessageDisplayMarker({messageId,viewTag=false,scope='message',compact=false,inline=false,disabled=false}:{messageId:string;viewTag?:boolean;scope?:'message'|'corrections';compact?:boolean;inline?:boolean;disabled?:boolean}) {
  const portalTarget=useWorkbenchPortalTarget();
  const context=useContext(DisplayHintsContext),comparisonContext=useContext(ComparisonReadingContext),hint=(scope==='corrections'?context?.data.correctionHints:context?.data.hints)?.get(messageId);
  const inlineWindow=useMemo(()=>inline?createDisplayHintWindow():undefined,[inline]);
  const markerRef=useRef<HTMLButtonElement>(null),tooltipRef=useRef<HTMLDivElement>(null),influencesRef=useRef<HTMLDivElement>(null),pinned=useRef(false);
  const instanceId=useId();
  const windowState=inline?inlineWindow:context?.windowState,key=JSON.stringify([context?.windowScope,messageId,scope,viewTag]);
  const openWindow=useSyncExternalStore(windowState?.subscribe??noWindow.subscribe,windowState?.getSnapshot??noWindow.getSnapshot);
  const expanded=inline||openWindow?.key===key&&openWindow.ownerId===instanceId;
  const confirmation=useMessageReadingConfirmation(messageId,scope,expanded);
  const tooltipId=useId(),[anchor,setAnchor]=useState<ReturnType<typeof displayHintPosition>|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
  const [comparison,setComparison]=useState<{before:string;after:string;version:BodyVersion;basis:string}|null>(null);
  const closeHint=()=>{pinned.current=false;setAnchor(null);windowState?.close(key);};
  const showHint=()=>{
    const rect=markerRef.current?.getBoundingClientRect();if(!rect)return;
    const viewport=window.visualViewport;
    setAnchor(displayHintPosition(rect,{left:viewport?.offsetLeft??0,top:viewport?.offsetTop??0,width:viewport?.width??window.innerWidth,height:viewport?.height??window.innerHeight},pinned.current));
  };
  useLayoutEffect(()=>{
    if(inline){windowState?.open(key,instanceId);return;}
    if(openWindow?.key===key&&!windowState?.getSnapshot()?.ownerId)windowState?.open(key,instanceId);
    if(openWindow?.key===key&&windowState?.getSnapshot()?.ownerId===instanceId){pinned.current=true;showHint();}
    else if(pinned.current||openWindow){pinned.current=false;setAnchor(null);}
  },[openWindow,key,hint,inline]);
  useLayoutEffect(()=>{
    if(!anchor||openWindow?.key!==key)return;
    if(tooltipRef.current)tooltipRef.current.scrollTop=openWindow.scrollTop;
    if(influencesRef.current)influencesRef.current.scrollTop=openWindow.influencesScrollTop;
  },[anchor,openWindow,key]);
  const rememberScroll=()=>windowState?.scroll(key,tooltipRef.current?.scrollTop??0,influencesRef.current?.scrollTop??0);
  const openPinned=()=>{pinned.current=true;windowState?.open(key,instanceId);showHint();};
  useLayoutEffect(()=>{
    if(!anchor)return;
    const outside=(event:PointerEvent)=>{
      if(comparison)return;
      if(tooltipRef.current?.querySelector('[data-message-authors] button[aria-expanded="true"]'))return;
      if(!markerRef.current?.contains(event.target as Node)&&!tooltipRef.current?.contains(event.target as Node))closeHint();
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!comparison)closeHint();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);
    const reposition=()=>{if(pinned.current)showHint();else closeHint();};
    const scroll=(event:Event)=>{if(!tooltipRef.current?.contains(event.target as Node))reposition();};
    document.addEventListener('scroll',scroll,true);window.addEventListener('resize',reposition);
    window.visualViewport?.addEventListener('resize',reposition);window.visualViewport?.addEventListener('scroll',reposition);
    return ()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);
      document.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',reposition);
      window.visualViewport?.removeEventListener('resize',reposition);window.visualViewport?.removeEventListener('scroll',reposition);};
  },[anchor,comparison]);
  if(!context || !hint)return null;
  const message=context.input.personalEffect.msgMap.get(messageId);
  const versions=context.input.corrections.get(messageId)?.versions??[];
  const originalVersion=bodyVersion(messageId,context.input.personalEffect.msgMap.get(messageId)?.revision??1);
  const choices=readingVersionChoices(context.input.personalEffect.msgMap.get(messageId)?.content??'',context.input.corrections.get(messageId)?.current,context.data.recommendedCorrections.get(messageId)?.current,context.data.personalCorrectionChoices.has(messageId),versions,originalVersion);
  const frozen=Object.values(context.versionHistory.getSnapshot().get(messageId)?.frozen??{}).flatMap(version=>version.bodyVersion?[version.bodyVersion]:[]);
  for(const version of [...knownReadingBodyVersions(messageId,context.input.readingMarks??[],context.input.messages),...frozen]){
    const identity=bodyVersionKey(version);
    if(!choices.some(choice=>choice.identity===identity)&&!(version.corrections.length===0&&version.revision===(context.input.personalEffect.msgMap.get(messageId)?.revision??1)))choices.push({value:identity,identity,label:`历史正文 ${choices.length}（基础 ${version.revision}，${version.corrections.length} 个更正）`,content:context.versionContent(messageId,identity)??'' ,sameAs:[]});
  }
  const showVersions=scope==='message'&&(!!versions.length||choices.some(choice=>choice.value.startsWith('body:2:')));
  const reading=hint.unread?'消息待阅':'消息已阅';
  const influenceGroups=groupReadingInfluences(hint.pendingInfluences,context.input.personalEffect.msgMap);
  const relatedCount=hint.pendingInfluences.length;
  const relatedReading=relatedCount?`${relatedCount} 条影响待阅`:'';
  const otherVersionReading=[hint.otherVersionUnreadCount?`其他版本有 ${hint.otherVersionUnreadCount} 个正文待阅`:'',hint.otherVersionInfluenceCount?`其他版本有 ${hint.otherVersionInfluenceCount} 条影响待确认`:''].filter(Boolean).join('；');
  const memberContainerType=context.input.personalEffect.msgMap.get(messageId)?.relationType;
  const hasMembers=scope==='message'&&isContainerType(memberContainerType);
  const memberCount=hint.displayed.memberIds.length;
  const memberReading=hasMembers?(hint.unreadMemberCount?`${hint.unreadMemberCount} 条成员消息待阅`:memberCount?'成员消息暂无待阅':'当前无有效成员消息'):'';
  const memberContainerLabel=memberContainerType?relationTypeName(memberContainerType):'容器';
  const match=viewTag?correctionRecordHint(context.input,context.data,messageId)??hint:hint;
  const personallyActive=hint.personalActive;
  const statisticallyActive=hint.recommendedActive;
  const selectionDiffers=personallyActive!==statisticallyActive;
  const effectiveStatus=personallyActive?'选择显示':'选择不显示';
  const recommendedStatus=statisticallyActive?'推荐显示':'推荐不显示';
  const readComparison=match.readChanged===undefined?'暂无上次已阅记录':match.readChanged?'与上次已阅不同':'与上次已阅一致';
  const comparisonStatus=selectionDiffers?'本消息在选择与推荐下的显示不同':'本消息在选择与推荐下的显示相同';
  const lines=[reading,hint.selectionChanged?'本次正文或显示选择变化待确认':'',readComparison,effectiveStatus,recommendedStatus,comparisonStatus,relatedReading,memberReading,otherVersionReading]
    .filter((line):line is string=>!!line),title=lines.join('；');
  const markerColor=statisticallyActive?'#86efac':'#fca5a5';
  const readingState=hint.unread?'unread':relatedCount||hint.unreadMemberCount||hint.otherVersionUnreadCount?'related-unread':match.readChanged?'changed':'read';
  const markRead=async(marks:ReadingMark[])=>{
    if(!context.onMarkRead)return;
    openPinned();setBusy(messageId);setError(null);
    try {await context.onMarkRead(marks);setComparison(null);}
    catch(reason){setError(reason instanceof Error?reason.message:'标记已阅失败，请重试');}
    finally{setBusy(null);}
  };
  const markUnread=async()=>{
    const version=hint.displayed.version;if(!context.onMarkRead||!version)return;
    setBusy(messageId);setError(null);
    try{const key=messageReadingKey(messageId);await context.onMarkRead([{format:3,version,messageId,scope:'message',key,bodySignature:key,signature:displaySignature(hint.displayed),state:'UNREAD'}]);}
    catch(reason){setError(reason instanceof Error?reason.message:'标记未阅失败');}finally{setBusy(null);}
  };
  const versionLabel=readingVersionLabel(choices,hint.displayed.content);
  const originatingVisits=context.influenceVisits.filter(visit=>visit.recordId===messageId);
  const plan=expanded?confirmation.marks:[];
  const automaticGroups=influenceGroups;
  const allInfluences=context.data.reading.influences.get(messageId)??[];
  const pendingKeys=new Set(hint.pendingInfluences.map(influenceIdentity));
  const readInfluences=allInfluences.filter(item=>!pendingKeys.has(influenceIdentity(item)));
  const unreadGroups=automaticGroups,readGroups=groupReadingInfluences(readInfluences,context.input.personalEffect.msgMap);
  const effect=context.input.displayEffect??context.input.personalEffect;
  const receivedRecords=expanded&&hasMembers?effect.relations.filter(record=>record.relationType.toUpperCase()==='JOIN'&&record.sourceMessageId===messageId):[];
  const receivedGroups=groupContainerJoinRecords(messageId,receivedRecords,effect);
  const hasMemberContent=hasMembers&&(memberCount>0||receivedRecords.length>0);
  const pendingImpactCount=new Set(plan.filter(mark=>mark.scope==='influence').map(mark=>JSON.stringify([mark.messageId,mark.key,mark.eventId,mark.resultKey]))).size;
  const confirmationPending=confirmation.pending;
  const confirmationBlocked=disabled||!!busy||!confirmationPending;
  const confirmationLabel=hint.unread?'标记当前消息已阅':!confirmationPending?'当前消息已阅':originatingVisits.length?'确认本次影响':automaticGroups.length?'确认新影响':'确认当前显示';
  const actionStyle={border:'1px solid #475569',borderRadius:3,background:'#243448',color:'#bae6fd',fontSize:11,padding:'2px 6px',cursor:'pointer'};
  const disabledActionStyle={...actionStyle,border:'1px solid #374151',background:'#26303d',color:'#64748b',cursor:'default'};
  const comparisonVersion=hint.displayed.version??bodyVersion(messageId,message?.revision??1);
  const comparisonBasis=comparisonContext?.basisFor(messageId)??'';
  const comparisonRead=isComparisonRead(context.input.readingMarks??[],comparisonVersion,message?.content??'',hint.displayed.content,comparisonBasis);
  const influenceRowStyle={display:'flex',alignItems:'center',gap:6,padding:'6px 0',borderBottom:'1px solid #334155'} as const;
  const influenceLinkStyle={flex:1,minWidth:0,border:0,padding:0,background:'transparent',color:'#bae6fd',textAlign:'left',cursor:'pointer',fontSize:11,overflowWrap:'anywhere'} as const;
  const influenceHasText=(id:string)=>{
    const messages=context.input.personalEffect.msgMap,record=messages.get(id);
    if(!record||!['agree','disagree','recommend','archive','attention','block','tag'].includes(record.relationType??''))return false;
    const hasText=(message:DemoMessage|undefined)=>!!message&&(message.parts?.some(part=>part.type==='text'&&!!part.text.trim())
      ??(message.kind==='normal'&&!!message.content.trim()));
    return hasText(record)||[record.sourceMessageId,...(record.sourceRefs??[]).map(ref=>ref.messageId)]
      .some(sourceId=>!!sourceId&&hasText(messages.get(sourceId)));
  };
  const sectionOpen=(section:string)=>{
    if(!openWindow?.toggledSections?.includes(section)){
      if(section.startsWith('influence-category:'))return false;
      if(section==='automatic')return automaticGroups.length>0||originatingVisits.length>0;
    }
    return !openWindow?.collapsedSections?.includes(section);
  };
  const sectionHeading=(section:string,label:string,color:string)=>
    <button type="button" aria-label={`${sectionOpen(section)?'收起':'展开'}${label}`} aria-expanded={sectionOpen(section)}
      onClick={()=>{rememberScroll();windowState?.toggleSection(key,section,sectionOpen(section));}}
      style={{border:0,padding:0,background:'transparent',color,fontSize:11,fontWeight:600,textAlign:'left',cursor:'pointer'}}>
      <span aria-hidden="true">{sectionOpen(section)?'▾':'▸'} </span>{label}
    </button>;
  const renderInfluence=(group:ReadingInfluenceGroup,unread:boolean)=>{
    const id=group.items[0].messageId,message=context.input.personalEffect.msgMap.get(id),label=readingInfluenceLabel(message,group.items[0].type);
    const influenceStatus=unread?'影响待阅':'影响已阅';
    if(group.grouped){
      const category=`influence-category:${unread?'unread':'read'}:${group.key}`;
      const ids=[...new Set(group.items.map(item=>item.messageId))],causes=[...new Set(group.items.flatMap(item=>item.causes??[]))];
      return <section key={group.key} aria-label={`${group.label}影响`} data-influence-category={group.items[0].type} style={{padding:'6px 0',borderBottom:'1px solid #334155'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:6}}>
          {sectionHeading(category,`${group.label}（${ids.length} 条）`,unread?'#7dd3fc':'#94a3b8')}
          {unread&&!sectionOpen(category)&&<span style={{color:'#7dd3fc',fontSize:10,flexShrink:0}}>影响待阅</span>}
        </div>
        <div hidden={!sectionOpen(category)} style={{paddingLeft:8}}>
          {ids.filter(id=>id!==messageId).map(id=><div key={id} data-influence-message-id={id} style={influenceRowStyle}>
            <div style={{display:'flex',alignItems:'center',gap:6,flex:1,minWidth:0}}>
              <button type="button" title={`查看${label} ${id}`} style={{...influenceLinkStyle,flex:'0 1 auto'}}
                onClick={event=>{openPinned();rememberScroll();context.onView(id,event,true,messageId);}}>{id}</button>
              {influenceHasText(id)&&<span style={{color:'#94a3b8',fontSize:10,flexShrink:0}}>有文本</span>}
            </div>
            <span style={{color:unread?'#7dd3fc':'#86efac',fontSize:10,flexShrink:0}}>{influenceStatus}</span>
          </div>)}
          {causes.map(id=><div key={`cause:${id}`} data-influence-message-id={id} style={influenceRowStyle}>
            <button type="button" style={influenceLinkStyle} onClick={event=>{openPinned();rememberScroll();context.onView(id,event,true,messageId);}}>原因 · {id}</button>
          </div>)}
        </div>
      </section>;
    }
    const containerId=message?.joinInfo?.containerId;
    const currentContainers=context.currentContainers(messageId),currentMessageContainer=currentContainers.has(id);
    const currentContainer=currentMessageContainer||!!containerId&&currentContainers.has(containerId);
    const containerType=containerId?context.input.personalEffect.msgMap.get(containerId)?.relationType:undefined;
    const containerLabel=containerType?relationTypeName(containerType):'容器';
    const description=<>{label} · {id}{currentMessageContainer&&'（当前）'}
      {containerId&&<span style={{display:'block',color:'#94a3b8'}}>{containerLabel}：{containerId}{currentContainer&&'（当前）'}</span>}</>;
    const row=<div key={group.key} style={influenceRowStyle}>
      {currentContainer?<span style={{flex:1,minWidth:0,color:'#cbd5e1',overflowWrap:'anywhere'}}>{description}</span>
        :<button type="button" title={`查看${label} ${id}`} onClick={event=>{openPinned();rememberScroll();context.onView(id,event,true,messageId);}}
          style={influenceLinkStyle}>{description}</button>}
      <span style={{color:unread?'#7dd3fc':'#86efac',fontSize:10,flexShrink:0}}>{influenceStatus}</span>
    </div>;
    return row;
  };
  const renderJoinEntry=(entry:JoinRecordEntry)=> <div key={entry.id} data-reading-join-record={entry.id} style={{display:'grid',gap:3,padding:'4px 0'}}>
    {entry.targets.map(target=>{
      const targetHint=context.data.hints.get(target.id),pendingCount=targetHint?.pendingInfluences.length??0;
      return <div key={target.id} data-reading-join-target={target.id} style={{display:'grid',gap:2,paddingLeft:8}}>
        <div style={{display:'flex',alignItems:'baseline',gap:6}}>
          <button type="button" aria-label={`查看被加入目标 ${target.id}`} onClick={event=>{openPinned();rememberScroll();context.onView(target.id,event,false);}}
            style={{flex:1,minWidth:0,border:0,padding:0,background:'transparent',color:'#bae6fd',textAlign:'left',cursor:'pointer',fontSize:11,overflowWrap:'anywhere'}}><JoinEndpointType messageId={target.id} messages={effect.msgMap}/> ID：{target.id}</button>
          <span data-join-target-location={target.location} data-join-target-adopted={target.adopted?'true':'false'} style={{color:target.location==='outside'?'#fbbf24':target.location==='nested'?'#bfdbfe':'#94a3b8',fontSize:10,fontWeight:target.location==='outside'?600:undefined,flexShrink:0}}>
            {JOIN_TARGET_LOCATION_LABELS[target.location]}{entry.adopted&&!target.adopted?' · 此目标未采用':''}
          </span>
        </div>
        <div style={{color:'#94a3b8',fontSize:10}}>{targetHint?(targetHint.unread?'消息待阅':'消息已阅'):'阅读状态待加载'} · {pendingCount?`${pendingCount} 条新影响待确认`:'暂无新影响'}{targetHint?.unreadMemberCount?` · ${targetHint.unreadMemberCount} 条成员消息待阅`:''}</div>
      </div>;
    })}
  </div>;
  const renderMember=(id:string)=>{
    const memberHint=context.data.hints.get(id);
    return <div key={id} style={{display:'flex',gap:6,alignItems:'baseline'}}>
    <button type="button" style={actionStyle} onClick={event=>{openPinned();rememberScroll();context.onView(id,event,false);}}>查看成员消息 {id}</button>
    <span style={{fontSize:10,color:'#94a3b8'}}>{memberHint?(memberHint.unread?'消息待阅':'消息已阅'):'阅读状态待加载'}{memberHint?.pendingInfluences.length?' · 有新影响':''}</span>
    </div>;
  };
  const renderReceivedGroups=()=>{
    if(!hasMembers)return null;
    const groups=[{key:'adopted',label:'当前采用',entries:receivedGroups.adopted},{key:'unadopted',label:'未采用',entries:receivedGroups.unadopted}];
    const count=groups.reduce((sum,group)=>sum+group.entries.length,0);
    const classify=memberContainerType?.toLowerCase()==='classify',memberIds=new Set(hint.displayed.memberIds);
    const placements=new Map<string,JoinRecordEntry>();
    for(const entry of receivedGroups.adopted)for(const target of entry.targets)if(target.adopted&&memberIds.has(target.id))placements.set(target.id,{...entry,targets:[target]});
    const readGroups=[{key:'read',label:'已阅无新影响',color:'#94a3b8',ids:[] as string[]},
      {key:'new',label:'已阅有新影响',color:'#7dd3fc',ids:[] as string[]},{key:'unread',label:'未阅',color:'#7dd3fc',ids:[] as string[]}];
    for(const id of memberIds){
      const memberHint=context.data.hints.get(id),index=!memberHint||memberHint.unread?2:memberHint.pendingInfluences.length||memberHint.selectionChanged?1:0;
      readGroups[index].ids.push(id);
    }
    return <div data-reading-received-joins style={{borderTop:'1px solid #334155',paddingTop:5,display:'grid',gap:5}}>
      {count>0&&<><div style={{color:'#7dd3fc'}}>被加入的目标消息</div>
      <div style={{fontSize:10,color:'#94a3b8'}}>前往目标消息查看加入的影响，并分别确认阅读进度。</div></>}
      {groups.filter(group=>count>0||group.key==='adopted').map(group=><section key={group.key} aria-label={`${group.label}的被加入目标`} data-reading-join-group={group.key}>
        {sectionHeading(group.key,`${group.label}${count>0?`（${group.entries.length} 条）`:''}`,group.key==='adopted'?'#a7f3d0':'#cbd5e1')}
        <div hidden={!sectionOpen(group.key)}>
        {group.key==='adopted'&&<div data-display-hint-members style={{color:'#7dd3fc',margin:'3px 0'}}>
          <div>成员消息：共 {memberCount} 条 · {memberReading}</div>
          {hint.unreadMemberCount>0&&<div style={{color:'#94a3b8',fontSize:10}}>成员消息需逐个已阅。{memberContainerType?.toLowerCase()==='classify'?`双击进入${memberContainerLabel}查看。`:''}</div>}
          {classify?readGroups.filter(group=>group.ids.length>0).map(group=><section key={group.key} aria-label={`${group.label}的成员消息`} data-member-reading-group={group.key}
            style={{borderTop:'1px solid #334155',paddingTop:5,marginTop:5,display:'grid',gap:3}}>
            {sectionHeading(`members-${group.key}`,`${group.label}（${group.ids.length} 条）`,group.color)}
            <div hidden={!sectionOpen(`members-${group.key}`)} style={{display:sectionOpen(`members-${group.key}`)?'grid':undefined,gap:3}}>
              {group.ids.map(id=><div key={id} data-member-reading-id={id}>{placements.has(id)?renderJoinEntry(placements.get(id)!):renderMember(id)}</div>)}
            </div>
          </section>):hint.displayed.memberIds.filter(id=>!receivedGroups.adopted.some(entry=>entry.targets.some(target=>target.id===id))).map(renderMember)}
        </div>}
        {group.entries.length?group.entries.map(entry=>classify&&group.key==='adopted'?{...entry,targets:entry.targets.filter(target=>!target.adopted||!memberIds.has(target.id))}:entry)
          .filter(entry=>entry.targets.length>0).map(renderJoinEntry):count>0?<div style={{fontSize:10,color:'#94a3b8'}}>暂无记录。</div>:null}
        </div>
      </section>)}
    </div>;
  };
  const readingDetails=expanded?(<section aria-label="消息与影响" style={{border:'1px solid #36516b',borderRadius:4,padding:6,marginTop:8}}>
    <section aria-label="消息阅读确认" data-reading-confirmation="message">
      <div style={{display:'flex',alignItems:'center',gap:6}}>
        <span style={{flex:1}}>消息 · 【{getMessageTypeLabel(message)}】 {messageId}{hint.unread?'（待阅）':''}</span>
        {!!versions.length&&<button type="button" data-comparison-reading={comparisonRead?'read':'unread'} title={comparisonRead?'本版本对比已阅，可再次查看':'查看原文与当前版本正文对比'}
          style={{...(comparisonRead?disabledActionStyle:actionStyle),cursor:'pointer'}} onClick={()=>setComparison({before:message?.content??'',after:hint.displayed.content,version:comparisonVersion,basis:comparisonBasis})}>对比</button>}
        {context.onMarkRead&&<button type="button" aria-label={confirmationLabel} title={confirmationLabel}
          style={{...(confirmationBlocked?disabledActionStyle:actionStyle),flexShrink:0}} disabled={confirmationBlocked} onClick={()=>void markRead(plan)}>
          {busy===messageId?'保存中…':'已阅'}
        </button>}
      </div>
    </section>
    <div ref={influencesRef} data-display-hint-influences="true" onScroll={rememberScroll} style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:8,maxHeight:230,overflowY:'auto',overflowX:'hidden',scrollbarGutter:'stable',paddingRight:6,marginTop:6}}>
      {(unreadGroups.length>0||readGroups.length>0||originatingVisits.length>0)&&<section aria-label="相关影响" data-reading-confirmation="automatic" style={{display:'grid',gap:5}}>
        <div style={{color:'#94a3b8',fontSize:10}}>确认影响不代替阅读对应消息本身。</div>
        {(unreadGroups.length>0||originatingVisits.length>0)&&<section aria-label="未阅影响" data-influence-reading-group="unread">
          {sectionHeading('automatic',`未阅影响（${pendingImpactCount} 条）`,'#7dd3fc')}
          <div hidden={!sectionOpen('automatic')}>
            {unreadGroups.map(group=>renderInfluence(group,true))}
            {originatingVisits.map(visit=>{
              const current=visit.targetId===context.currentContainerId||context.currentContainers(messageId).has(visit.targetId);
              return <div key={visit.targetId} style={influenceRowStyle}>
                {current?<span style={{flex:1,color:'#cbd5e1'}}>影响目标 · {visit.targetId}（当前）</span>
                  :<button type="button" style={influenceLinkStyle} onClick={event=>context.onView(visit.targetId,event,false)}>影响目标 · {visit.targetId}</button>}
                <span style={{color:'#7dd3fc',fontSize:10}}>影响待阅</span>
              </div>;
            })}
          </div>
        </section>}
        {readGroups.length>0&&<section aria-label="已阅影响" data-influence-reading-group="read">
          {sectionHeading('read-influences',`已阅影响（${readInfluences.length} 条）`,'#94a3b8')}
          <div hidden={!sectionOpen('read-influences')}>{readGroups.map(group=>renderInfluence(group,false))}</div>
        </section>}
      </section>}
      {hasMemberContent&&<section aria-label="成员消息" data-reading-confirmation="individual" style={{borderTop:'1px solid #475569',paddingTop:6,display:'grid',gap:5}}>
        {sectionHeading('individual','成员消息','#fbbf24')}
        <div hidden={!sectionOpen('individual')} style={{display:sectionOpen('individual')?'grid':undefined,gap:5}}>
        {renderReceivedGroups()}
        </div>
      </section>}
    </div>
    </section>):null;
  if(inline)return <div data-reading-message-details={messageId}>{readingDetails}
    {(error||context.readingError)&&<div role="alert">{error??context.readingError}</div>}
    {comparison&&<CurrentBodyComparison before={comparison.before} after={comparison.after} version={comparison.version} basis={comparison.basis} onClose={()=>setComparison(null)}/>}
  </div>;
  return <>{viewTag&&<button type="button" data-message-view={messageId} aria-label={`查看消息 ${messageId}：${title}`}
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()}
    onKeyDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
    onClick={event=>{event.stopPropagation();context.onView(messageId,event,true);}}
    style={{padding:'0 2px',border:0,borderRadius:3,background:'transparent',color:'#94a3b8',fontSize:9,lineHeight:'16px',cursor:'pointer',userSelect:'none',pointerEvents:'auto'}}>查看</button>}
  {showVersions&&!compact&&<MessageReadingVersions messageId={messageId} choices={choices} displayedContent={hint.displayed.content} defaultContent={hint.personal.content} recommendedContent={hint.recommended.content}
    displayedIdentity={correctionVersionIdentity((context.input.displayCorrections??context.input.corrections).get(messageId)?.current,originalVersion)} defaultIdentity={correctionVersionIdentity(context.input.corrections.get(messageId)?.current,originalVersion)} recommendedIdentity={correctionVersionIdentity(context.data.recommendedCorrections.get(messageId)?.current,originalVersion)}
    history={context.versionHistory} windowState={context.windowState} windowScope={context.windowScope}
    versionContent={value=>context.versionContent(messageId,value)} versionIdentity={value=>context.versionIdentity(messageId,value)}
    onNavigate={(action,anchor)=>context.navigateVersion(messageId,action,anchor)}/>}
  <button ref={markerRef} type="button" data-display-hint={messageId} data-display-hint-scope={scope}
    data-reading-body={hint.unread?'unread':'read'} data-reading-impact-count={relatedCount}
    data-display-personal={personallyActive?'active':'inactive'} data-display-statistical={statisticallyActive?'active':'inactive'} data-display-reading={readingState}
    data-display-comparison={selectionDiffers?'different':'same'}
    aria-label={`${compact?'消息状态与影响':scope==='corrections'?'更正显示提示':'显示提示'} ${messageId}：${title}`} aria-describedby={anchor?tooltipId:undefined} aria-expanded={expanded}
    aria-description="点击查看作者、发送时间、消息状态与影响"
    onMouseEnter={()=>{if(!windowState?.getSnapshot())showHint();}} onMouseLeave={()=>{if(!pinned.current)setAnchor(null);}}
    onFocus={()=>{if(!windowState?.getSnapshot())showHint();}} onBlur={event=>{if(!pinned.current&&!tooltipRef.current?.contains(event.relatedTarget as Node))closeHint();}}
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()}
    onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')closeHint();}}
    onDoubleClick={event=>event.stopPropagation()} onClick={event=>{
      event.stopPropagation();
      openPinned();
    }}
    style={{position:'relative',display:'inline-flex',alignItems:'center',justifyContent:'center',verticalAlign:'middle',flexShrink:0,
      ...(compact?{marginLeft:4,marginRight:relatedCount?8:2}:{}),
      minHeight:16,minWidth:16,padding:0,border:0,borderRadius:3,background:'transparent',color:markerColor,lineHeight:'16px',cursor:'pointer',userSelect:'none',pointerEvents:'auto'}}>
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {statisticallyActive?<circle cx="8" cy="8" r="6.25" />:<rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2" strokeDasharray="2 1.5" />}
      <path stroke={selectionDiffers?'#7dd3fc':'#94a3b8'} d={`M5 6.5h6M5 9.5h6${selectionDiffers?'M9.5 4.5l-3 7':''}`} />
    </svg>
    {readingState!=='read' && <span aria-hidden="true" style={{position:'absolute',right:0,top:0,width:5,height:5,boxSizing:'border-box',borderRadius:readingState==='changed'?1:'50%',background:readingState==='unread'?'#7dd3fc':readingState==='changed'?'#fbbf24':'#17202e',border:`1px solid ${readingState==='changed'?'#fbbf24':'#7dd3fc'}`}}/>}
    {relatedCount>0&&<span aria-hidden="true" style={{position:'absolute',right:-7,bottom:-1,fontSize:8,lineHeight:'10px',minWidth:10,borderRadius:5,background:'#17202e',color:'#fbbf24',border:'1px solid #a16207'}}>{relatedCount}</span>}
  </button>
  {anchor&&createPortal(<div ref={tooltipRef} id={tooltipId} role="tooltip" data-display-hint-mode={expanded?'details':'summary'}
    data-display-hint-placement={anchor.placement}
    onScroll={rememberScroll}
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()}
    onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
    style={{position:'fixed',left:anchor.left,top:anchor.top,transform:anchor.placement==='above'?'translateY(-100%)':undefined,
      zIndex:10050,width:anchor.width,maxHeight:anchor.maxHeight,boxSizing:'border-box',overflowY:'auto',padding:'8px 10px',border:'1px solid #475569',borderRadius:4,
      background:'#17202e',color:'#e2e8f0',fontSize:11,lineHeight:1.6,boxShadow:'0 3px 12px rgba(0,0,0,0.35)',pointerEvents:expanded?'auto':'none'}}>
    {expanded?<>
    <div data-display-hint-header="true" style={{position:'sticky',top:0,zIndex:5,background:'#17202e',display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,margin:'-8px -10px 6px',padding:'8px 10px 6px',borderBottom:'1px solid #334155'}}>
      <span>消息状态与影响</span>
      <button type="button" aria-label="关闭消息提示" onClick={closeHint} style={{...actionStyle,fontSize:10}}>关闭</button>
    </div>
    <section aria-label="消息信息" style={{display:'grid',gap:5,marginBottom:8,paddingBottom:6,borderBottom:'1px solid #334155'}}>
      {message&&<>
        <MessageAuthors message={message} prefix="作者：" showSelfStake stakePlacement="inline"/>
        <div style={{display:'flex',gap:6,alignItems:'baseline'}}>发送时间：<MessageTime value={message.createdAt}/></div>
      </>}
    </section>
    <section aria-label="消息状态" style={{display:'grid',gap:5}}>
    {sectionHeading('status','消息状态','#cbd5e1')}
    <div hidden={!sectionOpen('status')}>
    {!!versions.length&&<div style={{color:'#94a3b8',fontSize:10,marginBottom:5}}>正在查看：{versionLabel}</div>}
    <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) auto minmax(0,1fr)',alignItems:'center',columnGap:10,rowGap:4}}>
      <span style={{textAlign:'left'}}>{hint.unread?reading:'消息'}</span>
      <span role="img" aria-label={match.readChanged===undefined?'暂无上次已阅记录可比较':match.readChanged?'当前显示与上次已阅不同':'当前显示与上次已阅一致'}
        style={{color:match.readChanged===undefined?'#94a3b8':match.readChanged?'#fbbf24':'#86efac',fontSize:16,fontWeight:600}}>
        {match.readChanged===undefined?'—':match.readChanged?'≠':'='}
      </span>
      <span>{readComparison}</span>
    </div>
    <div role="group" aria-label={selectionDiffers?'选择与推荐不一致':'选择与推荐一致'}
      style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) auto minmax(0,1fr)',alignItems:'center',columnGap:10,marginTop:4}}>
      <span style={{textAlign:'left'}}>{effectiveStatus}</span>
      <span role="img" aria-label={comparisonStatus} style={{color:selectionDiffers?'#7dd3fc':'#94a3b8',fontSize:16,fontWeight:600}}>{selectionDiffers?'≠':'='}</span>
      <span>{recommendedStatus}</span>
    </div>
    {context.onReadNavigate&&<button type="button" style={{marginTop:6,fontSize:11}} onClick={()=>context.onReadNavigate?.(messageId)}>追溯并阅读此消息</button>}
    </div>
    </section>
    {readingDetails}
    {!hint.unread&&context.onMarkRead&&<button type="button" style={{...actionStyle,marginTop:6}} disabled={!!busy} onClick={()=>void markUnread()}>将此消息标为未阅</button>}
    {context.input.readingMarks?.some(mark=>mark.messageId===messageId&&mark.unknownContext)&&<div style={{marginTop:6,color:'#94a3b8'}}>保留有历史确认记录，原版本或确认范围未明确。</div>}
    {(error||context.readingError)&&<div role="alert" style={{marginTop:6,color:'#fca5a5'}}>{error??context.readingError}</div>}
    <div style={{marginTop:4,paddingTop:4,borderTop:'1px solid #334155',color:'#94a3b8',fontSize:10}}>
      {sectionHeading('legend','状态标志说明','#94a3b8')}
      <div hidden={!sectionOpen('legend')}>
      <div>内部 = / ≠：本消息在选择与推荐下显示相同／不同</div>
      <div>外框圆形实线／方形虚线：推荐有效／无效</div>
      <div>蓝点：消息待阅 · 蓝空心点：影响或成员待阅 · 橙角：显示变化</div>
      <div>阅读状态仅自己可见，不消耗贡献点。</div>
      </div>
    </div>
    </>:<>
      <div>{[hint.unread?reading:'消息',relatedReading,memberReading,otherVersionReading].filter(Boolean).join(' · ')}</div>
      <div>{effectiveStatus} · {recommendedStatus}</div>
      <div style={{marginTop:4,color:'#94a3b8',fontSize:10}}>点击展开详情</div>
    </>}
  </div>,portalTarget)}
  {comparison&&<CurrentBodyComparison before={comparison.before} after={comparison.after} version={comparison.version} basis={comparison.basis} onClose={()=>setComparison(null)}/>}
  </>;
}

export function MessageDisplayHintsProvider({input:sourceInput,onView,onMarkRead,onReadNavigate,readingError,windowState:providedWindow,windowScope='',currentContainerId,versionHistory:providedVersions,children}:{input:DisplayHintsInput;onView:ViewMessage;onMarkRead?:MarkRead;onReadNavigate?:(id:string,tasks:ReadingTask[])=>void;readingError?:string|null;windowState?:DisplayHintWindow;windowScope?:string;currentContainerId?:string|null;versionHistory?:ReadingVersionHistory;children:ReactNode}) {
  const parent=useContext(DisplayHintsContext);
  const ownWindow=useMemo(createDisplayHintWindow,[]),windowState=providedWindow??ownWindow;
  const ownVersions=useMemo(createReadingVersionHistory,[]),versionHistory=providedVersions??ownVersions;
  const [ownInfluenceVisits,setOwnInfluenceVisits]=useState<InfluenceVisit[]>([]);
  useEffect(()=>setOwnInfluenceVisits([]),[sourceInput.username]);
  const setInfluenceVisits=parent?.setInfluenceVisits??setOwnInfluenceVisits;
  const influenceVisits=useMemo(()=>{
    if(parent)return parent.influenceVisits;
    const acknowledged=new Set((sourceInput.readingMarks??[]).filter(mark=>mark.format===3&&mark.scope==='influence'&&mark.state!=='UNREAD'&&!mark.unknownContext).map(mark=>JSON.stringify([mark.messageId,mark.key,mark.eventId,mark.resultKey])));
    return ownInfluenceVisits.flatMap(visit=>{const items=visit.items.filter(item=>!acknowledged.has(JSON.stringify([influenceAcknowledgementId(visit.targetId,item),item.key,item.eventId??item.messageId,item.resultKey])));return items.length?[{...visit,items}]:[];});
  },[parent?.influenceVisits,ownInfluenceVisits,sourceInput.readingMarks]);
  const rememberInfluenceVisit=useCallback((recordId:string,targetId:string,items:ReadingInfluence[])=>{
    if(recordId!==targetId&&items.length)setInfluenceVisits(previous=>[...previous.filter(visit=>visit.recordId!==recordId||visit.targetId!==targetId),{recordId,targetId,items}]);
  },[setInfluenceVisits]);
  const startPositioning=useWorkbenchDrawingTask('positioning'),cancelPosition=useRef(()=>{});
  useEffect(()=>()=>cancelPosition.current(),[versionHistory,windowScope]);
  const versions=useSyncExternalStore(versionHistory.subscribe,versionHistory.getSnapshot);
  const recommendedCorrections=useMemo(()=>sourceInput.recommendedCorrections??computeCorrectionVersions(sourceInput.messages,sourceInput.edges,computeGloballySuppressedRelIds(sourceInput.edges,sourceInput.messages)),[sourceInput.recommendedCorrections,sourceInput.messages,sourceInput.edges]);
  const input=useMemo(()=>({...sourceInput,recommendedCorrections,...(providedVersions?{}:{displayCorrections:applyReadingVersions(sourceInput.displayCorrections??sourceInput.corrections,versions,sourceInput.messages,recommendedCorrections,sourceInput.corrections)})}),[sourceInput,providedVersions,versions,recommendedCorrections]);
  const data=useMemo(()=>deriveDisplayHints(input),[input]);
  const versionContent=useCallback((messageId:string,value:string)=>{
    const hint=data.hints.get(messageId);
    if(value==='current'||value==='personal')return hint?.personal.content;
    if(value==='recommended')return hint?.recommended.content;
    if(value==='original')return input.personalEffect.msgMap.get(messageId)?.content;
    return versionHistory.getSnapshot().get(messageId)?.frozen?.[value]?.content??input.corrections.get(messageId)?.versions.find(version=>version.correctionId===value)?.content;
  },[data,input]);
  const versionIdentity=useCallback((messageId:string,value:string)=>{
    const original=bodyVersion(messageId,input.personalEffect.msgMap.get(messageId)?.revision??1);
    if(value==='original')return correctionVersionIdentity(undefined,original);
    if(value==='current'||value==='personal')return correctionVersionIdentity(input.corrections.get(messageId)?.current,original);
    if(value==='recommended')return correctionVersionIdentity(recommendedCorrections.get(messageId)?.current,original);
    return correctionVersionIdentity(versionHistory.getSnapshot().get(messageId)?.frozen?.[value]??input.corrections.get(messageId)?.versions.find(version=>version.correctionId===value),original);
  },[input,recommendedCorrections,versionHistory]);
  const navigateVersion=useCallback((messageId:string,action:ReadingVersionAction,anchor:HTMLElement|null)=>{
    const restore=captureReadingVersionPosition(anchor),before=versionHistory.getSnapshot();
    if(typeof action==='string')versionHistory[action](messageId,value=>versionContent(messageId,value),value=>versionIdentity(messageId,value));
    else {
      const content=versionContent(messageId,action.select);
      if(action.select==='freeze'){
        const source=input.personalEffect.msgMap.get(messageId),current=(input.displayCorrections??input.corrections).get(messageId)?.current;
        if(!source)return;
        const version=current?.bodyVersion??bodyVersion(messageId,source.revision??1);
        const freeze=(snapshot:CoreMessage)=>{versionHistory.freeze(messageId,{...current,snapshot,bodyVersion:version,correctionId:current?.correctionId??bodyVersionKey(version),targetId:messageId,baseContent:current?.baseContent??source.content,content:textOf(snapshot),valid:current?.valid??false,appliedCorrectionIds:version.corrections.map(c=>c.messageId),createdAt:source.createdAt});setVersionError(null);};
        try{freeze(materializeBodyVersion(version,(id,revision)=>{const item=input.personalEffect.msgMap.get(id);return item?.parts&&item.revision===revision?item as unknown as CoreMessage:undefined;}));}
        catch{void api.resolveBodyVersion(version).then(({message})=>freeze(message)).catch(reason=>setVersionError(reason instanceof Error?reason.message:'上下文待补齐'));}
        return;
      }
      if(action.select.startsWith('body:2:')&&content===undefined){
        const version=knownReadingBodyVersions(messageId,input.readingMarks??[],input.messages).find(version=>bodyVersionKey(version)===action.select);
        if(!version)return;
        const freeze=(snapshot:CoreMessage)=>versionHistory.freeze(messageId,{snapshot,bodyVersion:version,correctionId:action.select,targetId:messageId,baseContent:textOf(snapshot),content:textOf(snapshot),valid:false,appliedCorrectionIds:version.corrections.map(c=>c.messageId),createdAt:snapshot.createdAt});
        try{freeze(materializeBodyVersion(version,(id,revision)=>{const item=input.personalEffect.msgMap.get(id);return item?.parts&&item.revision===revision?item as unknown as CoreMessage:undefined;}));}
        catch{void api.resolveBodyVersion(version).then(({message})=>{freeze(message);setVersionError(null);}).catch(reason=>setVersionError(reason instanceof Error?reason.message:'上下文待补齐'));}
        return;
      }
      if(content===undefined)return;
      versionHistory.select(messageId,action.select,true);
    }
    if(before===versionHistory.getSnapshot())return;
    cancelPosition.current();
    const task=startPositioning();let frame=0,paintFrame=0;
    cancelPosition.current=()=>{cancelAnimationFrame(frame);cancelAnimationFrame(paintFrame);task.cancel();};
    const finish=()=>task.run(()=>{restore();task.complete();});
    if(task.afterLayout)task.afterLayout(finish);
    else frame=requestAnimationFrame(()=>{paintFrame=requestAnimationFrame(finish);});
  },[versionHistory,startPositioning,versionContent,data,input]);
  const effect=input.displayEffect??input.personalEffect;
  const currentContainers=useMemo(()=>createCurrentContainerLookup(effect,currentContainerId),[effect,currentContainerId]);
  const readingInput=useMemo(()=>({...input,marks:input.readingMarks,corrections:input.displayCorrections??input.corrections,effectiveCorrections:input.corrections,memberships:effect.memberships,
    displays:new Map([...data.hints].map(([id,hint])=>[id,hint.displayed])),effectiveJoinIds:effect.effectiveJoinIds,suppressedIds:effect.suppressed}),[input,data,effect]);
  const readNavigate=useCallback((id:string,targetId?:string)=>{
    const values=readingTasks(readingInput,new Set([targetId??id]),new Set(input.messages.map(message=>message.id)),'both','discussion',undefined,data.reading,new Set([id])).tasks;
    const visit=values.filter(task=>targetId?task.targetId===targetId&&task.influence?.messageId===id:task.kind==='body'&&task.destinationId===id);
    if(targetId)rememberInfluenceVisit(id,targetId,visit.flatMap(task=>task.influence?[task.influence]:[]));
    // An explicit influence jump addresses that record (its label, badge or
    // inspection card), even when the reading queue normally visits its source.
    onReadNavigate?.(id,targetId?visit.map(task=>({...task,destinationId:id})):visit);
  },[readingInput,input.messages,data.reading,onReadNavigate,rememberInfluenceVisit]);
  const viewInfluence=useCallback<ViewMessage>((id,event,record,targetId)=>{
    if(targetId)rememberInfluenceVisit(id,targetId,data.hints.get(targetId)?.pendingInfluences.filter(item=>item.messageId===id)??[]);
    onView(id,event,record);
  },[data,onView,rememberInfluenceVisit]);
  const confirmRead=useCallback<MarkRead>(async marks=>{
    if(!onMarkRead)return;
    const unique=new Map(marks.map(mark=>[JSON.stringify([mark.messageId,mark.scope,mark.key,mark.eventId,mark.resultKey,mark.version]),mark]));
    await onMarkRead([...unique.values()]);
  },[onMarkRead]);
  const context=useMemo(()=>({data,input,onView:viewInfluence,onMarkRead:onMarkRead?confirmRead:undefined,onReadNavigate:onReadNavigate?readNavigate:undefined,onReadVisit:onReadNavigate,influenceVisits,setInfluenceVisits,readingError,windowState,windowScope,currentContainerId,currentContainers,versionHistory,readingInput,navigateVersion,versionContent,versionIdentity}),[data,input,viewInfluence,onMarkRead,confirmRead,onReadNavigate,readNavigate,influenceVisits,setInfluenceVisits,readingError,windowState,windowScope,currentContainerId,currentContainers,versionHistory,versions,readingInput,navigateVersion,versionContent,versionIdentity]);
  const [versionError,setVersionError]=useState<string|null>(null);
  const comparisonBasis=useMemo(()=>createComparisonBasis(input),[input]);
  const comparisonReading=useMemo(()=>({marks:input.readingMarks??[],onMarkRead:context.onMarkRead,basisFor:comparisonBasis}),[input.readingMarks,context.onMarkRead,comparisonBasis]);
  return <DisplayHintsContext.Provider value={context}><ComparisonReadingContext.Provider value={comparisonReading}>
    {versionError&&<div role="alert">上下文待补齐：{versionError}</div>}{children}
  </ComparisonReadingContext.Provider></DisplayHintsContext.Provider>;
}

/** Comparison panes keep the same markers, calculated for the side being viewed. */
export function MessageDisplayHintsScope({messageId,side,children}:{messageId?:string|null;side?:'agree'|'disagree';children:ReactNode}) {
  const parent=useContext(DisplayHintsContext);
  const input=useMemo(()=>{
    if(!parent||!messageId||!side)return null;
    return {...parent.input,displayEffect:deriveContainerEffect({...parent.input,username:parent.input.username,
      stakeCounts:parent.input.personalEffect.stakeCounts,assumption:{messageId,side}})};
  },[parent?.input,messageId,side]);
  return input&&parent?<MessageDisplayHintsProvider input={input} onView={parent.onView} onMarkRead={parent.onMarkRead} onReadNavigate={parent.onReadVisit} readingError={parent.readingError}
    windowState={parent.windowState} windowScope={`${parent.windowScope}:${messageId}:${side}`} currentContainerId={parent.currentContainerId} versionHistory={parent.versionHistory}>{children}</MessageDisplayHintsProvider>:children;
}
import {correctionVersionIdentity} from '../utils/bodyVersions';
