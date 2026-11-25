import {createContext,useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {api} from '../api';
import type {ReviewDetail} from '../api/client';
import {applyReviewSnapshots,recordsForReview} from '../utils/reviewRecords';
import type {WorkbenchSnapshot} from '@gonglun/core';
import {useOptionalAuth} from '../context/AuthContext';

/** One active case owns its data; cached canvases must not keep background pollers. */
export function useReviewDetail(messageId?:string,revision?:number,previewPages?:WorkbenchSnapshot[]){
  const viewerId=useOptionalAuth()?.user?.id;
  const key=messageId?JSON.stringify([viewerId??null,messageId,revision??'current']):null;
  const [state,setState]=useState<{key:string;detail:ReviewDetail}|null>(null);
  const [error,setError]=useState('');
  const generation=useRef(0),active=useRef<{key:string;controller:AbortController}>();
  const lastSummary=useRef('');
  const refresh=useCallback(async()=>{
    if(!messageId||!key||active.current?.key!==key||active.current.controller.signal.aborted)return;
    const controller=active.current.controller,version=++generation.current;
    const value=await api.getReview(messageId,controller.signal,revision);
    if(controller.signal.aborted)return;
    if(version!==generation.current)return value;
    setState(previous=>{
      if(previous?.key!==key)return {key,detail:value};
      const before=previous.detail;
      if(JSON.stringify(before)===JSON.stringify(value))return previous;
      return {key,detail:{...value,
        records:JSON.stringify(before.records)===JSON.stringify(value.records)?before.records:value.records,
        target:JSON.stringify(before.target)===JSON.stringify(value.target)?before.target:value.target,
      }};
    });
    setError('');
    const summary=JSON.stringify(value.summary);
    if(summary!==lastSummary.current){
      lastSummary.current=summary;
      window.dispatchEvent(new CustomEvent('review-summary',{detail:{messageId,summary:value.summary}}));
    }
    return value;
  },[messageId,revision,key]);
  useLayoutEffect(()=>{
    if(!messageId||!key)return;
    const controller=new AbortController();active.current={key,controller};lastSummary.current='';setError('');
    const load=()=>void refresh().catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    const changed=(event:Event)=>{if((event as CustomEvent).detail?.messageId===messageId)load();};
    const committed=(event:Event)=>{
      const pages=(event as CustomEvent<WorkbenchSnapshot[]>).detail;
      if(Array.isArray(pages))setState(previous=>previous?.key===key?{...previous,detail:applyReviewSnapshots(previous.detail,pages)}:previous);
      load();
    };
    load();const timer=setInterval(load,15000);
    window.addEventListener('review-refresh',changed);
    window.addEventListener('gonglun:committed',committed);
    return()=>{controller.abort();generation.current++;clearInterval(timer);window.removeEventListener('review-refresh',changed);window.removeEventListener('gonglun:committed',committed);};
  },[messageId,refresh]);
  const currentDetail=state?.key===key?state.detail:null;
  const detail=useMemo(()=>currentDetail&&previewPages?applyReviewSnapshots(currentDetail,previewPages):currentDetail,[currentDetail,previewPages]);
  const target=detail?.target;
  const records=useMemo(()=>detail?recordsForReview(detail.records,detail.summary,new Set(detail.records.map(record=>record.id))):[],[detail?.records,detail?.summary.caseId,detail?.summary.messageId,detail?.summary.revision]);
  return useMemo(()=>({messageId,revision,detail,error,refresh,records,target}),[messageId,revision,detail,error,refresh,records,target]);
}

export const ReviewDetailContext=createContext<ReturnType<typeof useReviewDetail>|null>(null);
