import type { DemoMessage } from './modelBridge';

/** Independent relation regions share folding and summary interactions. */
export type DiscussionType = 'agree' | 'disagree' | 'recommend' | 'archive' | 'reply' | 'review-pass' | 'review-reject';
export const discussionTypes: readonly DiscussionType[] = ['agree', 'disagree', 'recommend', 'archive', 'reply', 'review-pass', 'review-reject'];
export const discussionLabels: Record<DiscussionType, string> = {
  agree: '支持', disagree: '反驳', recommend: '推荐', archive: '冷藏', reply: '回复',
  'review-pass': '审核通过', 'review-reject': '审核不通过',
};
export const isDiscussionType = (value: string): value is DiscussionType => discussionTypes.includes(value as DiscussionType);
export const isReviewDiscussionType = (value: string | undefined) => value === 'review-pass' || value === 'review-reject';

/** An expanded classification is trace context, so discussion lanes arrange
 * its contents. Explicit arrangements still retain their member order. */
export function hasManualDiscussionOrder(message: DemoMessage | undefined, traceMode = false): boolean {
  return !(traceMode && ['classify', 'summary'].includes(message?.relationType ?? ''))
    && !!message?.parts?.some(part => part.type === 'display');
}

/** Generated relation previews are not authored text. Explicit parts are authoritative. */
export function hasDiscussionText(message: DemoMessage | undefined): boolean {
  if (!message) return false;
  if (Array.isArray(message.parts) && message.parts.some(part => part.type === 'display' && part.layout === 'relation')) return false;
  if (message.parts !== undefined) return Array.isArray(message.parts)
    && message.parts.some(part => part.type === 'text' && part.text.trim().length > 0);
  return (message.kind === 'normal' || message.kind === 'code') && message.content.trim().length > 0;
}
