import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { signPayloadWithPrivateJwk } from '../utils/signature';
import { fetchJsonWithDeadline, getOperations, REQUEST_TIMEOUT_MS, RequestTimeoutError, resetRequestOperations, UncertainRequestError } from '../utils/requestLifecycle';

vi.mock('../utils/signature', () => ({ signPayloadWithPrivateJwk: vi.fn(async () => 'signature') }));

beforeEach(async () => {
  vi.useFakeTimers();
  let requestId = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `test-request-${++requestId}`, subtle: { digest: async () => new Uint8Array([1, 2, 3]).buffer } });
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 'u', username: 'alice' }));
  localStorage.setItem('deviceId', 'device'); api.storePrivateKeyForUser('alice', {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ csrf: 'csrf' }))));
  await api.getSession();
});
afterEach(() => { resetRequestOperations(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('signs a rehearsal without pending-write state or uncertain-send errors',async()=>{
  const prepared=await api.prepareCommandBatch(async()=>{await api.createMessage('root',{content:'未发送草稿',stakeAmount:1});});
  expect(prepared).not.toBeNull();
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({error:'预览计算失败'}),{status:500}));vi.stubGlobal('fetch',fetcher);
  await expect(api.previewCommandBatch(prepared!,['root'])).rejects.toMatchObject({status:500,path:'/commands/preview'});
  expect(fetcher).toHaveBeenCalledOnce();expect(sessionStorage.length).toBe(0);expect(getOperations()).toEqual([]);
});

it('discards a rehearsal when the account switches during signing',async()=>{
  const prepared=await api.prepareCommandBatch(async()=>{await api.createMessage('root',{content:'旧账号草稿',stakeAmount:1});});
  vi.mocked(signPayloadWithPrivateJwk).mockImplementationOnce(async()=>{localStorage.setItem('user',JSON.stringify({id:'other',username:'other'}));return 'signature';});
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(api.previewCommandBatch(prepared!,['root'])).rejects.toMatchObject({name:'AbortError'});
  expect(fetcher).not.toHaveBeenCalled();expect(sessionStorage.length).toBe(0);
});

it('saves private viewing state with CSRF but without signing keys or a public command batch',async()=>{
  localStorage.removeItem('privateKey:device:alice');vi.mocked(signPayloadWithPrivateJwk).mockClear();
  const marks=[{messageId:'m',scope:'message' as const,key:'body',signature:'display',bodySignature:'body'}];
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({marks})));vi.stubGlobal('fetch',fetcher);
  const committed=vi.fn();
  await api.withCommandBatch(async()=>{expect(await api.markReading(marks)).toEqual({marks});},committed);
  expect(fetcher).toHaveBeenCalledOnce();
  const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toMatch(/\/ui\/reading-state$/);
  expect(options.headers).toMatchObject({'X-CSRF-Token':'csrf'});
  expect(options.headers).not.toHaveProperty('X-Signature');
  expect(committed).not.toHaveBeenCalled();expect(signPayloadWithPrivateJwk).not.toHaveBeenCalled();
});

it('rebuilds stale message caches once after a reading 404 and keeps a repeated failure visible', async () => {
  const marks = [{ messageId: 'removed-message', scope: 'message' as const, key: 'body', signature: 'display' }];
  const invalidated = vi.fn(); window.addEventListener('gonglun:invalidate-cache', invalidated);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: '消息或版本不存在' }), { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  try {
    await expect(api.markReading(marks)).rejects.toThrow('消息数据已过期，正在重新加载');
    expect(invalidated).toHaveBeenCalledOnce();
    expect(getOperations()).toEqual([]);
    // Do not keep rebuilding or hide an actual server integrity problem.
    await expect(api.markReading(marks)).rejects.toMatchObject({ status: 404, path: '/reading-state' });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(getOperations()).toMatchObject([{ label: '保存阅读状态', state: 'failed', message: '消息或版本不存在' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { window.removeEventListener('gonglun:invalidate-cache', invalidated); }
});

it('bounds a response body that never completes, even after the headers arrived', async () => {
  const json = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json })));
  const pending = fetchJsonWithDeadline('/read').catch(error => error);
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
  expect(json).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBeInstanceOf(RequestTimeoutError);
  expect(vi.getTimerCount()).toBe(0);
});

it('forwards caller cancellation through body reading and removes its deadline', async () => {
  let forwarded!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    forwarded = options.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  }));
  const controller = new AbortController();
  const pending = fetchJsonWithDeadline('/read', { signal: controller.signal }).catch(error => error);
  await Promise.resolve();
  const reason = new DOMException('cancelled', 'AbortError'); controller.abort(reason);
  expect(await pending).toBe(reason); expect(forwarded.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds signed retries, keeps an ambiguous write uncertain, and reuses its identity on a later retry', async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetcher);
  const pending = api.createRound('message', { settlementType: 'TRUTH' }).catch(error => error);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
  expect(await pending).toBeInstanceOf(UncertainRequestError);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const headers = fetcher.mock.calls.map(call => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>);
  expect(headers[1]['X-Request-Id']).toBe(headers[0]['X-Request-Id']);
  expect(headers[1]['X-Signature']).toBe(headers[0]['X-Signature']);
  expect(getOperations().at(-1)?.state).toBe('uncertain');
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ id: 'round' })));
  await api.createRound('message', { settlementType: 'TRUTH' });
  const retried = (fetcher.mock.lastCall as unknown as [string, RequestInit])[1].headers as Record<string, string>;
  expect(retried['X-Request-Id']).toBe(headers[0]['X-Request-Id']);
  expect(getOperations().some(operation => operation.state === 'uncertain')).toBe(false);
});

