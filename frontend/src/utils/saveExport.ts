import type { ExportData } from '../api/client';

export function downloadExport(data: ExportData, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The save picker runs on the user's Save click, after the updated archive has passed verification. */
export async function saveUpdatedExport(data: ExportData, filename: string): Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?: (options: {
    suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (!picker) { downloadExport(data, filename); return; }
  const handle = await picker.call(window, { suggestedName: filename,
    types: [{ description: '公论导出文件', accept: { 'application/json': ['.json'] } }] });
  const stream = await handle.createWritable();
  try {
    await stream.write(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    await stream.close();
  } catch (error) {
    try { await stream.abort(); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}
