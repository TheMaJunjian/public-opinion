import {Suspense,useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type MouseEvent} from 'react';
import {MessageDisplayMarker} from './LazyMessageDisplayHints';

/** Used only by staged selections and trace reading references. */
export default function MessageReferenceControl({messageId,type,summary,onNavigate,ariaLabel,navigateLabel,status,disabled=false,style,wholeMessage=true,initialView='id'}:{
  messageId:string;type:string;summary?:string;onNavigate?:(id:string)=>void;ariaLabel?:string;navigateLabel?:string;status?:string;disabled?:boolean;style?:CSSProperties;wholeMessage?:boolean;initialView?:'id'|'summary';
}){
  const [showSummary,setShowSummary]=useState(initialView==='summary'),[copyStatus,setCopyStatus]=useState('');
  const pending=useRef<ReturnType<typeof setTimeout>|null>(null);
  const latest=useRef({onNavigate,disabled});latest.current={onNavigate,disabled};
  const cancelClick=()=>{if(pending.current!==null){clearTimeout(pending.current);pending.current=null;}};
  useEffect(()=>{setShowSummary(initialView==='summary');setCopyStatus('');return cancelClick;},[messageId,initialView]);
  useLayoutEffect(()=>cancelClick,[]);
  const click=(event:MouseEvent,action:()=>void)=>{
    event.stopPropagation();cancelClick();if(disabled||event.detail>1)return;
    setCopyStatus('');
    // Keyboard activation has no competing double click.
    if(event.detail===0){action();return;}
    pending.current=setTimeout(()=>{pending.current=null;if(!latest.current.disabled)action();},500);
  };
  const copy=async(event:MouseEvent)=>{
    event.preventDefault();event.stopPropagation();cancelClick();if(disabled)return;
    try{await navigator.clipboard.writeText(messageId);setCopyStatus('已复制消息 ID');}
    catch{setCopyStatus('复制失败，请重试');}
  };
  const content=summary?.replace(/\s+/g,' ').trim()||'（暂无摘要）';
  const preview=content.length>64?`${content.slice(0,64)}…`:content;
  const label=ariaLabel??`消息 ${messageId}`;
  const button:CSSProperties={border:0,padding:0,background:'transparent',color:'inherit',font:'inherit',cursor:disabled?'default':'pointer',overflowWrap:'anywhere',textAlign:'left'};
  return <span role="group" aria-label={label} data-message-reference={messageId} style={{display:'inline',overflowWrap:'anywhere',...style}}>
    <button type="button" aria-label={ariaLabel??`切换消息 ${messageId} 的摘要和 ID`} aria-pressed={showSummary} disabled={disabled}
      title="单击切换摘要和 ID；双击复制消息 ID" onClick={event=>click(event,()=>setShowSummary(value=>!value))} onDoubleClick={copy}
      style={{...button,color:'var(--ink-a5b4fc)'}}>【{type}】</button>{' '}
    <button type="button" aria-label={navigateLabel??`跳转到${label}`} disabled={disabled||!onNavigate}
      title={`单击跳转到消息；双击复制消息 ID\n${messageId}`} onClick={event=>click(event,()=>latest.current.onNavigate?.(messageId))} onDoubleClick={copy}
      data-message-reference-value style={{...button,color:'var(--ink-bae6fd)',fontFamily:showSummary?'inherit':'monospace',textDecoration:'underline',textUnderlineOffset:2}}>{showSummary?preview:messageId}</button>
    {wholeMessage&&<Suspense fallback={null}><MessageDisplayMarker messageId={messageId} compact /></Suspense>}
    {status&&<span style={{color:'var(--ink-94a3b8)'}}> · {status}</span>}
    {copyStatus&&<span role="status" style={{color:'var(--ink-94a3b8)',marginLeft:6}}>{copyStatus}</span>}
  </span>;
}
