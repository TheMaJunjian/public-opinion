import type { Message, Relation, User } from '../types';
import type { WorkbenchSnapshot } from '../data/workbench';

export interface Command { id: string; method: string; path: string; body: Record<string, unknown> }
export interface CommandEnvelope { requestId: string; commands: Command[] }
export interface CommandCommit { snapshots?: WorkbenchSnapshot[]; sequence?: number }
export interface CommandBatchContext { apiBase: string }
interface CapturedContext { owner: string; api: string; key: string; user: User }
export interface PreparedCommandBatch { envelope: CommandEnvelope; context: CapturedContext }
type Batch = CommandEnvelope & { context: CapturedContext; previous: CommandEnvelope | null; failure?: Error; provisional: Map<string, Message | Relation>; preview?: boolean };
let current: Batch | null = null;
let active = false;

function currentUser(): User {
  try { return JSON.parse(localStorage.getItem('user') || '{}') as User; }
  catch { return {} as User; }
}
function captureContext(options?: CommandBatchContext): CapturedContext {
  const user = currentUser(), owner = String(user.id || 'anonymous');
  const page = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  const api = new URL(options?.apiBase ?? import.meta.env.VITE_API_BASE_URL ?? '/api', page).href.replace(/\/$/, '');
  return { owner, api, user, key: `gonglun:pending-send:v2:${JSON.stringify([api, owner])}` };
}
function assertOwner(context: CapturedContext) {
  if (String(currentUser().id || 'anonymous') !== context.owner) throw new DOMException('账户已切换，请重新操作', 'AbortError');
}
function pending(context: CapturedContext): CommandEnvelope | null {
  const raw = sessionStorage.getItem(context.key);
  if (!raw) return null;
  const value = JSON.parse(raw) as CommandEnvelope;
  if (!value || typeof value.requestId !== 'string' || !Array.isArray(value.commands) || !value.commands.length)
    throw new Error('待确认的发送记录无效，请先核对已有消息');
  sessionStorage.setItem(context.key, raw);
  return value;
}
function definiteRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('unknownOutcome' in error && error.unknownOutcome === true || 'name' in error && error.name === 'UncertainRequestError') return false;
  const status = 'status' in error ? Number(error.status) : 0;
  return status >= 400 && status < 500;
}
function semanticJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function sameIntent(a: CommandEnvelope, b: CommandEnvelope): boolean {
  const intent = (value: CommandEnvelope) => value.commands.map(({ method, path, body }) => ({ method, path, body }));
  return semanticJson(intent(a)) === semanticJson(intent(b));
}
function publishCommit(committed?: CommandCommit) {
  if (committed?.snapshots?.length) window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: committed.snapshots }));
  else window.dispatchEvent(new Event('gonglun:reload'));
  window.dispatchEvent(new Event('points-refresh'));
}
export function cancelCommandBatch(error: unknown) {
  if (current) current.failure = error instanceof Error ? error : new Error(String(error));
}
export function isPendingMessage(id: string): boolean { return current?.provisional.has(id) ?? false; }
export function isCapturingPreview() { return current?.preview === true; }

/** Capture every operation without sending, persisting a pending request, or holding the send lock. */
export async function prepareCommandBatch(work: () => Promise<unknown>, options?: CommandBatchContext, previous?: PreparedCommandBatch): Promise<PreparedCommandBatch | null> {
  if (active) throw new Error('上一条消息正在发送，请稍候');
  active = true;
  try {
    const context = captureContext(options);
    if (previous) {
      assertOwner(previous.context);
      if (previous.context.api !== context.api) throw new Error('发送环境已切换，请重新预览');
    }
    if (pending(context)) throw new Error('上一笔发送尚未确认，请先点击发送核对结果');
    const batch: Batch = { requestId: crypto.randomUUID(), commands: [], provisional: new Map(), context, previous: previous?.envelope ?? null, preview: true };
    current = batch;
    await work();
    if (batch.failure) throw batch.failure;
    assertOwner(context);
    return batch.commands.length ? { envelope: structuredClone({ requestId: batch.requestId, commands: batch.commands }), context } : null;
  } finally { current = null; active = false; }
}

