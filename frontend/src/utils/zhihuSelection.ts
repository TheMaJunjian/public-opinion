import { unitSelectionToReference, type UnitSelection } from './modelBridge';
import { resolveReference, type Message as CoreMessage, type Reference } from '@gonglun/core';
import { isWholeMessageSelection } from './messageElementSelection';
import type { ZhihuViewingData } from './zhihuArchive';

/** A current relation-type badge addresses the relation itself, not an arbitrary body fragment. */
export function zhihuWholeMessageUnit(data: ZhihuViewingData, unit: UnitSelection): UnitSelection | null {
  const message = data.messages.find(candidate => candidate.id === unit.messageId), reference = unit.reference;
  if (!message || reference && reference.messageId !== unit.messageId || reference?.revision !== undefined && reference.revision !== (message.revision ?? 1)) return null;
  if (isWholeMessageSelection(unit, unit.messageId)) return { messageId: unit.messageId, selection: { kind: 'whole' } };
  const relationPath = !reference?.path?.length || reference.path.length === 1 && reference.path[0] === 'relation';
  if (unit.selection.kind !== 'edge' || !reference?.partId || !relationPath || reference.memberId || reference.range) return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some(part => part.id === reference.partId && part.type === 'relation' && part.relation !== 'member-of')
    ? { messageId: unit.messageId, selection: { kind: 'whole' } } : null;
}

/** Preserve native fragment addresses; only the current relation badge expands to its whole relation. */
export function zhihuStanceReference(data: ZhihuViewingData, unit: UnitSelection,
  messageById: ReadonlyMap<string, ZhihuViewingData['messages'][number]> = new Map(data.messages.map(message => [message.id, message]))): Reference | null {
  const message = messageById.get(unit.messageId), meta = data.zhihu.byMessageId[unit.messageId];
  if (!message || !meta || meta.kind === 'membership' || message.supersededBy || unit.reference && unit.reference.messageId !== unit.messageId) return null;
  if (!unit.reference?.context && zhihuWholeMessageUnit(data, unit)) return { messageId: unit.messageId };
  try {
    const reference = unitSelectionToReference(unit, messageById);
    const value = resolveReference(reference, (id, revision) => {
      const target = messageById.get(id);
      return target?.parts && (revision === undefined || revision === (target.revision ?? 1))
        ? { ...target, revision: target.revision ?? 1 } as unknown as CoreMessage : undefined;
    });
    return value === undefined || reference.range && (typeof value !== 'string' || !value.length) ? null : reference;
  } catch {
    return null;
  }
}
