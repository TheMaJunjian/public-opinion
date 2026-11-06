import type { ExportData } from '../api/client';
import { createEmptyZhihuLocalOperations, getZhihuArchiveIdentity, isZhihuViewingData, prepareZhihuForViewing } from './zhihuArchive';
import { assertZhihuSourceUpdate, sameZhihuValue, stableZhihuValue, zhihuEditState, type ZhihuEditState } from './zhihuIncremental';
import { materializeRelations } from './zhihuRelations.mjs';
import { copyDiscussionView, isDiscussionView, type DiscussionView } from './discussionView';
import { isNativeLocalMessage, isNativeZhihuView, nativeZhihuIdentity, type NativeZhihuView } from './nativeZhihuView';
import { attachPagedArchive, hydratePagedArchive, inheritPagedArchive, pageNativeZhihuData, pagedArchiveSource, type PagedArchiveDescriptor } from './pagedZhihuArchive';

const LAST_EXPORT_KEY = 'lastExportData';
const DATABASE_NAME = 'gonglun-export-viewer';
// Older builds cannot safely write a base snapshot after edits move to a
// separate record. Their version-1 opens must fail instead of discarding edits.
const DATABASE_VERSION = 4;
const STORE_NAME = 'archives';
const LAST_ARCHIVE_POINTER = '__last_viewed_archive__';
type ArchiveReference = { archiveId: string };
export type ExportCacheReference = ArchiveReference & { viewCacheId: string };
export type ExportPreview = { title: string; reference: ExportCacheReference };
export type ExportNavigation = { classificationId: string | null; classificationPath?: string[] };
type CachedArchive = ArchiveReference & { data: ExportData; viewCacheId?: string; revision?: string; pages?: PagedArchiveDescriptor };
const previewKey = (archiveId: string) => `__archive_preview__:${archiveId}`;
const archivePreview = (entry: CachedArchive): ExportPreview => ({ title: entry.data.scope.title,
  reference: { archiveId: entry.archiveId, viewCacheId: entry.viewCacheId ?? entry.archiveId } });
type NativeRevision = { revision: string; viewCacheId: string; localMessages?: ExportData['messages']; localRelations?: ExportData['relations']; localUsers?: ExportData['users']; view?: ExportData['view']; viewerUsername?: string | null };
const nativeRevisions = new WeakMap<object, NativeRevision>();
const nativeVersionKey = (id: string) => `__native_revision__:${id}`;
const nativeSourceKey = (data: NativeZhihuView) => `__native_source__:${nativeZhihuIdentity(data)}`;
function nativeRevision(data: ExportData, revision: string, viewCacheId: string): NativeRevision {
  if (!isNativeZhihuView(data)) return { revision, viewCacheId };
  const localMessages = data.messages.filter(isNativeLocalMessage), ids = new Set(localMessages.map(message => message.id));
  const authors = new Set(localMessages.map(message => message.authorId));
  return { revision, viewCacheId, localMessages, localRelations: data.relations.filter(relation => ids.has(relation.id)), localUsers: data.users?.filter(user => authors.has(user.id)), view: data.view, viewerUsername: data.viewerUsername };
}
type EditRecord = { revision: string; viewCacheId: string; state: ZhihuEditState };
const editKey = (archiveId: string) => `__zhihu_edits__:${archiveId}`;
const sourceRevisions = new WeakMap<object, EditRecord>();
const pendingZhihuProjections = new WeakSet<object>();
type RestoreOptions = { sourceOnly?: boolean; fresh?: boolean; paged?: boolean };
let currentArchive: CachedArchive | null = null;
let currentArchivePersistent = false;
const viewCacheIds = new Map<string, string>();
const sourceViewCacheIds = new WeakMap<object, ExportCacheReference>();
const durableViewCacheIds = new Set<string>();

/** The old Zhihu editing data was explicitly abandoned, not migrated. */
function discardLegacyZhihuCache(store: IDBObjectStore): void {
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      const pointer = store.get(LAST_ARCHIVE_POINTER);
      pointer.onsuccess = () => { if (pointer.result?.archiveId?.startsWith('zhihu:')) store.delete(LAST_ARCHIVE_POINTER); };
      return;
    }
    const key = String(cursor.key);
    if (key.startsWith('zhihu:')) {
      const viewId = cursor.value?.viewCacheId ?? key;
      store.delete(`__discussion_view__:${viewId}`);
      cursor.delete();
    } else if (key.startsWith('__zhihu_')) cursor.delete();
    cursor.continue();
  };
}

