import { annotationAtReference, oppositeAnnotation, ANNOTATION_WITHOUT_OPPOSITE,
  type Part, type SendInput } from '@gonglun/core';
import { DomainError, type Store } from './db.js';

/** Normalize before charging or executing, for both native and workbench commands. */
export async function normalizeAnnotationStance(store: Store, input: SendInput): Promise<SendInput> {
  const stance = input.parts.find((part): part is Extract<Part,{type:'relation'}> => part.type === 'relation'
    && (part.relation === 'agree' || part.relation === 'disagree'));
  if (!stance || stance.roles.target?.length !== 1) return input;
  const reference = stance.roles.target[0]!.reference;
  const original = await store.message(reference.messageId, reference.revision);
  const annotation = annotationAtReference(original, reference);
  if (!annotation) return input;
  const action = stance.relation === 'agree' ? annotation : oppositeAnnotation(annotation);
  if (!action) throw new DomainError(ANNOTATION_WITHOUT_OPPOSITE);
  if (!action.targets.length) throw new DomainError('标注缺少目标，不能转换表态');
  const payload = Object.fromEntries(['label','subType','customLabel'].flatMap(key => {
    const value = action.payload[key as keyof typeof action.payload];
    return value === undefined ? [] : [[key,value]];
  }));
  const uiType = action.relation === 'follow' ? 'ATTENTION' : action.relation.toUpperCase();
  const data = input.parts.find(part => part.id === 'data' && part.type === 'data') ?? input.parts.find(part => part.type === 'data');
  const ownData = data?.type === 'data' && data.value && typeof data.value === 'object' && !Array.isArray(data.value) ? data.value : {};
  const usedBindingIds = new Set(Object.entries(stance.roles).flatMap(([role,bindings]) => role === 'target' ? [] : bindings.map(binding => binding.id)));
  const targetBindings = action.targets.map((reference,index) => {
    let id = index === 0 ? stance.roles.target[0]!.id : `target-${index}`;
    for (let attempt = 1; usedBindingIds.has(id); attempt++) id = `annotation-target-${index}-${attempt}`;
    usedBindingIds.add(id);
    return {id,reference};
  });
  const reason = action.relation === 'follow' || action.relation === 'block' ? action.payload.subType as 'YES' | 'NO' : undefined;
  const parts: Part[] = input.parts.filter(part => part !== data).map(part => part === stance
    ? {...stance,relation:action.relation,...(reason ? {reason} : {}),roles:{...stance.roles,target:targetBindings}} : part);
  let dataId = data?.id ?? 'annotation-data';
  for (let index = 1; parts.some(part => part.id === dataId); index++) dataId = `annotation-data-${index}`;
  parts.push({id:dataId,type:'data',value:{...ownData,...payload,uiType,
    annotationStance:{target:{...reference},side:stance.relation === 'agree' ? 'pro' : 'con'}}});
  // The user's wager stays on the new annotation, just like a directly sent annotation.
  return {...input,parts,...(input.wager ? {selfStance:'pro' as const} : {})};
}
