import { expect, it } from 'vitest';
import type { Change } from '@gonglun/core';
import { collectArchive, type ExportPage } from './export';

const change = (sequence: number, ruleVersion = 1): Change => ({ sequence, messages: [{ updatedAt: `2026-10-14T00:0${sequence}:00Z`, ruleVersion }] } as Change);
const page = (changes: Change[], hasMore: boolean, versions: number[]): ExportPage => ({ format: 'gonglun-2', regionId: 'local', ledgerId: 'local', programVersion: '2.0.0', changes, nextCursor: changes.at(-1)!.sequence, hasMore, ruleHistory: versions.map(version => ({ version })) });
it('freezes the export head while retaining rules from every page', async () => {
  const pages = [page([change(1)], true, [1]), page([change(2, 2), change(3, 2)], false, [2])];
  const result = await collectArchive(2, async () => pages.shift()!);
  expect(result.changes.map(item => item.sequence)).toEqual([1, 2]);
  expect(result.ruleHistory.map(rule => rule.version)).toEqual([1, 2]);
});
it('exports a complete prefix for a historical cutoff and rejects missing transactions', async () => {
  const result = await collectArchive(2, async () => page([change(1), change(2)], false, [1]), Date.parse('2026-10-14T00:01:30Z'));
  expect(result.changes.map(item => item.sequence)).toEqual([1]);
  await expect(collectArchive(2, async () => page([change(2)], false, [1]))).rejects.toThrow('不连续');
});
