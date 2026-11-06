import type { ExportData } from '../api/client';
import type { Part, Reference } from '@gonglun/core';
import { CLEAN_MESSAGE_TYPES } from '../types';
import { isHomeFilterMode } from '../pages/workbench/model/homeFilter';
import { projectZhihuLocalAdditions, buildZhihuLocalSend, validateZhihuLocalReferences } from './zhihuLocalModel';
import { correctionFingerprint } from './zhihuCorrections';
import { isCardWidth } from './cardWidth';
import { isDiscussionView } from './discussionView';
import { activityEvidenceText, validateZhihuActivitySource, type ZhihuActivitySource } from './zhihuActivities';
export type { ZhihuActivitySource, ZhihuSourceEvent, ZhihuSourceFolder } from './zhihuActivities';
export { getZhihuCorrectableFields, getZhihuMissingContent, getZhihuDisplayFields } from './zhihuCorrections';
import {
  applyRelation, applyRelationBatch, createOverrides, getRelations, materializeRelations,
  resetRelation, undoRelationBatch,
  type RelationArchive, type RelationComment, type RelationOverrides, type RelationRow,
} from './zhihuRelations.mjs';

type SourcePerson = { id?: string | null; name?: string; url?: string | null };
type SourceFields = {
  id: string; text: string; author?: SourcePerson | null; createdAt?: string | null;
  createdAtText?: string | null; sourceLabels?: string[]; [key: string]: unknown;
};
export type ZhihuQuestion = Omit<SourceFields, 'text'> & { id?: string | null; text?: string | null; title?: string | null; url?: string | null; author?: SourcePerson | null; createdAt?: string | null; createdAtText?: string | null; sourceLabels?: string[] };
export type ZhihuItem = SourceFields & { type: 'answer' | 'article' | 'pin'; url?: string | null; title?: string | null; question?: ZhihuQuestion | null };
export type ZhihuComment = SourceFields & RelationComment;
export interface ZhihuArchive extends RelationArchive {
  format: 'gonglun-zhihu-archive'; version: 1; owner?: SourcePerson | null;
  createdAt?: string; updatedAt?: string; items: ZhihuItem[]; comments: ZhihuComment[]; questions?: ZhihuQuestion[];
  activitySource?: ZhihuActivitySource;
}
export interface ZhihuMessageSource {
  kind: 'item' | 'comment' | 'question' | 'type-category' | 'source-category' | 'source-folder' | 'activity-event' | 'activity-reference' | 'reply' | 'local-operation' | 'local-organization' | 'local-text' | 'local-correction' | 'membership'; threadId: string; sourceId: string; sourceUrl: string | null;
  authorName: string; createdAt: string | null; createdAtText: string | null;
  sourceLabels: string[]; relation?: RelationRow;
  sourceMessageId?: string; targetMessageIds?: string[]; active?: boolean; questionTitle?: string | null; descriptionKnown?: boolean;
  descriptionCompleteness?: 'complete' | 'partial' | 'unknown';
  titleCompleteness?: 'complete' | 'partial' | 'unknown';
  localCorrections?: Partial<Record<'body' | 'title', { id: string; content: string }>>;
  correctionField?: 'body' | 'title'; correctionApplicable?: boolean;
  correctionKind?: 'TEXT' | 'WIDTH'; correctionWidth?: number;
  activityScope?: 'collections' | 'activities'; targetMessageId?: string;
}
export interface ZhihuReplyDefinition {
  id: string; threadId: string; commentId: string; sourceMessageId: string; targetMessageIds: string[];
  source: 'original' | 'manual'; method: 'sequence' | 'manual' | null; revisionId?: string;
  createdAt: string; authorId: string; author: string;
}
export type ZhihuReplyRelation = ZhihuReplyDefinition & { active: boolean; current: boolean };
export type ZhihuOrganizationType = 'CLASSIFY' | 'SUMMARY' | 'MERGE' | 'ARRANGE';
export type ZhihuLocalRelationType = 'REPLY' | 'AGREE' | 'DISAGREE' | 'CORRECT' | ZhihuOrganizationType;
export interface ZhihuLocalCorrection {
  field: 'body' | 'title'; targetMessageId: string; baseContent: string; baseFingerprint: string;
  baseStatus: 'complete' | 'partial' | 'unknown';
}
export interface ZhihuLocalMessage {
  id: string; operationId: string; kind: 'text' | 'relation'; relationType?: 'REPLY' | 'CORRECT' | ZhihuOrganizationType;
  createdAt: string; sourceMessageId: string | null; targetMessageIds: string[]; content: string;
  title?: string; targetLayout?: 'single-column' | 'multi-column' | 'single-row';
  correction?: ZhihuLocalCorrection; authorId?: string; author?: string;
  correctionKind?: 'WIDTH'; correctionWidth?: number;
}
export interface ZhihuLocalSendInput {
  relationType: ZhihuLocalRelationType; sourceMessageIds?: string[]; targetMessageIds: string[];
  title?: string; content?: string; note?: string; targetLayout?: 'single-column' | 'multi-column' | 'single-row';
  currentClassificationId?: string | null;
  correctionField?: 'body' | 'title';
  correctionKind?: 'TEXT' | 'WIDTH'; correctionWidth?: number;
  sourceReferences?: Reference[]; targetReferences?: Reference[];
}
export interface ZhihuLocalOperation {
  id: string; type: ZhihuLocalRelationType | 'AGREE'; createdAt: string; targetRelationIds: string[];
  sourceMessageIds: string[]; note: string; overrideRevisionIds?: string[];
  mode?: 'create' | 'append' | 'stance'; createdMessageIds?: string[]; memberMessageIds?: string[];
  currentClassificationId?: string | null;
  sourceReferences?: Reference[]; targetReferences?: Reference[];
}
export interface ZhihuLocalOperations {
  format: 'gonglun-zhihu-local-operations'; version: 3;
  operations: ZhihuLocalOperation[]; replyDefinitions: ZhihuReplyDefinition[]; messages: ZhihuLocalMessage[];
}
export function createEmptyZhihuLocalOperations(): ZhihuLocalOperations {
  return { format: 'gonglun-zhihu-local-operations', version: 3, operations: [], replyDefinitions: [], messages: [] };
}
export interface ZhihuViewMetadata {
  archiveId: string; archive: ZhihuArchive; overrides: RelationOverrides; relations: RelationRow[];
  localOperations: ZhihuLocalOperations; replyRelations: ZhihuReplyRelation[];
  inactiveRelationIds: string[]; membershipParents: Record<string, string | null>;
  byMessageId: Record<string, ZhihuMessageSource>; warnings: string[]; readOnly: true;
}
export type ZhihuViewingData = ExportData & { zhihu: ZhihuViewMetadata };
export type ZhihuRelationUpdate = {
  mode: 'sets' | 'sequence'; sourceMessageIds?: string[]; targetMessageIds?: string[]; threadId?: string; note?: string;
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(message: string): never { throw new Error(message); }
const key = (threadId: string, commentId: string) => JSON.stringify([threadId, commentId]);
// eslint-disable-next-line no-control-regex -- Imported identifiers must reject ASCII control characters.
const identifier = (value: unknown, label: string): string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/.test(value) ? value : fail(`${label}必须是字符串编号`);
const optionalString = (value: unknown, label: string) => value == null || typeof value === 'string' ? undefined : fail(`${label}必须是文字`);
const itemId = (item: ZhihuItem) => `zhihu:item:${encodeURIComponent(item.type)}:${encodeURIComponent(item.id)}`;
const commentId = (threadId: string, id: string) => `zhihu:comment:${encodeURIComponent(threadId)}:${encodeURIComponent(id)}`;
const canonicalThread = (item: ZhihuItem) => `${item.type}:${item.id}`;
const questionMessageId = (id: string) => `zhihu:question:${encodeURIComponent(id)}`;
const TYPE_CATEGORIES = [{ type: 'answer', title: '回答' }, { type: 'article', title: '文章' }, { type: 'pin', title: '想法' }] as const;
const CATEGORY_AUTHOR = { id: 'zhihu:viewer-category', name: '阅览分类' };
const LOCAL_AUTHOR = { id: 'zhihu:local-editor', name: '本地整理者' };
function shortHash(value: string): string {
  let hash = 14695981039346656037n;
  for (const character of value) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
  return hash.toString(16).padStart(16, '0');
}

/** A format sniff only. Every entry point below revalidates the untrusted file. */
export function isZhihuInput(value: unknown): boolean {
  return object(value) && (value.format === 'gonglun-zhihu-archive' || value.format === 'gonglun-zhihu-reviewed');
}
export function isZhihuViewingData(value: unknown): value is ZhihuViewingData {
  return object(value) && value.format === 'gonglun-view-3' && object(value.zhihu) && isZhihuInput(value.zhihu.archive);
}

/** JSON-only, bounded input; source HTML stays inert evidence inside the envelope. */
function cloneInput(value: unknown): unknown {
  let nodes = 0, characters = 0;
  const seen = new Set<object>();
  function copy(entry: unknown, depth: number): unknown {
    if (++nodes > 8_000_000) return fail('知乎文件过大：原始资料与整理日志超过 8000000 个数据节点');
    if (depth > 50) return fail('知乎文件嵌套过深：最多 50 层');
    if (entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : fail('文件包含无效数字');
    if (typeof entry === 'string') {
      characters += entry.length;
      if (characters > 100_000_000) return fail('知乎文件文字量过大');
      return entry;
    }
    if (!object(entry) && !Array.isArray(entry)) return fail('知乎文件必须是普通 JSON 数据');
    if (seen.has(entry)) return fail('知乎文件包含循环引用');
    seen.add(entry);
    let result: unknown;
    if (Array.isArray(entry)) result = entry.map(child => copy(child, depth + 1));
    else {
      const fields: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(entry)) {
        if (['__proto__', 'prototype', 'constructor'].includes(name)) return fail('知乎文件包含不安全字段');
        // Optional fields in an in-memory view may be undefined; serialized JSON omits them.
        if (child !== undefined) fields[name] = copy(child, depth + 1);
      }
      result = fields;
    }
    seen.delete(entry);
    return result;
  }
  return copy(value, 0);
}

/** Derived graph rows repeat source evidence; validate only the persisted source, log and view. */
function cloneViewingSource(value: unknown): unknown {
  // Reject excessive record counts before walking body text or observation history.
  // Full structure/content validation still follows the bounded JSON clone.
  const archive = isZhihuViewingData(value) ? value.zhihu.archive
    : object(value) && value.format === 'gonglun-zhihu-reviewed' ? value.archive : value;
  if (object(archive)) {
    if (Array.isArray(archive.items) && Array.isArray(archive.comments)
      && archive.items.length + archive.comments.length > 100_000) fail('单份知乎归档记录过多');
    const activity = archive.activitySource;
    if (object(activity) && Array.isArray(activity.events) && Array.isArray(activity.folders)
      && activity.events.length + activity.folders.length > 100_000) fail('知乎来源记录数量无效');
  }
  if (isZhihuViewingData(value)) return cloneInput({ format: value.format,
    zhihu: { archive: value.zhihu.archive, overrides: value.zhihu.overrides, localOperations: value.zhihu.localOperations },
    ...(value.view !== undefined ? { view: value.view } : {}) });
  if (object(value) && value.format === 'gonglun-zhihu-reviewed') return cloneInput({
    format: value.format, version: value.version, archive: value.archive, overrides: value.overrides,
    localOperations: value.localOperations, ...(value.view !== undefined ? { view: value.view } : {}),
  });
  return cloneInput(value);
}
function validatePerson(value: unknown) {
  if (value == null) return;
  if (!object(value)) fail('原站作者资料无效');
  const person = value as Record<string, unknown>;
  if (person.id != null) identifier(person.id, '作者');
  optionalString(person.name, '作者名称'); optionalString(person.url, '作者链接');
}
function validateFields(value: unknown): asserts value is SourceFields {
  if (!object(value)) fail('原站记录无效');
  const record = value as Record<string, unknown>;
  identifier(record.id, '原站记录');
  if (typeof record.text !== 'string') fail('原站正文必须是纯文字');
  validatePerson(record.author);
  optionalString(record.createdAt, '原站时间'); optionalString(record.createdAtText, '原站时间文字');
  if (record.sourceLabels !== undefined && (!Array.isArray(record.sourceLabels) || record.sourceLabels.some(label => typeof label !== 'string'))) fail('原站内容标识无效');
}
function validateQuestion(value: unknown, requireId = true): asserts value is ZhihuQuestion {
  if (!object(value)) fail('原站问题资料无效');
  const question = value as Record<string, unknown>;
  if (requireId || question.id != null) identifier(question.id, '问题');
  for (const name of ['title', 'text', 'url', 'createdAt', 'createdAtText']) optionalString(question[name], `问题${name}`);
  validatePerson(question.author);
  if (question.sourceLabels !== undefined && (!Array.isArray(question.sourceLabels) || question.sourceLabels.some(label => typeof label !== 'string'))) fail('问题内容标识无效');
}
function validateArchive(value: unknown): ZhihuArchive {
  if (!object(value) || value.format !== 'gonglun-zhihu-archive' || value.version !== 1) return fail('不支持的知乎归档版本');
  if (value.platform !== undefined && value.platform !== 'zhihu') fail('归档来源平台不是知乎');
  if (!Array.isArray(value.items) || !Array.isArray(value.comments)) return fail('知乎归档缺少作品或评论列表');
  if (value.items.length + value.comments.length > 100_000) fail('单份知乎归档记录过多');
  validatePerson(value.owner);
  const ids = new Set<string>();
  for (const item of value.items) {
    validateFields(item);
    if (!['answer', 'article', 'pin'].includes(item.type as string)) fail('知乎作品类型无效');
    optionalString(item.title, '作品标题'); optionalString(item.url, '作品链接');
    if (item.question != null) validateQuestion(item.question, false);
    const id = canonicalThread(item as ZhihuItem);
    if (ids.has(id)) fail('知乎归档包含重复作品编号');
    ids.add(id);
  }
  for (const comment of value.comments) {
    validateFields(comment);
    identifier(comment.threadId, '讨论');
    for (const name of ['sourceId', 'parentCommentId', 'rootCommentId']) if (comment[name] != null) identifier(comment[name], name);
    validatePerson(comment.replyToAuthor);
    if (comment.issues !== undefined && !Array.isArray(comment.issues)) fail('评论完整性说明无效');
  }
  if (value.questions !== undefined) {
    if (!Array.isArray(value.questions)) fail('问题列表无效');
    const seen = new Set<string>();
    for (const question of value.questions as unknown[]) {
      validateQuestion(question);
      if (seen.has(question.id!)) fail('知乎归档包含重复问题编号');
      seen.add(question.id!);
    }
  }
  if (value.activitySource !== undefined) validateZhihuActivitySource(value.activitySource);
  return value as unknown as ZhihuArchive;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function exactTime(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : '';
}
function validateLocalOperations(value: unknown): ZhihuLocalOperations {
  if (value === undefined) return createEmptyZhihuLocalOperations();
  if (!object(value) || value.format !== 'gonglun-zhihu-local-operations' || ![1, 2, 3].includes(value.version as number) || !Array.isArray(value.operations)
    || value.replyDefinitions !== undefined && !Array.isArray(value.replyDefinitions) || value.messages !== undefined && !Array.isArray(value.messages)) return fail('本地关系操作记录格式无效');
  const ids = new Set<string>();
  const list = (entry: unknown, label: string, allowRepeatedIds = false): string[] => {
    if (!Array.isArray(entry)) return fail(`${label}必须是编号数组`);
    const result = entry.map(id => identifier(id, label));
    if (!allowRepeatedIds && new Set(result).size !== result.length) fail(`${label}包含重复编号`);
    return result;
  };
  const operations = value.operations.map(entry => {
    if (!object(entry) || !['REPLY', 'AGREE', 'DISAGREE', 'CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE', 'CORRECT'].includes(entry.type as string)
      || entry.type === 'CORRECT' && value.version !== 3) return fail('本地关系操作类型或版本无效');
    const id = identifier(entry.id, '本地操作');
    if (ids.has(id)) fail('本地操作编号重复'); ids.add(id);
    if (!exactTime(entry.createdAt) || typeof entry.note !== 'string' || entry.note.length > 10000) fail('本地操作时间或说明无效');
    const hasReferences = entry.targetReferences !== undefined || entry.sourceReferences !== undefined;
    if (hasReferences && (entry.mode !== 'stance' || !['AGREE', 'DISAGREE'].includes(entry.type as string) || value.version !== 3)) fail('只有新版赞同或反对可以携带消息部件地址');
    const targetRelationIds = list(entry.targetRelationIds, '本地操作目标', hasReferences);
    const sourceMessageIds = list(entry.sourceMessageIds ?? [], '本地操作来源', hasReferences);
    const references = hasReferences ? {
      targetReferences: validateZhihuLocalReferences(entry.targetReferences, targetRelationIds, '表态目标'),
      sourceReferences: validateZhihuLocalReferences(entry.sourceReferences, sourceMessageIds, '表态来源'),
    } : {};
    if (!targetRelationIds.length) fail('本地操作缺少回复关系目标');
    if (entry.mode !== undefined && (!['create', 'append', 'stance'].includes(entry.mode as string) || value.version === 1)) fail('本地操作模式或版本无效');
    if (entry.type === 'CORRECT' && entry.mode !== 'create') fail('本地更正必须是独立创建记录');
    if (entry.currentClassificationId != null) identifier(entry.currentClassificationId, '所在分类');
    return { id, type: entry.type as ZhihuLocalOperation['type'], createdAt: entry.createdAt as string,
      targetRelationIds, sourceMessageIds, note: entry.note as string, ...references,
      ...(entry.overrideRevisionIds !== undefined ? { overrideRevisionIds: list(entry.overrideRevisionIds, '对应关系修订') } : {}),
      ...(entry.mode !== undefined ? { mode: entry.mode as NonNullable<ZhihuLocalOperation['mode']> } : {}),
      ...(entry.createdMessageIds !== undefined ? { createdMessageIds: list(entry.createdMessageIds, '本地新增消息') } : {}),
      ...(entry.memberMessageIds !== undefined ? { memberMessageIds: list(entry.memberMessageIds, '本地组织成员', hasReferences) } : {}),
      ...(entry.currentClassificationId !== undefined ? { currentClassificationId: entry.currentClassificationId as string | null } : {}) };
  });
  ids.clear();
  const replyDefinitions = ((value.replyDefinitions || []) as unknown[]).map(entry => {
    if (!object(entry) || !['original', 'manual'].includes(entry.source as string) || ![null, 'sequence', 'manual'].includes(entry.method as null)) return fail('回复关系版本资料无效');
    const id = identifier(entry.id, '回复版本');
    if (ids.has(id)) fail('回复关系版本编号重复'); ids.add(id);
    if (typeof entry.createdAt !== 'string' || entry.createdAt !== '' && !exactTime(entry.createdAt) || typeof entry.author !== 'string') fail('回复版本时间或作者无效');
    const targetMessageIds = list(entry.targetMessageIds, '回复版本目标');
    if (!targetMessageIds.length) fail('回复版本缺少目标');
    return { id, threadId: identifier(entry.threadId, '回复讨论'), commentId: identifier(entry.commentId, '回复评论'),
      sourceMessageId: identifier(entry.sourceMessageId, '回复来源'), targetMessageIds,
      source: entry.source as ZhihuReplyDefinition['source'], method: entry.method as ZhihuReplyDefinition['method'],
      ...(entry.revisionId !== undefined ? { revisionId: identifier(entry.revisionId, '回复修订') } : {}),
      createdAt: entry.createdAt as string, authorId: identifier(entry.authorId, '回复作者'), author: entry.author as string };
  });
  ids.clear();
  const messages = ((value.messages || []) as unknown[]).map(entry => {
    if (value.version === 1 || !object(entry) || !['text', 'relation'].includes(entry.kind as string)) return fail('本地新增消息格式无效');
    const id = identifier(entry.id, '本地消息');
    if (ids.has(id)) fail('本地新增消息编号重复'); ids.add(id);
    if (!id.startsWith('zhihu:added:') || !exactTime(entry.createdAt) || typeof entry.content !== 'string') fail('本地消息编号、时间或正文无效');
    if (entry.sourceMessageId !== null) identifier(entry.sourceMessageId, '本地消息来源');
    if (entry.kind === 'relation' && !['REPLY', 'CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE', 'CORRECT'].includes(entry.relationType as string)) fail('本地新增关系类型无效');
    if (entry.kind === 'text' && entry.relationType !== undefined) fail('本地文本不能伪装关系');
    optionalString(entry.title, '本地组织标题');
    if (entry.targetLayout !== undefined && !['single-column', 'multi-column', 'single-row'].includes(entry.targetLayout as string)) fail('本地组织排列方式无效');
    let correction: ZhihuLocalCorrection | undefined, correctionWidth: number | undefined;
    if (entry.relationType === 'CORRECT') {
      if (value.version !== 3 || entry.authorId !== LOCAL_AUTHOR.id || entry.author !== LOCAL_AUTHOR.name) fail('本地更正作者或版本无效');
      if (entry.correctionKind === 'WIDTH') {
        if (!isCardWidth(entry.correctionWidth) || entry.correction !== undefined || entry.content !== '') fail('宽度调整须为 320–2400 的整数，且不能夹带正文更正');
        correctionWidth = entry.correctionWidth;
      } else {
        const edit = entry.correction;
        if (entry.correctionKind !== undefined || entry.correctionWidth !== undefined || !object(edit) || !['body', 'title'].includes(edit.field as string)
          || typeof edit.baseContent !== 'string' || edit.baseContent.length > 1_000_000 || !['complete', 'partial', 'unknown'].includes(edit.baseStatus as string)) fail('本地更正基础字段或类型无效');
        const targetMessageId = identifier(edit.targetMessageId, '更正目标');
        correction = { field: edit.field as 'body' | 'title', targetMessageId, baseContent: edit.baseContent,
          baseStatus: edit.baseStatus as ZhihuLocalCorrection['baseStatus'], baseFingerprint: edit.baseFingerprint as string };
        if (correction.baseFingerprint !== correctionFingerprint(targetMessageId, correction.field, correction.baseContent, correction.baseStatus)) fail('本地更正基础内容指纹不一致');
      }
    } else if (entry.correction !== undefined || entry.correctionKind !== undefined || entry.correctionWidth !== undefined || entry.authorId !== undefined || entry.author !== undefined) fail('只有本地更正可以携带更正基础和独立作者字段');
    return { id, operationId: identifier(entry.operationId, '本地消息所属操作'), kind: entry.kind as 'text' | 'relation',
      ...(entry.relationType !== undefined ? { relationType: entry.relationType as ZhihuLocalMessage['relationType'] } : {}),
      createdAt: entry.createdAt as string, sourceMessageId: entry.sourceMessageId as string | null,
      targetMessageIds: list(entry.targetMessageIds, '本地消息目标'), content: entry.content as string,
      ...(entry.title !== undefined ? { title: entry.title as string } : {}), ...(entry.targetLayout !== undefined ? { targetLayout: entry.targetLayout as ZhihuLocalMessage['targetLayout'] } : {}),
      ...(correction ? { correction, authorId: LOCAL_AUTHOR.id, author: LOCAL_AUTHOR.name } : {}),
      ...(correctionWidth !== undefined ? { correctionKind: 'WIDTH' as const, correctionWidth, authorId: LOCAL_AUTHOR.id, author: LOCAL_AUTHOR.name } : {}) };
  });
  return { format: 'gonglun-zhihu-local-operations', version: 3, operations, replyDefinitions, messages };
}
type ArchiveIdentitySource = {
  owner?: Pick<SourcePerson, 'id' | 'url'> | null;
  items: Array<Pick<ZhihuItem, 'id' | 'type'>>; comments: Array<Pick<ZhihuComment, 'threadId'>>;
  activitySource?: { scope: 'collections' | 'activities'; events: Array<{ id: string }> };
};
function archiveIdentity(archive: ArchiveIdentitySource): string {
  // A local grouping key, never a signature or an authenticity claim.
  const owner = archive.owner?.id || safeUrl(archive.owner?.url) || '';
  if (archive.activitySource && owner) return `zhihu:${shortHash(JSON.stringify([owner, 'source-events', archive.activitySource.scope]))}`;
  const threadFor = (item: Pick<ZhihuItem, 'id' | 'type'>) => `${item.type}:${item.id}`;
  const itemThreads = new Set(archive.items.flatMap(item => [threadFor(item), item.id]));
  const orphanThreads = [...new Set(archive.comments.map(comment => comment.threadId).filter(thread => !itemThreads.has(thread)))].sort();
  const source = JSON.stringify([owner, archive.items.map(threadFor).sort(), orphanThreads,
    ...(archive.activitySource ? [archive.activitySource.scope, archive.activitySource.events.map(event => event.id).sort()] : [])]);
  return `zhihu:${shortHash(source)}`;
}
function sourceParts(input: unknown) {
  if (!object(input)) return fail('不是可阅览的知乎文件');
  const view: unknown = input.view;
  let candidate: unknown = input, overrides: unknown = createOverrides(), local: unknown;
  if (isZhihuViewingData(input)) {
    candidate = input.zhihu.archive; overrides = input.zhihu.overrides; local = input.zhihu.localOperations;
  } else if (input.format === 'gonglun-zhihu-reviewed') {
    if (![1, 2, 3, 4, 5].includes(input.version as number)) fail('不支持的知乎整理文件版本');
    if ((input.version as number) >= 3 && input.localOperations === undefined) fail('新版整理文件缺少本地操作记录');
    candidate = input.archive; overrides = input.overrides; local = input.localOperations;
  }
  const archive = validateArchive(candidate);
  return reviewedSourceParts(archive, overrides, local, view);
}

/** The archive here has already been copied and validated by its caller. */
function reviewedSourceParts(archive: ZhihuArchive, overrides: unknown, local: unknown, view: unknown) {
  const reviewed = materializeRelations(archive, overrides as RelationOverrides, { copyArchive: false });
  // Invalid or dangling manual edges may never silently acquire the appearance of verified source links.
  if (reviewed.relations.some(row => row.source === 'manual' && row.needsReview)) fail('人工回复关系包含缺失目标或循环，请先修复原整理文件');
  view = validateView(view);
  return { ...reviewed, localOperations: validateLocalOperations(local), view: view as ExportData['view'] };
}
function validateView(value: unknown): ExportData['view'] {
  if (value === undefined) return undefined;
  if (!object(value) || !(value.username === null || typeof value.username === 'string') || !['list', 'graph'].includes(value.mode as string)
    || !object(value.messageFilter) || typeof value.messageFilter.hideSettlement !== 'boolean' || typeof value.messageFilter.hideJoin !== 'boolean'
    || !Array.isArray(value.cleanFilters) || !(value.classificationId === null || typeof value.classificationId === 'string')) return fail('阅览设置格式无效');
  if (!isHomeFilterMode(value.homeFilter)) fail('阅览设置格式无效');
  if (value.discussion !== undefined && !isDiscussionView(value.discussion)) fail('阅览设置格式无效');
  const messageTypes = new Set<string>(['CONTENT', 'RELATION', ...CLEAN_MESSAGE_TYPES.map(([type]) => type)]);
  const nonnegative = (entry: unknown) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0;
  for (const rule of value.cleanFilters as unknown[]) {
    if (!object(rule) || typeof rule.id !== 'string') fail('阅览设置格式无效');
    const filter = rule as Record<string, unknown>;
    const valid = filter.kind === 'sender' ? typeof filter.username === 'string'
      : filter.kind === 'tag' ? typeof filter.tagType === 'string' && nonnegative(filter.minCount)
      : filter.kind === 'stake' ? nonnegative(filter.minAmount) && (filter.side === undefined || ['PRO', 'CON'].includes(filter.side as string))
      : filter.kind === 'rounds' ? nonnegative(filter.minRounds)
      : filter.kind === 'participants' ? nonnegative(filter.minCount)
      : filter.kind === 'relationType' ? typeof filter.relationType === 'string'
      : filter.kind === 'messageType' ? Array.isArray(filter.messageTypes) && filter.messageTypes.length > 0 && filter.messageTypes.every(type => typeof type === 'string' && messageTypes.has(type))
      : filter.kind === 'time' ? typeof filter.from === 'string' && typeof filter.to === 'string' && !!(filter.from || filter.to)
        && (!filter.from || Number.isFinite(Date.parse(filter.from))) && (!filter.to || Number.isFinite(Date.parse(filter.to)))
        && (!filter.from || !filter.to || Date.parse(filter.from) <= Date.parse(filter.to))
      : false;
    if (!valid) fail('阅览设置格式无效');
  }
  return value as unknown as ExportData['view'];
}

/** Surface recorded limitations as plain text without promoting historical pages to current status. */
function sourceWarnings(archive: ZhihuArchive): string[] {
  const warnings = new Set<string>();
  let omitted = 0;
  const add = (value: string) => {
    if (warnings.has(value)) return;
    if (warnings.size < 200) warnings.add(value); else omitted++;
  };
  const issueTexts = (value: unknown, label: string) => {
    if (!Array.isArray(value)) return;
    for (const issue of value) {
      const text = typeof issue === 'string' ? issue : object(issue)
        ? typeof issue.message === 'string' && issue.message.trim() ? issue.message
          : typeof issue.reason === 'string' && issue.reason.trim() ? issue.reason
            : typeof issue.code === 'string' ? issue.code : ''
        : '';
      if (text.trim()) add(`${label}：${text}`);
    }
  };
  if (archive.activitySource) {
    const source = archive.activitySource, label = source.scope === 'collections' ? '收藏' : '动态';
    add(`本文件采集的是${label}来源，目标内容可能由他人创作；行为人、目标作者分别保留，不把收藏或赞同行为转换为公论表态。`);
    add(source.coverage.pagesComplete ? '本轮可访问的来源分页已结束；这不证明包含全部历史、已删除或不可访问记录。' : '来源分页尚未确认全部结束，事件数量不代表全部历史。');
    if (source.coverage.reason) add(`来源采集说明：${source.coverage.reason}`);
    if (source.unparsedRecords.length) add(`${source.unparsedRecords.length} 条来源记录尚未适配，原始证据保留在文件中，未补写事件或目标正文。`);
  }
  let partialBodies = 0, unconfirmedBodies = 0, partialComments = 0, unconfirmedComments = 0;
  for (const item of archive.items) {
    const state = object(item.completeness) ? item.completeness : {};
    if (state.body === 'partial') partialBodies++;
    else if (state.body !== 'complete') unconfirmedBodies++;
    if (state.comments === 'partial') partialComments++;
    else if (state.comments !== 'complete') unconfirmedComments++;
  }
  if (partialBodies) add(`原文件标记 ${partialBodies} 条作品的正文采集为部分，不能据此确认已取得完整正文。`);
  if (unconfirmedBodies) add(`原文件中 ${unconfirmedBodies} 条作品的正文完整性未确认。`);
  if (partialComments) add(`原文件标记 ${partialComments} 个作品的评论采集为部分，已保存条数不代表原站全部评论。`);
  if (unconfirmedComments) add(`原文件中 ${unconfirmedComments} 个作品的评论完整性未确认，已保存条数不代表原站全部评论。`);

  const captures = Array.isArray(archive.captures) ? archive.captures.filter(object) : [];
  const coverages = captures.map(capture => capture.coverage).filter(object);
  const lastScope = [...coverages].reverse().find(coverage => coverage.scope === 'account' || coverage.scope === 'selected-items');
  const latestCoverage = coverages.at(-1);
  if (lastScope?.scope === 'selected-items') add('原文件最近声明的采集范围仅为选定作品，不代表全账号备份。');
  else if (!(lastScope?.scope === 'account' && lastScope.complete === true && lastScope.hasMore === false)) add('原文件未确认已完成全账号采集，不声明为整个账号的完整备份。');
  // These are the most recent recorded scope statements, not deductions from record counts.
  for (const coverage of new Set([lastScope, latestCoverage].filter((value): value is Record<string, unknown> => !!value))) {
    const scopeNames: Record<string, string> = { account: '账号', 'selected-items': '选定作品', collection: '作品列表', thread: '作品讨论', 'root-comments': '顶层评论', 'child-comments': '楼中楼' };
    const scope = typeof coverage.scope === 'string' ? Object.hasOwn(scopeNames, coverage.scope) ? scopeNames[coverage.scope] : coverage.scope : '未注明';
    if (coverage.complete === false || coverage.hasMore === true || coverage.state === 'partial') add(`原文件采集范围 ${scope} 尚未完成或仍有后续内容。`);
    if (typeof coverage.reason === 'string' && coverage.reason.trim()) add(`原文件采集范围 ${scope} 的说明：${coverage.reason}`);
    for (const [field, label] of [['pendingCount', '待采集数'], ['missingCount', '缺失数']] as const) {
      const count = coverage[field];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) add(`原文件采集范围 ${scope} 报告${label}：${count}。`);
    }
  }
  issueTexts(archive.issues, '原文件问题记录');
  for (const item of archive.items) {
    const label = `作品 ${canonicalThread(item)}`;
    const state = object(item.completeness) ? item.completeness : {};
    if (typeof state.reason === 'string' && state.reason.trim()) add(`${label} 的完整性说明：${state.reason}`);
    issueTexts(item.issues, `${label} 的问题记录`);
  }
  for (const comment of archive.comments) issueTexts(comment.issues, `评论 ${comment.threadId}/${comment.sourceId || comment.id} 的问题记录`);
  for (const capture of captures) issueTexts(capture.issues, '采集过程问题记录（含历史记录）');
  if (omitted) warnings.add(`其余 ${omitted} 条问题提示未在面板展开，完整记录仍保存在原文件中。`);
  return [...warnings];
}
/** A bounded identity lookup, not a substitute for full evidence/log validation. */
export function getZhihuArchiveIdentity(input: unknown): string {
  if (!object(input)) return fail('不是可阅览的知乎文件');
  let value: unknown = input;
  if (input.format === 'gonglun-view-3') {
    if (!object(input.zhihu)) return fail('公论文档缺少知乎原始资料');
    value = input.zhihu.archive;
  } else if (input.format === 'gonglun-zhihu-reviewed') {
    if (![1, 2, 3, 4, 5].includes(input.version as number)) return fail('不支持的知乎整理文件版本');
    if ((input.version as number) >= 3 && input.localOperations === undefined) return fail('新版整理文件缺少本地操作记录');
    value = input.archive;
  }
  if (!object(value) || value.format !== 'gonglun-zhihu-archive' || value.version !== 1) return fail('不支持的知乎归档版本');
  if (value.platform !== undefined && value.platform !== 'zhihu') fail('归档来源平台不是知乎');
  if (!Array.isArray(value.items) || !Array.isArray(value.comments)) return fail('知乎归档缺少作品或评论列表');
  if (value.items.length + value.comments.length > 100_000) fail('单份知乎归档记录过多');
  const owner: Pick<SourcePerson, 'id' | 'url'> = {};
  if (value.owner != null) {
    if (!object(value.owner)) return fail('原站作者资料无效');
    if (value.owner.id != null) owner.id = identifier(value.owner.id, '作者');
    else if (value.owner.url != null) {
      // Keep URL-only identities compatible with already accepted source files.
      // The ordinary source character budget also bounds this fallback field.
      if (typeof value.owner.url !== 'string' || value.owner.url.length > 100_000_000) fail('作者链接无效');
      owner.url = value.owner.url;
    }
  }
  let activitySource: ArchiveIdentitySource['activitySource'];
  if (value.activitySource !== undefined) {
    const activity = value.activitySource;
    if (!object(activity) || activity.version !== 1 || !['collections', 'activities'].includes(activity.scope as string)
      || !Array.isArray(activity.events) || !Array.isArray(activity.folders)) return fail('知乎来源记录范围或版本无效');
    if (activity.events.length + activity.folders.length > 100_000) fail('知乎来源记录数量无效');
    activitySource = { scope: activity.scope as 'collections' | 'activities', events: [] };
    // Account-owned collection/activity identity intentionally excludes changing
    // events and works. Their contents are validated when the document is read.
    if (owner.id || safeUrl(owner.url)) return archiveIdentity({ owner, items: [], comments: [], activitySource });
    activitySource.events = activity.events.map(entry => ({ id: identifier(object(entry) ? entry.id : null, '事件') }));
  }
  const seen = new Set<string>();
  const items = value.items.map(entry => {
    if (!object(entry) || !['answer', 'article', 'pin'].includes(entry.type as string)) return fail('知乎作品类型无效');
    const id = identifier(entry.id, '原站记录'), type = entry.type as ZhihuItem['type'], thread = `${type}:${id}`;
    if (seen.has(thread)) fail('知乎归档包含重复作品编号'); seen.add(thread);
    return { id, type };
  });
  const comments = value.comments.map(entry => ({ threadId: identifier(object(entry) ? entry.threadId : null, '讨论') }));
  return archiveIdentity({ owner, items, comments, ...(activitySource ? { activitySource } : {}) });
}

/** Project source records into the existing viewer, with no ledger or publication fields. */
export function prepareZhihuForViewing(input: unknown): ZhihuViewingData {
  return projectReviewedSource(sourceParts(cloneViewingSource(input)));
}

function projectReviewedSource({ archive, overrides, relations, localOperations, view }: ReturnType<typeof sourceParts>): ZhihuViewingData {
  const messages: ExportData['messages'] = [], projectedRelations: ExportData['relations'] = [];
  const byMessageId: Record<string, ZhihuMessageSource> = {};
  const users = new Map<string, NonNullable<ExportData['users']>[number]>();
  const warnings = ['本地知乎资料，仅供阅览；原站内容未经平台认证。人工整理与原始证据分别保留。', ...sourceWarnings(archive)];
  const rows = new Map(relations.map(row => [key(row.threadId, row.commentId), row]));
  const aliases = new Map<string, string>();
  const threads = new Set(archive.comments.map(comment => comment.threadId));
  const itemsByThread = new Map<string, ZhihuItem>();
  const rawItemCounts = new Map<string, number>();
  for (const item of archive.items) rawItemCounts.set(item.id, (rawItemCounts.get(item.id) || 0) + 1);
  for (const item of archive.items) {
    itemsByThread.set(canonicalThread(item), item);
    if (rawItemCounts.get(item.id) === 1) itemsByThread.set(item.id, item);
  }
  for (const comment of archive.comments) {
    const id = commentId(comment.threadId, comment.sourceId || comment.id);
    aliases.set(key(comment.threadId, comment.id), id);
    aliases.set(key(comment.threadId, comment.sourceId || comment.id), id);
  }
  function authorship(record: SourceFields | ZhihuQuestion, id: string) {
    const author = record.author?.name || '作者未提供';
    const authorKey = record.author?.id ? `id:${record.author.id}` : safeUrl(record.author?.url) ? `url:${safeUrl(record.author?.url)}` : `record:${id}`;
    const authorId = `zhihu:author:${encodeURIComponent(authorKey)}`;
    return { author, authorId };
  }
  function append(record: SourceFields, id: string, content: string, metadata: ZhihuMessageSource) {
    const { author, authorId } = authorship(record, id);
    if (!users.has(authorId)) users.set(authorId, { id: authorId, username: author, createdAt: '' });
    const createdAt = exactTime(record.createdAt);
    const parts: Part[] = [{ id: 'body', type: 'text', text: content }];
    // This index only preserves display order when the source date is absent or tied.
    // It is not an execution sequence and is never written into the source archive.
    const message = { id, sequence: messages.length + 1, kind: 'TEXT', contentType: 'TEXT', content, createdAt, authorId, author, revision: 1, parts };
    messages.push(message);
    byMessageId[id] = metadata;
  }
  function appendRelation(input: { id: string; type: 'REPLY' | 'AGREE' | 'DISAGREE' | 'CLASSIFY' | 'REFERENCE'; sourceMessageId: string | null; targets: string[];
    author: string; authorId: string; createdAt: string; meta: ZhihuMessageSource; content?: string; title?: string; label: string; supersededBy?: string | null }) {
    const { id, type, sourceMessageId, targets, author, authorId, createdAt } = input;
    const targetRefs = targets.map(messageId => ({ kind: 'message' as const, messageId }));
    const roles: Extract<Part, { type: 'relation' }>['roles'] = type === 'CLASSIFY'
      ? { members: targets.map((messageId, index) => ({ id: `member-${index}`, reference: { messageId } })) }
      : { ...(sourceMessageId ? { source: [{ id: 'source', reference: { messageId: sourceMessageId } }] } : {}),
        target: targets.map((messageId, index) => ({ id: `target-${index}`, reference: { messageId } })) };
    const parts: Part[] = [ ...(input.content !== undefined ? [{ id: 'body', type: 'text' as const, text: input.content }] : []),
      { id: 'relation', type: 'relation', relation: type.toLowerCase(), roles } ];
    if (type === 'CLASSIFY') parts.push({ id: 'source-fields', type: 'data', value: { title: input.meta.kind === 'question' ? input.meta.questionTitle || '' : input.title || '' } });
    const payload = { source: 'zhihu-local-view', label: input.label, note: input.label, ...(input.title !== undefined ? { title: input.title } : {}),
      // These classifications are source navigation, not user-authored moves.
      ...(type === 'CLASSIFY' ? { separateTitle: true, sourceNavigation: true } : {}) };
    const sequence = messages.length + 1;
    const supersededBy = input.supersededBy || null;
    const record = { id, sequence, revision: 1, parts, relationType: type, sourceMessageId, targetRefs, payload, createdAt, authorId, author, supersededBy };
    projectedRelations.push(record);
    messages.push({ ...record, kind: 'RELATION', contentType: 'TEXT', content: input.content ?? '', relationPayload: payload });
    users.set(authorId, { id: authorId, username: author, createdAt: '' });
    byMessageId[id] = input.meta;
  }
  const metadata = (record: SourceFields | ZhihuQuestion, kind: ZhihuMessageSource['kind'], threadId: string, sourceUrl: string | null): ZhihuMessageSource => ({
    kind, threadId, sourceId: record.id || '', sourceUrl, authorName: record.author?.name || '作者未提供',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    createdAtText: record.createdAtText || (exactTime(record.createdAt) ? null : record.createdAt) || null,
    sourceLabels: [...(record.sourceLabels || [])],
  });
  for (const item of archive.items) {
    const threadId = threads.has(canonicalThread(item)) ? canonicalThread(item) : threads.has(item.id) && rawItemCounts.get(item.id) === 1 ? item.id : canonicalThread(item);
    append(item, itemId(item), item.type === 'answer' ? item.text : [item.title, item.text].filter(Boolean).join('\n\n'), metadata(item, 'item', threadId, safeUrl(item.url)));
  }
  const sourceComments = new Map<string, ZhihuComment>();
  for (const comment of archive.comments) {
    const sourceId = comment.sourceId || comment.id;
    const relation = rows.get(key(comment.threadId, sourceId))!;
    const item = itemsByThread.get(comment.threadId);
    const info = { ...metadata(comment, 'comment', comment.threadId, safeUrl(item?.url)), sourceId, relation };
    append(comment, commentId(comment.threadId, sourceId), comment.text, info);
    sourceComments.set(key(comment.threadId, sourceId), comment);
  }
  const originalRows = new Map(getRelations(archive).map(row => [key(row.threadId, row.commentId), row]));
  const revisionIndex = new Map(overrides.revisions.map(revision => [revision.id, revision]));
  function definition(row: RelationRow, observation?: ZhihuComment): ZhihuReplyDefinition | null {
    const comment = observation || sourceComments.get(key(row.threadId, row.commentId));
    if (!comment || row.source === 'unknown') return null;
    const item = itemsByThread.get(row.threadId);
    const targets = row.effectiveParentCommentIds.length
      ? row.effectiveParentCommentIds.flatMap(parent => aliases.get(key(row.threadId, parent)) || [])
      : item ? [itemId(item)] : [];
    if (!targets.length || targets.length !== row.effectiveParentCommentIds.length && row.effectiveParentCommentIds.length) return null;
    const sourceMessageId = commentId(row.threadId, row.commentId);
    let revision = row.revisionId ? revisionIndex.get(row.revisionId) : undefined;
    const visited = new Set<string>();
    // An explicit undo restores the prior relationship identity as well as its
    // targets, so pre-existing local opposition is restored instead of discarded.
    while (revision?.undoOfBatchId) {
      if (visited.has(revision.id)) fail('撤销记录包含循环版本引用');
      visited.add(revision.id);
      if (!revision.restoredFromRevisionId) {
        if (revision.action !== 'reset') fail('撤销记录缺少原回复版本');
        revision = undefined;
        break;
      }
      const previous = revisionIndex.get(revision.restoredFromRevisionId);
      if (!previous || previous.threadId !== row.threadId || aliases.get(key(previous.threadId, previous.commentId)) !== sourceMessageId) fail('撤销记录引用了其他评论或缺失的回复版本');
      revision = previous;
    }
    if (revision?.action === 'set') {
      const restoredParents = revision.parentCommentIds ?? (revision.parentCommentId ? [revision.parentCommentId] : []);
      const restoredTargets = restoredParents.length ? restoredParents.map(parent => aliases.get(key(row.threadId, parent))) : item ? [itemId(item)] : [];
      if (row.source !== 'manual' || JSON.stringify(restoredTargets) !== JSON.stringify(targets)) fail('撤销记录与恢复的回复目标不一致');
    } else if (row.source === 'manual') fail('人工回复缺少可验证的关系版本');
    const version = revision ? `${revision.id}-${shortHash(JSON.stringify(targets))}` : `original-${shortHash(JSON.stringify([sourceMessageId, targets]))}`;
    const id = `zhihu:reply:${encodeURIComponent(row.threadId)}:${encodeURIComponent(row.commentId)}:${encodeURIComponent(version)}`;
    const originalAuthor = authorship(comment, sourceMessageId);
    return { id, threadId: row.threadId, commentId: row.commentId, sourceMessageId, targetMessageIds: targets,
      source: row.source, method: row.method, ...(revision ? { revisionId: revision.id } : {}),
      createdAt: row.source === 'manual' ? revision?.createdAt || '' : exactTime(comment.createdAt),
      authorId: row.source === 'manual' ? LOCAL_AUTHOR.id : originalAuthor.authorId,
      author: row.source === 'manual' ? LOCAL_AUTHOR.name : originalAuthor.author };
  }
  const currentDefinitions = relations.flatMap(row => definition(row) || []);
  const knownDefinitions = new Map(currentDefinitions.map(value => [value.id, value]));
  for (const saved of localOperations.replyDefinitions) {
    const original = originalRows.get(key(saved.threadId, saved.commentId));
    if (!original) fail('本地回复版本引用了不存在的评论');
    let row = original!;
    if (saved.revisionId) {
      const revision = revisionIndex.get(saved.revisionId) || fail('本地回复版本缺少对应关系调整记录');
      if (revision.threadId !== saved.threadId || aliases.get(key(revision.threadId, revision.commentId)) !== saved.sourceMessageId) fail('本地回复版本与原有调整记录不一致');
      if (revision.action === 'set') {
        const parentIds = revision.parentCommentIds ?? (revision.parentCommentId ? [revision.parentCommentId] : []);
        row = { ...row, revisionId: revision.id, source: 'manual', method: revision.method || 'manual',
          effectiveParentCommentIds: parentIds, effectiveParentCommentId: parentIds.length === 1 ? parentIds[0] : null };
      } else row = { ...row, revisionId: revision.id };
    }
    let expected = definition(row);
    const matches = (candidate: ZhihuReplyDefinition | null) => !!candidate && JSON.stringify(candidate) === JSON.stringify(saved);
    // A normal source refresh may change the parent, author name or timestamp.
    // Old local actions must remain verifiable against preserved observations.
    if (!matches(expected) && saved.source === 'original') {
      const source = sourceComments.get(key(saved.threadId, saved.commentId))!;
      const versions = Array.isArray(source.versions) ? source.versions : [];
      for (const version of versions) {
        if (!object(version) || version.threadId !== saved.threadId || typeof version.id !== 'string'
          || (version.sourceId || version.id) !== saved.commentId) continue;
        try {
          validateFields(version);
          const observation = version as ZhihuComment;
          const historical = getRelations({ comments: archive.comments.map(comment => comment === source ? observation : comment) })
            .find(candidate => candidate.threadId === saved.threadId && candidate.commentId === saved.commentId);
          if (!historical) continue;
          const candidate = definition({ ...historical, ...(saved.revisionId ? { revisionId: saved.revisionId } : {}) }, observation);
          if (matches(candidate)) { expected = candidate; break; }
        } catch { /* Malformed snapshots are not proof for a local relationship. */ }
      }
    }
    if (!matches(expected)) fail('本地回复版本与原始评论或关系目标不一致');
    knownDefinitions.set(saved.id, expected!);
  }
  const latestStances = new Map<string, { operation: ZhihuLocalOperation; messageId: string }>();
  const stanceId = (operation: ZhihuLocalOperation, target: string) => `zhihu:local:${encodeURIComponent(operation.id)}:${shortHash(target)}`;
  for (const operation of localOperations.operations) {
    if (operation.mode) continue;
    if (!['REPLY', 'AGREE', 'DISAGREE'].includes(operation.type)) fail('旧版本操作包含不支持的本地组织');
    const targets = operation.targetRelationIds.map(id => knownDefinitions.get(id) || fail('本地赞反操作必须指向可验证的回复关系，不能指向评论或问题正文'));
    const selectedThreads = new Set(targets.map(target => target.threadId));
    if (selectedThreads.size !== 1) fail('本地操作不能跨作品连接回复关系');
    for (const id of operation.sourceMessageIds) if (byMessageId[id]?.kind !== 'comment' || !selectedThreads.has(byMessageId[id].threadId)) fail('本地操作的说明来源不是同一作品的评论');
    if (operation.type === 'REPLY') {
      if (!operation.overrideRevisionIds?.length || operation.overrideRevisionIds.some(id => !revisionIndex.has(id))
        || operation.overrideRevisionIds.length !== targets.length
        || targets.some(target => target.source !== 'manual' || !target.revisionId || !operation.overrideRevisionIds!.includes(target.revisionId))
        || operation.sourceMessageIds.length !== targets.length || targets.some(target => !operation.sourceMessageIds.includes(target.sourceMessageId))) fail('本地回复操作缺少对应关系调整记录');
    } else {
      if (operation.overrideRevisionIds !== undefined) fail('本地赞反记录不能夹带回复修订');
      for (const target of operation.targetRelationIds) latestStances.set(target, { operation, messageId: stanceId(operation, target) });
    }
  }
  const replyRelations: ZhihuReplyRelation[] = currentDefinitions.map(value => ({ ...value, current: true, active: latestStances.get(value.id)?.operation.type !== 'DISAGREE' }));
  for (const reply of replyRelations) {
    const row = rows.get(key(reply.threadId, reply.commentId))!;
    const source = byMessageId[reply.sourceMessageId];
    appendRelation({ id: reply.id, type: 'REPLY', sourceMessageId: reply.sourceMessageId, targets: reply.targetMessageIds,
      author: reply.author, authorId: reply.authorId, createdAt: reply.createdAt,
      label: reply.source === 'original' ? '原站回复' : reply.method === 'sequence' ? '本地按顺序整理' : '本地回复',
      meta: { ...source, kind: 'reply', sourceId: reply.id, authorName: reply.author, createdAt: reply.createdAt || null,
        createdAtText: reply.source === 'manual' ? null : source.createdAtText, sourceLabels: [],
        sourceMessageId: reply.sourceMessageId, targetMessageIds: reply.targetMessageIds, active: reply.active, relation: row } });
  }
  const currentReplyIds = new Set(replyRelations.map(reply => reply.id));
  for (const operation of localOperations.operations) {
    if (operation.mode || operation.type === 'REPLY') continue;
    if (operation.type !== 'AGREE' && operation.type !== 'DISAGREE') continue;
    for (const target of operation.targetRelationIds) {
      if (!currentReplyIds.has(target)) continue; // Replaced versions remain in the operation log, never reactivate silently.
      const reply = knownDefinitions.get(target)!;
      const id = stanceId(operation, target), latest = latestStances.get(target)!;
      appendRelation({ id, type: operation.type, sourceMessageId: null, targets: [target], content: operation.note || undefined,
        author: LOCAL_AUTHOR.name, authorId: LOCAL_AUTHOR.id, createdAt: operation.createdAt,
        label: operation.type === 'AGREE' ? '本地赞同回复关系' : '本地反对回复关系', supersededBy: id === latest.messageId ? null : latest.messageId,
        meta: { kind: 'local-operation', threadId: reply.threadId, sourceId: operation.id, sourceUrl: null,
          authorName: LOCAL_AUTHOR.name, createdAt: operation.createdAt, createdAtText: null, sourceLabels: [], targetMessageIds: [target], active: id === latest.messageId } });
    }
  }
  const questions = new Map<string, ZhihuQuestion>((archive.questions || []).map(question => [question.id!, question]));
  const primaryIds = new Set(questions.keys());
  const questionRank = (question: ZhihuQuestion) => typeof question.text === 'string' ? object(question.completeness) && question.completeness.body === 'complete' ? 2 : 1 : 0;
  for (const item of archive.items) if (item.type === 'answer' && item.question?.id) {
    const previous = questions.get(item.question.id);
    if (!previous || !primaryIds.has(item.question.id) && questionRank(item.question) > questionRank(previous)) questions.set(item.question.id, item.question);
  }
  for (const item of archive.items) if (item.type === 'answer' && item.question && !item.question.id)
    warnings.push(`作品 ${canonicalThread(item)} 的问题编号未取得，未按标题猜测归类。`);
  // Index once, preserving the original message order. Scanning the entire
  // discussion for every question makes opening large archives quadratic.
  const questionsByThread = new Map<string, Set<string>>();
  const membersByQuestion = new Map<string, string[]>();
  for (const item of archive.items) if (item.type === 'answer' && item.question?.id) {
    for (const thread of [canonicalThread(item), ...(rawItemCounts.get(item.id) === 1 ? [item.id] : [])]) {
      const ids = questionsByThread.get(thread) ?? new Set<string>();
      ids.add(item.question.id); questionsByThread.set(thread, ids);
    }
    if (!membersByQuestion.has(item.question.id)) membersByQuestion.set(item.question.id, []);
  }
  for (const message of messages) if (!message.supersededBy) {
    for (const questionId of questionsByThread.get(byMessageId[message.id]?.threadId) ?? [])
      membersByQuestion.get(questionId)!.push(message.id);
  }
  const questionMembers = new Set<string>(), questionCategories: string[] = [];
  for (const question of questions.values()) {
    if (!question.id) continue;
    const memberIds = membersByQuestion.get(question.id);
    if (!memberIds) continue;
    const id = questionMessageId(question.id), known = typeof question.text === 'string'
      && (question.text.length > 0 || object(question.completeness) && question.completeness.body === 'complete');
    const questionTitle = typeof question.title === 'string' ? question.title : null;
    const titleCompleteness: NonNullable<ZhihuMessageSource['titleCompleteness']> = object(question.completeness)
      && ['complete', 'partial', 'unknown'].includes(question.completeness.title as string)
      ? question.completeness.title as 'complete' | 'partial' | 'unknown' : 'unknown';
    const descriptionCompleteness: NonNullable<ZhihuMessageSource['descriptionCompleteness']> = known && object(question.completeness) && ['complete', 'partial'].includes(question.completeness.body as string)
      ? question.completeness.body as 'complete' | 'partial' : 'unknown';
    const info = { ...metadata(question, 'question', `question:${question.id}`, safeUrl(question.url)), questionTitle, titleCompleteness, descriptionKnown: known, descriptionCompleteness };
    const { author, authorId } = authorship(question, id);
    appendRelation({ id, type: 'CLASSIFY', sourceMessageId: null, targets: memberIds, content: known ? question.text! : '',
      title: questionTitle ?? (titleCompleteness === 'complete' ? '' : '问题标题未取得'), label: '原站问题', author, authorId, createdAt: exactTime(question.createdAt), meta: info });
    questionCategories.push(id);
    for (const member of memberIds) questionMembers.add(member);
    if (!known) warnings.push(`问题 ${question.id} 的描述未取得；分类正文留空不代表原站描述为空。`);
    else if (!object(question.completeness) || question.completeness.body !== 'complete') warnings.push(`问题 ${question.id} 的描述完整性未确认。`);
  }
  function appendNavigation(id: string, title: string, targets: string[], options: {
    content?: string; sourceId?: string; sourceUrl?: string | null; kind?: 'source-category' | 'source-folder';
    sourceLabels?: string[];
  } = {}) {
    appendRelation({ id, type: 'CLASSIFY', sourceMessageId: null, targets: [...new Set(targets)],
      content: options.content ?? '', title, label: '按已采集资料生成的阅览分类',
      author: CATEGORY_AUTHOR.name, authorId: CATEGORY_AUTHOR.id, createdAt: '',
      meta: { kind: options.kind ?? 'source-category', threadId: `navigation:${id}`, sourceId: options.sourceId ?? id,
        sourceUrl: options.sourceUrl ?? null, authorName: CATEGORY_AUTHOR.name, createdAt: null, createdAtText: null,
        sourceLabels: options.sourceLabels ?? [], ...(archive.activitySource ? { activityScope: archive.activitySource.scope } : {}) } });
  }
  // A discussion uses the original messages and reply relations. Navigation
  // paths may reference them repeatedly; source text/message identities are not copied.
  const discussionMembers = new Map<string, string[]>();
  for (const message of messages) {
    if (message.supersededBy) continue;
    const item = itemsByThread.get(byMessageId[message.id]?.threadId);
    if (item) {
      const key = canonicalThread(item), members = discussionMembers.get(key) ?? [];
      members.push(message.id); discussionMembers.set(key, members);
    }
  }
  const articleCategories = new Map<string, string>(), articleMembers = new Set<string>();
  for (const item of archive.items) if (item.type === 'article') {
    const id = `zhihu:article:${encodeURIComponent(item.id)}`, members = discussionMembers.get(canonicalThread(item)) ?? [itemId(item)];
    const firstParagraph = item.text.split(/\r?\n+/u).find(paragraph => paragraph.trim().length > 0) ?? '';
    appendNavigation(id, item.title ?? '文章（标题未取得）', members, { content: firstParagraph,
      sourceId: item.id, sourceUrl: safeUrl(item.url), sourceLabels: [...(item.sourceLabels ?? [])] });
    articleCategories.set(item.id, id);
    for (const member of members) articleMembers.add(member);
  }
  // Keep the complete type index as another path to the same source messages.
  const membersByType = new Map<ZhihuItem['type'], string[]>();
  for (const item of archive.items) if (!membersByType.has(item.type)) membersByType.set(item.type, []);
  membersByType.get('answer')?.push(...questionCategories);
  membersByType.get('article')?.push(...articleCategories.values());
  for (const message of messages) {
    if (message.supersededBy || questionMembers.has(message.id) || articleMembers.has(message.id)) continue;
    const item = itemsByThread.get(byMessageId[message.id]?.threadId);
    if (item) membersByType.get(item.type)!.push(message.id);
  }
  for (const { type, title } of TYPE_CATEGORIES) {
    const targets = membersByType.get(type);
    if (!targets) continue;
    appendRelation({ id: `zhihu:type:${type}`, type: 'CLASSIFY', sourceMessageId: null, targets,
      title, label: '按原站内容类型生成的阅览分类', author: CATEGORY_AUTHOR.name, authorId: CATEGORY_AUTHOR.id, createdAt: '',
      meta: { kind: 'type-category', threadId: `type:${type}`, sourceId: type, sourceUrl: null,
        authorName: CATEGORY_AUTHOR.name, createdAt: null, createdAtText: null, sourceLabels: [] } });
  }
  if (archive.activitySource) {
    const source = archive.activitySource, rootId = `zhihu:source:${source.scope}`;
    const rootMembers: string[] = [], evidenceByEvent = new Map<string, string[]>();
    const currentEvents = source.coverage.currentEventIds ? new Set(source.coverage.currentEventIds) : null;
    const person = (value: import('./zhihuActivities').ActivityPerson | null): SourcePerson | null => value ? { ...value, name: value.name || '' } : null;
    for (const event of source.events) {
      const target = event.target.id && event.target.type ? itemsByThread.get(`${event.target.type}:${event.target.id}`) : undefined;
      const targetId = target ? itemId(target) : null, id = `zhihu:event:${source.scope}:${encodeURIComponent(event.id)}`;
      const evidence = activityEvidenceText(event, target, currentEvents ? currentEvents.has(event.id) : null), record = { id: event.id, text: evidence.content, author: person(event.actor), createdAt: event.createdAt, createdAtText: event.createdAtText };
      const info: ZhihuMessageSource = { ...metadata(record, 'activity-event', `source:${source.scope}`, safeUrl(event.sourceUrl)),
        activityScope: source.scope, ...(targetId ? { targetMessageId: targetId } : {}) };
      append(record, id, evidence.content, info);
      messages.at(-1)!.parts!.push({ id: 'source-event', type: 'data', value: {
        platform: 'zhihu', kind: event.kind, identity: event.identity, sourceId: event.sourceId, actor: event.actor,
        verb: event.verb, actionText: event.actionText, eventType: event.type, target: event.target, folderId: event.folderId,
        createdAt: event.createdAt, createdAtText: event.createdAtText, sourceUrl: event.sourceUrl, capturedAt: event.capturedAt,
      } });
      const members = [id]; evidenceByEvent.set(event.id, members);
      if (evidence.missing) warnings.push(`来源事件 ${event.id}：${evidence.missing}`);
      if (targetId) {
        const referenceId = `zhihu:event-reference:${source.scope}:${encodeURIComponent(event.id)}`;
        appendRelation({ id: referenceId, type: 'REFERENCE', sourceMessageId: id, targets: [targetId],
          author: CATEGORY_AUTHOR.name, authorId: CATEGORY_AUTHOR.id, createdAt: '', label: '阅读本地目标原文（来源引用，非表态）',
          meta: { ...info, kind: 'activity-reference', sourceId: event.id, authorName: CATEGORY_AUTHOR.name, createdAt: null, createdAtText: null,
            sourceMessageId: id, targetMessageId: targetId, targetMessageIds: [targetId] } });
        members.push(referenceId);
      }
    }
    function contentPaths(parentId: string, events: typeof source.events): string[] {
      const selectedItems = new Map<string, ZhihuItem>();
      for (const event of events) {
        const item = event.target.id && event.target.type ? itemsByThread.get(`${event.target.type}:${event.target.id}`) : undefined;
        if (item) selectedItems.set(canonicalThread(item), item);
      }
      const byAuthor = new Map<string, { author: SourcePerson | null | undefined; items: ZhihuItem[] }>();
      for (const item of selectedItems.values()) {
        // A display name is never an identity. Unidentified authors stay per-work.
        const author = item.author, key = author?.id ? `id:${author.id}` : safeUrl(author?.url) ? `url:${safeUrl(author?.url)}` : `work:${canonicalThread(item)}`;
        const group = byAuthor.get(key) ?? { author, items: [] };
        group.items.push(item); byAuthor.set(key, group);
      }
      const children: string[] = [];
      for (const [authorKey, group] of byAuthor) {
        const authorId = `zhihu:author-category:${shortHash(JSON.stringify([parentId, authorKey]))}`, typeIds: string[] = [];
        for (const { type, title } of TYPE_CATEGORIES) {
          const items = group.items.filter(item => item.type === type); if (!items.length) continue;
          const typeId = `${authorId}:type:${type}`, targets: string[] = [], groupedQuestions = new Map<string, ZhihuItem[]>();
          for (const item of items) {
            if (type === 'article') { targets.push(articleCategories.get(item.id)!); continue; }
            if (type === 'answer' && item.question?.id) {
              const subset = groupedQuestions.get(item.question.id) ?? []; subset.push(item); groupedQuestions.set(item.question.id, subset);
            } else targets.push(...(discussionMembers.get(canonicalThread(item)) ?? [itemId(item)]));
          }
          for (const [questionId, answers] of groupedQuestions) {
            const question = questions.get(questionId)!, id = `${typeId}:question:${encodeURIComponent(questionId)}`;
            appendNavigation(id, question.title ?? '问题标题未取得', answers.flatMap(item => discussionMembers.get(canonicalThread(item)) ?? [itemId(item)]),
              { sourceId: questionId, sourceUrl: safeUrl(question.url) });
            targets.push(id);
          }
          appendNavigation(typeId, title, targets, { sourceId: type }); typeIds.push(typeId);
        }
        appendNavigation(authorId, group.author?.name || '作者未提供', typeIds,
          { sourceId: authorKey, sourceUrl: safeUrl(group.author?.url) });
        children.push(authorId);
      }
      // Evidence stays available without making a source-event link the reading path.
      const evidenceIds = events.flatMap(event => evidenceByEvent.get(event.id) ?? []);
      if (evidenceIds.length) {
        const id = `${parentId}:evidence`;
        appendNavigation(id, '来源记录与缺失提示', evidenceIds); children.push(id);
      }
      return children;
    }
    if (source.scope === 'collections') {
      const folderIds = new Set([...source.folders.map(folder => folder.id), ...source.events.flatMap(event => event.folderId ? [event.folderId] : [])]);
      for (const folderId of folderIds) {
        const folder = source.folders.find(entry => entry.id === folderId), id = `zhihu:folder:${encodeURIComponent(folderId)}`;
        const members = contentPaths(id, source.events.filter(event => event.folderId === folderId));
        if (folder) {
          const record = { id: folder.id, text: folder.description || '', author: person(folder.creator), createdAt: folder.createdAt };
          const { author, authorId } = authorship(record, id);
          appendRelation({ id, type: 'CLASSIFY', sourceMessageId: null, targets: members, content: folder.description || '',
            title: folder.title || '收藏夹（标题未取得）', label: '原站收藏夹', author, authorId, createdAt: exactTime(folder.createdAt),
            meta: { ...metadata(record, 'source-folder', `folder:${folder.id}`, safeUrl(folder.url) || safeUrl(folder.sourceUrl)), activityScope: source.scope } });
        } else {
          appendNavigation(id, '收藏夹（资料未取得）', members, { kind: 'source-folder', sourceId: folderId });
          warnings.push(`收藏夹 ${folderId} 的资料未取得；保留其已采集内容，未猜测收藏夹名称。`);
        }
        rootMembers.push(id);
      }
      const unfiled = source.events.filter(event => !event.folderId);
      if (unfiled.length) {
        const id = `${rootId}:unfiled`; appendNavigation(id, '收藏夹归属未取得', contentPaths(id, unfiled)); rootMembers.push(id);
      }
    } else {
      // Only explicit known source verbs are labelled as likes. Other actions
      // remain literal source observations rather than inferred approval.
      const likeVerbs = new Set(['ANSWER_VOTE_UP', 'ARTICLE_VOTE_UP', 'PIN_VOTE_UP', 'PIN_LIKE']);
      const liked = source.events.filter(event => likeVerbs.has(event.verb ?? ''));
      const other = source.events.filter(event => !likeVerbs.has(event.verb ?? ''));
      for (const [key, title, events] of [['likes', '点赞', liked], ['other', '其他动态', other]] as const) {
        if (!events.length) continue;
        const id = `${rootId}:${key}`; appendNavigation(id, title, contentPaths(id, events)); rootMembers.push(id);
      }
    }
    appendRelation({ id: rootId, type: 'CLASSIFY', sourceMessageId: null, targets: rootMembers,
      title: source.scope === 'collections' ? '收藏夹' : '动态', content: '按已采集作者与内容类型阅览。仅包含这份文件中的作品；来源记录和缺失提示单独保留。',
      label: '来源内容目录', author: CATEGORY_AUTHOR.name, authorId: CATEGORY_AUTHOR.id, createdAt: '',
      meta: { kind: 'source-category', threadId: `source:${source.scope}`, sourceId: source.scope, sourceUrl: null,
        authorName: CATEGORY_AUTHOR.name, createdAt: null, createdAtText: null, sourceLabels: [], activityScope: source.scope } });
  }
  const pending = relations.filter(row => row.needsReview).length;
  if (pending) warnings.push(`${pending} 条评论的回复关系仍待核对；未猜测缺失的直接回复对象。`);
  if (archive.comments.some(comment => !itemsByThread.has(comment.threadId))) warnings.push('部分评论缺少对应作品，保留为独立记录。');
  const data: ZhihuViewingData = {
    format: 'gonglun-view-3', formatVersion: 5, exportedAt: exactTime(archive.updatedAt) || exactTime(archive.createdAt),
    scope: { messageId: null, title: `知乎资料${archive.owner?.name ? ` · ${archive.owner.name}` : ''}` },
    messages, relations: projectedRelations, users: [...users.values()], ...(view ? { view } : {}),
    zhihu: { archiveId: archiveIdentity(archive), archive, overrides, relations, localOperations, replyRelations, byMessageId,
      inactiveRelationIds: [], membershipParents: {}, warnings, readOnly: true },
  };
  return projectZhihuLocalAdditions(data, knownDefinitions);
}

function current(data: ZhihuViewingData): ZhihuViewingData {
  if (!isZhihuViewingData(data)) return fail('当前文件不是知乎阅览资料');
  return prepareZhihuForViewing(data);
}
function rebuild(data: ZhihuViewingData, overrides: RelationOverrides, localOperations = data.zhihu.localOperations): ZhihuViewingData {
  // Every local operation starts with current(), which owns a validated copy.
  // Revalidate its small editing records without cloning the source archive again.
  const changes = cloneInput({ overrides, localOperations, ...(data.view ? { view: data.view } : {}) }) as Record<string, unknown>;
  return projectReviewedSource(reviewedSourceParts(data.zhihu.archive, changes.overrides, changes.localOperations, changes.view));
}
function selectedComments(data: ZhihuViewingData, ids: string[] | undefined): ZhihuMessageSource[] {
  if (!Array.isArray(ids) || !ids.length) return fail('请选择至少一条来源评论');
  return [...new Set(ids)].map(id => {
    const record = data.zhihu.byMessageId[id];
    if (!record || record.kind !== 'comment') return fail('来源只能选择本文件中的评论，作品不能作为回复来源');
    return record;
  });
}
function threadFor(data: ZhihuViewingData, sources: ZhihuMessageSource[], requested?: string): string {
  const threads = [...new Set(sources.length ? sources.map(source => source.threadId) : data.zhihu.relations.map(row => row.threadId))];
  if (requested !== undefined) {
    identifier(requested, '讨论');
    if (sources.some(source => source.threadId !== requested) || !data.zhihu.relations.some(row => row.threadId === requested)) fail('不能跨作品调整回复关系');
    return requested;
  }
  if (threads.length !== 1) return fail('请选择一个作品后再整理，不能跨作品调整回复关系');
  return threads[0];
}
function singleBatch(data: ZhihuViewingData, sources: ZhihuMessageSource[], action: 'root' | 'reset', note?: string): RelationOverrides {
  let overrides = data.zhihu.overrides;
  const start = overrides.revisions.length, batchId = crypto.randomUUID();
  // Resetting several subjects can temporarily form a cycle even when their final
  // original graph is valid. Validate the final graph by first clearing all chosen
  // outgoing edges in memory; temporary revisions never enter the saved history.
  if (action === 'reset') {
    for (const source of sources) overrides = applyRelation(data.zhihu.archive, overrides,
      { threadId: source.threadId, commentId: source.sourceId, parentCommentIds: [] });
    const before = overrides.revisions.slice(start).map(revision => revision.beforeRevision);
    const temporaryEnd = overrides.revisions.length;
    for (const source of sources) overrides = resetRelation(data.zhihu.archive, overrides,
      { threadId: source.threadId, commentId: source.sourceId, note });
    return { ...overrides, revisions: [...data.zhihu.overrides.revisions,
      ...overrides.revisions.slice(temporaryEnd).map((revision, index) => ({ ...revision, batchId, beforeRevision: before[index] }))] };
  }
  for (const source of sources) {
    const input = { threadId: source.threadId, commentId: source.sourceId, note };
    overrides = applyRelation(data.zhihu.archive, overrides, { ...input, parentCommentIds: [] });
  }
  return { ...overrides, revisions: overrides.revisions.map((revision, index) => index < start ? revision : { ...revision, batchId }) };
}
export function updateZhihuRelations(input: ZhihuViewingData, change: ZhihuRelationUpdate): ZhihuViewingData {
  const data = current(input);
  if (!change || !['sets', 'sequence'].includes(change.mode)) return fail('未知的关系整理方式');
  const sources = change.mode === 'sequence' && change.sourceMessageIds === undefined ? [] : selectedComments(data, change.sourceMessageIds);
  const threadId = threadFor(data, sources, change.threadId);
  if (change.mode === 'sequence') {
    if (change.targetMessageIds?.length) fail('按顺序整理不接受目标集合');
    return rebuild(data, applyRelationBatch(data.zhihu.archive, data.zhihu.overrides, { mode: 'sequence', threadId,
      ...(sources.length ? { sourceCommentIds: sources.map(source => source.sourceId) } : {}), note: change.note }));
  }
  if (!Array.isArray(change.targetMessageIds) || !change.targetMessageIds.length) return fail('请选择至少一个回复目标');
  const targets = [...new Set(change.targetMessageIds)].map(id => data.zhihu.byMessageId[id] || fail('回复目标不存在于此文件中'));
  if (targets.some(target => target.kind !== 'comment' && target.kind !== 'item')) fail('回复目标只能是评论或作品；问题分类和关系记录不能作为此回复的目标');
  if (targets.some(target => target.threadId !== threadId)) fail('不能跨作品调整回复关系');
  if (targets.some(target => target.kind === 'item')) {
    if (targets.length !== 1) fail('回复作品表示顶层评论，不能同时选择其他回复目标');
    return rebuild(data, singleBatch(data, sources, 'root', change.note));
  }
  return rebuild(data, applyRelationBatch(data.zhihu.archive, data.zhihu.overrides, { mode: 'sets', threadId,
    sourceCommentIds: sources.map(source => source.sourceId), targetCommentIds: targets.map(target => target.sourceId), note: change.note }));
}
export function resetZhihuRelations(input: ZhihuViewingData, sourceMessageIds: string[]): ZhihuViewingData {
  const data = current(input), sources = selectedComments(data, sourceMessageIds);
  threadFor(data, sources);
  return rebuild(data, singleBatch(data, sources, 'reset'));
}
export function getZhihuUndoBatch(data: ZhihuViewingData): { threadId: string; batchId: string } | null {
  const revisions = data.zhihu.overrides.revisions;
  const latest = new Map(revisions.map(revision => [key(revision.threadId, revision.commentId), revision.id]));
  const undone = new Set(revisions.flatMap(revision => revision.undoOfBatchId ? [revision.undoOfBatchId] : []));
  const checked = new Set<string>();
  for (let index = revisions.length - 1; index >= 0; index--) {
    const revision = revisions[index];
    if (!revision.batchId || revision.undoOfBatchId || undone.has(revision.batchId) || checked.has(revision.batchId)) continue;
    checked.add(revision.batchId);
    const batch = revisions.filter(value => value.batchId === revision.batchId);
    if (batch.every(value => value.threadId === revision.threadId && latest.get(key(value.threadId, value.commentId)) === value.id && Object.hasOwn(value, 'beforeRevision')))
      return { threadId: revision.threadId, batchId: revision.batchId };
  }
  return null;
}
export function undoZhihuRelations(input: ZhihuViewingData, selection?: { threadId?: string; batchId?: string }): ZhihuViewingData {
  const data = current(input), latest = getZhihuUndoBatch(data);
  const batch = selection?.batchId ? { threadId: selection.threadId || latest?.threadId || '', batchId: selection.batchId } : latest;
  if (!batch) return fail('没有可撤销的完整整理批次');
  return rebuild(data, undoRelationBatch(data.zhihu.archive, data.zhihu.overrides, batch));
}
export function serializeZhihuViewingData(input: ZhihuViewingData): string {
  const data = current(input);
  return JSON.stringify({ ...materializeRelations(data.zhihu.archive, data.zhihu.overrides), version: 5, localOperations: data.zhihu.localOperations,
    ...(data.view ? { view: data.view } : {}) }, null, 2);
}

/** Only current reply versions are selectable; opposed versions remain here for restoration. */
export function getZhihuReplyRelations(data: ZhihuViewingData): ZhihuReplyRelation[] {
  return (data.zhihu.replyRelations || []).map(reply => ({ ...reply, targetMessageIds: [...reply.targetMessageIds] }));
}

export function sendZhihuLocalRelation(input: ZhihuViewingData, change: ZhihuLocalSendInput): ZhihuViewingData {
  const data = current(input);
  return rebuild(data, data.zhihu.overrides, buildZhihuLocalSend(data, change));
}

export function getZhihuInactiveRelationIds(data: ZhihuViewingData): Set<string> {
  return new Set(data.zhihu.inactiveRelationIds);
}
export function getZhihuLocalRelations(data: ZhihuViewingData) {
  const inactive = getZhihuInactiveRelationIds(data);
  return data.messages.flatMap(message => {
    const meta = data.zhihu.byMessageId[message.id];
    if (meta?.kind !== 'reply' && meta?.kind !== 'local-organization' && meta?.kind !== 'local-correction') return [];
    return [{ id: message.id, relationType: message.relationType as 'REPLY' | 'CORRECT' | ZhihuOrganizationType, active: !inactive.has(message.id),
      sourceMessageIds: meta.sourceMessageId ? [meta.sourceMessageId] : [], targetMessageIds: meta.targetMessageIds || [],
      ...(meta.kind === 'local-organization' ? { title: (message.relationPayload as { title?: string } | null)?.title } : {}),
      ...(meta.kind === 'local-correction' ? { title: meta.correctionKind === 'WIDTH' ? `宽度调整 · ${meta.correctionWidth} px` : meta.correctionField === 'title' ? '本地标题更正' : '本地正文更正' } : {}) }];
  });
}
