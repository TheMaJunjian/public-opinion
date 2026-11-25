import { REVIEW_RECORD_RELATIONS, REVIEW_PROCESS_RELATIONS } from './moderation.js';
import type { Message, Part } from './types.js';

export const REVIEW_CONTEXT_RELATION = 'review-context';
export const REVIEW_REASON_RELATION = 'review-reason';
export type ReviewContext = { messageId: string; revision: number };
type ReviewMessage = { parts?: Part[] };

/** A discussion scope is an address, never an additional review or vote. */
export function reviewContextOf(message: ReviewMessage | undefined): ReviewContext | undefined {
  const part = message?.parts?.find(part => part.type === 'relation' && part.relation === REVIEW_CONTEXT_RELATION)
    ?? message?.parts?.find(part => part.type === 'relation' && REVIEW_RECORD_RELATIONS.has(part.relation));
  if (part?.type !== 'relation' || part.roles.target?.length !== 1) return;
  const ref = part.roles.target[0]!.reference;
  if (!ref.revision || ref.partId || ref.memberId || ref.path?.length || ref.range) return;
  return { messageId: ref.messageId, revision: ref.revision };
}
export function sameReviewContext(a: ReviewContext | undefined, b: ReviewContext | undefined): boolean {
  return !!a && !!b && a.messageId === b.messageId && a.revision === b.revision;
}
export function reviewContextPart(context: ReviewContext): Part {
  return { id: 'review-context', type: 'relation', relation: REVIEW_CONTEXT_RELATION,
    roles: { target: [{ id: 'review-context-target', reference: { ...context } }] } };
}
/** Attribution to the immutable decision, independent of the reason's own moderation. */
export function reviewReasonPart(decision: ReviewContext): Part {
  return { id: 'review-reason', type: 'relation', relation: REVIEW_REASON_RELATION,
    roles: { target: [{ id: 'review-reason-target', reference: { ...decision } }] } };
}
export function reviewReasonContent(message: Pick<Message,'parts'>):Part[] {
  const content=message.parts.filter(part=>part.type==='text'||part.type==='code'||part.type==='web');
  const labels=message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)
    ?[part.value.content,part.value.title,part.value.label]:[]);
  // Native clients can submit a reason in the payload. Workbench commands often duplicate it in a text part.
  for(const text of labels){
    if(typeof text!=='string'||!text.trim()||content.some(part=>part.type==='text'&&part.text===text))continue;
    let id='body';
    for(let i=1;message.parts.some(part=>part.id===id)||content.some(part=>part.id===id);i++)id=`body-${i}`;
    content.push({id,type:'text',text});
  }
  return content.some(part=>(part.type==='text'?part.text:part.type==='code'?part.source:part.excerpt).trim())?content:[];
}
/** Links use fresh component IDs so existing citations to the reason text stay valid. */
export function withReviewReasonLinks(content:Part[],context:ReviewContext,decision:ReviewContext):Part[] {
  const parts=[...content];
  for(const marker of [reviewContextPart(context),reviewReasonPart(decision)]){
    let id=marker.id;
    for(let i=1;parts.some(part=>part.id===id);i++)id=`${marker.id}-${i}`;
    parts.push({...marker,id});
  }
  return parts;
}
export function hasReviewContext(message: ReviewMessage | undefined): boolean {
  return !!message?.parts?.some(part => part.type === 'relation' && part.relation === REVIEW_CONTEXT_RELATION);
}
export function isReviewAudit(message: ReviewMessage | undefined): boolean {
  return !!message?.parts?.some(part => part.type === 'relation' && REVIEW_RECORD_RELATIONS.has(part.relation));
}
export function isReviewProcessRecord(message: ReviewMessage | undefined): boolean {
  return !!message?.parts?.some(part => part.type === 'relation' && REVIEW_PROCESS_RELATIONS.has(part.relation));
}

/** Keep discussion attached to the exact reviewed version, including older
 * replies/corrections that predate explicit discussion scopes. */
export function selectReviewDiscussion<T extends Pick<Message, 'id' | 'parts'>>(
  records: T[], context: ReviewContext, caseId?: string,
): T[] {
  const unique = [...new Map(records.map(record => [record.id, record])).values()];
  const included = new Set<string>();
  const incoming = new Map<string, string[]>(), sources = new Map<string, string[]>();
  const allowed = new Set<string>();
  for (const record of unique) {
    if (record.id === context.messageId || isReviewProcessRecord(record)) continue;
    const audit = isReviewAudit(record), explicit = hasReviewContext(record);
    const data = Object.assign({}, ...record.parts.flatMap(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));
    const matches = explicit ? sameReviewContext(reviewContextOf(record), context)
      : audit && (caseId && data.caseId ? data.caseId === caseId : record.parts.some(part => part.type === 'relation' && REVIEW_RECORD_RELATIONS.has(part.relation)
        && part.roles.target?.some(({reference}) => reference.messageId === context.messageId && reference.revision === context.revision)));
    if (matches) included.add(record.id);
    if ((audit || explicit) && !matches) continue;
    allowed.add(record.id);
    for (const part of record.parts) {
      if (part.type !== 'relation' || audit || part.relation === REVIEW_CONTEXT_RELATION || part.relation === REVIEW_REASON_RELATION) continue;
      for (const bindings of Object.values(part.roles)) for (const { reference } of bindings) {
        const list = incoming.get(reference.messageId) ?? [];
        list.push(record.id); incoming.set(reference.messageId, list);
      }
      if (['reply', 'reference', 'annotation'].includes(part.relation)) {
        sources.set(record.id, [...(sources.get(record.id) ?? []), ...(part.roles.source ?? []).map(binding => binding.reference.messageId)]);
      }
    }
  }
  const queue = [...included];
  for (let index = 0; index < queue.length; index++) for (const id of [...incoming.get(queue[index]!) ?? [], ...sources.get(queue[index]!) ?? []]) {
    if (!allowed.has(id) || included.has(id)) continue;
    included.add(id); queue.push(id);
  }
  return unique.filter(record => included.has(record.id));
}
