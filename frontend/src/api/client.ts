import { signPayloadWithPrivateJwk } from '../utils/signature';
import type { Session, Reference } from '@gonglun/core';
import { decodeWorkbenchSnapshot, type CompactSnapshot } from '@gonglun/core';
import { cancelCommandBatch, isPendingMessage, queueCommand, runCommandBatch } from './commandBatch';

const CORE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const BASE_URL = `${CORE_URL}/ui`;
let csrf = '';
const PRIVATE_KEY_PREFIX = 'privateKey:';
const DEVICE_ID_KEY = 'deviceId';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly path: string;

  constructor(message: string, details: { status: number; code?: string; path: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = details.status;
    this.code = details.code;
    this.path = details.path;
  }
}

export function getDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const generated = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
}

function getCurrentUsername(): string | null {
  const rawUser = localStorage.getItem('user');
  if (!rawUser) return null;

  try {
    const user = JSON.parse(rawUser) as { username?: string };
    return user.username ?? null;
  } catch {
    return null;
  }
}

export function storePrivateKeyForUser(username: string, keyData: JsonWebKey): void {
  const serialized = JSON.stringify(keyData);
  localStorage.setItem(`${PRIVATE_KEY_PREFIX}${getDeviceId()}:${username}`, serialized);
}

export function getPrivateKeyForCurrentUser(): string | null {
  const username = getCurrentUsername();
  return username ? getPrivateKeyForUser(username) : null;
}

