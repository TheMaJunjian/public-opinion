import { useMemo, useState } from 'react';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { isCardMessage, isSettlementRecord } from '../utils/modelBridge';
import { getMessageCardContent, getMessageTypeLabel } from '../utils/messageDisplay';
import MessageReferenceControl from './MessageReferenceControl';

interface Props {
  messageId:string; messages:DemoMessage[]; edges:DemoEdge[]; disabled?:boolean;
  defaultOpen?:boolean;
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
      if([edge.relationMessageId,edge.from.messageId,edge.to.messageId].some(id=>isSettlementRecord(byId.get(id))||byId.get(id)?.kind==='join'))continue;
      // Only the actual endpoints are directly connected. A selected relation
      // record does not inherit its source's connections as it would in a trace.
      const sourceId=edge.from.messageId.startsWith('anon:')?edge.relationMessageId:edge.from.messageId;
      if(sourceId===messageId)add('out',edge,edge.to.messageId);
      if(edge.to.messageId===messageId)add('in',edge,sourceId);
    }
    return {outgoing,incoming,byId};
  },[messageId,messages,edges]);
  return <div style={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:8,marginTop:8}}>
    <div style={{gridColumn:'1 / -1',fontSize:11,color:'var(--ink-94a3b8)'}}>只显示与当前消息直接相连的消息。</div>
    {([{title:'本消息指向',description:'当前消息直接指向的目标。',rows:outgoing},
      {title:'指向本消息',description:'直接指向当前消息的来源。',rows:incoming}] as const).map(group=><section key={group.title} aria-label={group.title} style={{minWidth:0,overflowWrap:'anywhere',padding:8,border:'1px solid var(--line-444)',borderRadius:4}}>
      <strong>{group.title} · {group.rows.length} 条关联</strong>
      <div style={{fontSize:11,color:'var(--ink-94a3b8)',margin:'4px 0'}}>{group.description}</div>
      {!group.rows.length?<div style={{color:'var(--ink-94a3b8)'}}>暂无这类关联</div>:<ul style={{listStyle:'none',padding:0,margin:0,maxHeight:180,overflow:'auto'}}>
        {group.rows.map(({edge,otherId,summary})=>{
          const other=byId.get(otherId),readable=summary!==undefined||isCardMessage(other);
          const type=getMessageTypeLabel(other);
          // A pure relation's generated description names its own endpoints,
          // which are another layer. Show that directly linked record's ID.
          const text=readable?(summary??getMessageSummary?.(otherId)??getMessageCardContent(other))||otherId:`${type}消息`;
          return <li key={`${edge.relationMessageId}:${otherId}`} style={{display:'flex',gap:6,alignItems:'baseline',padding:'4px 0'}}>
            <MessageReferenceControl messageId={otherId} type={type} summary={text} initialView={readable?'summary':'id'} disabled={disabled} onNavigate={onNavigate}
              navigateLabel={`阅读关联消息 ${otherId}`} wholeMessage={false} style={{flex:1,minWidth:0}}/>
          </li>;
        })}
      </ul>}
    </section>)}
  </div>;
}

/** Direction is available on demand beside the current message, separate from reading progress. */
export default function MessageConnections(props:Props){
  const [open,setOpen]=useState(props.defaultOpen??false);
  return <details open={open} data-message-connections={props.messageId} onToggle={event=>setOpen(event.currentTarget.open)} style={{marginTop:8,fontSize:12}}>
    <summary style={{cursor:'pointer'}}>关联方向</summary>
    {open&&<ConnectionLists {...props}/>}
  </details>;
}
