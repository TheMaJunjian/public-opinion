import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { LocalDiscussion } from '../utils/localDiscussion';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { MeetingDirectorySync } from '../utils/meetingDirectorySync';
import { createMeetingStart, exportMeetingDelta } from '../utils/meetingExchange';

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

// The directory can expose a zero-byte file while a writer still owns its stream.
class Directory {
  readonly children = new Map<string, Directory>();
  readonly files = new Map<string, string>();
  private readonly identities = new Map<string, symbol>();
  writes = 0;
  reads = 0;
  failClose = false;
  get handle() { return this as unknown as FileSystemDirectoryHandle; }
  async getDirectoryHandle(name: string) {
    if (!this.children.has(name)) this.children.set(name, new Directory());
    return this.children.get(name)!;
  }
  async *values() {
    for (const name of [...this.files.keys()]) yield await this.getFileHandle(name);
  }
  async removeEntry(name: string) {
    if (this.failClose) throw new Error('共享目录已断开');
    this.files.delete(name); this.identities.delete(name);
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('missing', 'NotFoundError');
      this.files.set(name, '');
    }
    if (!this.identities.has(name)) this.identities.set(name, Symbol(name));
    const identity = this.identities.get(name)!;
    return {
      kind: 'file', name, identity, isSameEntry: async (other: { identity: symbol }) => identity === other.identity,
      getFile: async () => { this.reads++; return new File([this.files.get(name)!], name); },
      createWritable: async () => {
        let buffer = '';
        return {
          write: async (value: Uint8Array) => { buffer = new TextDecoder().decode(value); },
          close: async () => {
            if (this.failClose) throw new Error('共享目录已断开');
            this.writes++; this.files.set(name, buffer);
          },
          abort: async () => {},
        };
      },
    };
  }
  get meeting() { return [...this.children.values()][0]!; }
}

async function speak(data: ExportData, name: string, text: string, target?: string) {
  const draft = new LocalDiscussion(data, name);
  const source = await draft.createMessage('root', { content: text });
  if (target) await draft.createRelation('root', { relationType: 'REPLY', sourceMessageId: source.id,
    targetRefs: [{ kind: 'message', messageId: target }] });
  let saved!: ExportData;
  await draft.commit(async result => { saved = result; });
  return saved;
}

it('merges concurrent writers, never overwrites originals and does not relay received records', async () => {
  const root = new Directory(), start = await createMeetingStart(createLocalMessageFile());
  root.files.set('议程.json', '已有文件');
  const a = new MeetingDirectorySync(root.handle), b = new MeetingDirectorySync(root.handle);
  const [alice, bob] = await Promise.all([speak(start, '甲', '甲的提案'), speak(start, '乙', '乙的补充')]);
  const [firstA, firstB] = await Promise.all([a.exchange(alice), b.exchange(bob)]);
  expect(firstA.published).toBe(1); expect(firstB.published).toBe(1);
  const [nextA, nextB] = await Promise.all([a.exchange(firstA.data), b.exchange(firstB.data)]);
  expect(nextA.data.messages.map(row => row.id)).toEqual(nextB.data.messages.map(row => row.id));
  expect(nextA.data.messages).toHaveLength(2);
  expect(nextA.published + nextB.published).toBe(0);
  const reads = root.meeting.reads;
  expect(await a.exchange(nextA.data)).toMatchObject({ published: 0, added: 0, warnings: [] });
  expect(await b.exchange(nextB.data)).toMatchObject({ published: 0, added: 0, warnings: [] });
  expect(root.meeting.reads).toBe(reads);
  expect(root.meeting.writes).toBe(2);
  expect(root.files.get('议程.json')).toBe('已有文件');
  // If the caller failed to persist a result, or restored an older snapshot, it can replay it.
  const replay = await a.exchange(start);
  expect(replay.added).toBe(2);
  expect(await exportMeetingDelta(replay.data)).toEqual(await exportMeetingDelta(nextA.data));
  expect(replay.published).toBe(0);
});