export function getPrivateKeyForUser(username: string): string | null {
  if (username) {
    return localStorage.getItem(`${PRIVATE_KEY_PREFIX}${getDeviceId()}:${username}`);
  }

  return null;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const queued = options.method && options.method !== 'GET' ? queueCommand(path, options) : null;
  if (queued) return queued as T;
  const core = ['/setup', '/session', '/login', '/register', '/logout'].includes(path);
  const url = `${core ? CORE_URL : BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  headers['X-Device-Id'] = getDeviceId();
  const isAuthBootstrap = ['/login', '/register', '/logout', '/auth/signing-key'].includes(path);
  if (path === '/auth/signing-key' || path === '/logout') {
    if (!csrf) await getSession();
    headers['X-CSRF-Token'] = csrf;
  }
  if (options.method && options.method !== 'GET' && !isAuthBootstrap) {
    if (!csrf) await getSession();
    headers['X-CSRF-Token'] = csrf;
    const body = JSON.parse(typeof options.body === 'string' ? options.body : '{}');
    const requestId = body.requestId || crypto.randomUUID();
    headers['X-Request-Id'] = requestId;
    try {
      const rawKey = getPrivateKeyForCurrentUser();
      if (!rawKey) throw new Error('本设备缺少签名密钥，请重新登录以绑定当前设备');
      const keyData = JSON.parse(rawKey) as JsonWebKey;
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
      const bodyHash = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
      const signed = JSON.stringify({ method: options.method, path: new URL(url, location.href).pathname, bodyHash, requestId });
      headers['X-Signed-Payload'] = btoa(String.fromCharCode(...new TextEncoder().encode(signed)));
      headers['X-Signature'] = await signPayloadWithPrivateJwk(signed, keyData);
    } catch (error) {
      throw error instanceof Error ? error : new Error('签名失败，请重新登录以绑定当前设备');
    }
  }
  // Retry a lost write response with exactly the same request identity and signature.
  const fetchOnce = async () => {
    // A suspended tab may never receive a response to a completed write.
    // Bound each attempt, while keeping the same request identity for retries.
    if (path !== '/commands') return fetch(url, { ...options, headers, credentials: 'same-origin' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
    try {
      return await fetch(url, { ...options, headers, credentials: 'same-origin', signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  };
  let res: Response;
  try { res = await fetchOnce(); }
  catch (error) { if (!headers['X-Request-Id']) throw error; res = await fetchOnce(); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText })) as { error?: string; message?: string; code?: string; details?: unknown };
    const details = Array.isArray(err.details)
      ? err.details
          .map((d: { field?: string; message?: string }) => (d.field ? `${d.field}: ${d.message}` : d.message))
          .filter(Boolean)
          .join('；')
      : '';
    const message = err.error && details ? `${err.error}（${details}）` : err.error || details || err.message || res.statusText;
    throw new ApiError(err.code ? `${message} [${err.code}]` : message, {
      status: res.status,
      code: err.code,
      path,
    });
  }
  const data = await res.json();
  return data;
}

type UiSession = Session & { user: Session['user'] & import('../types').User & { publicKey?: string | null } };
export async function getSession(): Promise<UiSession | null> {
  const session = await request<UiSession | null>('/session');
  csrf = session?.csrf ?? '';
  return session;
}
export function getSetup() {
  return request<{ initialized: boolean; founderKeyRequired: boolean }>('/setup');
}
export async function register(data: { username: string; password: string; publicKey?: string | null; founderKey?: string }) {
  const session = await request<UiSession>('/register', {
    method: 'POST',
    body: JSON.stringify({ ...data, deviceId: getDeviceId() }),
  });
  csrf = session.csrf;
  return { message: '注册成功', user: session.user };
}

export async function login(data: { username: string; password: string; publicKey?: string }) {
  const session = await request<UiSession>('/login', {
    method: 'POST',
    body: JSON.stringify({ ...data, deviceId: getDeviceId() }),
  });
  csrf = session.csrf;
  return { message: '登录成功', token: 'session', user: session.user };
}

export async function rotateSigningKey(data: { password: string; publicKey: string }) {
  const result = await request<{ message: string; session: UiSession; user: UiSession['user'] }>('/auth/signing-key', {
    method: 'POST',
    body: JSON.stringify({ ...data, deviceId: getDeviceId() }),
  });
  csrf = result.session.csrf;
  return { ...result, token: 'session' };
}

export function logout() {
  return request<{ message: string }>('/logout', { method: 'POST' }).finally(() => { csrf = ''; });
}

export { cancelCommandBatch };
export function withCommandBatch<T>(work: () => Promise<T>, onCommitted?: (commandCount: number) => void): Promise<T> {
  return runCommandBatch(work, body => request('/commands', { method: 'POST', body: JSON.stringify(body) }), onCommitted);
}

export async function getWorkbenchSnapshot({ signal, ...query }: import('../data/workbench').SnapshotQuery) {
  const params = new URLSearchParams({ format: 'compact-v1' });
  // The server still uses bounded keyset pagination. Bundle four pages per
  // round trip without truncating the graph or changing the sync boundary.
  if (query.after === undefined) params.set('batch', '4');
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  type Snapshot = import('../data/workbench').WorkbenchSnapshot;
  return decodeWorkbenchSnapshot<Snapshot>(await request<Snapshot | CompactSnapshot<Snapshot>>(`/snapshot?${params}`, { signal }));
}
export function subscribeChanges(after: number) {
  return new EventSource(`${CORE_URL}/events?after=${after}`, { withCredentials: true });
}

export function getScope(parent = 'root') {
  return request<import('../types').ScopeView>(`/scope?parent=${encodeURIComponent(parent)}`);
}

export function getMessages(scopeMessageId: string, params?: { page?: number; limit?: number; sinceUpdatedAt?: string; sinceId?: string }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.sinceUpdatedAt) qs.set('sinceUpdatedAt', params.sinceUpdatedAt);
  if (params?.sinceId) qs.set('sinceId', params.sinceId);
  return request<import('../types').PaginatedResponse<import('../types').Message>>(`/messages?parent=${encodeURIComponent(scopeMessageId)}&${qs}`);
}

export async function getAllMessages(scopeMessageId: string, limit = 200, cursor?: { updatedAt: string; id: string }) {
  const firstPage = await getMessages(scopeMessageId, {
    page: 1,
    limit,
    sinceUpdatedAt: cursor?.updatedAt,
    sinceId: cursor?.id,
  });
  if (firstPage.pagination.totalPages <= 1) return firstPage;
  const pages = await Promise.all(
    Array.from({ length: firstPage.pagination.totalPages - 1 }, (_, index) =>
      getMessages(scopeMessageId, {
        page: index + 2,
        limit,
        sinceUpdatedAt: cursor?.updatedAt,
        sinceId: cursor?.id,
      }),
    ),
  );
  return {
    data: [firstPage, ...pages].flatMap(page => page.data),
    pagination: { ...firstPage.pagination, page: 1, totalPages: 1 },
  };
}

export function createMessage(scopeMessageId: string, data: {
  kind?: 'TEXT' | 'GOVERNANCE' | 'CODE' | 'ROUND' | 'ROUND_RESULT' | 'OPERATIONS';
  contentType?: 'TEXT' | 'MARKDOWN';
  content?: string;
  stakeAmount?: number;
  recommendation?: number;
  wager?: number;
  selfAgree?: boolean;
  sourceRefs?: Reference[];
  targetMessageId?: string;
  note?: string;
  settlementType?: string;
  relationPayload?: Record<string, unknown>;
}) {
  return request<import('../types').Message>('/messages', {
    method: 'POST',
    body: JSON.stringify({ ...data, parentMessageId: scopeMessageId === 'root' ? undefined : scopeMessageId }),
  });
}

export function getRelations(scopeMessageId: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<import('../types').PaginatedResponse<import('../types').Relation>>(`/relations?parent=${encodeURIComponent(scopeMessageId)}&${qs}`);
}

export function getAttentionUsers(scopeMessageId: string) {
  return request<{ data: Record<string, string[]> }>(`/attention-users?parent=${encodeURIComponent(scopeMessageId)}`);
}

export function createRelation(scopeMessageId: string, data: {
  relationType: string;
  sourceMessageId?: string | null;
  targetRefs: import('../types').TargetRef[];
  payload?: import('../types').RelationPayload;
  supersedesRelationId?: string;
  stakeAmount?: number;
  recommendation?: number;
  wager?: number;
  selfAgree?: boolean;
  sourceRefs?: Reference[];
}) {
  return request<import('../types').Relation>('/relations', {
    method: 'POST',
    body: JSON.stringify({ ...data, parentMessageId: scopeMessageId === 'root' ? undefined : scopeMessageId }),
  });
}

// Update a relation by creating a new version that supersedes the old one.
// The old relation is preserved in the database but marked as superseded.
export function updateRelation(scopeMessageId: string, relationId: string, data: {
  relationType: string;
  targetRefs: import('../types').TargetRef[];
  payload?: import('../types').RelationPayload;
}) {
  return request<import('../types').Relation>('/relations', {
    method: 'POST',
    body: JSON.stringify({
      parentMessageId: scopeMessageId === 'root' ? undefined : scopeMessageId,
      relationType: data.relationType,
      targetRefs: data.targetRefs,
      payload: data.payload,
      supersedesRelationId: relationId,
    }),
  });
}

// Update a relation's targetRefs in-place without creating a new message version.
// Unlike updateRelation (which supersedes), this preserves the relation's ID
// so that external references (stance records, URLs) remain valid.
export function patchRelationTargets(scopeMessageId: string, relationId: string, targetRefs: import('../types').TargetRef[]) {
  return request<import('../types').Relation>(`/relations/${relationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ targetRefs, parentMessageId: scopeMessageId === 'root' ? undefined : scopeMessageId }),
  });
}

