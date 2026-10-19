import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Change, Message } from '@gonglun/core';
import type { ExportUpdateData } from '../api/client';
import { mergeExportUpdate, prepareExportUpdate, type UpdatableExportData } from '../utils/exportArchive';

const message: Message = { id: 'm', revision: 1, authorId: 'system', createdAt: '', updatedAt: '', regionId: 'local', ledgerId: 'local', programVersion: '2.0.0', ruleVersion: 1,
  parts: [{ id: 'body', type: 'text', text: '旧正文' }], spending: { protocol: 0, recommendation: 0, wager: 0 }, sequence: 1 };
const change: Change = { sequence: 1, messages: [message], states: [], memberships: [], removedMemberships: [], ledger: [], treasury: { operating: 0, issued: 0 } };
export const originalArchive = (): UpdatableExportData => ({
  format: 'gonglun-2', formatVersion: 2, exportedAt: '', regionId: 'local', ledgerId: 'local', programVersion: '2.0.0',
  scope: { messageId: null, title: '公论' }, changes: [structuredClone(change)],
  messages: [{ id: 'm', kind: 'TEXT', contentType: 'TEXT', content: '旧正文', createdAt: '', authorId: 'system', author: '公论规则' }], relations: [],
  viewerUsername: '原用户', tagCounts: { m: { VALUABLE: 2 } }, attentionUsers: { m: ['u'] },
  view: { username: '原用户', mode: 'list', classificationId: null, homeFilter: null, cleanFilters: [], messageFilter: { hideSettlement: true, hideJoin: true } },
});
export const makeUpdate = (base: Awaited<ReturnType<typeof prepareExportUpdate>>): ExportUpdateData => ({
  ...base.data, format: 'gonglun-2-update', exportedAt: '更新后', base: base.checkpoint,
  changes: [{ ...structuredClone(change), sequence: 3, previousSequence: 1, messages: [{ ...message, revision: 2, sequence: 3, parts: [{ id: 'body', type: 'text', text: '新正文' }] }] }],
  journal: { version: 1, entryCount: 2, lastSequence: 3 }, viewerUsername: '当前在线用户',
  messages: [{ ...base.data.messages[0], content: '新正文' }], tagCounts: {}, attentionUsers: {},
});

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

it('merges a historical archive, refreshes old message state, preserves the viewer, and leaves the input unchanged', async () => {
  const original = originalArchive(), before = JSON.stringify(original);
  const base = await prepareExportUpdate(original), update = makeUpdate(base);
  const merged = mergeExportUpdate(base.data, base.checkpoint, update);
  expect(merged.changes.map(change => [change.sequence, change.previousSequence])).toEqual([[1, 0], [3, 1]]);
  expect(merged.messages[0].content).toBe('新正文');
  expect(merged.tagCounts).toEqual({});
  expect(merged.attentionUsers).toEqual({});
  expect(merged.view).toEqual(original.view);
  expect(merged.viewerUsername).toBe('原用户');
  expect(merged).not.toHaveProperty('base');
  expect(JSON.stringify(original)).toBe(before);
  const next = await prepareExportUpdate(merged);
  const unchanged = { ...update, base: next.checkpoint, changes: [] };
  expect(mergeExportUpdate(next.data, next.checkpoint, unchanged).changes).toHaveLength(2);
});

it('refuses duplicate, omitted, mismatched or unbalanced updates before they can be saved', async () => {
  const base = await prepareExportUpdate(originalArchive()), update = makeUpdate(base);
  expect(() => mergeExportUpdate(base.data, base.checkpoint, { ...update, changes: [] })).toThrow('不完整');
  expect(() => mergeExportUpdate(base.data, base.checkpoint, { ...update, changes: [{ ...base.data.changes[0], previousSequence: 0 }] })).toThrow('不连续');
  expect(() => mergeExportUpdate(base.data, base.checkpoint, { ...update, base: { ...update.base, hash: 'wrong' } })).toThrow('不匹配');
  expect(() => mergeExportUpdate(base.data, base.checkpoint, { ...update, scope: { messageId: 'other', title: '另一分类' } })).toThrow('阅览范围');
  const unbalanced = structuredClone(update); unbalanced.changes[0].treasury.issued = 1;
  expect(() => mergeExportUpdate(base.data, base.checkpoint, unbalanced)).toThrow('资金不守恒');
});

it('requires a full export for files without execution history', async () => {
  const { format: _format, ...old } = originalArchive();
  await expect(prepareExportUpdate(old)).rejects.toThrow('请先完整导出一次');
});
