import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ExportViewerModal from '../components/ExportViewerModal';
import type { ExportData } from '../api/client';
import { getExportCacheReference, loadCachedExport, loadLastExport, loadLastExportPreview, loadReferencedExport, loadExportNavigation, openFolderMeetingExport, saveLastExport } from '../utils/exportViewerCache';
import { getPreparedViewerExport } from '../utils/exportViewerSession';
import { isZhihuViewingData, prepareZhihuForViewing, updateZhihuRelations } from '../utils/zhihuArchive';
import { createMeetingStart } from '../utils/meetingExchange';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { listFolderMeetings, openFolderMeeting } from '../utils/meetingFolder';
import { takeMeetingDirectory } from '../utils/meetingDirectoryHandoff';

vi.mock('../utils/exportViewerCache', () => ({ loadCachedExport: vi.fn(), loadLastExport: vi.fn(), saveLastExport: vi.fn(),
  loadLastExportPreview: vi.fn(), loadReferencedExport: vi.fn(), loadExportNavigation: vi.fn(), openFolderMeetingExport: vi.fn(),
  getExportCacheReference: vi.fn(() => null), inheritExportCacheReference: (data: ExportData) => data }));
vi.mock('../utils/meetingFolder', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/meetingFolder')>(), listFolderMeetings: vi.fn(), openFolderMeeting: vi.fn(),
}));

const data: ExportData = {
  formatVersion: 5, exportedAt: '', scope: { messageId: null, title: '相同阅览文件' },
  messages: [{ id: 'm', kind: 'TEXT', contentType: 'TEXT', content: '保存的正文', createdAt: '', author: '甲', authorId: 'a',revision:1,parts:[{id:'body',type:'text',text:'保存的正文'}] }],
  relations: [], view: { username: '甲', mode: 'list', classificationId: null,
    messageFilter: { hideJoin: false, hideSettlement: true }, homeFilter: 'read-self', cleanFilters: [] },
};

function Chooser() {
  const [open, setOpen] = useState(true);
  const location = useLocation();
  return <><ExportViewerModal open={open} onClose={() => setOpen(false)} />
    <output data-testid="location">{JSON.stringify({ pathname: location.pathname, state: location.state })}</output></>;
}

beforeEach(() => { vi.mocked(loadExportNavigation).mockResolvedValue(null); vi.mocked(loadLastExportPreview).mockResolvedValue(null); vi.mocked(getExportCacheReference).mockReturnValue(null); vi.mocked(loadCachedExport).mockResolvedValue(null); vi.mocked(loadLastExport).mockResolvedValue(null); vi.mocked(saveLastExport).mockResolvedValue(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function sharedMeetingFolder() {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  const folder = { name: '本机映射的共享文件夹' } as FileSystemDirectoryHandle;
  vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(folder));
  const start = await createMeetingStart(createLocalMessageFile());
  const { id, baseHash } = start.meeting!;
  vi.mocked(listFolderMeetings).mockResolvedValue([{ id, baseHash, title: start.scope.title, createdAt: start.exportedAt }]);
  vi.mocked(openFolderMeeting).mockResolvedValue(start);
  return { folder, start, id };
}

it('offers WPS from the ordinary viewer without starting a connection until a document is selected', async () => {
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  const cloud = screen.getByRole('region', { name: '云文档' });
  const chooseWps = within(cloud).getByText('使用 WPS 云文档');
  fireEvent.click(chooseWps);
  const open = within(cloud).getByRole('button', { name: '打开讨论' });
  expect(open).toBeDisabled();
  fireEvent.change(within(cloud).getByRole('textbox', { name: 'WPS 多维表格分享链接' }), {
    target: { value: 'https://example.com/l/not-wps' },
  });
  fireEvent.click(open);
  expect(await within(cloud).findByRole('alert')).toHaveTextContent('WPS');
  expect(document.querySelector('iframe')).toBeNull();
  expect(openFolderMeetingExport).not.toHaveBeenCalled();
});

it('keeps the viewer open while selecting a WPS link even when the mouse is released on the backdrop', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  await user.click(screen.getByText('使用 WPS 云文档'));
  const dialog = screen.getByRole('dialog', { name: '打开讨论或文件' });
  const backdrop = dialog.closest<HTMLElement>('[data-popup-content-layer]')!;
  const input = within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'WPS 多维表格分享链接' });
  const url = 'https://www.kdocs.cn/l/ca8P1Pr2V8tX';
  fireEvent.change(input, { target: { value: url } });

  await user.pointer([
    { target: input, offset: 0, keys: '[MouseLeft>]' },
    { target: input, offset: url.length },
    { keys: '[/MouseLeft]' },
  ]);
  expect(dialog).toBeVisible();
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(url.length);

  await user.pointer([
    { target: input, offset: 0, keys: '[MouseLeft>]' },
    { target: input, offset: url.length },
    { target: backdrop },
    { keys: '[/MouseLeft]' },
  ]);
  expect(dialog).toBeVisible();
  expect(input).toHaveValue(url);
  await user.pointer([
    { target: backdrop, keys: '[MouseLeft>]' },
    { target: input, keys: '[/MouseLeft]' },
  ]);
  expect(dialog).toBeVisible();
  await user.click(backdrop);
  expect(dialog).not.toBeInTheDocument();
});

