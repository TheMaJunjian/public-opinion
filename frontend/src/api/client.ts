const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

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
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.error || err.message || res.statusText);
  }
  return res.json();
}

export function register(data: { username: string; password: string }) {
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
  contentType?: 'TEXT' | 'MARKDOWN';
  content: string;
  stakeAmount?: number;
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

export function createRelation(topicId: string, data: {
  relationType: string;
  sourceMessageId?: string | null;
  targetRefs: import('../types').TargetRef[];
  payload?: import('../types').RelationPayload;
  supersedesRelationId?: string;
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
// Stake API (Phase 2)
// ============================================================

export function placeStake(messageId: string, data: { side: 'PRO' | 'CON'; amount: number }) {
  return request<import('../types').StakeResult>(`/messages/${messageId}/stakes`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getMessageStakes(messageId: string) {
  return request<import('../types').MessageStakes>(`/messages/${messageId}/stakes`);
}