it('skips other meetings, damaged or incomplete batches and processes healthy packets before retrying', async () => {
  const root = new Directory(), start = await createMeetingStart(createLocalMessageFile());
  const a = new MeetingDirectorySync(root.handle), b = new MeetingDirectorySync(root.handle);
  const first = await speak(start, '甲', '发言甲');
  await a.exchange(first);
  const [name, original] = [...root.meeting.files][0];
  const second = await speak(first, '乙', '发言乙');
  await a.exchange(second);
  root.meeting.files.set(name, original.slice(0, -2));
  root.meeting.files.set('无关.json', '私有文件');
  const partial = await b.exchange(start);
  expect(partial.data.messages.map(row => row.content)).toEqual(['发言乙']);
  expect(partial.warnings).toHaveLength(1);
  root.meeting.files.set(name, original);
  const retry = await b.exchange(partial.data);
  expect(retry.added).toBe(1); expect(retry.warnings).toEqual([]);
  expect(retry.data.messages).toHaveLength(2); expect(retry.published).toBe(0);
  const other = await createMeetingStart(createLocalMessageFile());
  const independent = await new MeetingDirectorySync(root.handle).exchange(other);
  expect(independent.added).toBe(0); expect(root.children.size).toBe(2);
});

it('skips the speech index on an idle scan but detects replacement or deletion of batch files', async () => {
  const root = new Directory(), remote = new Directory(), start = await createMeetingStart(createLocalMessageFile());
  const local = await speak(start, '甲', '甲的发言'), incoming = await speak(start, '乙', '乙的发言');
  const sync = new MeetingDirectorySync(root.handle);
  await sync.exchange(local);
  await sync.exchange(local); // Confirm the published batch is present.
  root.meeting.files.set('会议通知.txt', '开会');
  const indexed = vi.spyOn(Set.prototype, 'add');
  try {
    const idle = await sync.exchange(local);
    expect(idle.data).toBe(local);
    expect(indexed).not.toHaveBeenCalledWith(local.messages[0].id);
  } finally { indexed.mockRestore(); }

  await new MeetingDirectorySync(remote.handle).exchange(incoming);
  const [batch, bytes] = [...remote.meeting.files][0];
  root.meeting.files.clear();
  root.meeting.files.set(batch, bytes); // Same batch count, different contents and filename.
  const replaced = await sync.exchange(local);
  expect(replaced).toMatchObject({ added: 1, published: 1, pending: false });
  // A failed local save must still be able to receive the replacement again.
  const replay = await sync.exchange(local);
  expect(replay).toMatchObject({ added: 1, published: 0 });
  await sync.exchange(replay.data);
  root.meeting.files.clear();
  const removed = await sync.exchange(replay.data);
  expect(removed).toMatchObject({ added: 0, published: 2, pending: false });
});

it('defers replies delivered before their dependencies and recovers from an interrupted local write', async () => {
  const root = new Directory(), start = await createMeetingStart(createLocalMessageFile());
  const writer = new MeetingDirectorySync(root.handle), reader = new MeetingDirectorySync(root.handle);
  expect((await writer.exchange(start)).published).toBe(0);
  const first = await speak(start, '甲', '原发言');
  root.meeting.failClose = true;
  await expect(writer.exchange(first)).rejects.toThrow('已断开');
  expect(root.meeting.writes).toBe(0);
  const waiting = await reader.exchange(start);
  expect(waiting.data).toBe(start); expect(waiting.pending).toBe(true);
  root.meeting.failClose = false;
  await writer.exchange(first);
  const [name, text] = [...root.meeting.files].find(([, content]) => !!content)!;
  const later = await speak(first, '乙', '答复', first.messages[0].id);
  const sent = await writer.exchange(later);
  expect(sent.published).toBe(2);
  root.meeting.files.delete(name);
  const pending = await reader.exchange(start);
  expect(pending.data).toBe(start);
  expect(pending.warnings[0]).toContain('缺少');
  root.meeting.files.set(name, text);
  const retry = await reader.exchange(pending.data);
  expect(retry.added).toBe(3); expect(retry.warnings).toEqual([]); expect(retry.pending).toBe(false);
  expect(root.meeting.writes).toBe(2);
});