/** Titles, timestamps and scopes are not document identities (legacy files may share all three). */
function bindDiscussionSource<T>(source: T, entry: CachedArchive): T {
  if (source && typeof source === 'object') sourceViewCacheIds.set(source, { archiveId: entry.archiveId, viewCacheId: entry.viewCacheId ?? entry.archiveId });
  if (source && typeof source === 'object' && entry.revision) nativeRevisions.set(source, { revision: entry.revision, viewCacheId: entry.viewCacheId ?? entry.archiveId });
  return source;
}

/** Carry cache identity through local conversion without inferring it from file metadata. */
export function inheritExportCacheReference<T extends ExportData>(data: T, source: unknown): T {
  inheritPagedArchive(data, source);
  const reference = source && typeof source === 'object' ? sourceViewCacheIds.get(source) : undefined;
  if (reference) sourceViewCacheIds.set(data, reference);
  const revision = source && typeof source === 'object' ? sourceRevisions.get(source) : undefined;
  if (revision) sourceRevisions.set(data, revision);
  const nativeRevision = source && typeof source === 'object' ? nativeRevisions.get(source) : undefined;
  if (nativeRevision) nativeRevisions.set(data, nativeRevision);
  return data;
}

/** The router clones state; this small reference reconnects only a durable source. */
export function getExportCacheReference(data: ExportData): ExportCacheReference | null {
  const reference = sourceViewCacheIds.get(data);
  return reference && durableViewCacheIds.has(reference.viewCacheId) ? { ...reference } : null;
}

class ArchiveConflictError extends Error {}

/** Zhihu projections are rebuilt on opening; cloning them again only increases memory and load time. */
function readingSource(data: ExportData, sourceOnly = false): unknown {
  if (!sourceOnly && pendingZhihuProjections.has(data)) return prepareZhihuForViewing(data);
  return sourceOnly && isZhihuViewingData(data) ? {
    format: 'gonglun-zhihu-reviewed', version: 5, archive: data.zhihu.archive,
    overrides: data.zhihu.overrides, localOperations: data.zhihu.localOperations,
    ...(data.view ? { view: data.view } : {}),
  } : data;
}

function relationshipVersion(data: ExportData): string {
  const emptyLocal = createEmptyZhihuLocalOperations();
  const value = isZhihuViewingData(data) ? { archive: data.zhihu.archive,
    // Opening an older cache upgrades scalar parents and default provenance.
    // Compare that same representation without rebuilding/cloning source bodies.
    // The empty archive is used only for history normalization, never persisted.
    overrides: materializeRelations({ comments: [] }, data.zhihu.overrides).overrides,
    localOperations: data.zhihu.localOperations
      ? { ...emptyLocal, ...data.zhihu.localOperations,
        version: [1, 2].includes(Number(data.zhihu.localOperations.version)) ? emptyLocal.version : data.zhihu.localOperations.version,
        replyDefinitions: data.zhihu.localOperations.replyDefinitions ?? [] }
      : emptyLocal, view: data.view ?? null } : data;
  return JSON.stringify(value, (_name, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry);
}

/** Keep the archive and cross-session pointer in one committed transaction. */
export function withArchiveStore<T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const opening = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    opening.onupgradeneeded = event => {
      if (!opening.result.objectStoreNames.contains(STORE_NAME)) opening.result.createObjectStore(STORE_NAME);
      if (event.oldVersion > 0 && event.oldVersion < 3) discardLegacyZhihuCache(opening.transaction!.objectStore(STORE_NAME));
    };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { blocked = true; reject(new Error('阅览缓存暂时不可用')); };
    opening.onsuccess = () => {
      const database = opening.result;
      database.onversionchange = () => database.close();
      if (blocked) { database.close(); return; }
      let transaction: IDBTransaction | undefined;
      try {
        transaction = database.transaction(STORE_NAME, mode);
        const result = request(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => { database.close(); resolve(result.result); };
        transaction.onabort = () => { database.close(); reject(transaction?.error); };
        transaction.onerror = () => { database.close(); reject(transaction?.error); };
      } catch (error) {
        try { transaction?.abort(); } catch { /* Already complete or aborted. */ }
        database.close(); reject(error);
      }
    };
  });
}

function createEntry(data: ExportData, preserveView = false, copyData = true): CachedArchive {
  // A selected download replaces its cached contents; never merge older edits.
  const archiveId = isZhihuViewingData(data) ? `zhihu:${getZhihuArchiveIdentity(data)}` : crypto.randomUUID();
  return { archiveId, data: copyData ? inheritPagedArchive(structuredClone(data), data) : data,
    ...(pagedArchiveSource(data) ? { pages: pagedArchiveSource(data)!.descriptor } : {}), viewCacheId: preserveView
    ? viewCacheIds.get(archiveId) ?? crypto.randomUUID() : crypto.randomUUID() };
}

