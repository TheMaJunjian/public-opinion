import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isRelationView, type ModerationSummary } from '@gonglun/core';
import { api } from '../api';
import { convertMessagesToDemoModel, type DemoMessage } from '../utils/modelBridge';
import { projectReviewVoteDecorations, reviewVoteLoadLabels, reviewVoteWindow, type ReviewVoteWindow, type ReviewVoteGroup } from '../utils/reviewRecords';

type Scope=Parameters<typeof projectReviewVoteDecorations>[1];
type VoteDetail={state:'loading'|'error'}|{state:'ready';groups:ReviewVoteGroup[];window?:ReviewVoteWindow;records:DemoMessage[]};

function hasRecordedVotes(summary:ModerationSummary){
  if(summary.reviewerCount>0)return true;
  // The reviewer count resets on appeal. Funded votes from earlier rounds still have public records.
  return (summary.round??1)>1 && (summary.selfPass===undefined || summary.selfReject===undefined
    || summary.pass>summary.selfPass || summary.reject>summary.selfReject);
}

/** A regular canvas gets the case ledger only when its decoration control is opened. */
export function useReviewVoteDecorations(messages:DemoMessage[],scope:Scope,online:boolean,viewerId?:string,sequence?:number|null){
  const projected=useMemo(()=>projectReviewVoteDecorations(messages,scope),[messages,scope]);
  const requests=useMemo(()=>{
    const map=new Map<string,{key:string;revision:number}>();
    if(online&&!scope)for(const {id,revision,restricted,moderation:m} of messages){
      if(m?.messageId===id&&hasRecordedVotes(m)){
        map.set(id,{revision:m.revision,key:JSON.stringify([viewerId,id,m.caseId,m.revision,m.round,m.reviewerCount,
          m.pass,m.reject,m.status,m.finalized,m.releaseAt,!!restricted])});
      }else if(!m&&projected.groups.has(id)){
        // Older snapshots can carry a vote and its address without the case summary.
        const versions=new Set(projected.groups.get(id)!.flatMap(group=>group.votes.map(vote=>vote.targetRevision)));
        const pinned=revision??(versions.size===1?[...versions][0]:undefined);
        if(pinned)map.set(id,{revision:pinned,key:JSON.stringify([viewerId,id,pinned,sequence])});
      }
    }
    return map;
  },[messages,online,scope,viewerId,sequence,projected.groups]);
  const [details,setDetails]=useState(()=>new Map<string,VoteDetail>());
  const pending=useRef(new Map<string,AbortController>());
  useEffect(()=>{
    const valid=new Set([...requests.values()].map(request=>request.key));
    for(const [key,controller] of pending.current)if(!valid.has(key)){controller.abort();pending.current.delete(key);}
    setDetails(previous=>[...previous.keys()].some(key=>!valid.has(key))?new Map([...previous].filter(([key])=>valid.has(key))):previous);
  },[requests]);
  useEffect(()=>()=>{for(const controller of pending.current.values())controller.abort();pending.current.clear();},[]);
  const onExpandDecorations=useCallback((id:string)=>{
    const request=requests.get(id);
    if(!request||pending.current.has(request.key)||details.get(request.key)?.state==='ready')return;
    const {key,revision}=request,controller=new AbortController();
    pending.current.set(key,controller);
    setDetails(previous=>new Map(previous).set(key,{state:'loading'}));
    void api.getReview(id,controller.signal,revision).then(detail=>{
      if(controller.signal.aborted)return;
      if(detail.summary.messageId!==id||detail.summary.revision!==revision)throw new Error('审核版本已变更');
      const records=convertMessagesToDemoModel(detail.records,detail.records.filter(isRelationView)).messages;
      const groups=projectReviewVoteDecorations(records).groups.get(id)??[];
      const voteIds=new Set(groups.flatMap(group=>group.votes.map(vote=>vote.id)));
      setDetails(previous=>new Map(previous).set(key,{state:'ready',groups,window:reviewVoteWindow(detail),records:records.filter(record=>voteIds.has(record.id))}));
    }).catch(()=>{
      if(!controller.signal.aborted)setDetails(previous=>new Map(previous).set(key,{state:'error'}));
    }).finally(()=>{if(pending.current.get(key)===controller)pending.current.delete(key);});
  },[requests,details]);
  const {groups,hints,windows,records}=useMemo(()=>{
    const groups=new Map(projected.groups),hints=new Map<string,string>(),windows=new Map<string,ReviewVoteWindow>();
    const records=new Map<string,DemoMessage>();
    for(const [id,{key}] of requests){
      const detail=details.get(key);
      if(detail?.state==='ready'){
        for(const record of detail.records)records.set(record.id,record);
        if(detail.window)windows.set(id,detail.window);
        if(detail.groups.length)groups.set(id,detail.groups);else groups.delete(id);
      }else if(!groups.has(id)){
        hints.set(id,reviewVoteLoadLabels[detail?.state??'idle']);
      }
    }
    return {groups,hints,windows,records};
  },[projected.groups,requests,details]);
  return {reviewVoteGroups:groups,reviewVoteHints:hints,voteWindows:windows,voteModels:records,voteIds:projected.voteIds,onExpandDecorations};
}
