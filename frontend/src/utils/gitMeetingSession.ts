import type { ExportData } from '../api/client';
import { getExportCacheReference } from './exportViewerCache';
import { gitMeetingCommentSource, type GitMeetingCommentSource } from './gitMeetingComments';

// Credentials belong to this page and repository. Cache keys, route state, and
// downloadable archives contain only the public location of the discussion.
const tokens = new Map<string, string>();
const listeners = new Set<() => void>();
export type GitHubAccess = 'public' | 'private';
type HostedGrant = { token: string; access: GitHubAccess };
let hostedGrant: HostedGrant | null = null;

export function getGitHubGrant() { return hostedGrant; }

export function rememberGitHubGrant(token: string, access: GitHubAccess) {
  // A fresh popup may authorize a different GitHub account. Drop prior bindings.
  tokens.clear();
  hostedGrant = { token, access };
  listeners.forEach(listener => listener());
}

export function gitMeetingToken(repository: string): string {
  return tokens.get(repository) ?? '';
}

export function setGitMeetingToken(repository: string, token: string) {
  if (gitMeetingToken(repository) === token) return;
  if (token) tokens.set(repository, token);
  else tokens.delete(repository);
  listeners.forEach(listener => listener());
}

export function clearGitMeetingTokens() {
  if (!tokens.size && !hostedGrant) return;
  hostedGrant = null;
  tokens.clear();
  listeners.forEach(listener => listener());
}

export function subscribeGitCredentials(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function gitMeetingBinding(data: ExportData): { key: string; source: GitMeetingCommentSource } | undefined {
  const key = getExportCacheReference(data)?.archiveId;
  if (!key?.startsWith('git-issue:')) return;
  try {
    const issueUrl = decodeURIComponent(key.split(':')[1]);
    return { key, source: gitMeetingCommentSource(issueUrl) };
  } catch { return; }
}
