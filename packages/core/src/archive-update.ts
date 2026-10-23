import type { Change } from './types.js';

export interface ArchiveCheckpoint {
  regionId: string;
  ledgerId: string;
  sequence: number;
  entryCount: number;
  hash: string;
}

/** Stable input for a SHA-256 prefix check, independent of JSON indentation and key order. */
export function archiveChangeFingerprint(change: Change): string {
  return JSON.stringify(change, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }) + '\n';
}
