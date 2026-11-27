import { useSyncExternalStore } from 'react';
import type { ExportData } from '../api/client';
import { clearPendingGitDeltas } from './gitMeetingRetry';

export const CLOUD_LOGOUT_KEY = 'gonglun:cloud-meeting-logout';
export const CLOUD_LOGOUT_REQUEST = 'request-cloud-meeting-logout';
export const WPS_MEETING_SESSION_KEY = 'gonglun:wps-meeting:v1';
const legacyChanged = 'legacy-wps-archive-bound';
const closedViewerPrefix = 'gonglun:closed-wps-viewer:';
const closedInlineViewers = new Set<string>();
const inlineViewerSessions = new Map<string, string>();
type LegacyWpsMeeting = { meetingId: string; baseHash: string; url: string; archiveId?: string; viewCacheId?: string };
type ViewerState = { viewerCacheRef?: { archiveId: string }; exportData?: ExportData } | null;

export function cloudLogoutStamp(): string | null {
  try { return localStorage.getItem(CLOUD_LOGOUT_KEY); } catch { return null; }
}

export function isCloudMeetingArchive(id: unknown): id is string {
  return typeof id === 'string' && (id.startsWith('wps-document:') || id.startsWith('git-issue:'));
}

function tabArchiveId(): string | undefined {
  try {
    const id = JSON.parse(sessionStorage.getItem('lastExportData') ?? 'null')?.archiveId;
    if (typeof id === 'string') return id;
  } catch { /* The route can still identify the open discussion. */ }
}

export function legacyWpsMeeting(): LegacyWpsMeeting | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(WPS_MEETING_SESSION_KEY) ?? 'null');
    if (typeof value?.meetingId === 'string' && typeof value.baseHash === 'string' && typeof value.url === 'string') return value;
  } catch { /* No legacy WPS binding in this tab. */ }
}

export function matchesLegacyWps(meeting: ExportData['meeting'], legacy: LegacyWpsMeeting | undefined) {
  return !!meeting && meeting.id === legacy?.meetingId && meeting.baseHash === legacy.baseHash;
}

export function matchesLegacyWpsArchive(meeting: ExportData['meeting'], legacy: LegacyWpsMeeting | undefined,
  reference?: { archiveId: string; viewCacheId?: string } | null) {
  return matchesLegacyWps(meeting, legacy) && (!legacy?.archiveId ||
    (legacy.archiveId === reference?.archiveId && (!legacy.viewCacheId || legacy.viewCacheId === reference.viewCacheId)));
}

export function configuredWpsMeetingUrl(meeting: ExportData['meeting'], reference: { archiveId: string; viewCacheId?: string } | null) {
  if (!meeting) return;
  const id = reference?.archiveId;
  if (id?.startsWith('git-issue:')) return;
  if (id?.startsWith('wps-document:')) return decodeURIComponent(id.split(':')[1]);
  const legacy = legacyWpsMeeting();
  if (matchesLegacyWpsArchive(meeting, legacy, reference)) return legacy?.url;
}

// Old storage fallbacks put the data itself in history. A later Back action
// must not rehydrate that viewer after logout; freshly opened files get a new key.
export function rememberLegacyInlineViewer(state: ViewerState, key: string) {
  if (state?.viewerCacheRef || !matchesLegacyWpsArchive(state?.exportData?.meeting, legacyWpsMeeting())) return;
  const session = 'seen:' + (cloudLogoutStamp() ?? '');
  if (!inlineViewerSessions.has(key)) inlineViewerSessions.set(key, session);
  try {
    if (sessionStorage.getItem(closedViewerPrefix + key) === null) sessionStorage.setItem(closedViewerPrefix + key, session);
  } catch { /* The in-memory marker covers this page's history. */ }
}

export function closeLegacyInlineViewer(state: ViewerState, key: string) {
  if (!state?.viewerCacheRef && matchesLegacyWpsArchive(state?.exportData?.meeting, legacyWpsMeeting())) {
    closedInlineViewers.add(key);
    try { sessionStorage.setItem(closedViewerPrefix + key, '1'); } catch { /* Still invalidate the live tab. */ }
  }
}