// ============================================================
// Points & Rules API (Phase 1)
// ============================================================

export function getPointsBalance() {
  return request<import('../types').PointsBalance>('/points/balance');
}

export function getPointsTransactions(params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<import('../types').PaginatedResponse<import('../types').PointTransaction>>(`/points/transactions?${qs}`);
}

export function getCurrentRules() {
  return request<import('../types').CurrentRule>('/rules/current');
}

// ============================================================
// Stake API (Phase 2 — read-only; writing via messages/relations)
// ============================================================

export function getMessageStakes(messageId: string, settlementType?: 'TRUTH' | 'VALUE') {
  if (isPendingMessage(messageId)) return Promise.resolve<import('../types').MessageStakes>({ messageId, pool: { lockedPro: 0, lockedCon: 0 }, stakes: [], counts: { pro: 0, con: 0 }, countsByType: { TRUTH: { pro: 0, con: 0 }, VALUE: { pro: 0, con: 0 } } });
  const qs = settlementType ? `?settlementType=${settlementType}` : '';
  return request<import('../types').MessageStakes>(`/messages/${messageId}/stakes${qs}`);
}

// ============================================================
// Settlement API (Phase 3)
// ============================================================

export function createRound(messageId: string, data?: { note?: string; settlementType?: 'TRUTH' | 'VALUE' }) {
  return request<import('../types').SettlementRoundItem>(`/messages/${messageId}/rounds`, {
    method: 'POST',
    body: JSON.stringify(data ?? {}),
  });
}

export function getMessageRounds(messageId: string) {
  return request<{ data: import('../types').SettlementRoundItem[] }>(`/messages/${messageId}/rounds`);
}

export function getRoundDetail(roundId: string) {
  return request<import('../types').SettlementRoundItem>(`/rounds/${roundId}`);
}

