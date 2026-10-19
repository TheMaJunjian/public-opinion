import { afterEach, expect, it, vi } from 'vitest';
import { saveUpdatedExport } from '../utils/saveExport';
import type { ExportData } from '../api/client';

const data: ExportData = { formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '公论' }, messages: [], relations: [] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  vi.stubGlobal('showSaveFilePicker', undefined);
  const createObjectURL = vi.fn().mockReturnValue('blob:updated'), revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('公论.json');
    expect(this.href).toBe('blob:updated');
  });
  await saveUpdatedExport(data, '公论.json');
  expect(click).toHaveBeenCalledOnce();
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:updated');
});
