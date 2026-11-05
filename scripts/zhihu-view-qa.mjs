import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';

// Development QA only: reads actual files, builds the existing pure viewer code
// in memory, and emits counts/timings. It never writes source data or makes requests.
const arguments_ = process.argv.slice(2);
const developmentRequirement = '此脚本仅用于公论仓库的开发 QA：需要完整 frontend 源码、Node.js 24+，以及在仓库根目录安装的开发依赖（含 esbuild）。独立 personal-data-exporter 程序的登录、采集、导出和整理功能不依赖此脚本。';
if (!arguments_[0] || arguments_[0] === '--help') {
  console.log(`${developmentRequirement}\n\n从仓库根目录运行：\nnode scripts/zhihu-view-qa.mjs <gonglun.json> [--checkpoint <checkpoint.json>]\nnode scripts/zhihu-view-qa.mjs <checkpoint.json> --from-checkpoint\n\n只读本机文件，在内存中验证；不修改源文件，不请求网络。--from-checkpoint 是未完成采集快照的预检查，不代表最终导出已通过验收。`);
  process.exit(arguments_[0] ? 0 : 1);
}
const checkpointIndex = arguments_.indexOf('--checkpoint');
const fromCheckpoint = arguments_[1] === '--from-checkpoint' && arguments_.length === 2;
if (!fromCheckpoint && arguments_.length !== (checkpointIndex === 1 && arguments_[2] ? 3 : 1)) throw new Error('只接受阅览文件和可选 --checkpoint 路径，或检查点文件及 --from-checkpoint');
const report = { file: resolve(arguments_[0]), stages: {}, checks: {}, errors: [] };
const timed = (name, operation) => {
  const start = performance.now();
  const result = operation();
  report.stages[name] = Math.round((performance.now() - start) * 100) / 100;
  return result;
};
const requireCheck = (value, name) => { report.checks[name] = Boolean(value); if (!value) throw new Error(name); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sizeOf(value) {
  let nodes = 0, characters = 0, depth = 0;
  const pending = [[value, 0]];
  while (pending.length) {
    const [entry, level] = pending.pop(); nodes++; depth = Math.max(depth, level);
    if (typeof entry === 'string') characters += entry.length;
    else if (entry && typeof entry === 'object') for (const child of Object.values(entry)) pending.push([child, level + 1]);
  }
  return { nodes, characters, depth, nodeBudgetUsed: nodes / 2_000_000, characterBudgetUsed: characters / 100_000_000 };
}

try {
  let build;
  try {
    await stat(new URL('../frontend/src/utils/zhihuArchive.ts', import.meta.url));
    ({ build } = await import('esbuild'));
  } catch { throw new Error(developmentRequirement); }
  const metadata = await stat(report.file), text = await readFile(report.file, 'utf8');
  report.bytes = metadata.size; report.modifiedAt = metadata.mtime.toISOString();
  report.sha256 = createHash('sha256').update(text).digest('hex');
  const source = timed('parseMs', () => JSON.parse(text));
  if (fromCheckpoint) requireCheck(['gonglun-zhihu-crawl', 'gonglun-zhihu-activity-crawl'].includes(source.format) && source.archive, 'sourceCheckpoint');
  const compiled = await build({
    stdin: { contents: `export { validateExportForViewing } from '../frontend/src/utils/exportArchive.ts';
export { getZhihuMissingContent, getZhihuLocalRelations } from '../frontend/src/utils/zhihuArchive.ts';
export { serializeGonglunZhihuViewingData } from '../frontend/src/utils/zhihuGonglunExport.ts';
export { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../frontend/src/utils/workbenchProjection.ts';
export { deriveContainerEffect } from '../frontend/src/pages/workbench/model/containerEffect.ts';`,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'read-only-view-qa.ts', loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', treeShaking: true,
  });
  const model = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  // An active checkpoint is read once into memory. This creates no export or
  // checkpoint files and cannot affect the live crawler or its authentication.
  const input = fromCheckpoint ? timed('buildNativeFromCheckpointMs', () => JSON.parse(model.serializeGonglunZhihuViewingData(source.archive))) : source;
  report.inputKind = fromCheckpoint ? 'in-memory-checkpoint-preview' : 'saved-view-file';
  if (fromCheckpoint) report.checkpoint = { status: source.status, result: source.result, pending: source.queue?.length, requests: source.requestCount, updatedAt: source.updatedAt };
  requireCheck(input.format === 'gonglun-view-3' && input.zhihu?.archive, 'nativeZhihuEnvelope');
  report.nativeBytes = Buffer.byteLength(JSON.stringify(input));
  report.size = timed('measureSizeMs', () => sizeOf(input));
  const originalArchiveDigest = digest(fromCheckpoint ? source.archive : input.zhihu.archive);
  const data = timed('validateAndPrepareMs', () => model.validateExportForViewing(input).data);
  const archive = data.zhihu.archive, byId = new Map(data.messages.map(message => [message.id, message]));
  requireCheck(digest(archive) === originalArchiveDigest, 'sourceArchiveUnchanged');
  requireCheck(byId.size === data.messages.length, 'uniqueMessageIds');
  requireCheck(new Set(data.relations.map(relation => relation.id)).size === data.relations.length, 'uniqueRelationIds');
  requireCheck(data.messages.every(message => Number.isSafeInteger(message.revision) && Array.isArray(message.parts)), 'nativeMessageParts');
  requireCheck(!data.view?.classificationId || byId.has(data.view.classificationId), 'savedClassificationExists');
  const sourceIndex = new Map(Object.entries(data.zhihu.byMessageId).map(([id, meta]) => [JSON.stringify([meta.kind, meta.threadId, meta.sourceId]), id]));
  for (const item of archive.items) {
    const id = `zhihu:item:${encodeURIComponent(item.type)}:${encodeURIComponent(item.id)}`;
    const expected = item.type === 'answer' ? item.text : [item.title, item.text].filter(Boolean).join('\n\n');
    requireCheck(byId.get(id)?.content === expected, 'allOriginalItemBodiesRetained');
  }
  for (const comment of archive.comments) {
    const id = sourceIndex.get(JSON.stringify(['comment', comment.threadId, comment.sourceId || comment.id]));
    requireCheck(id && byId.get(id)?.content === comment.text, 'allOriginalCommentBodiesRetained');
  }
  for (const relation of data.relations) {
    requireCheck(byId.has(relation.id), 'allRelationRecordsRetained');
    for (const ref of relation.targetRefs || []) requireCheck(byId.has(ref.messageId || ref.relationId), 'allProjectedTargetsResolve');
  }
  const questions = Object.entries(data.zhihu.byMessageId).filter(([, meta]) => meta.kind === 'question');
  const categories = Object.entries(data.zhihu.byMessageId).filter(([, meta]) => meta.kind === 'type-category');
  const sourceTypes = new Set(archive.items.map(item => item.type));
  requireCheck(categories.length === sourceTypes.size && categories.every(([id, meta]) => sourceTypes.has(meta.sourceId) && id === `zhihu:type:${meta.sourceId}`), 'oneCategoryPerPresentSourceType');
  const questionIds = new Set(archive.items.filter(item => item.type === 'answer' && item.question?.id).map(item => item.question.id));
  requireCheck(questions.length === questionIds.size, 'oneClassificationPerReferencedQuestion');
  const itemIdCounts = new Map();
  for (const item of archive.items) itemIdCounts.set(item.id, (itemIdCounts.get(item.id) || 0) + 1);
  const threadEntries = (item, value) => [[`${item.type}:${item.id}`, value], ...(itemIdCounts.get(item.id) === 1 ? [[item.id, value]] : [])];
  const questionByThread = new Map(archive.items.filter(item => item.type === 'answer' && item.question?.id)
    .flatMap(item => threadEntries(item, item.question.id)));
  const articleByThread = new Map(archive.items.filter(item => item.type === 'article')
    .flatMap(item => threadEntries(item, `zhihu:article:${encodeURIComponent(item.id)}`)));
  const relations = new Map(data.relations.map(relation => [relation.id, relation]));
  const membersByQuestion = new Map(questions.map(([id, meta]) => [meta.sourceId, new Set(relations.get(id).targetRefs.map(ref => ref.messageId || ref.relationId))]));
  const membersByType = new Map(categories.map(([id, meta]) => [meta.sourceId, new Set(relations.get(id).targetRefs.map(ref => ref.messageId || ref.relationId))]));
  const membersByArticle = new Map([...new Set(articleByThread.values())].map(id => [id, new Set((relations.get(id)?.targetRefs || []).map(ref => ref.messageId || ref.relationId))]));
  requireCheck(questions.every(([id]) => membersByType.get('answer')?.has(id)), 'questionCategoriesBelongToAnswers');
  requireCheck([...membersByArticle.keys()].every(id => relations.has(id) && membersByType.get('article')?.has(id)), 'articleDiscussionsBelongToArticles');
  const typeByThread = new Map(archive.items.flatMap(item => threadEntries(item, item.type)));
  for (const [id, meta] of Object.entries(data.zhihu.byMessageId)) if (['item', 'comment'].includes(meta.kind)) {
    const question = questionByThread.get(meta.threadId);
    if (question) requireCheck(membersByQuestion.get(question)?.has(id), 'answersAndCommentsBelongToQuestion');
    const article = articleByThread.get(meta.threadId);
    if (article) requireCheck(membersByArticle.get(article)?.has(id), 'articlesAndCommentsBelongToDiscussion');
    const type = typeByThread.get(meta.threadId);
    if (type) requireCheck(question || article ? !membersByType.get(type)?.has(id) : membersByType.get(type)?.has(id), 'originalRecordsHaveOneTypeBranch');
  }
  const inactive = new Set(data.zhihu.inactiveRelationIds);
  const activityEvents = Object.entries(data.zhihu.byMessageId).filter(([, meta]) => meta.kind === 'activity-event');
  requireCheck(activityEvents.length === (archive.activitySource?.events.length || 0), 'allSourceEventsRetained');
  const eventSource = new Map((archive.activitySource?.events || []).map(event => [event.id, event]));
  for (const [id, meta] of activityEvents) {
    requireCheck(byId.get(id)?.kind === 'TEXT' && !byId.get(id)?.relationType, 'sourceEventsAreNotStances');
    const event = eventSource.get(meta.sourceId);
    requireCheck(!!event && (!meta.targetMessageId || byId.has(meta.targetMessageId) && data.zhihu.byMessageId[meta.targetMessageId]?.kind === 'item'), 'sourceEventTargetsResolveLocally');
    requireCheck(!event?.createdAt || byId.get(id)?.createdAt === event.createdAt, 'eventTimeNotReplacedByTargetTime');
  }
  requireCheck([...inactive].every(id => byId.has(id) && !['item', 'comment', 'question'].includes(data.zhihu.byMessageId[id]?.kind)), 'inactiveRelationsKeepEvidence');
  const missing = timed('missingContentListMs', () => model.getZhihuMissingContent(data));
  const activeRelations = timed('activeRelationListMs', () => model.getZhihuLocalRelations(data).filter(relation => relation.active));
  const commentsPerThread = new Map();
  for (const comment of archive.comments) commentsPerThread.set(comment.threadId, (commentsPerThread.get(comment.threadId) || 0) + 1);
  const projected = timed('nativeProjectionMs', () => model.projectWorkbenchSnapshot(model.archiveToWorkbenchSnapshot(data)));
  const effect = timed('nativeContainerEffectMs', () => model.deriveContainerEffect({ ...projected, username: null, stakeCounts: {} }));
  requireCheck(effect.edges.every(edge => !inactive.has(edge.relationMessageId)), 'inactiveConnectionsHidden');
  requireCheck(projected.messages.filter(message => ['item', 'comment'].includes(data.zhihu.byMessageId[message.id]?.kind)).length === archive.items.length + archive.comments.length, 'nativeProjectionRetainsOriginalBodies');
  const serialized = timed('serializeNativeMs', () => model.serializeGonglunZhihuViewingData(data));
  const reopened = timed('reopenNativeMs', () => model.validateExportForViewing(JSON.parse(serialized)).data);
  requireCheck(digest(reopened.zhihu.archive) === originalArchiveDigest, 'roundtripOriginalEvidence');
  requireCheck(isDeepStrictEqual(reopened.messages.map(message => message.id), data.messages.map(message => message.id)), 'roundtripMessageIds');
  requireCheck(isDeepStrictEqual(reopened.zhihu.localOperations, data.zhihu.localOperations), 'roundtripLocalHistory');
  requireCheck(isDeepStrictEqual(reopened.zhihu.inactiveRelationIds, data.zhihu.inactiveRelationIds), 'roundtripInactiveRelations');
  if (checkpointIndex === 1) {
    const checkpoint = JSON.parse(await readFile(resolve(arguments_[2]), 'utf8'));
    report.checkpoint = { status: checkpoint.status, result: checkpoint.result, pending: checkpoint.queue?.length, requests: checkpoint.requestCount };
    requireCheck(isDeepStrictEqual(checkpoint.archive, archive), 'matchesProvidedCheckpoint');
  }
  report.counts = { items: archive.items.length, comments: archive.comments.length, questions: questions.length, typeCategories: categories.length, sourceEvents: activityEvents.length,
    messages: data.messages.length, relations: data.relations.length, edges: projected.edges.length,
    missingFields: missing.length, inactiveRelations: inactive.size, warnings: data.zhihu.warnings.length,
    localOperations: data.zhihu.localOperations.operations.length };
  report.editorScale = { activeRelationButtons: activeRelations.length, missingContentButtons: missing.length,
    workOptions: archive.items.length, warningRows: data.zhihu.warnings.length,
    threadsWithComments: commentsPerThread.size, largestThreadComments: Math.max(0, ...commentsPerThread.values()) };
  report.maxRssKiB = process.resourceUsage().maxRSS;
  report.ok = true;
} catch (error) {
  report.ok = false; report.errors.push(error instanceof Error ? error.message : 'QA failed'); process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
