import type { Message, Part } from './types.js';
import type { StakeItem } from './workbench.js';
import { hasModeratedContent } from './moderation-content.js';

/** Hidden bodies carry no text; clients draw a compact cover from restricted. */
export const RESTRICTED_CONTENT_PLACEHOLDER = '';

export interface ModerationPolicy {
  enabled: boolean;
  fee: number;
  /** Publication self stake on pass; retained field name for stored rules. */
  deposit: number;
  /** Historical configuration only; settlement has no reviewer-count threshold. */
  minReviewers: number;
  /** Historical setting; settlements now distribute funds immediately. */
  appealDelayMs: number;
  /** Retained for old policies; only the initial invitation count is used. */
  stages?: number[];
  assignmentTtlMs?: number;
  exposureMultiplier?: number;
  rewardSlots?: number;
  rewardAmount?: number;
  minWager?: number;
  appealFee?: number;
  /** Appeal self stake on the opposite of the challenged conclusion. */
  appealDeposit?: number;
}
export const DEFAULT_MODERATION_POLICY: ModerationPolicy = {
  enabled: true, fee: 6, deposit: 10, minReviewers: 2, appealDelayMs: 0,
  stages: [3, 9, 27], assignmentTtlMs: 30 * 60_000, exposureMultiplier: 2,
  rewardSlots: 3, rewardAmount: 2, minWager: 2, appealFee: 6, appealDeposit: 10,
};
export type ReviewVerdict = 'pass' | 'reject';
export type ReviewResult = ReviewVerdict | 'unknown';
export function reviewResult(totals:{pass:number;reject:number}):ReviewResult {
  return totals.pass>totals.reject?'pass':totals.reject>totals.pass?'reject':'unknown';
}
export type ReviewEligibility = 'eligible' | 'login-required' | 'closed' | 'content-restricted';
/** Each funded review or self stake remains a separate entry in the review pool. */
export interface ReviewStakeItem extends StakeItem {
  sourceMessageId: string;
  revision: number;
  round: number;
  kind: 'wager' | 'self';
}
export interface ModerationSummary {
  caseId: string;
  messageId: string;
  revision: number;
  status: 'pending' | 'approved' | 'rejected' | 'appeal' | 'unknown';
  /** The requesting viewer's latest decision for this version and review round. */
  viewerVote?: { messageId: string; verdict: ReviewVerdict };
  fee: number;
  deposit: number;
  pass: number;
  reject: number;
  /** Self stakes contribute funds, never reviewer votes or participation rewards. */
  selfPass?: number;
  selfReject?: number;
  reviewerCount: number;
  releaseAt: string | null;
  finalized: boolean;
  round?: number;
  stage?: number;
  stageSize?: number;
  stageCount?: number;
  requiredMajority?: number;
  passReviewers?: number;
  rejectReviewers?: number;
  assignedCount?: number;
  exposedCount?: number;
  exposureLimit?: number;
  provisional?: boolean;
  rewardSlots?: number;
  rewardAmount?: number;
  rewardCount?: number;
  feeRefund?: number;
}
export function reviewStages(policy:ModerationPolicy):number[]{return policy.stages??DEFAULT_MODERATION_POLICY.stages!;}
/** Random invitations are reminders and never a settlement quorum or an expanding jury. */
export function reviewAssignmentSize(policy:ModerationPolicy):number{return reviewStages(policy)[0]!;}
export function reviewEconomy(policy:ModerationPolicy){return {
  rewardSlots:policy.rewardSlots??DEFAULT_MODERATION_POLICY.rewardSlots!,rewardAmount:policy.rewardAmount??DEFAULT_MODERATION_POLICY.rewardAmount!,
  minWager:policy.minWager??DEFAULT_MODERATION_POLICY.minWager!,appealFee:policy.appealFee??DEFAULT_MODERATION_POLICY.appealFee!,appealDeposit:policy.appealDeposit??DEFAULT_MODERATION_POLICY.appealDeposit!,
};}
export const REVIEW_RELATIONS = new Set(['review', 'review-appeal', 'review-settle', 'review-finalize', 'reviewer-authorize']);
/** All review audit records, including historical enrollment, attach to reviewed content. */
export const REVIEW_RECORD_RELATIONS = new Set([...REVIEW_RELATIONS, 'review-record', 'review-enrollment']);
/** Process events feed private notifications, never the review discussion canvas. */
export const REVIEW_PROCESS_RELATIONS = new Set(['review-record', 'review-enrollment', 'review-settle', 'review-finalize', 'reviewer-authorize']);

/** Content and custom labels require publication review; structural actions do not. */
export function requiresModeration(message: Pick<Message, 'authorId' | 'parts'> & {id?:string}): boolean {
  if (message.authorId === 'system') return false;
  const actions = message.parts.filter((p): p is Extract<Part,{type:'relation'}> => p.type === 'relation'
    && !(p.relation === 'member-of' && !p.roles.member?.length) && p.relation !== 'review-context'
    && !((p.id === 'self-stance' || p.id.startsWith('minimum-self-stance-'))
      && ['agree','disagree'].includes(p.relation) && p.roles.target?.length === 1 && p.roles.target[0]!.reference.messageId === message.id));
  if (actions.some(p => REVIEW_RELATIONS.has(p.relation))) return false;
  // Settlement declarations/results contain generated descriptions, including old records
  // attributed to their initiator. They are financial records, not submitted content.
  // Do not trust display metadata (kind/uiType) or exempt unrelated actions in a mixed message.
  if (actions.length && actions.every(p => ['settlement','distribution','open-settlement','open-value-settlement'].includes(p.relation))) return false;
  const data = Object.assign({}, ...message.parts.flatMap(p => p.type === 'data' && p.value && typeof p.value === 'object' && !Array.isArray(p.value) ? [p.value] : []));
  if (hasModeratedContent(message, actions, data)) return true;
  if (actions.some(p => ['proposal','rule-change','recharge','revenue-injection','operations','code-change','classify','summary','delegate','fulfill','amend'].includes(p.relation))) return !!data.title || data.value !== undefined || data.parts !== undefined || data.rules !== undefined;
  return actions.some(p => p.relation === 'correct') && data.correctionKind !== 'WIDTH';
}
