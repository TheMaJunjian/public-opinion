import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ExportViewerModal from '../components/ExportViewerModal';
import type { ExportData } from '../api/client';
import { loadLastExport, saveLastExport } from '../utils/exportViewerCache';

vi.mock('../utils/exportViewerCache', () => ({ loadLastExport: vi.fn(), saveLastExport: vi.fn() }));

const data: ExportData = {
  formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '相同阅览文件' },
  messages: [{ id: 'm', kind: 'TEXT', contentType: 'TEXT', content: '保存的正文', createdAt: '', author: '甲', authorId: 'a' }],
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
