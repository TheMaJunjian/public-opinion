import type { Message, Relation, User } from '../types';
import type { WorkbenchSnapshot } from '../data/workbench';

export interface Command { id: string; method: string; path: string; body: Record<string, unknown> }
export interface CommandEnvelope { requestId: string; commands: Command[] }
export interface CommandCommit { snapshots?: WorkbenchSnapshot[] }
type Batch = CommandEnvelope & { failure?: Error; provisional: Map<string, Message | Relation> };
function storageKey() { return `gonglun:pending-send:${JSON.parse(localStorage.getItem('user') || '{}').id || 'anonymous'}`; }
let current: Batch | null = null;

function pending(): CommandEnvelope | null {
  try { return JSON.parse(sessionStorage.getItem(storageKey()) || 'null') as CommandEnvelope | null; }
  catch { return null; }
}
export function cancelCommandBatch(error: unknown) {
  if (current) current.failure = error instanceof Error ? error : new Error(String(error));
}
export function isPendingMessage(id: string): boolean { return current?.provisional.has(id) ?? false; }

/** The workbench keeps its interaction order; the resulting messages commit together. */
export function queueCommand(path: string, options: RequestInit): Message | Relation | null {
  if (!current || !/^\/(messages|relations)(\/[^/]+)?$/.test(path)) return null;
  const body = JSON.parse(String(options.body || '{}')) as Record<string, unknown>;
  const id = crypto.randomUUID();
  const command: Command = { id, method: options.method || 'POST', path, body };
  current.commands.push(command);
  const user = JSON.parse(localStorage.getItem('user') || '{}') as User;
  const stamp = new Date().toISOString();
  const relationType = typeof body.relationType === 'string' ? body.relationType : undefined;
  const content = typeof body.content === 'string' ? body.content : '';
  const parts = content ? [{ id: 'body', type: 'text' as const, text: content }] : [];
  const response = relationType ? {
    id, relationType, sourceMessageId: body.sourceMessageId ?? null,
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

export async function runCommandBatch<T>(work: () => Promise<T>, commit: (input: CommandEnvelope) => Promise<unknown>, onCommitted?: (commandCount: number) => void): Promise<T> {
  if (current) throw new Error('上一条消息正在发送，请稍候');
  const previous = pending();
  if (previous) {
    // Replay the exact envelope after an interrupted response. The server
    // deduplicates by requestId; rebuilding commands would create new IDs.
    let recovered: CommandCommit | undefined;
    try {
      recovered = await commit(previous) as CommandCommit | undefined;
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && Number(error.status) < 500) {
        sessionStorage.removeItem(storageKey());
      }
      throw error;
    }
    sessionStorage.removeItem(storageKey());
    if (recovered?.snapshots?.length) window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: recovered.snapshots }));
    else window.dispatchEvent(new Event('gonglun:reload'));
    window.dispatchEvent(new Event('points-refresh'));
    throw new Error('上一笔发送已确认，请查看消息后再发送');
  }
  const batch: Batch = { requestId: crypto.randomUUID(), commands: [], provisional: new Map() };
  current = batch;
  let result: T;
  try {
    result = await work();
    if (batch.failure) throw batch.failure;
  } finally { current = null; }
  if (!batch.commands.length) return result;
  const envelope = { requestId: batch.requestId, commands: batch.commands };
  sessionStorage.setItem(storageKey(), JSON.stringify(envelope));
  try {
    const committed = await commit(envelope) as CommandCommit | undefined;
    sessionStorage.removeItem(storageKey());
    onCommitted?.(batch.commands.length);
    if (committed?.snapshots?.length) {
      window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: committed.snapshots }));
    } else window.dispatchEvent(new Event('gonglun:reload'));
    window.dispatchEvent(new Event('points-refresh'));
    return result;
  } catch (error) {
    // A definite rejection made no changes; a lost response must keep its request identity.
    const definiteRejection = error && typeof error === 'object' && 'status' in error && Number(error.status) < 500;
    if (definiteRejection) sessionStorage.removeItem(storageKey());
    window.dispatchEvent(new Event('gonglun:reload'));
    if (!definiteRejection) throw new Error('发送结果尚未确认。请查看消息列表；再次发送时会先核对上一笔发送。', { cause: error });
    throw error;
  }
}
