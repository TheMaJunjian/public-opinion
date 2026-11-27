import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { confirmWpsMeetingEdit, useWpsMeetingSync } from '../hooks/useWpsMeetingSync';
import { LocalDiscussion } from '../utils/localDiscussion';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { createMeetingStart, exportMeetingDelta } from '../utils/meetingExchange';
import type { WpsMeetingSdk } from '../utils/wpsMeetingTransport';
import { clearPendingGitDeltas } from '../utils/gitMeetingRetry';

const getSdk = vi.hoisted(() => vi.fn<() => WpsMeetingSdk>());
vi.mock('../utils/wpsMeetingTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/wpsMeetingTransport')>();
  return { ...actual, openWpsMeetingTransport: (options: Parameters<typeof actual.openWpsMeetingTransport>[0]) =>
    actual.openWpsMeetingTransport({ ...options, sdk: getSdk() }) };
});

type Delta = Awaited<ReturnType<typeof exportMeetingDelta>>;
const roomKey = 'gonglun:wps-meeting:v1';

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request outside WPS transport'); }));
  getSdk.mockReset();
});

afterEach(() => {
  cleanup();
  clearPendingGitDeltas();
  sessionStorage.removeItem(roomKey);
  vi.unstubAllGlobals();
});

async function openRoom(url = 'https://www.kdocs.cn/l/testRoom') {
  const start = await createMeetingStart(createLocalMessageFile());
  sessionStorage.setItem(roomKey, JSON.stringify({
    meetingId: start.meeting!.id, baseHash: start.meeting!.baseHash, url,
  }));
  return start;
}

async function speak(source: ExportData, author: string, text: string, replyTo?: string, persist?: (next: ExportData) => Promise<void>) {
  const draft = new LocalDiscussion(source, author);
  const message = await draft.createMessage('root', { content: text });
  if (replyTo) {
    await draft.createRelation('root', { relationType: 'REPLY', sourceMessageId: message.id,
      targetRefs: [{ kind: 'message', messageId: replyTo }] });
  }
  let data = source;
  await draft.commit(async next => {
    if (persist) await persist(next);
    data = next;
  });
  return { data, id: message.id };
}

function sharedTable(initial: Delta[] = []) {
  const rows = initial.map(delta => ({ id: crypto.randomUUID(), value: JSON.stringify(delta) }));
  const writes: Delta[] = [];
  const countRows = vi.fn(() => rows.length);
  const readBack = vi.fn((value: string) => [[value]]);
  const range = Object.assign((indexes: number[]) => ({ Value: indexes.map(i => [rows[i - 1].value]) }), {
    Count: 0,
    Add: (_before: null, after: number | null) => {
      const row = { id: crypto.randomUUID(), value: '' };
      rows.splice(after ?? 0, 0, row);
      return {
        get Value() { return readBack(row.value); },
        set Value(next: string[][]) {
          row.value = next[0][0];
          writes.push(JSON.parse(row.value) as Delta);
        },
      };
    },
  });
  Object.defineProperty(range, 'Count', { get: countRows });
  const view = { Id: 'discussion-view', RecordRange: range, Records: { Item: (i: number) => ({ Id: rows[i - 1].id }) } };
  getSdk.mockReturnValue({ config: () => ({ ready: async () => {}, destroy: () => {}, Application: { ActiveView: view } }) });
  return { writes, countRows, readBack };
}

function mountParticipant(initial: ExportData) {
  return renderHook(() => {
    const [data, setData] = useState(initial);
    const save = useCallback(async (next: ExportData) => { setData(next); }, []);
    const status = useWpsMeetingSync(data, save);
    return { data, save, status };
  });
}

