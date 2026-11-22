type DirectoryPicker = (options: { mode: 'readwrite'; id: string }) => Promise<FileSystemDirectoryHandle>;
type PickerWindow = Window & { showDirectoryPicker?: DirectoryPicker };

export function supportsDirectoryPicker(): boolean {
  return typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/** The caller invokes this directly from a user gesture. */
export async function pickWritableDirectory(id: string): Promise<FileSystemDirectoryHandle> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('当前浏览器无法读写所选文件夹。');
  return picker.call(window, { mode: 'readwrite', id });
}
