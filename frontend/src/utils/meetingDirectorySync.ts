import type { ExportData } from '../api/client';
import { exportMeetingDelta, importMeetingDelta, MAX_MEETING_BYTES, MeetingEntryConflict } from './meetingExchange';
import { blobBytes } from './streamJsonArchive';

type Delta = Awaited<ReturnType<typeof exportMeetingDelta>>;
type Entry = Delta['entries'][number];
type DirectoryEntries = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
export const meetingDirectoryName = (meetingId: string, baseHash: string) => `gonglun-meeting-${meetingId}-${baseHash}`;
type Snapshot = { data: ExportData; delta: Delta; entries: Map<string, Entry>; signatures: Map<string, string>; matches: Set<string> };
const batchName = /^batch-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-([0-9a-f]{64})\.json$/;
const maxReads = 16;
const encoder = new TextEncoder();

async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function errorName(cause: unknown) { return cause instanceof Error || cause instanceof DOMException ? cause.name : ''; }
function entrySignature(view: Snapshot, id: string): string | undefined {
  const entry = view.entries.get(id);
  if (!entry) return undefined;
  if (!view.signatures.has(id)) view.signatures.set(id, JSON.stringify(entry));
  return view.signatures.get(id);
}

/** One linked meeting. The caller serializes rounds and commits returned data locally. */
export class MeetingDirectorySync {
  private readonly directory: FileSystemDirectoryHandle;
  private snapshot?: Snapshot;
  private idle?: { data: ExportData; names: Set<string> };
  private meetingKey?: string;
  private readonly files = new Map<string, Map<string, string>>();
  private readonly conflicts = new Map<string, string[]>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly unfinishedWrites = new Map<string, FileSystemFileHandle>();
  private attempt = 0;

  constructor(directory: FileSystemDirectoryHandle) { this.directory = directory; }

  private async view(data: ExportData): Promise<Snapshot> {
    if (this.snapshot?.data === data) return this.snapshot;
    const delta = await exportMeetingDelta(data);
    this.snapshot = { data, delta, entries: new Map(delta.entries.map(e => [e.id, e])), signatures: new Map(), matches: new Set() };
    return this.snapshot;
  }

  private remember(name: string, ids: string[], view: Snapshot) {
    // Base entries, if replayed in a packet, are already covered by the verified baseline.
    const entries = new Map<string, string>();
    for (const id of ids) {
      const signature = entrySignature(view, id);
      if (signature !== undefined) entries.set(id, signature);
    }
    this.files.set(name, entries);
    view.matches.add(name);
  }

  private matches(name: string, view: Snapshot) {
    if (view.matches.has(name)) return true;
    const entries = this.files.get(name);
    if (!entries) return false;
    for (const [id, signature] of entries) if (entrySignature(view, id) !== signature) return false;
    view.matches.add(name);
    return true;
  }

  // Closing a native writable stream may fail after its empty directory entry
  // was created. Retry cleanup after reconnection, even if the next packet
  // contains additional speech. Never remove a replacement or a nonempty file.
  private async discardOwnEmptyFile(folder: FileSystemDirectoryHandle, name: string, original: FileSystemFileHandle) {
    try {
      const current = await folder.getFileHandle(name);
      if (await current.isSameEntry(original) && (await current.getFile()).size === 0) await folder.removeEntry(name);
      this.unfinishedWrites.delete(name);
    } catch (cause) {
      if (errorName(cause) === 'NotFoundError') this.unfinishedWrites.delete(name);
    }
  }

