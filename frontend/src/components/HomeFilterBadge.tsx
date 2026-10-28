/** The same badge and explanation are used in the table, cards and container headers. */
export default function HomeFilterBadge({label,reason}:{label?:string|null;reason?:string}) {
  if(!label)return null;
  const matched=label==='命中';
  return <span data-home-filter-label={label} title={reason?`${matched?'主页命中原因':'主页显示原因'}：\n${reason}`:undefined}
    style={{display:'inline-block',fontSize:10,fontWeight:700,padding:'2px 6px',marginRight:6,borderRadius:4,
      background:matched?'#0e7490':'#374151',color:matched?'#cffafe':'#d1d5db',whiteSpace:'nowrap'}}>{label}</span>;
}
