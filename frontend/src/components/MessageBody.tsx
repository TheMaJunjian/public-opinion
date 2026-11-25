import {createContext,useContext,useEffect,useState,type ReactNode,type SyntheticEvent} from 'react';
import type {ReviewContext} from '@gonglun/core';
import type {DemoMessage} from '../utils/modelBridge';
import {CoveredBodyContext,LocalReviewRecordsContext,MessageViewerContext,ModerationContext} from './ModerationContext';
import './MessageBody.css';

const VisibleBody=createContext<string|null>(null);
const stopCardEvent=(event:SyntheticEvent)=>event.stopPropagation();
const coverEvents={onMouseDown:stopCardEvent,onMouseUp:stopCardEvent,onDoubleClick:stopCardEvent,onKeyDown:stopCardEvent};

/** Covers the body without mounting hidden text or preserving its old dimensions. */
export default function MessageBody({message,children}:{message:DemoMessage;children:ReactNode}){
  const moderation=useContext(ModerationContext),visible=useContext(VisibleBody);
  const viewer=useContext(MessageViewerContext),localReviews=useContext(LocalReviewRecordsContext);
  const [revealed,setRevealed]=useState<string|null>(null);
  const summary=message.moderation??moderation?.summaries.get(message.id);
  const revision=message.revision??summary?.revision??1;
  const vote=summary?.revision===revision?summary.viewerVote:undefined;
  const key=`${message.id}:${revision}:${vote?.messageId??''}`;
  const canToggle=vote?.verdict==='reject'&&visible!==key&&!message.restricted;
  const personal=canToggle&&revealed!==key;
  const covered=!!message.restricted||personal;
  const onCovered=useContext(CoveredBodyContext);
  useEffect(()=>{
    if(covered)onCovered?.(message.id);
  },[covered,onCovered,message.id]);
  // Older canvases may still hand the renderer the signed vote's embedded text.
  if(!covered&&['review','review-appeal'].includes(message.relationType??''))return null;
  const cover=<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.8 5.3A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.1 3.7M6.1 6.1A20 20 0 0 0 2 12s4 7 10 7a12 12 0 0 0 5.9-1.9"/>
  </svg>;
  if(!message.restricted&&!personal)return <VisibleBody.Provider value={key}>{canToggle?<div className="message-body-revealed">
    <button type="button" className="message-body-hide" aria-label="重新遮挡正文" title="重新遮挡正文" aria-expanded="true"
      {...coverEvents} onClick={event=>{event.stopPropagation();setRevealed(null);}}>{cover}</button>
    {children}
  </div>:children}</VisibleBody.Provider>;
  const targets=new Map<string,ReviewContext>();
  function addTarget(target:ReviewContext){
    const key=JSON.stringify([target.messageId,target.revision]);
    if(moderation||localReviews?.available.has(key))targets.set(key,target);
  }
  if((summary?.messageId===message.id&&summary.revision===revision)||localReviews?.available.has(JSON.stringify([message.id,revision])))
    addTarget({messageId:message.id,revision});
  for(const target of message.restrictedReviewTargets??[])addTarget(target);
  // A local viewer may be selected by name when the archive has no account directory.
  const ownStance=message.restricted&&message.restrictedStance&&viewer&&
    (viewer.id===message.authorId||viewer.id===`viewer:${viewer.username}`&&viewer.username===message.author);
  const singleMaskLink=!personal&&!ownStance&&targets.size===1;
  const links=[...targets].map(([key,target])=>{
    const address=`${target.messageId} 第 ${target.revision} 版`;
    const label=singleMaskLink?'正文已遮挡，查看审核记录':targets.size===1?'查看审核记录':`查看审核记录（${address}）`;
    const text=targets.size===1?'查看审核记录':
      `${target.messageId===message.id&&target.revision===revision?'本条消息':'遮挡来源 '+target.messageId.slice(0,8)} · 第 ${target.revision} 版审核记录`;
    return <button key={key} type="button" className={singleMaskLink?'message-content-mask':'message-mask-review-link'}
      data-content-mask={singleMaskLink?'restricted':undefined} aria-label={label} title={`查看审核记录（${address}）`}
      {...coverEvents} onClick={event=>{
        event.stopPropagation();
        if(event.detail<=1)(moderation??localReviews)?.open(target.messageId,target.revision);
      }}>{singleMaskLink&&cover}<span>{text}</span></button>;
  });
  if(singleMaskLink)return <>{links}</>;
  if(ownStance)return <div className="message-restricted-stance" data-gesture-disabled="true" {...coverEvents} onClick={stopCardEvent}>
    <strong>{message.restrictedStance==='agree'?'你已赞同':'你已反对'}</strong>
    <span>目标正文已被审核遮挡。这条表态免审。</span>{links}
  </div>;
  return <div className="message-cover-actions" data-gesture-disabled="true" {...coverEvents} onClick={stopCardEvent}>
    {personal?<button type="button" className="message-content-mask" data-content-mask="personal"
      aria-label="你已投不通过，点击展开正文" aria-expanded={false}
      onClick={event=>{event.stopPropagation();if(event.detail<=1)setRevealed(key);}}>{cover}<span>展开正文</span></button>:
      <div className="message-content-mask" data-content-mask="restricted" role="img" aria-label="正文已遮挡">{cover}<span>正文已遮挡</span></div>}
    {links}
  </div>;
}
