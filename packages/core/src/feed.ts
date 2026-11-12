/** Lightweight discovery views; reading a preview never confirms a message as read. */
export type FeedMode = 'recommended' | 'following' | 'latest';
export interface FeedPreview {
  id: string;
  revision: number;
  excerpt: string;
  kind: string;
  author: { id: string; username: string };
  createdAt: string;
  updatedAt: string;
  hasCorrections: boolean;
}
export interface FeedItem extends FeedPreview {
  reasons: string[];
  updates: FeedPreview[];
}
export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
  mode: FeedMode;
}
