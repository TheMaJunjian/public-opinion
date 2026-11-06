import { prepareExportForViewing } from './exportArchive';
import { attachPagedArchive, indexNativeZhihuBlob, PAGED_ARCHIVE_MIN_BYTES, type PagedArchiveDescriptor } from './pagedZhihuArchive';
import { blobBytes } from './streamJsonArchive';
import type { NativeZhihuView } from './nativeZhihuView';

export async function readViewerFile(file: Blob, signal?: AbortSignal) {
  if (file.size >= PAGED_ARCHIVE_MIN_BYTES) {
    const header = new TextDecoder().decode(await blobBytes(file.slice(0, 65536)));
    if (/"format"\s*:\s*"gonglun-view-3"/.test(header)) {
      let worker: Worker | undefined;
      if (typeof Worker === 'function') {
        try { worker = new Worker(new URL('../workers/viewerIndex.worker.ts', import.meta.url), { type: 'module' }); }
        catch { /* The bounded scanner also works without workers. */ }
      }
      const indexed = worker ? await new Promise<{ data: NativeZhihuView; descriptor: PagedArchiveDescriptor } | null>((resolve, reject) => {
        const active = worker!;
        const stop = () => { active.terminate(); signal?.removeEventListener('abort', cancel); };
        const cancel = () => { stop(); reject(signal?.reason ?? new DOMException('读取已取消', 'AbortError')); };
        active.onmessage = ({ data }) => { stop(); if (data.error) reject(new Error(data.error)); else resolve(data.result); };
        active.onerror = () => { stop(); reject(new Error('文件索引建立失败，请重新选择文件')); };
        active.onmessageerror = () => { stop(); reject(new Error('文件索引读取失败')); };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) { cancel(); return; }
        active.postMessage(file);
      }) : await indexNativeZhihuBlob(file, { signal });
      signal?.throwIfAborted();
      if (indexed) return prepareExportForViewing(attachPagedArchive(indexed.data, indexed.descriptor, async () => file));
    }
  }
  signal?.throwIfAborted();
  const data = JSON.parse(typeof file.text === 'function' ? await file.text()
    : new TextDecoder('utf-8', { fatal: true }).decode(await blobBytes(file)));
  signal?.throwIfAborted();
  return prepareExportForViewing(data);
}
