import { resolveMemberships, resolveStance, textOf, type Message as CoreMessage, type MembershipAction, type Reference } from '@gonglun/core';
import { createEmptyZhihuLocalOperations, type ZhihuViewingData, type ZhihuMessageSource, type ZhihuLocalSendInput } from './zhihuArchive';
import { createOverrides } from './zhihuRelations.mjs';
import { buildZhihuLocalSend, projectZhihuLocalAdditions } from './zhihuLocalModel';
import { correctionBase } from './zhihuCorrections';
import { isNativeLocalMessage, nativeZhihuIdentity, type NativeZhihuView } from './nativeZhihuView';
import { pagedArchiveSource } from './pagedZhihuArchive';

const LOCAL_AUTHOR = '本地整理者';
const views = new WeakMap<NativeZhihuView, ZhihuViewingData>();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const targets = (message: NativeZhihuView['messages'][number]) => (message.targetRefs as Array<{ messageId?: string; relationId?: string }> | undefined)?.flatMap(ref => ref.messageId || ref.relationId || []) || [];

/** A transient editing index over native messages, never a persisted source envelope. */
export function nativeZhihuEditingView(data: NativeZhihuView): ZhihuViewingData {
  const cached = views.get(data); if (cached) return cached;
  const byMessageId: Record<string, ZhihuMessageSource> = Object.create(null);
  const archive: ZhihuViewingData['zhihu']['archive'] = { format: 'gonglun-zhihu-archive', version: 1, items: [], comments: [] };
  const byId = new Map(data.messages.map(message => [message.id, message]));
  const latest = new Map<string, { id: string; opposed: boolean }>();
  const resolver = (id: string, revision?: number) => {
    const message = byId.get(id);
    return message && (revision === undefined || revision === message.revision) ? message as unknown as CoreMessage : undefined;
  };
  const structural = (ref: Reference) => !ref.range && !ref.memberId && !ref.path?.length
    && byId.get(ref.messageId)?.relationType && (!ref.partId || byId.get(ref.messageId)?.parts?.some(part => part.id === ref.partId && part.type === 'relation'));
  for (const message of data.messages) {
    const item = /^zhihu:item:([^:]+):(.+)$/.exec(message.id), comment = /^zhihu:comment:([^:]+):(.+)$/.exec(message.id);
    const question = /^zhihu:question:(.+)$/.exec(message.id), local = isNativeLocalMessage(message);
    const part = message.parts?.find(candidate => candidate.id === 'source-fields' && candidate.type === 'data');
    const title = part?.type === 'data' ? object(part.value).title : undefined;
    const kind: ZhihuMessageSource['kind'] = item ? 'item' : comment ? 'comment' : question ? 'question'
      : message.relationType === 'JOIN' ? 'membership' : message.relationType === 'CORRECT' ? 'local-correction'
      : message.relationType === 'REPLY' ? 'reply' : local && ['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(message.relationType || '') ? 'local-organization'
      : local && message.kind === 'TEXT' ? 'local-text' : message.id.startsWith('zhihu:type:') ? 'type-category'
      : message.id.startsWith('zhihu:folder:') ? 'source-folder' : message.id.startsWith('zhihu:event:') ? 'activity-event' : 'source-category';
    const threadId = item ? `${decodeURIComponent(item[1])}:${decodeURIComponent(item[2])}` : comment ? decodeURIComponent(comment[1]) : `native:${nativeZhihuIdentity(data)}`;
    const sourceId = item ? decodeURIComponent(item[2]) : comment ? decodeURIComponent(comment[2]) : question ? decodeURIComponent(question[1]) : message.id;
    byMessageId[message.id] = { kind, threadId, sourceId, sourceUrl: null, authorName: message.author, createdAt: message.createdAt || null,
      createdAtText: null, sourceLabels: [], ...(message.sourceMessageId ? { sourceMessageId: message.sourceMessageId } : {}),
      targetMessageIds: targets(message), ...(question ? { questionTitle: typeof title === 'string' ? title : '',
        titleCompleteness: 'unknown', descriptionCompleteness: 'unknown', descriptionKnown: !!message.content } : {}) };
    if (item) archive.items.push({ id: sourceId, type: decodeURIComponent(item[1]) as 'answer' | 'article' | 'pin', text: message.content || '' });
    if (comment) archive.comments.push({ id: sourceId, sourceId, threadId, text: message.content || '', parentCommentId: null });
  }
  const stances = data.messages.filter(message => ['AGREE', 'DISAGREE'].includes(message.relationType || ''))
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0) || a.createdAt.localeCompare(b.createdAt));
  for (const message of stances) for (const part of message.parts || []) if (part.type === 'relation' && ['agree', 'disagree'].includes(part.relation)) {
    for (const binding of part.roles.target || []) {
      const resolved = resolveStance(binding.reference, part.relation === 'agree' ? 'pro' : 'con', resolver);
      if (structural(resolved.target)) latest.set(resolved.target.messageId, { id: message.id, opposed: resolved.side === 'con' });
    }
  }
  const inactive = new Set([...latest].flatMap(([id, state]) => state.opposed ? [id] : []));
  const actions = data.relations.flatMap(relation => {
    const action = object(relation.payload).membershipHistory as MembershipAction | undefined;
    return relation.relationType === 'JOIN' && action?.id === relation.id ? [action] : [];
  });
  const resolvedMemberships = resolveMemberships(actions, inactive);
  const membershipParents: Record<string, string | null> = Object.fromEntries([...resolvedMemberships.effective].map(([id, action]) => [id, action.parentId || null]));
  const declared = new Map<string, Set<string>>();
  for (const relation of data.relations) if (['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(relation.relationType || '') && !object(relation.payload).independentMemberships) {
    for (const ref of (relation.targetRefs || []) as Array<{ messageId?: string; relationId?: string }>) {
      const id = ref.messageId || ref.relationId; if (!id || resolvedMemberships.trackedMembers.has(id)) continue;
      const parents = declared.get(id) || new Set<string>(); parents.add(relation.id); declared.set(id, parents);
    }
  }
  for (const [id, parents] of declared) membershipParents[id] = parents.size === 1 ? [...parents][0] : null;
  const view: ZhihuViewingData = { ...data, zhihu: { archiveId: `native:${nativeZhihuIdentity(data)}`, archive, overrides: createOverrides(),
    localOperations: createEmptyZhihuLocalOperations(), relations: [], replyRelations: [], byMessageId, inactiveRelationIds: [...inactive],
    membershipParents, warnings: [], readOnly: true } };
  const localCorrections = data.messages.filter(message => message.relationType === 'CORRECT').sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  for (const message of localCorrections) {
    const info = byMessageId[message.id], payload = object(message.relationPayload), field = payload.localCorrectionField === 'title' ? 'title' : 'body';
    const target = targets(message)[0], targetInfo = byMessageId[target];
    info.correctionKind = payload.correctionKind === 'WIDTH' ? 'WIDTH' : 'TEXT'; info.correctionField = field;
    if (info.correctionKind === 'WIDTH' && typeof payload.correctionWidth === 'number') info.correctionWidth = payload.correctionWidth;
    let applicable = info.correctionKind === 'WIDTH';
    if (!applicable) try { applicable = !payload.baseFingerprint || payload.baseFingerprint === correctionBase(view, target, field).baseFingerprint; } catch { /* A changed source field cannot accept the previous correction. */ }
    info.correctionApplicable = applicable; if (!applicable) inactive.add(message.id);
    if (applicable && !inactive.has(message.id) && targetInfo && info.correctionKind !== 'WIDTH') (targetInfo.localCorrections ||= {})[field] = { id: message.id, content: message.content || '' };
  }
  view.zhihu.inactiveRelationIds = [...inactive];
  views.set(data, view); return view;
}

