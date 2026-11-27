import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ExportData } from '../api/client';
import { exportMeetingDelta, importMeetingDelta, type MeetingEditConfirmation } from '../utils/meetingExchange';
import { GitHubRequestError, type GitMeetingDelta } from '../utils/gitMeetingTransport';
import { gitMeetingBinding, gitMeetingToken, subscribeGitCredentials } from '../utils/gitMeetingSession';
import { publishCloudMeetingDelta } from '../utils/publishCloudMeetingDelta';
import { hasPendingGitDeltas, settlePendingGitDeltas } from '../utils/gitMeetingRetry';
import { hasGitHubHostedAuth } from '../utils/githubHostedAuth';
import { GitMeetingComments, type GitMeetingCommentCursor } from '../utils/gitMeetingComments';
import { getExportCacheReference, loadGitMeetingCheckpoint, saveGitMeetingCheckpoint } from '../utils/exportViewerCache';

type Save = (next: ExportData, expected: ExportData) => Promise<void>;
type Writer = (delta: GitMeetingDelta) => Promise<MeetingEditConfirmation>;
type Status = { failed: boolean; message: string };
const writers = new Map<string, Writer>();

function requireWriteCredential(token: string) {
  if (!token) throw new Error(hasGitHubHostedAuth()
    ? '要发言，请在“会议交换”中用此讨论的 GitHub 成员账号授权，或连接自己的令牌。'
    : '要发言，请先在“会议交换”中连接可读写 Issues 的 GitHub 令牌。');
}

export async function confirmGitMeetingEdit(candidate: ExportData, expected: ExportData): Promise<MeetingEditConfirmation | false> {
  const binding = gitMeetingBinding(expected);
  if (!binding) return false;
  const delta = await exportMeetingDelta(candidate);
  if (delta.meetingId !== expected.meeting?.id || delta.baseHash !== expected.meeting.baseHash) throw new Error('已切换讨论，请重新发送。');
  const known = new Set(expected.messages.map(message => message.id));
  const added = delta.entries.filter(entry => !known.has(entry.id));
  if (!added.length) return false;
  requireWriteCredential(gitMeetingToken(binding.source.repository));
  const write = writers.get(binding.key);
  if (!write) throw new Error('Git 仓库尚未连接，请稍后再发送。');
  return write({ ...delta, entries: added });
}

export function useGitMeetingSync(data: ExportData, onSave: Save) {
  const binding = gitMeetingBinding(data);
  const key = binding?.key, repository = binding?.source.repository, issue = binding?.source.issue;
  const token = useSyncExternalStore(subscribeGitCredentials, () => repository ? gitMeetingToken(repository) : '');
  const latest = useRef({ data, onSave });
  const [report, setReport] = useState<Status | null>(null);
  const refresh = useRef<() => void>(() => {});
  useLayoutEffect(() => { latest.current = { data, onSave }; }, [data, onSave]);
  useLayoutEffect(() => {
    const meeting = latest.current.data.meeting;
    const reference = getExportCacheReference(latest.current.data);
    if (!key || !repository || !issue || !meeting || !reference) { setReport(null); return; }
    const transport = new GitMeetingComments({ repository, issue }, token);
    const stop = new AbortController();
    const { signal } = stop;
    let cursor: GitMeetingCommentCursor | undefined;
    const savedCursor = loadGitMeetingCheckpoint(latest.current.data).catch(() => undefined);
    let reading = false, queued = false, timer: number | undefined;
    function status(message: string, failed = false) {
      if (!signal.aborted) setReport(old => old?.message === message && old.failed === failed ? old : { message, failed });
    }
    const interval = token ? 10_000 : 150_000;
    let retry = interval, retryAfter = 0;
    async function pull() {
      if (signal.aborted || document.hidden) return;
      if (reading) { queued = true; return; }
      if (Date.now() < retryAfter) {
        window.clearTimeout(timer);
        timer = window.setTimeout(pull, retryAfter - Date.now());
        return;
      }
      reading = true;
      window.clearTimeout(timer);
      try {
        const previous = cursor ?? await savedCursor;
        const { delta, checkpoint, hasMore } = await transport.readSince(meeting!, previous, signal);
        signal.throwIfAborted();
        if (delta.entries.length) {
          const current = latest.current;
          const merged = await importMeetingDelta(current.data, delta);
          signal.throwIfAborted();
          if (merged.added) await current.onSave(merged.data, current.data);
          signal.throwIfAborted();
          if (hasPendingGitDeltas()) await settlePendingGitDeltas(key!, await exportMeetingDelta(merged.data));
        }
        signal.throwIfAborted();
        cursor = checkpoint;
        if (JSON.stringify(previous) !== JSON.stringify(cursor)) {
          await saveGitMeetingCheckpoint(reference!, cursor, signal).catch(() => undefined);
        }
        queued ||= hasMore;
        retry = interval;
        status(hasMore ? '正在补读 GitHub 讨论…' : token ? 'GitHub 讨论已连接' : 'GitHub 讨论已连接 · 匿名只读');
      } catch (error) {
        retry = Math.min(15 * 60_000, retry * 2);
        if (error instanceof GitHubRequestError && error.retryAt) {
          retryAfter = error.retryAt;
          retry = Math.max(retry, retryAfter - Date.now());
        }
        status(error instanceof Error ? error.message : '读取 Git 仓库失败。', true);
      } finally {
        reading = false;
        if (!signal.aborted && !document.hidden) {
          timer = window.setTimeout(pull, queued ? 0 : retry);
          queued = false;
        }
      }
    }
    const write: Writer = async delta => {
      requireWriteCredential(token);
      try {
        const receipt = await publishCloudMeetingDelta(delta, {
          provider: 'GitHub',
          archiveKey: key, signal,
          append: batch => transport.append(batch, signal),
          readForRetry: async prior => {
            const ids = new Set(prior.entries.map(row => row.id));
            const local = await exportMeetingDelta(latest.current.data);
            const matching = local.entries.filter(row => ids.has(row.id));
            if (matching.length === ids.size) return matching;
            let previous = cursor ?? await savedCursor;
            for (;;) {
              const update = await transport.readSince(meeting, previous, signal);
              matching.push(...update.delta.entries.filter(row => ids.has(row.id)));
              if (!update.hasMore) return matching;
              previous = update.checkpoint;
            }
          },
        });
        signal.throwIfAborted();
        return receipt;
      } catch (error) {
        status(error instanceof Error ? error.message : 'GitHub 未确认此次发言。', true);
        throw error;
      } finally {
        void pull();
      }
    };
    writers.set(key, write);
    refresh.current = pull;
    status('正在连接 GitHub 讨论…');
    const onVisibility = () => { if (document.hidden) window.clearTimeout(timer); else void pull(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', pull);
    void pull();
    return () => {
      stop.abort();
      if (writers.get(key) === write) writers.delete(key);
      window.clearTimeout(timer);
      refresh.current = () => {};
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', pull);
    };
  }, [key, repository, issue, token]);
  return binding && { source: binding.source, report, authenticated: !!token, syncNow: () => refresh.current() };
}