function rememberInTab(entry: CachedArchive, persistent = false): void {
  currentArchive = entry;
  currentArchivePersistent = persistent;
  viewCacheIds.set(entry.archiveId, entry.viewCacheId ?? entry.archiveId);
  if (persistent) durableViewCacheIds.add(entry.viewCacheId ?? entry.archiveId);
  bindDiscussionSource(entry.data, entry);
  try { sessionStorage.setItem(LAST_EXPORT_KEY, JSON.stringify({ archiveId: entry.archiveId })); }
  catch {
    // Do not retain an earlier file as the current tab's latest selection.
    try { sessionStorage.removeItem(LAST_EXPORT_KEY); } catch { /* Storage may be disabled entirely. */ }
  }
}

/** The mounted viewer owns its data; durable recovery needs only the IDB pointer. */
export function releaseDurableExportMemory(): void {
  if (!currentArchivePersistent) return;
  // If session storage is unavailable, retain the tab's own selection rather
  // than later falling back to another tab's last-document pointer.
  try {
    if (JSON.parse(sessionStorage.getItem(LAST_EXPORT_KEY) ?? 'null')?.archiveId !== currentArchive?.archiveId) return;
  } catch { return; }
  currentArchive = null;
  currentArchivePersistent = false;
}

async function persistEntry(entry: CachedArchive, expected?: ExportData): Promise<void> {
  const pageSource = pagedArchiveSource(entry.data), blob = await pageSource?.blob();
  let ownedBlob: Blob | undefined;
  const guarded = expected !== undefined && isZhihuViewingData(expected);
  if (guarded && entry.archiveId !== `zhihu:${getZhihuArchiveIdentity(expected)}`) throw new ArchiveConflictError('正在保存的档案与当前阅览不同，请重新打开后再调整。');
  const baseline = guarded ? relationshipVersion(expected) : null;
  let failure: unknown;
  try {
    await withArchiveStore('readwrite', store => {
      const write = () => {
        if (pageSource && blob) {
          store.put(blob, pageSource.descriptor.blobKey); entry.pages = pageSource.descriptor;
          const owned = store.get(pageSource.descriptor.blobKey); owned.onsuccess = () => { ownedBlob = owned.result; };
        }
        store.put({ archiveId: entry.archiveId }, LAST_ARCHIVE_POINTER);
        store.put(archivePreview(entry), previewKey(entry.archiveId));
        if (isZhihuViewingData(entry.data)) {
          const edits: EditRecord = { revision: crypto.randomUUID(), viewCacheId: entry.viewCacheId!, state: zhihuEditState(entry.data) };
          store.put(edits, editKey(entry.archiveId)); sourceRevisions.set(entry.data, edits);
        } else {
          entry.revision = crypto.randomUUID();
          const revision = nativeRevision(entry.data, entry.revision, entry.viewCacheId!);
          store.put(revision, nativeVersionKey(entry.archiveId)); nativeRevisions.set(entry.data, revision);
          if (isNativeZhihuView(entry.data)) store.put({ archiveId: entry.archiveId }, nativeSourceKey(entry.data));
        }
        return store.put(entry, entry.archiveId);
      };
      if (baseline === null) return write();
      const read = store.get(entry.archiveId);
      read.onsuccess = () => {
        try {
          const existing = read.result as CachedArchive | undefined;
          const edits = store.get(editKey(entry.archiveId));
          edits.onsuccess = () => {
            try {
              const stored = edits.result as EditRecord | undefined;
              const actual = existing?.data && stored && isZhihuViewingData(existing.data) ? applyEditRecord(existing.data, stored) : existing?.data;
              if (existing && (!actual || relationshipVersion(actual) !== baseline)) throw new ArchiveConflictError('这份档案已在其他标签页更新，本次调整尚未保存。请重新打开上次阅览后再调整。');
              write();
            } catch (error) { failure = error; store.transaction.abort(); }
          };
        } catch (error) { failure = error; store.transaction.abort(); }
      };
      return read;
    });
  } catch (error) { throw failure ?? error; }
  // A directory exporter may replace its File immediately after this commit.
  // Keep the durable Blob handle, not the external File's invalidatable snapshot.
  if (pageSource && ownedBlob) { const stored = ownedBlob; pageSource.blob = async () => stored; }
}