export function sendNativeZhihuRelation(data: NativeZhihuView, input: ZhihuLocalSendInput): ZhihuViewingData {
  const index = nativeZhihuEditingView(data);
  const localOperations = buildZhihuLocalSend(index, input);
  const working: ZhihuViewingData = { ...index, messages: data.messages.map(message => ({ ...message })),
    relations: data.relations.map(relation => ({ ...relation })), users: [...(data.users || [])],
    zhihu: { ...index.zhihu, byMessageId: Object.fromEntries(Object.entries(index.zhihu.byMessageId).map(([id, info]) => [id, { ...info,
      ...(info.localCorrections ? { localCorrections: { ...info.localCorrections } } : {}) }])), localOperations } };
  const projected = projectZhihuLocalAdditions(working, new Map(), { nativeBase: true });
  const ids = new Set(data.messages.map(message => message.id)), relationIds = new Set(data.relations.map(relation => relation.id));
  let order = data.messages.filter(isNativeLocalMessage).length;
  const additions = projected.messages.filter(message => !ids.has(message.id)).map(message => ({ ...message,
    parts: [...(message.parts || []), { id: 'local-origin', type: 'data' as const, value: { format: 'gonglun-local-message', version: 1, order: ++order } }] }));
  const partsById = new Map(additions.map(message => [message.id, message.parts]));
  const native: NativeZhihuView = { ...data, messages: [...data.messages, ...additions],
    relations: [...data.relations, ...projected.relations.filter(relation => !relationIds.has(relation.id)).map(relation => ({ ...relation, parts: partsById.get(relation.id) }))], users: projected.users,
    viewerUsername: LOCAL_AUTHOR };
  const result = nativeZhihuEditingView(native);
  return { ...result, zhihu: { ...result.zhihu, localOperations } };
}

export function nativeZhihuDocument(view: ZhihuViewingData): NativeZhihuView {
  const { zhihu: _index, ...data } = view;
  return data as NativeZhihuView;
}

export function serializeNativeZhihuView(data: NativeZhihuView): string {
  if (pagedArchiveSource(data)) throw new Error('分段阅览文件须通过原文片段导出，不能直接序列化索引');
  return `${JSON.stringify({ ...data, messages: data.messages.map(compactNativeRecord), relations: data.relations.map(compactNativeRecord), exportedAt: new Date().toISOString() }, null, 2)}\n`;
}
export function compactNativeRecord<T extends object>(row: T): T | Omit<T, 'content'> {
  if (!('parts' in row) || !Array.isArray(row.parts) || !('content' in row) || row.content !== textOf(row as unknown as CoreMessage)) return row;
  const { content: _content, ...rest } = row; return rest;
}
