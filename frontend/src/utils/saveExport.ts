import type { ExportData } from '../api/client';

function exportBlob(data: ExportData | Blob): Blob {
  return data instanceof Blob ? data : new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export function downloadExport(data: ExportData | Blob, filename: string): void {
  const url = URL.createObjectURL(exportBlob(data));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The save picker runs on the user's Save click, after the updated archive has passed verification. */
export async function saveUpdatedExport(data: ExportData | Blob, filename: string): Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?: (options: {
    suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (!picker) { downloadExport(data, filename); return; }
  const handle = await picker.call(window, { suggestedName: filename,
    types: [{ description: '公论导出文件', accept: { 'application/json': ['.json'] } }] });
  const stream = await handle.createWritable();
  try {
    await stream.write(exportBlob(data));
    await stream.close();
  } catch (error) {
    try { await stream.abort(); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}