/** Bound the optional Web Storage fallback before allocating a giant JSON string. */
function memoryFallback(data: ExportData): string {
  let budget = 2_000_000;
  return JSON.stringify(data, (key, value: unknown) => {
    budget -= key.length + (typeof value === 'string' ? value.length : 8);
    if (budget < 0) throw new Error('阅览文件超过 Web Storage 回退容量');
    return value;
  });
}

/** The chooser owns immutable prepared data; IDB already snapshots it on put. */
export async function saveLastExport(data: ExportData, options: { immutable?: boolean } = {}): Promise<void> {
  const entry = createEntry(data, false, !options.immutable);
  bindDiscussionSource(data, entry);
  rememberInTab(entry);
  try {
    await persistEntry(entry);
    inheritExportCacheReference(data, entry.data);
    durableViewCacheIds.add(entry.viewCacheId ?? entry.archiveId);
    if (currentArchive === entry) {
      currentArchivePersistent = true;
      if (options.immutable) releaseDurableExportMemory();
    }
  }
  catch {
    // Never serialize index placeholders as a recoverable source document.
    if (pagedArchiveSource(data)) return;
    try { sessionStorage.setItem(LAST_EXPORT_KEY, memoryFallback(entry.data)); }
    catch { /* Keep the latest archive in memory instead of reopening stale data. */ }
  }
}

/** Resolve only after durable storage succeeds; failures do not replace active data. */
export async function saveLastExportPersistent(data: ExportData, expected?: ExportData, options: { sourceUpdate?: boolean } = {}): Promise<void> {
  if (options.sourceUpdate && expected && isZhihuViewingData(expected) && isZhihuViewingData(data)) assertZhihuSourceUpdate(expected, data);
  // A linked source update may grow the set of works, changing legacy archive IDs.
  // Preserve the opened document's cache identity while that directory remains linked.
  const expectedReference = expected && sourceViewCacheIds.get(expected);
  const nativeBaseline = expected && nativeRevisions.get(expected);
  if (expectedReference && nativeBaseline && !isZhihuViewingData(data) && (options.sourceUpdate || isNativeZhihuView(data) && isNativeZhihuView(expected))) {
    if (!options.sourceUpdate && expected && isNativeZhihuView(data)) {
      const before = expected.messages.filter(message => !isNativeLocalMessage(message)), after = data.messages.filter(message => !isNativeLocalMessage(message));
      if (!(before.length === after.length && before.every((row, index) => row === after[index])) && !sameZhihuValue(before, after)) throw new Error('本地整理不能替换导入的原文。');
    }
    const revision = nativeRevision(data, crypto.randomUUID(), nativeBaseline.viewCacheId);
    const paging = pagedArchiveSource(data), blob = options.sourceUpdate ? await paging?.blob() : undefined;
    let ownedBlob: Blob | undefined;
    const entry: CachedArchive = { ...expectedReference, revision: revision.revision, data, ...(paging ? { pages: paging.descriptor } : {}) };
    let failure: unknown;
    try {
      await withArchiveStore('readwrite', store => {
        const read = store.get(nativeVersionKey(entry.archiveId));
        read.onsuccess = () => {
          if (read.result?.revision !== nativeBaseline.revision || read.result?.viewCacheId !== entry.viewCacheId) {
            failure = new ArchiveConflictError('这份档案已在其他标签页更新，请重新打开上次阅览。'); store.transaction.abort(); return;
          }
          if (options.sourceUpdate) {
            if (paging && blob) {
              store.put(blob, paging.descriptor.blobKey);
              const owned = store.get(paging.descriptor.blobKey); owned.onsuccess = () => { ownedBlob = owned.result; };
            }
            store.put(entry, entry.archiveId);
            const previousPages = pagedArchiveSource(expected)?.descriptor;
            if (previousPages && previousPages.blobKey !== paging?.descriptor.blobKey) store.delete(previousPages.blobKey);
          }
          store.put(revision, nativeVersionKey(entry.archiveId));
          if (isNativeZhihuView(data)) store.put({ archiveId: entry.archiveId }, nativeSourceKey(data));
          store.put({ archiveId: entry.archiveId }, LAST_ARCHIVE_POINTER);
          store.put(archivePreview(entry), previewKey(entry.archiveId));
        };
        return read;
      });
    } catch (error) { throw failure ?? new Error('本机保存失败，当前阅览未替换。', { cause: error }); }
    if (paging && ownedBlob) { const stored = ownedBlob; paging.blob = async () => stored; }
    bindDiscussionSource(data, entry); rememberInTab(entry, true); return;
  }
  const baseline = expected && sourceRevisions.get(expected);
  if (expected && isZhihuViewingData(data) && isZhihuViewingData(expected) && baseline && expectedReference
    && (options.sourceUpdate || sameZhihuValue(data.zhihu.archive, expected.zhihu.archive))) {
    const entry = { archiveId: expectedReference.archiveId, data, viewCacheId: expectedReference.viewCacheId };
    const state = zhihuEditState(data);
    const next: EditRecord = { ...baseline, revision: crypto.randomUUID(), state };
    // Local sends only change the small edit record. The full source is written
    // when the exporter updates, never for a reply, stance, correction or move.
    let failure: unknown;
    try {
      await withArchiveStore('readwrite', store => {
        const read = store.get(editKey(entry.archiveId));
        read.onsuccess = () => {
          const actual = read.result as EditRecord | undefined;
          if (!actual || actual.revision !== baseline.revision || actual.viewCacheId !== entry.viewCacheId) {
            failure = new ArchiveConflictError('这份档案已在其他标签页更新，本次调整尚未保存。请重新打开上次阅览后再调整。'); store.transaction.abort(); return;
          }
          if (options.sourceUpdate) {
            store.put(entry, entry.archiveId);
            store.put(entry.archiveId, `__zhihu_alias__:${data.zhihu.archiveId}`);
          }
          store.put(next, editKey(entry.archiveId)); store.put({ archiveId: entry.archiveId }, LAST_ARCHIVE_POINTER);
          store.put(archivePreview(entry), previewKey(entry.archiveId));
        };
        return read;
      });
    } catch (error) {
      if (failure) throw failure;
      throw new Error('本机持久保存失败，调整尚未保存。请检查浏览器存储空间或权限后重试。', { cause: error });
    }
    sourceRevisions.set(data, next); bindDiscussionSource(data, entry); rememberInTab(entry, true); return;
  }
  const entry = createEntry(data, true);
  try { await persistEntry(entry, expected); }
  catch (error) {
    if (error instanceof ArchiveConflictError) throw error;
    throw new Error('本机持久保存失败，调整尚未保存。请检查浏览器存储空间或权限后重试。');
  }
  bindDiscussionSource(data, entry);
  inheritExportCacheReference(data, entry.data);
  rememberInTab(entry, true);
}

