import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkbenchSnapshot } from '@gonglun/core';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';

const t=vi.hoisted(()=>({load:vi.fn(),catalog:vi.fn(),global:vi.fn(),search:'?msg=focus',events:{onmessage:null as null|((event:{data:string})=>void),onopen:null,close:vi.fn()}}));
vi.mock('react-router-dom',()=>({useLocation:()=>({pathname:'/messages',search:t.search,key:'page',state:null})}));
vi.mock('../api',()=>({api:{getDiscussionSnapshot:t.load,getWorkbenchSnapshot:t.global,subscribeChanges:()=>t.events}}));
vi.mock('../data/catalogClient',()=>({createCatalogClient:t.catalog}));
const user={id:'reader',username:'读者',createdAt:''};
const resultFor=(id='focus',content='正文',sequence=1):WorkbenchSnapshot=>({regionId:'r',sequence,scope:{messageId:null,title:'当前讨论'},
  messages:[{id,revision:1,parts:[{id:'body',type:'text',text:content}],kind:'TEXT',contentType:'TEXT',content,createdAt:'',createdBy:user}],
  relations:[],users:[user],stakes:{},tagCounts:{},attentionUsers:{},discussion:{focusId:id,pageIds:[],nextCursor:null,memberCounts:{}}});
const input={user,authLoading:false,scopeMessageId:'root',navigate:vi.fn(),viewMode:'graph' as const};
beforeEach(()=>{vi.clearAllMocks();t.load.mockResolvedValue(resultFor());t.search='?msg=focus';t.events.onmessage=null;});
afterEach(()=>{vi.useRealTimers();});

it('opens a cold message link with one scoped request and no global catalog or window synchronization',async()=>{
  const {result,unmount}=renderHook(()=>useWorkbenchData(input));
  await waitFor(()=>expect(result.current.loading).toBe(false));
  expect(result.current.messages.map(row=>row.content)).toEqual(['正文']);
  expect(t.load).toHaveBeenCalledOnce();expect(t.global).not.toHaveBeenCalled();expect(t.catalog).not.toHaveBeenCalled();
  expect(result.current.discussionPage).toMatchObject({page:1,loading:false});
  expect(result.current.viewerStructure?.has('focus')).toBe(true);
  unmount();expect(t.events.close).toHaveBeenCalled();
});

it('loads previously unknown destinations and changes classifications without downloading the catalog',async()=>{
  const {result}=renderHook(()=>useWorkbenchData(input));
  await waitFor(()=>expect(result.current.loading).toBe(false));
  t.load.mockResolvedValueOnce(resultFor('remote','跨讨论正文'));
  await act(async()=>{await result.current.ensureMessages(['remote']);});
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({focusId:'remote'});
  expect(result.current.messages.map(row=>row.content)).toEqual(['跨讨论正文']);
  t.load.mockResolvedValueOnce(resultFor('category','新分类'));
  await act(async()=>{await result.current.loadViewerScope({classificationId:'category'});});
  expect(t.load.mock.calls.at(-1)![0].classificationId).toBe('category');
  expect(result.current.messages.map(row=>row.content)).toEqual(['新分类']);
  expect(t.catalog).not.toHaveBeenCalled();
});

it('replaces account data and stops displaying an old page when its access is revoked',async()=>{
  const {result,rerender}=renderHook(props=>useWorkbenchData(props),{initialProps:input});
  await waitFor(()=>expect(result.current.loading).toBe(false));
  t.load.mockResolvedValueOnce(resultFor('focus','另一个账户的范围',2));
  rerender({...input,user:{...user,id:'other',username:'另一位'}});
  await waitFor(()=>expect(result.current.messages[0]?.content).toBe('另一个账户的范围'));
  t.load.mockRejectedValueOnce(Object.assign(new Error('该内容尚未获准传播'),{status:403}));
  await act(async()=>{await expect(result.current.refreshDiscussion()).rejects.toThrow('该内容尚未获准传播');});
  expect(result.current.loadError).toBe('该内容尚未获准传播');
  t.load.mockResolvedValueOnce(resultFor('focus','另一个账户的范围',2));
  await act(async()=>{await result.current.refreshDiscussion();});
  expect(result.current.loadError).toBeNull();
});

it('keeps the same source when an in-place navigation changes its message query',async()=>{
  const {result,rerender}=renderHook(()=>useWorkbenchData(input));
  await waitFor(()=>expect(result.current.loading).toBe(false));
  t.search='?view=graph'; rerender();
  await act(async()=>{});
  expect(t.load).toHaveBeenCalledOnce();expect(t.global).not.toHaveBeenCalled();
  t.search='?msg=remote';rerender();
  await act(async()=>{});
  expect(t.load).toHaveBeenCalledOnce();expect(t.catalog).not.toHaveBeenCalled();
});
