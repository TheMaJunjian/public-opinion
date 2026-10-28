import {useCallback,useEffect,useRef,useState} from 'react';
import type {ReadingMark} from '@gonglun/core';
import {api} from '../api';
const EMPTY_MARKS:ReadingMark[]=[];

export const readingMarkId=(mark:ReadingMark)=>JSON.stringify([mark.messageId,mark.scope,mark.key,mark.eventId,mark.resultKey]);
export function useReadingState(userId:string|undefined,enabled:boolean) {
  const [state,setState]=useState<{owner?:string;marks:ReadingMark[]}>({marks:[]});
  const owner=enabled?userId:undefined,ownerRef=useRef(owner);ownerRef.current=owner;
  const [error,setError]=useState<string|null>(null);
  const [loadedOwner,setLoadedOwner]=useState<string|undefined>();
  useEffect(()=>{
    let current=true;setError(null);setLoadedOwner(undefined);
    if(!owner){setState({marks:[]});return;}
    const refresh=()=>{void api.getReadingState().then(value=>{
      if(!current)return;
      setLoadedOwner(owner);
      setError(null);setState(previous=>{
        const merged=new Map(value.marks.map(mark=>[readingMarkId(mark),mark]));
        for(const mark of previous.owner===owner?previous.marks:[]){
          const key=readingMarkId(mark),incoming=merged.get(key);
          if(!incoming||(mark.position??0)>(incoming.position??0)||(mark.position??0)===(incoming.position??0)&&(mark.updatedAt??'')>=(incoming.updatedAt??''))merged.set(key,mark);
        }
        return {owner,marks:[...merged.values()]};
      });
    }).catch(reason=>{if(current)setError(reason instanceof Error?reason.message:'阅读状态加载失败');});};
    refresh();window.addEventListener('focus',refresh);
    return()=>{current=false;window.removeEventListener('focus',refresh);};
  },[owner]);
  const markRead=useCallback(async(marks:ReadingMark[])=>{
    if(!owner)throw new Error('请登录后标记已阅');
    setError(null);
    const saved=await api.markReading(marks);
    if(ownerRef.current!==owner)return;
    setState(previous=>{
      const values=new Map((previous.owner===owner?previous.marks:[]).map(mark=>[readingMarkId(mark),mark]));
      for(const mark of saved.marks){
        const key=readingMarkId(mark),previous=values.get(key);
        if(!previous||(mark.position??0)>=(previous.position??0))values.set(key,mark);
      }
      return {owner,marks:[...values.values()]};
    });
  },[owner]);
  return {marks:state.owner===owner?state.marks:EMPTY_MARKS,markRead:owner?markRead:undefined,error,ready:!!owner&&loadedOwner===owner&&state.owner===owner};
}
