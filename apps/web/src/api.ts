import type { Change, Context, LedgerEntry, Message, Page, Rules, SendInput, SendResult, Session, User } from '@gonglun/core';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function request<T>(path: string, options: RequestInit = {}, csrf?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options, credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!response.ok) throw new ApiError(body?.error || body?.message || `请求未完成（${response.status}）`, response.status);
  return body as T;
}

export interface PersonalMark { messageId: string; read: boolean; followed: boolean; blocked: boolean; archived: boolean }
export type PersonalPage = Page & { personalStates?: PersonalMark[] };
export interface Query { parent?: string; q?: string; relation?: string; author?: string; personal?: string; viewer?: string }
export function inQueryScope(query: Query, parentId?: string): boolean {
  if (query.parent) return parentId === query.parent;
  if (query.q || query.author || query.relation || (query.personal && query.personal !== 'normal')) return true;
  return !parentId;
}
export function queryKey(query: Query): string {
  return JSON.stringify([query.parent || '', query.q || '', query.relation || '', query.author || '', query.personal || '', query.viewer || '']);
}
export function pagePath(query: Query, cursor?: string | null): string {
  const params = new URLSearchParams({ limit: '30' });
  for (const [key, value] of Object.entries(query)) if (value && key !== 'viewer' && key !== 'personal') params.set(key, value);
  if (query.personal && query.personal !== 'notifications') params.set('filter', query.personal);
  if (cursor) params.set('cursor', cursor);
  return `${query.personal === 'notifications' ? '/me/notifications' : query.personal ? '/me/messages' : '/messages'}?${params}`;
}

export const api = {
  session: () => request<Session | null>('/session'),
  setup: () => request<{ initialized: boolean; founderKeyRequired: boolean }>('/setup'),
  user: (id: string) => request<User>(`/users/${encodeURIComponent(id)}`),
  rules: () => request<Rules>('/rules'),
  login: (mode: 'login' | 'register', name: string, password: string, founderKey?: string) => request<Session>(`/${mode}`, { method: 'POST', body: JSON.stringify({ name, password, ...(founderKey ? { founderKey } : {}) }) }),
  logout: (csrf: string) => request<unknown>('/logout', { method: 'POST', body: '{}' }, csrf),
  page: (query: Query, cursor?: string | null, signal?: AbortSignal) => request<PersonalPage>(pagePath(query, cursor), { signal }),
  marks: (ids: string[]) => request<PersonalPage>(`/me/marks?ids=${encodeURIComponent(ids.join(','))}`),
  notifications: (after: number, cursor?: string | null) => request<PersonalPage>(`/me/notifications?after=${after}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  message: (id: string, revision?: number, signal?: AbortSignal) => request<Message>(`/messages/${encodeURIComponent(id)}${revision ? `?revision=${revision}` : ''}`, { signal }),
  context: (id: string, signal?: AbortSignal) => request<Context>(`/messages/${encodeURIComponent(id)}/context`, { signal }),
  history: (id: string, signal?: AbortSignal, cursor?: string | null) => request<{ messages: Message[]; nextCursor: string | null }>(`/messages/${encodeURIComponent(id)}/history?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  ledger: (signal?: AbortSignal, cursor?: string | null) => request<{ entries: LedgerEntry[]; account: import('@gonglun/core').Account; nextCursor: string | null }>(`/ledger?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  send: (input: SendInput, csrf: string) => request<SendResult>('/messages', { method: 'POST', body: JSON.stringify(input) }, csrf),
  changes: (after: number) => request<{ changes: Change[]; nextCursor: number; hasMore: boolean }>(`/changes?after=${after}&limit=100`),
};

/** A request keeps its identity after a timeout; retrying cannot charge twice. */
export class Outbox {
  private active: Promise<SendResult> | null = null;
  constructor(public readonly input: SendInput, private transport: (input: SendInput) => Promise<SendResult>) {}
  send(): Promise<SendResult> {
    if (this.active) return this.active;
    this.active = this.transport(this.input).finally(() => { this.active = null; });
    return this.active;
  }
}
