import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { markNotificationsSeen } from '../api/client';
import { refreshNotifications } from '../data/notifications';

interface Options {
  ready:boolean;
  navigate:(id:string,options:{select:false;onComplete:(located:boolean,cancelled?:boolean)=>void})=>void;
  openSettlement:(id:string,type:'TRUTH'|'VALUE')=>void;
  onError:(message:string)=>void;
  onLocated?:(sourceId:string,targetId:string|null)=>void;
}
export function useNotificationNavigation(options:Options) {
  const [params,setParams]=useSearchParams();
  const active=useRef<string|null>(null),current=useRef(options);current.current=options;
  const request=params.get('notification'),source=params.get('notificationSource'),round=params.get('notificationRound');
  const target=params.get('notificationTarget'),type=params.get('notificationSettlement');
  const nonce=params.get('notificationRequest');
  useEffect(()=>{
    const id=Number(request),key=JSON.stringify([request,source,nonce]);
    if(!request||!source){active.current=null;return;}
    if(!options.ready||!Number.isSafeInteger(id)||id<=0||active.current===key)return;
    active.current=key;
    current.current.navigate(round&&target?target:source,{select:false,onComplete:(located,cancelled)=>{
      if(active.current!==key||cancelled)return;
      if(!located){current.current.onError('尚未定位到通知消息，通知保留未查看状态，可重新打开重试');return;}
      current.current.onLocated?.(source,target);
      if(round&&target){sessionStorage.setItem('settlementHighlightRound',round);current.current.openSettlement(target,type==='VALUE'?'VALUE':'TRUTH');}
      void markNotificationsSeen({through:id,ids:[id]}).then(refreshNotifications).catch(error=>current.current.onError(error instanceof Error?error.message:'通知查看状态保存失败，请在通知面板重试'));
      setParams(previous=>{
        if(previous.get('notification')!==request||previous.get('notificationRequest')!==nonce)return previous;
        const next=new URLSearchParams(previous);
        for(const key of [...next.keys()])if(key.startsWith('notification'))next.delete(key);
        return next;
      },{replace:true});
    }});
  },[request,source,target,round,type,nonce,options.ready,setParams]);
  useEffect(()=>()=>{active.current=null;},[]);
}