function applyEditRecord(data: ExportData, edits: EditRecord): ExportData {
  if (!isZhihuViewingData(data) || stableZhihuValue(zhihuEditState(data)) === stableZhihuValue(edits.state)) return data;
  // Most callers request the compact source and will project it once themselves.
  // Keep cached graph rows private until a caller actually requests a full view.
  const { view: _oldView, ...rest } = data;
  const updated = { ...rest, ...(edits.state.view ? { view: edits.state.view } : {}),
    zhihu: { ...data.zhihu, overrides: edits.state.overrides, localOperations: edits.state.localOperations } };
  pendingZhihuProjections.add(updated);
  return updated;
}

async function readStoredEntry(archiveId: string, cachePreview = false, paged = false): Promise<CachedArchive | undefined> {
  let edits: EditRecord | undefined;
  let native: NativeRevision | undefined;
  let sourceBlob: Blob | undefined;
  // Read the base and its edit head from the same transaction, so a source
  // replacement in another tab cannot attach a new log to an old source.
  const entry = await withArchiveStore<CachedArchive | undefined>(cachePreview ? 'readwrite' : 'readonly', store => {
    const head = store.get(editKey(archiveId)); head.onsuccess = () => { edits = head.result; };
    const nativeHead = store.get(nativeVersionKey(archiveId)); nativeHead.onsuccess = () => { native = nativeHead.result; };
    const read = store.get(archiveId);
    read.onsuccess = () => {
      const stored = read.result as CachedArchive | undefined;
      if (stored?.pages) {
        const file = store.get(stored.pages.blobKey); file.onsuccess = () => { sourceBlob = file.result; };
      }
      if (cachePreview && stored?.archiveId === archiveId && typeof stored.data?.scope?.title === 'string')
        store.put(archivePreview(stored), previewKey(archiveId));
    };
    return read;
  });
  if (entry?.pages) attachPagedArchive(entry.data, entry.pages, async () => {
    if (!sourceBlob || typeof sourceBlob.slice !== 'function') throw new Error('阅览原文缓存缺失，请重新选择原 JSON 文件');
    return sourceBlob;
  });
  const finish = async (value: CachedArchive | undefined): Promise<CachedArchive | undefined> => {
    if (!value) return value;
    if (paged && !value.pages && isNativeZhihuView(value.data) && value.data.messages.length > 10_000) {
      const data = await pageNativeZhihuData(value.data), source = pagedArchiveSource(data)!;
      const migrated = { ...value, data, pages: source.descriptor };
      const blob = await source.blob();
      let ownedBlob: Blob | undefined;
      let conflict = false;
      await withArchiveStore('readwrite', store => {
        const check = store.get(nativeVersionKey(archiveId));
        check.onsuccess = () => {
          // Conversion is also a source replacement. Never install it over a
          // newer edit head that arrived while the old source was being read.
          if (check.result?.revision !== value.revision || check.result?.viewCacheId !== value.viewCacheId) {
            conflict = true; return;
          }
          store.put(blob, source.descriptor.blobKey); store.put(migrated, archiveId);
          const owned = store.get(source.descriptor.blobKey); owned.onsuccess = () => { ownedBlob = owned.result; };
        };
        return check;
      });
      if (conflict) throw new Error('建立索引期间档案已更新，请重新打开上次阅览');
      if (ownedBlob) { const stored = ownedBlob; source.blob = async () => stored; }
      return migrated;
    }
    return !paged && value.pages ? { ...value, data: await hydratePagedArchive(value.data, value.data) } : value;
  };
  if (entry && native?.localMessages && isNativeZhihuView(entry.data)) {
    const localIds = new Set(entry.data.messages.filter(isNativeLocalMessage).map(message => message.id));
    const { view: _baseView, ...source } = entry.data;
    const authors = new Set((entry.data.users || []).map(user => user.id));
    const data = { ...source, messages: [...entry.data.messages.filter(message => !localIds.has(message.id)), ...native.localMessages],
      relations: [...entry.data.relations.filter(relation => !localIds.has(relation.id)), ...(native.localRelations || [])],
      ...(native.view ? { view: native.view } : {}), viewerUsername: native.viewerUsername,
      ...(entry.data.users || native.localUsers ? { users: [...(entry.data.users || []), ...(native.localUsers || []).filter(user => !authors.has(user.id))] } : {}) };
    return finish({ ...entry, data, revision: native.revision });
  }
  if (!entry || !edits) return finish(entry);
  const data = applyEditRecord(entry.data, edits);
  sourceRevisions.set(data, edits);
  return finish({ ...entry, data });
}