it('discards only its own still-empty failed handle even when later speech changes the next packet', async () => {
  const root = new Directory(), start = await createMeetingStart(createLocalMessageFile());
  const writer = new MeetingDirectorySync(root.handle), reader = new MeetingDirectorySync(root.handle);
  const first = await speak(start, '甲', '第一条');
  await writer.exchange(start);
  root.meeting.failClose = true;
  await expect(writer.exchange(first)).rejects.toThrow('断开');
  expect((await reader.exchange(start)).pending).toBe(true);
  root.meeting.failClose = false;
  const later = await speak(first, '甲', '写入失败期间的第二条');
  expect(await writer.exchange(later)).toMatchObject({ published: 2, pending: false });
  expect(root.meeting.files.size).toBe(1);
  expect(await reader.exchange(start)).toMatchObject({ added: 2, pending: false });

  root.meeting.failClose = true;
  const third = await speak(later, '甲', '第三条');
  await expect(writer.exchange(third)).rejects.toThrow('断开');
  const abandoned = [...root.meeting.files].find(([, value]) => value === '')![0];
  root.meeting.failClose = false;
  await root.meeting.removeEntry(abandoned);
  await root.meeting.getFileHandle(abandoned, { create: true }); // An identically named replacement.
  expect(await writer.exchange(third)).toMatchObject({ published: 1, pending: false });
  expect(root.meeting.files.get(abandoned)).toBe('');
});

it('keeps conflicting local records and their replies off the share while sending independent contributions', async () => {
  const root = new Directory(), start = await createMeetingStart(createLocalMessageFile());
  const first = await speak(start, '甲', '共享的内容');
  await new MeetingDirectorySync(root.handle).exchange(first);
  const alternative = structuredClone(first);
  alternative.messages[0].content = '不同的原文';
  (alternative.messages[0].parts![0] as { text: string }).text = '不同的原文';
  const replied = await speak(alternative, '乙', '另外的回复', alternative.messages[0].id);
  const local = await speak(replied, '乙', '独立意见');
  const round = await new MeetingDirectorySync(root.handle).exchange(local);
  expect(round.pending).toBe(true); expect(round.warnings[0]).toContain('不同内容');
  // Both independently valid text contributions may be shared. The conflicting ID and the link stay local.
  expect(round.published).toBe(2); expect(round.data).toBe(local);
  const packets = [...root.meeting.files.values()].map(content => JSON.parse(content));
  expect(packets[1].entries.map((entry: { text: string }) => entry.text)).toEqual(['另外的回复', '独立意见']);

  // Even a correctly checksummed file cannot suppress an ID if any entry is malformed.
  const invalidRoot = new Directory(), subscriber = new MeetingDirectorySync(invalidRoot.handle);
  await subscriber.exchange(start);
  const invalid = JSON.stringify({ ...packets[0], entries: [...packets[0].entries, {}] });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invalid));
  const hex = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  invalidRoot.meeting.files.set(`batch-${crypto.randomUUID()}-${hex}.json`, invalid);
  const retry = await subscriber.exchange(alternative);
  expect(retry.warnings[0]).toContain('无效'); expect(retry.published).toBe(1);
});

it('bounds a catch-up scan without reposting old records and follows up until the new contribution is published', async () => {
  const root = new Directory(), start = await createMeetingStart(createLocalMessageFile());
  const publisher = new MeetingDirectorySync(root.handle);
  let data = start;
  for (let i = 0; i < 20; i++) {
    data = await speak(data, '甲', `发言 ${i}`);
    await publisher.exchange(data);
  }
  const local = await speak(data, '乙', '最新意见'), other = new MeetingDirectorySync(root.handle), before = root.meeting.reads;
  const first = await other.exchange(local);
  expect(root.meeting.reads - before).toBeLessThan(20);
  expect(first).toMatchObject({ added: 0, published: 0, pending: true });
  const second = await other.exchange(first.data);
  expect(second).toMatchObject({ published: 1, pending: false, warnings: [] });
  expect(root.meeting.writes).toBe(21);
});
