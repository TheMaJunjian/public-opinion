import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { correctionRecordHint, deriveDisplayHints, displaySignature, type DisplayHintsInput } from '../pages/workbench/model/displayHints';
import { deriveContainerEffect, isContainerType } from '../pages/workbench/model/containerEffect';
import {bodyVersion,bodyVersionKey,messageReadingKey,materializeBodyVersion,textOf,type ReadingMark,type Message as CoreMessage} from '@gonglun/core';
import {api} from '../api';
import {influenceReadingMarks,planReadingMarks,readingMarksFor,type ReadingInput} from '../pages/workbench/model/readingProgress';
import {groupReadingInfluences,readingInfluenceLabel,type ReadingInfluenceGroup} from '../pages/workbench/model/readingInfluenceGroups';
import {relationTypeName} from '../utils/graphTextSelection';
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

type ViewMessage = (messageId: string,event: MouseEvent,record: boolean) => void;
type MarkRead=(marks:ReadingMark[])=>Promise<void>;
const DisplayHintsContext = createContext<{data:ReturnType<typeof deriveDisplayHints>;input:DisplayHintsInput;onView:ViewMessage;onMarkRead?:MarkRead;readingError?:string|null;
  windowState:DisplayHintWindow;windowScope:string;currentContainerId?:string|null;currentContainers:ReturnType<typeof createCurrentContainerLookup>;versionHistory:ReadingVersionHistory;readingInput:ReadingInput;
  navigateVersion:(messageId:string,action:ReadingVersionAction,anchor:HTMLElement|null)=>void;
  versionIdentity:(messageId:string,value:string)=>string|undefined;
  versionContent:(messageId:string,value:string)=>string|undefined}|null>(null);
