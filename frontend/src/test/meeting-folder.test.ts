import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { LocalDiscussion } from '../utils/localDiscussion';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { createMeetingStart } from '../utils/meetingExchange';
import { meetingDirectoryName } from '../utils/meetingDirectorySync';
import { createFolderMeeting, listFolderMeetings, openFolderMeeting } from '../utils/meetingFolder';

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const missing = () => new DOMException('not found', 'NotFoundError');
class MemoryFile {
  readonly kind = 'file';
  reads = 0;
  content = new Blob();
  constructor(readonly name: string) {}
  async getFile() { this.reads++; return new File([this.content], this.name); }
  async createWritable() {
    let staged = new Blob();
    return {
      write: async (value: Blob) => { staged = value; },
      close: async () => { this.content = staged; },
      abort: async () => {},
    };
  }
}
class Folder {
  readonly kind = 'directory';
  readonly files = new Map<string, MemoryFile>();
  readonly folders = new Map<string, Folder>();
  constructor(readonly name = '共享文件夹') {}
  get handle() { return this as unknown as FileSystemDirectoryHandle; }
  async *values() {
    yield* this.files.values();
    yield* this.folders.values();
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.folders.has(name)) {
      if (!options?.create) throw missing();
      this.folders.set(name, new Folder(name));
    }
    return this.folders.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw missing();
      this.files.set(name, new MemoryFile(name));
    }
    return this.files.get(name)!;
  }
  async put(name: string, value: unknown) {
    const file = await this.getFileHandle(name, { create: true });
    file.content = new Blob([JSON.stringify(value)]);
    return file;
  }
  childFor(data: ExportData) { return this.folders.get(meetingDirectoryName(data.meeting!.id, data.meeting!.baseHash))!; }
}

async function speak(data: ExportData, text: string) {
  const draft = new LocalDiscussion(data, '主持人');
  await draft.createMessage('root', { content: text });
  let next!: ExportData;
  await draft.commit(async result => { next = result; });
  return next;
}

it('lists names without opening speech files, even when hosts create meetings concurrently with identical names', async () => {
  const root = new Folder();
  const personal = await root.put('私人的材料.json', { unrelated: true });
  const source = await speak(createLocalMessageFile(), '本次议程');
  const [first, second] = await Promise.all([
    createFolderMeeting(root.handle, '  一组 / 会议  ', source),
    createFolderMeeting(root.handle, '一组 / 会议'),
  ]);
  const list = await listFolderMeetings(root.handle);
  expect(new Set(list.map(item => item.id))).toEqual(new Set([first.meeting!.id, second.meeting!.id]));
  expect(list.map(item => item.title)).toEqual(['一组 / 会议', '一组 / 会议']);
  const getStart = (start: ExportData) => root.childFor(start).files.get('start.json')!;
  expect(getStart(first).reads + getStart(second).reads).toBe(0);
  expect(personal.reads).toBe(0);
  const selected = list.find(item => item.id === first.meeting!.id)!;
  expect(await openFolderMeeting(root.handle, selected)).toEqual(first);
  expect(await openFolderMeeting(root.handle, selected)).toEqual(first);
  expect(getStart(second).reads).toBe(0);
  expect(root.folders.size).toBe(2);
});

it('opens a previous manually downloaded start, ignores batches, and prefers the named meeting over a duplicate file', async () => {
  const root = new Folder();
  const start = await createMeetingStart(createLocalMessageFile());
  const original = await root.put(`会议起始-${start.meeting!.id}.json`, start);
  await root.put(`会议增量-${start.meeting!.id}.json`, {});
  const [legacy] = await listFolderMeetings(root.handle);
  expect(legacy).toMatchObject({ id: start.meeting!.id, baseHash: null, createdAt: null });
  expect(original.reads).toBe(0);
  expect(await openFolderMeeting(root.handle, legacy)).toEqual(start);
  const named = await createFolderMeeting(root.handle, '工作会议');
  await root.put(`会议起始-${named.meeting!.id}.json`, named);
  const list = await listFolderMeetings(root.handle);
  expect(list).toHaveLength(2);
  expect(list[0]).toMatchObject({ id: named.meeting!.id, title: '工作会议', baseHash: named.meeting!.baseHash });
});

it('verifies the selected identity, baseline and title and only restores validated public records', async () => {
  const root = new Folder(), source = await speak(createLocalMessageFile(), '初始文字');
  const start = await createFolderMeeting(root.handle, '讨论', source);
  const child = root.childFor(start), [selected] = await listFolderMeetings(root.handle);
  const wrong = await createFolderMeeting(root.handle, '讨论', source);
  await child.put('start.json', wrong);
  await expect(openFolderMeeting(root.handle, selected)).rejects.toThrow('不匹配');
  await child.put('start.json', { ...start, scope: { ...start.scope, title: '其他标题' } });
  await expect(openFolderMeeting(root.handle, selected)).rejects.toThrow('不匹配');
  const tampered = structuredClone(start);
  tampered.messages[0].content = '改写';
  (tampered.messages[0].parts![0] as { text: string }).text = '改写';
  await child.put('start.json', tampered);
  await expect(openFolderMeeting(root.handle, selected)).rejects.toThrow('指纹');
  await child.put('start.json', await speak(start, '创建会议以后的发言'));
  await expect(openFolderMeeting(root.handle, selected)).rejects.toThrow('含会后记录');
  await child.put('start.json', { ...start, users: '坏数据', viewerUsername: '别人的署名', view: false });
  expect(await openFolderMeeting(root.handle, selected)).toEqual(start);
});

it('never advertises an interrupted creation, preserves existing files, and propagates permission failures', async () => {
  const root = new Folder();
  await expect(createFolderMeeting(root.handle, '    ')).rejects.toThrow('会议名称');
  const controller = new AbortController();
  const original = MemoryFile.prototype.createWritable;
  vi.spyOn(MemoryFile.prototype, 'createWritable').mockImplementation(async function (this: MemoryFile) {
    const stream = await original.call(this);
    if (this.name !== 'start.json') return stream;
    return { ...stream, close: async () => { await stream.close(); controller.abort(); } };
  });
  await expect(createFolderMeeting(root.handle, '中断', undefined, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
  expect(await listFolderMeetings(root.handle)).toEqual([]);
  vi.restoreAllMocks();
  const started = await createFolderMeeting(root.handle, '第一次');
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(started.meeting!.id as ReturnType<Crypto['randomUUID']>);
  await expect(createFolderMeeting(root.handle, '意外重号')).rejects.toThrow('已存在');
  const [selected] = await listFolderMeetings(root.handle);
  expect(await openFolderMeeting(root.handle, selected)).toEqual(started);
  const child = root.childFor(started);
  await child.put('meeting.json', { format: 'wrong' });
  expect(await listFolderMeetings(root.handle)).toEqual([]);
  vi.spyOn(child, 'getFileHandle').mockRejectedValue(new DOMException('拒绝访问', 'NotAllowedError'));
  await expect(listFolderMeetings(root.handle)).rejects.toHaveProperty('name', 'NotAllowedError');
});
