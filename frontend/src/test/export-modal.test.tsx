import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ExportModal from '../components/ExportModal';
import { startArchiveExport } from '../utils/exportWorker';
import { downloadExport, saveUpdatedExport } from '../utils/saveExport';
import type { PreparedExport } from '../utils/exportTask';
import { conversionFailure } from '@gonglun/core';

vi.mock('../utils/exportWorker', () => ({ startArchiveExport: vi.fn() }));
vi.mock('../utils/saveExport', () => ({ downloadExport: vi.fn(), saveUpdatedExport: vi.fn() }));
const props = { onClose: vi.fn(), scopeMessageId: 'root', filename: '公论.json', view: { username: null, mode: 'list' as const,
  messageFilter: { hideJoin: false, hideSettlement: false }, homeFilter: null, cleanFilters: [], classificationId: null } };
const prepared: PreparedExport = { blob: new Blob(['{}']), added: 2, messageCount: 3 };
const cancel = vi.fn();
const choose = () => fireEvent.change(screen.getByLabelText('选择要更新的导出文件（可选）'), {
  target: { files: [new File(['{}'], '旧文件.json')] },
});
beforeEach(() => {
  vi.mocked(startArchiveExport).mockReturnValue({ result: Promise.resolve(prepared), cancel });
  vi.mocked(saveUpdatedExport).mockResolvedValue();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('opens immediately without any export work; no selected file means a full export after confirmation', async () => {
  render(<ExportModal {...props} />);
  expect(screen.getByRole('dialog', { name: '导出' })).toBeVisible();
  expect(startArchiveExport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '导出文件' }));
  expect(screen.getByRole('status')).toHaveTextContent('正在准备');
  await waitFor(() => expect(downloadExport).toHaveBeenCalledWith(prepared.blob, '公论.json'));
  expect(startArchiveExport).toHaveBeenCalledWith(expect.objectContaining({ kind: 'full', scopeMessageId: 'root', view: props.view }), expect.any(Function));
  expect(props.onClose).toHaveBeenCalledOnce();
});

it('selecting an old file chooses update mode and waits for the Save click before writing', async () => {
  render(<ExportModal {...props} />);
  choose();
  expect(startArchiveExport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '更新文件' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已补充 2 次变更，现有 3 条消息'));
  expect(startArchiveExport).toHaveBeenCalledWith({ kind: 'update', file: expect.any(File) }, expect.any(Function));
  expect(saveUpdatedExport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存更新文件' }));
  await waitFor(() => expect(saveUpdatedExport).toHaveBeenCalledWith(prepared.blob, '旧文件.json'));
});

it('allows removing a selected file to return to a full export', () => {
  render(<ExportModal {...props} />);
  choose();
  fireEvent.click(screen.getByRole('button', { name: '移除所选文件，改为完整导出' }));
  expect(screen.getByRole('button', { name: '导出文件' })).toBeEnabled();
  expect(startArchiveExport).not.toHaveBeenCalled();
});

it('does not write any file when the service rejects an update', async () => {
  vi.mocked(startArchiveExport).mockImplementation(() => ({ result: Promise.reject(new Error('旧文件来自另一份公论数据，请回到原服务更新')), cancel }));
  render(<ExportModal {...props} />);
  choose(); fireEvent.click(screen.getByRole('button', { name: '更新文件' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('请回到原服务更新');
  expect(saveUpdatedExport).not.toHaveBeenCalled();
  expect(downloadExport).not.toHaveBeenCalled();
});

it('displays the original failure report after a worker conversion fails and saves nothing',async()=>{
  const failure=conversionFailure(new Error('执行记录缺失'),'unchanged','本次转换已取消，原 JSON 文件和缓存均未修改。');
  vi.mocked(startArchiveExport).mockImplementation(()=>({result:Promise.reject(failure),cancel}));
  render(<ExportModal {...props}/>);
  choose();fireEvent.click(screen.getByRole('button',{name:'更新文件'}));
  const alert=await screen.findByRole('alert');
  expect(alert.textContent).toContain(failure.message);
  expect(alert.textContent!.match(/失败时间：/g)).toHaveLength(1);
  expect(alert).toHaveTextContent('失败原因：执行记录缺失');
  expect(alert).toHaveTextContent('回滚结果：本次转换已取消');
  expect(saveUpdatedExport).not.toHaveBeenCalled();
  expect(downloadExport).not.toHaveBeenCalled();
});

it('terminates work on close and ignores a result arriving after unmount', async () => {
  let finish!: (value: PreparedExport) => void;
  vi.mocked(startArchiveExport).mockReturnValue({ result: new Promise(resolve => { finish = resolve; }), cancel });
  const { unmount } = render(<ExportModal {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '导出文件' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(cancel).toHaveBeenCalled();
  unmount();
  await act(async () => finish(prepared));
  expect(downloadExport).not.toHaveBeenCalled();
});

it('keeps a verified update ready when the user cancels the save dialog', async () => {
  vi.mocked(saveUpdatedExport).mockRejectedValue(new DOMException('取消', 'AbortError'));
  render(<ExportModal {...props} />);
  choose(); fireEvent.click(screen.getByRole('button', { name: '更新文件' }));
  fireEvent.click(await screen.findByRole('button', { name: '保存更新文件' }));
  await waitFor(() => expect(saveUpdatedExport).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole('button', { name: '保存更新文件' })).toBeEnabled());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(props.onClose).not.toHaveBeenCalled();
});