export function castVote(roundId: string, data: { vote: 'TRUE' | 'FALSE'; amount: number }) {
  // Voting now creates an AGREE/DISAGREE relation message (Phase 5 unification)
  return request<import('../types').Relation & { message: string }>(`/rounds/${roundId}/votes`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function closeAndSettle(roundId: string) {
  return request<import('../types').SettlementResult>(`/rounds/${roundId}/close-and-settle`, {
    method: 'POST',
  });
}

// ============================================================
// Stance API (Phase 5)
// ============================================================

export function getUserStances(userId: string, params?: { page?: number; limit?: number; scopeMessageId?: string }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.scopeMessageId) qs.set('scopeMessageId', params.scopeMessageId);
  return request<import('../types').StanceHistoryResponse>(`/users/${userId}/stances?${qs}`);
}

export function getUser(userId: string) {
  return request<import('../types').User>(`/users/${userId}`);
}

export function getUsers() {
  return request<{ data: import('../types').User[] }>('/users');
}

export function getUserMessages(userId: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<import('../types').PaginatedResponse<import('../types').Message>>(`/users/${userId}/messages?${qs}`);
}

export async function getAllUserMessages(userId: string, limit = 200) {
  const firstPage = await getUserMessages(userId, { page: 1, limit });
  if (firstPage.pagination.totalPages <= 1) return firstPage;
  const pages = await Promise.all(
    Array.from({ length: firstPage.pagination.totalPages - 1 }, (_, index) =>
      getUserMessages(userId, { page: index + 2, limit }),
    ),
  );
  return {
    data: [firstPage, ...pages].flatMap(page => page.data),
    pagination: { ...firstPage.pagination, page: 1, totalPages: 1 },
  };
}

// ============================================================
// Audit Log API (Phase 6)
// ============================================================

export function getAuditLogs(params?: { scopeMessageId?: string; page?: number; limit?: number; action?: string; actorId?: string; entityType?: string; entityId?: string }) {
  const qs = new URLSearchParams();
  if (params?.scopeMessageId) qs.set('scopeMessageId', params.scopeMessageId);
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.action) qs.set('action', params.action);
  if (params?.actorId) qs.set('actorId', params.actorId);
  if (params?.entityType) qs.set('entityType', params.entityType);
  if (params?.entityId) qs.set('entityId', params.entityId);
  return request<import('../types').PaginatedResponse<import('../types').AuditLogEntry>>(`/audit-logs?${qs}`);
}

// ============================================================
// Revenue API (Phase 6)
// ============================================================

export function getRevenuePool() {
  return request<import('../types').RevenuePoolData>('/revenue/pool');
}

export function getRevenueDistributions(params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<import('../types').PaginatedResponse<import('../types').RevenueDistributionItem>>(`/revenue/distributions?${qs}`);
}

// ============================================================
// Tag API
// ============================================================

export interface TagCountsResponse {
  counts: Record<string, Record<string, number>>;
}

export function getMessageTagCounts(scopeMessageId: string) {
  return request<TagCountsResponse>(`/tag-counts?parent=${encodeURIComponent(scopeMessageId)}`);
}

// ============================================================
// Export API
// ============================================================

export interface ExportData {
  format?: 'gonglun-2';
  formatVersion: number;
  exportedAt: string;
  scope: import('../types').ScopeView;
  messages: Array<Partial<Pick<import('../types').Message, 'revision' | 'parts' | 'state' | 'spending' | 'executedStance'>> & {
    id: string;
    kind: string;
    contentType: string | null;
    content: string | null;
    createdAt: string;
    authorId: string;
    author: string;
    quoteSourceId?: string | null;
    quotedText?: string | null;
    quotedTextHash?: string | null;
    quoteContextBefore?: string | null;
    quoteContextAfter?: string | null;
    targetRefs?: unknown;
    relationPayload?: unknown;
    relationType?: string | null;
    sourceMessageId?: string | null;
    supersededBy?: string | null;
  }>;
  relations: Array<{
    id: string;
    relationType: string | null;
    sourceMessageId: string | null;
    targetRefs: unknown;
    payload: unknown;
    createdAt: string;
    authorId: string;
    author: string;
    supersededBy: string | null;
  }>;
}

export function exportMessages(scopeMessageId: string) {
  return request<ExportData>(`/export?parent=${encodeURIComponent(scopeMessageId)}`);
}
