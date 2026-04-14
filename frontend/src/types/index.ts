export interface User {
  id: string;
  username: string;
  createdAt: string;
}

export interface Topic {
  id: string;
  title: string;
  body?: string;
  status: 'OPEN' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
  createdBy: User;
  _count?: { messages: number; relations?: number };
}

export interface Message {
  id: string;
  topicId: string;
  contentType: 'TEXT' | 'MARKDOWN';
  content: string;
  quoteSourceId?: string;
  quotedText?: string;
  quotedTextHash?: string;
  quoteContextBefore?: string;
  quoteContextAfter?: string;
  createdAt: string;
  createdBy: User;
}

export interface TargetRef {
  targetMessageId: string;
  targetSelectedText?: string;
  targetSelectedTextHash?: string;
}

export interface Relation {
  id: string;
  topicId: string;
  relationType: string;
  sourceMessageId: string;
  targetRefs: TargetRef[];
  createdAt: string;
  createdBy: User;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export type RelationType = 'QUOTE' | 'REPLY' | 'SUPPORT' | 'OPPOSE' | 'CORRECT' | 'LINK' | 'UNLINK';
