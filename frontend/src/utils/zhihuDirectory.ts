import { getExportCacheReference, withArchiveStore } from './exportViewerCache';
import { isZhihuViewingData, prepareZhihuForViewing, type ZhihuViewingData } from './zhihuArchive';
import { mergeZhihuLocalHistory, mergeZhihuSourceUpdate, sameZhihuValue, stableZhihuValue, zhihuDocumentIdentity, zhihuEditState, zhihuHistoryPrefix, type ZhihuEditState } from './zhihuIncremental';
import type { ExportData } from '../api/client';
import { prepareExportForViewing } from './exportArchive';
import { isNativeZhihuView, mergeNativeZhihuUpdate, nativeZhihuIdentity } from './nativeZhihuView';
import { appendNativeJournal, nativeJournalSignature, restoreNativeJournal } from './nativeZhihuJournal';

// The exporter owns gonglun.json. Gonglun alone owns this append-only sidecar.
export const ZHIHU_LOCAL_JOURNAL = 'gonglun-local.ndjson';
export type LinkedDirectory = { directory: FileSystemDirectoryHandle; sourceName: string; signature: string; documentId: string; journalSignature?: string };
type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};
type DirectoryPicker = (options: { mode: 'readwrite'; id: string }) => Promise<FileSystemDirectoryHandle>;
export function canLinkZhihuDirectory(): boolean { return typeof (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker === 'function'; }
export async function chooseZhihuDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (!picker) throw new Error('当前浏览器不支持关联目录，请使用 Chrome 或 Edge 打开阅览。');
  return picker.call(window, { mode: 'readwrite', id: 'gonglun-zhihu-export' });
}
const connectionKey = (id: string) => `__zhihu_directory__:${id}`;
const connections = new Map<string, LinkedDirectory>();
export async function rememberZhihuDirectory(data: ExportData, connection: LinkedDirectory): Promise<void> {
  const reference = getExportCacheReference(data);
  if (!reference) throw new Error('本机缓存不可用，目录尚未关联。');
  await withArchiveStore('readwrite', store => store.put(connection, connectionKey(reference.viewCacheId)));
  connections.set(reference.viewCacheId, connection);
}
export async function getZhihuDirectory(data: ExportData): Promise<LinkedDirectory | null> {
  const reference = getExportCacheReference(data);
  if (!reference) return null;
  if (connections.has(reference.viewCacheId)) return connections.get(reference.viewCacheId)!;
  const value = await withArchiveStore<LinkedDirectory | undefined>('readonly', store => store.get(connectionKey(reference.viewCacheId)));
  if (value) connections.set(reference.viewCacheId, value);
  return value || null;
}
export async function requireDirectoryPermission(connection: LinkedDirectory, request = false): Promise<void> {
  const handle = connection.directory as PermissionHandle;
  const options = { mode: 'readwrite' as const };
  if (await handle.queryPermission(options) === 'granted') return;
  if (request && await handle.requestPermission(options) === 'granted') return;
  throw new Error('目录权限需要恢复，请点击“检查更新”后允许访问。本机整理记录仍已保留。');
}
export async function readZhihuDirectory(directory: FileSystemDirectoryHandle): Promise<{ data: ExportData; connection: LinkedDirectory }> {
  // gonglun.json is atomically replaced by the exporter after a completed export.
  const file = await (await directory.getFileHandle('gonglun.json')).getFile();
  const parsed = JSON.parse(await file.text());
  if (isNativeZhihuView(parsed)) {
    const data = (await prepareExportForViewing(parsed)).data;
    if (!isNativeZhihuView(data)) throw new Error('精简阅览文件格式无效。');
    const connection = { directory, sourceName: 'gonglun.json', signature: `${file.lastModified}:${file.size}`, documentId: nativeZhihuIdentity(parsed), journalSignature: '' };
    const restored = await restoreNativeJournal(connection, data);
    connection.journalSignature = await nativeJournalSignature(connection);
    return { data: restored, connection };
  }
  const data = prepareZhihuForViewing(parsed);
  if (!isZhihuViewingData(data)) throw new Error('此目录没有可阅览的知乎 gonglun.json。');
  const connection = { directory, sourceName: 'gonglun.json', signature: `${file.lastModified}:${file.size}`, documentId: zhihuDocumentIdentity(data) };
  const restored = await restoreZhihuJournal(connection, data);
  return { data: restored, connection: { ...connection, journalSignature: await getJournalSignature(connection) } };
}

