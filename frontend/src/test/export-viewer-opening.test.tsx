import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ExportViewerModal from '../components/ExportViewerModal';
import type { ExportData } from '../api/client';
import { loadLastExport, saveLastExport } from '../utils/exportViewerCache';

vi.mock('../utils/exportViewerCache', () => ({ loadLastExport: vi.fn(), saveLastExport: vi.fn() }));

const data: ExportData = {
  formatVersion: 3, exportedAt: '', scope: { messageId: null, title: '相同阅览文件' },
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

beforeEach(() => { vi.mocked(loadLastExport).mockResolvedValue(null); vi.mocked(saveLastExport).mockResolvedValue(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

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
  expect(saveLastExport).toHaveBeenCalledWith(data);
  expect(JSON.parse(screen.getByTestId('location').textContent!)).toEqual({ pathname: '/viewer', state: { exportData: data } });
  expect(screen.queryByRole('dialog')).toBeNull();
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
  await vi.waitFor(()=>expect(saveLastExport).toHaveBeenCalled());
  const converted=vi.mocked(saveLastExport).mock.calls[0][0];
  expect(converted.formatVersion).toBe(3);
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
    expect(saveLastExport).toHaveBeenCalledWith(data);
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