/** Confirm the very same identities and bodies that were rehearsed. */
export async function commitPreparedBatch(prepared: PreparedCommandBatch, commit: (input: CommandEnvelope) => Promise<CommandCommit>) {
  if (active) throw new Error('上一条消息正在发送，请稍候');
  active = true;
  const { context, envelope } = prepared;
  try {
    assertOwner(context);
    const previous = pending(context);
    if (previous && JSON.stringify(previous) !== JSON.stringify(envelope)) throw new Error('请先核对上一笔尚未确认的发送');
    sessionStorage.setItem(context.key, JSON.stringify(envelope));
    let committed: CommandCommit;
    try { committed = await commit(envelope); }
    catch (error) {
      if (definiteRejection(error)) sessionStorage.removeItem(context.key);
      else throw Object.assign(new Error('发送结果尚未确认，请保留预览并再次确认同一笔发送。', { cause: error }), { unknownOutcome: true });
      throw error;
    }
    sessionStorage.removeItem(context.key);
    assertOwner(context);
    publishCommit(committed);
    return committed;
  } finally { active = false; }
}

/** The workbench keeps its interaction order; the resulting messages commit together. */
export function queueCommand(path: string, options: RequestInit): Message | Relation | null {
  if (!current || !/^\/(messages|relations)(\/[^/]+)?$/.test(path)) return null;
  assertOwner(current.context);
  const body = JSON.parse(String(options.body || '{}')) as Record<string, unknown>;
  const method = options.method || 'POST', previous = current.previous?.commands[current.commands.length];
  // References created later in this preparation must point to the original IDs.
  const id = previous?.method === method && previous.path === path ? previous.id : crypto.randomUUID();
  const command: Command = { id, method, path, body };
  current.commands.push(command);
  const user = current.context.user;
  const stamp = new Date().toISOString();
  const relationType = typeof body.relationType === 'string' ? body.relationType : undefined;
  const content = typeof body.content === 'string' ? body.content : '';
  const parts = content ? [{ id: 'body', type: 'text' as const, text: content }] : [];
  const response = relationType ? {
    id, relationType, sourceMessageId: body.sourceMessageId ?? null, sourceRefs: body.sourceRefs,
    targetRefs: body.targetRefs ?? [], payload: body.payload, revision: 1, parts,
    createdAt: stamp, createdBy: user,
  } as Relation : {
    id, kind: body.kind ?? 'TEXT', contentType: body.contentType ?? 'TEXT', content,
    revision: 1, parts, createdAt: stamp, updatedAt: stamp, createdBy: user,
    relationPayload: body.relationPayload,
  } as Message;
  current.provisional.set(id, response);
  return response;
}

export async function runCommandBatch<T>(work: () => Promise<T>, commit: (input: CommandEnvelope) => Promise<unknown>, onCommitted?: (commandCount: number) => void, options?: CommandBatchContext): Promise<T> {
  if (active) throw new Error('上一条消息正在发送，请稍候');
  active = true;
  try {
    const context = captureContext(options), previous = pending(context);
    const batch: Batch = { requestId: previous?.requestId ?? crypto.randomUUID(), commands: [], provisional: new Map(), context, previous };
    current = batch;
    let result!: T, preparationError: unknown;
    try { result = await work(); if (batch.failure) throw batch.failure; }
    catch (error) { preparationError = error; }
    finally { current = null; }
    assertOwner(context);
    if (!previous && preparationError) throw preparationError;
    if (!previous && !batch.commands.length) return result;
    const envelope = previous ?? { requestId: batch.requestId, commands: batch.commands };
    const matching = !preparationError && sameIntent(batch, envelope);
    sessionStorage.setItem(context.key, JSON.stringify(envelope));
    let committed: CommandCommit | undefined;
    try { committed = await commit(envelope) as CommandCommit | undefined; }
    catch (error) {
      const definite = definiteRejection(error);
      if (definite) sessionStorage.removeItem(context.key);
      if (String(currentUser().id || 'anonymous') === context.owner) window.dispatchEvent(new Event('gonglun:reload'));
      if (!definite) {
        const uncertain = new Error('发送结果尚未确认。请查看消息列表；再次发送时会先核对同一笔发送。', { cause: error });
        throw Object.assign(uncertain, { unknownOutcome: true, requestId: envelope.requestId });
      }
      throw error;
    }
    // Always clear the captured owner's record, even if an account switch occurred.
    sessionStorage.removeItem(context.key);
    assertOwner(context);
    publishCommit(committed);
    if (previous && !matching) throw new Error('上一笔发送已确认；当前输入与上一笔不同，已保留，请检查后再发送');
    onCommitted?.(envelope.commands.length);
    return result;
  } finally { current = null; active = false; }
}
