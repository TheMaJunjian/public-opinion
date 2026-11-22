import type { ExportData } from '../api/client';
import { ArchiveConflictError, getExportCacheReference, loadReferencedExport } from './exportViewerCache';
import { exportMeetingDelta, importMeetingDelta } from './meetingExchange';

/** Rebase an append-only edit on the latest local copy. The actual write still
 * compares the IndexedDB revision, including when two browser tabs race. */
export async function persistMeetingRevision(
  candidate: ExportData, expected: ExportData, active: ExportData, localEdit: boolean,
  commit: (next: ExportData, baseline: ExportData) => Promise<void>,
) {
  const reference = getExportCacheReference(active);
  const meeting = expected.meeting;
  if (!meeting || [active, candidate].some(data => data.meeting?.id !== meeting.id || data.meeting.baseHash !== meeting.baseHash)
    || (reference && getExportCacheReference(expected)?.viewCacheId !== reference.viewCacheId)) {
    throw new Error('已切换阅览文件，请在当前会议重新同步。');
  }
  let baseline = active;
  let delta: Awaited<ReturnType<typeof exportMeetingDelta>> | undefined;
  for (let attempt = 0; ; attempt++) {
    let next = candidate;
    if (baseline !== expected) {
      delta ??= await exportMeetingDelta(candidate);
      const merged = await importMeetingDelta(baseline, delta);
      if (!merged.added && baseline === active && !localEdit) return;
      const presentation = localEdit ? candidate : active;
      next = { ...merged.data, viewerUsername: presentation.viewerUsername, view: presentation.view };
    }
    try {
      await commit(next, baseline);
      return;
    } catch (error) {
      if (!(error instanceof ArchiveConflictError) || !reference || attempt >= 2) throw error;
      // Never consult the global last-opened pointer: another tab may now
      // have a different document open. This read validates both cache IDs.
      baseline = await loadReferencedExport(reference, { sourceOnly: true }) as ExportData;
    }
  }
}
