import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import MeetingFolderDialog from '../components/MeetingFolderDialog';
import { createMeetingStart } from '../utils/meetingExchange';
import { createFolderMeeting, listFolderMeetings, openFolderMeeting, type FolderMeeting } from '../utils/meetingFolder';
import { createLocalMessageFile } from '../utils/localMessageFile';

vi.mock('../utils/meetingFolder', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/meetingFolder')>(),
  createFolderMeeting: vi.fn(), listFolderMeetings: vi.fn(), openFolderMeeting: vi.fn(),
}));
const root = { name: '局域网会议目录' } as FileSystemDirectoryHandle;
const pick = vi.fn<() => Promise<FileSystemDirectoryHandle>>();
const open = vi.fn<(data: ExportData, handle: FileSystemDirectoryHandle, signal?: AbortSignal) => Promise<void>>();
const choose = () => fireEvent.click(screen.getByRole('button', { name: '共享文件夹会议' }));
async function meeting(title: string) {
  const data = await createMeetingStart(createLocalMessageFile());
  data.scope.title = title;
  const info: FolderMeeting = { id: data.meeting!.id, baseHash: data.meeting!.baseHash, createdAt: data.exportedAt, title };
  return { data, info };
}
beforeEach(async () => {
  vi.resetAllMocks();
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('showDirectoryPicker', pick.mockResolvedValue(root));
  vi.mocked(listFolderMeetings).mockResolvedValue([]);
  open.mockResolvedValue();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lets the participant choose again if the browser denies access', async () => {
  pick.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
  render(<MeetingFolderDialog onOpen={open} />);
  choose();
  expect(await screen.findByRole('alert')).toHaveTextContent('没有读写权限');
  fireEvent.click(screen.getByRole('button', { name: '重新选择共享文件夹' }));
  expect(await screen.findByText('此文件夹还没有会议。')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(pick).toHaveBeenCalledTimes(2);
});

it('creates a named meeting in the chosen folder and hands the same folder to the workbench', async () => {
  const { data } = await meeting('项目晨会');
  vi.mocked(createFolderMeeting).mockResolvedValue(data);
  render(<MeetingFolderDialog onOpen={open} />);
  choose();
  const title = await screen.findByLabelText('会议名称');
  fireEvent.change(title, { target: { value: '项目晨会' } });
  fireEvent.click(screen.getByRole('button', { name: '创建并进入' }));
  await waitFor(() => expect(open.mock.calls).toEqual([[data, root, expect.any(AbortSignal)]]));
  expect(vi.mocked(createFolderMeeting).mock.calls[0]?.slice(0, 2)).toEqual([root, '项目晨会']);
  expect(pick).toHaveBeenCalledTimes(1);
  expect(openFolderMeeting).not.toHaveBeenCalled();
});

it('lets the host re-enter a published meeting after a local opening failure without creating a second one', async () => {
  const { data } = await meeting('晨会');
  vi.mocked(createFolderMeeting).mockResolvedValue(data);
  vi.mocked(openFolderMeeting).mockResolvedValue(data);
  open.mockRejectedValueOnce(new Error('本地文件暂不可读'));
  render(<MeetingFolderDialog onOpen={open} />);
  choose();
  fireEvent.change(await screen.findByLabelText('会议名称'), { target: { value: '晨会' } });
  fireEvent.click(screen.getByRole('button', { name: '创建并进入' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('本地文件暂不可读');
  fireEvent.click(screen.getByRole('button', { name: '晨会' }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(open.mock.calls[1]).toEqual([data, root, expect.any(AbortSignal)]);
  expect(createFolderMeeting).toHaveBeenCalledTimes(1);
  expect(pick).toHaveBeenCalledTimes(1);
});

it('discovers another computer’s meeting on refresh, opens the selected title and retains the folder for sync', async () => {
  const { data, info } = await meeting('讨论计划');
  const { info: other } = await meeting('另一个会议');
  vi.mocked(listFolderMeetings).mockResolvedValueOnce([other]).mockResolvedValue([info, other]);
  vi.mocked(openFolderMeeting).mockRejectedValueOnce(new Error('会议起始文件暂不可读')).mockResolvedValue(data);
  render(<MeetingFolderDialog onOpen={open} />);
  choose();
  await screen.findByRole('button', { name: other.title });
  fireEvent.click(screen.getByRole('button', { name: '刷新会议列表' }));
  fireEvent.click(await screen.findByRole('button', { name: info.title }));
  expect(await screen.findByRole('alert')).toHaveTextContent('会议起始文件暂不可读');
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: info.title }));
  await waitFor(() => expect(open.mock.calls).toEqual([[data, root, expect.any(AbortSignal)]]));
  expect(vi.mocked(openFolderMeeting).mock.calls.every(call => call[0] === root && call[1] === info)).toBe(true);
  expect(pick).toHaveBeenCalledTimes(1);
  expect(createFolderMeeting).not.toHaveBeenCalled();
});

it('does not open a stale meeting when the caller leaves during an outstanding read', async () => {
  const { data, info } = await meeting('已离开的会议');
  vi.mocked(listFolderMeetings).mockResolvedValue([info]);
  let finish!: (data: ExportData) => void;
  vi.mocked(openFolderMeeting).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<MeetingFolderDialog onOpen={open} />);
  choose();
  fireEvent.click(await screen.findByRole('button', { name: info.title }));
  await waitFor(() => expect(openFolderMeeting).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => { finish(data); });
  expect(open).not.toHaveBeenCalled();
});
