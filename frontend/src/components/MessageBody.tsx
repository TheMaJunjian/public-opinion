import {createContext,useContext,useState,type ReactNode} from 'react';
import type {DemoMessage} from '../utils/modelBridge';
import {ModerationContext} from './ModerationContext';
import './MessageBody.css';

const VisibleBody=createContext<string|null>(null);

/** Covers the body without mounting hidden text or preserving its old dimensions. */
export default function MessageBody({message,children}:{message:DemoMessage;children:ReactNode}){
  const moderation=useContext(ModerationContext),visible=useContext(VisibleBody);
  const [revealed,setRevealed]=useState<string|null>(null);
  const summary=message.moderation??moderation?.summaries.get(message.id);
  const vote=summary?.revision===(message.revision??1)?summary.viewerVote:undefined;
  const key=`${message.id}:${message.revision??1}:${vote?.messageId??''}`;
  const canToggle=vote?.verdict==='reject'&&visible!==key&&!message.restricted;
  const personal=canToggle&&revealed!==key;
  const reveal=!message.restricted;
  const action=reveal?()=>setRevealed(key):moderation?()=>moderation.open(message.id):undefined;
  const label=reveal?'你已投不通过，点击展开正文':action?'正文已遮挡，查看审核记录':'正文已遮挡';
  const cover=<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.8 5.3A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.1 3.7M6.1 6.1A20 20 0 0 0 2 12s4 7 10 7a12 12 0 0 0 5.9-1.9"/>
  </svg>;
  if(!message.restricted&&!personal)return <VisibleBody.Provider value={key}>{canToggle?<div className="message-body-revealed">
    <button type="button" className="message-body-hide" aria-label="重新遮挡正文" title="重新遮挡正文" aria-expanded="true"
      onClick={event=>{event.stopPropagation();setRevealed(null);}} onDoubleClick={event=>event.stopPropagation()}
      onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>{cover}</button>
    {children}
  </div>:children}</VisibleBody.Provider>;
  return action?<button type="button" className="message-content-mask" data-content-mask={reveal?'personal':'restricted'} aria-label={label} title={label}
    aria-expanded={reveal?false:undefined}
    onClick={event=>{event.stopPropagation();action();}} onDoubleClick={event=>event.stopPropagation()}
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>{cover}</button>
    :<div className="message-content-mask" data-content-mask="restricted" role="img" aria-label={label} title={label}>{cover}</div>;
}
