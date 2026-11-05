import type { ExportData } from '../api/client';
import { prepareExportForViewing } from './exportArchive';
import { serializeNativeZhihuView } from './nativeZhihuEditor';
import { isNativeZhihuView, mergeNativeZhihuUpdate, type NativeZhihuView } from './nativeZhihuView';
import type { PreparedExport } from './exportTask';

/** A local snapshot update never asks the Gonglun server for Zhihu records. */
export async function prepareZhihuViewExport(source: NativeZhihuView, view: ExportData['view'], file: Blob | undefined,
  progress: (message: string) => void): Promise<PreparedExport> {
  let data = source, added = 0;
  if (file) {
    progress('正在读取已有阅览文件…');
    const original = (await prepareExportForViewing(JSON.parse(await file.text()))).data;
    if (!isNativeZhihuView(original)) throw new Error('请选择精简格式的知乎阅览文件。');
    progress('正在合并新增内容和本地消息…');
    // Source omissions and diverging local histories are rejected by the same
    // merge used for directory updates, before a writable stream is opened.
    data = mergeNativeZhihuUpdate(original, source);
    const existing = new Set(original.messages.map(message => message.id));
    added = data.messages.filter(message => !existing.has(message.id)).length;
  }
  data = { ...data, ...(view ? { view } : {}) };
  progress('正在生成阅览文件…');
  return { blob: new Blob([serializeNativeZhihuView(data)], { type: 'application/json' }), added, messageCount: data.messages.length };
}
