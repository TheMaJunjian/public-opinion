import type { Reference } from './types.js';

export type NotificationCategory = 'direct' | 'following' | 'financial';
export type NotificationFilter = 'all' | NotificationCategory;
export interface NotificationContent {
  actorName: string;
  action: string;
  excerpt: string;
  targetExcerpt: string;
  sourceRevision: number;
  references: Reference[];
  reasons: string[];
  watchedIds: string[];
  navigationId?: string;
  membershipActive?: boolean;
  roundId?: string;
  settlementType?: 'TRUTH' | 'VALUE';
  settlementTargetId?: string;
  availableDelta?: number;
  lockedDelta?: number;
}
export interface NotificationItem extends NotificationContent {
  id: number;
  sourceId: string;
  targetId: string;
  actorId: string;
  category: NotificationCategory;
  kind: string;
  groupKey: string;
  createdAt: string;
  seenAt: string | null;
  muted: boolean;
}
export interface NotificationSummary {
  unseenCount: number;
  through: number;
  sequence: number;
}
export interface NotificationPage extends NotificationSummary {
  items: NotificationItem[];
  nextCursor: number | null;
}
export interface NotificationQuery {
  category?: NotificationFilter;
  unread?: boolean;
  cursor?: number;
  through?: number;
  limit?: number;
}
export interface NotificationSeenInput {
  through: number;
  ids?: number[];
  category?: NotificationFilter;
}
export interface NotificationDeleteInput extends NotificationSeenInput {
  seenOnly?: boolean;
}
