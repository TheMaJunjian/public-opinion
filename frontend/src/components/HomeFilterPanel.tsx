import {useEffect,useRef,useState} from 'react';

import {normalizeHomeFilter,type HomeFilterMode,type HomeFilterSelection} from '../pages/workbench/model/homeFilter';
export type {HomeFilterMode,HomeFilterSelection} from '../pages/workbench/model/homeFilter';
const scopes=[['all','全部'],['self','自发'],['related','与我相关'],['following','关注']] as const;
const statuses=[['all','全部'],['pending','待阅或有新提醒'],['confirmed','已阅且无新提醒']] as const;
export default function HomeFilterPanel({mode,onChange}:{mode:HomeFilterMode|null;onChange:(mode:HomeFilterMode|null)=>void}) {
  const [open,setOpen]=useState(false),ref=useRef<HTMLDivElement>(null),selected=normalizeHomeFilter(mode);
  const active=selected.scope!=='all'||selected.status!=='all';
  useEffect(()=>{
    if(!open)return;
    const close=(event:MouseEvent)=>{if(!ref.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close);
  },[open]);
  const update=(change:Partial<HomeFilterSelection>)=>{
    const next={...selected,...change};onChange(next.scope==='all'&&next.status==='all'?null:next);
  };
  return <div ref={ref} style={{position:'relative',flexShrink:0}}>
    <button type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}
      title={active?'主页过滤中':'主页：按消息范围和查看状态筛选'}
      style={{padding:'3px 9px',borderRadius:4,border:`1px solid ${active?'#22d3ee':'#666'}`,background:active?'#087f8c':'#333',color:'#fff',fontSize:12,cursor:'pointer'}}>主页</button>
    {open&&<div style={{position:'absolute',top:'100%',right:0,marginTop:4,width:280,padding:12,background:'#17202b',border:'1px solid #3b5368',borderRadius:6,boxShadow:'0 8px 24px #0007',zIndex:100,color:'#e5e7eb',fontSize:12}}>
      <fieldset style={{border:0,padding:0,margin:0}}><legend style={{marginBottom:8,color:'#94a3b8'}}>消息范围</legend>
        <div style={{display:'flex',flexWrap:'wrap',gap:10}}>{scopes.map(([value,label])=><label key={value} style={{cursor:'pointer'}}>
          <input type="radio" name="home-scope" checked={selected.scope===value} onChange={()=>update({scope:value})} /> {label}
        </label>)}</div>
      </fieldset>
      <fieldset style={{border:0,padding:0,margin:'14px 0 0'}}><legend style={{marginBottom:8,color:'#94a3b8'}}>查看状态</legend>
        <div style={{display:'flex',flexWrap:'wrap',gap:12}}>{statuses.map(([value,label])=><label key={value} style={{cursor:'pointer'}}>
          <input type="radio" name="home-status" checked={selected.status===value} onChange={()=>update({status:value})} /> {label}
        </label>)}</div>
      </fieldset>
      <div style={{marginTop:12,paddingTop:8,borderTop:'1px solid #334155',color:'#94a3b8',fontSize:11,lineHeight:1.6}}>
        待阅包括尚未确认的正文或具体影响。<br/>已确认表示当前正文及需确认的影响均已处理。
      </div>
    </div>}
  </div>;
}
