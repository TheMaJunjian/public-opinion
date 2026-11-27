import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import type { PropsWithChildren } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { useGitMeetingSync } from '../hooks/useGitMeetingSync';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import { forgetCloudMeetingArchives, getExportCacheReference, loadGitMeetingCheckpoint, loadReferencedExport, openFolderMeetingExport, saveGitMeetingCheckpoint } from '../utils/exportViewerCache';
import { gitMeetingBinding, clearGitMeetingTokens, setGitMeetingToken } from '../utils/gitMeetingSession';
import { GitMeetingComments, gitMeetingIssueUrl, type GitMeetingCommentCursor } from '../utils/gitMeetingComments';
import type { GitMeetingDelta } from '../utils/gitMeetingTransport';
import { LocalDiscussion } from '../utils/localDiscussion';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { createMeetingStart, exportMeetingDelta } from '../utils/meetingExchange';

const source = { repository: 'https://github.com/group/discussions', issue: 17 };
beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected HTTP request'); }));
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => {
  cleanup(); clearGitMeetingTokens();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function speak(room: ExportData, content: string, replyTo?: string): Promise<ExportData> {
  const draft = new LocalDiscussion(room, '参与者');
  const message = await draft.createMessage('root', { content });
  if (replyTo) await draft.createRelation('root', { relationType: 'REPLY', sourceMessageId: message.id,
    targetRefs: [{ kind: 'message', messageId: replyTo }] });
  let result!: ExportData;
  await draft.commit(async value => { result = value; });
  return result;
}

function renderGitWorkbench(room: ExportData) {
  const wrapper = ({ children }: PropsWithChildren) =>
    <MemoryRouter initialEntries={[{ pathname: '/viewer', state: { exportData: room } }]}>{children}</MemoryRouter>;
  return renderHook(() => {
    const view = useWorkbenchData({ user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'list' });
    const git = useGitMeetingSync(view.loadedExport ?? { ...room, meeting: undefined }, view.persistMeetingExport);
    return { view, git };
  }, { wrapper });
}

function issueStream(room: ExportData, pageSize = 100) {
  const records: GitMeetingDelta['entries'][] = [];
  const read = vi.spyOn(GitMeetingComments.prototype, 'readSince').mockImplementation(async (meeting, stored) => {
    const previous = stored as GitMeetingCommentCursor | undefined;
    const from = previous?.mode === 'graphql' ? Number(previous.after) : 0;
    const delta = { ...await exportMeetingDelta(room), entries: records.slice(from, from + pageSize).flat() };
    const checkpoint: GitMeetingCommentCursor = { mode: 'graphql', source: gitMeetingIssueUrl(source),
      meetingId: meeting.id, after: records.length ? String(Math.min(from + pageSize, records.length)) : null };
    return { delta, checkpoint, hasMore: from + pageSize < records.length };
  });
  const append = vi.spyOn(GitMeetingComments.prototype, 'append').mockImplementation(async delta => {
    records.push(delta.entries);
  });
  return { records, read, append };
}

it('opens isolated Issues and persists only confirmed comments, including both records for a reply', async () => {
  const start = await createMeetingStart(createLocalMessageFile());
  const other = await openFolderMeetingExport(structuredClone(start), { ...source, issue: 18 });
  const room = await openFolderMeetingExport(start, source);
  const remote = issueStream(room);
  const cached = async (data = room) => await loadReferencedExport(getExportCacheReference(data)!) as ExportData;
  const { result } = renderGitWorkbench(room);
  await waitFor(() => expect(result.current.view.loadedExport?.meeting).toBeDefined());
  const outgoing = await speak(room, '第一次发言');
  const send = () => result.current.view.persistMeetingExport(outgoing, room, true);
  await act(async () => { await expect(send()).rejects.toThrow('令牌'); });
  expect(remote.append).not.toHaveBeenCalled();
  act(() => setGitMeetingToken(source.repository, 'test-credential'));
  remote.append.mockRejectedValueOnce(new Error('接口拒绝'));
  await act(async () => { await expect(send()).rejects.toThrow('接口拒绝'); });
  expect((await cached()).messages).toHaveLength(0);
  await act(async () => { await send(); });
  const baseline = await cached();
  expect(baseline.messages.map(m => m.content)).toEqual(['第一次发言']);
  const reply = await speak(baseline, '已收到', baseline.messages[0].id);
  await act(async () => { await result.current.view.persistMeetingExport(reply, baseline, true); });
  expect(remote.records.map(rows => rows.map(row => row.type))).toEqual([['text'], ['text', 'reply']]);
  expect((await cached()).relations.some(r => r.id === remote.records[1][1].id)).toBe(true);
  expect((await cached(other)).messages).toHaveLength(0);
  expect(gitMeetingBinding(room)?.key).not.toEqual(gitMeetingBinding(other)?.key);
  expect(gitMeetingBinding(room)?.key).not.toContain('test-credential');
});

it('resumes from the last saved comment on reconnect and reopen, and clears the cursor on logout', async () => {
  const room = await openFolderMeetingExport(await createMeetingStart(createLocalMessageFile()), source);
  const reference = getExportCacheReference(room)!;
  const remote = issueStream(room);
  setGitMeetingToken(source.repository, 'fixture');
  remote.records.push((await exportMeetingDelta(await speak(room, '先收到的发言'))).entries);
  const first = renderGitWorkbench(room);
  const cached = async () => await loadReferencedExport(reference) as ExportData;
  await waitFor(async () => expect(await loadGitMeetingCheckpoint(await cached())).toMatchObject({ after: '1' }));
  first.unmount();
  const saved = await cached();
  expect(await loadGitMeetingCheckpoint(room)).toBeUndefined();
  const restored = renderGitWorkbench(saved);
  await waitFor(() => expect(restored.result.current.git?.report?.message).toContain('已连接'));
  expect(remote.read.mock.lastCall?.[1]).toMatchObject({ after: '1' });
  remote.records.push((await exportMeetingDelta(await speak(room, '离线期间新增'))).entries);
  fireEvent(window, new Event('online'));
  await waitFor(async () => expect(await loadGitMeetingCheckpoint(await cached())).toMatchObject({ after: '2' }));
  expect(remote.read.mock.lastCall?.[1]).toMatchObject({ after: '1' });
  expect((await cached()).messages.map(m => m.content)).toEqual(['先收到的发言', '离线期间新增']);
  restored.unmount();
  const checkpoint = await loadGitMeetingCheckpoint(await cached()) as GitMeetingCommentCursor;
  await forgetCloudMeetingArchives();
  await saveGitMeetingCheckpoint(reference, checkpoint, new AbortController().signal);
  expect(await loadGitMeetingCheckpoint(saved)).toBeUndefined();
});

it('applies each page before advancing the cursor to the next reply', async () => {
  const room = await openFolderMeetingExport(await createMeetingStart(createLocalMessageFile()), source);
  const remote = issueStream(room, 1);
  const message = await speak(room, '第一页');
  remote.records.push((await exportMeetingDelta(message)).entries);
  const reply = await speak(message, '第二页的回复', message.messages[0].id);
  remote.records.push((await exportMeetingDelta(reply)).entries.filter(row => row.id !== message.messages[0].id));
  setGitMeetingToken(source.repository, 'fixture');
  renderGitWorkbench(room);
  const reference = getExportCacheReference(room)!;
  await waitFor(async () => {
    const saved = await loadReferencedExport(reference) as ExportData;
    expect(await loadGitMeetingCheckpoint(saved)).toMatchObject({ after: '2' });
    expect(saved.messages).toHaveLength(3);
    expect(saved.relations).toHaveLength(1);
  });
  expect(remote.read.mock.calls[1][1]).toMatchObject({ after: '1' });
});
