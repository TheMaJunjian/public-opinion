import { useEffect, useState } from 'react';
import { getNotificationRecipients } from '../api/client';

export function useNotificationRecipients(enabled:boolean,owner:string|undefined,ids:string[]) {
  const key=JSON.stringify([...new Set(ids)].sort());
  const [state,setState]=useState<{key:string;users:Array<{id:string;username:string}>;loading:boolean;error:string|null}>({key:'',users:[],loading:false,error:null});
  useEffect(()=>{
    if(!enabled||!owner||!ids.length)return;
    const abort=new AbortController();
    setState({key,users:[],loading:true,error:null});
    const timer=setTimeout(()=>{
      getNotificationRecipients(JSON.parse(key),abort.signal).then(result=>{if(!abort.signal.aborted)setState({key,users:result.users,loading:false,error:null});})
        .catch(error=>{if(!abort.signal.aborted)setState({key,users:[],loading:false,error:error instanceof Error?error.message:'接收者加载失败'});});
    },150);
    return()=>{abort.abort();clearTimeout(timer);};
  },[key,owner,enabled]);
  return !enabled||!ids.length?{users:[],loading:false,error:null}:state.key===key?state:{users:[],loading:true,error:null};
}
