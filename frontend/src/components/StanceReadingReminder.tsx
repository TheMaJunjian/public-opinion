import {useReadingDisplayContext} from './MessageDisplayHints';

/** A reading reminder never changes selection, reading progress or send eligibility. */
export default function StanceReadingReminder({relationType,secondaryRelationType,targetIds}:{relationType:string|null;secondaryRelationType?:string;targetIds:string[]}) {
  const context=useReadingDisplayContext();
  const action=relationType==='tag'?secondaryRelationType:relationType;
  if(!context||!['agree','disagree','recommend','archive'].includes(action??''))return null;
  const pending=[...new Set(targetIds)].flatMap(id=>{
    const hint=context.data.hints.get(id);
    if(!hint)return [];
    const corrections=hint.unreadCorrectionIds??[];
    const correctionMessage=context.input.personalEffect.msgMap.get(id)?.relationType==='correct';
    return hint.unread||hint.pendingInfluences.length||corrections.length?[{id,hint,corrections,correctionMessage}]:[];
  });
  if(!pending.length)return null;
  return <aside role="note" aria-label="站队表态前阅读提示" style={{fontSize:11,color:'#fbbf24',border:'1px solid #66552b',borderRadius:4,padding:6,marginTop:5}}>
    <div>请先阅读目标消息。{pending.some(item=>(context.input.corrections.get(item.id)?.versions.length??0)>0)&&'有更正时，请查看原文和不同更正，确认更正未改变原意；针对原文的站队表态不变，若某条更正改变了原意，请前往该更正消息表达反对。'}</div>
    {pending.map(({id,hint,corrections,correctionMessage})=><div key={id} style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'baseline',marginTop:3}}>
      <button type="button" onClick={event=>context.onView(id,event,false)} style={{fontSize:11}}>查看消息 {id}</button>
      {correctionMessage&&<span>当前目标是更正消息本身</span>}
      <span>{[hint.unread?'消息待阅':'',hint.pendingInfluences.length?`${hint.pendingInfluences.length} 项影响待阅`:'',corrections.length?`${corrections.length} 条更正消息待阅`:''].filter(Boolean).join(' · ')}</span>
      {corrections.map(correctionId=><button key={correctionId} type="button" onClick={event=>context.onView(correctionId,event,true)} style={{fontSize:11}}>查看更正 {correctionId}</button>)}
    </div>)}
  </aside>;
}
