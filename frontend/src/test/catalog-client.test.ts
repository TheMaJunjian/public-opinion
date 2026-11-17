import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCatalogClient } from '../data/catalogClient';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createGlobalCatalogCache} from '../data/globalCatalogCache';
import {createCatalogEngine,type CatalogOptions} from '../data/catalogEngine';
import type {WorkbenchSnapshot} from '@gonglun/core';

class TestWorker {
  static latest: TestWorker;
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { TestWorker.latest = this; }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const clients: ReturnType<typeof createCatalogClient>[] = [];
function start() {
  const onReady = vi.fn(), onProgress = vi.fn();
  const client = createCatalogClient('user', 'root', { onReady, onProgress }, 'region'); clients.push(client);
  return { client, worker: TestWorker.latest, onReady, onProgress };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('Worker', TestWorker); vi.stubGlobal('requestIdleCallback', undefined); });
afterEach(() => { clients.splice(0).forEach(client => client.stop()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('rebuilds the global catalog from the server after the restricted-reference cache version changes',async()=>{
  vi.useRealTimers();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
  const {worker}=start(),options=worker.postMessage.mock.calls[0][0].options as CatalogOptions;
  const user={id:'u',username:'用户',createdAt:''};
  const message=(id:string)=>({id,kind:'TEXT',contentType:'TEXT' as const,content:id,createdBy:user,createdAt:''});
  const old:WorkbenchSnapshot={regionId:'region',sequence:10,structureOnly:true,scope:{messageId:null,title:'公论'},
    messages:[message('old')],relations:[],users:[user],stakes:{},tagCounts:{},attentionUsers:{}};
  await createGlobalCatalogCache(JSON.stringify(['structure-v4',options.baseUrl,'user','root'])).save({
    boundary:10,after:10,pages:1,phase:'changes',complete:true,nextCursor:null,snapshot:old});
  const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify({...old,sequence:20,
    messages:new URL(url).searchParams.has('after')?[]:[message('fresh')]})));
  vi.stubGlobal('fetch',fetch);
  const ready=vi.fn(),engine=createCatalogEngine(options,{idle:async()=>{},onReady:ready,onProgress:vi.fn()});
  try{
    await vi.waitFor(()=>expect(ready).toHaveBeenCalledOnce());
    expect(new URL(fetch.mock.calls[0][0]).searchParams.has('after')).toBe(false);
    expect(ready.mock.lastCall![0].index.messages.map((record:{id:string})=>record.id)).toEqual(['fresh']);
  }finally{engine.stop();}
});

it('pauses background batches while hidden, resumes with an idle budget, and prioritizes requested global features', async () => {
  let hidden = true;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const { client, worker } = start();
  expect(worker.postMessage.mock.calls[0][0]).toMatchObject({ type: 'init', options: { parent: 'root', regionId: 'region' } });
  worker.emit({ type: 'idle', id: 1 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(worker.postMessage).toHaveBeenCalledOnce();
  hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(249); expect(worker.postMessage).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'idle', id: 1 });
  worker.emit({ type: 'idle', id: 2 }); client.prioritize();
  await vi.advanceTimersByTimeAsync(1); expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'idle', id: 2 });
});

it('correlates concurrent results, reports failures, and rejects pending requests when leaving the scope', async () => {
  const { client, worker, onProgress } = start();
  const refresh = client.refresh();
  const refreshId = worker.postMessage.mock.lastCall![0].id;
  const filters = client.filters({ user: null, home: null, rules: [] });
  const filterId = worker.postMessage.mock.lastCall![0].id;
  const leaderboard = client.leaderboard();
  const leaderboardId = worker.postMessage.mock.lastCall![0].id;
  expect(worker.postMessage.mock.lastCall![0].type).toBe('leaderboard');
  worker.emit({ type: 'result', id: leaderboardId, result: { userRows: [], messageRows: [] } });
  await expect(leaderboard).resolves.toEqual({ userRows: [], messageRows: [] });
  worker.emit({ type: 'result', id: filterId, result: { clean: null, home: null } });
  await expect(filters).resolves.toEqual({ clean: null, home: null });
  worker.emit({ type: 'result', id: refreshId, result: false });
  await expect(refresh).resolves.toBe(false);
  const pending = client.refresh(); client.stop();
  await expect(pending).rejects.toThrow('已停止');
  expect(worker.terminate).toHaveBeenCalledOnce();
  worker.emit({ type: 'progress', progress: { ready: true } }); expect(onProgress).not.toHaveBeenCalled();
});

it('exposes worker startup failure and makes subsequent refreshes fail promptly', async () => {
  const { client, worker, onProgress } = start();
  const refresh = client.refresh(); worker.onerror?.();
  await expect(refresh).rejects.toThrow('请刷新重试');
  await expect(client.refresh()).rejects.toThrow('请刷新重试');
  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ ready: false, error: expect.any(String) }));
});