it('coalesces identical same-turn writes before signature preparation can yield', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetcher);
  const first = api.castVote('round', { vote: 'TRUE', amount: 2 });
  const second = api.castVote('round', { vote: 'TRUE', amount: 2 });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  finish(new Response(JSON.stringify({ id: 'vote' })));
  expect(await first).toEqual(await second); expect(fetcher).toHaveBeenCalledOnce();
});

it('retries a timed-out send with the same commands and ignores old bodies and headers during later sends', async () => {
  let finishOldBody!: (value: unknown) => void;
  const oldJson = vi.fn(() => new Promise(resolve => { finishOldBody = resolve; }));
  const lateHeadersJson = vi.fn(async () => ({ snapshots: [{ sequence: 1 }] }));
  const requests: Array<{ body: string; headers: Record<string, string>; finish: (response: Response) => void }> = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ body: String(options.body), headers: options.headers as Record<string, string>, finish: resolve });
    if (requests.length === 1) resolve({ ok: true, json: oldJson } as unknown as Response);
  })));
  const published = vi.fn(), completed = vi.fn();
  window.addEventListener('gonglun:committed', published);
  const send = () => api.withCommandBatch(async () => {
    const message = await api.createMessage('root', { content: '同一发送意图' });
    await api.createRelation('root', { relationType: 'AGREE', targetRefs: [{ kind: 'message', messageId: message.id }] });
    return message.id;
  }, completed);
  try {
    const first = send().catch(error => error);
    await vi.waitFor(() => expect(oldJson).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(await first).toMatchObject({ unknownOutcome: true });
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toBe(requests[0].body);
    const retry = send();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].body).toBe(requests[0].body);
    expect(requests[2].headers['X-Request-Id']).toBe(requests[0].headers['X-Request-Id']);
    // Even an abort-ignoring body cannot publish a receipt or end the retry's progress.
    finishOldBody({ snapshots: [{ sequence: 1 }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(published).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(getOperations()).toMatchObject([{ state: 'pending' }]);
    requests[2].finish(new Response(JSON.stringify({ snapshots: [{ sequence: 2 }] })));
    const recovered = await retry;
    expect(recovered).toBe(JSON.parse(requests[0].body).commands[0].id);
    expect(completed).toHaveBeenCalledExactlyOnceWith(2);
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0][0].detail).toEqual([{ sequence: 2 }]);
    const next = send();
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(JSON.parse(requests[3].body).requestId).not.toBe(JSON.parse(requests[0].body).requestId);
    // Old headers arriving while a fresh send is pending must not even decode their body.
    requests[1].finish({ ok: true, json: lateHeadersJson } as unknown as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateHeadersJson).not.toHaveBeenCalled();
    expect(published).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
    expect(getOperations()).toMatchObject([{ state: 'pending' }]);
    requests[3].finish(new Response(JSON.stringify({ snapshots: [{ sequence: 3 }] })));
    expect(await next).not.toBe(recovered);
    expect(published).toHaveBeenCalledTimes(2);
    expect(completed).toHaveBeenCalledTimes(2);
    expect(getOperations()).toHaveLength(0);
  } finally { window.removeEventListener('gonglun:committed', published); }
});

it('does not retry a caller-aborted read', async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const pending = api.getWorkbenchSnapshot({ parent: 'root', signal: controller.signal }).catch(error => error);
  controller.abort();
  expect(await pending).toMatchObject({ name: 'AbortError' }); expect(fetcher).toHaveBeenCalledOnce();
});

it('does not dispatch a prepared write after the signed-in account changes', async () => {
  let finish!: (signature: string) => void;
  vi.mocked(signPayloadWithPrivateJwk).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const pending = api.castVote('round', { vote: 'TRUE', amount: 2 }).catch(error => error);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  localStorage.setItem('user', JSON.stringify({ id: 'other', username: 'bob' }));
  finish('signature');
  expect(await pending).toMatchObject({ name: 'AbortError' }); expect(fetcher).not.toHaveBeenCalled();
});

it('tracks explicit message loads immediately while keeping background snapshot checks quiet', async () => {
  const page = { regionId: 'region', windowed: true, sequence: 1, scope: { messageId: null, title: 'root' },
    messages: [], relations: [], users: [], stakes: {}, tagCounts: {}, attentionUsers: {} };
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    const query = JSON.parse(String(options?.body ?? '{}'));
    if (query.ids?.length) return new Promise<Response>(resolve => { finish = resolve; });
    return new Response(JSON.stringify(page));
  }));
  const read = api.getWorkbenchSnapshot({ parent: 'root', mode: 'window', ids: ['target'] });
  expect(getOperations()).toMatchObject([{ label: '加载消息', state: 'pending' }]);
  await api.getWorkbenchSnapshot({ parent: 'root', mode: 'window', after: 1 });
  expect(getOperations()).toHaveLength(1);
  finish(new Response(JSON.stringify(page))); await read;
  expect(getOperations()).toHaveLength(0);
});

it('tracks explicit context reads and distinguishes their cancellation from a failed write', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  const controller = new AbortController();
  const read = api.getMessageContext(['target'], controller.signal).catch(error => error);
  expect(getOperations()).toMatchObject([{ label: '加载消息', state: 'pending' }]);
  controller.abort(); await read;
  expect(getOperations()).toMatchObject([{ label: '加载消息', state: 'cancelled' }]);
});

it('starts a fresh context read when the previous navigation was just cancelled', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const previous = new AbortController();
  const first = api.getMessageContext(['target'], previous.signal).catch(error => error);
  previous.abort();
  const next = new AbortController();
  const second = api.getMessageContext(['target'], next.signal).catch(error => error);
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish(new Response(JSON.stringify({ messages: [], relations: [] })));
  expect(await first).toMatchObject({ name: 'AbortError' });
  expect(await second).toEqual({ messages: [], relations: [] });
});
