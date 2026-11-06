import { textOf, type Message, type Part } from '@gonglun/core';
import type { ExportData } from '../api/client';
import { isNativeLocalMessage, isNativeZhihuView, type NativeZhihuView } from './nativeZhihuView';
import { blobBytes, scanJsonArchive, type JsonRange } from './streamJsonArchive';

type Row = ExportData['messages'][number];
type RelationRow = ExportData['relations'][number];
type Offset = [id: string, start: number, end: number];
export interface PagedArchiveDescriptor {
  version: 1;
  blobKey: string;
  messages: Offset[];
  relations: Offset[];
}
export interface PagedArchiveSource {
  descriptor: PagedArchiveDescriptor;
  blob(): Promise<Blob>;
  messageRanges: Map<string, JsonRange>;
  relationRanges: Map<string, JsonRange>;
}
// Spreads preserve this private binding; JSON and IndexedDB do not persist it.
// Stored entries carry an explicit descriptor and reattach it on restoration.
const sourceKey = Symbol('paged-zhihu-archive');
export const pagedArchiveSource = (data: unknown): PagedArchiveSource | undefined =>
  data && typeof data === 'object' ? (data as { [sourceKey]?: PagedArchiveSource })[sourceKey] : undefined;
export function attachPagedArchive<T extends ExportData>(data: T, descriptor: PagedArchiveDescriptor, blob: () => Promise<Blob>): T {
  const source: PagedArchiveSource = { descriptor, blob,
    messageRanges: new Map(descriptor.messages.map(([id, start, end]) => [id, [start, end]])),
    relationRanges: new Map(descriptor.relations.map(([id, start, end]) => [id, [start, end]])) };
  Object.defineProperty(data, sourceKey, { value: source, enumerable: true, configurable: true });
  return data;
}
export function inheritPagedArchive<T extends object>(data: T, source: unknown): T {
  const binding = pagedArchiveSource(source);
  if (binding) Object.defineProperty(data, sourceKey, { value: binding, enumerable: true, configurable: true });
  return data;
}
export const PAGED_ARCHIVE_MIN_BYTES = 8 * 1024 * 1024;
const skeletonPart = (part: Part, keepAddresses: boolean): Part => {
  switch (part.type) {
    case 'text': return { id: part.id, type: part.type, text: part.text.trim() ? 'x' : '' };
    case 'data': return { id: part.id, type: part.type, value: null };
    case 'code': return { ...part, source: part.source.trim() ? 'x' : '' };
    case 'web': return { ...part, excerpt: part.excerpt.trim() ? 'x' : '' };
    case 'relation': return keepAddresses ? part : { ...part, roles: {} };
    default: return part;
  }
};
/** Local additions stay complete. Imported originals retain only topology and
 * the presence of body parts, never their text or source-fields evidence. */
export function pagedRowSkeleton<T extends object>(row: T): T {
  if (isNativeLocalMessage(row)) return row;
  const value = row as Row;
  const keepAddresses = ['AGREE', 'DISAGREE', 'JOIN'].includes(value.relationType ?? '');
  return { ...row, ...('content' in row ? { content: value.content?.trim() ? 'x' : value.content } : {}),
    ...(value.parts ? { parts: value.parts.map(part => skeletonPart(part, keepAddresses)) } : {}),
    ...(Array.isArray(value.targetRefs) && !keepAddresses ? { targetRefs: value.targetRefs.map(ref => ref.kind === 'relation'
      ? { kind: 'relation', relationId: ref.relationId } : { kind: 'message', messageId: ref.messageId }) } : {}),
    ...('quotedText' in row ? { quotedText: value.quotedText ? 'x' : value.quotedText } : {}),
    ...('quoteContextBefore' in row ? { quoteContextBefore: '' } : {}), ...('quoteContextAfter' in row ? { quoteContextAfter: '' } : {}) };
}
const restoredRow = <T extends object>(row: T): T => 'parts' in row && Array.isArray(row.parts) && !('content' in row)
  ? { ...row, content: textOf(row as unknown as Message) } : row;

