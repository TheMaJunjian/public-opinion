import type { WorkbenchSnapshot, RelationPayload, TargetRef } from './workbench.js';
import type { Part } from './types.js';
import { referenceLabelPart } from './reference-label.js';

/** Presence and topology only. Bodies, quoted text and replacement bodies are fetched by ID. */
const payload = (value: RelationPayload | null | undefined) => {
  if (!value) return value;
  const { content: _content, note: _note, correctionContent: _correction, correctionValue: _value,
    correctionBeforeContent: _before, correctionAfterContent: _after, readDisplay: _read, readDisplayParts: _parts, ...rest } = value;
  return { ...rest,
    ...(_before !== undefined ? { correctionBeforeContent: '' } : {}),
    ...(_after !== undefined ? { correctionAfterContent: '' } : {}) };
};
const refs = (values: TargetRef[] | undefined) => values?.map(ref => ref.kind === 'text-fragment' ? { ...ref, text: '' } : ref);
const parts = (values: Part[] | undefined): Part[] | undefined => {
  const labelPart = referenceLabelPart(values);
  return values?.map(part => {
    if (part.type === 'text') return { ...part, text: part.id !== labelPart && part.text.trim() ? 'x' : '' };
    if (part.type === 'code') return { ...part, source: '' };
    if (part.type === 'data') return { ...part, value: null };
    if (part.type === 'web') return { ...part, excerpt: '' };
    // Native roles contain only reference identities, never readable bodies.
    return part;
  });
};
export function structureSnapshot(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  const rows = new Map<object, object>();
  const compact = <T extends WorkbenchSnapshot['messages'][number] | WorkbenchSnapshot['relations'][number]>(row: T): T => {
    const previous = rows.get(row); if (previous) return previous as T;
    const result = { ...row, parts: parts(row.parts), targetRefs: refs(row.targetRefs), declaredTargetRefs: refs(row.declaredTargetRefs),
      ...('content' in row ? { content: row.content.trim() ? 'x' : '', relationPayload: payload(row.relationPayload) } : {}),
      ...('payload' in row ? { payload: payload(row.payload) } : {}) } as T;
    rows.set(row, result); return result;
  };
  return { ...snapshot, structureOnly: true, messages: snapshot.messages.map(compact), relations: snapshot.relations.map(compact),
    stakes: Object.fromEntries(Object.entries(snapshot.stakes).map(([id, stake]) => [id, { ...stake, stakes: [], contexts: undefined }])) };
}
