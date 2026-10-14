import { ORGANIZATIONS, type Binding, type Message, type Membership, type MessageState, type Part, type Reference } from './types.js';

export type RelationPart = Extract<Part, { type: 'relation' }>;
export type Resolver = (id: string, revision?: number) => Message | undefined;
export function bindRoles(roles: Record<string, Reference[]>): Record<string, Binding[]> {
  return Object.fromEntries(Object.entries(roles).map(([role, refs]) => [role, refs.map((reference, i) => ({ id: `${role}-${i}`, reference }))]));
}
export function targets(part: RelationPart, role: string): Reference[] { return (part.roles[role] ?? []).map(b => b.reference); }
export function relations(message: Message): RelationPart[] {
  return message.parts.filter((p): p is RelationPart => p.type === 'relation');
}
export function organization(message: Message): RelationPart | undefined {
  return relations(message).find(p => ORGANIZATIONS.has(p.relation));
}
export function textOf(message: Message): string {
  return message.parts.flatMap(p => p.type === 'text' ? [p.text] : p.type === 'web' ? [p.excerpt || p.url] : p.type === 'code' ? [p.source] : []).join('\n');
}
export function referenceKey(reference: Reference): string {
  return JSON.stringify([reference.messageId, reference.revision ?? null, reference.partId ?? null, reference.memberId ?? null, reference.path ?? [], reference.range ?? null]);
}
export function resolveReference(reference: Reference, resolver: Resolver): unknown {
  const message = resolver(reference.messageId, reference.revision);
  if (!message || (reference.revision !== undefined && message.revision !== reference.revision)) return undefined;
  let value: unknown = reference.partId ? message.parts.find(p => p.id === reference.partId) : message;
  if (reference.memberId) {
    const part = value as Part | undefined;
    value = part?.type === 'relation' ? Object.values(part.roles).flat().find(b => b.id === reference.memberId) : undefined;
  }
  for (const key of reference.path ?? []) {
    if (['__proto__', 'constructor', 'prototype'].includes(String(key))) return undefined;
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  if (reference.range) {
    if (typeof value === 'object' && value !== null && 'type' in value) {
      const part = value as Part;
      value = part.type === 'text' ? part.text : part.type === 'code' ? part.source : part.type === 'web' ? part.excerpt : undefined;
    }
    const { start, end } = reference.range;
    if (typeof value !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > value.length) return undefined;
    value = value.slice(start, end);
  }
  return value;
}

/** Only a reference to the stance component itself can reverse the underlying stance. */
export function resolveStance(target: Reference, side: 'pro' | 'con', resolver: Resolver): { target: Reference; side: 'pro' | 'con'; chain: Reference[] } {
  let current = target;
  let currentSide = side;
  const seen = new Set<string>();
  const chain: Reference[] = [];
  for (let depth = 0; depth < 128; depth++) {
    const key = referenceKey(current);
    if (seen.has(key)) throw new Error('立场引用不能形成循环');
    seen.add(key);
    chain.push(current);
    const message = resolver(current.messageId, current.revision);
    if (!message || (current.revision !== undefined && message.revision !== current.revision) || current.memberId || current.path?.length || current.range) return { target: current, side: currentSide, chain };
    const part = current.partId
      ? message.parts.find(p => p.id === current.partId)
      : message.parts.filter(p => !(p.type === 'relation' && p.relation === 'member-of')).length === 1
        ? message.parts.find(p => !(p.type === 'relation' && p.relation === 'member-of')) : undefined;
    if (part?.type !== 'relation' || !['agree', 'disagree'].includes(part.relation) || part.roles.target?.length !== 1) {
      return { target: current, side: currentSide, chain };
    }
    if (part.relation === 'disagree') currentSide = currentSide === 'pro' ? 'con' : 'pro';
    current = part.roles.target[0].reference;
  }
  throw new Error('立场引用链过深');
}

export interface Projection {
  byId: Map<string, Message>;
  roots: Message[];
  children: Map<string, Message[]>;
  suppressed: Set<string>;
  stances: Map<string, { pro: Message[]; con: Message[] }>;
}

/** A bounded view over indexed messages; no topic ownership or copied message nodes. */
export function projectMessages(messages: Message[], memberships: Membership[], states: MessageState[] = []): Projection {
  const byId = new Map(messages.map(m => [m.id, m]));
  const parents = new Map(memberships.map(m => [m.memberId, m.parentId]));
  const children = new Map<string, Message[]>();
  const roots: Message[] = [];
  const stances: Projection['stances'] = new Map();
  const latest = new Map<string, { message: Message; target: Reference; side: 'pro' | 'con' }>();
  for (const message of messages) {
    const parent = parents.get(message.id);
    if (parent && byId.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(message);
      children.set(parent, siblings);
    } else roots.push(message);
    for (const part of relations(message)) {
      if (!['agree', 'disagree'].includes(part.relation) || part.roles.target?.length !== 1) continue;
      try {
        const resolved = resolveStance(part.roles.target[0].reference, part.relation === 'agree' ? 'pro' : 'con', id => byId.get(id));
        const key = `${message.authorId}:${referenceKey({ ...resolved.target, revision: undefined })}`;
        const before = latest.get(key);
        if (!before || before.message.sequence < message.sequence) latest.set(key, { message, ...resolved });
      } catch { /* A partial page may not contain a resolvable historical chain. */ }
    }
  }
  const suppressed = new Set<string>();
  for (const { message, target, side } of latest.values()) {
    const entry = stances.get(target.messageId) ?? { pro: [], con: [] };
    entry[side].push(message);
    stances.set(target.messageId, entry);
    const targetMessage = byId.get(target.messageId);
    const group = targetMessage && organization(targetMessage);
    if (side === 'con' && group && (!target.partId || target.partId === group.id) && !target.memberId && !target.path?.length && !target.range) suppressed.add(target.messageId);
  }
  for (const state of states) {
    if (byId.get(state.messageId)?.revision !== state.revision) continue;
    if (state.suppressed) suppressed.add(state.messageId);
    else suppressed.delete(state.messageId);
  }
  return { byId, roots, children, stances, suppressed };
}

export function replaceReference(message: Message, reference: Reference, value: unknown): Part[] {
  const clone = structuredClone(message);
  if (!reference.partId) {
    if (reference.path?.length || reference.range) throw new Error('修改消息字段须指向具体部件');
    if (!Array.isArray(value)) throw new Error('整条消息的修改内容必须是部件数组');
    return value as Part[];
  }
  const index = clone.parts.findIndex(p => p.id === reference.partId);
  if (index < 0) throw new Error('目标部件不存在');
  let owner: Record<string | number, unknown> = clone.parts as unknown as Record<number, unknown>;
  let field: string | number = index;
  if (reference.memberId) {
    const part = clone.parts[index];
    if (part.type !== 'relation') throw new Error('目标不是关系成员');
    const role = Object.values(part.roles).find(bs => bs.some(b => b.id === reference.memberId));
    if (!role) throw new Error('目标成员不存在');
    owner = role as unknown as Record<number, unknown>;
    field = role.findIndex(b => b.id === reference.memberId);
  }
  const path = reference.path ?? [];
  for (const key of path) {
    if (['__proto__', 'constructor', 'prototype'].includes(String(key))) throw new Error('无效的部件路径');
    const next = owner[field];
    if (typeof next !== 'object' || next === null || !Object.hasOwn(next, key)) throw new Error('目标路径不存在');
    owner = next as Record<string | number, unknown>;
    field = key;
  }
  if (reference.range) {
    if (!path.length) {
      const part = clone.parts[index];
      owner = part as unknown as Record<string, unknown>;
      field = part.type === 'text' ? 'text' : part.type === 'web' ? 'excerpt' : part.type === 'code' ? 'source' : '';
    }
    const previous = owner[field];
    const { start, end } = reference.range;
    if (typeof previous !== 'string' || typeof value !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > previous.length) throw new Error('无效的文本范围');
    owner[field] = previous.slice(0, start) + value + previous.slice(end);
  } else owner[field] = value;
  return clone.parts;
}
