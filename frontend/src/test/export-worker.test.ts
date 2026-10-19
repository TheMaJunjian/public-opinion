import { afterEach, expect, it, vi } from 'vitest';
import { startArchiveExport } from '../utils/exportWorker';

const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { workers.push(this); }
}
const task = { kind: 'update' as const, file: new File(['{}'], '公论.json') };
afterEach(() => { vi.unstubAllGlobals(); workers.length = 0; });

it('passes the unparsed file to a worker and returns the worker Blob without JSON processing', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const progress = vi.fn();
  const job = startArchiveExport(task, progress);
  const worker = workers[0];
  expect(worker.postMessage).toHaveBeenCalledWith({ task, apiUrl: expect.stringMatching(/\/api\/ui$/) });
  worker.onmessage!({ data: { status: 'progress', message: '正在生成文件…' } } as MessageEvent);
  expect(progress).toHaveBeenCalledWith('正在生成文件…');
  const result = { blob: new Blob(['{}']), added: 0, messageCount: 0 };
  worker.onmessage!({ data: { status: 'ready', result } } as MessageEvent);
  expect(await job.result).toBe(result);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('cancellation terminates the worker and rejects the pending task', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const job = startArchiveExport(task, vi.fn());
  job.cancel();
  await expect(job.result).rejects.toMatchObject({ name: 'AbortError' });
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

it('reports a worker load failure and releases the worker', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const job = startArchiveExport(task, vi.fn());
  workers[0].onerror!();
  await expect(job.result).rejects.toThrow('请刷新页面后重试');
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});