it('opens a shared meeting from the viewer chooser with its local revision and an in-memory folder handle', async () => {
  const { folder, start, id } = await sharedMeetingFolder();
  const reference = { archiveId: 'folder-meeting-view', viewCacheId: 'local-view' };
  const stored = { ...start, viewerUsername: '本机署名' };
  vi.mocked(openFolderMeetingExport).mockRejectedValueOnce(new Error('本地缓存暂不可用')).mockResolvedValue(stored);
  vi.mocked(getExportCacheReference).mockReturnValue(reference);
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  const sharedFolder = screen.getByRole('region', { name: '共享文件夹' });
  fireEvent.click(within(sharedFolder).getByRole('button', { name: '选择共享文件夹' }));
  fireEvent.click(await screen.findByRole('button', { name: start.scope.title }));
  expect(await screen.findByRole('alert')).toHaveTextContent('本地缓存暂不可用');
  expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/');
  fireEvent.click(screen.getByRole('button', { name: start.scope.title }));
  await waitFor(() => expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/viewer'));
  const state = JSON.parse(screen.getByTestId('location').textContent!).state;
  expect(state).toEqual({ viewerInstanceKey: expect.any(String), viewerCacheRef: reference });
  expect(getPreparedViewerExport(state.viewerInstanceKey)).toEqual(stored);
  expect(takeMeetingDirectory(state.viewerInstanceKey, id)).toBe(folder);
  expect(takeMeetingDirectory(state.viewerInstanceKey, id)).toBeNull();
  expect(saveLastExport).not.toHaveBeenCalled();
});

it('stays in the viewer chooser when a meeting dialog closes during a slow local cache read', async () => {
  const { start } = await sharedMeetingFolder();
  let finish!: (data: ExportData) => void;
  vi.mocked(openFolderMeetingExport).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '选择共享文件夹' }));
  fireEvent.click(await screen.findByRole('button', { name: start.scope.title }));
  await waitFor(() => expect(openFolderMeetingExport).toHaveBeenCalled());
  fireEvent.keyDown(screen.getByRole('button', { name: '关闭共享文件夹会议' }), { key: 'Escape' });
  await act(async () => { finish(start); });
  expect(screen.queryByRole('dialog', { name: '共享文件夹会议' })).toBeNull();
  expect(screen.getByRole('dialog', { name: '打开讨论或文件' })).toBeVisible();
  expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/');
});

