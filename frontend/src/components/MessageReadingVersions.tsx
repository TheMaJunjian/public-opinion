import {useEffect,useId,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {readingVersionLabel,readingVersionNavigation,type ReadingVersionChoice,type ReadingVersionHistory} from '../pages/workbench/model/readingVersions';
import type {DisplayHintWindow} from '../pages/workbench/model/displayHintWindow';
import HistoryArrowIcon from './HistoryArrowIcon';

export type ReadingVersionAction={select:string}|'back'|'forward';

export default function MessageReadingVersions({messageId,choices,displayedContent,displayedIdentity,defaultIdentity,recommendedIdentity,defaultContent,recommendedContent,history,windowState,windowScope,onNavigate,versionContent,versionIdentity}:{
  versionIdentity?:(value:string)=>string|undefined;
  displayedIdentity?:string;defaultIdentity?:string;recommendedIdentity?:string;
  messageId:string;choices:ReadingVersionChoice[];displayedContent:string;defaultContent:string;recommendedContent:string;history:ReadingVersionHistory;windowState:DisplayHintWindow;windowScope:string;
  onNavigate:(action:ReadingVersionAction,anchor:HTMLElement|null)=>void;
  versionContent:(value:string)=>string|undefined;
}) {
  const markerRef=useRef<HTMLButtonElement>(null),popupRef=useRef<HTMLDivElement>(null),popupId=useId();
  const snapshot=useSyncExternalStore(history.subscribe,history.getSnapshot);
  const navigation=readingVersionNavigation(snapshot,messageId,versionContent,displayedContent,versionIdentity);
  const openWindow=useSyncExternalStore(windowState.subscribe,windowState.getSnapshot),key=JSON.stringify([windowScope,messageId,'versions']),open=openWindow?.key===key;
  const [position,setPosition]=useState({left:8,top:8,above:false});
  const label=readingVersionLabel(choices,displayedContent,displayedIdentity);
  const fixed=snapshot.get(messageId)?.values[snapshot.get(messageId)!.index]?.startsWith('body:2:')??false;
  const overridden=displayedIdentity===undefined?displayedContent!==defaultContent:displayedIdentity!==defaultIdentity,defaultLabel=readingVersionLabel(choices,defaultContent,defaultIdentity);
  const differsFromRecommendation=displayedIdentity===undefined?displayedContent!==recommendedContent:displayedIdentity!==recommendedIdentity;
  const hasPersonalChoice=choices.some(choice=>choice.value==='personal');
  const close=()=>windowState.close(key);
  const reposition=()=>{
    const rect=markerRef.current?.getBoundingClientRect();if(!rect)return;
    const above=rect.bottom+240>window.innerHeight;
    setPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-308)),top:above?rect.top-6:rect.bottom+6,above});
  };
  useLayoutEffect(()=>{if(open)reposition();},[open,snapshot]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!markerRef.current?.contains(event.target as Node)&&!popupRef.current?.contains(event.target as Node))close();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){close();markerRef.current?.focus({preventScroll:true});}};
    const scroll=(event:Event)=>{if(!popupRef.current?.contains(event.target as Node))reposition();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
    document.addEventListener('scroll',scroll,true);window.addEventListener('resize',reposition);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);
      document.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',reposition);};
  },[open]);
  const actionStyle={border:'1px solid #475569',borderRadius:3,background:'#243448',color:'#bae6fd',fontSize:11,padding:'3px 7px',cursor:'pointer'};
  return <span data-reading-versions={messageId} style={{display:'inline-flex',alignItems:'center',verticalAlign:'middle',pointerEvents:'auto'}}
    onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}
    onDoubleClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>
    <button ref={markerRef} type="button" data-reading-version-marker={messageId} data-reading-version-override={overridden?'true':'false'} aria-label={`切换消息 ${messageId} 的版本`}
      data-reading-version-recommendation={differsFromRecommendation?'different':'same'}
      aria-description={`${fixed?'当前固定查看此正文':overridden?'当前显示与默认版本不同':'当前显示跟随默认版本'}；${differsFromRecommendation?'正文与推荐显示不同':'正文与推荐显示相同'}`}
      title={`阅览版本：${label}；${differsFromRecommendation?'正文与推荐显示不同；':''}${overridden?`与默认显示不同（默认：${defaultLabel}）；`:''}点击切换版本`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open?popupId:undefined} onClick={()=>{
        if(open){close();return;}
        windowState.open(key);
      }}
      style={{position:'relative',display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0,width:18,height:16,padding:0,border:0,borderRadius:3,background:overridden?'rgba(251,191,36,0.15)':'transparent',color:'#fbbf24',cursor:'pointer'}}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="1.5" width="8.5" height="10" rx="1.5"/><path d="M10.5 14.5h-7A1 1 0 0 1 2 13V5.5M7.5 5h3.5M7.5 8h3.5"/>
      </svg>
      {differsFromRecommendation&&<span data-reading-version-recommendation-difference aria-hidden="true" style={{position:'absolute',right:0,top:0,width:5,height:5,borderRadius:'50%',background:'#7dd3fc',boxShadow:'0 0 0 1px #17202e'}}/>}
    </button>
    {open&&createPortal(<div ref={popupRef} id={popupId} role="dialog" aria-label={`消息 ${messageId} 的版本`}
      style={{position:'fixed',left:position.left,top:position.top,transform:position.above?'translateY(-100%)':undefined,zIndex:10050,width:280,maxWidth:'calc(100vw - 36px)',maxHeight:'calc(100vh - 24px)',overflowY:'auto',padding:'8px 10px',border:'1px solid #475569',borderRadius:4,background:'#17202e',color:'#e2e8f0',fontSize:11,lineHeight:1.6,boxShadow:'0 3px 12px rgba(0,0,0,0.35)'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,marginBottom:8}}><span>切换阅览版本</span><button type="button" aria-label="关闭版本选择" onClick={close} style={actionStyle}>关闭</button></div>
      {!hasPersonalChoice&&<div style={{marginBottom:8,color:'#94a3b8'}}>当前用户尚未选择，默认跟随推荐选择。</div>}
      {differsFromRecommendation&&<div style={{marginBottom:8,color:'#7dd3fc'}}>当前正文与推荐显示不同。</div>}
      {(overridden||fixed)&&<div style={{marginBottom:8,color:'#fbbf24'}}>
        <div>{fixed?'当前固定查看此正文。':'当前显示与默认版本不同。'}</div>
        <button type="button" aria-label={`恢复默认显示 ${messageId}`} onClick={()=>onNavigate({select:'current'},markerRef.current)} style={{...actionStyle,marginTop:4}}>恢复默认显示</button>
      </div>}
      <div role="radiogroup" aria-label={`消息 ${messageId} 的阅览版本`} style={{display:'grid',gap:6}}>
        {choices.map(choice=>{
          const displayed=displayedIdentity===undefined?choice.content===displayedContent:choice.identity===displayedIdentity;
          return <button key={choice.label} type="button" role="radio" aria-checked={displayed} data-reading-version-choice={choice.value}
            onClick={()=>{if(!displayed||fixed)onNavigate({select:choice.value},markerRef.current);}}
            style={{...actionStyle,display:'flex',alignItems:'center',gap:8,textAlign:'left',padding:'6px 8px',background:displayed?'#263e52':'#1b293a',borderColor:displayed?'#7dd3fc':'#475569'}}>
            <span style={{flex:1,minWidth:0}}><span>{choice.label}</span>{!!choice.sameAs.length&&<span style={{display:'block',fontSize:10,color:'#94a3b8'}}>与{choice.sameAs.join('、')}相同</span>}{choices.some(other=>other!==choice&&other.content===choice.content)&&<span style={{display:'block',fontSize:10,color:'#94a3b8'}}>正文相同、来源不同</span>}</span>
            {displayed&&<span style={{color:'#7dd3fc',fontSize:10}}>显示</span>}
          </button>;
        })}
      </div>
      <button type="button" style={{...actionStyle,marginTop:8}} onClick={()=>onNavigate({select:'freeze'},markerRef.current)}>固定查看此正文</button>
      {(navigation.back!==undefined||navigation.forward!==undefined)&&<div style={{display:'flex',justifyContent:'space-between',marginTop:8}}>
        <button type="button" aria-label={`版本后退 ${messageId}`} title="返回上一个阅览版本" disabled={navigation.back===undefined} onClick={()=>onNavigate('back',markerRef.current)} style={{...actionStyle,display:'inline-flex',opacity:navigation.back===undefined?0.4:1}}><HistoryArrowIcon direction="back"/></button>
        <button type="button" aria-label={`版本前进 ${messageId}`} title="前进到下一个阅览版本" disabled={navigation.forward===undefined} onClick={()=>onNavigate('forward',markerRef.current)} style={{...actionStyle,display:'inline-flex',opacity:navigation.forward===undefined?0.4:1}}><HistoryArrowIcon direction="forward"/></button>
      </div>}
    </div>,document.body)}
  </span>;
}
