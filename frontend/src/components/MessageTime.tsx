const timeFormat=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

export default function MessageTime({value}:{value:string}) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return null;
  return <time dateTime={date.toISOString()} title={`发送时间：${date.toLocaleString('zh-CN',{hour12:false})}`} style={{fontSize:10,color:'#94a3b8',whiteSpace:'nowrap'}}>{timeFormat.format(date)}</time>;
}
