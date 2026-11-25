import { expect, it, vi } from 'vitest';
import type { DiscussionQuery, WorkbenchSnapshot } from '@gonglun/core';
import { createDiscussionClient } from '../data/discussionClient';

const user = {id:'u',username:'读者',createdAt:''};
const message = (id: string) => ({id,revision:1,kind:'TEXT',contentType:'TEXT' as const,content:id,
  parts:[{id:'body',type:'text' as const,text:id}],createdAt:'',createdBy:user});
function snapshot(ids: string[] = [], nextCursor: string | null = null, cursor = 'head', focusId = 'focus'): WorkbenchSnapshot {
  return {sequence:1,regionId:'region',scope:{messageId:null,title:'当前讨论'},messages:[...new Set([focusId,...ids])].map(message),
    relations:[],users:[user],stakes:{},tagCounts:{},attentionUsers:{},
    discussion:{focusId,pageIds:ids,nextCursor,cursor,memberCounts:{}}};
}
const setup = () => {
  const windows = new Map<string, WorkbenchSnapshot>([['latest',snapshot()],['head',snapshot()]]);
  const load=vi.fn<(query: DiscussionQuery, signal: AbortSignal) => Promise<WorkbenchSnapshot>>(async query => windows.get(query.cursor ?? 'latest') ?? snapshot([],null,'head',query.focusId));
  const publish=vi.fn(),status=vi.fn();
  return {windows,load,publish,status,client:createDiscussionClient('focus',{load,publish,status,username:user.username})};
};
const ids = (t: ReturnType<typeof setup>) => t.publish.mock.calls.at(-1)![0].snapshot.messages.map((row:{id:string})=>row.id);

it('loads vote rows when switching to the list and drops those rows when returning to the graph',async()=>{
  const t=setup();
  t.load.mockImplementation(async query=>{
    const value=snapshot();
    if(query.includeReviewVotes)value.messages.push(message('vote-row'));
    return value;
  });
  await t.client.select({classificationId:null,viewMode:'graph'});
  await t.client.select({classificationId:null,viewMode:'list'});
  expect(ids(t)).toEqual(['focus','vote-row']);
  await t.client.select({classificationId:null,viewMode:'graph'});
  expect(ids(t)).toEqual(['focus']);
});

it('leaves the category for root paging, preserves root appends and resets the scope for a new link',async()=>{
  const t=setup();
  await t.client.select({classificationId:'category'});
  const first=snapshot(['root-first'],'root-next','root-head');
  t.windows.set('latest',first);t.windows.set('root-head',first);t.windows.set('root-next',snapshot(['root-second'],null,'root-next'));
  await t.client.select({classificationId:null});
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({classificationId:'root',cursor:undefined});
  expect(t.status.mock.calls.at(-1)![0]).toMatchObject({classificationId:'root',hasMore:true});
  await t.client.loadMore();
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({classificationId:'root',cursor:'root-next'});
  expect(ids(t)).toEqual(['focus','root-first','root-second']);
  await t.client.refresh();
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({classificationId:'root'});
  await t.client.ensure(['new-focus']);
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({focusId:'new-focus',classificationId:null});
});

it('deduplicates selection changes and advances an unchanged refresh without redrawing',async()=>{
  const t=setup(); t.windows.set('latest',snapshot(['first'],'next','old-head'));
  await t.client.select({classificationId:null});
  await t.client.select({classificationId:null,pinnedIds:['focus'],viewMode:'graph'});
  expect(t.load).toHaveBeenCalledOnce(); expect(t.publish).toHaveBeenCalledOnce();
  t.windows.set('latest',{...snapshot(['first'],'next','new-head'),sequence:30});
  t.windows.set('new-head',t.windows.get('latest')!); t.windows.set('next',snapshot(['second'],null,'next'));
  await t.client.refresh();
  expect(t.client.sequence).toBe(30); expect(t.publish).toHaveBeenCalledOnce();
  await t.client.loadMore();
  expect(t.load.mock.calls.at(-1)![0].cursor).toBe('next');
  expect(new Set(ids(t))).toEqual(new Set(['focus','first','second']));
  t.client.stop();
});

