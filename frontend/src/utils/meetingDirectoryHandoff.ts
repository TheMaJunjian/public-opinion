// A directory permission belongs to the tab that picked it. Browser history
// stores the viewer key; it never stores the native handle.
let pending: { viewerKey: string; meetingId: string; directory: FileSystemDirectoryHandle } | undefined;

export function handoffMeetingDirectory(viewerKey: string, meetingId: string, directory: FileSystemDirectoryHandle) {
  pending = { viewerKey, meetingId, directory };
}

export function takeMeetingDirectory(viewerKey: unknown, meetingId: string | undefined) {
  if (!pending || pending.viewerKey !== viewerKey || pending.meetingId !== meetingId) return null;
  const { directory } = pending;
  pending = undefined;
  return directory;
}
