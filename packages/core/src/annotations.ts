import type { Part, Reference } from './types.js';
import type { RelationPayload, TargetRef } from './workbench.js';

/** Only built-in pairs have an inverse. Custom tags currently have no opposite. */
export const ANNOTATION_OPPOSITES: Readonly<Record<string, string>> = {
  recommend: 'archive', archive: 'recommend', read: 'unread', unread: 'read',
};
export const ANNOTATION_TYPES = new Set(['tag', 'follow', 'block', ...Object.keys(ANNOTATION_OPPOSITES)]);
export const ANNOTATION_WITHOUT_OPPOSITE = '该标注没有互斥项，不能发送反对';

interface AnnotationMessage {
  id?: string;
  revision?: number;
  parts?: Part[];
  relationType?: string | null;
  relationPayload?: RelationPayload | null;
  payload?: RelationPayload;
  targetRefs?: TargetRef[];
}
export interface AnnotationAction {
  relation: string;
  targets: Reference[];
  payload: RelationPayload;
}
const nativeName = (type: string) => type.toLowerCase() === 'attention' ? 'follow' : type.toLowerCase();

/** A body/field/range remains an ordinary discussion target, even on an annotation message. */
export function annotationAtReference(message: AnnotationMessage, reference: Reference): AnnotationAction | undefined {
  if (reference.revision !== undefined && message.revision !== reference.revision
    || reference.memberId || reference.range
    || reference.path?.length && !(reference.partId && reference.path.length === 1 && reference.path[0] === 'relation')) return;
  if (message.parts) {
    const candidates = message.parts.filter((part): part is Extract<Part, {type:'relation'}> => part.type === 'relation'
      && part.relation !== 'member-of' && !(part.id === 'self-stance' && ['agree','disagree'].includes(part.relation)
        && part.roles.target?.length === 1 && part.roles.target[0]?.reference.messageId === message.id));
    const part = reference.partId ? candidates.find(part => part.id === reference.partId) : candidates.length === 1 ? candidates[0] : undefined;
    if (!part || !ANNOTATION_TYPES.has(part.relation)) return;
    const data = Object.assign({}, ...message.parts.flatMap(part => part.type === 'data' && part.value
      && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));
    return {relation:part.relation, targets:(part.roles.target ?? []).map(binding => binding.reference),
      payload:{...data,...message.payload,...message.relationPayload,...(part.reason ? {subType:part.reason} : {})}};
  }
  // Relation projections used during command preparation also carry exact target addresses.
  if (reference.partId || reference.path?.length) return;
  const relation = nativeName(message.relationType ?? '');
  if (!ANNOTATION_TYPES.has(relation)) return;
  return {relation, targets:(message.targetRefs ?? []).map(ref => ref.reference
    ?? {messageId:ref.kind === 'relation' ? ref.relationId : ref.messageId}), payload:{...message.payload,...message.relationPayload}};
}

export function oppositeAnnotation(action: AnnotationAction): AnnotationAction | undefined {
  if (action.relation === 'follow' || action.relation === 'block') {
    const reason = action.payload.subType;
    return reason === 'YES' || reason === 'NO' ? {...action,payload:{subType:reason === 'YES' ? 'NO' : 'YES'}} : undefined;
  }
  const relation = ANNOTATION_OPPOSITES[action.relation];
  // Reasons for the original label are not reasons for its inverse.
  return relation ? {...action,relation,payload:{}} : undefined;
}

export function annotationStanceError(message: AnnotationMessage, reference: Reference): string | null {
  const action = annotationAtReference(message,reference);
  return action && !oppositeAnnotation(action) ? ANNOTATION_WITHOUT_OPPOSITE : null;
}