it('expands a selected context-only body once and retains expanded references across pages',async()=>{
  const t=setup(), first=snapshot(['first'],'next');
  first.messages.push(message('context'));
  first.discussion!.expandedIds=['focus','first'];
  t.windows.set('latest',first);t.windows.set('head',first);
  await t.client.select({classificationId:null});
  const expanded=snapshot(['first'],'next');
  expanded.messages.push(message('context'),message('target'));
  expanded.discussion!.expandedIds=['focus','first','context'];
  const link={...message('link'),kind:'RELATION',relationType:'REFERENCE',sourceMessageId:'context',
    content:'引用：「目标正文」',targetRefs:[{kind:'message' as const,messageId:'target'}]};
  expanded.messages.push(link);expanded.relations.push(link);
  t.windows.set('latest',expanded);t.windows.set('head',expanded);
  await t.client.select({classificationId:null,pinnedIds:['context']});
  expect(t.load).toHaveBeenCalledTimes(2);expect(ids(t)).toContain('target');
  await t.client.select({classificationId:null,pinnedIds:['context','first']});
  expect(t.load).toHaveBeenCalledTimes(2);
  const tail=snapshot(['second'],null,'next');
  tail.discussion!.expandedIds=['focus','second'];
  const backgroundLink={...link,content:'REFERENCE',targetRefs:[]};
  tail.messages.push(backgroundLink);tail.relations.push(backgroundLink);
  t.windows.set('next',tail);
  await t.client.loadMore();
  const result=t.publish.mock.calls.at(-1)![0].snapshot as WorkbenchSnapshot;
  expect(result.relations.find(row=>row.id==='link')!.targetRefs).toEqual(link.targetRefs);
  expect(result.messages.find(row=>row.id==='link')!.content).toBe(link.content);
  expect(result.discussion!.expandedIds).toEqual(expect.arrayContaining(['context','first','second']));
  const count=t.load.mock.calls.length;
  await t.client.select({classificationId:null,pinnedIds:['context','second']});
  expect(t.load).toHaveBeenCalledTimes(count);
});

it('appends replies once, retains a failed batch and retries the same cursor',async()=>{
  const t=setup(), first=snapshot(['first'],'next');
  t.windows.set('latest',first);t.windows.set('head',first);t.windows.set('next',snapshot(['first','second'],null,'next'));
  await t.client.select({classificationId:null});
  const normal=t.load.getMockImplementation()!;
  t.load.mockImplementationOnce(normal).mockRejectedValueOnce(new Error('网络中断'));
  await expect(t.client.loadMore()).rejects.toThrow('网络中断');
  expect(t.publish).toHaveBeenCalledOnce(); expect(ids(t)).toEqual(['focus','first']);
  expect(t.status.mock.calls.at(-1)![0]).toMatchObject({hasMore:true,loading:false,error:'网络中断'});
  await t.client.loadMore();
  expect(t.load.mock.calls.at(-1)![0].cursor).toBe('next');
  expect(ids(t)).toEqual(['focus','first','second']);
  expect(t.status.mock.calls.at(-1)![0]).toMatchObject({loadedCount:2,hasMore:false,expanded:true});
  const count=t.load.mock.calls.length;await t.client.loadMore();expect(t.load).toHaveBeenCalledTimes(count);
});

