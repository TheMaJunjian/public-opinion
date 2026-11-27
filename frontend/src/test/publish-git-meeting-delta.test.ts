import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitHubRequestError, type GitMeetingDelta } from '../utils/gitMeetingTransport';
import { clearPendingGitDeltas, gitMeetingPendingKey, loadPendingGitDelta } from '../utils/gitMeetingRetry';
import { publishCloudMeetingDelta } from '../utils/publishCloudMeetingDelta';

const meeting = { id: '00000000-0000-4000-a000-000000000001', baseHash: 'a'.repeat(64) };
const archiveKey = 'git-issue:room-7';

function replyBatch(n: number): GitMeetingDelta {
  const uuid = (v: number) => '00000000-0000-4000-a000-' + v.toString(16).padStart(12, '0');
  const author = { speakerId: 'local:user:' + uuid(n), speaker: '小李', at: new Date(n * 1000).toISOString() };
  return { format: 'gonglun-meeting-delta', version: 1, meetingId: meeting.id, baseHash: meeting.baseHash, entries: [
    { ...author, id: 'local:' + uuid(n), type: 'text', text: '我同意。' },
    { ...author, id: 'local:' + uuid(n + 1), type: 'reply', source: 'local:' + uuid(n), targets: ['local:' + uuid(999)] },
  ] };
}

const first = replyBatch(10);
function setup() {
  return {
    archiveKey, provider: 'GitHub' as const, signal: new AbortController().signal,
    readForRetry: vi.fn<() => Promise<GitMeetingDelta['entries']>>().mockResolvedValue([]),
    append: vi.fn<(delta: GitMeetingDelta) => Promise<void>>().mockResolvedValue(undefined),
  };
}
beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  clearPendingGitDeltas();
});
afterEach(() => { clearPendingGitDeltas(); vi.unstubAllGlobals(); });

it('confirms after the single POST and releases the retry batch only on local save', async () => {
  const options = setup();
  const key = await gitMeetingPendingKey(archiveKey, first);
  const receipt = await publishCloudMeetingDelta(first, options);
  expect(options.append).toHaveBeenCalledExactlyOnceWith(first);
  expect(options.readForRetry).not.toHaveBeenCalled();
  expect(loadPendingGitDelta(key, first)).toEqual(first);
  receipt.saved();
  expect(loadPendingGitDelta(key, first)).toBeUndefined();
});

it('recovers a lost reply acknowledgment without posting the batch again', async () => {
  const options = setup();
  options.append.mockRejectedValueOnce(new TypeError('offline'));
  await expect(publishCloudMeetingDelta(first, options)).rejects.toThrow('offline');
  options.readForRetry.mockResolvedValue(first.entries);
  const receipt = await publishCloudMeetingDelta(replyBatch(20), options);
  expect(receipt.original).toEqual(first);
  expect(options.append).toHaveBeenCalledTimes(1);
  receipt.saved();
});

it('uses original UUIDs after an uncertain attempt with no matching remote entries', async () => {
  const options = setup();
  options.append.mockRejectedValueOnce(new TypeError('offline'));
  await expect(publishCloudMeetingDelta(first, options)).rejects.toThrow();
  await publishCloudMeetingDelta(replyBatch(20), options);
  expect(options.append.mock.calls.map(([delta]) => delta.entries.map(entry => entry.id))).toEqual([
    first.entries.map(entry => entry.id), first.entries.map(entry => entry.id),
  ]);
});

it('clears a rejected submission and keeps conflicting remote records visible as an error', async () => {
  const options = setup();
  options.append.mockRejectedValueOnce(new GitHubRequestError(403, new Response(null, { status: 403 })));
  await expect(publishCloudMeetingDelta(first, options)).rejects.toThrow();
  expect(loadPendingGitDelta(await gitMeetingPendingKey(archiveKey, first), first)).toBeUndefined();
  options.append.mockRejectedValueOnce(new TypeError('connection lost'));
  await expect(publishCloudMeetingDelta(first, options)).rejects.toThrow();
  options.readForRetry.mockResolvedValue(first.entries.map(row => ({ ...row, speaker: '不同发言人' })));
  await expect(publishCloudMeetingDelta(first, options)).rejects.toThrow('不同内容');
  expect(options.append).toHaveBeenCalledTimes(2);
});