function bindRestoredSource(source: unknown, entry: CachedArchive): unknown {
  if (source && typeof source === 'object') {
    const edits = sourceRevisions.get(entry.data); if (edits) sourceRevisions.set(source, edits);
  }
  return bindDiscussionSource(source, entry);
}

/** Relinking a source must recover unsynced native edits even after another file was viewed. */
export async function loadCachedNativeExport(source: NativeZhihuView, options: RestoreOptions = {}): Promise<ExportData | null> {
  const matches = (data: ExportData) => isNativeZhihuView(data) && nativeZhihuIdentity(data) === nativeZhihuIdentity(source);
  if (currentArchive && matches(currentArchive.data) && !currentArchivePersistent) {
    const data = inheritPagedArchive(structuredClone(currentArchive.data), currentArchive.data);
    return bindRestoredSource(options.paged ? data : await hydratePagedArchive(data, data), currentArchive) as ExportData;
  }
  if (typeof indexedDB === 'undefined') return null;
  let reference = await withArchiveStore<ArchiveReference | undefined>('readonly', store => store.get(nativeSourceKey(source)));
  // Existing caches predate the source index. Their current/last selection is still recoverable.
  if (!reference && currentArchive && matches(currentArchive.data)) reference = { archiveId: currentArchive.archiveId };
  reference ??= await withArchiveStore<ArchiveReference | undefined>('readonly', store => store.get(LAST_ARCHIVE_POINTER));
  if (!reference) return null;
  const entry = await readStoredEntry(reference.archiveId, false, !!options.paged);
  if (!entry?.data || !matches(entry.data)) return null;
  durableViewCacheIds.add(entry.viewCacheId ?? entry.archiveId);
  viewCacheIds.set(entry.archiveId, entry.viewCacheId ?? entry.archiveId);
  return bindRestoredSource(entry.data, entry) as ExportData;
}

async function readReference(reference: unknown, options: RestoreOptions = {}): Promise<unknown> {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new Error('上次阅览缓存格式无效，请重新选择原 JSON 文件');
  if (!('archiveId' in reference) || typeof reference.archiveId !== 'string') return readingSource(reference as ExportData, options.sourceOnly);
  const archiveId = reference.archiveId;
  const stored = await readStoredEntry(archiveId, false, !!options.paged);
  if (!stored && archiveId.startsWith('zhihu:')) { sessionStorage.removeItem(LAST_EXPORT_KEY); return null; }
  if (!stored || stored.archiveId !== archiveId || !stored.data) throw new Error('上次阅览缓存缺失，请重新选择原 JSON 文件');
  const entry = stored;
  rememberInTab(entry, true);
  return bindRestoredSource(readingSource(entry.data, options.sourceOnly), entry);
}

