import { referenceKey, type Reference } from '@gonglun/core';
import type { DemoMessage, UnitSelection } from './modelBridge';

export const PART_SELECTION_EVENT = 'message-part-selected';
export interface PartSelectionDetail { reference: Reference; label: string }

/** Addresses belong to rendered content. Never manufacture a UI tree from a message's JSON. */
export function messageTypeReference(message: DemoMessage): Reference | undefined {
  const part = (message.kind !== 'normal' && message.kind !== 'code'
    ? message.parts?.find(candidate => candidate.type === 'relation' && (candidate.relation !== 'member-of' || message.kind === 'join')) : undefined)
    ?? message.parts?.find(candidate => ['text', 'code', 'web'].includes(candidate.type));
  return part ? { messageId: message.id, revision: message.revision ?? 1, partId: part.id } : undefined;
}

export function messageMembersReference(message: DemoMessage): Reference | undefined {
  const part = message.parts?.find(candidate => candidate.type === 'relation' && candidate.roles.members);
  return part ? { messageId: message.id, revision: message.revision ?? 1, partId: part.id, path: ['roles', 'members'] } : undefined;
}

export function selectMessageElement(reference: Reference, label: string): void {
  window.dispatchEvent(new CustomEvent<PartSelectionDetail>(PART_SELECTION_EVENT, { detail: { reference, label } }));
}

export function isWholeMessageSelection(unit: UnitSelection, messageId: string): boolean {
  const ref = unit.reference;
  return unit.messageId === messageId && unit.selection.kind === 'whole'
    && !ref?.partId && !ref?.memberId && !ref?.path?.length && !ref?.range;
}

export function isMessageElementSelected(units: readonly UnitSelection[] | undefined, reference: Reference | undefined): boolean {
  return !!reference && !!units?.some(unit => unit.reference && referenceKey(unit.reference) === referenceKey(reference));
}
