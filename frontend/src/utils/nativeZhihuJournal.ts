import type { ExportData } from '../api/client';
import type { LinkedDirectory } from './zhihuDirectory';
import { compactNativeRecord } from './nativeZhihuEditor';
import { isNativeLocalMessage, mergeNativeZhihuUpdate, nativeZhihuIdentity, type NativeZhihuView } from './nativeZhihuView';
import { prepareExportForViewing } from './exportArchive';
import { sameZhihuValue } from './zhihuIncremental';

const NAME = 'gonglun-local.ndjson';
type Row = { format: 'gonglun-native-messages'; version: 1; documentId: string; previous: string | null; base: number;
  messages: ExportData['messages']; relations: ExportData['relations']; users: ExportData['users']; view: ExportData['view'] | null; digest: string };
async function checksum(value: Omit<Row, 'digest'>): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function file(connection: LinkedDirectory): Promise<File | null> {
  try { return await (await connection.directory.getFileHandle(NAME)).getFile(); }
  catch (error) { if ((error as DOMException).name === 'NotFoundError') return null; throw error; }
}
export async function nativeJournalSignature(connection: LinkedDirectory): Promise<string> {
  const current = await file(connection); return current ? `${current.lastModified}:${current.size}` : '';
}
async function read(connection: LinkedDirectory) {
  const current = await file(connection);
  const messages: ExportData['messages'] = [], relations: ExportData['relations'] = [];
  const users = new Map<string, NonNullable<ExportData['users']>[number]>();
  let previous: string | null = null, view: ExportData['view'] | null = null;
  if (!current) return { messages, relations, users, view, previous, size: 0 };
  if (current.size > 100_000_000) throw new Error('本地消息增量文件过大，已保留原文件。');
  const text = await current.text();
  if (text && !text.endsWith('\n')) throw new Error('本地消息增量末尾不完整，已停止同步并保留文件。');
  const ids = new Set<string>();
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as Row;
    if (!row || row.format !== 'gonglun-native-messages' || row.version !== 1 || row.documentId !== connection.documentId
      || row.base !== messages.length || row.previous !== previous || !Array.isArray(row.messages) || !Array.isArray(row.relations)) throw new Error('本地消息增量格式或顺序不符，未覆盖文件。');
    const { digest, ...payload } = row;
    if (digest !== await checksum(payload)) throw new Error('本地消息增量校验失败，未覆盖文件。');
    for (const message of row.messages) {
      if (!isNativeLocalMessage(message) || ids.has(message.id) || !Number.isSafeInteger(message.revision)) throw new Error('本地原生消息编号或来源不符。');
      ids.add(message.id); messages.push(message);
    }
    for (const relation of row.relations) { if (!ids.has(relation.id)) throw new Error('本地关系缺少对应消息。'); relations.push(relation); }
    for (const user of row.users || []) users.set(user.id, user);
    view = row.view; previous = digest;
  }
  return { messages, relations, users, view, previous, size: current.size };
}
export async function restoreNativeJournal(connection: LinkedDirectory, source: NativeZhihuView): Promise<NativeZhihuView> {
  const journal = await read(connection);
  if (!journal.messages.length && !journal.view) return source;
  const users = new Map((source.users || []).map(user => [user.id, user]));
  for (const [id, user] of journal.users) users.set(id, user);
  const doc = (await prepareExportForViewing({ ...source, messages: [...source.messages.filter(message => !isNativeLocalMessage(message)), ...journal.messages],
    relations: [...source.relations.filter(relation => !isNativeLocalMessage(relation)), ...journal.relations], users: [...users.values()],
    ...(journal.view ? { view: journal.view } : {}) })).data as NativeZhihuView;
  const merged = mergeNativeZhihuUpdate(source, doc);
  return journal.view ? { ...merged, view: journal.view } : merged;
}
export async function appendNativeJournal(connection: LinkedDirectory, data: NativeZhihuView): Promise<void> {
  if (connection.documentId !== nativeZhihuIdentity(data)) throw new Error('本地消息与关联目录身份不一致。');
  if (!navigator.locks) throw new Error('浏览器不支持安全的本地目录同步。');
  await navigator.locks.request(`gonglun-native:${connection.documentId}`, async () => {
    const journal = await read(connection), local = data.messages.filter(isNativeLocalMessage);
    if (journal.messages.length > local.length || journal.messages.some((message, index) => message.id !== local[index].id || !sameZhihuValue(message.parts, local[index].parts))) throw new Error('目录中的本地消息比当前阅览更新或存在分叉，未覆盖文件。');
    const added = local.slice(journal.messages.length), ids = new Set(added.map(message => message.id)), authors = new Set(added.map(message => message.authorId));
    if (!added.length && sameZhihuValue(journal.view, data.view ?? null)) return;
    const payload: Omit<Row, 'digest'> = { format: 'gonglun-native-messages', version: 1, documentId: connection.documentId,
      previous: journal.previous, base: journal.messages.length, messages: added.map(compactNativeRecord) as ExportData['messages'],
      relations: data.relations.filter(relation => ids.has(relation.id)).map(compactNativeRecord), users: data.users?.filter(user => authors.has(user.id)), view: data.view ?? null };
    const record = { ...payload, digest: await checksum(payload) };
    const writable = await (await connection.directory.getFileHandle(NAME, { create: true })).createWritable({ keepExistingData: true });
    try { await writable.seek(journal.size); await writable.write(`${JSON.stringify(record)}\n`); await writable.close(); }
    catch (error) { await writable.abort().catch(() => undefined); throw error; }
    connection.journalSignature = await nativeJournalSignature(connection);
  });
}