it('creates a new local discussion without choosing a file or logging in', async () => {
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '新建本地消息文件' }));
  await waitFor(() => expect(saveLastExport).toHaveBeenCalledTimes(1));
  expect(vi.mocked(saveLastExport).mock.calls[0][0]).toMatchObject({ format: 'gonglun-view-3', formatVersion: 5,
    scope: { messageId: null, title: '本地讨论' }, messages: [], relations: [] });
  await waitFor(() => expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/viewer'));
});

it.each(['file', 'drop', 'cache'])('paints a waiting dialog before processing %s and opens exactly the saved data', async source => {
  if (source === 'cache') vi.mocked(loadLastExport).mockResolvedValue(data);
  render(<MemoryRouter initialEntries={['/messages']}><Chooser /></MemoryRouter>);
  let button: HTMLElement;
  if (source === 'cache') button = await screen.findByRole('button', { name: /上次阅览：相同阅览文件/ });
  else {
    const file = new File([JSON.stringify(data)], '相同阅览文件.json', { type: 'application/json' });
    if (source === 'drop') fireEvent.drop(screen.getByText('拖拽 JSON 文件到此处').parentElement!, { dataTransfer: { files: [file] } });
    else fireEvent.change(screen.getByLabelText('选择导出文件'), { target: { files: [file] } });
    button = await screen.findByRole('button', { name: '阅览此文件' });
  }
  vi.useFakeTimers();
  vi.mocked(saveLastExport).mockImplementation(async () => {
    expect(screen.getByRole('dialog', { name: '正在加载' })).toBeInTheDocument();
  });
  fireEvent.click(button);
  expect(screen.getByRole('dialog', { name: '正在加载' })).toBeInTheDocument();
  expect(saveLastExport).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(16));
  expect(saveLastExport).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(34); });
  if (source === 'cache') {
    expect(saveLastExport).not.toHaveBeenCalled();
    expect(loadLastExport).toHaveBeenLastCalledWith({ sourceOnly: true, fresh: true, paged: true });
  }
  else expect(saveLastExport).toHaveBeenCalledWith(data, { immutable: true });
  expect(JSON.parse(screen.getByTestId('location').textContent!)).toEqual({ pathname: '/viewer', state: { exportData: data, viewerInstanceKey: expect.any(String) } });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('carries a durable file-cache identity through route state without adding it to the document', async () => {
  const reference = { archiveId: 'native-cache-fixture', viewCacheId: 'view-cache-fixture' };
  vi.mocked(getExportCacheReference).mockReturnValue(reference);
  render(<MemoryRouter initialEntries={['/messages']}><Chooser /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('选择导出文件'), { target: { files: [new File([JSON.stringify(data)], '结构测试.json')] } });
  fireEvent.click(await screen.findByRole('button', { name: '阅览此文件' }));
  await waitFor(() => expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/viewer'));
  const state = JSON.parse(screen.getByTestId('location').textContent!).state;
  expect(state).toEqual({ viewerInstanceKey: expect.any(String), viewerCacheRef: reference });
  expect(getPreparedViewerExport(state.viewerInstanceKey)).toEqual(data);
  expect(data).not.toHaveProperty('viewerCacheRef');
});

it.each(['file','cache'])('automatically converts an old %s without a migration warning or confirmation',async source=>{
  const old={formatVersion:2,topic:{title:'旧讨论'},messages:[{id:'text',kind:'TEXT',content:'原正文',createdAt:'',authorId:'a',author:'甲'}],
    relations:[{id:'follow',relationType:'ATTENTION',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'text'}],payload:{action:'unfollow'},createdAt:'',authorId:'a',author:'甲'}]};
  if(source==='cache')vi.mocked(loadLastExport).mockResolvedValue(old);
  render(<MemoryRouter initialEntries={['/messages']}><Chooser/></MemoryRouter>);
  if(source==='file')fireEvent.change(screen.getByLabelText('选择导出文件'),{target:{files:[new File([JSON.stringify(old)],'旧文件.json',{type:'application/json'})]}});
  const button=await screen.findByRole('button',{name:source==='file'?'阅览此文件':/上次阅览：旧讨论/});
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(button);
  await screen.findByTestId('location');
  await vi.waitFor(()=>expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/viewer'));
  const converted=JSON.parse(screen.getByTestId('location').textContent!).state.exportData;
  if(source==='cache')expect(saveLastExport).not.toHaveBeenCalled();
  else expect(saveLastExport).toHaveBeenCalled();
  expect(converted.formatVersion).toBe(5);
  expect(converted.messages).toHaveLength(2);
  expect(converted.relations[0].payload).toMatchObject({subType:'NO'});
  expect(screen.queryByText(/确认迁移|需要转换/)).toBeNull();
  expect(old.messages[0]).not.toHaveProperty('parts');
});

