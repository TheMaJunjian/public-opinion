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
