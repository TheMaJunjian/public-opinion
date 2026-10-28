import { archiveChangeFingerprint, replayArchive, type Archive, type ArchiveCheckpoint } from '@gonglun/core';
import type { ExportData, ExportUpdateData } from '../api/client';
import {isHomeFilterMode} from '../pages/workbench/model/homeFilter';
import {CLEAN_MESSAGE_TYPES} from '../types';

const cleanMessageTypes=new Set<string>(['CONTENT','RELATION',...CLEAN_MESSAGE_TYPES.map(([type])=>type)]);

/** Convert old files locally, on demand, without adding a migration dialog. */
export async function prepareExportForViewing(input:unknown){
  const archive=input as ExportData|null;
  if(archive&&archive.formatVersion>5)throw new Error('文件版本比当前程序更新，请更新程序后再打开');
  const historical=archive&&typeof archive==='object'&&(archive.formatVersion<5
    ||archive.format==='gonglun-2'&&!Array.isArray(archive.messages)&&Array.isArray((archive as unknown as Archive).changes)
    ||Array.isArray(archive.messages)&&archive.messages.some(message=>!Array.isArray(message.parts)||!Number.isSafeInteger(message.revision)
      ||message.parts.some(part=>part.type==='relation'&&['legacy-join','unfollow','unblock'].includes(part.relation)
        ||part.type==='data'&&!!part.value&&typeof part.value==='object'&&!Array.isArray(part.value)&&'legacyTopicId' in part.value)));
  if(historical){
    const {migrateViewFile}=await import('../../../apps/migrate/src/migrate-view-file');
    return validateExportForViewing(migrateViewFile(input));
  }
  return validateExportForViewing(input);
}

/** Accept the current view contract; historical conversion belongs to the standalone migrator. */
export function validateExportForViewing(input: unknown): { data: ExportData; verification: string | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('导出文件格式无效');
  const archive = input as ExportData;
  let verification: string | null = null;
  if (archive.format === 'gonglun-2') {
    const replay = replayArchive(archive);
    verification = `记录连续性及资金守恒校验通过：${replay.changeCount} 次变更，${replay.messages.length} 条消息，${replay.accounts.size} 个账户。运营余额 ${replay.operating}，发行总量 ${replay.issued}。`;
  }
  const data = archive;
  if (!data.scope || typeof data.scope.title !== 'string') {
    throw new Error(archive.format === 'gonglun-2'
      ? '缺少阅览范围信息（scope）；仅含执行记录的文件请改用消息视图中的“导出”生成阅览文件'
      : '缺少阅览范围信息（scope），请先使用独立迁移程序转换文件');
  }
  if (!Array.isArray(data.messages)) throw new Error('缺少消息列表（messages）');
  if (!Array.isArray(data.relations)) throw new Error('缺少关系列表（relations）');
  if(data.messages.some(message=>!Array.isArray(message.parts)||!Number.isSafeInteger(message.revision)))
    throw new Error('消息文件需要先使用独立迁移程序转换为最新版');
  const view = data.view;
  if (view !== undefined && (!view || typeof view !== 'object'
    || !(view.username === null || typeof view.username === 'string')
    || !['list', 'graph'].includes(view.mode)
    || typeof view.messageFilter?.hideSettlement !== 'boolean' || typeof view.messageFilter?.hideJoin !== 'boolean'
    || !isHomeFilterMode(view.homeFilter)
    || !Array.isArray(view.cleanFilters) || view.cleanFilters.some(rule => !rule || !['sender', 'tag', 'stake', 'rounds', 'participants', 'relationType','messageType','time'].includes(rule.kind)
      ||rule.kind==='messageType'&&(!Array.isArray(rule.messageTypes)||!rule.messageTypes.length
        ||rule.messageTypes.some(type=>!cleanMessageTypes.has(type)))
      ||rule.kind==='time'&&(typeof rule.from!=='string'||typeof rule.to!=='string'
        ||!rule.from&&!rule.to||rule.from&&!Number.isFinite(Date.parse(rule.from))||rule.to&&!Number.isFinite(Date.parse(rule.to))
        ||rule.from&&rule.to&&Date.parse(rule.from)>Date.parse(rule.to)))
    || !(view.classificationId === null || typeof view.classificationId === 'string'))) {
    throw new Error('阅览设置格式无效');
  }
  return { data, verification };
}

export type UpdatableExportData = ExportData & Archive;

/** Verify the selected file locally; send only a digest and cursor to the server. */
export async function prepareExportUpdate(input: unknown): Promise<{ data: UpdatableExportData; checkpoint: ArchiveCheckpoint }> {
  const { data } = await prepareExportForViewing(input);
  if (data.format !== 'gonglun-2') throw new Error('此阅览文件不含完整执行记录，请先完整导出一次');
  const archive = data as UpdatableExportData;
  if (typeof archive.regionId !== 'string' || !archive.regionId || typeof archive.ledgerId !== 'string' || !archive.ledgerId) {
    throw new Error('文件缺少数据来源信息，请先完整导出一次');
  }
  const bytes = new TextEncoder().encode(archive.changes.map(archiveChangeFingerprint).join(''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { data: archive, checkpoint: {
    regionId: archive.regionId, ledgerId: archive.ledgerId, sequence: archive.changes.at(-1)?.sequence ?? 0,
    entryCount: archive.changes.length, hash: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''),
  } };
}

/** Replace current projections, append history once, and verify the complete result before saving. */
export function mergeExportUpdate(original: UpdatableExportData, checkpoint: ArchiveCheckpoint, update: ExportUpdateData): UpdatableExportData {
  const { base, ...fresh } = update;
  if (update.format !== 'gonglun-2-update' || !base || update.regionId !== checkpoint.regionId || update.ledgerId !== checkpoint.ledgerId
    || base.hash !== checkpoint.hash || base.sequence !== checkpoint.sequence || base.entryCount !== checkpoint.entryCount
    || base.regionId !== checkpoint.regionId || base.ledgerId !== checkpoint.ledgerId || !update.journal || !Array.isArray(update.changes)) {
    throw new Error('增量记录与所选文件不匹配');
  }
  if ((update.scope?.messageId ?? null) !== (original.scope.messageId ?? null)) throw new Error('增量记录的阅览范围不一致');
  const merged: UpdatableExportData = { ...original, ...fresh, format: 'gonglun-2',
    changes: [...original.changes, ...update.changes],
    viewerUsername: original.viewerUsername, view: original.view,
  };
  validateExportForViewing(merged);
  return merged;
}
