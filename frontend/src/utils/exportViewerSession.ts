import type { ExportData } from '../api/client';
import { getExportCacheReference, type ExportCacheReference, type ExportNavigation } from './exportViewerCache';
import { pagedArchiveSource } from './pagedZhihuArchive';

export interface ExportViewerRouteState {
  exportData?: ExportData;
  viewerCacheRef?: ExportCacheReference;
  viewerInstanceKey?: string;
  viewerNavigation?: ExportNavigation;
  viewerRetain?: false;
}

// Large document projections should not coexist with another freshly loaded copy.
export const RETAINED_VIEWER_MESSAGE_LIMIT = 10_000;

// A one-use handoff from the chooser to the mounted viewer. Large documents
// must not be cloned into every category's browser-history entry.
let pending: { key: string; data: ExportData } | null = null;

export function createExportViewerState(data: ExportData, navigation?: ExportNavigation | null): ExportViewerRouteState {
  const viewerInstanceKey = crypto.randomUUID();
  const viewerCacheRef = getExportCacheReference(data);
  const large = data.messages.length > RETAINED_VIEWER_MESSAGE_LIMIT || !!pagedArchiveSource(data);
  pending = { key: viewerInstanceKey, data };
  return {
    viewerInstanceKey,
    ...(large ? { viewerRetain: false as const } : {}),
    // Small files can recover through history if storage fails. Large files
    // use the in-memory handoff: cloning them into history can crash the tab.
    ...(viewerCacheRef ? { viewerCacheRef } : !large ? { exportData: data } : {}),
    ...(navigation ? { viewerNavigation: navigation } : {}),
  };
}

export function getPreparedViewerExport(key: unknown): ExportData | null {
  return typeof key === 'string' && pending?.key === key ? pending.data : null;
}

export function releasePreparedViewerExport(key: unknown): void {
  if (pending?.key === key) pending = null;
}
