import { replayArchive } from '@gonglun/core';
import type { ExportData } from '../api/client';

/** Normalize historical view metadata at the file boundary, keeping replay checks intact. */
export function validateExportForViewing(input: unknown): { data: ExportData; verification: string | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('导出文件格式无效');
  const archive = input as ExportData & { topic?: { title?: unknown } };
  let verification: string | null = null;
  if (archive.format === 'gonglun-2') {
    const replay = replayArchive(archive);
    verification = `记录连续性及资金守恒校验通过：${replay.sequence} 次变更，${replay.messages.length} 条消息，${replay.accounts.size} 个账户。运营余额 ${replay.operating}，发行总量 ${replay.issued}。`;
  }
  // Historical topic IDs are not message IDs and must not become navigation targets.
  const data = archive.scope == null && typeof archive.topic?.title === 'string'
    ? { ...archive, scope: { messageId: null, title: archive.topic.title } }
    : archive;
  if (!data.scope || typeof data.scope.title !== 'string') {
    throw new Error(archive.format === 'gonglun-2'
      ? '缺少阅览范围信息（scope）；仅含执行记录的文件请改用消息视图中的“导出”生成阅览文件'
      : '缺少阅览范围信息（scope 或旧版 topic）');
  }
  if (!Array.isArray(data.messages)) throw new Error('缺少消息列表（messages）');
  if (!Array.isArray(data.relations)) throw new Error('缺少关系列表（relations）');
  const view = data.view;
  if (view !== undefined && (!view || typeof view !== 'object'
    || !(view.username === null || typeof view.username === 'string')
    || !['list', 'graph'].includes(view.mode)
    || typeof view.messageFilter?.hideSettlement !== 'boolean' || typeof view.messageFilter?.hideJoin !== 'boolean'
    || ![null, 'read-self', 'read-related', 'unread-related', 'unread-other'].includes(view.homeFilter)
    || !Array.isArray(view.cleanFilters) || view.cleanFilters.some(rule => !rule || !['sender', 'tag', 'stake', 'rounds', 'participants', 'relationType'].includes(rule.kind))
    || !(view.classificationId === null || typeof view.classificationId === 'string'))) {
    throw new Error('阅览设置格式无效');
  }
  return { data, verification };
}
