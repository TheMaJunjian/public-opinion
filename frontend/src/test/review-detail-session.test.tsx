import {act,renderHook,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {DEFAULT_MODERATION_POLICY} from '@gonglun/core';
import {useReviewDetail} from '../hooks/useReviewDetail';
import type {ReviewDetail} from '../api/client';

const {api,auth}=vi.hoisted(()=>({api:{getReview:vi.fn()},auth:{user:{id:'author'}}}));
vi.mock('../api',()=>({api}));
vi.mock('../context/AuthContext',()=>({useOptionalAuth:()=>auth}));

it('drops the previous account review data immediately and ignores its late response',async()=>{
  const summary={caseId:'c',messageId:'m',revision:1,status:'rejected' as const,fee:6,deposit:10,pass:10,reject:16,reviewerCount:2,releaseAt:null,finalized:true};
  const readable:ReviewDetail={summary,records:[],stakes:[],canReview:false,canAppeal:true,canSettle:false,policy:DEFAULT_MODERATION_POLICY,
    target:{id:'m',revision:1,sequence:1,kind:'TEXT',contentType:'TEXT',content:'PRIVATE-BODY',parts:[{id:'body',type:'text',text:'PRIVATE-BODY'}],
      createdBy:{id:'author',username:'作者',createdAt:''},createdAt:'',updatedAt:'',sourceMessageId:null,sourceRefs:[],targetRefs:[],relationType:null,payload:{},
      state:{messageId:'m',revision:1,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0},
      spending:{protocol:1,wager:0,recommendation:1}}};
  api.getReview.mockResolvedValueOnce(readable);
  const hook=renderHook(()=>useReviewDetail('m',1));
  await waitFor(()=>expect(hook.result.current.target?.content).toBe('PRIVATE-BODY'));
  let finishOld!:(value:ReviewDetail)=>void,finishNew!:(value:ReviewDetail)=>void;
  api.getReview.mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve;}))
    .mockImplementationOnce(()=>new Promise(resolve=>{finishNew=resolve;}));
  let pending!:Promise<ReviewDetail|undefined>;
  const refreshOld=hook.result.current.refresh;
  act(()=>{pending=refreshOld();});
  const oldSignal=api.getReview.mock.calls[1][1] as AbortSignal;
  auth.user={id:'observer'};hook.rerender();
  expect(oldSignal.aborted).toBe(true);
  expect(hook.result.current.detail).toBeNull();expect(hook.result.current.target).toBeUndefined();
  await act(async()=>{expect(await refreshOld()).toBeUndefined();});
  expect(api.getReview).toHaveBeenCalledTimes(3);
  const hidden={...readable,canAppeal:false,target:{...readable.target!,content:'',parts:[],restricted:true}};
  await act(()=>finishNew(hidden));
  await act(async()=>{finishOld(readable);await pending;});
  expect(hook.result.current.detail).toEqual(hidden);
  expect(JSON.stringify(hook.result.current)).not.toContain('PRIVATE-BODY');
});
