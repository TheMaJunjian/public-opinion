import type { ExportData, ExportUpdateData } from '../api/client';
import { mergeExportUpdate, prepareExportUpdate, validateExportForViewing } from './exportArchive';
import { fetchJsonWithDeadline } from './requestLifecycle';

export type ExportTask = { kind: 'full'; scopeMessageId: string; source?: ExportData | null; view: NonNullable<ExportData['view']> }
  | { kind: 'update'; file: Blob };
export interface PreparedExport { blob: Blob; added: number; messageCount: number }
export type ExportWorkerRequest = { task: ExportTask; apiUrl: string };
export type ExportWorkerResponse = { status: 'progress'; message: string }
  | { status: 'ready'; result: PreparedExport } | { status: 'error'; message: string };

/** Runs in the export worker: only small progress messages and the finished Blob leave it. */
export async function prepareArchiveExport({ task, apiUrl }: ExportWorkerRequest, progress: (message: string) => void): Promise<PreparedExport> {
  async function fetchExport(parent: string, base?: Awaited<ReturnType<typeof prepareExportUpdate>>['checkpoint']) {
    const query = new URLSearchParams({ parent });
    if (base) Object.entries({ after: base.sequence, baseCount: base.entryCount, baseHash: base.hash,
      regionId: base.regionId, ledgerId: base.ledgerId }).forEach(([key, value]) => query.set(key, String(value)));
    const { response, data } = await fetchJsonWithDeadline<ExportData | ExportUpdateData | { error?: string; message?: string }>(`${apiUrl}/export?${query}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      const error = data as { error?: string; message?: string };
      throw new Error(error.error || error.message || response.statusText);
    }
    return data;
  }
  let data: ExportData;
  let added = 0;
  if (task.kind === 'update') {
    progress('正在读取旧文件并校验完整性…');
    const original = await prepareExportUpdate(JSON.parse(await task.file.text()));
    progress('正在核对数据来源并获取新增记录…');
    const update = await fetchExport(original.data.scope.messageId ?? 'root', original.checkpoint) as ExportUpdateData;
    progress('正在合并记录并校验更新后的文件…');
    data = mergeExportUpdate(original.data, original.checkpoint, update);
    added = update.changes.length;
  } else {
    progress(task.source ? '正在校验当前阅览文件…' : '正在获取导出数据…');
    const source = task.source ?? await fetchExport(task.scopeMessageId);
    progress('正在校验导出数据…');
    data = { ...validateExportForViewing(source).data, view: task.view };
  }
  progress('正在生成文件…');
  return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }), added, messageCount: data.messages.length };
}
