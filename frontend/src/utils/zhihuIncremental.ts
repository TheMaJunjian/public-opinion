import type { ExportData } from '../api/client';
import { prepareZhihuForViewing, type ZhihuViewingData } from './zhihuArchive';

export function stableZhihuValue(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().filter(key => entry[key] !== undefined).map(key => [key, entry[key]])) : entry);
}

/** Compare source trees without allocating another serialized copy of the document. */
export function sameZhihuValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left).filter(key => (left as Record<string, unknown>)[key] !== undefined);
  const b = Object.keys(right).filter(key => (right as Record<string, unknown>)[key] !== undefined);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && sameZhihuValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export function zhihuDocumentIdentity(data: ZhihuViewingData): string {
  const archive = data.zhihu.archive, owner = archive.owner?.id || archive.owner?.url;
  return stableZhihuValue([owner || data.zhihu.archiveId, archive.activitySource?.scope || 'own']);
}

function containsEvidence(before: unknown, after: unknown): boolean {
  if (Array.isArray(before)) return Array.isArray(after) && before.length === after.length && before.every((v, i) => containsEvidence(v, after[i]));
  if (before && typeof before === 'object') return !!after && typeof after === 'object'
    && Object.entries(before).every(([key, value]) => containsEvidence(value, (after as Record<string, unknown>)[key]));
  return before === after;
}
function observations(record: Record<string, unknown>): unknown[] {
  if (Array.isArray(record.versions) && record.versions.length) return record.versions;
  return [Object.fromEntries(Object.entries(record).filter(([key]) => !['versions', 'firstCapturedAt', 'lastCapturedAt', 'retainedFields', 'bodyCapturedAt'].includes(key)))];
}
function includesAll(before: unknown[], after: unknown[]): boolean {
  const exact = new Set(after.map(stableZhihuValue));
  return before.every(value => exact.has(stableZhihuValue(value)) || after.some(next => containsEvidence(value, next)));
}

/** Match the exporter's evidence-retention rule; an older/partial export cannot erase history. */
export function assertZhihuSourceUpdate(previous: ZhihuViewingData, incoming: ZhihuViewingData): void {
  if (zhihuDocumentIdentity(previous) !== zhihuDocumentIdentity(incoming)) throw new Error('更新文件属于不同用户或资料范围，原阅览与整理记录未修改。');
  const before = previous.zhihu.archive, after = incoming.zhihu.archive;
  const check = (older: Record<string, unknown>[], newer: Record<string, unknown>[], key: (record: Record<string, unknown>) => unknown) => {
    const records = new Map(newer.map(record => [key(record), record]));
    for (const record of older) {
      const next = records.get(key(record));
      if (!next || !includesAll(observations(record), observations(next))) throw new Error('导出文件缺少已有原文或历史版本，已保留当前阅览。请核对导出目录及采集结果。');
    }
  };
  check(before.items, after.items, r => `${r.type}:${r.id}`);
  check(before.comments, after.comments, r => `${r.threadId}:${r.sourceId || r.id}`);
  check(before.questions || [], after.questions || [], r => r.id);
  for (const field of ['captures', 'issues']) if (!includesAll((before[field] || []) as unknown[], (after[field] || []) as unknown[])) throw new Error('导出文件缺少已有采集历史，已保留当前阅览。');
  if (before.activitySource && after.activitySource) {
    check(before.activitySource.events as unknown as Record<string, unknown>[], after.activitySource.events as unknown as Record<string, unknown>[], r => r.id);
    check(before.activitySource.folders as unknown as Record<string, unknown>[], after.activitySource.folders as unknown as Record<string, unknown>[], r => r.id);
    if (!includesAll(before.activitySource.unparsedRecords, after.activitySource.unparsedRecords)) throw new Error('导出文件缺少已有收藏／动态证据，已保留当前阅览。');
  }
}

export function zhihuHistoryPrefix(before: unknown[], after: unknown[]): boolean {
  return before.length <= after.length && before.every((value, i) => stableZhihuValue(value) === stableZhihuValue(after[i]));
}

/** Histories are ordered. Never silently combine divergent edits or reinterpret their ordering. */
export function mergeZhihuLocalHistory(previous: ZhihuViewingData, incoming: ZhihuViewingData): ZhihuViewingData {
  const newest = <T,>(left: T, right: T, arrays: (value: T) => unknown[][]): T => {
    if (arrays(right).every((entries, i) => zhihuHistoryPrefix(entries, arrays(left)[i]))) return left;
    if (arrays(left).every((entries, i) => zhihuHistoryPrefix(entries, arrays(right)[i]))) return right;
    throw new Error('两份本地整理历史存在分叉，已停止更新并保留双方记录。请先核对使用的目录。');
  };
  const overrides = newest(previous.zhihu.overrides, incoming.zhihu.overrides, value => [value.revisions]);
  const localOperations = newest(previous.zhihu.localOperations, incoming.zhihu.localOperations, value => [value.operations, value.messages, value.replyDefinitions]);
  return prepareZhihuForViewing({ format: 'gonglun-zhihu-reviewed', version: 5,
    archive: incoming.zhihu.archive, overrides, localOperations, ...(previous.view ? { view: previous.view } : incoming.view ? { view: incoming.view } : {}) });
}

export function mergeZhihuSourceUpdate(previous: ZhihuViewingData, incoming: ZhihuViewingData): ZhihuViewingData {
  assertZhihuSourceUpdate(previous, incoming);
  return mergeZhihuLocalHistory(previous, incoming);
}

export type ZhihuEditState = Pick<ZhihuViewingData['zhihu'], 'overrides' | 'localOperations'> & { view?: ExportData['view'] };
export function zhihuEditState(data: ZhihuViewingData): ZhihuEditState {
  return { overrides: data.zhihu.overrides, localOperations: data.zhihu.localOperations, ...(data.view ? { view: data.view } : {}) };
}