it('preserves every loaded reply across refresh when new replies displace the original first batch',async()=>{
  const t=setup(), first=snapshot(['first','older'],'next');
  t.windows.set('latest',first);t.windows.set('head',first);t.windows.set('next',snapshot(['second'],'third','next'));
  await t.client.select({classificationId:null});await t.client.loadMore();
  t.windows.set('latest',snapshot(['new','first'],'new-next','new-head'));
  await t.client.refresh();
  expect(new Set(ids(t))).toEqual(new Set(['focus','new','first','older','second']));
  expect(t.status.mock.calls.at(-1)![0]).toMatchObject({loadedCount:4,hasMore:true});
  expect(t.load.mock.calls.slice(-3).map(([query])=>query.cursor)).toEqual([undefined,'head','next']);
  t.windows.set('new-head',t.windows.get('latest')!);t.windows.set('third',snapshot(['third'],null,'third'));
  await t.client.loadMore();
  expect(t.load.mock.calls.at(-1)![0].cursor).toBe('third');
  expect(new Set(ids(t))).toEqual(new Set(['focus','new','first','older','second','third']));
});

it('fills the gap to retained replies when more than a page arrives before refresh',async()=>{
  const t=setup(), older=Array.from({length:20},(_,index)=>`older-${index}`), newest=Array.from({length:45},(_,index)=>`new-${index}`);
  const first=snapshot(older,'tail');
  t.windows.set('latest',first);t.windows.set('head',first);t.windows.set('tail',snapshot(['oldest'],null,'tail'));
  await t.client.select({classificationId:null});await t.client.loadMore();
  t.windows.set('latest',snapshot(newest.slice(0,20),'new-next','new-head'));
  t.windows.set('new-next',snapshot(newest.slice(20,40),'new-last','new-next'));
  t.windows.set('new-last',snapshot([...newest.slice(40),...older.slice(0,15)],'new-older','new-last'));
  await t.client.refresh();
  expect(new Set(ids(t))).toEqual(new Set(['focus',...newest,...older,'oldest']));
  expect(t.status.mock.calls.at(-1)![0]).toMatchObject({loadedCount:66,hasMore:false});
});

it('connects retained batches when changed membership displaces their original boundary',async()=>{
  const t=setup(),first=snapshot(['first','second'],'tail');
  t.windows.set('latest',first);t.windows.set('head',first);t.windows.set('tail',snapshot(['third','fourth'],'last','tail'));
  await t.client.select({classificationId:'category'});await t.client.loadMore();
  t.windows.set('head',snapshot(['moved-first','moved-second'],'gap'));
  t.windows.set('gap',snapshot(['first','second'],'tail','gap'));t.windows.set('last',snapshot(['last'],null,'last'));
  await t.client.loadMore();
  expect(new Set(ids(t))).toEqual(new Set(['focus','moved-first','moved-second','first','second','third','fourth','last']));
  expect(t.status.mock.calls.at(-1)![0]).toMatchObject({loadedCount:7,hasMore:false});
});

it('keeps the new continuation when retained batches become empty',async()=>{
  const t=setup(),first=snapshot(['first'],'tail');
  t.windows.set('latest',first);t.windows.set('head',first);t.windows.set('tail',snapshot(['last'],null,'tail'));
  await t.client.select({classificationId:'category'});await t.client.loadMore();
  t.windows.set('head',snapshot([],null));t.windows.set('tail',snapshot([],null,'tail'));
  t.windows.set('latest',snapshot(['replacement'],'replacement-next','replacement-head'));
  await t.client.refresh();
  expect(ids(t)).toEqual(['focus','replacement']);
  expect(t.status.mock.calls.at(-1)![0]).toMatchObject({loadedCount:1,hasMore:true});
});

it('revalidates old replies and removes obsolete context before publishing an append',async()=>{
  const t=setup(), first=snapshot(['first'],'next');
  first.messages.push(message('obsolete-context'));
  t.windows.set('latest',first);t.windows.set('head',first);t.windows.set('next',snapshot(['second'],null,'next'));
  await t.client.select({classificationId:null});
  const fresh=snapshot(['first'],'next');fresh.messages[1]={...message('first'),content:'正文已遮挡',parts:[]};
  t.windows.set('head',fresh);
  await t.client.loadMore();
  const result=t.publish.mock.calls.at(-1)![0].snapshot as WorkbenchSnapshot;
  expect(result.messages.find(row=>row.id==='first')?.content).toBe('正文已遮挡');
  expect(ids(t)).not.toContain('obsolete-context');
});

