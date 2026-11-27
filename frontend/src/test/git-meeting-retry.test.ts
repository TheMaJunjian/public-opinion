import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearPendingGitDeltas, forgetPendingGitDelta, gitMeetingPendingKey, hasPendingGitDeltas, loadPendingGitDelta,
  rememberPendingGitDelta, settlePendingGitDeltas,
} from '../utils/gitMeetingRetry';
import type { GitMeetingDelta } from '../utils/gitMeetingTransport';

const archive = 'git-issue:example-room-1';
const uuid = (n: number) => '00000000-0000-4000-a000-' + n.toString(16).padStart(12, '0');
const message = (n: number) => 'local:' + uuid(n);

function batch(start: number, text = '收到，我下周一参加。', speaker = '小李', target = message(999)): GitMeetingDelta {
  const author = { speakerId: 'local:user:' + uuid(start), speaker, at: new Date(start * 1000).toISOString() };
  return {
    format: 'gonglun-meeting-delta', version: 1, meetingId: uuid(500), baseHash: 'a'.repeat(64),
    entries: [
      { ...author, id: message(start), type: 'text', text },
      { ...author, id: message(start + 1), type: 'reply', source: message(start), targets: [target] },
    ],
  };
}

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  clearPendingGitDeltas();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearPendingGitDeltas(); });

it('reuses the original IDs, author and timestamp for a repeated reply after a reload', async () => {
  const original = batch(10), retry = batch(20);
  const key = await gitMeetingPendingKey(archive, original);
  expect(key).toMatch(/^gonglun:git-pending:[0-9a-f]{64}$/);
  expect(await gitMeetingPendingKey(archive, retry)).toBe(key);
  rememberPendingGitDelta(key, original);
  expect(sessionStorage.getItem(key)).toBeTruthy();
  vi.resetModules();
  const reloaded = await import('../utils/gitMeetingRetry');
  expect(reloaded.loadPendingGitDelta(key, retry)).toEqual(original);
  reloaded.forgetPendingGitDelta(key);
  expect(loadPendingGitDelta(key, retry)).toBeUndefined();
});

it('keeps independent archives, meetings, base snapshots, names, text and external reply targets separate', async () => {
  const original = batch(10);
  const key = await gitMeetingPendingKey(archive, original);
  rememberPendingGitDelta(key, original);
  expect(await gitMeetingPendingKey(archive + '2', original)).not.toBe(key);
  for (const other of [
    { ...original, meetingId: uuid(501) }, { ...original, baseHash: 'b'.repeat(64) },
    batch(10, '修改后的发言'), batch(10, undefined, '小张'), batch(10, undefined, undefined, message(998)),
  ]) {
    expect(await gitMeetingPendingKey(archive, other)).not.toBe(key);
    expect(loadPendingGitDelta(key, other)).toBeUndefined();
  }
  const misplaced = await gitMeetingPendingKey(archive + '2', original);
  sessionStorage.setItem(misplaced, sessionStorage.getItem(key)!);
  expect(loadPendingGitDelta(misplaced, original)).toBeUndefined();
});

it('keeps the specific in-batch reference and distinguishes it from an existing text', async () => {
  const original = batch(10);
  const otherText = { ...original.entries[0], id: message(90) };
  const reply = original.entries[1];
  if (reply.type !== 'reply') throw new Error();
  const make = (source: string) => ({ ...original, entries: [original.entries[0], otherText, { ...reply, source }] });
  const keys = await Promise.all([message(10), message(90), message(91)].map(id => gitMeetingPendingKey(archive, make(id))));
  expect(new Set(keys).size).toBe(3);
});

it('refuses malformed records, unrelated content and invalid identities in storage', async () => {
  const original = batch(10);
  const key = await gitMeetingPendingKey(archive, original);
  const [text, reply] = original.entries;
  const records = [
    null, { ...original, revision: 2 }, { ...original, meetingId: 'bad' }, batch(10, '无关的发言'),
    { ...original, entries: [{ ...text, token: 'unexpected' }, reply] },
    { ...original, entries: [{ ...text, id: 'broken' }, reply] },
    { ...original, entries: [{ ...text, at: 'invalid' }, reply] },
    { ...original, entries: [text, { ...reply, id: text.id }] },
    { ...original, entries: [text, { ...reply, speaker: '其他署名' }] },
    { ...original, entries: [text, { ...reply, source: reply.id }] },
  ];
  for (const delta of records) {
    sessionStorage.setItem(key, JSON.stringify({ key, delta }));
    expect(loadPendingGitDelta(key, original)).toBeUndefined();
  }
  sessionStorage.setItem(key, 'broken');
  expect(loadPendingGitDelta(key, original)).toBeUndefined();
});

