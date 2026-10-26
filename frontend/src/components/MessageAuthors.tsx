import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {DemoMessage} from '../utils/modelBridge';
import {bodyAuthorInvestment,messageAuthorInvestment,type AuthorContribution,type AuthorInvestment,type MessageAuthorship} from '../utils/messageAuthorship';
import {cardAuthor} from '../utils/cardWidth';
import {useMessageAuthorship} from './MessageDisplayHints';
import PopupOverlay from './PopupOverlay';
import {DIALOG_BACKDROP,dialogStyles} from './dialogStyles';

function SelfStake({messageId,investment,label}:{messageId:string;investment:AuthorInvestment;label:string}){
  const {truth,value}=investment.total;
  const initial=investment.initial,additional=investment.additional;
  const title=`${label}累计自押：真假 ${truth} 点／价值 ${value} 点（N/M）`
    +(initial?`；首次 ${initial.truth}/${initial.value}，追加 ${additional!.truth}/${additional!.value}`:'；首次投入未单独记录');
  return <span data-message-self-stake={messageId} title={title} aria-label={title}
    style={{fontSize:10,color:'#94a3b8',whiteSpace:'nowrap',fontWeight:400}}>自押 {truth}/{value}</span>;
}

export function MessageSelfStake({message,fallbackTruth=0}:{message:DemoMessage;fallbackTruth?:number}){
  return <SelfStake messageId={message.id} investment={messageAuthorInvestment(message,undefined,fallbackTruth)} label={`消息 ${message.id} 的发送者 ${message.author} `}/>;
}

function Contribution({source}:{source:AuthorContribution}){
  const {initial,additional}=source.investment;
  return <div data-author-contribution={source.message.id} style={{border:'1px solid #475569',borderRadius:4,padding:'7px 9px',marginTop:6,fontSize:12}}>
    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
      <span style={{color:'#93c5fd'}}>{source.kind==='original'?'原文':'修正文字'}</span>
      <span style={{fontFamily:'monospace',color:'#94a3b8',overflowWrap:'anywhere'}}>{source.message.id}</span>
      <span data-author-investment-details style={{display:'inline-flex',alignItems:'baseline',gap:8,whiteSpace:'nowrap'}}>
        <MessageSelfStake message={{...source.message,authorInvestment:source.investment}}/>
        <span style={{fontSize:11,color:'#94a3b8'}}>{initial?`首次 ${initial.truth}/${initial.value} · 追加 ${additional!.truth}/${additional!.value}`:'首次投入未单独记录'}</span>
      </span>
    </div>
  </div>;
}