/** IDs, addresses and relation metadata occur in both native arrays. Share
 * their compact representation rather than retaining every parsed duplicate. */
function compactIndex(messages: Row[], relations: RelationRow[]): void {
  const strings = new Map<string, string>();
  const intern = (text: string) => {
    const previous = strings.get(text);
    if (previous !== undefined) return previous;
    strings.set(text, text); return text;
  };
  const canonical = <T extends object>(row: T): T => {
    if (isNativeLocalMessage(row)) return row;
    const value = row as Row;
    for (const field of ['id', 'sourceMessageId', 'createdAt', 'authorId', 'author', 'relationType'] as const) {
      const text = value[field]; if (typeof text === 'string') (value as Record<string, unknown>)[field] = intern(text);
    }
    if (!['AGREE', 'DISAGREE', 'JOIN'].includes(value.relationType ?? '') && Array.isArray(value.targetRefs)) for (const ref of value.targetRefs) {
      if (typeof ref.messageId === 'string') ref.messageId = intern(ref.messageId);
      if (typeof ref.relationId === 'string') ref.relationId = intern(ref.relationId);
    }
    return row;
  };
  const byId = new Map(messages.map(row => [row.id, canonical(row)]));
  for (let i = 0; i < relations.length; i++) {
    const row = canonical(relations[i]), message = byId.get(row.id);
    if (message && !isNativeLocalMessage(row)) relations[i] = { ...row,
      ...(JSON.stringify(row.targetRefs) === JSON.stringify(message.targetRefs) ? { targetRefs: message.targetRefs } : {}),
      ...('parts' in row && JSON.stringify(row.parts) === JSON.stringify(message.parts) ? { parts: message.parts } : {}) };
  }
}

/** Initial import scans bounded chunks. No full-file text or parsed source copy. */
export async function indexNativeZhihuBlob(blob: Blob, options: Parameters<typeof scanJsonArchive>[2] = {}): Promise<{
  data: NativeZhihuView; descriptor: PagedArchiveDescriptor;
} | null> {
  const messages: Row[] = [], relations: RelationRow[] = [];
  const descriptor: PagedArchiveDescriptor = { version: 1, blobKey: `__native_blob__:${crypto.randomUUID()}`, messages: [], relations: [] };
  const messageIds = new Set<string>(), relationIds = new Set<string>();
  let invalidMessage = false;
  const metadata = await scanJsonArchive(blob, (field, value, [start, end]) => {
    if (!value || typeof value !== 'object' || typeof (value as Row).id !== 'string') throw new Error('消息编号格式无效');
    const row = value as Row, ids = field === 'messages' ? messageIds : relationIds;
    if (ids.has(row.id)) throw new Error('阅览文件含重复消息编号');
    ids.add(row.id);
    if (field === 'messages' && (!Array.isArray(row.parts) || !Number.isSafeInteger(row.revision))) invalidMessage = true;
    descriptor[field].push([row.id, start, end]);
    if (field === 'messages') messages.push(restoredRow(pagedRowSkeleton(row)));
    else relations.push(pagedRowSkeleton(value as RelationRow));
  }, options);
  const data = { ...metadata, messages, relations } as NativeZhihuView;
  if (!isNativeZhihuView(data) || invalidMessage) return null;
  if (!Array.isArray(metadata.messages) || !Array.isArray(metadata.relations)) throw new Error('缺少消息或关系列表');
  compactIndex(messages, relations);
  return { data: attachPagedArchive(data, descriptor, async () => blob), descriptor };
}

/** Upgrade old object caches in bounded serialization batches, then release
 * the old object. This one-time migration cannot avoid reading the old record. */
