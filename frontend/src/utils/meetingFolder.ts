import type { ExportData } from '../api/client';
import { meetingDirectoryName } from './meetingDirectorySync';
import { createMeetingStart, MAX_MEETING_BYTES, restoreMeetingDocument } from './meetingExchange';
import { createLocalMessageFile } from './localMessageFile';
import { blobBytes } from './streamJsonArchive';

export const MAX_FOLDER_MEETING_TITLE = 80;
export type FolderMeeting = { id: string; title: string; createdAt: string | null; baseHash: string | null };
type DirectoryEntries = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const validId = new RegExp(`^${uuid}$`);
const meetingFolder = new RegExp(`^gonglun-meeting-(${uuid})-([a-f0-9]{64})$`);
const manualFile = new RegExp(`^会议起始-(${uuid})\\.json$`);
const indexName = 'meeting.json', startName = 'start.json';
const indexFormat = 'gonglun-folder-meeting-1';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const isTitle = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_FOLDER_MEETING_TITLE;
const errorName = (error: unknown) => isRecord(error) ? error.name : undefined;
class InvalidMeetingFile extends Error {}

async function readJson(handle: FileSystemFileHandle, limit: number, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const file = await handle.getFile();
  if (!file.size || file.size > limit) throw new InvalidMeetingFile('会议文件为空或超过允许的大小。');
  const bytes = await blobBytes(file);
  signal?.throwIfAborted();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InvalidMeetingFile('会议文件格式无效，请刷新后重试。'); }
}

/** Scan only meeting descriptors. A previously downloaded start file can also be placed in the shared root. */
export async function listFolderMeetings(root: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<FolderMeeting[]> {
  const entries = new Map<string, FolderMeeting>();
  signal?.throwIfAborted();
  for await (const item of (root as DirectoryEntries).values()) {
    signal?.throwIfAborted();
    if (item.kind === 'file') {
      const id = manualFile.exec(item.name)?.[1];
      if (id && !entries.has(id)) entries.set(id, { id, title: `离线会议 · ${id.slice(0, 8)}`, createdAt: null, baseHash: null });
      continue;
    }
    const match = meetingFolder.exec(item.name);
    if (!match) continue;
    const [, id, baseHash] = match;
    const folder = item as FileSystemDirectoryHandle;
    try {
      const index = await readJson(await folder.getFileHandle(indexName), 4096, signal);
      if (!isRecord(index) || index.format !== indexFormat || index.id !== id || index.baseHash !== baseHash
        || !isTitle(index.title) || !isDate(index.createdAt)) continue;
      await folder.getFileHandle(startName);
      entries.set(id, { id, baseHash, title: index.title, createdAt: index.createdAt });
    } catch (error) {
      if (!(error instanceof InvalidMeetingFile) && !['NotFoundError', 'TypeMismatchError'].includes(String(errorName(error)))) throw error;
    }
  }
  signal?.throwIfAborted();
  return [...entries.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id));
}

async function writeNewFile(folder: FileSystemDirectoryHandle, name: string, value: Blob, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    await folder.getFileHandle(name);
    throw new Error('会议文件已存在，请刷新会议列表。');
  } catch (error) { if (errorName(error) !== 'NotFoundError') throw error; }
  const handle = await folder.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try {
    signal?.throwIfAborted();
    await stream.write(value);
    signal?.throwIfAborted();
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}

export async function createFolderMeeting(root: FileSystemDirectoryHandle, name: string, source = createLocalMessageFile(), signal?: AbortSignal): Promise<ExportData> {
  const title = name.trim();
  if (!isTitle(title)) throw new Error(`会议名称须为 1 到 ${MAX_FOLDER_MEETING_TITLE} 个字符。`);
  signal?.throwIfAborted();
  const start = await createMeetingStart(source);
  start.scope = { ...start.scope, title };
  const file = new Blob([JSON.stringify(start)], { type: 'application/json' });
  if (file.size > MAX_MEETING_BYTES) throw new Error('会议起始文件超过 32 MiB。');
  const { id, baseHash } = start.meeting!;
  const key = meetingDirectoryName(id, baseHash);
  signal?.throwIfAborted();
  try {
    await root.getDirectoryHandle(key);
    throw new Error('会议编号已存在，请重试创建。');
  } catch (error) { if (errorName(error) !== 'NotFoundError') throw error; }
  const folder = await root.getDirectoryHandle(key, { create: true });
  await writeNewFile(folder, startName, file, signal);
  // Publish the descriptor last. Incomplete creations are invisible to other participants.
  const index = { format: indexFormat, id, baseHash, title, createdAt: start.exportedAt };
  await writeNewFile(folder, indexName, new Blob([JSON.stringify(index)], { type: 'application/json' }), signal);
  return start;
}

export async function openFolderMeeting(root: FileSystemDirectoryHandle, selection: FolderMeeting, signal?: AbortSignal): Promise<ExportData> {
  signal?.throwIfAborted();
  const { id, baseHash } = selection;
  if (!validId.test(id) || (baseHash !== null && !/^[0-9a-f]{64}$/.test(baseHash))) throw new Error('所选会议编号无效。');
  let handle: FileSystemFileHandle;
  try {
    handle = baseHash
      ? await (await root.getDirectoryHandle(meetingDirectoryName(id, baseHash))).getFileHandle(startName)
      : await root.getFileHandle(`会议起始-${id}.json`);
  } catch (error) {
    if (errorName(error) === 'NotFoundError') throw new Error('会议起始文件已移走，请刷新会议列表。');
    throw error;
  }
  const input = await readJson(handle, MAX_MEETING_BYTES, signal);
  if (!isRecord(input) || input.format !== 'gonglun-view-3' || input.formatVersion !== 5 || !isRecord(input.meeting)
    || !isRecord(input.scope) || !isTitle(input.scope.title) || !isDate(input.exportedAt) || !Array.isArray(input.messages)
    || !Array.isArray(input.relations) || !Array.isArray(input.meeting.baseIds)) throw new Error('会议起始文件格式无效。');
  if (input.meeting.id !== id || (baseHash !== null && (input.meeting.baseHash !== baseHash || input.scope.title !== selection.title
    || input.exportedAt !== selection.createdAt))) throw new Error('起始文件与所选会议不匹配。');
  const data = await restoreMeetingDocument(input as unknown as ExportData, { startOnly: true });
  signal?.throwIfAborted();
  return data;
}
