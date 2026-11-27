import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import OfflineMeetingExchange from '../components/OfflineMeetingExchange';
import * as wpsSync from '../hooks/useWpsMeetingSync';
import { LocalDiscussion } from '../utils/localDiscussion';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { createMeetingStart, exportMeetingDelta, importMeetingDelta } from '../utils/meetingExchange';
import { prepareExportForViewing } from '../utils/exportArchive';
import { blobBytes } from '../utils/streamJsonArchive';
import { downloadExport } from '../utils/saveExport';

vi.mock('../utils/saveExport', () => ({ downloadExport: vi.fn() }));
beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(downloadExport).mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows WPS sync and export without importing local-only records into a cloud discussion', async () => {
  const seed = await createMeetingStart(createLocalMessageFile());
  vi.stubGlobal('showDirectoryPicker', vi.fn());
  const wps = vi.spyOn(wpsSync, 'useWpsMeetingSync').mockReturnValue({ message: 'WPS 会议已连接', failed: false });
  try {
    render(<OfflineMeetingExchange data={seed} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '会议交换' }));
    expect(screen.getByRole('dialog', { name: 'WPS 云文档同步' })).toHaveTextContent('WPS 会议已连接');
    expect(screen.getByRole('button', { name: '导出累计增量' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '连接共享文件夹' })).toBeNull();
    expect(screen.queryByLabelText('导入他人的会议增量')).toBeNull();
  } finally { wps.mockRestore(); }
});

async function speak(source: ExportData, speaker: string, text: string, replyTo?: string) {
  const draft = new LocalDiscussion(source, speaker), msg = await draft.createMessage('root', { content: text });
  if (replyTo) await draft.createRelation('root', { relationType: 'REPLY', sourceMessageId: msg.id,
    targetRefs: [{ kind: 'message', messageId: replyTo }] });
  let saved!: ExportData;
  await draft.commit(async value => { saved = value; });
  return saved;
}

it('reopens the common starting file, merges concurrent speakers in either order and reimports idempotently', async () => {
  const agenda = await speak(createLocalMessageFile(), '发起人', '议题');
  const start = (await prepareExportForViewing(JSON.parse(JSON.stringify(await createMeetingStart(agenda))))).data;
  const a = await speak(start, '甲', '甲的意见', agenda.messages[0].id), b = await speak(start, '乙', '乙的意见');
  const da = await exportMeetingDelta(a), db = await exportMeetingDelta(b);
  expect(da.entries).toHaveLength(2);
  expect(JSON.stringify(da)).not.toContain('议题');
  const ab = await importMeetingDelta(a, db), ba = await importMeetingDelta(b, da);
  expect(ab.added).toBe(1); expect(ba.added).toBe(2);
  expect(await exportMeetingDelta(ab.data)).toEqual(await exportMeetingDelta(ba.data));
  expect(ab.data.messages.map(m => m.content)).toEqual(expect.arrayContaining(['议题', '甲的意见', '乙的意见']));
  expect(ab.data.viewerUsername).toBe('甲');
  expect((await importMeetingDelta(ab.data, db)).data).toBe(ab.data);
  const cumulative = await exportMeetingDelta(ba.data);
  expect((await importMeetingDelta(start, cumulative)).added).toBe(3);
  expect((await importMeetingDelta(ba.data, db)).added).toBe(0);
  expect((await importMeetingDelta(start, { ...cumulative, entries: [...cumulative.entries].reverse() })).added).toBe(3);
});

it('rejects a different meeting, wrong baseline, collisions, invalid payloads and missing dependencies without partial import', async () => {
  const start = await createMeetingStart(createLocalMessageFile());
  const a = await speak(start, '甲', '第一条'), b = await speak(a, '乙', '第二条', a.messages[0].id);
  const delta = await exportMeetingDelta(b), original = JSON.stringify(a);
  const altered = { ...delta.entries[0], text: '换掉正文' };
  await expect(importMeetingDelta(await createMeetingStart(createLocalMessageFile()), delta)).rejects.toThrow('不匹配');
  await expect(importMeetingDelta(a, { ...delta, baseHash: 'wrong' })).rejects.toThrow('不匹配');
  await expect(importMeetingDelta(a, { ...delta, entries: [delta.entries[1], altered] })).rejects.toThrow('不同内容');
  await expect(importMeetingDelta(start, { ...delta, entries: [{ ...delta.entries[0], spending: { wager: 999 } }] })).rejects.toThrow('无效');
  await expect(importMeetingDelta(start, { ...delta, entries: delta.entries.slice(1) })).rejects.toThrow('缺少');
  expect(JSON.stringify(a)).toBe(original);
  const seeded = await createMeetingStart(await speak(createLocalMessageFile(), '甲', '议程'));
  const spoiled = structuredClone(seeded);
  spoiled.messages[0].content = '另一份议程';
  (spoiled.messages[0].parts![0] as { text: string }).text = '另一份议程';
  await expect(prepareExportForViewing(spoiled)).rejects.toThrow('指纹');
});

