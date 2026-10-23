import {migratePendingSends} from './browser-state.js';
import {migrateViewFile} from './migrate-view-file.js';
const status=document.getElementById('result')!;
document.getElementById('cache')!.addEventListener('click',()=>{
  try{status.textContent=`已迁移 ${migratePendingSends(sessionStorage,location.origin)} 条待确认记录；未发送任何请求。`;}
  catch(error){status.textContent=error instanceof Error?error.message:String(error);}
});
document.getElementById('archive')!.addEventListener('change',async event=>{
  const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;
  try{
    const result=migrateViewFile(JSON.parse(await file.text()));
    const url=URL.createObjectURL(new Blob([JSON.stringify(result)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=file.name.replace(/\.json$/i,'')+'-新版.json';link.click();URL.revokeObjectURL(url);
    status.textContent='新版阅览文件已生成，原文件已保留。';
  }catch(error){status.textContent=error instanceof Error?error.message:String(error);}
});
