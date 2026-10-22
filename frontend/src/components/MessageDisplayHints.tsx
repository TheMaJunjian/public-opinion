import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { correctionRecordHint, deriveDisplayHints, type DisplayHintsInput } from '../pages/workbench/model/displayHints';
import { deriveContainerEffect, isContainerType } from '../pages/workbench/model/containerEffect';
import { meaningCorrectionIds } from '../utils/correctionStanceDisplay';

type ViewMessage = (messageId: string,event: MouseEvent,record: boolean) => void;
const DisplayHintsContext = createContext<{data:ReturnType<typeof deriveDisplayHints>;input:DisplayHintsInput;onView:ViewMessage}|null>(null);

export function useStanceCorrections(messageId:string) {
  const context=useContext(DisplayHintsContext);
  return context?meaningCorrectionIds((context.input.displayCorrections??context.input.corrections).get(messageId)):undefined;
}

/** Compact status hints; the explicit View tag keeps the existing viewer entry. */
export function MessageDisplayMarker({messageId,viewTag=false,scope='message'}:{messageId:string;viewTag?:boolean;scope?:'message'|'corrections'}) {
  const context=useContext(DisplayHintsContext),hint=(scope==='corrections'?context?.data.correctionHints:context?.data.hints)?.get(messageId);
  const markerRef=useRef<HTMLButtonElement>(null),tooltipRef=useRef<HTMLDivElement>(null),pinned=useRef(false);
  const tooltipId=useId(),[anchor,setAnchor]=useState<{left:number;top:number;above:boolean}|null>(null);
  const closeHint=()=>{pinned.current=false;setAnchor(null);};
  const showHint=()=>{
    const rect=markerRef.current?.getBoundingClientRect();if(!rect)return;
    const above=rect.bottom+110>window.innerHeight;
    setAnchor({left:Math.max(8,Math.min(rect.left,window.innerWidth-268)),top:above?rect.top-6:rect.bottom+6,above});
  };
  useEffect(()=>{
    if(!anchor)return;
    const outside=(event:PointerEvent)=>{
      if(!markerRef.current?.contains(event.target as Node)&&!tooltipRef.current?.contains(event.target as Node))closeHint();
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')closeHint();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);
    document.addEventListener('scroll',closeHint,true);window.addEventListener('resize',closeHint);
    return ()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);
      document.removeEventListener('scroll',closeHint,true);window.removeEventListener('resize',closeHint);};
  },[anchor]);
  const reviewingContainer=scope==='message'&&!!context?.input.displayEffect&&isContainerType(context?.input.personalEffect.relationById.get(messageId)?.relationType);
  if(!context || !hint || !viewTag && !reviewingContainer && !hint.unread && !hint.relatedUnreadIds.length && !hint.source && !hint.readChanged)return null;
  const reading=hint.unread?hint.explicitlyUnread?'已标为未读':'待阅，尚未标为已读':hint.relatedUnreadIds.length?'有相关未读变动':'';
  const match=viewTag?correctionRecordHint(context.input,context.data,messageId)??hint:hint;
  const comparisons=[match.matchesPersonal?'与我的选择一致':'与我的选择不同',match.matchesRecommended?'与推荐一致':'与推荐不同',
    match.readChanged===undefined?'暂无上次已读的显示记录':match.readChanged?'与上次已读不同':'与上次已读一致'];
  const lines=[reading,...comparisons].filter(Boolean),title=lines.join('；');
  return <><button ref={markerRef} type="button" data-display-hint={messageId} data-display-hint-scope={scope} data-message-view={viewTag?messageId:undefined}
    aria-label={`${viewTag?'查看消息':scope==='corrections'?'更正显示提示':'显示提示'} ${messageId}：${title}`} aria-describedby={anchor?tooltipId:undefined}
    onMouseEnter={showHint} onMouseLeave={()=>{if(!pinned.current)setAnchor(null);}}
    onFocus={showHint} onBlur={closeHint}
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()}
    onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')closeHint();}}
    onDoubleClick={event=>event.stopPropagation()} onClick={event=>{
      event.stopPropagation();
      if(viewTag){closeHint();context.onView(messageId,event,true);}else{pinned.current=true;showHint();}
    }}
    style={{display:'inline-flex',alignItems:'center',justifyContent:'center',gap:3,verticalAlign:'middle',flexShrink:0,
      minHeight:14,minWidth:14,padding:'0 2px',border:0,borderRadius:3,background:'transparent',color:'#94a3b8',fontSize:9,lineHeight:'14px',cursor:viewTag?'pointer':'help',userSelect:'none',pointerEvents:'auto'}}>
    {(hint.unread || !!hint.relatedUnreadIds.length) && <span aria-hidden="true" style={{width:5,height:5,boxSizing:'border-box',borderRadius:'50%',background:hint.unread?'#7dd3fc':'transparent',border:'1px solid #7dd3fc'}}/>}
    {viewTag?'查看':!match.matchesPersonal?'我≠':!match.matchesRecommended?'荐≠':match.readChanged?'读≠':hint.source==='recommended'?'荐':reviewingContainer?'✓':null}
  </button>{anchor&&createPortal(<div ref={tooltipRef} id={tooltipId} role="tooltip"
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()}
    onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
    style={{position:'fixed',left:anchor.left,top:anchor.top,transform:anchor.above?'translateY(-100%)':undefined,
      zIndex:10050,maxWidth:260,padding:'6px 8px',border:'1px solid #475569',borderRadius:4,
      background:'#17202e',color:'#e2e8f0',fontSize:11,lineHeight:1.6,boxShadow:'0 3px 12px rgba(0,0,0,0.35)',pointerEvents:'auto'}}>
    {lines.map(line=><div key={line}>{line}</div>)}
  </div>,document.body)}</>;
}

export function MessageDisplayHintsProvider({input,onView,children}:{input:DisplayHintsInput;onView:ViewMessage;children:ReactNode}) {
  const data=useMemo(()=>deriveDisplayHints(input),[input]);
  const context=useMemo(()=>({data,input,onView}),[data,input,onView]);
  return <DisplayHintsContext.Provider value={context}>{children}</DisplayHintsContext.Provider>;
}

/** Comparison panes keep the same markers, calculated for the side being viewed. */
export function MessageDisplayHintsScope({messageId,side,children}:{messageId?:string|null;side?:'agree'|'disagree';children:ReactNode}) {
  const parent=useContext(DisplayHintsContext);
  const input=useMemo(()=>{
    if(!parent||!messageId||!side)return null;
    return {...parent.input,displayEffect:deriveContainerEffect({...parent.input,username:parent.input.username,
      stakeCounts:parent.input.personalEffect.stakeCounts,assumption:{messageId,side}})};
  },[parent?.input,messageId,side]);
  return input&&parent?<MessageDisplayHintsProvider input={input} onView={parent.onView}>{children}</MessageDisplayHintsProvider>:children;
}