export function isClosedLegacyInlineViewer(state: ViewerState, key: string) {
  if (!state?.exportData || state.viewerCacheRef) return false;
  if (closedInlineViewers.has(key)) return true;
  let marker = inlineViewerSessions.get(key);
  try { marker = sessionStorage.getItem(closedViewerPrefix + key) ?? marker; } catch { /* Session storage is optional. */ }
  return marker !== undefined && marker !== 'seen:' + (cloudLogoutStamp() ?? '');
}

// Older WPS sessions identified the meeting, but used a regular viewer cache ID.
// Record the exact archive when its mounted workbench actually connects to WPS.
export function bindLegacyWpsArchive(meeting: ExportData['meeting'], reference: { archiveId: string; viewCacheId: string } | null) {
  const legacy = legacyWpsMeeting();
  if (!reference || isCloudMeetingArchive(reference.archiveId) || !legacy || !matchesLegacyWpsArchive(meeting, legacy, reference)
    || (reference.archiveId === legacy.archiveId && reference.viewCacheId === legacy.viewCacheId)) return;
  try {
    sessionStorage.setItem(WPS_MEETING_SESSION_KEY, JSON.stringify({ ...legacy, ...reference }));
    window.dispatchEvent(new Event(legacyChanged));
  } catch { /* Optional cache binding. */ }
}

export function legacyLogoutTarget(state?: ViewerState) {
  const legacy = legacyWpsMeeting();
  if (!legacy) return;
  const archiveId = legacy.archiveId ?? state?.viewerCacheRef?.archiveId ?? tabArchiveId();
  return { ...legacy, archiveId: typeof archiveId === 'string' && !isCloudMeetingArchive(archiveId) ? archiveId : undefined };
}
export type LegacyLogoutTarget = ReturnType<typeof legacyLogoutTarget>;

function cloudViewer(state?: ViewerState) {
  const legacy = legacyWpsMeeting();
  if (!state?.viewerCacheRef && state?.exportData) return matchesLegacyWpsArchive(state.exportData.meeting, legacy);
  const id = state?.viewerCacheRef?.archiveId ?? tabArchiveId();
  if (isCloudMeetingArchive(id)) return true;
  return !!legacy && !!id && id === (legacy.archiveId ?? `folder-meeting:${legacy.meetingId}:${legacy.baseHash}`);
}

function subscribeLegacyArchive(notify: () => void) {
  window.addEventListener(legacyChanged, notify);
  return () => window.removeEventListener(legacyChanged, notify);
}
export function useCloudViewer(state?: ViewerState) {
  return useSyncExternalStore(subscribeLegacyArchive, () => cloudViewer(state));
}

export function tabCloudMeetingId(): string | undefined {
  return cloudViewer() ? tabArchiveId() : undefined;
}

export function requestCloudMeetingLogout(includeGonglun = false) {
  window.dispatchEvent(new CustomEvent(CLOUD_LOGOUT_REQUEST, { detail: { includeGonglun } }));
}

export function clearCloudMeetingStorage(verifiedLegacyId?: string) {
  clearPendingGitDeltas();
  let inlineLegacy = false;
  const legacy = legacyWpsMeeting();
  if (legacy) {
    try { inlineLegacy = matchesLegacyWpsArchive(JSON.parse(sessionStorage.getItem('lastExportData') ?? 'null')?.meeting, legacy); }
    catch { /* An invalid fallback cannot identify an old cloud meeting. */ }
  }
  if (inlineLegacy || tabCloudMeetingId() || (verifiedLegacyId && tabArchiveId() === verifiedLegacyId)) sessionStorage.removeItem('lastExportData');
  for (const key of Object.keys(sessionStorage)) {
    if (key === 'gonglun:wps-meeting:v1' || key.startsWith('gonglun:wps-meeting:v1:')) sessionStorage.removeItem(key);
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('gonglun:wps-identity:v1:')) localStorage.removeItem(key);
  }
  localStorage.removeItem('export-viewer-username');
}