it('retains a pending send on the current page when storage is full and clears only pending sends at logout', async () => {
  const first = batch(10), second = batch(20, '第二次提交');
  const firstKey = await gitMeetingPendingKey(archive, first), secondKey = await gitMeetingPendingKey(archive, second);
  sessionStorage.setItem('unrelated', 'keep');
  rememberPendingGitDelta(firstKey, first);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
  rememberPendingGitDelta(secondKey, second);
  expect(loadPendingGitDelta(secondKey, second)).toEqual(second);
  forgetPendingGitDelta(secondKey);
  expect(loadPendingGitDelta(secondKey, second)).toBeUndefined();
  rememberPendingGitDelta(secondKey, second);
  clearPendingGitDeltas();
  expect(loadPendingGitDelta(secondKey, second)).toBeUndefined();
  expect(loadPendingGitDelta(firstKey, first)).toBeUndefined();
  expect(sessionStorage.getItem('unrelated')).toBe('keep');
});

it('only settles the whole original batch with exact saved attributes, even when the same text is sent again', async () => {
  const original = batch(10), newer = batch(20);
  const key = await gitMeetingPendingKey(archive, original);
  expect(hasPendingGitDeltas()).toBe(false);
  rememberPendingGitDelta(key, original);
  expect(hasPendingGitDeltas()).toBe(true);
  const [text, reply] = original.entries;
  for (const incomplete of [
    { ...original, entries: [text] }, { ...original, entries: [reply] }, newer,
    { ...original, entries: [text, { ...reply, at: newer.entries[1].at }] },
    { ...original, entries: [text, { ...reply, speakerId: newer.entries[1].speakerId }] },
    { ...original, entries: [text, { ...reply, type: 'reply' as const, source: text.id, targets: [message(997)] }] },
    { ...original, meetingId: uuid(501) }, { ...original, baseHash: 'b'.repeat(64) },
  ]) {
    await settlePendingGitDeltas(archive, incomplete);
    expect(loadPendingGitDelta(key, newer)).toEqual(original);
  }
  await settlePendingGitDeltas(archive, { ...original, entries: [reply, ...newer.entries, text] });
  expect(hasPendingGitDeltas()).toBe(false);
  expect(loadPendingGitDelta(key, newer)).toBeUndefined();
  rememberPendingGitDelta(key, newer);
  forgetPendingGitDelta(key, original);
  expect(loadPendingGitDelta(key, newer)).toEqual(newer);
  forgetPendingGitDelta(key, newer);
  expect(hasPendingGitDeltas()).toBe(false);
});

it('only settles matching records in the selected archive, including when session storage is full', async () => {
  const original = batch(10), other = batch(80, '另外一条');
  const firstKey = await gitMeetingPendingKey(archive, original), otherKey = await gitMeetingPendingKey(archive, other);
  const copyKey = await gitMeetingPendingKey(archive + 'copy', original);
  rememberPendingGitDelta(copyKey, original);
  rememberPendingGitDelta(otherKey, other);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
  rememberPendingGitDelta(firstKey, original);
  await settlePendingGitDeltas(archive, original);
  expect(loadPendingGitDelta(firstKey, original)).toBeUndefined();
  expect(loadPendingGitDelta(copyKey, original)).toEqual(original);
  expect(loadPendingGitDelta(otherKey, other)).toEqual(other);
});

it('preserves a new pending send that races with reconciliation of a previous identical message', async () => {
  const original = batch(10), newer = batch(20);
  const key = await gitMeetingPendingKey(archive, original);
  rememberPendingGitDelta(key, original);
  const settling = settlePendingGitDeltas(archive, original);
  rememberPendingGitDelta(key, newer);
  await settling;
  expect(loadPendingGitDelta(key, newer)).toEqual(newer);
});
