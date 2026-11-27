import { bindRoles, type Part } from '@gonglun/core';
import type { ExportData } from '../api/client';
import { isNativeLocalMessage } from './nativeZhihuView';

type Common = { id: string; speakerId: string; speaker: string; at: string };
type Entry = Common & ({ type: 'text'; text: string } | { type: 'reply'; source: string; targets: string[] });
type Row = ExportData['messages'][number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localId = (value: unknown, prefix: string) => typeof value === 'string' && value.startsWith(prefix) && uuid.test(value.slice(prefix.length));
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keysAre = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).every(key => keys.includes(key));
const notShared = '会议文件只支持本地文字和针对整条发言的回复。请用新建的本地消息文件准备会议。';
const invalid = '会议增量格式或发言记录无效，未导入。';
export const MAX_MEETING_BYTES = 32 * 1024 * 1024;

export function parseEntry(input: unknown): Entry {
  if (!isObject(input) || !localId(input.id, 'local:') || !localId(input.speakerId, 'local:user:')
    || typeof input.speaker !== 'string' || !input.speaker.trim() || input.speaker.length > 200
    || typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at)) || new Date(input.at).toISOString() !== input.at) throw new Error(invalid);
  const common = { id: input.id as string, speakerId: input.speakerId as string, speaker: input.speaker, at: input.at };
  const keys = ['id', 'speakerId', 'speaker', 'at', 'type'];
  if (input.type === 'text' && keysAre(input, [...keys, 'text']) && typeof input.text === 'string' && input.text.trim()) {
    return { ...common, type: 'text', text: input.text };
  }
  if (input.type === 'reply' && keysAre(input, [...keys, 'source', 'targets']) && localId(input.source, 'local:')
    && Array.isArray(input.targets) && input.targets.length && input.targets.every(id => localId(id, 'local:'))
    && new Set(input.targets).size === input.targets.length && !input.targets.includes(input.source)) {
    return { ...common, type: 'reply', source: input.source as string, targets: [...input.targets] as string[] };
  }
  throw new Error(invalid);
}

function publicRow(row: object) {
  const value = row as Record<string, unknown>;
  if (value.restricted || value.moderation || value.supersededBy || (isObject(value.state) && value.state.suppressed)) {
    throw new Error('文件含受限、受审核或已隐藏的消息，不能作为会议文件交换。');
  }
}

function extractEntries(data: ExportData): Entry[] {
  if (data.format !== 'gonglun-view-3' || data.formatVersion !== 5 || 'source' in data || 'changes' in data) throw new Error(notShared);
  const relations = new Map(data.relations.map(row => [row.id, row]));
  if (relations.size !== data.relations.length) throw new Error(invalid);
  for (const row of data.relations) publicRow(row);
  const entries = data.messages.map(row => {
    publicRow(row);
    if (!isNativeLocalMessage(row) || row.revision !== 1) throw new Error(notShared);
    const common = { id: row.id, speakerId: row.authorId, speaker: row.author, at: row.createdAt };
    const parts = row.parts!.filter(p => p.id !== 'local-origin');
    if (row.kind === 'TEXT' && !row.relationType && !relations.has(row.id) && parts.length === 1
      && parts[0].type === 'text' && parts[0].id === 'body' && parts[0].text === row.content) {
      return parseEntry({ ...common, type: 'text', text: parts[0].text });
    }
    const relation = relations.get(row.id);
    const link = parts.find(p => p.type === 'relation');
    if (row.relationType !== 'REPLY' || relation?.relationType !== 'REPLY' || row.kind !== 'RELATION'
      || !link || link.relation !== 'reply' || !keysAre(link.roles, ['target', 'source'])
      || parts.some(p => p !== link && !(p.type === 'data' && p.id === 'data' && isObject(p.value) && keysAre(p.value, ['uiType'])))
      || link.roles.source?.length !== 1 || !Array.isArray(link.roles.target)) throw new Error(notShared);
    const whole = (b: { reference: unknown }) => {
      const r = b.reference;
      if (!isObject(r) || !keysAre(r, ['messageId', 'revision', 'context']) || (r.revision !== undefined && r.revision !== 1)) throw new Error(notShared);
      if (r.context !== undefined) {
        const c = r.context;
        if (!isObject(c) || !['BODY', 'MESSAGE'].includes(String(c.kind)) || !keysAre(c, ['kind', 'version'])) throw new Error(notShared);
        const version = c.version;
        if (version !== undefined && (!isObject(version) || version.format !== 2 || version.messageId !== r.messageId
          || version.revision !== 1 || !Array.isArray(version.corrections) || version.corrections.length)) throw new Error(notShared);
      }
      return r.messageId;
    };
    relations.delete(row.id);
    return parseEntry({ ...common, type: 'reply', source: whole(link.roles.source[0]), targets: link.roles.target.map(whole) });
  });
  if (relations.size) throw new Error(invalid);
  validateCollection(entries);
  return entries;
}

