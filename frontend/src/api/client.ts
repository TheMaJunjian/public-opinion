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
    throw new Error(err.message || res.statusText);
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

export function deleteTopic(id: string) {
  return request<{ message: string }>(`/topics/${id}`, { method: 'DELETE' });
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
  quoteSourceId?: string;
  quotedText?: string;
  quoteContextBefore?: string;
  quoteContextAfter?: string;
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
  sourceMessageId: string;
  targetRefs: import('../types').TargetRef[];
}) {
  return request<import('../types').Relation>(`/topics/${topicId}/relations`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
