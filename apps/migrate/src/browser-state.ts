/** Standalone browser maintenance, never imported by the application. No requests are sent. */
export function migratePendingSends(storage:Storage, origin:string):number{
  const api=new URL('/api',origin).href.replace(/\/$/,'');
  const keys=Array.from({length:storage.length},(_,index)=>storage.key(index)).filter((key):key is string=>!!key&&key.startsWith('gonglun:pending-send:')&&!key.startsWith('gonglun:pending-send:v2:'));
  let count=0;
  for(const key of keys){
    const owner=key.slice('gonglun:pending-send:'.length),raw=storage.getItem(key);
    if(!raw)continue;
    const envelope=JSON.parse(raw);
    if(typeof envelope.requestId!=='string'||!Array.isArray(envelope.commands)||!envelope.commands.length)throw new Error('待确认发送记录格式无效，原记录已保留');
    const target=`gonglun:pending-send:v2:${JSON.stringify([api,owner])}`,existing=storage.getItem(target);
    if(existing&&existing!==raw)throw new Error('已有不同的待确认发送记录，原记录已保留，请先核对');
    storage.setItem(`gonglun:migration:backup:${key}`,raw);
    storage.setItem(target,raw);storage.removeItem(key);count++;
  }
  return count;
}
