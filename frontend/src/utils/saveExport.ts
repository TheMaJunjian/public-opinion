import type { ExportData } from '../api/client';

function exportBlob(data: ExportData | Blob): Blob {
  return data instanceof Blob ? data : new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export function downloadExport(data: ExportData | Blob, filename: string): void {
  const url = URL.createObjectURL(exportBlob(data));
  const revoke = URL.revokeObjectURL.bind(URL, url);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  let dispatched = false;
  try {
    document.body.appendChild(anchor);
    anchor.click();
    dispatched = true;
  } finally {
    anchor.remove();
    // Browsers may consume the Blob after click dispatch returns. Revoking in
    // the same task can cancel that read; the dispatch is not a disk-write receipt.
    if (dispatched) window.setTimeout(revoke, 60_000);
    else revoke();
  }
}

async function sameFileContent(first: Blob, second: Blob): Promise<boolean> {
  if (first.size !== second.size) return false;
  // Large Zhihu exports must not be loaded into two more full-size buffers.
  for (let offset = 0; offset < first.size; offset += 1024 * 1024) {
    const [left, right] = await Promise.all([first.slice(offset, offset + 1024 * 1024).arrayBuffer(), second.slice(offset, offset + 1024 * 1024).arrayBuffer()]);
    const a = new Uint8Array(left), b = new Uint8Array(right);
    if (a.some((byte, index) => byte !== b[index])) return false;
  }
  return true;
}

/** The save picker runs on the user's Save click, after the updated archive has passed verification. */
export async function saveUpdatedExport(data: ExportData | Blob, filename: string, original?: Blob): Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?: (options: {
    suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (!picker) { downloadExport(data, filename); return; }
  const handle = await picker.call(window, { suggestedName: filename,
    types: [{ description: '公论导出文件', accept: { 'application/json': ['.json'] } }] });
  if (original) {
    const selected = await handle.getFile();
    if (selected.size && !await sameFileContent(original, selected)) {
      throw new Error('保存位置的文件与刚才合并的文件不同，或已被更新。请重新选择该文件并合并，或另存为新文件。');
    }
  }
  const stream = await handle.createWritable();
  try {
    await stream.write(exportBlob(data));
    await stream.close();
  } catch (error) {
    try { await stream.abort(); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}
