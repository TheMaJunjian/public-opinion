import { afterEach, expect, it, vi } from 'vitest';
import { downloadExport, saveUpdatedExport } from '../utils/saveExport';
import type { ExportData } from '../api/client';

const data: ExportData = { formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '公论' }, messages: [], relations: [] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('writes the worker Blob directly without serializing the archive again', async () => {
  const blob = new Blob(['{"format":"gonglun-2"}'], { type: 'application/json' });
  const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal('showSaveFilePicker', vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(stream) }));
  await saveUpdatedExport(blob, '公论.json');
  expect(stream.write).toHaveBeenCalledWith(blob);
});

it('writes the complete JSON to the selected file and commits only after the write succeeds', async () => {
  const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn() };
  const picker = vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(stream) });
  vi.stubGlobal('showSaveFilePicker', picker);
  await saveUpdatedExport(data, '公论.json');
  expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: '公论.json' }));
  const blob = stream.write.mock.calls[0][0] as Blob;
  const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
  expect(JSON.parse(text)).toEqual(data);
  expect(stream.close).toHaveBeenCalledOnce();
  expect(stream.abort).not.toHaveBeenCalled();
});

it('aborts a failed write instead of committing a partial file', async () => {
  const stream = { write: vi.fn().mockRejectedValue(new Error('磁盘已满')), close: vi.fn(), abort: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal('showSaveFilePicker', vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(stream) }));
  await expect(saveUpdatedExport(data, '公论.json')).rejects.toThrow('磁盘已满');
  expect(stream.close).not.toHaveBeenCalled();
  expect(stream.abort).toHaveBeenCalledOnce();
});

it('downloads a complete updated file when saving to a chosen path is unavailable', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('showSaveFilePicker', undefined);
  const createObjectURL = vi.fn().mockReturnValue('blob:updated'), revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('公论.json');
    expect(this.href).toBe('blob:updated');
    expect(this.isConnected).toBe(true);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
  await saveUpdatedExport(data, '公论.json');
  expect(click).toHaveBeenCalledOnce();
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(document.querySelector('a[download="公论.json"]')).toBeNull();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:updated');
});

it('cleans up and reports a rejected download dispatch so it can be retried', () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn().mockReturnValueOnce('blob:failed').mockReturnValueOnce('blob:retry');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementationOnce(() => { throw new Error('下载被阻止'); }).mockImplementation(() => undefined);
  expect(() => downloadExport(data, '公论.json')).toThrow('下载被阻止');
  expect(document.querySelector('a[download]')).toBeNull();
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:failed');
  expect(() => downloadExport(data, '公论.json')).not.toThrow();
  expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_000);
  expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:retry');
});

async function guardedSave(original: string, selected: string, output = '{}') {
  const { Blob: NativeBlob } = await vi.importActual<{ Blob: typeof Blob }>('node:buffer');
  const stream = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
  const handle = { getFile: vi.fn().mockResolvedValue(new NativeBlob([selected])), createWritable: vi.fn().mockResolvedValue(stream) };
  vi.stubGlobal('showSaveFilePicker', vi.fn().mockResolvedValue(handle));
  return { stream, handle, save: () => saveUpdatedExport(new Blob([output]), '知乎阅览.json', new NativeBlob([original]) as unknown as Blob) };
}

it('updates the verified original file and permits saving a new file', async () => {
  const existing = await guardedSave('旧阅览文件', '旧阅览文件');
  await existing.save();
  expect(existing.stream.close).toHaveBeenCalledOnce();
  const fresh = await guardedSave('旧阅览文件', '');
  await fresh.save();
  expect(fresh.stream.close).toHaveBeenCalledOnce();
});

it('leaves a different or externally updated destination untouched', async () => {
  for (const selected of ['其它文件', '改动内容']) {
    const run = await guardedSave('原有内容', selected);
    await expect(run.save()).rejects.toThrow('与刚才合并的文件不同');
    expect(run.handle.createWritable).not.toHaveBeenCalled();
  }
});
