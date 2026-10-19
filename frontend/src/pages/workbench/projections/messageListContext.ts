import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';
import { collectExclusiveRelationMsgIds } from '../actions/targetResolution';

/** Fold dependent relation rows with their context, preserving the stream's order. */
export function filterMessageListContext(
  visibleMessages: DemoMessage[], messages: DemoMessage[], edges: DemoEdge[],
  standaloneMessageIds?: ReadonlySet<string>,
): DemoMessage[] {
  const visibleIds = new Set(visibleMessages.map(message => message.id));
  const msgMap = new Map(messages.map(message => [message.id, message]));
  const hiddenIds = new Set(messages.filter(message => !visibleIds.has(message.id)).map(message => message.id));
  let changed = hiddenIds.size > 0;
  while (changed) {
    changed = false;
    for (const id of collectExclusiveRelationMsgIds({ edges, msgMap }, hiddenIds, hiddenIds)) {
      if (hiddenIds.has(id) || standaloneMessageIds?.has(id)) continue;
      hiddenIds.add(id);
      changed = true;
    }
  }
  return visibleMessages.filter(message => !hiddenIds.has(message.id));
}