it.each(['file','cache'])('shows the time, cause and original-data result for a failed %s conversion',async source=>{
  const invalid={formatVersion:99,scope:{messageId:null,title:'新版文件'},messages:[],relations:[]};
  const original=structuredClone(invalid);
  if(source==='cache')vi.mocked(loadLastExport).mockResolvedValue(invalid);
  render(<MemoryRouter><Chooser/></MemoryRouter>);
  if(source==='file')fireEvent.change(screen.getByLabelText('选择导出文件'),{target:{files:[new File([JSON.stringify(invalid)],'无效.json')]}});
  const alert=await screen.findByRole('alert');
  expect(alert).toHaveTextContent('失败时间：');
  expect(alert).toHaveTextContent('文件版本比当前程序更新');
  expect(alert).toHaveTextContent('回滚结果：');
  expect(alert).toHaveTextContent(source==='cache'?'原缓存未修改':'原 JSON 文件和缓存均未修改');
  expect(saveLastExport).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:'阅览此文件'})).toBeNull();
  expect(invalid).toEqual(original);
});

it('shows a cache read error and still permits opening a valid selected file',async()=>{
  vi.mocked(loadLastExport).mockRejectedValue(new Error('缓存损坏'));
  render(<MemoryRouter><Chooser/></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('缓存损坏');
  fireEvent.change(screen.getByLabelText('选择导出文件'),{target:{files:[new File([JSON.stringify(data)],'有效.json')]}});
  fireEvent.click(await screen.findByRole('button',{name:'阅览此文件'}));
  await waitFor(()=>{
    expect(saveLastExport).toHaveBeenCalledWith(data, { immutable: true });
    expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/viewer');
  });
});

it('ignores a cache failure arriving after the chooser has closed',async()=>{
  let rejectCache!:(error:Error)=>void;
  vi.mocked(loadLastExport).mockReturnValue(new Promise((_,reject)=>{rejectCache=reject;}));
  render(<MemoryRouter><Chooser/></MemoryRouter>);
  await vi.waitFor(()=>expect(loadLastExport).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button',{name:'关闭阅览'}));
  await act(async()=>{rejectCache(new Error('迟到的异常'));});
  expect(screen.queryByRole('alert')).toBeNull();
});

it('opens a chosen Zhihu file in the existing viewer without replacing it with cached manual adjustments', async () => {
  const raw = { format: 'gonglun-zhihu-archive', version: 1, items: [{ id: '10', type: 'answer', text: '' }], comments: [
    { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
    { id: '2', sourceId: '2', threadId: 'answer:10', text: '', rootCommentId: '2', parentCommentId: null },
  ] };
  const original = prepareZhihuForViewing(raw);
  const ids = Object.entries(original.zhihu.byMessageId).filter(([, source]) => source.kind === 'comment').map(([id]) => id);
  const cached = updateZhihuRelations(original, { mode: 'sets', sourceMessageIds: [ids[1]], targetMessageIds: [ids[0]] });
  vi.mocked(loadLastExport).mockResolvedValue(cached);
  const fetch = vi.spyOn(globalThis, 'fetch');
  render(<MemoryRouter initialEntries={['/']}><Chooser /></MemoryRouter>);
  const localFiles = screen.getByRole('region', { name: '本地消息文件' });
  expect(within(localFiles).getByText('文件仅在本机读取，不会上传')).toBeInTheDocument();
  expect(within(localFiles).getByText('知乎导入')).toBeInTheDocument();
  const resume = await screen.findByRole('button', { name: /上次阅览/ });
  expect(localFiles).not.toContainElement(resume);
  expect(screen.getByRole('region', { name: '共享文件夹' })).not.toContainElement(resume);
  fireEvent.change(screen.getByLabelText('选择导出文件'), { target: { files: [new File([JSON.stringify(raw)], '知乎导出.json', { type: 'application/json' })] } });
  fireEvent.click(await screen.findByRole('button', { name: '阅览此文件' }));
  await waitFor(() => expect(saveLastExport).toHaveBeenCalled());
  const chosen = vi.mocked(saveLastExport).mock.calls[0][0];
  expect(isZhihuViewingData(chosen)).toBe(true);
  if (!isZhihuViewingData(chosen)) throw new Error('Expected Zhihu display data');
  expect(chosen.zhihu.overrides.revisions).toHaveLength(0);
  expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/viewer');
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});

it('rereads Zhihu changes made in another tab before reopening cached data and never writes back its stale preview', async () => {
  const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [{ id: '10', type: 'answer', text: '' }], comments: [
    { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
    { id: '2', sourceId: '2', threadId: 'answer:10', text: '', rootCommentId: '2', parentCommentId: null },
  ] });
  const ids = Object.entries(original.zhihu.byMessageId).filter(([, source]) => source.kind === 'comment').map(([id]) => id);
  const latest = updateZhihuRelations(original, { mode: 'sets', sourceMessageIds: [ids[1]], targetMessageIds: [ids[0]] });
  vi.mocked(loadLastExport).mockResolvedValue(original);
  vi.mocked(loadCachedExport).mockResolvedValue(latest);
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /上次阅览/ }));
  await waitFor(() => expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/viewer'));
  expect(loadCachedExport).toHaveBeenCalledWith(original.zhihu.archiveId, { fresh: true, sourceOnly: true });
  expect(saveLastExport).not.toHaveBeenCalled();
  expect(JSON.parse(screen.getByTestId('location').textContent!).state.exportData).toEqual(latest);
  expect(JSON.parse(screen.getByTestId('location').textContent!).state.viewerNavigation).toBeUndefined();
});