it('merges remote WPS records once and sends a local reply without republishing its parent', async () => {
  const start = await openRoom();
  const original = await speak(start, '甲', '先看这段材料');
  const remote = await exportMeetingDelta(original.data);
  const table = sharedTable([remote, remote]);
  const participant = mountParticipant(start);

  await waitFor(() => expect(participant.result.current.data.messages.map(m => m.id)).toEqual([original.id]));
  expect(table.writes).toHaveLength(0);
  const before = participant.result.current.data;
  const reply = await act(async () => speak(before, '乙', '看过了，这是我的回复', original.id, async next => {
    await confirmWpsMeetingEdit(next, before);
    await participant.result.current.save(next);
  }));
  await waitFor(() => expect(table.writes.length).toBeGreaterThan(0));
  const exported = await exportMeetingDelta(reply.data);
  const newEntries = exported.entries.filter(entry => entry.id !== original.id);
  expect(newEntries).toHaveLength(2);
  expect(table.writes.flatMap(delta => delta.entries)).toEqual(expect.arrayContaining(newEntries));
  expect(table.writes.flatMap(delta => delta.entries)).toHaveLength(2);

  participant.unmount();
  const other = mountParticipant(start);
  await waitFor(() => expect(other.result.current.data.relations).toEqual([
    expect.objectContaining({ relationType: 'REPLY', sourceMessageId: reply.id,
      targetRefs: [expect.objectContaining({ messageId: original.id })] }),
  ]));
  expect(other.result.current.data.messages.find(m => m.id === reply.id)).toMatchObject({ author: '乙', content: '看过了，这是我的回复' });
  const writes = table.writes.length;
  const reads = table.countRows.mock.calls.length;
  act(() => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(table.countRows.mock.calls.length).toBeGreaterThan(reads));
  expect(table.writes).toHaveLength(writes);
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps independently authored concurrent writes and does not publish unrelated cached speech', async () => {
  const start = await openRoom();
  const cached = await speak(start, '历史署名', '已经存在本地的旧记录');
  const table = sharedTable();
  const participant = mountParticipant(cached.data);
  await waitFor(() => expect(table.countRows.mock.calls.length).toBeGreaterThan(1));
  expect(table.writes).toHaveLength(0);
  const confirm = async (next: ExportData) => { expect(await confirmWpsMeetingEdit(next, cached.data)).toMatchObject({ saved: expect.any(Function) }); };
  const [left, right] = await act(() => Promise.all([
    speak(cached.data, '甲', '甲的新增发言', undefined, confirm),
    speak(cached.data, '乙', '乙的新增发言', undefined, confirm),
  ]));
  participant.unmount();
  const fresh = mountParticipant(start);
  act(() => { window.dispatchEvent(new Event('online')); });
  const bothIds = [left.id, right.id].sort();
  await waitFor(() => {
    expect(fresh.result.current.data.messages.map(m => m.id).sort()).toEqual(bothIds);
  });
  expect(table.writes.flatMap(delta => delta.entries).map(entry => entry.id).sort()).toEqual(bothIds);
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps a rejected WPS write out of the local discussion', async () => {
  const start = await openRoom('https://www.kdocs.cn/l/testRoom?readonly');
  const table = sharedTable();
  const participant = mountParticipant(start);
  await waitFor(() => expect(table.countRows.mock.calls.length).toBeGreaterThan(1));
  const saveLocally = vi.fn(participant.result.current.save);
  await act(async () => {
    await expect(speak(start, '甲', '这条发言没有写入权限', undefined, async next => {
      await confirmWpsMeetingEdit(next, start);
      await saveLocally(next);
    })).rejects.toThrow();
  });
  expect(saveLocally).not.toHaveBeenCalled();
  expect(table.writes).toHaveLength(0);
  expect(participant.result.current.data.messages).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([false, true])('reuses the original edit when retrying a lost acknowledgement (reopen=%s)', async reopen => {
  const start = await openRoom();
  const table = sharedTable();
  let participant = mountParticipant(start);
  await waitFor(() => expect(participant.result.current.status?.message).toBe('WPS 会议已连接'));
  table.readBack.mockImplementationOnce(() => { throw new Error('WPS 回读超时'); });
  await expect(speak(start, '甲', '同样的发言', undefined, async next => {
    await confirmWpsMeetingEdit(next, start);
  })).rejects.toThrow('WPS 回读超时');
  expect(table.writes).toHaveLength(1);
  const original = table.writes[0].entries[0];
  if (reopen) {
    participant.unmount();
    participant = mountParticipant(start);
    await waitFor(() => expect(participant.result.current.data.messages[0]?.id).toBe(original.id));
  }
  const baseline = participant.result.current.data;
  const retried = await speak(baseline, '甲', '同样的发言', undefined, async next => {
    const receipt = await confirmWpsMeetingEdit(next, baseline);
    if (!receipt) throw new Error('Missing WPS confirmation');
    expect(receipt.original?.entries).toEqual([original]);
    receipt.saved();
  });
  expect(retried.id).not.toBe(original.id);
  expect(table.writes).toHaveLength(1);
  await speak(baseline, '甲', '同样的发言', undefined, async next => {
    await confirmWpsMeetingEdit(next, baseline);
  });
  expect(table.writes).toHaveLength(2);
  expect(table.writes[1].entries[0].id).not.toBe(original.id);
});
