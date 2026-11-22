import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import OfflineMeetingExchange from '../components/OfflineMeetingExchange';
import { LocalDiscussion } from '../utils/localDiscussion';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { createMeetingStart, exportMeetingDelta, importMeetingDelta } from '../utils/meetingExchange';
import { handoffMeetingDirectory } from '../utils/meetingDirectoryHandoff';

type ExchangeResult = { data: ExportData; added: number; published: number; warnings: string[] };
const { exchange, openDirectory } = vi.hoisted(() => ({
  exchange: vi.fn<(data: ExportData, signal?: AbortSignal) => Promise<ExchangeResult>>(),
  openDirectory: vi.fn<(directory: FileSystemDirectoryHandle) => void>(),
}));
vi.mock('../utils/meetingDirectorySync', () => ({
  MeetingDirectorySync: class {
    constructor(directory: FileSystemDirectoryHandle) { openDirectory(directory); }
    exchange = exchange;
  },
}));

const folder = { name: '共享会议记录' } as FileSystemDirectoryHandle;
const pickDirectory = vi.fn<() => Promise<FileSystemDirectoryHandle>>();
const result = (data: ExportData, added = 0): ExchangeResult => ({ data, added, published: 0, warnings: [] });
const start = () => createMeetingStart(createLocalMessageFile());
async function say(data: ExportData, author: string, text: string) {
  const draft = new LocalDiscussion(data, author);
  await draft.createMessage('root', { content: text });
  let saved: ExportData = data;
  await draft.commit(async next => { saved = next; });
  return saved;
}
const modal = () => fireEvent.click(screen.getByRole('button', { name: /会议交换/ }));
const connect = () => fireEvent.click(screen.getByRole('button', { name: '连接共享文件夹' }));

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('showDirectoryPicker', pickDirectory.mockReset().mockResolvedValue(folder));
  openDirectory.mockReset();
  exchange.mockReset().mockImplementation(async data => result(data));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('only connects the intended viewer to the directory selected on the homepage, once', async () => {
  const data = await start(), other = await start(), save = vi.fn(async () => {});
  handoffMeetingDirectory('target-viewer', data.meeting!.id, folder);
  const toolbar = (source: ExportData, key: string) => <StrictMode>
    <OfflineMeetingExchange data={source} viewerInstanceKey={key} onSave={save} />
  </StrictMode>;
  const view = render(toolbar(other, 'target-viewer'));
  view.rerender(toolbar(data, 'another-viewer'));
  expect(openDirectory).not.toHaveBeenCalled();
  view.unmount();
  const intended = render(toolbar(data, 'target-viewer'));
  await waitFor(() => expect(exchange).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: '会议交换' })).toHaveTextContent('自动');
  intended.unmount();
  render(toolbar(data, 'target-viewer'));
  expect(screen.getByRole('button', { name: '会议交换' })).not.toHaveTextContent('自动');
  expect(pickDirectory).not.toHaveBeenCalled();
});

it('keeps manual exchange available on browsers without a directory picker and after the picker is cancelled', async () => {
  const data = await start(), save = vi.fn(async () => {});
  vi.stubGlobal('showDirectoryPicker', undefined);
  const view = render(<OfflineMeetingExchange data={data} onSave={save} />);
  modal();
  expect(screen.getByRole('button', { name: '导出累计增量' })).toBeEnabled();
  expect(screen.getByLabelText('导入他人的会议增量')).toBeEnabled();
  view.unmount();

  vi.stubGlobal('showDirectoryPicker', pickDirectory);
  pickDirectory.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
  render(<OfflineMeetingExchange data={data} onSave={save} />);
  modal();
  await act(async () => { connect(); });
  expect(openDirectory).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '连接共享文件夹' })).toBeEnabled();
  expect(exchange).not.toHaveBeenCalled();
});

it('syncs locally saved speech with the dialog closed, and stops on disconnect', async () => {
  const data = await start(), local = await say(data, '甲', '第一项意见');
  const later = await say(local, '甲', '停止后只在本机');
  vi.useFakeTimers();
  const save = vi.fn(async () => {});
  const view = render(<OfflineMeetingExchange data={data} onSave={save} />);
  modal();
  await act(async () => { connect(); });
  expect(openDirectory).toHaveBeenCalledWith(folder);
  expect(exchange.mock.calls[0][0]).toBe(data);
  expect(screen.getByRole('dialog')).toHaveTextContent(folder.name);
  fireEvent.click(screen.getByRole('button', { name: '关闭离线会议交换' }));
  await act(async () => { view.rerender(<OfflineMeetingExchange data={local} onSave={save} />); });
  expect(exchange.mock.calls.at(-1)?.[0]).toBe(local);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  modal();
  fireEvent.click(screen.getByRole('button', { name: '停止自动同步' }));
  expect(screen.getByRole('button', { name: '连接共享文件夹' })).toBeEnabled();
  exchange.mockClear();
  view.rerender(<OfflineMeetingExchange data={later} onSave={save} />);
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(exchange).not.toHaveBeenCalled();
  expect(pickDirectory).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});

