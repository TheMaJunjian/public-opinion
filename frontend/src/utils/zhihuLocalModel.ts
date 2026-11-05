import { referenceKey, resolveReference, resolveStance, resolveMemberships, type Message as CoreMessage, type MembershipAction, type Part, type Reference, type ReferenceContext } from '@gonglun/core';
import { correctionBase } from './zhihuCorrections';
import { isCardWidth } from './cardWidth';
import type {
  ZhihuViewingData, ZhihuLocalOperations, ZhihuLocalMessage, ZhihuLocalOperation,
  ZhihuLocalSendInput, ZhihuReplyDefinition, ZhihuMessageSource, ZhihuLocalCorrection,
} from './zhihuArchive';

const ORGANIZATIONS = new Set<string>(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE']);
const AUTHOR = { id: 'zhihu:local-editor', name: '本地整理者' };
function fail(message: string): never { throw new Error(message); }
function hash(value: string): string {
  let result = 14695981039346656037n;
  for (const character of value) result = BigInt.asUintN(64, (result ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
  return result.toString(16).padStart(16, '0');
}
const stanceId = (operation: ZhihuLocalOperation, target: string) => `zhihu:local:${encodeURIComponent(operation.id)}:${hash(target)}`;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function selections(value: unknown, label: string, preserveRepeatedIds = false): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id)) return fail(`${label}必须是消息编号集合`);
  return preserveRepeatedIds ? value as string[] : [...new Set(value as string[])];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
// eslint-disable-next-line no-control-regex -- Imported identifiers must reject ASCII control characters.
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/.test(value);
const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Retain native addresses; malformed imports must never widen a fragment into a whole message. */
export function validateZhihuLocalReferences(value: unknown, ids: string[], label: string): Reference[] {
  if (!Array.isArray(value) || value.length !== ids.length) fail(`${label}地址与消息编号必须逐项对应`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!object(entry) || entry.messageId !== ids[index] || !validId(entry.messageId)
      || Object.keys(entry).some(key => !['messageId', 'revision', 'partId', 'memberId', 'path', 'range', 'context'].includes(key))) fail(`${label}消息地址无效`);
    for (const field of ['partId', 'memberId']) if (entry[field] !== undefined && !validId(entry[field])) fail(`${label}部件编号无效`);
    if (entry.revision !== undefined && !validRevision(entry.revision)) fail(`${label}版本无效`);
    if (entry.memberId !== undefined && entry.partId === undefined) fail(`${label}成员缺少所属部件`);
    if (entry.path !== undefined && (!Array.isArray(entry.path) || entry.path.length > 64 || entry.path.some(key =>
      typeof key !== 'string' && !(typeof key === 'number' && Number.isSafeInteger(key) && key >= 0)
      || ['__proto__', 'prototype', 'constructor'].includes(String(key))))) fail(`${label}字段路径无效`);
    if (entry.range !== undefined && (!object(entry.range) || Object.keys(entry.range).some(key => !['start', 'end'].includes(key))
      || !Number.isSafeInteger(entry.range.start) || !Number.isSafeInteger(entry.range.end)
      || (entry.range.start as number) < 0 || (entry.range.end as number) <= (entry.range.start as number))) fail(`${label}文字范围无效`);
    if (entry.context !== undefined) {
      const context = entry.context;
      if (!object(context) || !['BODY', 'MEANING', 'MESSAGE', 'CORRECTION', 'ROUND', 'UNKNOWN'].includes(context.kind as string)
        || Object.keys(context).some(key => !['kind', 'version', 'follow'].includes(key))
        || context.follow !== undefined && (!['BODY', 'MEANING'].includes(context.kind as string) || context.follow !== true)) fail(`${label}正文语境无效`);
      const version = context.version;
      if (['BODY', 'MEANING'].includes(context.kind as string) && version === undefined) fail(`${label}正文语境缺少版本`);
      if (version !== undefined) {
        if (!['BODY', 'MEANING', 'MESSAGE'].includes(context.kind as string) || !object(version) || version.format !== 2
          || version.messageId !== entry.messageId || !validRevision(version.revision) || !Array.isArray(version.corrections)
          || version.corrections.length > 10000 || Object.keys(version).some(key => !['format', 'messageId', 'revision', 'corrections'].includes(key))) fail(`${label}正文版本无效`);
        const corrections = new Set<string>();
        for (const correction of version.corrections) {
          if (!object(correction) || !validId(correction.messageId) || !validRevision(correction.revision)
            || !['TEXT', 'MEANING'].includes(correction.kind as string) || corrections.has(correction.messageId)
            || Object.keys(correction).some(key => !['messageId', 'revision', 'kind'].includes(key))) fail(`${label}正文更正版本无效`);
          corrections.add(correction.messageId);
        }
      }
    }
    const reference: Reference = { messageId: entry.messageId,
      ...(entry.revision !== undefined ? { revision: entry.revision as number } : {}),
      ...(entry.partId !== undefined ? { partId: entry.partId as string } : {}),
      ...(entry.memberId !== undefined ? { memberId: entry.memberId as string } : {}),
      ...(entry.path !== undefined ? { path: [...entry.path as (string | number)[]] } : {}),
      ...(entry.range !== undefined ? { range: { ...entry.range as { start: number; end: number } } } : {}),
      ...(entry.context !== undefined ? { context: structuredClone(entry.context) as ReferenceContext } : {}) };
    const key = referenceKey(reference);
    if (seen.has(key)) fail(`${label}包含重复地址`); seen.add(key);
    return reference;
  });
}
function checkedText(value: unknown, label: string, max = 1_000_000): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) return fail(`${label}必须是有效文字`);
  return value;
}

