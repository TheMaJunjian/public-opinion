import type { ZhihuViewingData, ZhihuLocalCorrection } from './zhihuArchive';

export type ZhihuCorrectionField = 'body' | 'title';
export interface ZhihuCorrectableField {
  field: ZhihuCorrectionField; label: string; value: string; originalValue: string;
  originalStatus: 'complete' | 'partial' | 'unknown'; localCorrectionId?: string; issue?: string;
}
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const correctableKinds = new Set(['item', 'comment', 'question', 'local-text', 'local-organization']);
type SourceArchive = ZhihuViewingData['zhihu']['archive'];
function createIndex(data: ZhihuViewingData) {
  const itemsByThread = new Map<string, SourceArchive['items'][number]>();
  const firstItemById = new Map<string, SourceArchive['items'][number]>();
  for (const item of data.zhihu.archive.items) {
    const thread = `${item.type}:${item.id}`;
    if (!itemsByThread.has(thread)) itemsByThread.set(thread, item);
    if (!firstItemById.has(item.id)) firstItemById.set(item.id, item);
  }
  const commentsByThread = new Map<string, Map<string, SourceArchive['comments'][number]>>();
  for (const comment of data.zhihu.archive.comments) {
    let comments = commentsByThread.get(comment.threadId);
    if (!comments) { comments = new Map(); commentsByThread.set(comment.threadId, comments); }
    const id = comment.sourceId || comment.id;
    if (!comments.has(id)) comments.set(id, comment);
  }
  return {
    messages: new Map(data.messages.map(message => [message.id, message])), itemsByThread, firstItemById, commentsByThread,
    definitions: new Map(data.zhihu.localOperations.messages.map(message => [message.id, message])),
    inactive: new Set(data.zhihu.inactiveRelationIds),
  };
}
type CorrectionIndex = ReturnType<typeof createIndex>;
const indexes = new WeakMap<ZhihuViewingData, { arrays: readonly unknown[][]; lengths: number[]; index: CorrectionIndex }>();
function correctionIndex(data: ZhihuViewingData): CorrectionIndex {
  const arrays = [data.messages, data.zhihu.archive.items, data.zhihu.archive.comments, data.zhihu.localOperations.messages, data.zhihu.inactiveRelationIds];
  const cached = indexes.get(data);
  // Projection appends records in place while replaying local operations. Do
  // not reuse a partially built index after an append or array replacement.
  if (cached && arrays.every((array, index) => array === cached.arrays[index] && array.length === cached.lengths[index])) return cached.index;
  const index = createIndex(data);
  indexes.set(data, { arrays, lengths: arrays.map(array => array.length), index });
  return index;
}

