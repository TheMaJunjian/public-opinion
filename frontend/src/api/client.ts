import { signPayloadWithPrivateJwk } from '../utils/signature';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';
const PRIVATE_KEY_PREFIX = 'privateKey:';

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
  localStorage.setItem(`${PRIVATE_KEY_PREFIX}${username}`, serialized);
  localStorage.setItem('privateKey', serialized);
}

export function getPrivateKeyForCurrentUser(): string | null {
  const username = getCurrentUsername();
  if (username) {
    return localStorage.getItem(`${PRIVATE_KEY_PREFIX}${username}`) ?? localStorage.getItem('privateKey');
  }

  return localStorage.getItem('privateKey');
}

function getToken(): string | null {
  return localStorage.getItem('token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Sign write requests with private key
  if (options.method && options.method !== 'GET') {
    try {
      const rawKey = getPrivateKeyForCurrentUser();
      if (rawKey) {
        const keyData = JSON.parse(rawKey) as JsonWebKey;
        // express.json() exposes an empty POST body as {}, so sign the same
        // canonical representation that verifySignature() reconstructs.
        const rawBody = typeof options.body === 'string' ? options.body : '{}';
        headers['X-Signature'] = await signPayloadWithPrivateJwk(rawBody, keyData);
      }
    } catch { /* signing best-effort */ }
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const details = Array.isArray(err.details)
      ? err.details
          .map((d: { field?: string; message?: string }) => (d.field ? `${d.field}: ${d.message}` : d.message))
          .filter(Boolean)
          .join('；')
      : '';
    throw new Error(
      err.error && details ? `${err.error}（${details}）` : err.error || details || err.message || res.statusText
    );
  }
  const data = await res.json();
  return data;
}

export function register(data: { username: string; password: string; publicKey?: string | null }) {
  return request<{ message: string; user: import('../types').User }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function login(data: { username: string; password: string }) {
  return request<{ message: string; token: string; user: import('../types').User }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function logout() {
  return request<{ message: string }>('/auth/logout', { method: 'POST' });
}

export function getTopics(params?: { query?: string; sort?: string; page?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.query) qs.set('query', params.query);
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<import('../types').PaginatedResponse<import('../types').Topic>>(`/topics?${qs}`);
}

export function createTopic(data: { title: string; body?: string }) {
  return request<import('../types').Topic>('/topics', { method: 'POST', body: JSON.stringify(data) });
}

export function getTopic(id: string) {
  return request<import('../types').Topic>(`/topics/${id}`);
}

export function updateTopic(id: string, data: { status: 'OPEN' | 'ARCHIVED' }) {
  return request<import('../types').Topic>(`/topics/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function getMessages(topicId: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<import('../types').PaginatedResponse<import('../types').Message>>(`/topics/${topicId}/messages?${qs}`);
}

export function createMessage(topicId: string, data: {
  kind?: 'TEXT' | 'GOVERNANCE' | 'CODE' | 'ROUND' | 'ROUND_RESULT' | 'OPERATIONS';
  contentType?: 'TEXT' | 'MARKDOWN';
  content?: string;
  stakeAmount?: number;
  targetMessageId?: string;
  note?: string;
  settlementType?: string;
  relationPayload?: Record<string, unknown>;
}) {
  return request<import('../types').Message>(`/topics/${topicId}/messages`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getRelations(topicId: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<import('../types').PaginatedResponse<import('../types').Relation>>(`/topics/${topicId}/relations?${qs}`);
}

export function getAttentionUsers(topicId: string) {
  return request<{ data: Record<string, string[]> }>(`/topics/${topicId}/relations/attention-users`);
}

export function createRelation(topicId: string, data: {
  relationType: string;
  sourceMessageId?: string | null;
  targetRefs: import('../types').TargetRef[];
  payload?: import('../types').RelationPayload;
  supersedesRelationId?: string;
  stakeAmount?: number;
}) {
  return request<import('../types').Relation>(`/topics/${topicId}/relations`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Update a relation by creating a new version that supersedes the old one.
// The old relation is preserved in the database but marked as superseded.
export function updateRelation(topicId: string, relationId: string, data: {
  relationType: string;
  targetRefs: import('../types').TargetRef[];
  payload?: import('../types').RelationPayload;
}) {
  return request<import('../types').Relation>(`/topics/${topicId}/relations`, {
    method: 'POST',
    body: JSON.stringify({
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
export function patchRelationTargets(topicId: string, relationId: string, targetRefs: import('../types').TargetRef[]) {
  return request<import('../types').Relation>(`/topics/${topicId}/relations/${relationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ targetRefs }),
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

export function getUserStances(userId: string, params?: { page?: number; limit?: number; topicId?: string }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.topicId) qs.set('topicId', params.topicId);
  return request<import('../types').StanceHistoryResponse>(`/users/${userId}/stances?${qs}`);
}

export function getUser(userId: string) {
  return request<import('../types').User>(`/users/${userId}`);
}

export function getUserMessages(userId: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<import('../types').PaginatedResponse<import('../types').Message>>(`/users/${userId}/messages?${qs}`);
}

// ============================================================
// Audit Log API (Phase 6)
// ============================================================

export function getAuditLogs(params?: { topicId?: string; page?: number; limit?: number; action?: string; actorId?: string; entityType?: string; entityId?: string }) {
  const qs = new URLSearchParams();
  if (params?.topicId) qs.set('topicId', params.topicId);
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
  topicId: string;
  counts: Record<string, Record<string, number>>;
}

export function getTopicTagCounts(topicId: string) {
  return request<TagCountsResponse>(`/topics/${topicId}/tag-counts`);
}

// ============================================================
// Export API
// ============================================================

export interface ExportData {
  formatVersion: number;
  exportedAt: string;
  topicId: string;
  topic: { title: string; body: string | null; status: string };
  messages: Array<{
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

export function exportTopic(topicId: string) {
  return request<ExportData>(`/topics/${topicId}/export`);
}
