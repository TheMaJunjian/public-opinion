import {useState} from 'react';
import type {RelatedMessage} from '../utils/relatedMessages';
import {getPresentationSpec,getRelationTitle} from '../types';
import MessageElement from './MessageElement';
import {messageTypeReference,isMessageElementSelected} from '../utils/messageElementSelection';
import type {UnitSelection} from '../utils/modelBridge';

/** Rejected containers remain selectable without occupying an independent card. */
export default function RelatedMessages({rows=[],onNavigate,selectedUnits}:{rows?:RelatedMessage[];onNavigate?:(id:string)=>void;selectedUnits?:readonly UnitSelection[]}) {
 const [limit,setLimit]=useState(5);
 const [expanded,setExpanded]=useState(false);
 if(!rows.length)return null;
 return <div data-related-rejected-containers style={{marginTop:5,fontSize:11,color:'#fca5a5'}} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>
  <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)} style={{color:'inherit',background:'none',border:0,cursor:'pointer',padding:0,fontSize:'inherit'}}>{expanded?'▾':'▸'} 被反对的容器：{rows.length}</button>
  {expanded&&<div style={{display:'flex',flexDirection:'column',gap:4,marginTop:3}}>{rows.slice(0,limit).map(({message})=>{
   const type=getPresentationSpec(message.relationType??'classify').label,title=getRelationTitle(message.relationPayload)||message.content||message.id;
   const reference=messageTypeReference(message)??{messageId:message.id,revision:message.revision};
   return <div key={message.id} data-related-message-id={message.id} style={{border:'1px solid #7f1d1d',borderRadius:4,padding:'2px 5px',overflowWrap:'anywhere'}}>
    <MessageElement reference={reference} selected={isMessageElementSelected(selectedUnits,reference)} label={`被反对的${type}消息部件`}>{type} · {title}</MessageElement>{' '}
    <button type="button" onClick={()=>onNavigate?.(message.id)} title={`查看容器消息 ${message.id}`} style={{color:'#a5b4fc',background:'none',border:0,cursor:'pointer',fontSize:10}}>查看</button>
   </div>;
  })}{rows.length>limit&&<button type="button" onClick={()=>setLimit(limit+5)}>显示更多容器</button>}</div>}
 </div>;
}