/** Alignment fingerprint only: not an authenticity or authorship signature. */
export function correctionFingerprint(target: string, field: ZhihuCorrectionField, content: string, completeness: ZhihuCorrectableField['originalStatus']): string {
  let hash = 14695981039346656037n;
  for (const character of JSON.stringify([target, field, content, completeness])) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

/** Field identities are explicit; a classification's members are never a text edit. */
export function getZhihuCorrectableFields(data: ZhihuViewingData, messageId: string): ZhihuCorrectableField[] {
  if (!correctableKinds.has(data.zhihu.byMessageId[messageId]?.kind)) return [];
  return correctableFields(data, messageId, correctionIndex(data));
}
function correctableFields(data: ZhihuViewingData, messageId: string, index: CorrectionIndex): ZhihuCorrectableField[] {
  const message = index.messages.get(messageId), meta = data.zhihu.byMessageId[messageId];
  if (!message || !meta || index.inactive.has(messageId)) return [];
  const field = (name: ZhihuCorrectionField, label: string, value: string, originalStatus: ZhihuCorrectableField['originalStatus'], issue?: string): ZhihuCorrectableField => ({
    field: name, label, originalValue: value, value: meta.localCorrections?.[name]?.content ?? value, originalStatus,
    ...(meta.localCorrections?.[name] ? { localCorrectionId: meta.localCorrections[name]!.id } : {}), ...(issue ? { issue } : {}),
  });
  if (meta.kind === 'question') return [
    field('title', '问题标题', meta.questionTitle || '', meta.titleCompleteness || 'unknown', meta.titleCompleteness === 'complete' ? undefined
      : meta.titleCompleteness === 'partial' ? '原站问题标题未完整取得' : meta.questionTitle ? '原站问题标题完整性未确认' : '原站问题标题未取得'),
    field('body', '问题描述', message.content || '', meta.descriptionCompleteness || 'unknown', !meta.descriptionKnown ? '原站问题描述未取得' : meta.descriptionCompleteness !== 'complete' ? '原站问题描述完整性未确认' : undefined),
  ];
  if (meta.kind === 'item' || meta.kind === 'comment') {
    const threadItem = index.itemsByThread.get(meta.threadId);
    const source = meta.kind === 'item'
      ? (threadItem?.id === meta.sourceId ? threadItem : index.firstItemById.get(meta.sourceId))
      : index.commentsByThread.get(meta.threadId)?.get(meta.sourceId);
    const completeness = record(source?.completeness);
    const issues = Array.isArray(source?.issues) ? source.issues.flatMap(value => {
      const entry = record(value), text = typeof value === 'string' ? value : typeof entry?.message === 'string' ? entry.message : '';
      return /正文|缺字|内容.*(?:缺|未|截断)|(?:body|content|text).*(?:partial|missing|truncat)|(?:partial|missing|truncat).*(?:body|content|text)/i.test(`${entry?.code || ''} ${text}`) ? [text || '原站记录指出正文可能不完整'] : [];
    }).filter(Boolean) : [];
    const originalStatus = issues.length || completeness?.body === 'partial' ? 'partial' : completeness?.body === 'complete' ? 'complete' : 'unknown';
    const issue = issues.join('；') || (originalStatus === 'partial' ? '原站正文未完整取得' : originalStatus === 'unknown' ? '未记录可确认的原站正文完整性' : undefined);
    return [field('body', meta.kind === 'comment' ? '评论正文' : '作品正文', message.content || '', originalStatus, issue)];
  }
  if (meta.kind === 'local-text') return [field('body', '本地文本', message.content || '', 'complete')];
  if (meta.kind === 'local-organization') {
    const definition = index.definitions.get(messageId);
    const sourceFields = message.parts?.find(part => part.id === 'source-fields' && part.type === 'data');
    const title = sourceFields?.type === 'data' ? record(sourceFields.value)?.title : undefined;
    if (message.relationType === 'CLASSIFY') return [field('title', '分类名称', definition?.title || definition?.content || (typeof title === 'string' ? title : '') || String(record(message.relationPayload)?.title || ''), 'complete')];
    if (message.relationType === 'SUMMARY') return [field('body', '总结正文', definition?.content || message.content || '', 'complete')];
  }
  return [];
}

export function correctionBase(data: ZhihuViewingData, messageId: string, name: ZhihuCorrectionField): ZhihuLocalCorrection {
  const field = getZhihuCorrectableFields(data, messageId).find(candidate => candidate.field === name);
  if (!field) throw new Error('该消息没有可更正的所选文字字段');
  return { field: name, targetMessageId: messageId, baseContent: field.originalValue, baseStatus: field.originalStatus,
    baseFingerprint: correctionFingerprint(messageId, name, field.originalValue, field.originalStatus) };
}

export function getZhihuDisplayFields(data: ZhihuViewingData, messageId: string) {
  const fields = getZhihuCorrectableFields(data, messageId), body = fields.find(field => field.field === 'body'), title = fields.find(field => field.field === 'title');
  return { body: body?.value ?? correctionIndex(data).messages.get(messageId)?.content ?? '',
    ...(title ? { title: title.value } : {}), ...(body?.localCorrectionId ? { bodyCorrectionId: body.localCorrectionId } : {}),
    ...(title?.localCorrectionId ? { titleCorrectionId: title.localCorrectionId } : {}) };
}

/** These are reported missing/partial fields, never inferred missing characters. */
export function getZhihuMissingContent(data: ZhihuViewingData) {
  const index = correctionIndex(data);
  return data.messages.filter(message => correctableKinds.has(data.zhihu.byMessageId[message.id]?.kind))
    .flatMap(message => correctableFields(data, message.id, index)
    .filter(field => field.originalStatus !== 'complete')
    .map(field => ({ messageId: message.id, ...field, issue: field.issue || '原站文字完整性未确认' })));
}
