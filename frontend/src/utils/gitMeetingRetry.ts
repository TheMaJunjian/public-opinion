import type { GitMeetingDelta } from './gitMeetingTransport';
import { parseEntry } from './meetingExchange';

const prefix = 'gonglun:git-pending:';
const keyPattern = /^gonglun:git-pending:[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const memory = new Map<string, string>();
const invalid = '待确认的云端发言记录无效。';

function validatedDelta(value: unknown): GitMeetingDelta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(invalid);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['format', 'version', 'meetingId', 'baseHash', 'entries'].includes(key))
    || row.format !== 'gonglun-meeting-delta' || row.version !== 1
    || typeof row.meetingId !== 'string' || !uuid.test(row.meetingId)
    || typeof row.baseHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.baseHash)
    || !Array.isArray(row.entries) || !row.entries.length) throw new Error(invalid);
  const entries = row.entries.map(parseEntry);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error(invalid);
  const authors = new Map<string, string>();
  for (const entry of entries) {
    if (authors.has(entry.speakerId) && authors.get(entry.speakerId) !== entry.speaker) throw new Error(invalid);
    authors.set(entry.speakerId, entry.speaker);
    if (entry.type === 'reply' && [entry.source, ...entry.targets].some(id => byId.get(id)?.type === 'reply')) throw new Error(invalid);
  }
  return { format: row.format, version: row.version, meetingId: row.meetingId, baseHash: row.baseHash, entries };
}

function signature(delta: GitMeetingDelta): string {
  const positions = new Map(delta.entries.map((entry, index) => [entry.id, index]));
  // A repeated send can allocate fresh UUIDs for both a message and its reply
  // relation. References outside this batch still identify an exact message.
  const reference = (id: string) => positions.get(id) ?? id;
  const entries = delta.entries.map(entry => entry.type === 'text'
    ? ['text', entry.speaker, entry.text]
    : ['reply', entry.speaker, reference(entry.source), entry.targets.map(reference)]);
  return JSON.stringify([delta.meetingId, delta.baseHash, entries]);
}

export async function gitMeetingPendingKey(archiveKey: string, delta: GitMeetingDelta): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([archiveKey, signature(validatedDelta(delta))]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return prefix + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function storedValue(key: string) {
  let raw = memory.get(key);
  try { raw ??= sessionStorage.getItem(key) ?? undefined; } catch { /* Storage may be disabled. */ }
  return raw;
}

function storedDelta(key: string, raw: string | undefined): GitMeetingDelta | undefined {
  if (!raw) return;
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || Object.keys(record).length !== 2 || record.key !== key) return;
    return validatedDelta(record.delta);
  } catch { /* An unrelated or damaged record must never be dispatched. */ }
}

export function loadPendingGitDelta(key: string, delta: GitMeetingDelta): GitMeetingDelta | undefined {
  if (!keyPattern.test(key)) return;
  const saved = storedDelta(key, storedValue(key));
  if (saved) {
    try { if (signature(saved) === signature(validatedDelta(delta))) return saved; }
    catch { /* The requested batch must also be valid. */ }
  }
}

function* pendingKeys() {
  yield* memory.keys();
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && keyPattern.test(key) && !memory.has(key)) yield key;
    }
  } catch { /* Storage may be disabled. */ }
}

export function hasPendingGitDeltas(): boolean {
  return !pendingKeys().next().done;
}

// The caller supplies remote entries only after saving them locally. A partial
// reply or an identical message by the same person is insufficient evidence.
export async function settlePendingGitDeltas(archiveKey: string, delta: GitMeetingDelta): Promise<void> {
  if (!delta.entries.length) return;
  const keys = [...pendingKeys()];
  let savedRows: Map<string, GitMeetingDelta['entries'][number]> | undefined;
  for (const key of keys) {
    const raw = storedValue(key);
    const pending = storedDelta(key, raw);
    if (!pending || pending.meetingId !== delta.meetingId || pending.baseHash !== delta.baseHash) continue;
    if (!savedRows) savedRows = new Map(validatedDelta(delta).entries.map(entry => [entry.id, entry]));
    const rows = savedRows;
    if (!pending.entries.every(entry => JSON.stringify(rows.get(entry.id)) === JSON.stringify(entry))) continue;
    // A later intentional send can reuse the semantic key while SHA-256 runs.
    if (await gitMeetingPendingKey(archiveKey, pending) === key && storedValue(key) === raw) forgetPendingGitDelta(key);
  }
}

export function rememberPendingGitDelta(key: string, delta: GitMeetingDelta) {
  if (!keyPattern.test(key)) throw new Error(invalid);
  const raw = JSON.stringify({ key, delta: validatedDelta(delta) });
  try {
    sessionStorage.setItem(key, raw);
    memory.delete(key);
  } catch {
    memory.set(key, raw);
  }
}

export function forgetPendingGitDelta(key: string, expected?: GitMeetingDelta) {
  if (!keyPattern.test(key)) return;
  if (expected && JSON.stringify(storedDelta(key, storedValue(key))) !== JSON.stringify(validatedDelta(expected))) return;
  memory.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}

export function clearPendingGitDeltas() {
  memory.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch { /* Storage may be disabled. */ }
}