it('coalesces repeated load clicks, refresh and selection while an append is pending',async()=>{
  const t=setup(), first=snapshot(['first'],'next');
  t.windows.set('latest',first);t.windows.set('head',first);
  await t.client.select({classificationId:null});
  let release!:(value:WorkbenchSnapshot)=>void;const normal=t.load.getMockImplementation()!;
  t.load.mockImplementation((query,signal)=>query.cursor==='next'?new Promise(resolve=>{release=resolve;}):normal(query,signal));
  const more=t.client.loadMore();
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const duplicate=t.client.loadMore(),selection=t.client.select({classificationId:null,pinnedIds:['first']}),refresh=t.client.refresh();
  release(snapshot(['second'],null,'next'));await Promise.all([more,duplicate,refresh,selection]);
  expect(t.load.mock.calls.filter(([query])=>query.cursor==='next')).toHaveLength(1);
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.publish.mock.calls.at(-1)![0].scope.pinnedIds).toEqual(['first']);
});

it('aborts navigation and ignores late responses, including after disposal',async()=>{
  const t=setup(); let release!:(value:WorkbenchSnapshot)=>void;
  t.load.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const first=t.client.select({classificationId:null});
  await t.client.ensure(['remote']);
  expect(t.load.mock.calls[0]![1].aborted).toBe(true);
  release(snapshot(['stale'])); await first;
  expect(t.publish).toHaveBeenCalledOnce();
  t.load.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const next=t.client.select({classificationId:'another'});
  t.client.stop(); release(snapshot(['late'])); await next;
  expect(t.publish).toHaveBeenCalledOnce();
});

it('discards accumulated replies on navigation and rejects late appends from the previous discussion',async()=>{
  const t=setup(),first=snapshot(['first'],'next');t.windows.set('latest',first);t.windows.set('head',first);
  await t.client.select({classificationId:null});
  let release!:(value:WorkbenchSnapshot)=>void;
  t.load.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const more=t.client.loadMore();
  t.windows.set('latest',snapshot(['different'],null,'other-head','other'));
  await t.client.ensure(['other']);release(first);await more;
  expect(ids(t)).toEqual(['other','different']);
  expect(t.status.mock.calls.at(-1)![0]).toMatchObject({focusId:'other',expanded:false,loadedCount:1});
});

it('reports revoked access and retries a failed category without an unrelated cursor',async()=>{
  const t=setup(); t.windows.set('latest',snapshot(['first'],'next'));
  await t.client.select({classificationId:null});
  t.load.mockRejectedValueOnce(Object.assign(new Error('权限已变化'),{status:403}));
  await expect(t.client.select({classificationId:'private'})).rejects.toThrow('权限已变化');
  expect(t.status.mock.calls.at(-1)![0].restricted).toBe(true);
  t.windows.set('latest',snapshot(['private']));
  await t.client.refresh();
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({classificationId:'private',cursor:undefined});
  expect(ids(t)).not.toContain('first');
});

it('keeps the original focus after a failed jump and republishes after access is restored',async()=>{
  const t=setup(); await t.client.select({classificationId:null});
  t.load.mockRejectedValueOnce(new Error('未找到该消息'));
  await expect(t.client.ensure(['missing'])).rejects.toThrow('未找到该消息');
  await t.client.refresh();
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({focusId:'focus',extraIds:[]});
  t.load.mockRejectedValueOnce(Object.assign(new Error('权限已变化'),{status:403}));
  await expect(t.client.refresh()).rejects.toThrow('权限已变化');
  await t.client.refresh();
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.status.mock.calls.at(-1)![0].restricted).not.toBe(true);
});
