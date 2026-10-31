import { useMemo, useState } from 'react';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { getPresentationSpec } from '../types';
import { getMessageCardContent, getMessageTypeLabel } from '../utils/messageDisplay';
import MessageReferenceControl from './MessageReferenceControl';

interface Props {
  messageId:string; messages:DemoMessage[]; edges:DemoEdge[]; disabled?:boolean;
  getMessageSummary?:(id:string)=>string; onNavigate:(id:string)=>void;
}
type Connection={edge:DemoEdge;otherId:string;summary?:string};

function ConnectionLists({messageId,messages,edges,disabled,getMessageSummary,onNavigate}:Props){
  const {outgoing,incoming,byId}=useMemo(()=>{
    const byId=new Map(messages.map(message=>[message.id,message]));
    const outgoing:Connection[]=[],incoming:Connection[]=[],seen=new Set<string>();
    const add=(direction:'out'|'in',edge:DemoEdge,otherId:string)=>{
      if(otherId===messageId||otherId.startsWith('anon:'))return;
      const key=JSON.stringify([direction,edge.relationMessageId,otherId]);if(seen.has(key))return;seen.add(key);
      (direction==='out'?outgoing:incoming).push({edge,otherId,
        summary:direction==='out'&&edge.to.selection.kind==='text'?`片段：${edge.to.selection.text}`:undefined});
    };
    for(const edge of edges){
      if(edge.relationType==='read'||edge.relationType==='unread')continue;
      // A relation record points to its targets; its declared source is context.
      if(edge.from.messageId===messageId||edge.relationMessageId===messageId)add('out',edge,edge.to.messageId);
      if(edge.to.messageId===messageId)add('in',edge,edge.from.messageId.startsWith('anon:')?edge.relationMessageId:edge.from.messageId);
    }
    return {outgoing,incoming,byId};
  },[messageId,messages,edges]);
  return <div style={{display:'grid',gap:8,marginTop:8}}>
    <div style={{fontSize:11,color:'var(--ink-94a3b8)'}}>展示连接方向；当前是否生效可查看消息与影响。</div>
    {([{title:'本消息指向',description:'这条消息引用、回应或关联的对象。',rows:outgoing},
      {title:'指向本消息',description:'引用、回应或评价这条消息的消息。',rows:incoming}] as const).map(group=><section key={group.title} aria-label={group.title} style={{padding:8,border:'1px solid var(--line-444)',borderRadius:4}}>
      <strong>{group.title} · {group.rows.length} 条关联</strong>
      <div style={{fontSize:11,color:'var(--ink-94a3b8)',margin:'4px 0'}}>{group.description}</div>
      {!group.rows.length?<div style={{color:'var(--ink-94a3b8)'}}>暂无这类关联</div>:<ul style={{listStyle:'none',padding:0,margin:0,maxHeight:180,overflow:'auto'}}>
        {group.rows.map(({edge,otherId,summary})=>{
          const text=(summary??getMessageSummary?.(otherId)??getMessageCardContent(byId.get(otherId)))||otherId;
          const relation=byId.get(edge.relationMessageId);
          const type=getMessageTypeLabel(byId.get(otherId));
          const relationType=relation?getMessageTypeLabel(relation):getPresentationSpec(edge.relationType).label;
          return <li key={`${edge.relationMessageId}:${otherId}`} style={{display:'flex',gap:6,alignItems:'baseline',padding:'4px 0'}}>
            <MessageReferenceControl messageId={otherId} type={type} summary={text} initialView="summary" disabled={disabled} onNavigate={onNavigate}
              navigateLabel={`阅读关联消息 ${otherId}`} wholeMessage={false} style={{flex:1,minWidth:0}}/>
            {edge.relationMessageId!==messageId&&edge.relationMessageId!==otherId&&<button type="button" disabled={disabled} aria-label={`查看关联记录 ${edge.relationMessageId}`} title={`查看${relationType}消息`} onClick={()=>onNavigate(edge.relationMessageId)}
              style={{flexShrink:0,border:0,padding:0,background:'transparent',color:'var(--ink-94a3b8)',font:'inherit',cursor:'pointer'}}>关系记录</button>}
          </li>;
        })}
      </ul>}
    </section>)}
  </div>;
}

/** Direction is available on demand beside the current message, separate from reading progress. */
export default function MessageConnections(props:Props){
  const [open,setOpen]=useState(false);
  return <details data-message-connections={props.messageId} onToggle={event=>setOpen(event.currentTarget.open)} style={{marginTop:8,fontSize:12}}>
    <summary style={{cursor:'pointer'}}>关联方向</summary>
    {open&&<ConnectionLists {...props}/>}
  </details>;
}
