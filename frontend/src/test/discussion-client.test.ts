import { expect, it, vi } from 'vitest';
import type { WorkbenchSnapshot } from '@gonglun/core';
import { createDiscussionClient } from '../data/discussionClient';

const user = {id:'u',username:'读者',createdAt:''};
function snapshot(id='focus', nextCursor: string | null = null): WorkbenchSnapshot {
  return { sequence:1,regionId:'region',scope:{messageId:null,title:'当前讨论'},messages:[{id,revision:1,kind:'TEXT',contentType:'TEXT',content:id,
    parts:[{id:'body',type:'text',text:id}],createdAt:'',createdBy:user}],relations:[],users:[user],stakes:{},tagCounts:{},attentionUsers:{},
    discussion:{focusId:id,pageIds:[],nextCursor,memberCounts:{}} };
}
const setup = () => {
  const load=vi.fn().mockResolvedValue(snapshot()),publish=vi.fn(),status=vi.fn();
  return {load,publish,status,client:createDiscussionClient('focus',{load,publish,status,username:user.username})};
};
it('fetches one bounded window, deduplicates selection changes and avoids redraws for unrelated updates',async()=>{
  const t=setup(); t.load.mockResolvedValueOnce(snapshot('focus','old-watermark'));
  await t.client.select({classificationId:null});
  expect(t.load).toHaveBeenCalledOnce(); expect(t.publish).toHaveBeenCalledOnce();
  await t.client.select({classificationId:null,pinnedIds:['focus'],viewMode:'graph'});
  expect(t.load).toHaveBeenCalledOnce();
  t.load.mockResolvedValue({...snapshot('focus','new-watermark'),sequence:30});
  await t.client.refresh();
  expect(t.client.sequence).toBe(30); expect(t.publish).toHaveBeenCalledOnce();
  await t.client.turn(1);
  expect(t.load.mock.calls.at(-1)![0].cursor).toBe('new-watermark');
  t.client.stop();
});
it('replaces pages, keeps a failed page readable and retries the same next cursor',async()=>{
  const t=setup(); t.load.mockResolvedValueOnce(snapshot('focus','next-page'));
  await t.client.select({classificationId:null});
  t.load.mockRejectedValueOnce(new Error('网络中断'));
  await expect(t.client.turn(1)).rejects.toThrow('网络中断');
  expect(t.publish).toHaveBeenCalledOnce();
  t.load.mockResolvedValueOnce(snapshot('second'));
  await t.client.turn(1);
  expect(t.load.mock.calls.at(-1)![0].cursor).toBe('next-page');
  expect(t.publish.mock.calls.at(-1)![0].snapshot.messages.map((row:{id:string})=>row.id)).toEqual(['second']);
  t.load.mockResolvedValueOnce(snapshot('focus','next-page'));
  await t.client.turn(-1);
  expect(t.load.mock.calls.at(-1)![0].cursor).toBeUndefined();
  expect(t.status.mock.calls.at(-1)![0].page).toBe(1);
});
it('aborts navigation and ignores late responses, including after disposal',async()=>{
  const t=setup(); let release!:(value:WorkbenchSnapshot)=>void;
  t.load.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const first=t.client.select({classificationId:null});
  await t.client.ensure(['remote']);
  expect(t.load.mock.calls[0]![1].aborted).toBe(true);
  release(snapshot('stale')); await first;
  expect(t.publish).toHaveBeenCalledOnce();
  t.load.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const next=t.client.select({classificationId:'another'});
  t.client.stop(); release(snapshot('late')); await next;
  expect(t.publish).toHaveBeenCalledOnce();
});
it('reports revoked access and retries a failed category without reusing an unrelated page cursor',async()=>{
  const t=setup(); t.load.mockResolvedValueOnce(snapshot('focus','page-two'));
  await t.client.select({classificationId:null});
  t.load.mockRejectedValueOnce(Object.assign(new Error('权限已变化'),{status:403}));
  await expect(t.client.select({classificationId:'private'})).rejects.toThrow('权限已变化');
  expect(t.status.mock.calls.at(-1)![0].restricted).toBe(true);
  t.load.mockResolvedValueOnce(snapshot('private'));
  await t.client.refresh();
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({classificationId:'private',cursor:undefined});
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
it('selects an already loaded second-page card without fetching or rewinding its page',async()=>{
  const t=setup();t.load.mockResolvedValueOnce(snapshot('first','second-page'));
  await t.client.select({classificationId:null});
  t.load.mockResolvedValueOnce(snapshot('second','third-page'));
  await t.client.turn(1);
  await t.client.select({classificationId:null,pinnedIds:['second']});
  expect(t.load).toHaveBeenCalledTimes(2);
  expect(t.status.mock.calls.at(-1)![0].page).toBe(2);
  t.load.mockResolvedValueOnce(snapshot('third'));
  await t.client.turn(1);
  expect(t.load.mock.calls.at(-1)![0]).toMatchObject({cursor:'third-page',extraIds:['second']});
  expect(t.status.mock.calls.at(-1)![0].page).toBe(3);
});