type HistoryArrays = { revisions: unknown[]; operations: unknown[]; messages: unknown[]; replyDefinitions: unknown[] };
type JournalRecord = { format: 'gonglun-zhihu-local-update'; version: 1; documentId: string; previous: string | null;
  base: Record<keyof HistoryArrays, number>; added: HistoryArrays; view?: ZhihuEditState['view']; digest: string };
type Journal = { state: ZhihuEditState; digest: string | null; size: number };
const arrays = (state: ZhihuEditState): HistoryArrays => ({ revisions: state.overrides.revisions,
  operations: state.localOperations.operations, messages: state.localOperations.messages, replyDefinitions: state.localOperations.replyDefinitions });
const fields = ['revisions', 'operations', 'messages', 'replyDefinitions'] as const;
async function digest(value: Omit<JournalRecord, 'digest'>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableZhihuValue(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function emptyState(): ZhihuEditState {
  return { overrides: { format: 'gonglun-zhihu-overrides', version: 2, revisions: [] },
    localOperations: { format: 'gonglun-zhihu-local-operations', version: 3, operations: [], messages: [], replyDefinitions: [] } };
}
async function readJournal(connection: LinkedDirectory): Promise<Journal> {
  let file: File;
  try { file = await (await connection.directory.getFileHandle(ZHIHU_LOCAL_JOURNAL)).getFile(); }
  catch (error) { if ((error as DOMException).name === 'NotFoundError') return { state: emptyState(), digest: null, size: 0 }; throw error; }
  if (file.size > 100_000_000) throw new Error('本地整理日志超过可读取大小，已保留原文件。');
  const text = await file.text(), state = emptyState();
  let previous: string | null = null;
  if (text && !text.endsWith('\n')) throw new Error('本地整理日志末尾不完整，已停止同步并保留原文件。');
  for (const line of text.split('\n').filter(Boolean)) {
    let record: JournalRecord;
    try { record = JSON.parse(line) as JournalRecord; }
    catch { throw new Error('本地整理日志无法解析，已停止同步并保留原文件。'); }
    if (!record || typeof record !== 'object') throw new Error('本地整理日志格式无效，已停止同步并保留原文件。');
    const { digest: checksum, ...payload } = record;
    if (record.format !== 'gonglun-zhihu-local-update' || record.version !== 1 || record.documentId !== connection.documentId
      || record.previous !== previous || !record.base || !record.added || checksum !== await digest(payload)) throw new Error('本地整理日志身份、顺序或校验失败，已停止同步并保留原文件。');
    const current = arrays(state);
    for (const field of fields) {
      if (!Array.isArray(record.added[field]) || current[field].length !== record.base[field]) throw new Error('本地整理日志顺序不一致，未覆盖文件。');
      for (const entry of record.added[field]) current[field].push(entry);
    }
    if (record.view) state.view = record.view;
    previous = checksum;
  }
  return { state, digest: previous, size: file.size };
}
export async function restoreZhihuJournal(connection: LinkedDirectory, source: ZhihuViewingData): Promise<ZhihuViewingData> {
  const journal = await readJournal(connection);
  const local = prepareZhihuForViewing({ format: 'gonglun-zhihu-reviewed', version: 5, archive: source.zhihu.archive, ...journal.state });
  return mergeZhihuLocalHistory(local, source);
}

/** Atomic close publishes a new tail. Re-reading under a browser lock prevents tab races. */
export async function appendZhihuJournal(connection: LinkedDirectory, data: ExportData): Promise<void> {
  if (isNativeZhihuView(data)) { await appendNativeJournal(connection, data); return; }
  if (!isZhihuViewingData(data)) throw new Error('不是可整理的知乎文档。');
  if (connection.documentId !== zhihuDocumentIdentity(data)) throw new Error('关联目录与当前资料不一致，未写入整理日志。');
  const append = async () => {
    const journal = await readJournal(connection), before = arrays(journal.state), after = arrays(zhihuEditState(data));
    for (const field of fields) if (!zhihuHistoryPrefix(before[field], after[field])) throw new Error('目录中的整理记录比当前阅览更新或存在分叉，未覆盖日志。请重新打开关联目录。');
    const added = Object.fromEntries(fields.map(field => [field, after[field].slice(before[field].length)])) as HistoryArrays;
    if (fields.every(field => !added[field].length) && stableZhihuValue(journal.state.view) === stableZhihuValue(data.view)) return;
    const payload: Omit<JournalRecord, 'digest'> = { format: 'gonglun-zhihu-local-update', version: 1, documentId: connection.documentId,
      previous: journal.digest, base: Object.fromEntries(fields.map(field => [field, before[field].length])) as JournalRecord['base'], added,
      ...(data.view ? { view: data.view } : {}) };
    const record = { ...payload, digest: await digest(payload) };
    const handle = await connection.directory.getFileHandle(ZHIHU_LOCAL_JOURNAL, { create: true });
    const writable = await handle.createWritable({ keepExistingData: true });
    try { await writable.seek(journal.size); await writable.write(`${JSON.stringify(record)}\n`); await writable.close(); }
    catch (error) { await writable.abort().catch(() => undefined); throw error; }
    connection.journalSignature = await getJournalSignature(connection);
  };
  if (!navigator.locks) throw new Error('当前浏览器不支持安全的目录同步，请使用 Chrome 或 Edge。');
  await navigator.locks.request(`gonglun-zhihu:${connection.documentId}`, append);
}

async function getJournalSignature(connection: LinkedDirectory): Promise<string> {
  try { const file = await (await connection.directory.getFileHandle(ZHIHU_LOCAL_JOURNAL)).getFile(); return `${file.lastModified}:${file.size}`; }
  catch (error) { if ((error as DOMException).name === 'NotFoundError') return ''; throw error; }
}

export async function refreshZhihuDirectory(connection: LinkedDirectory, current: ExportData): Promise<{ data: ExportData; signature: string; journalSignature: string }> {
  const file = await (await connection.directory.getFileHandle(connection.sourceName)).getFile();
  const signature = `${file.lastModified}:${file.size}`;
  if (isNativeZhihuView(current)) {
    const journalSignature = await nativeJournalSignature(connection);
    if (signature === connection.signature && journalSignature === connection.journalSignature) return { data: current, signature, journalSignature };
    const incoming = signature === connection.signature ? current : (await prepareExportForViewing(JSON.parse(await file.text()))).data;
    if (!isNativeZhihuView(incoming)) throw new Error('关联目录中的文件格式已改变，已保留当前阅览。');
    const restored = await restoreNativeJournal(connection, incoming);
    const merged = mergeNativeZhihuUpdate(current, restored);
    const unchanged = sameZhihuValue(current.messages, merged.messages) && sameZhihuValue(current.relations, merged.relations)
      && sameZhihuValue(current.scope, merged.scope) && sameZhihuValue(current.users, merged.users);
    return { data: unchanged ? current : merged, signature, journalSignature };
  }
  if (!isZhihuViewingData(current)) throw new Error('当前文件不支持目录更新。');
  const journalSignature = await getJournalSignature(connection);
  if (signature === connection.signature && journalSignature === connection.journalSignature) return { data: current, signature, journalSignature };
  const incoming = signature === connection.signature ? current : prepareZhihuForViewing(JSON.parse(await file.text()));
  const restored = await restoreZhihuJournal(connection, incoming);
  const data = mergeZhihuSourceUpdate(current, restored);
  return { data, signature, journalSignature };
}
