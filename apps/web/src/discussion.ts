import type { ExecutedStance, Message, MessageState } from '@gonglun/core';

export interface DiscussionModel {
  roots: Message[];
  messages: Map<string, Message>;
  members: Map<string, Message[]>;
  sides: Map<string, { pro: Message[]; con: Message[] }>;
  placements: Map<string, ExecutedStance>;
  attached: Set<string>;
  contextual: Set<string>;
}

/** Arrange only loaded records. Page membership and its cursor remain untouched. */
export function buildDiscussion(
  roots: Message[],
  known: Map<string, Message>,
  states: Record<string, MessageState>,
  childrenFor: (message: Message, depth: number) => Message[] = () => [],
  hiddenTargets: Set<string> = new Set(),
  focusedId?: string,
): DiscussionModel {
  const messages = new Map<string, Message>();
  const members = new Map<string, Message[]>();
  const parents = new Map<string, string>();
  const contextual = new Set<string>();
  const add = (message: Message, depth: number) => {
    if (messages.has(message.id)) return;
    messages.set(message.id, message);
    const children = depth < 3 ? childrenFor(message, depth) : [];
    members.set(message.id, children);
    for (const child of children) {
      if (child.id === message.id) continue;
      parents.set(child.id, message.id);
      add(child, depth + 1);
    }
  };
  roots.forEach(message => add(message, 0));
  if (focusedId) parents.delete(focusedId);
  // A cached target can provide context without fetching an unbounded relation tree.
  for (const message of messages.values()) {
    const basis = states[message.id]?.executedStance;
    const target = basis && known.get(basis.target.messageId);
    if (target && !messages.has(target.id) && !hiddenTargets.has(target.id)) {
      messages.set(target.id, target);
      contextual.add(target.id);
    }
  }
  const placements = new Map<string, ExecutedStance>();
  const attached = new Set<string>();
  const sides: DiscussionModel['sides'] = new Map();
  for (const message of messages.values()) {
    const basis = states[message.id]?.executedStance;
    if (!basis) continue;
    placements.set(message.id, basis);
    const targetId = basis.target.messageId;
    if (!messages.has(targetId) || targetId === message.id || message.id === focusedId) continue;
    let parent: string | undefined = targetId;
    const seen = new Set<string>();
    while (parent && parent !== message.id && !seen.has(parent)) { seen.add(parent); parent = parents.get(parent); }
    if (parent) continue; // Keep an addressable card instead of creating a display cycle.
    parents.set(message.id, targetId);
    attached.add(message.id);
    const group = sides.get(targetId) || { pro: [], con: [] };
    group[basis.side].push(message);
    sides.set(targetId, group);
  }
  for (const [id, children] of members) members.set(id, children.filter(child => !attached.has(child.id) && parents.get(child.id) === id));
  return { roots: [...messages.values()].filter(message => !parents.has(message.id)), messages, members, sides, placements, attached, contextual };
}
