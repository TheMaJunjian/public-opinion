import {createContext,useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {api} from '../api';
import type {ReviewDetail} from '../api/client';
import {applyReviewSnapshots,recordsForReview,reviewTargetPlaceholder} from '../utils/reviewRecords';
import type {WorkbenchSnapshot} from '@gonglun/core';

/** One active case owns its data; cached canvases must not keep background pollers. */
export function useReviewDetail(messageId?:string,revision?:number,previewPages?:WorkbenchSnapshot[]){
  const key=messageId?`${messageId}:${revision??'current'}`:null;
  const [state,setState]=useState<{key:string;detail:ReviewDetail}|null>(null);
  const [error,setError]=useState(''),[clock,setClock]=useState(Date.now);
  const generation=useRef(0),active=useRef<AbortController>();
  const lastSummary=useRef('');
  const refresh=useCallback(async()=>{
    if(!messageId||!key||!active.current||active.current.signal.aborted)return;
    const controller=active.current,version=++generation.current;
    const value=await api.getReview(messageId,controller.signal,revision);
    if(controller.signal.aborted||version!==generation.current)return;
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
  },[messageId,revision,key]);
  useLayoutEffect(()=>{
    if(!messageId)return;
    const controller=new AbortController();active.current=controller;setError('');setClock(Date.now());
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
  // Wake only at a deadline, rather than rerendering every second.
  useLayoutEffect(()=>{
    if(!messageId||!detail)return;
    const next=[detail.assignment?.submittedAt?null:detail.assignment?.expiresAt,detail.summary.releaseAt]
      .flatMap(value=>value?[Date.parse(value)]:[]).filter(at=>at>clock).sort((a,b)=>a-b)[0];
    if(next===undefined)return;
    const timer=setTimeout(()=>setClock(Date.now()),Math.min(2147483647,Math.max(0,next-Date.now())));
    return()=>clearTimeout(timer);
  },[messageId,detail,clock]);
  const expired=!!detail?.assignment&&!detail.assignment.submittedAt&&(!!detail.assignment.revokedAt||Date.parse(detail.assignment.expiresAt)<=clock);
  const privateBody=detail?.restricted??['rejected','appeal'].includes(detail?.summary.status??'');
  const lostReadAccess=expired&&privateBody&&detail?.readableWithoutAssignment!==true;
  const records=useMemo(()=>!detail||lostReadAccess?[]:recordsForReview(detail.records,detail.summary),[detail?.records,detail?.summary.caseId,detail?.summary.messageId,detail?.summary.revision,lostReadAccess]);
  const target=useMemo(()=>detail?.target?(lostReadAccess?reviewTargetPlaceholder(detail.target):detail.target):undefined,[detail?.target,lostReadAccess]);
  return useMemo(()=>({messageId,revision,detail,error,refresh,clock,expired,lostReadAccess,records,target}),[messageId,revision,detail,error,refresh,clock,expired,lostReadAccess,records,target]);
}

export const ReviewDetailContext=createContext<ReturnType<typeof useReviewDetail>|null>(null);