/** One fixed-height author label; wheel changes the name without changing the message. */
export default function MessageAuthors({message,prefix='',showSelfStake=false,stakePlacement='below',fallbackTruth=0,authorship:provided}:{
  message:DemoMessage;prefix?:string;showSelfStake?:boolean;stakePlacement?:'below'|'inline';fallbackTruth?:number;authorship?:MessageAuthorship;
}){
  const authorship=useMessageAuthorship(message,fallbackTruth,provided);
  const {authors,original,hasCorrections}=authorship;
  const [selected,setSelected]=useState<string>(),[open,setOpen]=useState(false);
  const buttonRef=useRef<HTMLButtonElement>(null),contentRef=useRef<HTMLDivElement>(null);
  const index=Math.max(0,authors.findIndex(author=>author.key===selected)),current=authors[index];
  const step=(direction:number)=>setSelected(previous=>{
    const position=Math.max(0,authors.findIndex(author=>author.key===previous));
    return authors[(position+direction+authors.length)%authors.length]?.key;
  });
  useEffect(()=>{
    const button=buttonRef.current;if(!button||authors.length<2)return;
    const wheel=(event:WheelEvent)=>{if(!event.deltaY)return;event.preventDefault();event.stopPropagation();step(event.deltaY>0?1:-1);};
    button.addEventListener('wheel',wheel,{passive:false});return()=>button.removeEventListener('wheel',wheel);
  },[authors]);
  const close=()=>{setOpen(false);buttonRef.current?.focus({preventScroll:true});};
  useEffect(()=>{
    if(!open)return;
    contentRef.current?.focus({preventScroll:true});
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
    document.addEventListener('keydown',escape,true);return()=>document.removeEventListener('keydown',escape,true);
  },[open]);
  if(!current)return null;
  const showCount=hasCorrections||authors.length>1;
  const stop=(event:{stopPropagation():void})=>event.stopPropagation();
  const profile=(name:string,children:ReactNode,key:string)=><section key={key} style={{marginBottom:14}}>
    <div style={{fontWeight:700,color:'#f8fafc',fontSize:13}}>{name}</div>{children}
  </section>;
  return <span data-message-authors={message.id} style={{display:'inline-flex',flexDirection:showSelfStake&&stakePlacement==='below'?'column':'row',alignItems:stakePlacement==='inline'?'center':'flex-start',verticalAlign:'middle',minWidth:0,flexShrink:0,gap:stakePlacement==='inline'?6:2}}
    onMouseDown={stop} onMouseUp={stop} onPointerDown={stop} onClick={stop} onDoubleClick={stop} onKeyDown={stop}>
    <button ref={buttonRef} type="button" title={current.name} aria-label={`查看消息 ${message.id} 的当前正文作者：${current.name}${showCount?`，共 ${authors.length} 人`:''}`}
      aria-description={authors.length>1?'滚动切换名称，点击查看全部作者与各自投入':'点击查看作者与投入'}
      aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(true)}
      style={{display:'inline-flex',alignItems:'center',gap:4,border:0,borderRadius:3,padding:showCount?'1px 4px':0,
        background:showCount?'rgba(148,163,184,0.12)':'transparent',color:'inherit',font:'inherit',cursor:'pointer',whiteSpace:'nowrap',maxWidth:'100%'}}>
      {prefix}<span style={{display:'inline-grid',minWidth:0}}>{authors.map((author,position)=><span key={author.key} aria-hidden="true"
        style={{gridArea:'1 / 1',visibility:position===index?'visible':'hidden',overflow:'hidden',textOverflow:'ellipsis'}}>{cardAuthor(author.name,message.id)}</span>)}</span>
      {showCount&&<span aria-hidden="true" style={{fontSize:9,color:'#94a3b8'}}>✎ {authors.length}人</span>}
    </button>
    {showSelfStake&&<SelfStake messageId={message.id} investment={bodyAuthorInvestment(current)}
      label={`当前正文作者 ${current.name}（对应消息 ${[...new Set(current.contributions.map(source=>source.message.id))].join('、')}）`}/>}
    {open&&<PopupOverlay contentRef={contentRef} zIndex={10060} background={DIALOG_BACKDROP} onClick={close}
      style={{display:'flex',alignItems:'center',justifyContent:'center',padding:16,boxSizing:'border-box'}}>
      <div ref={contentRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`消息 ${message.id} 的当前正文作者`} data-message-authors-popup={message.id}
        onClick={stop} onMouseDown={stop} onMouseUp={stop} onDoubleClick={stop} onKeyDown={stop}
        style={{...dialogStyles.panel,width:'min(560px, 100%)',maxHeight:'100%',display:'flex',flexDirection:'column',minHeight:0}}>
        <div style={dialogStyles.header}>当前正文作者 · {authors.length} 人</div>
        <div style={{...dialogStyles.body,overflowY:'auto',minHeight:0}}>
          <div style={{fontSize:12,color:'#94a3b8',marginBottom:12}}>自押 N/M：该消息发送者的累计真假投入／价值投入。各条消息分别列示。</div>
          {authors.map(author=>profile(author.name,author.contributions.map(source=><Contribution key={source.message.id} source={source}/>),author.key))}
          {!original.contributes&&profile(`原消息发送者：${original.message.author}（当前正文未保留原文）`,<Contribution source={original}/>,'original-sender')}
        </div>
        <div style={dialogStyles.footer}><button type="button" data-shortcut-cancel="true" onClick={close} style={dialogStyles.button}>关闭作者详情</button></div>
      </div>
    </PopupOverlay>}
  </span>;
}