export async function pageNativeZhihuData(data: NativeZhihuView): Promise<NativeZhihuView> {
  if (pagedArchiveSource(data)) return data;
  const descriptor: PagedArchiveDescriptor = { version: 1, blobKey: `__native_blob__:${crypto.randomUUID()}`, messages: [], relations: [] };
  const chunks: Blob[] = [], encoder = new TextEncoder();
  let fragments: Uint8Array<ArrayBuffer>[] = [], size = 0, batch = 0;
  const messages: Row[] = [], relations: RelationRow[] = [];
  for (const field of ['messages', 'relations'] as const) {
    for (const row of data[field]) {
      const bytes = encoder.encode(JSON.stringify(row));
      descriptor[field].push([row.id, size, size + bytes.length]); size += bytes.length;
      fragments.push(bytes); batch += bytes.length;
      if (field === 'messages') messages.push(pagedRowSkeleton(row as Row));
      else relations.push(pagedRowSkeleton(row as RelationRow));
      if (batch >= 1024 * 1024) {
        chunks.push(new Blob(fragments)); fragments = []; batch = 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
  if (fragments.length) chunks.push(new Blob(fragments));
  compactIndex(messages, relations);
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  return attachPagedArchive({ ...data, messages, relations }, descriptor, async () => blob);
}

/** Hydrate one requested window only; callers replace the previous window.
 * Adjacent ranges share a bounded read, with no accumulating body cache. */
export async function hydratePagedArchive<T extends ExportData>(source: ExportData, window: T, signal?: AbortSignal): Promise<T> {
  const paging = pagedArchiveSource(source);
  if (!paging) return window;
  signal?.throwIfAborted();
  const blob = await paging.blob();
  const read = async <R extends object & { id: string }>(rows: R[], ranges: Map<string, JsonRange>, restoreContent = false): Promise<R[]> => {
    const result = [...rows];
    const requests = rows.flatMap((row, index) => {
      const range = ranges.get(row.id);
      return range && !isNativeLocalMessage(row) ? [{ index, range, id: row.id }] : [];
    }).sort((a, b) => a.range[0] - b.range[0]);
    for (let i = 0; i < requests.length;) {
      signal?.throwIfAborted();
      const first = i, start = requests[i].range[0];
      let end = requests[i++].range[1];
      while (i < requests.length && requests[i].range[0] - end < 4096 && requests[i].range[1] - start <= 1024 * 1024)
        end = requests[i++].range[1];
      const bytes = await blobBytes(blob.slice(start, end));
      signal?.throwIfAborted();
      for (let j = first; j < i; j++) {
        const { index, range, id } = requests[j];
        const row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(range[0] - start, range[1] - start))) as R;
        if (row.id !== id) throw new Error('阅览索引与原文件不一致，请重新打开原文件');
        result[index] = restoreContent ? restoredRow(row) : row;
      }
    }
    return result;
  };
  const messages = await read(window.messages, paging.messageRanges, true);
  const relations = await read(window.relations, paging.relationRanges);
  return { ...window, messages, relations };
}

/** A download is assembled from Blob slices and complete local additions.
 * Neither JSON.stringify nor the export worker ever receives placeholder rows. */
export async function exportPagedArchive(data: NativeZhihuView, signal?: AbortSignal): Promise<Blob> {
  const paging = pagedArchiveSource(data);
  if (!paging) throw new Error('阅览文件没有分段索引');
  const blob = await paging.blob();
  const { messages, relations, ...header } = data;
  const parts: BlobPart[] = [JSON.stringify({ ...header, exportedAt: new Date().toISOString() }).slice(0, -1)];
  for (const field of ['messages', 'relations'] as const) {
    parts.push(`,"${field}":[`);
    const ranges = field === 'messages' ? paging.messageRanges : paging.relationRanges;
    const rows = field === 'messages' ? messages : relations;
    for (let index = 0; index < rows.length; index++) {
      if (index) parts.push(',');
      const row = rows[index], range = ranges.get(row.id);
      parts.push(range && !isNativeLocalMessage(row) ? blob.slice(...range) : JSON.stringify(row));
      if (index % 1000 === 0) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    parts.push(']');
  }
  parts.push('}\n');
  return new Blob(parts, { type: 'application/json' });
}
