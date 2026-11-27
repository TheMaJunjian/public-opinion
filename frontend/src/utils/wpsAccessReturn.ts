import { wpsDocumentUrl } from './wpsMeetingTransport';
import { cloudLogoutStamp } from './cloudMeetingAccount';

const returnKey = 'gonglunWpsAccessReturn';
const returnStamp = 'gonglunWpsAccessSession';

export function getPendingWpsDocument(): string | null {
  const url = window.history.state?.[returnKey];
  if (typeof url !== 'string' || (window.history.state?.[returnStamp] ?? null) !== cloudLogoutStamp()) return null;
  try { return wpsDocumentUrl(url).href; } catch { return null; }
}

export function clearPendingWpsDocument() {
  if (!window.history.state?.[returnKey]) return;
  const state = { ...window.history.state };
  delete state[returnKey];
  delete state[returnStamp];
  window.history.replaceState(state, '');
}

export function visitWpsForAccess(link: URL) {
  const url = wpsDocumentUrl(link.href).href;
  // Attach to this exact history entry. Back restores the chooser without exposing the
  // document URL in the public-opinion route or changing React Router's navigation state.
  try { window.history.replaceState({ ...window.history.state, [returnKey]: url, [returnStamp]: cloudLogoutStamp() }, ''); }
  catch { /* Some embedded browsers restrict history updates but allow navigating to WPS. */ }
  window.location.assign(url);
}
