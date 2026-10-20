export const REQUEST_TIMEOUT_MS = 20_000;
export const LONG_OPERATION_MS = 800;

export class RequestTimeoutError extends Error {
  constructor() { super('请求等待超时，请稍后重试'); this.name = 'RequestTimeoutError'; }
}

export class UncertainRequestError extends Error {
  readonly requestId?: string;
  constructor(cause: unknown, requestId?: string) {
    super('请求结果尚未确认，请先核对记录；重试将核对同一笔请求。', { cause });
    this.name = 'UncertainRequestError'; this.requestId = requestId;
  }
}

/** The deadline includes headers AND body decoding, even if a transport ignores abort. */
export async function fetchJsonWithDeadline<T>(url: string, options: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ response: Response; data: T }> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => {
      const reason = options.signal?.reason ?? new DOMException('请求已取消', 'AbortError');
      controller.abort(reason); reject(reason);
    };
    timer = setTimeout(() => { const error = new RequestTimeoutError(); controller.abort(error); reject(error); }, timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([interrupted, (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json().catch(error => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (response.ok) throw error;
        return { message: response.statusText };
      }) as T;
      return { response, data };
    })()]);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
  }
}

export type OperationState = 'pending' | 'confirmed' | 'failed' | 'uncertain' | 'cancelled';
export interface RequestOperation {
  id: number; owner: string; label: string; state: OperationState; startedAt: number;
  message?: string; long: boolean; quiet: boolean;
}
let nextOperation = 0;
let operations: RequestOperation[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const operationKeys = new Map<string, number>();
const publish = () => { for (const listener of listeners) listener(); };
export const subscribeOperations = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getOperations = () => operations;
export function requestOwner() {
  try { return String(JSON.parse(localStorage.getItem('user') || '{}').id || 'anonymous'); }
  catch { return 'anonymous'; }
}
function removeOperation(id: number) {
  clearTimeout(timers.get(id)); timers.delete(id);
  for (const [key, value] of operationKeys) if (value === id) operationKeys.delete(key);
  operations = operations.filter(operation => operation.id !== id); publish();
}
export function dismissOperation(id: number) {
  if (operations.some(operation => operation.id === id && operation.state === 'pending')) return;
  removeOperation(id);
}
export function beginRequestOperation(label: string, quiet = false, owner = requestOwner(), key?: string) {
  const previous = key === undefined ? undefined : operationKeys.get(key);
  if (previous !== undefined) dismissOperation(previous);
  const id = ++nextOperation;
  if (key !== undefined) operationKeys.set(key, id);
  operations = [...operations, { id, owner, label, state: 'pending', startedAt: Date.now(), long: false, quiet }]; publish();
  timers.set(id, setTimeout(() => {
    operations = operations.map(operation => operation.id === id ? { ...operation, long: true } : operation); publish();
  }, LONG_OPERATION_MS));
  return {
    finish(state: Exclude<OperationState, 'pending'>, message?: string) {
      clearTimeout(timers.get(id)); timers.delete(id);
      const entry = operations.find(operation => operation.id === id);
      if (!entry) return;
      if (state === 'confirmed' && (!entry.long || entry.quiet)) { removeOperation(id); return; }
      operations = operations.map(operation => operation.id === id ? { ...operation, state, message } : operation); publish();
      if (state === 'confirmed') timers.set(id, setTimeout(() => dismissOperation(id), 2500));
    },
  };
}

const inFlight = new Map<string, Promise<unknown>>();
export function singleRequest<T>(key: string, work: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const result = work().finally(() => { if (inFlight.get(key) === result) inFlight.delete(key); });
  inFlight.set(key, result); return result;
}

// Only hashes and request identities are persisted; bodies and credentials stay out of storage.
const IDENTITY_PREFIX = 'gonglun:request-identity:';
export function writeRequestIdentity(key: string, preferred?: string): string {
  try {
    const saved = sessionStorage.getItem(IDENTITY_PREFIX + key);
    if (saved) return saved;
  } catch { /* Deduplication still works for the current request. */ }
  const id = preferred ?? crypto.randomUUID();
  try { sessionStorage.setItem(IDENTITY_PREFIX + key, id); } catch { /* Storage is optional. */ }
  return id;
}
export function clearWriteRequestIdentity(key: string) {
  try { sessionStorage.removeItem(IDENTITY_PREFIX + key); } catch { /* Storage is optional. */ }
}

export function resetRequestOperations() {
  timers.forEach(timer => clearTimeout(timer)); timers.clear();
  operationKeys.clear();
  operations = []; publish();
}
