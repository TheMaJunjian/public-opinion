import { expect, it } from 'vitest';
import { replayArchive } from './replay.js';
import type { Change, Message } from './types.js';
const source: Message = { id: 'grant', revision: 1, authorId: 'system', createdAt: '', updatedAt: '', regionId: 'local', ledgerId: 'local', programVersion: '2.0.0', ruleVersion: 1, parts: [{ id: 'body', type: 'text', text: '发放' }], spending: { protocol: 0, recommendation: 0, wager: 0 }, sequence: 1 };
const first: Change = { sequence: 1, previousSequence:0, messages: [source], memberships: [], removedMemberships: [], states: [], treasury: { operating: 0, issued: 100 }, ledger: [{ id: 'entry', userId: 'user', messageId: 'grant', messageRevision: 1, amount: 100, lockedDelta: 0, reason: '初始发放', createdAt: '', ruleVersion: 1 }] };
const archive = (changes: Change[]) => ({ format: 'gonglun-2', regionId: 'local', ledgerId: 'local', programVersion: '2.0.0', changes });
it('replays actual historical amounts and checks each committed transaction', () => {
  const next: Change = { ...first, sequence: 2, previousSequence:1, messages: [], treasury: { operating: 1, issued: 100 }, ledger: [{ ...first.ledger[0], id: 'fee', amount: -11, lockedDelta: 10, reason: '协议与押注' }] };
  const result = replayArchive(archive([first, next]));
  expect(result.accounts.get('user')).toMatchObject({ available: 89, locked: 10 });
  expect(result.operating).toBe(1);
});
it('detects truncated pages, duplicated transfers and changed amounts', () => {
  expect(() => replayArchive(archive([{ ...first, sequence: 2, previousSequence:1 }]))).toThrow('不连续');
  expect(() => replayArchive(archive([first, { ...first, sequence: 2, previousSequence:1 }]))).toThrow('重复');
  expect(() => replayArchive(archive([{ ...first, treasury: { issued: 101, operating: 0 } }]))).toThrow('不守恒');
});
it('preserves historical versions and executed display state after content is edited', () => {
  const state = { messageId: source.id, revision: 1, suppressed: true, supportCount: 0, oppositionCount: 1, recommendationTotal: 0 };
  const edited = { ...source, revision: 2, parts: [{ id: 'body', type: 'text' as const, text: '修改后的内容' }] };
  const result = replayArchive(archive([{ ...first, states: [state] }, { ...first, sequence: 2, previousSequence:1, messages: [edited], ledger: [], states: [{ ...state, revision: 2 }] }]));
  expect(result.states[0].suppressed).toBe(true);
  expect(result.revisions.get(source.id)?.map(message => message.revision)).toEqual([1, 2]);
  expect(() => replayArchive(archive([{ ...first, messages: [{ ...source, parts: [null as never] }] }]))).toThrow('部件');
});

it('accepts rollback gaps only when the committed predecessor chain is complete', () => {
  const start = { ...first, previousSequence: 0 };
  const next = { ...first, sequence: 3, previousSequence: 1, messages: [], ledger: [] };
  const last = { ...next, sequence: 5, previousSequence: 3 };
  expect(replayArchive(archive([start, next, last])).sequence).toBe(5);
  expect(() => replayArchive(archive([start, last]))).toThrow('不连续');
  expect(() => replayArchive(archive([next, last]))).toThrow('不连续');
  expect(() => replayArchive(archive([start, next, next]))).toThrow('不连续');
});

it('checks the declared journal head and count, including an omitted final page', () => {
  const journal = { version: 1, entryCount: 2, lastSequence: 3 };
  const start = { ...first, previousSequence: 0 };
  const next = { ...first, sequence: 3, previousSequence: 1, messages: [], ledger: [] };
  expect(() => replayArchive({ ...archive([start]), journal })).toThrow('不完整');
  expect(replayArchive({ ...archive([start, next]), journal }).changeCount).toBe(2);
  expect(() => replayArchive({ ...archive([{...first,previousSequence:undefined}]), journal: { version: 1, entryCount: 1, lastSequence: 1 } })).toThrow('前序');
});