it.each([null, 'saved-category'])('shows a cached title without loading its bodies, then restores the actual last classification (%s)', async classificationId => {
  const reference = { archiveId: 'native-preview', viewCacheId: 'native-view' };
  const native = { ...data, format: 'gonglun-view-3' as const,
    source: { provider: 'zhihu' as const, version: 1, ownerId: 'fixture', ownerUrl: null, scope: 'collections' as const },
    view: { ...data.view!, classificationId: 'saved-category', username: '本地整理者' } };
  vi.mocked(loadLastExportPreview).mockResolvedValue({ title: data.scope.title, reference });
  vi.mocked(loadReferencedExport).mockResolvedValue(native);
  vi.mocked(loadExportNavigation).mockResolvedValue({ classificationId });
  vi.mocked(getExportCacheReference).mockReturnValue(reference);
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  const button = await screen.findByRole('button', { name: /上次阅览/ });
  expect(loadLastExport).not.toHaveBeenCalled();
  expect(loadReferencedExport).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/viewer'));
  const state = JSON.parse(screen.getByTestId('location').textContent!).state;
  expect(state).toEqual({ viewerInstanceKey: expect.any(String), viewerCacheRef: reference, viewerNavigation: { classificationId } });
  expect(getPreparedViewerExport(state.viewerInstanceKey)).toBe(native);
  expect(loadReferencedExport).toHaveBeenCalledTimes(1);
  expect(loadReferencedExport).toHaveBeenCalledWith(reference, { sourceOnly: true, paged: true });
  expect(saveLastExport).not.toHaveBeenCalled();
  expect(native.view.classificationId).toBe('saved-category');
});
