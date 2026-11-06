import type { ExportTask, ExportWorkerResponse, PreparedExport } from './exportTask';
import { ConversionFailure, readConversionFailure } from '@gonglun/core';
import { pagedArchiveSource } from './pagedZhihuArchive';
import { isNativeZhihuView } from './nativeZhihuView';

export function startArchiveExport(task: ExportTask, progress: (message: string) => void) {
  if (isNativeZhihuView(task.source) && pagedArchiveSource(task.source)) {
    const source = task.source;
    const controller = new AbortController();
    const result = import('./zhihuViewExport').then(async ({ prepareZhihuViewExport }) => {
      controller.signal.throwIfAborted();
      const result = await prepareZhihuViewExport(source, task.view, task.kind === 'update' ? task.file : undefined, progress, controller.signal);
      controller.signal.throwIfAborted();
      return result;
    });
    return { result, cancel: () => { controller.abort(new DOMException('导出已取消', 'AbortError')); } };
  }
  const worker = new Worker(new URL('../workers/archiveExport.worker.ts', import.meta.url), { type: 'module' });
  let rejectResult: (error: Error) => void;
  const result = new Promise<PreparedExport>((resolve, reject) => {
    rejectResult = reject;
    worker.onmessage = ({ data }: MessageEvent<ExportWorkerResponse>) => {
      if (data.status === 'progress') { progress(data.message); return; }
      worker.terminate();
      if (data.status === 'ready') resolve(data.result);
      else {
        const report=readConversionFailure(data.failure);
        reject(report?new ConversionFailure(report):new Error(data.message));
      }
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('导出处理未能启动，请刷新页面后重试')); };
    worker.onmessageerror = () => { worker.terminate(); reject(new Error('导出结果读取失败，请重试')); };
    const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
    try { worker.postMessage({ task, apiUrl: new URL(`${base}/ui`, window.location.href).href }); }
    catch (error) { worker.terminate(); reject(error); }
  });
  return { result, cancel: () => { worker.terminate(); rejectResult(new DOMException('导出已取消', 'AbortError')); } };
}