function validateCollection(entries: Entry[]) {
  const rows = new Map(entries.map(e => [e.id, e]));
  if (rows.size !== entries.length) throw new Error('会议发言编号重复。');
  const authors = new Map<string, string>();
  for (const e of entries) {
    if (authors.has(e.speakerId) && authors.get(e.speakerId) !== e.speaker) throw new Error('同一发言人编号对应不同署名。');
    authors.set(e.speakerId, e.speaker);
    if (e.type === 'reply' && [e.source, ...e.targets].some(id => rows.get(id)?.type !== 'text')) {
      throw new Error('缺少回复引用的文字发言。请先导入含原发言的增量，再重新导入此文件。');
    }
  }
}

async function hashBase(id: string, entries: Entry[]) {
  const bytes = new TextEncoder().encode(JSON.stringify([id, entries]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function emptyMeetingIdentity(id: string): Promise<NonNullable<ExportData['meeting']>> {
  if (!uuid.test(id)) throw new Error('云表中的会议编号无效。');
  return { version: 1, id, baseIds: [], baseHash: await hashBase(id, []) };
}

async function checkMeeting(data: ExportData) {
  const m = data.meeting;
  if (!m || m.version !== 1 || !uuid.test(m.id) || !Array.isArray(m.baseIds) || new Set(m.baseIds).size !== m.baseIds.length
    || !/^[0-9a-f]{64}$/.test(m.baseHash)) throw new Error('请先打开组织者分发的会议起始文件。');
  const entries = extractEntries(data);
  const rows = new Map(entries.map(e => [e.id, e]));
  const base = m.baseIds.map(id => {
    const e = rows.get(id);
    if (!e) throw new Error('会议起始文件缺少原始发言。');
    return e;
  });
  validateCollection(base);
  if (await hashBase(m.id, base) !== m.baseHash) throw new Error('会议起始内容与指纹不一致。');
  return { m, entries, base };
}

export async function validateMeetingDocument(data: ExportData) {
  await checkMeeting(data);
}

function records(entries: Entry[]) {
  const messages: Row[] = [], relations: ExportData['relations'] = [];
  const users = new Map<string, NonNullable<ExportData['users']>[number]>();
  for (const e of entries) {
    if (!users.has(e.speakerId)) users.set(e.speakerId, { id: e.speakerId, username: e.speaker, createdAt: e.at });
    const parts: Part[] = e.type === 'text' ? [{ type: 'text', id: 'body', text: e.text }] : [
      { type: 'relation', id: 'relation', relation: 'reply', roles: bindRoles({ source: [{ messageId: e.source }], target: e.targets.map(messageId => ({ messageId })) }) },
      { type: 'data', id: 'data', value: { uiType: 'REPLY' } },
    ];
    parts.push({ type: 'data', id: 'local-origin', value: { format: 'gonglun-local-message', version: 1 } });
    const row: Row = { id: e.id, author: e.speaker, authorId: e.speakerId, createdAt: e.at, sequence: messages.length + 1,
      revision: 1, kind: e.type === 'text' ? 'TEXT' : 'RELATION', contentType: 'TEXT', content: e.type === 'text' ? e.text : '', parts,
      spending: { protocol: 0, wager: 0, recommendation: 0 } };
    if (e.type === 'reply') {
      const targetRefs = e.targets.map(messageId => ({ kind: 'message', messageId, reference: { messageId } }));
      const info = { relationType: 'REPLY', sourceMessageId: e.source, targetRefs, payload: { uiType: 'REPLY' }, supersededBy: null };
      Object.assign(row, info, { relationPayload: info.payload });
      relations.push({ ...row, ...info });
    }
    messages.push(row);
  }
  return { messages, relations, users: [...users.values()] };
}

export async function createMeetingStart(source: ExportData): Promise<ExportData> {
  if (source.meeting) throw new Error('已打开会议文件。');
  const base = extractEntries(source), id = crypto.randomUUID();
  return { format: 'gonglun-view-3', formatVersion: 5, exportedAt: new Date().toISOString(),
    scope: { messageId: null, title: '离线会议' }, ...records(base),
    meeting: { version: 1, id, baseIds: base.map(e => e.id), baseHash: await hashBase(id, base) } };
}

/** The viewer and the exchange must use the same replies, including when a manual file contains stale display fields. */
export async function restoreMeetingDocument(data: ExportData, options: { startOnly?: boolean } = {}): Promise<ExportData> {
  const { m, base, entries } = await checkMeeting(data);
  if (options.startOnly && entries.length !== base.length) throw new Error('所选文件含会后记录，请使用最初生成的会议起始文件。');
  const baseIds = new Set(m.baseIds);
  const ordered = entries.length === base.length ? base : [...base, ...entries.filter(entry => !baseIds.has(entry.id))];
  return { format: 'gonglun-view-3', formatVersion: 5, exportedAt: data.exportedAt,
    scope: { messageId: null, title: data.scope.title }, ...records(ordered),
    ...(!options.startOnly && data.view ? { view: data.view } : {}),
    ...(!options.startOnly && data.viewerUsername !== undefined ? { viewerUsername: data.viewerUsername } : {}),
    meeting: { version: 1, id: m.id, baseHash: m.baseHash, baseIds: base.map(entry => entry.id) } };
}

export async function exportMeetingDelta(data: ExportData) {
  const { m, entries } = await checkMeeting(data), ids = new Set(m.baseIds);
  return { format: 'gonglun-meeting-delta', version: 1, meetingId: m.id, baseHash: m.baseHash,
    entries: entries.filter(e => !ids.has(e.id)) };
}

export type MeetingEditConfirmation = {
  original?: Awaited<ReturnType<typeof exportMeetingDelta>>;
  saved: () => void;
};

export class MeetingEntryConflict extends Error {
  constructor(readonly ids: string[]) {
    super('同一发言编号对应不同内容，已保留本机记录。');
  }
}

export async function importMeetingDelta(data: ExportData, input: unknown) {
  const { m, entries, base } = await checkMeeting(data);
  if (!isObject(input) || input.format !== 'gonglun-meeting-delta' || input.version !== 1
    || !keysAre(input, ['format','version','meetingId','baseHash','entries']) || !Array.isArray(input.entries)) throw new Error(invalid);
  if (input.meetingId !== m.id || input.baseHash !== m.baseHash) throw new Error('会议编号或起始内容不匹配。');
  const byId = new Map(entries.map(e => [e.id, e])), before = byId.size;
  const incoming = new Map<string, Entry>();
  for (const item of input.entries) {
    const e = parseEntry(item), duplicate = incoming.get(e.id);
    if (duplicate && JSON.stringify(e) !== JSON.stringify(duplicate)) throw new Error('增量中同一发言编号对应不同内容。');
    incoming.set(e.id, e);
  }
  const conflicts: string[] = [];
  for (const e of incoming.values()) {
    const old = byId.get(e.id);
    if (old && JSON.stringify(e) !== JSON.stringify(old)) conflicts.push(e.id);
    byId.set(e.id, e);
  }
  const merged = [...byId.values()];
  validateCollection(merged);
  if (conflicts.length) throw new MeetingEntryConflict(conflicts);
  const added = merged.length - before;
  if (!added) return { data, added };
  const baseIds = new Set(m.baseIds);
  const tail = merged.filter(e => !baseIds.has(e.id)).sort((a,b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1);
  const normalized = records([...base, ...tail]);
  const localMessages = new Map(data.messages.map(row => [row.id, row]));
  const localRelations = new Map(data.relations.map(row => [row.id, row]));
  const users = new Map(data.users?.map(user => [user.id, user]));
  for (const user of normalized.users) {
    const existing = users.get(user.id);
    if (existing && existing.username !== user.username) throw new Error('发言人与本机用户编号冲突。');
    if (!existing) users.set(user.id, user);
  }
  return { added, data: { ...data, users: [...users.values()],
    messages: normalized.messages.map(row => ({ ...(localMessages.get(row.id) ?? row), sequence: row.sequence })),
    relations: normalized.relations.map(row => ({ ...(localRelations.get(row.id) ?? row), sequence: (row as { sequence?: number }).sequence })),
  } };
}
