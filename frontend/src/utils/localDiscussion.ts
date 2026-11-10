import { bindRoles, replaceReference, resolveReference, textOf, type Json, type Message as CoreMessage,
  type MembershipAction, type Part, type Reference } from '@gonglun/core';
import type { ExportData, createMessage, createRelation } from '../api/client';
import type { Message, Relation, User } from '../types';

const containers = new Set(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE']);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const relationPart = (name: string, roles: Record<string, Reference[]>): Extract<Part, { type: 'relation' }> =>
  ({ id: 'relation', type: 'relation', relation: name, roles: bindRoles(roles) });

/** A single local transaction. Its records become visible only after durable saving. */
export class LocalDiscussion {
  readonly user: User;
  private data: ExportData;
  private failure: unknown;
  private count = 0;
  private sealed = false;
  constructor(source: ExportData, username: string) {
    const name = username.trim();
    if (!name) throw new Error('请先输入本地发言人');
    const existing = source.users?.find(user => user.username === name);
    const authored = source.messages.find(message => message.author === name);
    this.user = existing ?? { id: authored?.authorId || `local:user:${crypto.randomUUID()}`, username: name, createdAt: new Date().toISOString() };
    // An edited discussion is a view document, not a verifiable server ledger.
    this.data = { format: 'gonglun-view-3', formatVersion: 5, exportedAt: source.exportedAt,
      scope: source.scope, messages: [...source.messages], relations: [...source.relations],
      users: [...source.users ?? []], stakes: source.stakes, tagCounts: structuredClone(source.tagCounts ?? {}),
      attentionUsers: structuredClone(source.attentionUsers ?? {}), viewerUsername: name,
      ...(source.view ? { view: { ...source.view, username: name } } : {}) };
    if (!this.data.users!.some(user => user.id === this.user.id)) this.data.users!.push(this.user);
    const sequence = new Map(source.messages.map(message => [message.id, message.sequence ?? 0]));
    for (const relation of [...source.relations].sort((a, b) => (sequence.get(a.id) ?? 0) - (sequence.get(b.id) ?? 0) || a.createdAt.localeCompare(b.createdAt)))
      this.indexRelation(relation, !source.tagCounts, !source.attentionUsers);
  }
  cancel(error: unknown) { this.failure ??= error; }
  async commit(save: (data: ExportData) => Promise<void>): Promise<number> {
    if (this.failure) throw this.failure;
    if (this.sealed) throw new Error('本地文件正在保存，请稍候再发送');
    this.sealed = true;
    if (this.count) await save(this.data);
    return this.count;
  }
  private guarded<T>(work: () => T): T {
    // Persistence and projection may await independently. A later click must
    // not mutate the records already handed to either of them.
    if (this.sealed) throw new Error('本地文件正在保存，请稍候再发送');
    try { if (this.failure) throw this.failure; return work(); }
    catch (error) { this.cancel(error); throw error; }
  }
  private message(id: string): ExportData['messages'][number] {
    const value = this.data.messages.find(message => message.id === id);
    if (!value) throw new Error(`本地文件中没有消息 ${id}`);
    return value;
  }
  private reference(ref: Reference) {
    const value = resolveReference(ref, (id, revision) => {
      const row = this.message(id);
      return revision === undefined || revision === row.revision ? row as unknown as CoreMessage : undefined;
    });
    if (value === undefined) throw new Error('引用的消息、版本或片段已不存在，请重新选择');
    return structuredClone(ref);
  }
  private parent(id: string) {
    if (id !== 'root' && !containers.has(this.message(id).relationType ?? '')) throw new Error('只有组织消息可以接收成员');
  }
  private indexRelation(relation: ExportData['relations'][number], tags = true, attention = true) {
    const refs = Array.isArray(relation.targetRefs) ? relation.targetRefs : [];
    const ids = refs.flatMap(ref => {
      const value = object(ref), id = object(value.reference).messageId ?? value.messageId ?? value.relationId;
      return typeof id === 'string' ? [id] : [];
    });
    for (const id of new Set(ids)) {
      if (tags && ['TAG', 'RECOMMEND', 'ARCHIVE'].includes(relation.relationType ?? '')) {
        const counts = this.data.tagCounts![id] ??= {};
        for (const label of [relation.relationType, object(relation.payload).subType ?? object(relation.payload).label])
          if (typeof label === 'string' && label) counts[label] = (counts[label] ?? 0) + 1;
      }
      if (attention && relation.relationType === 'ATTENTION') {
        const users = new Set(this.data.attentionUsers![id] ?? []);
        if (object(relation.payload).subType === 'NO') users.delete(relation.authorId);
        else users.add(relation.authorId);
        this.data.attentionUsers![id] = [...users];
      }
    }
  }
  private append(parts: Part[], type?: string, refs: Reference[] = [], sources: Reference[] = [], payload: Record<string, unknown> = {}): Message & Relation {
    const id = `local:${crypto.randomUUID()}`, createdAt = new Date().toISOString();
    const sequence = this.data.messages.reduce((max, message) => Math.max(max, message.sequence ?? 0), 0) + 1;
    const nativeParts: Part[] = [...parts, { id: 'local-origin', type: 'data', value: { format: 'gonglun-local-message', version: 1 } }];
    const content = textOf({ parts: nativeParts } as CoreMessage);
    const targetRefs = refs.map(reference => ({ kind: 'message' as const, messageId: reference.messageId, reference }));
    const kind = type === 'PROPOSAL' ? 'GOVERNANCE' : type === 'CODE_CHANGE' ? 'CODE' : type === 'OPERATIONS' ? 'OPERATIONS' : type ? 'RELATION' : 'TEXT';
    const message: Message & Relation = { id, sequence, revision: 1, parts: nativeParts, kind,
      contentType: 'TEXT', content, createdAt, updatedAt: createdAt, createdBy: this.user,
      relationType: type as Relation['relationType'], sourceMessageId: sources[0]?.messageId ?? null, sourceRefs: sources,
      targetRefs, payload: payload as Relation['payload'], relationPayload: payload as Relation['payload'],
      spending: { protocol: 0, wager: 0, recommendation: 0 } };
    const row: ExportData['messages'][number] = { ...message, author: this.user.username, authorId: this.user.id };
    this.data.messages.push(row);
    if (type) {
      const relation = { ...message, relationType: type, payload, targetRefs, author: this.user.username, authorId: this.user.id, supersededBy: null };
      this.data.relations.push(relation); this.indexRelation(relation);
    }
    this.count++;
    return message;
  }
  private latestMembership(memberId: string): MembershipAction | undefined {
    return this.data.relations.map(relation => object(relation.payload).membershipHistory as MembershipAction | undefined)
      .filter((action): action is MembershipAction => !!action && action.memberId === memberId)
      .sort((a, b) => b.order - a.order)[0];
  }
  private containing(memberId: string): string | null {
    const tracked = this.latestMembership(memberId);
    if (tracked) return tracked.parentId || null;
    const owners = this.data.relations.filter(relation => containers.has(relation.relationType ?? '')
      && Array.isArray(relation.targetRefs) && relation.targetRefs.some(ref => (ref.messageId ?? ref.relationId) === memberId));
    return owners.length === 1 ? owners[0]!.id : null;
  }
  private join(parentId: string, memberId: string): Relation {
    this.parent(parentId); this.message(memberId);
    const seen = new Set([memberId]);
    for (let parent: string | null = parentId; parent; parent = this.containing(parent)) {
      if (seen.has(parent)) throw new Error('分类不能包含自身或形成循环');
      seen.add(parent);
    }
    const previous = this.latestMembership(memberId), previousParentId = this.containing(memberId);
    const message = this.append([relationPart('member-of', { parent: [{ messageId: parentId }], member: [{ messageId: memberId }] })],
      'JOIN', [{ messageId: memberId }], [{ messageId: parentId }]);
    const action: MembershipAction = { id: message.id, memberId, parentId,
      previousId: previous?.id ?? null, previousParentId, order: message.sequence!,
      sourcePartId: 'relation', bindingId: 'member-0', sourceRevision: 1 };
    const payload = { membershipHistory: action };
    const parts: Part[] = [...message.parts!, { id: 'membership-history', type: 'data', value: payload as unknown as Json }];
    Object.assign(message, { payload, relationPayload: payload, parts });
    Object.assign(this.data.messages.at(-1)!, { relationPayload: payload, parts });
    Object.assign(this.data.relations.at(-1)!, { payload, parts });
    return message;
  }
  createMessage = async (parent: string, input: Parameters<typeof createMessage>[1]): Promise<Message> => this.guarded(() => {
    this.parent(parent);
    if (!input.content?.trim()) throw new Error('消息内容不能为空');
    const message = this.append([{ id: 'body', type: 'text', text: input.content }]);
    if (parent !== 'root') this.join(parent, message.id);
    return message;
  });
  createRelation = async (parent: string, input: Parameters<typeof createRelation>[1]): Promise<Relation> => this.guarded(() => {
    this.parent(parent);
    const type = input.relationType.toUpperCase(), payload: Record<string, unknown> = { ...object(input.payload), uiType: type };
    const refs = input.targetRefs.map(ref => this.reference(ref.reference ?? { messageId: ref.kind === 'relation' ? ref.relationId : ref.messageId }));
    const sources = (input.sourceRefs ?? (input.sourceMessageId ? [{ messageId: input.sourceMessageId }] : [])).map(ref => this.reference(ref));
    if (type === 'JOIN') {
      if (!input.sourceMessageId || refs.length !== 1) throw new Error('加入需要一个组织和一个成员');
      return this.join(input.sourceMessageId, refs[0]!.messageId);
    }
    let name = ({ ATTENTION: 'follow', CORRECT: 'amend', CODE_CHANGE: 'code-change' } as Record<string, string>)[type] ?? type.toLowerCase();
    if (type === 'DELEGATION') name = payload.delegationKind === 'FULFILL' ? 'fulfill' : 'delegate';
    if (type === 'PROPOSAL' || type === 'OPERATIONS') name = ({ DISTRIBUTE_REVENUE: 'distribute', RECHARGE: 'recharge', REVENUE_INJECTION: 'revenue-injection', TERMINATE_SETTLEMENT: 'terminate', UPDATE_RULES: 'rule-change' } as Record<string, string>)[String(payload.operationType)] ?? name;
    if (type === 'ARCHIVE' && ['SPAM', 'OFFTOPIC', 'LOWVALUE'].includes(String(payload.subType))) name = 'low-quality';
    const isContainer = containers.has(type);
    if (isContainer && refs.some(ref => ref.partId || ref.memberId || ref.path?.length || ref.range || ref.revision !== undefined))
      throw new Error('组织成员需要当前完整消息');
    const primary = relationPart(name, isContainer ? { members: refs } : { target: refs, ...(sources.length ? { source: sources } : {}) });
    if (name === 'follow' || name === 'block') {
      if (payload.subType !== 'YES' && payload.subType !== 'NO') throw new Error('请选择是或否');
      primary.reason = payload.subType;
    }
    const parts: Part[] = [primary];
    const content = payload.content ?? payload.title ?? payload.label;
    if (typeof content === 'string' && content && type !== 'CORRECT') parts.unshift({ id: 'body', type: 'text', text: content });
    if (type === 'CORRECT') {
      if (refs.length !== 1 || sources.length) throw new Error('更正需要一个明确目标，不能有来源');
      const target = this.message(refs[0]!.messageId) as unknown as CoreMessage;
      if (payload.correctionKind === 'WIDTH') {
        if (!Number.isInteger(payload.correctionWidth) || Number(payload.correctionWidth) < 320 || Number(payload.correctionWidth) > 2400) throw new Error('消息宽度应为 320 至 2400');
        primary.relation = 'correct';
      } else {
        const replacement = payload.correctionValue ?? payload.correctionContent;
        if (replacement === undefined) throw new Error('缺少更正内容');
        const updated = replaceReference(target, refs[0]!, replacement as Json);
        payload.expectedRevision = target.revision; payload.value = replacement;
        const part = target.parts.find(part => part.id === refs[0]!.partId);
        if (part && ['text', 'web', 'code'].includes(part.type)) {
          primary.relation = 'correct'; payload.correctionKind = 'TEXT'; payload.correctionBeforeContent = textOf(target);
          parts.unshift({ id: 'corrected-body', type: 'text', text: textOf({ ...target, parts: updated }) });
          payload.correctionContent = textOf({ ...target, parts: updated });
          payload.correctionAfterContent = payload.correctionContent; delete payload.correctionValue;
        }
      }
    }
    if (isContainer) {
      payload.independentMemberships = true;
      parts.push({ id: 'display', type: 'display', relationPartId: 'relation', layout: type === 'SUMMARY' ? 'summary'
        : payload.targetLayout === 'single-row' ? 'row' : payload.targetLayout === 'multi-column' ? 'columns' : 'flow' });
    }
    if (type === 'REFERENCE' && payload.label && !payload.content && !payload.title)
      parts.push({ id: 'display', type: 'display', relationPartId: 'relation', layout: 'relation' });
    if (name === 'low-quality') parts.push({ ...relationPart('archive', { target: refs }), id: 'personal-archive' });
    parts.push({ id: 'data', type: 'data', value: payload as Json });
    const commonParents = refs.map(ref => this.containing(ref.messageId));
    const outer = isContainer && commonParents.length ? commonParents.every(value => value === commonParents[0]) ? commonParents[0] : null : parent === 'root' ? null : parent;
    const message = this.append(parts, type, refs, sources, payload);
    if (isContainer) {
      if (outer) this.join(outer, message.id);
      for (const ref of refs) this.join(message.id, ref.messageId);
    } else if (parent !== 'root' && ['PROPOSAL', 'DELEGATION', 'CODE_CHANGE', 'OPERATIONS'].includes(type)) this.join(parent, message.id);
    return message;
  });
}