it('discards an in-flight result when switching to a different meeting', async () => {
  const first = await start(), second = await start(), remote = await say(first, '乙', '只属于第一场');
  let finish!: (output: ExchangeResult) => void;
  exchange.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const save = vi.fn(async () => {});
  const view = render(<OfflineMeetingExchange data={first} onSave={save} />);
  modal(); connect();
  await waitFor(() => expect(exchange).toHaveBeenCalled());
  view.rerender(<OfflineMeetingExchange data={second} onSave={save} />);
  await act(async () => { finish(result(remote, 1)); });
  expect(save).not.toHaveBeenCalled();
  expect(exchange.mock.calls.some(([source]) => source === second)).toBe(false);
  expect(pickDirectory).toHaveBeenCalledTimes(1);
});

it('does not attach the new meeting to a directory chosen for the previous one', async () => {
  const first = await start(), second = await start();
  let choose!: (handle: FileSystemDirectoryHandle) => void;
  pickDirectory.mockImplementationOnce(() => new Promise(resolve => { choose = resolve; }));
  const save = vi.fn(async () => {});
  const view = render(<OfflineMeetingExchange data={first} onSave={save} />);
  modal(); connect();
  view.rerender(<OfflineMeetingExchange data={second} onSave={save} />);
  await act(async () => { choose(folder); });
  expect(openDirectory).not.toHaveBeenCalled();
  expect(exchange).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '连接共享文件夹' })).toBeEnabled();
});

it('receives a remote contribution within half a second while visible and checks immediately when returning', async () => {
  const data = await start(), remote = await say(data, '乙', '从另一台设备发出');
  const save = vi.fn(async () => {});
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  render(<OfflineMeetingExchange data={data} onSave={save} />);
  modal();
  await act(async () => { connect(); });
  exchange.mockClear();
  exchange.mockResolvedValueOnce(result(remote, 1));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(save).toHaveBeenCalledExactlyOnceWith(remote, data);
  visibility.mockReturnValue('hidden');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  exchange.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(exchange).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(pickDirectory).toHaveBeenCalledTimes(1);
});

it('does not overlap a slow directory read or run missed polling ticks immediately after it finishes', async () => {
  const data = await start();
  vi.useFakeTimers();
  let finish!: (output: ExchangeResult) => void;
  exchange.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<OfflineMeetingExchange data={data} onSave={vi.fn(async () => {})} />);
  modal();
  await act(async () => { connect(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(6750); });
  expect(exchange).toHaveBeenCalledTimes(1);
  await act(async () => { finish(result(data)); });
  expect(exchange).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(499); });
  expect(exchange).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(exchange).toHaveBeenCalledTimes(2);
});

it('backs off on directory failure and resumes half-second checks after recovery', async () => {
  const data = await start();
  vi.useFakeTimers();
  exchange.mockRejectedValueOnce(new Error('共享目录不可用'));
  render(<OfflineMeetingExchange data={data} onSave={vi.fn(async () => {})} />);
  modal();
  await act(async () => { connect(); });
  expect(screen.getByRole('alert')).toHaveTextContent('共享目录不可用');
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  expect(exchange).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(exchange).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(exchange).toHaveBeenCalledTimes(3);
});

it('retains a local message committed while reading a remote message from the same meeting', async () => {
  const data = await start(), local = await say(data, '甲', '刚刚在本机发送'), remote = await say(data, '乙', '来自目录');
  const merged = (await importMeetingDelta(local, await exportMeetingDelta(remote))).data;
  let finish!: (output: ExchangeResult) => void;
  exchange.mockImplementation(async current => current === local ? result(merged, 1) : result(current))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let latest = data;
  const saved: ExportData[] = [];
  const save = async (next: ExportData, expected?: ExportData) => {
    if (expected && expected !== latest) throw new Error('本地副本已更新');
    latest = next;
    saved.push(next);
    view.rerender(<OfflineMeetingExchange data={next} onSave={save} />);
  };
  const view = render(<OfflineMeetingExchange data={data} onSave={save} />);
  modal(); connect();
  await waitFor(() => expect(exchange).toHaveBeenCalled());
  latest = local;
  view.rerender(<OfflineMeetingExchange data={local} onSave={save} />);
  await act(async () => { finish(result(remote, 1)); });
  await waitFor(() => expect(saved).toContain(merged));
  expect(saved).not.toContain(remote);
  expect(latest.messages.map(row => row.content)).toEqual(expect.arrayContaining(['刚刚在本机发送', '来自目录']));
});

it('retries a failed local save when the page regains focus', async () => {
  const data = await start(), remote = await say(data, '乙', '已在目录里');
  exchange.mockImplementation(async current => current === remote ? result(current) : result(remote, 1));
  const save = vi.fn<(next: ExportData) => Promise<void>>().mockResolvedValue(undefined);
  save.mockRejectedValueOnce(new Error('本地保存稍后重试'));
  render(<OfflineMeetingExchange data={data} onSave={save} />);
  modal(); connect();
  await screen.findByText(/本地保存稍后重试/);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][0]).toBe(remote);
  expect(pickDirectory).toHaveBeenCalledTimes(1);
});

it('asks to restore write permission only when the participant chooses to sync immediately', async () => {
  const data = await start(), requestPermission = vi.fn(async () => 'granted');
  const permittedFolder = { ...folder, requestPermission };
  pickDirectory.mockResolvedValue(permittedFolder);
  exchange.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
  render(<OfflineMeetingExchange data={data} onSave={vi.fn(async () => {})} />);
  modal(); connect();
  expect(await screen.findByRole('alert')).toHaveTextContent('读写权限');
  expect(requestPermission).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
  await screen.findByText(/上次同步/);
  expect(requestPermission).toHaveBeenCalledExactlyOnceWith({ mode: 'readwrite' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
