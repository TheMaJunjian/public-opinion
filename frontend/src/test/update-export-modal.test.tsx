import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import UpdateExportModal from '../components/UpdateExportModal';
import { api } from '../api';
import { saveUpdatedExport } from '../utils/saveExport';
import type { ExportUpdateData } from '../api/client';

vi.mock('../api', () => ({ api: { updateExportMessages: vi.fn() } }));
vi.mock('../utils/saveExport', () => ({ saveUpdatedExport: vi.fn() }));

const archive = { format: 'gonglun-2', formatVersion: 2, regionId: 'local', ledgerId: 'local', programVersion: '2.0.0', exportedAt: '',
  scope: { messageId: null, title: '公论' }, messages: [], relations: [], changes: [] };
const choose = (filename = '公论.json') => fireEvent.change(screen.getByLabelText('选择要更新的导出文件'), {
  target: { files: [new File([JSON.stringify(archive)], filename, { type: 'application/json' })] },
});

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(api.updateExportMessages).mockImplementation(async (_parent, base) => ({ ...archive, format: 'gonglun-2-update', base,
    journal: { version: 1, entryCount: 0, lastSequence: 0 } } as ExportUpdateData));
  vi.mocked(saveUpdatedExport).mockResolvedValue();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('loads only the missing records and waits for the Save click before writing a complete archive', async () => {
  const close = vi.fn();
  render(<UpdateExportModal onClose={close} />);
  expect(screen.getByRole('button', { name: '保存更新文件' })).toBeDisabled();
  choose();
  expect(await screen.findByRole('status')).toHaveTextContent('正在校验');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('完整性及资金守恒校验通过'));
  expect(api.updateExportMessages).toHaveBeenCalledWith('root', expect.objectContaining({ sequence: 0, entryCount: 0, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  expect(saveUpdatedExport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存更新文件' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(saveUpdatedExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'gonglun-2', changes: [], journal: { version: 1, entryCount: 0, lastSequence: 0 } }), '公论.json');
});

it('keeps the original file untouched when its source does not match the service', async () => {
  vi.mocked(api.updateExportMessages).mockRejectedValue(new Error('旧文件来自另一份公论数据，请回到原服务更新'));
  render(<UpdateExportModal onClose={vi.fn()} />);
  choose();
  expect(await screen.findByRole('alert')).toHaveTextContent('请回到原服务更新');
  expect(saveUpdatedExport).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '保存更新文件' })).toBeDisabled();
});

it('does not replace a newer file selection with an older pending response', async () => {
  let finish!: (value: ExportUpdateData) => void;
  const defaultUpdate = vi.mocked(api.updateExportMessages).getMockImplementation()!;
  let firstBase: Parameters<typeof api.updateExportMessages>[1];
  vi.mocked(api.updateExportMessages).mockImplementationOnce(async (_parent, base) => {
    firstBase = base;
    return new Promise(resolve => { finish = resolve; });
  });
  render(<UpdateExportModal onClose={vi.fn()} />);
  choose('第一份.json');
  await waitFor(() => expect(api.updateExportMessages).toHaveBeenCalledOnce());
  // Closing the dialog must invalidate the in-flight network response.
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  cleanup();
  render(<UpdateExportModal onClose={vi.fn()} />);
  choose('第二份.json');
  await waitFor(() => expect(screen.getByRole('button', { name: '保存更新文件' })).toBeEnabled());
  await act(async () => finish(await defaultUpdate('root', firstBase!)));
  fireEvent.click(screen.getByRole('button', { name: '保存更新文件' }));
  await waitFor(() => expect(saveUpdatedExport).toHaveBeenCalledWith(expect.anything(), '第二份.json'));
});

it('keeps a verified update ready when the user cancels the save dialog', async () => {
  vi.mocked(saveUpdatedExport).mockRejectedValue(new DOMException('取消', 'AbortError'));
  const close = vi.fn();
  render(<UpdateExportModal onClose={close} />);
  choose();
  await waitFor(() => expect(screen.getByRole('button', { name: '保存更新文件' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '保存更新文件' }));
  await waitFor(() => expect(saveUpdatedExport).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole('button', { name: '保存更新文件' })).toBeEnabled());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(close).not.toHaveBeenCalled();
});
