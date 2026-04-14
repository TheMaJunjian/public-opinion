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

/** 某条消息被其他消息「支持」或「反对」的汇总统计 */
export interface StanceStats {
  support: number;
  oppose: number;
}

/**
 * MessageNode — 非线性树结构的节点
 *
 * 公论核心理念：消息是节点；消息的关系也是消息。
 * buildMessageTree() 将线性消息列表转换为该树形结构。
 */
export interface MessageNode {
  message: Message;
  /** 将该节点引入树的关系类型（REPLY/SUPPORT/OPPOSE/CORRECT），根节点无此字段 */
  relationType?: string;
  relationId?: string;
  children: MessageNode[];
}