it('exports only declared local text and verifies visibility before exporting or accepting an operation', async () => {
  const local = await speak(createLocalMessageFile(), '甲', '可分享的文字');
  Object.assign(local, { signatures: ['机密签名'], privateNote: '本机笔记' });
  Object.assign(local.messages[0], { quotedText: '未公开引文', extra: '额外字段' });
  const seed = await createMeetingStart(local);
  expect(JSON.stringify(seed)).not.toMatch(/机密签名|本机笔记|未公开引文|额外字段/);
  Object.assign(local.messages[0], { restricted: true });
  await expect(createMeetingStart(local)).rejects.toThrow('受限');
  const hidden = structuredClone(seed); Object.assign(hidden.messages[0], { moderation: { status: 'rejected' } });
  await expect(exportMeetingDelta(hidden)).rejects.toThrow('受限');
  const draft = new LocalDiscussion(seed, '乙');
  await draft.createRelation('root', { relationType: 'DISAGREE', targetRefs: [{ kind: 'message', messageId: seed.messages[0].id }] });
  const save = vi.fn();
  await expect(draft.commit(save)).rejects.toThrow('本地文字');
  expect(save).not.toHaveBeenCalled();
});

it('restores the displayed reply endpoints from the verified meeting records when opening a manual file', async () => {
  const agenda = await speak(createLocalMessageFile(), '甲', '议题');
  const reply = await speak(agenda, '乙', '回复议题', agenda.messages[0].id);
  const seed = await createMeetingStart(reply);
  const saved = await speak(seed, '丙', '会后的发言');
  const file = structuredClone(saved);
  const wrongSource = file.messages.at(-1)!.id;
  const wrongTarget = [{ kind: 'message', messageId: wrongSource }];
  Object.assign(file.relations[0], { sourceMessageId: wrongSource, targetRefs: wrongTarget });
  Object.assign(file.messages.find(row => row.id === file.relations[0].id)!, { targetRefs: wrongTarget });
  const reopened = (await prepareExportForViewing(file)).data;
  expect(reopened.relations[0]).toMatchObject({ sourceMessageId: reply.messages[1].id,
    targetRefs: [{ messageId: agenda.messages[0].id }] });
  expect(reopened.messages.find(row => row.id === file.relations[0].id)?.targetRefs).toEqual(reopened.relations[0].targetRefs);
  expect(reopened.viewerUsername).toBe('丙');
  expect(await exportMeetingDelta(reopened)).toEqual(await exportMeetingDelta(saved));
});

it('creates a start file through the dialog and reports import success only after a durable save', async () => {
  const empty = createLocalMessageFile(), save = vi.fn<(data: ExportData) => Promise<void>>().mockResolvedValue(undefined);
  const { rerender } = render(<OfflineMeetingExchange data={empty} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: '会议交换' }));
  fireEvent.click(screen.getByRole('button', { name: '生成会议起始文件' }));
  await screen.findByText(/已生成会议起始文件/);
  const seed: ExportData = JSON.parse(new TextDecoder().decode(await blobBytes(vi.mocked(downloadExport).mock.calls[0][0] as Blob)));
  expect(save).not.toHaveBeenCalled();
  rerender(<OfflineMeetingExchange data={seed} onSave={save} />);
  const draft = await speak(seed, '乙', '新意见');
  const file = new File([JSON.stringify(await exportMeetingDelta(draft))], '增量.json');
  const choose = () => fireEvent.change(screen.getByLabelText('导入他人的会议增量'), { target: { files: [file] } });
  save.mockRejectedValueOnce(new Error('文件已在其他标签页修改'));
  choose(); expect(await screen.findByRole('alert')).toHaveTextContent('其他标签页');
  choose(); expect(await screen.findByRole('status')).toHaveTextContent('已合并 1 条新记录');
  rerender(<OfflineMeetingExchange data={save.mock.calls[1][0]} onSave={save} />);
  choose(); expect(await screen.findByText('这份增量的记录已全部导入。')).toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(2);
});