/** Build one immutable local event. No source comments or legacy parent overrides are changed. */
export function buildZhihuLocalSend(data: ZhihuViewingData, input: ZhihuLocalSendInput): ZhihuLocalOperations {
  if (!input || !['REPLY', 'AGREE', 'DISAGREE', 'CORRECT', ...ORGANIZATIONS].includes(input.relationType)) fail('本地关系类型无效');
  const isStance = input.relationType === 'AGREE' || input.relationType === 'DISAGREE';
  if (!isStance && (input.targetReferences !== undefined || input.sourceReferences !== undefined)) fail('只有赞同或反对可以使用消息部件地址');
  const sources = selections(input.sourceMessageIds || [], '来源', isStance && input.sourceReferences !== undefined);
  const targets = selections(input.targetMessageIds, '目标', isStance && input.targetReferences !== undefined);
  const note = checkedText(input.note, '操作说明', 10000), content = checkedText(input.content, '正文');
  const title = checkedText(input.title, '标题', 10000).trim();
  const parent = input.currentClassificationId ?? null;
  for (const id of [...sources, ...targets]) {
    const meta = data.zhihu.byMessageId[id];
    if (!meta || meta.kind === 'membership' || data.messages.find(message => message.id === id)?.supersededBy) fail('只能选择当前文档中的外显消息');
  }
  const type = input.relationType, id = crypto.randomUUID(), createdAt = new Date().toISOString();
  if (type !== 'CORRECT' && (input.correctionKind !== undefined || input.correctionWidth !== undefined)) fail('只有更正可以调整消息宽度');
  if (type === 'CORRECT' && input.correctionKind !== undefined && !['TEXT', 'WIDTH'].includes(input.correctionKind)) fail('本地更正类型无效');
  const messages: ZhihuLocalMessage[] = [];
  const operation: ZhihuLocalOperation = { id, type, createdAt, sourceMessageIds: sources, targetRelationIds: [], note,
    currentClassificationId: parent, createdMessageIds: [], memberMessageIds: targets };
  const add = (value: Omit<ZhihuLocalMessage, 'id' | 'operationId' | 'createdAt'>) => {
    const message = { id: `zhihu:added:${id}:${messages.length}`, operationId: id, createdAt, ...value };
    messages.push(message); return message;
  };
  if (type === 'CORRECT') {
    if (sources.length || targets.length !== 1) fail('本地更正只能选择一个目标，来源集合须留空');
    if (title || input.targetLayout !== undefined) fail('更正不能编辑成员结构或排列方式');
    operation.mode = 'create';
    let message: ZhihuLocalMessage;
    if (input.correctionKind === 'WIDTH') {
      if (!isCardWidth(input.correctionWidth) || content !== '' || input.correctionField !== undefined) fail('宽度调整须为 320–2400 的整数，且不能夹带正文或标题更正');
      message = add({ kind: 'relation', relationType: 'CORRECT', sourceMessageId: null, targetMessageIds: targets, content: '',
        correctionKind: 'WIDTH', correctionWidth: input.correctionWidth, authorId: AUTHOR.id, author: AUTHOR.name });
    } else {
      if (input.correctionWidth !== undefined) fail('正文更正不能夹带宽度调整');
      if (input.content === undefined || !content.trim()) fail('请输入更正后的完整文字');
      const correction = correctionBase(data, targets[0], input.correctionField ?? 'body');
      message = add({ kind: 'relation', relationType: 'CORRECT', sourceMessageId: null, targetMessageIds: targets, content,
        correction, authorId: AUTHOR.id, author: AUTHOR.name });
    }
    operation.targetRelationIds = [message.id];
  } else if (type === 'REPLY') {
    if (!sources.length || !targets.length) fail('回复至少需要一条来源和一个目标');
    operation.mode = 'create';
    for (const sourceMessageId of sources) add({ kind: 'relation', relationType: 'REPLY', sourceMessageId, targetMessageIds: targets, content: note });
    operation.targetRelationIds = messages.map(message => message.id);
  } else if (type === 'AGREE' || type === 'DISAGREE') {
    if (!targets.length) fail('请选择要赞同或反对的消息、文字片段或关系');
    if (title || content || input.targetLayout !== undefined || input.correctionField !== undefined) fail('赞同或反对不能夹带未发送的正文或组织设置');
    operation.mode = 'stance'; operation.targetRelationIds = targets;
    operation.targetReferences = validateZhihuLocalReferences(input.targetReferences ?? targets.map(messageId => ({ messageId })), targets, '表态目标');
    operation.sourceReferences = validateZhihuLocalReferences(input.sourceReferences ?? sources.map(messageId => ({ messageId })), sources, '表态来源');
  } else if (sources.length) {
    if (sources.length !== 1 || data.messages.find(message => message.id === sources[0])?.relationType !== type) fail('追加成员只能选择一个同类型组织作为来源');
    if (content.trim() || title) fail('追加成员不创建正文或改名，请清空文字后追加');
    if (!targets.length) fail('追加组织至少需要一个目标');
    operation.mode = 'append'; operation.targetRelationIds = sources;
    const container = data.relations.find(relation => relation.id === sources[0]);
    const navigationMembers = (container?.payload as { sourceNavigation?: boolean } | undefined)?.sourceNavigation
      ? new Set((Array.isArray(container?.targetRefs) ? container.targetRefs : []).flatMap((reference: { messageId?: string; relationId?: string }) => {
        const ref = reference as { messageId?: string; relationId?: string };
        return ref.messageId || ref.relationId ? [ref.messageId || ref.relationId!] : [];
      })) : new Set<string>();
    const additions = targets.filter(target => data.zhihu.membershipParents[target] !== sources[0]
      && !(data.zhihu.membershipParents[target] == null && navigationMembers.has(target)));
    if (!additions.length) return data.zhihu.localOperations;
    operation.memberMessageIds = additions;
  } else {
    operation.mode = 'create';
    const targetLayout = input.targetLayout ?? (type === 'SUMMARY' || type === 'MERGE' ? 'multi-column' : type === 'ARRANGE' ? 'single-column' : undefined);
    if (targetLayout !== undefined && !['single-column', 'multi-column', 'single-row'].includes(targetLayout)) fail('组织排列方式无效');
    if (type === 'ARRANGE' && targetLayout === 'multi-column') fail('排列只支持横向或纵向');
    const heading = title || (type === 'CLASSIFY' || type === 'SUMMARY' ? content.trim() : '');
    if ((type === 'CLASSIFY' || type === 'SUMMARY') && !heading) fail(type === 'CLASSIFY' ? '分类名称不能为空' : '总结内容不能为空');
    const members = [...targets];
    if ((type === 'MERGE' || type === 'ARRANGE') && content.trim()) {
      const text = add({ kind: 'text', sourceMessageId: null, targetMessageIds: [], content });
      if (type === 'ARRANGE') members.push(text.id);
    }
    if (type !== 'CLASSIFY' && !members.length) fail('该组织至少需要一个目标消息');
    const organization = add({ kind: 'relation', relationType: type, sourceMessageId: null, targetMessageIds: members,
      content: type === 'CLASSIFY' || type === 'SUMMARY' ? content || heading : '',
      ...(heading ? { title: heading } : {}), ...(targetLayout ? { targetLayout } : {}) });
    operation.targetRelationIds = [organization.id];
  }
  operation.createdMessageIds = messages.map(message => message.id);
  // A saved original reply version remains verifiable even after a later source refresh.
  const definitions = new Map(data.zhihu.localOperations.replyDefinitions.map(reply => [reply.id, reply]));
  const referenced = new Set([...sources, ...targets, ...(parent ? [parent] : [])]);
  for (const reply of data.zhihu.replyRelations) if (referenced.has(reply.id) && reply.id.startsWith('zhihu:reply:')) definitions.set(reply.id, reply);
  return { ...data.zhihu.localOperations, replyDefinitions: [...definitions.values()],
    messages: [...data.zhihu.localOperations.messages, ...messages], operations: [...data.zhihu.localOperations.operations, operation] };
}