/** Reload an existing Zhihu viewer without switching to another tab's last file. */
export async function loadCachedExport(archiveId: string, { fresh = false, sourceOnly = false }: { fresh?: boolean; sourceOnly?: boolean } = {}): Promise<unknown | null> {
  let key = `zhihu:${archiveId}`;
  if (currentArchive && (currentArchive.archiveId === key || isZhihuViewingData(currentArchive.data) && currentArchive.data.zhihu.archiveId === archiveId) && (!fresh || !currentArchivePersistent)) return bindRestoredSource(structuredClone(readingSource(currentArchive.data, sourceOnly)), currentArchive);
  if (typeof indexedDB === 'undefined') return null;
  let stored = await readStoredEntry(key);
  if (!stored) {
    const alias = await withArchiveStore<string | undefined>('readonly', store => store.get(`__zhihu_alias__:${archiveId}`));
    if (alias) {
      key = alias; stored = await readStoredEntry(key);
      if (stored && (!isZhihuViewingData(stored.data) || stored.data.zhihu.archiveId !== archiveId)) return null;
    }
  }
  if (!stored) return null;
  if (stored.archiveId !== key || !stored.data) throw new Error('这份档案的阅览缓存格式无效，请重新选择原 JSON 文件');
  const entry = stored;
  if (fresh) rememberInTab(entry, true);
  else viewCacheIds.set(entry.archiveId, entry.viewCacheId ?? entry.archiveId);
  durableViewCacheIds.add(entry.viewCacheId ?? entry.archiveId);
  return bindRestoredSource(readingSource(entry.data, sourceOnly), entry);
}

/** Verify both IDs against the stored document before binding a cloned route. */
export async function loadReferencedExport(reference: unknown, options: RestoreOptions = {}): Promise<unknown> {
  if (!reference || typeof reference !== 'object' || !('archiveId' in reference) || typeof reference.archiveId !== 'string'
    || !('viewCacheId' in reference) || typeof reference.viewCacheId !== 'string') throw new Error('阅览缓存身份无效，请重新选择文件。');
  const { archiveId, viewCacheId } = reference;
  const stored = await readStoredEntry(archiveId, false, !!options.paged);
  if (!stored?.data || stored.archiveId !== archiveId || (stored.viewCacheId ?? stored.archiveId) !== viewCacheId)
    throw new Error('这份阅览缓存已更换或不存在，请重新选择文件。');
  const entry = stored;
  durableViewCacheIds.add(viewCacheId);
  viewCacheIds.set(entry.archiveId, viewCacheId);
  return bindRestoredSource(readingSource(entry.data, options.sourceOnly), entry);
}

// A tiny record per opened document, separate from the authoritative archive and
// its compare-and-swap baseline. Explicitly opening a file creates a new token,
// so an older tab cannot restore its folds over that newly selected file.
const discussionWrites = new Map<string, Promise<void>>();
const navigationWrites = new Map<string, Promise<void>>();
const navigationPositions = new Map<string, ExportNavigation>();
export const EXPORT_DISCUSSION_VIEW_SAVED = 'export-discussion-view-saved';
function discussionKey(data: ExportData): string | null {
  const reference = sourceViewCacheIds.get(data);
  if (reference) return `__discussion_view__:${reference.viewCacheId}`;
  if (isZhihuViewingData(data)) {
    const id = viewCacheIds.get(`zhihu:${getZhihuArchiveIdentity(data)}`);
    return id ? `__discussion_view__:${id}` : null;
  }
  return null;
}

function navigationKey(data: ExportData): string | null {
  const key = discussionKey(data);
  return key ? key.replace('__discussion_view__:', '__navigation_view__:') : null;
}

/** Browsing position is separate from the file's saved view and local edit baseline. */
export async function loadExportNavigation(data: ExportData): Promise<ExportNavigation | null> {
  const key = navigationKey(data);
  if (!key) return null;
  await navigationWrites.get(key)?.catch(() => undefined);
  const current = navigationPositions.get(key);
  if (current) return structuredClone(current);
  const saved = await withArchiveStore<ExportNavigation | undefined>('readonly', store => store.get(key));
  if (!saved || !(saved.classificationId === null || typeof saved.classificationId === 'string')) return null;
  if (saved.classificationPath !== undefined && (!Array.isArray(saved.classificationPath)
    || saved.classificationPath.some(id => typeof id !== 'string')
    || (saved.classificationPath.at(-1) ?? null) !== saved.classificationId)) return null;
  return saved;
}