const noWindow={subscribe:()=>()=>{},getSnapshot:()=>null};

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
export function MessageDisplayMarker({messageId,viewTag=false,scope='message'}:{messageId:string;viewTag?:boolean;scope?:'message'|'corrections'}) {
  const context=useContext(DisplayHintsContext),hint=(scope==='corrections'?context?.data.correctionHints:context?.data.hints)?.get(messageId);
  const markerRef=useRef<HTMLButtonElement>(null),tooltipRef=useRef<HTMLDivElement>(null),influencesRef=useRef<HTMLDivElement>(null),pinned=useRef(false);
  const windowState=context?.windowState,key=JSON.stringify([context?.windowScope,messageId,scope,viewTag]);
  const openWindow=useSyncExternalStore(windowState?.subscribe??noWindow.subscribe,windowState?.getSnapshot??noWindow.getSnapshot);
  const tooltipId=useId(),[anchor,setAnchor]=useState<ReturnType<typeof displayHintPosition>|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
  const closeHint=()=>{pinned.current=false;setAnchor(null);windowState?.close(key);};
  const showHint=()=>{
    const rect=markerRef.current?.getBoundingClientRect();if(!rect)return;
    const viewport=window.visualViewport;
    setAnchor(displayHintPosition(rect,{left:viewport?.offsetLeft??0,top:viewport?.offsetTop??0,width:viewport?.width??window.innerWidth,height:viewport?.height??window.innerHeight},pinned.current));
  };
  useLayoutEffect(()=>{
    if(openWindow?.key===key){pinned.current=true;showHint();}
    else if(pinned.current){pinned.current=false;setAnchor(null);}
  },[openWindow,key,hint]);
  useLayoutEffect(()=>{
    if(!anchor||openWindow?.key!==key)return;
    if(tooltipRef.current)tooltipRef.current.scrollTop=openWindow.scrollTop;
    if(influencesRef.current)influencesRef.current.scrollTop=openWindow.influencesScrollTop;
  },[anchor,openWindow,key]);
  const rememberScroll=()=>windowState?.scroll(key,tooltipRef.current?.scrollTop??0,influencesRef.current?.scrollTop??0);
  const openPinned=()=>{pinned.current=true;windowState?.open(key);showHint();};
  useEffect(()=>{
    if(!anchor)return;
    const outside=(event:PointerEvent)=>{
      if(!markerRef.current?.contains(event.target as Node)&&!tooltipRef.current?.contains(event.target as Node))closeHint();
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')closeHint();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);
    const reposition=()=>{if(pinned.current)showHint();else closeHint();};
    const scroll=(event:Event)=>{if(!tooltipRef.current?.contains(event.target as Node))reposition();};
    document.addEventListener('scroll',scroll,true);window.addEventListener('resize',reposition);
    window.visualViewport?.addEventListener('resize',reposition);window.visualViewport?.addEventListener('scroll',reposition);
    return ()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);
      document.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',reposition);
      window.visualViewport?.removeEventListener('resize',reposition);window.visualViewport?.removeEventListener('scroll',reposition);};
  },[anchor]);
  if(!context || !hint)return null;
  const isRelationMessage=context.input.personalEffect.relationById.has(messageId)||!!context.input.personalEffect.msgMap.get(messageId)?.relationType;
  const hasRelationStatus=scope==='message'&&isRelationMessage;
  const readStatus=context.input.readStatus.get(messageId);
  const hasReadRecord=context.input.readingMarks?.some(mark=>mark.messageId===messageId&&mark.format===3&&mark.scope==='message'&&mark.key===messageReadingKey(messageId)&&mark.state!=='UNREAD');
  const versions=context.input.corrections.get(messageId)?.versions??[];
  const originalVersion=bodyVersion(messageId,context.input.personalEffect.msgMap.get(messageId)?.revision??1);
  const choices=readingVersionChoices(context.input.personalEffect.msgMap.get(messageId)?.content??'',context.input.corrections.get(messageId)?.current,context.data.recommendedCorrections.get(messageId)?.current,context.data.personalCorrectionChoices.has(messageId),versions,originalVersion);
  const frozen=Object.values(context.versionHistory.getSnapshot().get(messageId)?.frozen??{}).flatMap(version=>version.bodyVersion?[version.bodyVersion]:[]);
  for(const version of [...knownReadingBodyVersions(messageId,context.input.readingMarks??[],context.input.messages),...frozen]){
    const identity=bodyVersionKey(version);
    if(!choices.some(choice=>choice.identity===identity)&&!(version.corrections.length===0&&version.revision===(context.input.personalEffect.msgMap.get(messageId)?.revision??1)))choices.push({value:identity,identity,label:`历史正文 ${choices.length}（基础 ${version.revision}，${version.corrections.length} 个更正）`,content:context.versionContent(messageId,identity)??'' ,sameAs:[]});
  }
  const showVersions=scope==='message'&&(!!versions.length||choices.some(choice=>choice.value.startsWith('body:2:')));
  if(!hasRelationStatus && !viewTag && !showVersions && !hint.unread && !hint.originalUnread && !hint.relatedUnreadIds.length && !hint.otherVersionUnreadCount && !hint.unreadMemberCount && !hint.source && !hint.readChanged && !hasReadRecord && readStatus!=='READ')return null;
  const expanded=openWindow?.key===key;
  const reading=hint.unread?'消息待阅':'消息已阅';
  const influenceGroups=groupReadingInfluences(hint.pendingInfluences,context.input.personalEffect.msgMap);
  const relatedCount=influenceGroups.length+Number(hint.originalUnread);
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
  const markRead=async(id:string,markScope:'message'|'corrections'='message')=>{
    const displayed=(markScope==='corrections'?context.data.correctionHints:context.data.hints).get(id)?.displayed;
    if(!context.onMarkRead||!displayed)return;
    openPinned();setBusy(id);setError(null);
    try {await context.onMarkRead(readingMarksFor(context.readingInput,id,displayed,markScope));}
    catch(reason){setError(reason instanceof Error?reason.message:'标记已阅失败，请重试');}
    finally{setBusy(null);}
  };
  const markUnread=async()=>{
    const version=hint.displayed.version;if(!context.onMarkRead||!version)return;
    setBusy(messageId);setError(null);
    try{const key=messageReadingKey(messageId);await context.onMarkRead([{format:3,version,messageId,scope:'message',key,bodySignature:key,signature:displaySignature(hint.displayed),state:'UNREAD'}]);}
    catch(reason){setError(reason instanceof Error?reason.message:'标记未阅失败');}finally{setBusy(null);}
  };
  const markGroupRead=async(group:ReadingInfluenceGroup)=>{
    if(!context.onMarkRead)return;openPinned();setBusy(group.key);setError(null);
    try{await context.onMarkRead(influenceReadingMarks(messageId,group.items));}
    catch(reason){setError(reason instanceof Error?reason.message:'标记已阅失败，请重试');}
    finally{setBusy(null);}
  };
  const versionLabel=readingVersionLabel(choices,hint.displayed.content);
  const plan=expanded?planReadingMarks(context.readingInput,messageId,hint.displayed,scope):[];
  const automaticallyConfirmed=(item:ReadingInfluenceGroup['items'][number])=>plan.some(mark=>mark.scope==='influence'
    ?mark.messageId===messageId&&mark.key===item.key:mark.messageId===item.messageId);
  const automaticGroups=groupReadingInfluences(hint.pendingInfluences.filter(automaticallyConfirmed),context.input.personalEffect.msgMap);
  const individualGroups=groupReadingInfluences(hint.pendingInfluences.filter(item=>!automaticallyConfirmed(item)),context.input.personalEffect.msgMap);
  const effect=context.input.displayEffect??context.input.personalEffect;
  const receivedRecords=expanded&&hasMembers?[...new Map(hint.pendingInfluences.flatMap(item=>{
    const record=effect.relationById.get(item.messageId);
    return record?.relationType.toUpperCase()==='JOIN'&&record.sourceMessageId===messageId?[[record.id,record] as const]:[];
  })).values()]:[];
  const receivedGroups=groupContainerJoinRecords(messageId,receivedRecords,effect);
  const receivedIds=new Set(receivedRecords.map(record=>record.id));
  const receivedInfluences=new Map(receivedRecords.map(record=>[record.id,{key:`received:${record.id}`,label:'被加入',grouped:false,
    items:hint.pendingInfluences.filter(item=>item.messageId===record.id)}]));
  const onlyOriginal=plan.some(mark=>mark.messageId===messageId&&mark.scope==='original');
  const confirmationLabels=[onlyOriginal?'原文阅读进度':'当前消息'];
  if(expanded){
    const included=plan.filter(mark=>mark.scope!=='influence'&&mark.messageId!==messageId);
    const joins=included.filter(mark=>context.input.personalEffect.msgMap.get(mark.messageId)?.kind==='join').length;
    const corrections=included.filter(mark=>context.input.personalEffect.msgMap.get(mark.messageId)?.relationType==='correct').length;
    if(corrections)confirmationLabels.push(`${corrections} 条当前更正`);
    if(joins)confirmationLabels.push(`${joins} 条当前路径加入记录`);
    for(const group of influenceGroups)if(group.grouped&&!(corrections&&group.label==='当前更正')&&group.items.some(item=>plan.some(mark=>mark.messageId===messageId&&mark.scope==='influence'&&mark.key===item.key)))confirmationLabels.push(group.label);
  }
  const actionStyle={border:'1px solid #475569',borderRadius:3,background:'#243448',color:'#bae6fd',fontSize:11,padding:'2px 6px',cursor:'pointer'};
  const renderInfluence=(group:ReadingInfluenceGroup,confirmIndividually:boolean,received?:JoinRecordEntry)=>{
    const id=group.items[0].messageId,message=context.input.personalEffect.msgMap.get(id),label=received?'被加入':readingInfluenceLabel(message,group.items[0].type);
    if(group.grouped)return <div key={group.key} style={{display:'flex',alignItems:'center',gap:6}}>
      <span style={{flex:1,color:'#cbd5e1'}} title={group.items.map(item=>item.messageId).join('、')}>{group.label} · {new Set(group.items.map(item=>item.messageId)).size} 条影响
        {[...new Set(group.items.flatMap(item=>item.causes??[]))].map(id=><button key={id} type="button" style={{...actionStyle,marginLeft:4}} onClick={event=>context.onView(id,event,true)}>原因 · {id}</button>)}
      </span>
      {confirmIndividually&&context.onMarkRead&&<button type="button" aria-label={`标记${group.label}影响已阅`} disabled={!!busy||hint.originalUnread&&group.label==='当前更正'}
        title={hint.originalUnread&&group.label==='当前更正'?'请先确认原文已阅':undefined} style={actionStyle} onClick={()=>void markGroupRead(group)}>{busy===group.key?'保存中…':'已阅'}</button>}
    </div>;
    const containerId=message?.joinInfo?.containerId;
    const currentContainers=context.currentContainers(messageId),currentMessageContainer=currentContainers.has(id);
    const currentContainer=currentMessageContainer||!!containerId&&currentContainers.has(containerId);
    const containerType=containerId?context.input.personalEffect.msgMap.get(containerId)?.relationType:undefined;
    const containerLabel=containerType?relationTypeName(containerType):'容器';
    const description=<>{label} · {id}{currentMessageContainer&&'（当前）'}
      {!received&&containerId&&<span style={{display:'block',color:'#94a3b8'}}>{containerLabel}：{containerId}{currentContainer&&'（当前）'}</span>}</>;
    const row=<div key={group.key} style={{display:'flex',alignItems:'center',gap:6}}>
      {currentContainer?<span style={{flex:1,minWidth:0,color:'#cbd5e1',overflowWrap:'anywhere'}}>{description}</span>
        :<button type="button" title={`查看${label} ${id}`} onClick={event=>{openPinned();rememberScroll();context.onView(id,event,true);}}
          style={{flex:1,minWidth:0,border:0,padding:0,background:'transparent',color:'#bae6fd',textAlign:'left',cursor:'pointer',fontSize:11,overflowWrap:'anywhere'}}>{description}</button>}
      {confirmIndividually&&context.onMarkRead&&<button type="button" aria-label={`标记${label} ${id} 已阅`} disabled={!!busy} style={{...actionStyle,flexShrink:0}}
        onClick={()=>void markRead(id)}>{busy===id?'保存中…':'已阅'}</button>}
    </div>;
    return received?<div key={group.key} data-reading-join-record={id} style={{display:'grid',gap:3,padding:'4px 0'}}>{row}
      {received.targets.map(target=><div key={target.id} data-reading-join-target={target.id} style={{display:'flex',alignItems:'baseline',gap:6,paddingLeft:8}}>
        <button type="button" aria-label={`查看被加入目标 ${target.id}`} onClick={event=>{openPinned();rememberScroll();context.onView(target.id,event,false);}}
          style={{flex:1,minWidth:0,border:0,padding:0,background:'transparent',color:'#94a3b8',textAlign:'left',cursor:'pointer',fontSize:10,overflowWrap:'anywhere'}}>目标 · {target.id}</button>
        <span data-join-target-location={target.location} data-join-target-adopted={target.adopted?'true':'false'} style={{color:target.location==='container'?'#a7f3d0':target.location==='nested'?'#bfdbfe':'#94a3b8',fontSize:10,flexShrink:0}}>
          {JOIN_TARGET_LOCATION_LABELS[target.location]}{received.adopted&&!target.adopted?' · 此目标未采用':''}
        </span>
      </div>)}
    </div>:row;
  };
  const renderReceivedGroups=(automatic:boolean)=>{
    const groups=[{key:'adopted',label:'当前采用',entries:receivedGroups.adopted},{key:'unadopted',label:'未采用',entries:receivedGroups.unadopted}]
      .map(group=>({...group,entries:group.entries.filter(entry=>receivedInfluences.get(entry.id)!.items.every(automaticallyConfirmed)===automatic)}));
    const count=groups.reduce((sum,group)=>sum+group.entries.length,0);if(!count)return null;
    return <div data-reading-received-joins style={{borderTop:'1px solid #334155',paddingTop:5,display:'grid',gap:5}}>
      <div style={{color:'#7dd3fc'}}>被加入记录 · {count} 条待阅</div>
      {groups.map(group=><section key={group.key} aria-label={`${group.label}的待阅被加入记录`} data-reading-join-group={group.key}>
        <div style={{fontWeight:600,color:group.key==='adopted'?'#a7f3d0':'#cbd5e1'}}>{group.label}（{group.entries.length} 条）</div>
        {group.entries.length?group.entries.map(entry=>renderInfluence(receivedInfluences.get(entry.id)!,!automatic,entry))
          :<div style={{fontSize:10,color:'#94a3b8'}}>暂无待阅记录。</div>}
      </section>)}
    </div>;
  };
  return <>{viewTag&&<button type="button" data-message-view={messageId} aria-label={`查看消息 ${messageId}：${title}`}
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()}
    onKeyDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
    onClick={event=>{event.stopPropagation();context.onView(messageId,event,true);}}
    style={{padding:'0 2px',border:0,borderRadius:3,background:'transparent',color:'#94a3b8',fontSize:9,lineHeight:'16px',cursor:'pointer',userSelect:'none',pointerEvents:'auto'}}>查看</button>}
  {showVersions&&<MessageReadingVersions messageId={messageId} choices={choices} displayedContent={hint.displayed.content} defaultContent={hint.personal.content} recommendedContent={hint.recommended.content}
    displayedIdentity={correctionVersionIdentity((context.input.displayCorrections??context.input.corrections).get(messageId)?.current,originalVersion)} defaultIdentity={correctionVersionIdentity(context.input.corrections.get(messageId)?.current,originalVersion)} recommendedIdentity={correctionVersionIdentity(context.data.recommendedCorrections.get(messageId)?.current,originalVersion)}
    history={context.versionHistory} windowState={context.windowState} windowScope={context.windowScope}
    versionContent={value=>context.versionContent(messageId,value)} versionIdentity={value=>context.versionIdentity(messageId,value)}
    onNavigate={(action,anchor)=>context.navigateVersion(messageId,action,anchor)}/>}
  <button ref={markerRef} type="button" data-display-hint={messageId} data-display-hint-scope={scope}
    data-display-personal={personallyActive?'active':'inactive'} data-display-statistical={statisticallyActive?'active':'inactive'} data-display-reading={readingState}
    data-display-comparison={selectionDiffers?'different':'same'}
    aria-label={`${scope==='corrections'?'更正显示提示':'显示提示'} ${messageId}：${title}`} aria-describedby={anchor?tooltipId:undefined} aria-expanded={expanded}
    onMouseEnter={showHint} onMouseLeave={()=>{if(!pinned.current)setAnchor(null);}}
    onFocus={showHint} onBlur={event=>{if(!pinned.current&&!tooltipRef.current?.contains(event.relatedTarget as Node))closeHint();}}
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()}
    onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')closeHint();}}
    onDoubleClick={event=>event.stopPropagation()} onClick={event=>{
      event.stopPropagation();
      openPinned();
    }}
    style={{position:'relative',display:'inline-flex',alignItems:'center',justifyContent:'center',verticalAlign:'middle',flexShrink:0,
      minHeight:16,minWidth:16,padding:0,border:0,borderRadius:3,background:'transparent',color:markerColor,lineHeight:'16px',cursor:'pointer',userSelect:'none',pointerEvents:'auto'}}>
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {statisticallyActive?<circle cx="8" cy="8" r="6.25" />:<rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2" strokeDasharray="2 1.5" />}
      <path stroke={selectionDiffers?'#7dd3fc':'#94a3b8'} d={`M5 6.5h6M5 9.5h6${selectionDiffers?'M9.5 4.5l-3 7':''}`} />
    </svg>
    {readingState!=='read' && <span aria-hidden="true" style={{position:'absolute',right:0,top:0,width:5,height:5,boxSizing:'border-box',borderRadius:readingState==='changed'?1:'50%',background:readingState==='unread'?'#7dd3fc':readingState==='changed'?'#fbbf24':'#17202e',border:`1px solid ${readingState==='changed'?'#fbbf24':'#7dd3fc'}`}}/>}
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
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,marginBottom:6,paddingBottom:4,borderBottom:'1px solid #334155'}}>
      <span>消息状态与影响</span>
      <button type="button" aria-label="关闭消息提示" onClick={closeHint} style={{...actionStyle,fontSize:10}}>关闭</button>
    </div>
    {!!versions.length&&<div style={{color:'#94a3b8',fontSize:10,marginBottom:5}}>正在查看：{versionLabel}</div>}
    <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) auto minmax(0,1fr)',alignItems:'center',columnGap:10,rowGap:4}}>
      <span style={{textAlign:'left'}}>{reading}</span>
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
    {hint.originalUnread&&<div style={{marginTop:4,color:'#fbbf24'}}>首次已阅前，请确认原文和全部更正消息已阅。</div>}
    {!!hint.unreadCorrectionIds?.length&&<div style={{color:'#fbbf24'}}>首次确认还需阅读更正：{hint.unreadCorrectionIds.map(id=><button key={id} type="button" onClick={event=>context.onView(id,event,true)} style={actionStyle}>{id}</button>)}</div>}
    {relatedReading&&<div style={{color:'#7dd3fc',marginTop:8}}>{relatedReading}</div>}
    <div ref={influencesRef} data-display-hint-influences="true" onScroll={rememberScroll} style={{display:'grid',gap:8,maxHeight:230,overflowY:'auto',marginTop:6}}>
      <section aria-label="点击已阅将自动确认" data-reading-confirmation="automatic" style={{border:'1px solid #36516b',borderRadius:4,padding:6,display:'grid',gap:5}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:6}}>
          <span style={{color:'#7dd3fc',fontWeight:600}}>点击已阅将自动确认</span>
          {context.onMarkRead&&<button type="button" aria-label={onlyOriginal?'确认原文已阅':hint.unread?'标记当前消息已阅':'确认当前显示'} title={`同时确认：${confirmationLabels.join('、')}。`}
            style={{...actionStyle,opacity:hint.displayed.correctionIds.length&&(hint.originalUnread||!!hint.unreadCorrectionIds?.length)?0.5:1,flexShrink:0}} disabled={!!busy||!!hint.displayed.correctionIds.length&&(hint.originalUnread||!!hint.unreadCorrectionIds?.length)} onClick={()=>void markRead(messageId,scope)}>
            {busy===messageId?'保存中…':onlyOriginal?'确认原文已阅':'已阅'}
          </button>}
        </div>
        <div style={{overflowWrap:'anywhere',fontSize:10}}>当前消息 · {messageId}</div>
        {automaticGroups.some(group=>group.grouped)&&<div style={{color:'#94a3b8',fontSize:10}}>表态、结算等只确认影响，不代替其消息正文。</div>}
        {automaticGroups.filter(group=>!receivedIds.has(group.items[0].messageId)).map(group=>renderInfluence(group,false))}
        {renderReceivedGroups(true)}
      </section>
      <section aria-label="需分别查看确认" data-reading-confirmation="individual" style={{borderTop:'1px solid #475569',paddingTop:6,display:'grid',gap:5}}>
        <div style={{color:'#fbbf24',fontWeight:600}}>需分别查看确认</div>
        {(individualGroups.length>0||!!hint.displayed.correctionIds.length)&&<div style={{color:'#94a3b8',fontSize:10}}>点击 ID 跳转到对应消息（“当前”项除外{hint.displayed.correctionIds.length?'；原文 ID 切回原文':''}）。</div>}
        {!!hint.displayed.correctionIds.length&&<button type="button" aria-label={`切回原文 ${messageId}`}
          onClick={()=>{openPinned();rememberScroll();context.navigateVersion(messageId,{select:'original'},markerRef.current);}}
          style={{border:0,padding:0,background:'transparent',color:'#bae6fd',textAlign:'left',cursor:'pointer',fontSize:11,overflowWrap:'anywhere'}}>
          原文 · {messageId}（{hint.originalUnread?'待阅':'已阅'}）
        </button>}
        {individualGroups.filter(group=>!receivedIds.has(group.items[0].messageId)).map(group=>renderInfluence(group,true))}
        {renderReceivedGroups(false)}
        {hasMembers&&<div data-display-hint-members style={{color:'#7dd3fc'}}>
          <div>成员消息：共 {memberCount} 条 · {memberReading}</div>
          {hint.unreadMemberCount>0&&<div style={{color:'#94a3b8',fontSize:10}}>成员消息需逐个已阅。{memberContainerType?.toLowerCase()==='classify'?`双击进入${memberContainerLabel}查看。`:''}</div>}
        </div>}
        {otherVersionReading&&<div>
          <div style={{color:'#7dd3fc'}}>{otherVersionReading}</div>
          <div style={{color:'#94a3b8',fontSize:10}}>切换版本后分别查看确认。</div>
        </div>}
        {!individualGroups.length&&!hint.displayed.correctionIds.length&&!hasMembers&&!otherVersionReading&&<div style={{color:'#94a3b8'}}>暂无需逐条确认的消息。</div>}
      </section>
    </div>
    {!hint.unread&&context.onMarkRead&&<button type="button" style={{...actionStyle,marginTop:6}} disabled={!!busy} onClick={()=>void markUnread()}>将此消息标为未阅</button>}
    {context.input.readingMarks?.some(mark=>mark.messageId===messageId&&mark.unknownContext)&&<div style={{marginTop:6,color:'#94a3b8'}}>保留有历史确认记录，原版本或确认范围未明确。</div>}
    {(error||context.readingError)&&<div role="alert" style={{marginTop:6,color:'#fca5a5'}}>{error??context.readingError}</div>}
    <div style={{marginTop:4,paddingTop:4,borderTop:'1px solid #334155',color:'#94a3b8',fontSize:10}}>
      <div>内部 = / ≠：本消息在选择与推荐下显示相同／不同</div>
      <div>外框圆形实线／方形虚线：推荐有效／无效</div>
      <div>蓝点：消息待阅 · 蓝空心点：影响或成员待阅 · 橙角：显示变化</div>
      <div>阅读状态仅自己可见，不消耗贡献点。</div>
    </div>
    </>:<>
      <div>{[reading,relatedReading,memberReading,otherVersionReading].filter(Boolean).join(' · ')}</div>
      <div>{effectiveStatus} · {recommendedStatus}</div>
      <div style={{marginTop:4,color:'#94a3b8',fontSize:10}}>点击展开详情</div>
    </>}
  </div>,document.body)}</>;
}

