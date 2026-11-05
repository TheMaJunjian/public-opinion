export interface RelationComment {
  id: string; sourceId?: string | null; threadId: string;
  parentCommentId?: string | null; rootCommentId?: string | null;
  replyToAuthor?: unknown; issues?: unknown[];
  [key: string]: unknown;
}
export interface RelationArchive { comments: RelationComment[]; [key: string]: unknown }
export interface RelationRow {
  threadId: string; commentId: string; originalParentCommentId: string | null;
  effectiveParentCommentIds: string[]; effectiveParentCommentId: string | null;
  source: 'original' | 'manual' | 'unknown'; method: 'sequence' | 'manual' | null;
  revisionId?: string; batchId?: string; needsReview: boolean;
}
export interface RelationRevision {
  id: string; action: 'set' | 'reset'; threadId: string; commentId: string;
  parentCommentId?: string | null; parentCommentIds?: string[];
  method?: 'sequence' | 'manual' | null; note?: string; createdAt: string;
  batchId?: string; undoOfBatchId?: string; restoredFromRevisionId?: string;
  beforeRevision?: Omit<RelationRevision, 'beforeRevision' | 'threadId' | 'commentId'> | null;
}
export interface RelationOverrides {
  format: 'gonglun-zhihu-overrides'; version: 1 | 2; revisions: RelationRevision[];
}
export interface RelationInput {
  threadId: string; commentId: string; parentCommentId?: string | null; parentCommentIds?: string[]; note?: string;
}
export interface RelationBatchInput {
  threadId: string; mode: 'sequence' | 'sets'; sourceCommentIds?: string[]; targetCommentIds?: string[]; note?: string;
}
export type RelationTime = string | number | Date | (() => string | number | Date);
export function createOverrides(): RelationOverrides;
export function getRelations(archive: RelationArchive, overrides?: RelationOverrides): RelationRow[];
export function applyRelation(archive: RelationArchive, overrides: RelationOverrides, input: RelationInput, now?: RelationTime): RelationOverrides;
export function resetRelation(archive: RelationArchive, overrides: RelationOverrides, input: Pick<RelationInput, 'threadId' | 'commentId' | 'note'>, now?: RelationTime): RelationOverrides;
export function applyRelationBatch(archive: RelationArchive, overrides: RelationOverrides, input: RelationBatchInput, now?: RelationTime): RelationOverrides;
export function undoRelationBatch(archive: RelationArchive, overrides: RelationOverrides, input: { threadId: string; batchId: string; note?: string }, now?: RelationTime): RelationOverrides;
export function materializeRelations<A extends RelationArchive>(archive: A, overrides?: RelationOverrides, options?: { copyArchive?: boolean }): {
  format: 'gonglun-zhihu-reviewed'; version: 2; archive: A; relations: RelationRow[]; overrides: RelationOverrides;
};