export async function saveExportNavigation(data: ExportData, value: ExportNavigation): Promise<void> {
  const key = navigationKey(data);
  if (!key) return;
  const saved = structuredClone(value);
  navigationPositions.set(key, saved);
  const write = (navigationWrites.get(key) ?? Promise.resolve()).catch(() => undefined)
    .then(async () => { await withArchiveStore('readwrite', store => store.put(saved, key)); });
  navigationWrites.set(key, write);
  try { await write; }
  finally { if (navigationWrites.get(key) === write) navigationWrites.delete(key); }
}

export async function loadExportDiscussionView(data: ExportData): Promise<DiscussionView | null> {
  const key = discussionKey(data);
  if (!key) return null;
  await discussionWrites.get(key)?.catch(() => undefined);
  const saved = await withArchiveStore<unknown>('readonly', store => store.get(key));
  if (saved === undefined) return null;
  if (!isDiscussionView(saved)) throw new Error('讨论布局缓存格式无效，已使用文件中的阅览设置。');
  return copyDiscussionView(saved);
}

/** Only a committed small record counts as saved; never rewrite source data. */
export async function saveExportDiscussionView(data: ExportData, value: DiscussionView): Promise<void> {
  if (!isDiscussionView(value)) throw new Error('讨论布局设置格式无效。');
  const key = discussionKey(data);
  if (!key) throw new Error('此文件尚无本机缓存，讨论布局未保存；可下载阅览文件保留当前设置。');
  const saved = copyDiscussionView(value);
  const write = (discussionWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    try { await withArchiveStore('readwrite', store => store.put(saved, key)); }
    catch { throw new Error('讨论布局未能保存到本机，请检查浏览器存储后重试；也可下载阅览文件保留当前设置。'); }
  });
  discussionWrites.set(key, write);
  try {
    await write;
    window.dispatchEvent(new CustomEvent(EXPORT_DISCUSSION_VIEW_SAVED, { detail: { key } }));
  }
  finally { if (discussionWrites.get(key) === write) discussionWrites.delete(key); }
}

/** The chooser needs a title, not a cloned and projected copy of the archive. */
export async function loadLastExportPreview(): Promise<ExportPreview | null> {
  if (currentArchive) return currentArchivePersistent ? archivePreview(currentArchive) : null;
  if (typeof indexedDB === 'undefined') return null;
  const raw = sessionStorage.getItem(LAST_EXPORT_KEY);
  const reference = raw ? JSON.parse(raw) as Partial<ArchiveReference> | null
    : await withArchiveStore<ArchiveReference | undefined>('readonly', store => store.get(LAST_ARCHIVE_POINTER));
  if (!reference || typeof reference.archiveId !== 'string') return null;
  const preview = await withArchiveStore<ExportPreview | undefined>('readonly', store => store.get(previewKey(reference.archiveId!)));
  if (preview && typeof preview.title === 'string' && preview.reference?.archiveId === reference.archiveId
    && typeof preview.reference.viewCacheId === 'string') return preview;
  // Read old caches once to add the small label beside the unchanged source.
  // A quota failure must not prevent reading an otherwise valid document.
  const entry = await readStoredEntry(reference.archiveId, true).catch(() => readStoredEntry(reference.archiveId!));
  return entry?.archiveId === reference.archiveId && typeof entry.data?.scope?.title === 'string' ? archivePreview(entry) : null;
}

export async function loadLastExport(options: RestoreOptions = {}): Promise<unknown | null> {
  // A new route must receive a fresh object even when persistent storage fails.
  if (currentArchive) {
    if (options.fresh && currentArchivePersistent) return readReference({ archiveId: currentArchive.archiveId }, options);
    if (pagedArchiveSource(currentArchive.data)) {
      const data = inheritPagedArchive(structuredClone(currentArchive.data), currentArchive.data);
      return bindRestoredSource(options.paged ? data : await hydratePagedArchive(data, data), currentArchive);
    }
    return bindRestoredSource(structuredClone(readingSource(currentArchive.data, options.sourceOnly)), currentArchive);
  }
  const raw = sessionStorage.getItem(LAST_EXPORT_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (isZhihuViewingData(parsed)) { sessionStorage.removeItem(LAST_EXPORT_KEY); }
    else return readReference(parsed, options);
  }
  if (typeof indexedDB === 'undefined') return null;
  const reference = await withArchiveStore<ArchiveReference | undefined>('readonly', store => store.get(LAST_ARCHIVE_POINTER));
  return reference ? readReference(reference, options) : null;
}