export function MessageDisplayHintsProvider({input:sourceInput,onView,onMarkRead,readingError,windowState:providedWindow,windowScope='',currentContainerId,versionHistory:providedVersions,children}:{input:DisplayHintsInput;onView:ViewMessage;onMarkRead?:MarkRead;readingError?:string|null;windowState?:DisplayHintWindow;windowScope?:string;currentContainerId?:string|null;versionHistory?:ReadingVersionHistory;children:ReactNode}) {
  const ownWindow=useMemo(createDisplayHintWindow,[]),windowState=providedWindow??ownWindow;
  const ownVersions=useMemo(createReadingVersionHistory,[]),versionHistory=providedVersions??ownVersions;
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
    displays:new Map([...data.hints].map(([id,hint])=>[id,hint.displayed])),effectiveJoinIds:effect.effectiveJoinIds}),[input,data,effect]);
  const context=useMemo(()=>({data,input,onView,onMarkRead,readingError,windowState,windowScope,currentContainerId,currentContainers,versionHistory,readingInput,navigateVersion,versionContent,versionIdentity}),[data,input,onView,onMarkRead,readingError,windowState,windowScope,currentContainerId,currentContainers,versionHistory,versions,readingInput,navigateVersion,versionContent,versionIdentity]);
  const [versionError,setVersionError]=useState<string|null>(null);
  return <DisplayHintsContext.Provider value={context}>{versionError&&<div role="alert">上下文待补齐：{versionError}</div>}{children}</DisplayHintsContext.Provider>;
}

/** Comparison panes keep the same markers, calculated for the side being viewed. */
export function MessageDisplayHintsScope({messageId,side,children}:{messageId?:string|null;side?:'agree'|'disagree';children:ReactNode}) {
  const parent=useContext(DisplayHintsContext);
  const input=useMemo(()=>{
    if(!parent||!messageId||!side)return null;
    return {...parent.input,displayEffect:deriveContainerEffect({...parent.input,username:parent.input.username,
      stakeCounts:parent.input.personalEffect.stakeCounts,assumption:{messageId,side}})};
  },[parent?.input,messageId,side]);
  return input&&parent?<MessageDisplayHintsProvider input={input} onView={parent.onView} onMarkRead={parent.onMarkRead} readingError={parent.readingError}
    windowState={parent.windowState} windowScope={`${parent.windowScope}:${messageId}:${side}`} currentContainerId={parent.currentContainerId} versionHistory={parent.versionHistory}>{children}</MessageDisplayHintsProvider>:children;
}
import {correctionVersionIdentity} from '../utils/bodyVersions';