/** Project additive local records and native placement history over the unchanged source view. */
export function projectZhihuLocalAdditions(data: ZhihuViewingData, baseReplies: ReadonlyMap<string, ZhihuReplyDefinition>, options: { nativeBase?: boolean } = {}): ZhihuViewingData {
  const { localOperations: log, byMessageId: metadata } = data.zhihu;
  const byId = new Map(data.messages.map(message => [message.id, message]));
  const relationById = new Map(data.relations.map(relation => [relation.id, relation]));
  const available = new Set([...byId.keys(), ...baseReplies.keys()]);
  const additions = new Map(log.messages.map(message => [message.id, message]));
  const usedMessages = new Set<string>();
  const actions: MembershipAction[] = options.nativeBase ? data.relations.flatMap(relation => {
    const action = (relation.payload as { membershipHistory?: MembershipAction } | undefined)?.membershipHistory;
    return relation.relationType === 'JOIN' && action?.id === relation.id && typeof action.memberId === 'string'
      && typeof action.parentId === 'string' && Number.isSafeInteger(action.order) ? [action] : [];
  }) : [];
  let membershipOrder = actions.reduce((max, action) => Math.max(max, action.order), 0);
  const nativeActionIds = new Set(actions.map(action => action.id));
  const navigationParents = new Map<string, Set<string>>();
  for (const relation of data.relations) if ((relation.payload as { sourceNavigation?: boolean } | undefined)?.sourceNavigation) {
    for (const target of relation.targetRefs as Array<{ messageId?: string; relationId?: string }>) {
      const member = target.messageId || target.relationId;
      if (member && byId.has(member)) {
        const parents = navigationParents.get(member) || new Set<string>();
        parents.add(relation.id); navigationParents.set(member, parents);
      }
    }
  }
  const actionTimes = new Map<string, string>();
  const actionSequences = new Map<string, number>();
  let displaySequence = options.nativeBase ? data.messages.reduce((max, message) => Math.max(max, Number(message.sequence) || 0), data.messages.length) : data.messages.length;
  const latestStances = new Map<string, { type: 'AGREE' | 'DISAGREE'; messageId: string }>();
  const correctionRecords: Array<{ message: ZhihuLocalMessage; applicable: boolean }> = [];
  const inactive = () => new Set([...latestStances].flatMap(([id, stance]) => stance.type === 'DISAGREE' ? [id] : []));
  const resolved = () => resolveMemberships(actions, inactive());
  const navigationParent = (member: string): string | null => {
    const parents = [...navigationParents.get(member) || []].filter(parent => !inactive().has(parent));
    return parents.length === 1 ? parents[0] : null;
  };
  const typeOf = (id: string) => byId.get(id)?.relationType || (baseReplies.has(id) ? 'REPLY' : null);
  const isOrganization = (id: string) => ORGANIZATIONS.has(typeOf(id) || '');
  const resolver = (id: string, revision?: number): CoreMessage | undefined => {
    const message = byId.get(id);
    return message?.parts && (revision === undefined || revision === (message.revision ?? 1))
      ? { ...message, revision: message.revision ?? 1 } as unknown as CoreMessage : undefined;
  };
  function checkReference(reference: Reference) {
    if (!byId.has(reference.messageId) && baseReplies.has(reference.messageId) && !reference.partId && !reference.range
      && !reference.memberId && !reference.path?.length && !reference.context) return; // Verified historical reply, not a current target.
    const value = resolveReference(reference, resolver);
    if (value === undefined || reference.range && (typeof value !== 'string' || !value.length)) fail('本地表态地址的版本、部件或文字范围不存在');
  }
  function structuralTarget(reference: Reference): string | null {
    const message = byId.get(reference.messageId);
    if (!message || !typeOf(message.id) || reference.memberId || reference.range || reference.path?.length
      || reference.context && !['MESSAGE', 'UNKNOWN', 'CORRECTION'].includes(reference.context.kind)) return null;
    if (!reference.partId) return message.id;
    const part = message.parts?.find(part => part.id === reference.partId);
    return part?.type === 'relation' && (ORGANIZATIONS.has(part.relation.toUpperCase()) || ['correct', 'amend'].includes(part.relation)) ? message.id : null;
  }
  if (options.nativeBase) {
    const stances = data.messages.filter(message => ['AGREE', 'DISAGREE'].includes(message.relationType || ''))
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0) || a.createdAt.localeCompare(b.createdAt));
    for (const message of stances) for (const part of message.parts || []) if (part.type === 'relation' && ['agree', 'disagree'].includes(part.relation)) {
      for (const target of part.roles.target || []) {
        const resolved = resolveStance(target.reference, part.relation === 'agree' ? 'pro' : 'con', resolver);
        const structure = structuralTarget(resolved.target);
        if (structure) latestStances.set(structure, { type: resolved.side === 'pro' ? 'AGREE' : 'DISAGREE', messageId: message.id });
      }
    }
  }
  function meta(id: string, kind: ZhihuMessageSource['kind'], at: string, extra: Partial<ZhihuMessageSource> = {}): ZhihuMessageSource {
    return { kind, threadId: `local:${data.zhihu.archiveId}`, sourceId: id, sourceUrl: null, authorName: AUTHOR.name,
      createdAt: at || null, createdAtText: null, sourceLabels: [], ...extra };
  }
  function addText(message: ZhihuLocalMessage) {
    const record = { id: message.id, sequence: ++displaySequence, revision: 1, kind: 'TEXT', contentType: 'TEXT', content: message.content,
      authorId: AUTHOR.id, author: AUTHOR.name, createdAt: message.createdAt, parts: [{ id: 'body', type: 'text' as const, text: message.content }] };
    data.messages.push(record); byId.set(record.id, record); metadata[record.id] = meta(record.id, 'local-text', message.createdAt); available.add(record.id);
  }
  function addRelation(input: { id: string; type: string; sourceMessageId: string | null; targets: string[]; createdAt: string; content?: string;
    title?: string; layout?: ZhihuLocalMessage['targetLayout']; kind: ZhihuMessageSource['kind']; membership?: MembershipAction; supersededBy?: string | null; sequence?: number;
    correction?: ZhihuLocalCorrection; applicable?: boolean; correctionWidth?: number; targetReferences?: Reference[]; sourceReferences?: Reference[] }) {
    const organization = ORGANIZATIONS.has(input.type), id = input.id;
    const widthCorrection = input.correctionWidth !== undefined;
    const correctionReference = input.correction ? { messageId: input.correction.targetMessageId, revision: 1,
      partId: input.correction.field === 'title' ? 'source-fields' : 'body', ...(input.correction.field === 'title' ? { path: ['value', 'title'] } : {}) } : undefined;
    const targetRefs = input.targets.map((messageId, index) => input.targetReferences ? (() => {
      const reference = input.targetReferences[index];
      if (reference.range) {
        const text = resolveReference(reference, resolver) as string;
        return { kind: 'text-fragment' as const, messageId, reference, text, hash: hash(text) };
      }
      return typeOf(messageId) ? { kind: 'relation' as const, relationId: messageId, reference } : { kind: 'message' as const, messageId, reference };
    })() : correctionReference ? { kind: 'message' as const, messageId, reference: correctionReference }
      : !widthCorrection && isOrganization(messageId) ? { kind: 'relation' as const, relationId: messageId } : { kind: 'message' as const, messageId });
    const references = input.targets.map((messageId, index) => ({ id: `member-${index}`, reference: input.targetReferences?.[index] || correctionReference || { messageId } }));
    const sourceReferences = input.sourceReferences || (input.sourceMessageId ? [{ messageId: input.sourceMessageId }] : []);
    const roles: Extract<Part, { type: 'relation' }>['roles'] = input.membership
      ? { member: references, ...(input.sourceMessageId ? { parent: [{ id: 'parent', reference: { messageId: input.sourceMessageId } }] } : {}) }
      : organization ? { members: references }
      : { target: references, ...(sourceReferences.length ? { source: sourceReferences.map((reference, index) => ({ id: `source-${index}`, reference })) } : {}) };
    const parts: Part[] = [...(input.content !== undefined ? [{ id: input.correction ? 'corrected-body' : 'body', type: 'text' as const, text: input.content }] : []),
      { id: 'relation', type: 'relation', relation: input.membership ? 'member-of' : input.type.toLowerCase(), roles }];
    if (input.type === 'CLASSIFY') parts.push({ id: 'source-fields', type: 'data', value: { title: input.title || '' } });
    if (input.correction) parts.push({ id: 'data', type: 'data', value: { correctionKind: 'TEXT', correctionBeforeContent: input.correction.baseContent,
      localCorrectionField: input.correction.field, localCorrectionApplicable: input.applicable !== false, baseFingerprint: input.correction.baseFingerprint } });
    if (input.correctionWidth !== undefined) parts.push({ id: 'data', type: 'data', value: { correctionKind: 'WIDTH', correctionWidth: input.correctionWidth } });
    if (input.layout) parts.push({ id: 'display', type: 'display', relationPartId: 'relation', layout: input.layout === 'single-row' ? 'row' : input.layout === 'multi-column' ? 'columns' : 'flow', order: references.map(reference => reference.id) });
    const payload = { source: 'zhihu-local-view', label: input.type === 'AGREE' ? '本地赞同' : input.type === 'DISAGREE' ? '本地反对' : widthCorrection ? '本地宽度调整' : input.correction ? '本地更正' : '本地整理',
      ...(organization ? { independentMemberships: true } : {}), ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.type === 'CLASSIFY' ? { separateTitle: true } : {}),
      ...(input.correction ? { correctionKind: 'TEXT', correctionBeforeContent: input.correction.baseContent, correctionAfterContent: input.content,
        correctionContent: input.content, correctionValue: input.content, localCorrectionField: input.correction.field,
        localCorrectionApplicable: input.applicable !== false, baseFingerprint: input.correction.baseFingerprint } : {}),
      ...(widthCorrection ? { correctionKind: 'WIDTH', correctionWidth: input.correctionWidth } : {}),
      ...(input.layout ? { targetLayout: input.layout } : {}), ...(input.membership ? { membershipHistory: input.membership } : {}) };
    const sequence = input.sequence ?? ++displaySequence;
    const relation = { id, sequence, revision: 1, parts, relationType: input.type, sourceMessageId: input.sourceMessageId,
      ...(input.sourceReferences ? { sourceRefs: sourceReferences } : {}), targetRefs, payload,
      createdAt: input.createdAt, authorId: AUTHOR.id, author: AUTHOR.name, supersededBy: input.supersededBy || null };
    const message = { ...relation, kind: 'RELATION', contentType: 'TEXT', content: input.content || '', relationPayload: payload };
    data.messages.push(message); data.relations.push(relation); byId.set(id, message); relationById.set(id, relation); available.add(id);
    metadata[id] = meta(id, input.kind, input.createdAt, { ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}), targetMessageIds: [...input.targets], active: true });
    if (input.correction) Object.assign(metadata[id], { sourceLabels: ['本地更正'], correctionKind: 'TEXT', correctionField: input.correction.field, correctionApplicable: input.applicable !== false });
    if (widthCorrection) Object.assign(metadata[id], { sourceLabels: ['本地宽度调整'], correctionKind: 'WIDTH', correctionWidth: input.correctionWidth, correctionApplicable: true });
  }
  function placement(memberId: string, parentId: string | null, eventId: string, time: string) {
    const before = resolved().effective.get(memberId);
    if ((before?.parentId || null) === parentId && (before || parentId === null)) return;
    const action: MembershipAction = { id: `zhihu:join:${eventId}:${actions.length}`, memberId, parentId: parentId || '',
      previousId: before?.id || null, previousParentId: before?.parentId || null, order: ++membershipOrder };
    actions.push(action); actionTimes.set(action.id, time);
    actionSequences.set(action.id, ++displaySequence);
  }
  function checkCycle(changes: Array<[string, string | null]>) {
    const parents = new Map([...navigationParents].map(([member, values]) => [member, new Set(values)]));
    const current = resolved();
    if (options.nativeBase) for (const relation of data.relations) {
      const payload = relation.payload as { independentMemberships?: boolean; sourceNavigation?: boolean } | undefined;
      if (!ORGANIZATIONS.has(relation.relationType || '') || payload?.independentMemberships || payload?.sourceNavigation) continue;
      for (const reference of (relation.targetRefs || []) as Array<{ messageId?: string; relationId?: string }>) {
        const member = reference.messageId || reference.relationId; if (!member || current.trackedMembers.has(member)) continue;
        const values = parents.get(member) || new Set<string>(); values.add(relation.id); parents.set(member, values);
      }
    }
    for (const [member, action] of current.effective) {
      const values = new Set(navigationParents.get(member));
      if (action.parentId) values.add(action.parentId); parents.set(member, values);
    }
    for (const [member, parent] of changes) {
      const values = new Set(navigationParents.get(member));
      if (parent) values.add(parent); parents.set(member, values);
    }
    for (const [member] of changes) {
      const active = new Set<string>(), finished = new Set<string>();
      const visit = (id: string) => {
        if (active.has(id)) fail('组织不能包含自身或形成循环嵌套');
        if (finished.has(id)) return;
        active.add(id); for (const parent of parents.get(id) || []) visit(parent);
        active.delete(id); finished.add(id);
      };
      visit(member);
    }
  }
  function ensureAvailable(ids: string[]) {
    for (const id of ids) if (!available.has(id) || metadata[id]?.kind === 'membership') fail('本地操作引用了不存在于当前文档的消息');
  }
  function ensureParent(parent: string | null | undefined) {
    if (parent && (!isOrganization(parent) || inactive().has(parent))) fail('所在分类不是当前有效组织');
  }
  // Base question/type membership is the starting placement for local moves and
  // rollbacks. It is generated navigation, never an edit to the source archive.
  const hasOrganizationMoves = log.operations.some(operation => operation.mode && ORGANIZATIONS.has(operation.type));
  const nativeTrackedMembers = options.nativeBase ? new Set(actions.map(action => action.memberId)) : null;
  const nativeMovingMembers = options.nativeBase ? new Set(log.operations.flatMap(operation => [...(operation.memberMessageIds || []), ...operation.sourceMessageIds])) : null;
  for (const relation of [...data.relations]) if (hasOrganizationMoves && !(relation.payload as { sourceNavigation?: boolean } | undefined)?.sourceNavigation
    && ['question', 'type-category', 'source-category', 'source-folder'].includes(metadata[relation.id]?.kind)) {
    relation.payload = { ...(relation.payload as object), independentMemberships: true };
    const message = byId.get(relation.id)!; message.relationPayload = relation.payload;
    for (const reference of relation.targetRefs as Array<{ messageId?: string; relationId?: string }>) {
      const id = reference.messageId || reference.relationId;
      if (id && byId.has(id)) {
        if (nativeMovingMembers && !nativeMovingMembers.has(id)) continue;
        if (nativeTrackedMembers?.has(id)) continue;
        let sourceOrder = actions.length;
        while (options.nativeBase && nativeActionIds.has(`zhihu:join:source:${sourceOrder}`)) sourceOrder++;
        const action: MembershipAction = { id: `zhihu:join:source:${sourceOrder}`, memberId: id, parentId: relation.id,
          previousId: null, previousParentId: null, order: ++membershipOrder };
        actions.push(action); actionTimes.set(action.id, ''); actionSequences.set(action.id, ++displaySequence);
        nativeActionIds.add(action.id);
        nativeTrackedMembers?.add(id);
      }
    }
  }
  for (const operation of log.operations) {
    if (!operation.mode) {
      if (operation.type === 'AGREE' || operation.type === 'DISAGREE') for (const target of operation.targetRelationIds)
        latestStances.set(target, { type: operation.type, messageId: stanceId(operation, target) });
      continue;
    }
    if (operation.overrideRevisionIds !== undefined) fail('新增本地记录不能改写旧父楼修订');
    const members = operation.memberMessageIds || [], createdIds = operation.createdMessageIds || [], parent = operation.currentClassificationId || null;
    ensureAvailable(operation.sourceMessageIds); ensureParent(parent);
    if (operation.mode === 'stance') {
      if (!['AGREE', 'DISAGREE'].includes(operation.type) || createdIds.length) fail('本地赞同或反对记录格式无效');
      ensureAvailable(operation.targetRelationIds);
      const nativeReferences = operation.targetReferences !== undefined;
      if (nativeReferences && !equal(members, operation.targetRelationIds)) fail('本地表态地址与目标记录不一致');
      const targetReferences = operation.targetReferences || operation.targetRelationIds.map(messageId => ({ messageId }));
      const sourceReferences = operation.sourceReferences || operation.sourceMessageIds.map(messageId => ({ messageId }));
      for (const reference of [...sourceReferences, ...targetReferences]) checkReference(reference);
      const sourceIds = [...new Set(sourceReferences.map(reference => reference.messageId))];
      const sourceGroups = sourceIds.length ? sourceIds.map(id => sourceReferences.filter(reference => reference.messageId === id)) : [[]];
      const records: Array<{ id: string; target: Reference; sources: Reference[] }> = [];
      const previousParents = new Map([...navigationParents.keys()].map(member => [member, navigationParent(member)]));
      for (const [member, action] of resolved().effective) previousParents.set(member, action.parentId || null);
      for (const target of targetReferences) {
        if (!nativeReferences && (operation.type !== 'DISAGREE' || typeOf(target.messageId) !== 'REPLY' && !['local-organization', 'local-correction'].includes(metadata[target.messageId]?.kind))) fail('旧反对只能指向回复关系、本地组织或更正，不能隐藏原文');
        const resolvedTarget = resolveStance(target, operation.type === 'AGREE' ? 'pro' : 'con', resolver);
        const structure = structuralTarget(resolvedTarget.target);
        for (const sources of sourceGroups) {
          const id = nativeReferences ? stanceId(operation, JSON.stringify([referenceKey(target), sources[0]?.messageId || null])) : stanceId(operation, target.messageId);
          if (structure) latestStances.set(structure, { type: resolvedTarget.side === 'pro' ? 'AGREE' : 'DISAGREE', messageId: id });
          records.push({ id, target, sources });
        }
      }
      // A batch may reject the current organization and several ancestors.
      // Place its records in the closest surviving pre-batch scope, never back
      // inside a rejected container via an implicit JOIN creation.
      let destination = parent;
      const excluded = inactive(), walked = new Set<string>();
      while (destination && excluded.has(destination) && !walked.has(destination)) {
        walked.add(destination); destination = previousParents.get(destination) || null;
      }
      for (const { id, target, sources } of records) {
        if (!byId.has(target.messageId) || sources.some(reference => !byId.has(reference.messageId))) continue; // Verified old source versions remain history only.
        addRelation({ id, type: operation.type, sourceMessageId: sources[0]?.messageId || null, targets: [target.messageId], createdAt: operation.createdAt,
          ...(nativeReferences ? { targetReferences: [target], sourceReferences: sources } : {}), content: operation.note || undefined, kind: 'local-operation' });
        placement(id, destination, operation.id, operation.createdAt);
      }
      continue;
    }
    if (operation.mode === 'append') {
      const container = operation.sourceMessageIds[0];
      if (!ORGANIZATIONS.has(operation.type) || operation.sourceMessageIds.length !== 1 || typeOf(container) !== operation.type
        || !equal(operation.targetRelationIds, [container]) || !members.length || createdIds.length || inactive().has(container)) fail('追加记录必须指向同类型有效组织');
      ensureAvailable(members); checkCycle(members.map(member => [member, container]));
      for (const member of members) placement(member, container, operation.id, operation.createdAt);
      continue;
    }
    if (operation.mode !== 'create' || !createdIds.length) fail('本地创建记录缺少消息');
    const created = createdIds.map(id => additions.get(id) || fail('本地操作缺少对应消息定义'));
    for (const message of created) {
      if (available.has(message.id) || usedMessages.has(message.id) || message.operationId !== operation.id || message.createdAt !== operation.createdAt) fail('本地消息与创建记录不一致');
      usedMessages.add(message.id);
    }
    ensureAvailable(members);
    if (operation.type === 'CORRECT') {
      const message = created[0], correction = message?.correction;
      if (created.length !== 1 || operation.sourceMessageIds.length || members.length !== 1 || !equal(operation.targetRelationIds, createdIds)
        || message.kind !== 'relation' || message.relationType !== 'CORRECT' || message.sourceMessageId !== null
        || !equal(message.targetMessageIds, members) || message.title !== undefined || message.targetLayout !== undefined
        || message.authorId !== AUTHOR.id || message.author !== AUTHOR.name) fail('本地更正定义与目标或作者不一致');
      if (inactive().has(members[0])) fail('不能更正已失效的组织或关系');
      if (message.correctionKind === 'WIDTH') {
        if (!isCardWidth(message.correctionWidth) || correction || message.content !== '' || !byId.has(members[0])) fail('宽度调整需要一个当前完整消息，不能修改正文');
        addRelation({ id: message.id, type: 'CORRECT', sourceMessageId: null, targets: members,
          createdAt: message.createdAt, kind: 'local-correction', correctionWidth: message.correctionWidth });
        placement(message.id, parent, operation.id, operation.createdAt);
        continue;
      }
      if (!correction || correction.targetMessageId !== members[0] || !message.content.trim()) fail('本地更正定义与目标或正文不一致');
      const current = correctionBase(data, members[0], correction.field);
      const applicable = current.baseFingerprint === correction.baseFingerprint && current.baseContent === correction.baseContent && current.baseStatus === correction.baseStatus;
      if (!applicable) data.zhihu.warnings.push(`更正 ${message.id} 的原始${correction.field === 'title' ? '标题' : '正文'}已变化；保留本地记录，未套用到新的原站内容。`);
      addRelation({ id: message.id, type: 'CORRECT', sourceMessageId: null, targets: members, content: message.content,
        createdAt: message.createdAt, kind: 'local-correction', correction, applicable });
      correctionRecords.push({ message, applicable });
      placement(message.id, parent, operation.id, operation.createdAt);
      continue;
    }
    if (operation.type === 'REPLY') {
      if (!operation.sourceMessageIds.length || !members.length || created.length !== operation.sourceMessageIds.length || !equal(operation.targetRelationIds, createdIds)) fail('新增回复的来源或目标记录无效');
      created.forEach((message, index) => {
        if (message.kind !== 'relation' || message.relationType !== 'REPLY' || message.sourceMessageId !== operation.sourceMessageIds[index]
          || !equal(message.targetMessageIds, members) || message.title !== undefined || message.targetLayout !== undefined) fail('新增回复定义与来源目标不一致');
        addRelation({ id: message.id, type: 'REPLY', sourceMessageId: message.sourceMessageId, targets: members,
          content: message.content || undefined, createdAt: message.createdAt, kind: 'reply' });
        data.zhihu.replyRelations.push({ id: message.id, threadId: metadata[message.sourceMessageId!]?.threadId || `local:${data.zhihu.archiveId}`,
          commentId: metadata[message.sourceMessageId!]?.sourceId || message.sourceMessageId!, sourceMessageId: message.sourceMessageId!, targetMessageIds: [...members],
          source: 'manual', method: 'manual', createdAt: message.createdAt, authorId: AUTHOR.id, author: AUTHOR.name, active: true, current: true });
        placement(message.id, parent, operation.id, operation.createdAt);
      });
      continue;
    }
    if (!ORGANIZATIONS.has(operation.type) || operation.sourceMessageIds.length) fail('本地组织创建记录无效');
    const organization = created.at(-1)!;
    const texts = created.slice(0, -1);
    if (organization.kind !== 'relation' || organization.relationType !== operation.type || organization.sourceMessageId !== null
      || !equal(operation.targetRelationIds, [organization.id]) || texts.length > 1
      || texts.some(message => message.kind !== 'text' || message.sourceMessageId !== null || message.targetMessageIds.length)) fail('本地组织消息与创建记录不一致');
    if (texts.length && !['MERGE', 'ARRANGE'].includes(operation.type)) fail('分类或总结不能夹带独立文本');
    const expectedMembers = [...members, ...(operation.type === 'ARRANGE' ? texts.map(message => message.id) : [])];
    if (!equal(organization.targetMessageIds, expectedMembers) || operation.type !== 'CLASSIFY' && !expectedMembers.length) fail('本地组织成员与创建记录不一致');
    if (['CLASSIFY', 'SUMMARY'].includes(operation.type) && !organization.title?.trim()) fail('分类名称或总结内容不能为空');
    if (operation.type === 'ARRANGE' && !['single-column', 'single-row'].includes(organization.targetLayout || '')) fail('排列方向无效');
    checkCycle([[organization.id, parent], ...expectedMembers.map(member => [member, organization.id] as [string, string])]);
    // Extra text is born in the current scope; ARRANGE then moves it into its
    // frame, retaining the same previous placement as other selected members.
    for (const text of texts) { addText(text); placement(text.id, parent, operation.id, operation.createdAt); }
    addRelation({ id: organization.id, type: operation.type, sourceMessageId: null, targets: expectedMembers, content: organization.content,
      title: organization.title, layout: organization.targetLayout, createdAt: organization.createdAt, kind: 'local-organization' });
    placement(organization.id, parent, operation.id, operation.createdAt);
    for (const member of expectedMembers) placement(member, organization.id, operation.id, operation.createdAt);
  }
  if (usedMessages.size !== additions.size) fail('本地消息包含无对应创建操作的记录');
  // Native stances remain addressable messages: later stances can target their
  // references. Hiding an intermediate record would break resolveStance chains.
  // Keep the prior display policy only for documents with legacy-only events.
  const hasNativeStances = options.nativeBase || log.operations.some(operation => operation.targetReferences !== undefined);
  for (const message of data.messages) if (!hasNativeStances && (message.relationType === 'AGREE' || message.relationType === 'DISAGREE')) {
    const reference = (message.targetRefs as Array<{ messageId?: string; relationId?: string }> | undefined)?.[0];
    const target = reference?.messageId || reference?.relationId, latestId = target ? latestStances.get(target)?.messageId : undefined;
    if (latestId) {
      message.supersededBy = latestId === message.id ? null : latestId;
      const relation = relationById.get(message.id); if (relation) relation.supersededBy = message.supersededBy;
    }
  }
  const rejected = inactive();
  for (const { message, applicable } of correctionRecords) if (!applicable) rejected.add(message.id);
  data.zhihu.inactiveRelationIds = [...rejected].filter(id => byId.has(id));
  for (const reply of data.zhihu.replyRelations) reply.active = !rejected.has(reply.id);
  for (const id of Object.keys(metadata)) if (['reply', 'local-organization', 'local-correction'].includes(metadata[id].kind)) metadata[id].active = !rejected.has(id);
  for (const { message, applicable } of correctionRecords) {
    if (!applicable || rejected.has(message.id)) continue;
    const correction = message.correction!, target = byId.get(correction.targetMessageId)!, info = metadata[target.id];
    (info.localCorrections ||= {})[correction.field] = { id: message.id, content: message.content };
    if (correction.field === 'title') {
      target.relationPayload = { ...(target.relationPayload as object), title: message.content };
      const relation = relationById.get(target.id); if (relation) relation.payload = target.relationPayload;
    }
  }
  const final = resolved();
  data.zhihu.membershipParents = Object.fromEntries([...new Set([...final.trackedMembers, ...navigationParents.keys()])]
    .map(member => [member, final.effective.has(member) ? final.effective.get(member)!.parentId || null : navigationParent(member)]));
  for (const action of actions) {
    if (options.nativeBase && byId.has(action.id)) continue;
    if (byId.get(action.memberId)?.supersededBy) continue;
    addRelation({ id: action.id, type: 'JOIN', sourceMessageId: action.parentId || null, targets: [action.memberId],
      createdAt: actionTimes.get(action.id) || '', kind: 'membership', membership: action, sequence: actionSequences.get(action.id) });
  }
  for (const [id, info] of Object.entries(metadata)) if (info.kind === 'local-organization') {
    info.targetMessageIds = [...final.effective].filter(([, action]) => action.parentId === id).sort((left, right) => left[1].order - right[1].order).map(([member]) => member);
  }
  if (!data.users?.some(user => user.id === AUTHOR.id) && log.messages.length + log.operations.length > 0)
    (data.users ||= []).push({ id: AUTHOR.id, username: AUTHOR.name, createdAt: '' });
  return data;
}