  async exchange(data: ExportData, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const local = await this.view(data);
    const key = meetingDirectoryName(local.delta.meetingId, local.delta.baseHash);
    if (this.meetingKey && this.meetingKey !== key) throw new Error('共享目录连接已属于另一场会议。');
    this.meetingKey = key;
    signal?.throwIfAborted();
    const folder = await this.directory.getDirectoryHandle(key, { create: true }) as DirectoryEntries;
    for (const [name, handle] of this.unfinishedWrites) await this.discardOwnEmptyFile(folder, name, handle);
    const listing = new Map<string, FileSystemFileHandle>();
    const idle = this.idle;
    let unchanged = idle?.data === data;
    for await (const item of folder.values()) {
      signal?.throwIfAborted();
      if (item.kind !== 'file' || !batchName.test(item.name)) continue;
      listing.set(item.name, item as FileSystemFileHandle);
      if (unchanged && !idle?.names.has(item.name)) unchanged = false;
    }
    signal?.throwIfAborted();
    if (unchanged && listing.size === idle?.names.size) {
      return { data, added: 0, published: 0, pending: false, warnings: [] as string[] };
    }
    this.idle = undefined;
    const handles: FileSystemFileHandle[] = [];
    const sharedIds = new Set<string>();
    const completeDigests = new Set<string>(), emptyFiles = new Map<string, string>();
    for (const item of listing.values()) {
      const checksum = batchName.exec(item.name)![1];
      const matches = this.matches(item.name, local);
      const known = this.files.get(item.name);
      if (known) for (const [id, signature] of known) {
        if (matches || entrySignature(local, id) === signature) sharedIds.add(id);
      }
      if (matches) completeDigests.add(checksum);
      else handles.push(item);
    }
    // New files go first. Retry incomplete files and out-of-order replies fairly.
    handles.sort((a, b) => (this.lastAttempt.get(a.name) ?? 0) - (this.lastAttempt.get(b.name) ?? 0) || a.name.localeCompare(b.name));
    let merged = data, added = 0, published = 0;
    let pending = handles.length > maxReads;
    const warnings: string[] = [];
    const accepted = new Map<string, string[]>();
    for (const handle of handles.slice(0, maxReads)) {
      signal?.throwIfAborted();
      this.lastAttempt.set(handle.name, ++this.attempt);
      this.conflicts.delete(handle.name);
      try {
        const file = await handle.getFile();
        const checksum = batchName.exec(handle.name)![1];
        if (!file.size) {
          emptyFiles.set(checksum, handle.name); // Visible before the first writable stream closes.
          continue;
        }
        if (file.size > MAX_MEETING_BYTES) throw new Error('文件超过 32 MiB。');
        const bytes = await blobBytes(file);
        if (await digest(bytes) !== checksum) throw new Error('文件尚未写完整或校验不符。');
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const next = await importMeetingDelta(merged, payload);
        merged = next.data;
        added += next.added;
        const ids = (payload as Delta).entries.map(entry => entry.id);
        accepted.set(handle.name, ids);
        completeDigests.add(checksum);
        for (const id of ids) sharedIds.add(id);
      } catch (cause) {
        signal?.throwIfAborted();
        const name = errorName(cause);
        if (name === 'NotAllowedError' || name === 'SecurityError') throw cause;
        this.files.delete(handle.name);
        if (cause instanceof MeetingEntryConflict) this.conflicts.set(handle.name, cause.ids);
        if (name !== 'NotFoundError') {
          pending = true;
          warnings.push(`${handle.name}：${cause instanceof Error ? cause.message : '文件暂不可读。'} 将自动重试。`);
        }
      }
    }
    const current = await this.view(merged);
    for (const [name, ids] of accepted) this.remember(name, ids, current);

    // Finish the first inventory before sending. A fresh tab must not relay
    // every previously downloaded speech while its scan is still catching up.
    if (!handles.slice(maxReads).some(handle => !this.lastAttempt.has(handle.name))) {
      const blocked = new Set(handles.flatMap(handle => this.conflicts.get(handle.name) ?? []));
      const entries: Entry[] = [];
      let bytesUsed = encoder.encode(JSON.stringify({ ...local.delta, entries: [] })).length;
      for (const entry of local.delta.entries) {
        if (sharedIds.has(entry.id) || blocked.has(entry.id)) continue;
        if (entry.type === 'reply' && (blocked.has(entry.source) || entry.targets.some(id => blocked.has(id)))) continue;
        const size = encoder.encode(JSON.stringify(entry)).length + (entries.length ? 1 : 0);
        if (size + bytesUsed > MAX_MEETING_BYTES) {
          pending = true;
          if (entries.length) break;
          warnings.push('一条发言超过单个会议文件的 32 MiB 上限。');
          continue;
        }
        entries.push(entry);
        bytesUsed += size;
      }
      if (entries.length) {
        const bytes = encoder.encode(JSON.stringify({ ...local.delta, entries }));
        const checksum = await digest(bytes), name = `batch-${crypto.randomUUID()}-${checksum}.json`;
        signal?.throwIfAborted();
        // Even an interrupted or foreign file with this exact name stays intact.
        try {
          await folder.getFileHandle(name);
          throw new Error('生成的批次文件名已存在，下次同步时将重试。');
        } catch (cause) { if (errorName(cause) !== 'NotFoundError') throw cause; }
        const handle = await folder.getFileHandle(name, { create: true });
        this.unfinishedWrites.set(name, handle);
        try {
          const stream = await handle.createWritable();
          try {
            signal?.throwIfAborted();
            await stream.write(bytes);
            signal?.throwIfAborted();
            await stream.close();
          } catch (cause) { await stream.abort().catch(() => {}); throw cause; }
        } catch (cause) {
          await this.discardOwnEmptyFile(folder, name, handle);
          throw cause;
        }
        this.unfinishedWrites.delete(name);
        published = entries.length;
        completeDigests.add(checksum);
        this.remember(name, entries.map(entry => entry.id), current);
      }
    }
    for (const [checksum, name] of emptyFiles) if (!completeDigests.has(checksum)) {
      pending = true; warnings.push(`正在等待文件写入完成：${name}`);
    }
    signal?.throwIfAborted();
    // Only a fully matched, read-only scan can certify an idle listing.
    // Failed reads, uncommitted arrivals and files created mid-round need another scan.
    if (!handles.length && !published && !pending && !this.unfinishedWrites.size) {
      this.idle = { data, names: new Set(listing.keys()) };
    }
    return { data: merged, added, published, pending, warnings };
  }
}
