import { act, fireEvent, render, screen } from '@testing-library/react';
import { Profiler, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LeaderboardModal from '../components/LeaderboardModal';
import type { DemoMessage } from '../utils/modelBridge';
import type { User } from '../types';
import { LEADERBOARD_PREFERENCES_KEY } from '../utils/leaderboardPreferences';
import * as leaderboardMetrics from '../utils/leaderboardMetrics';

beforeEach(() => { localStorage.removeItem(LEADERBOARD_PREFERENCES_KEY); });
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(LEADERBOARD_PREFERENCES_KEY); });

const users: User[] = ['alice', 'bob'].map(username => ({ id: `user-${username}`, username, createdAt: '' }));
const message = (id: string, author: string, kind: DemoMessage['kind'] = 'normal'): DemoMessage => ({
  id, author, kind, createdAt: '2026-10-19T00:00:00Z', content: id,
});
const messages = [message('text-a', 'alice'), message('reply-a', 'alice', 'relation'), message('proposal-a', 'alice', 'governance'),
  message('text-b', 'bob'), message('join-a', 'alice', 'join'), message('round-a', 'alice', 'round'), message('result-a', 'alice', 'round_result')];
const stakes = {
  'text-a': { truth: { pro: 8, con: 2 }, value: { pro: 1, con: 1 } },
  'reply-a': { truth: { pro: 3, con: 7 }, value: { pro: 10, con: 0 } },
  'text-b': { truth: { pro: 2, con: 0 }, value: { pro: 0, con: 0 } },
};

function setup() {
  const onRefresh = vi.fn();
  const onClose = vi.fn();
  const props = { open: true, onClose, onRefresh, messages, edges: [], relations: [], users, stakeCounts: stakes,
    messageBettorCounts: { 'text-a': 2, 'reply-a': 3, 'text-b': 1 } };
  const view = render(<LeaderboardModal {...props} />);
  return { ...view, props, onRefresh, onClose };
}

const rows = () => Array.from((screen.getByRole('table') as HTMLTableElement).tBodies[0].rows);
const cells = (row: HTMLTableRowElement) => Array.from(row.cells).map(cell => cell.textContent);
const pointer = (type: string, clientX: number, clientY = 0) => Object.assign(new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true }), { pointerId: 1 });

describe('排行榜', () => {
  it('打开和关闭重开不重复读写设置，只有设置变化时才保存', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const { rerender, props } = setup();
    const initialReads = read.mock.calls.filter(([key]) => key === LEADERBOARD_PREFERENCES_KEY).length;
    expect(write).not.toHaveBeenCalled();
    for (let index = 0; index < 3; index++) {
      rerender(<LeaderboardModal {...props} open={false} />);
      expect(screen.queryByRole('dialog', { name: '排行榜' })).toBeNull();
      expect(document.querySelector('[data-popup-overlay]')).toBeNull();
      rerender(<LeaderboardModal {...props} />);
    }
    expect(read.mock.calls.filter(([key]) => key === LEADERBOARD_PREFERENCES_KEY)).toHaveLength(initialReads);
    fireEvent.click(screen.getByRole('button', { name: '重置列宽' }));
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整排名列宽' }), { key: 'Home' });
    expect(write).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: '每页条数' }), { target: { value: 50 } });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('严格模式的重复挂载检查不写入未修改的设置', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const { props, unmount } = setup();
    unmount();
    write.mockClear();
    render(<StrictMode><LeaderboardModal {...props} /></StrictMode>);
    expect(write).not.toHaveBeenCalled();
  });

  it('排序、筛选、翻页和关闭重开复用统计；关闭期间暂停计算，重开显示最新数据', () => {
    const metrics = vi.spyOn(leaderboardMetrics, 'buildLeaderboardMetrics');
    const classify = vi.spyOn(leaderboardMetrics, 'isTextMessage');
    const { props, rerender } = setup();
    const initialMetrics = metrics.mock.calls.length;
    const initialClassifications = classify.mock.calls.length;
    fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: 'textMessageCount' } });
    fireEvent.click(screen.getByRole('button', { name: '降序' }));
    fireEvent.change(screen.getByPlaceholderText('搜索与会者ID/与会者'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByRole('combobox', { name: '每页条数' }), { target: { value: 50 } });
    expect(classify).toHaveBeenCalledTimes(initialClassifications);
    rerender(<LeaderboardModal {...props} open={false} />);
    rerender(<LeaderboardModal {...props} />);
    expect(metrics).toHaveBeenCalledTimes(initialMetrics);
    expect(screen.getByPlaceholderText('搜索与会者ID/与会者')).toHaveValue('alice');
    expect(screen.getByRole('combobox', { name: '排序条件' })).toHaveValue('textMessageCount');
    rerender(<LeaderboardModal {...props} open={false} />);
    const updatedMessages = [...messages, message('new-text', 'alice')];
    rerender(<LeaderboardModal {...props} open={false} messages={updatedMessages} />);
    expect(metrics).toHaveBeenCalledTimes(initialMetrics);
    rerender(<LeaderboardModal {...props} messages={updatedMessages} />);
    expect(metrics).toHaveBeenCalledTimes(initialMetrics + 1);
    expect(cells(rows()[0]).slice(4, 7)).toEqual(['7', '2', '5']);
  });

  it('消息榜重新排序不重新生成所有消息摘要', () => {
    const { props, rerender } = setup();
    const preview = vi.fn(() => '测试消息摘要');
    const records = [{ ...message('observed', 'alice'), get content() { return preview(); } }];
    rerender(<LeaderboardModal {...props} messages={records} />);
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    const initialPreviews = preview.mock.calls.length;
    fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: 'bettors' } });
    fireEvent.click(screen.getByRole('button', { name: '降序' }));
    expect(preview).toHaveBeenCalledTimes(initialPreviews);
  });

  it('相同窗口宽度的观察通知不重复刷新，关闭后释放全部观察器', () => {
    const observers: { callback: () => void; targets: Element[]; disconnect: ReturnType<typeof vi.fn<() => void>> }[] = [];
    const original = window.ResizeObserver;
    window.ResizeObserver = class {
      entry: typeof observers[number];
      constructor(callback: () => void) {
        this.entry = { callback, targets: [], disconnect: vi.fn() };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve() {}
      disconnect() { this.entry.disconnect(); }
    } as unknown as typeof ResizeObserver;
    const { props, unmount } = setup();
    unmount();
    const commits = vi.fn();
    const view = render(<Profiler id="measurement" onRender={commits}><LeaderboardModal {...props} /></Profiler>);
    try {
      const viewport = screen.getByRole('region', { name: '排行榜窗口区域' });
      vi.spyOn(viewport, 'clientWidth', 'get').mockReturnValue(900);
      const observer = observers.find(entry => entry.targets.includes(viewport))!;
      act(observer.callback);
      const changedCommits = commits.mock.calls.length;
      for (let index = 0; index < 10; index++) act(observer.callback);
      expect(commits).toHaveBeenCalledTimes(changedCommits);
      view.rerender(<Profiler id="measurement" onRender={commits}><LeaderboardModal {...props} open={false} /></Profiler>);
      expect(observers.every(entry => entry.disconnect.mock.calls.length === 1)).toBe(true);
    } finally {
      view.unmount();
      window.ResizeObserver = original;
    }
  });

  it('名称列去掉名字并沿用此前保存的列宽，新名称设置优先', () => {
    localStorage.setItem(LEADERBOARD_PREFERENCES_KEY, JSON.stringify({ columnWidths: {
      user: { '与会者名': 196 }, message: { '议事人名': 180, '议事人': 220 },
    } }));
    setup();
    expect(screen.getByRole('columnheader', { name: '与会者' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: '调整与会者列宽' })).toHaveAttribute('aria-valuenow', '196');
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(screen.getByRole('columnheader', { name: '议事人' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: '调整议事人列宽' })).toHaveAttribute('aria-valuenow', '220');
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整议事人列宽' }), { key: 'ArrowRight' });
    const saved = JSON.parse(localStorage.getItem(LEADERBOARD_PREFERENCES_KEY)!);
    expect(saved.columnWidths.user['与会者']).toBe(196);
    expect(saved.columnWidths.message['议事人']).toBe(236);
    expect(saved.columnWidths.user['与会者名']).toBeUndefined();
    expect(saved.columnWidths.message['议事人名']).toBeUndefined();
  });

  it('消息超过 80 条仍能分页查看，排序和筛选对全部记录生效，排名跨页连续', () => {
    const { rerender, props } = setup();
    const records = Array.from({ length: 105 }, (_, index) => message(`bulk-${String(index).padStart(3, '0')}`, 'alice'));
    rerender(<LeaderboardModal {...props} messages={records} stakeCounts={Object.fromEntries(records.map((record, index) => [record.id, {
      truth: { pro: index + 1, con: 0 }, value: { pro: 0, con: 0 },
    }]))} />);
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(rows()).toHaveLength(20);
    expect(cells(rows()[0]).slice(0, 2)).toEqual(['1', 'bulk-104']);
    expect(screen.getByRole('status')).toHaveTextContent('共 105 条 · 第 1–20 条');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(cells(rows()[0]).slice(0, 2)).toEqual(['21', 'bulk-084']);
    fireEvent.click(screen.getByRole('button', { name: '末页' }));
    expect(rows()).toHaveLength(5);
    expect(cells(rows()[0]).slice(0, 2)).toEqual(['101', 'bulk-004']);
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '降序' }));
    expect(cells(rows()[0]).slice(0, 2)).toEqual(['1', 'bulk-000']);
    fireEvent.click(screen.getByRole('button', { name: '末页' }));
    fireEvent.change(screen.getByPlaceholderText('搜索消息ID/议事人ID/议事人'), { target: { value: 'bulk-104' } });
    expect(rows()).toHaveLength(1);
    expect(cells(rows()[0]).slice(0, 2)).toEqual(['1', 'bulk-104']);
    fireEvent.change(screen.getByPlaceholderText('搜索消息ID/议事人ID/议事人'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '末页' }));
    fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: 'netSupportRate' } });
    expect(cells(rows()[0])[0]).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: '末页' }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: 100 } });
    expect(rows()).toHaveLength(6);
    expect(cells(rows()[0])[0]).toBe('1');
  });

  it('两榜分别保留页码，每页数量可调，数据减少与空结果时页码保持有效', () => {
    const { rerender, props } = setup();
    const people = Array.from({ length: 45 }, (_, index) => ({ id: `u-${index}`, username: `name-${index}`, createdAt: '' }));
    const records = Array.from({ length: 105 }, (_, index) => message(`bulk-${index}`, people[index % people.length].username));
    const largeProps = { ...props, users: people, messages: records };
    rerender(<LeaderboardModal {...largeProps} />);
    expect(rows()).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(cells(rows()[0])[0]).toBe('21');
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    fireEvent.click(screen.getByRole('button', { name: '末页' }));
    fireEvent.click(screen.getByRole('button', { name: '人榜' }));
    expect(cells(rows()[0])[0]).toBe('21');
    fireEvent.change(screen.getByRole('combobox', { name: '每页条数' }), { target: { value: 50 } });
    expect(rows()).toHaveLength(45);
    expect(cells(rows()[0])[0]).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(rows()).toHaveLength(50);
    expect(cells(rows()[0])[0]).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: '末页' }));
    expect(cells(rows()[0])[0]).toBe('101');
    rerender(<LeaderboardModal {...largeProps} messages={records.slice(0, 5)} />);
    expect(rows()).toHaveLength(5);
    expect(cells(rows()[0])[0]).toBe('1');
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('搜索消息ID/议事人ID/议事人'), { target: { value: 'missing' } });
    expect(rows()).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('共 0 条 · 第 0–0 条');
    expect(screen.getByText('未找到符合条件的记录')).toBeInTheDocument();
    for (const name of ['首页', '上一页', '下一页', '末页']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('可拖动和用键盘调整列宽，两榜独立保留宽度并支持恢复', () => {
    setup();
    const handle = screen.getByRole('separator', { name: '调整与会者列宽' });
    fireEvent(handle, pointer('pointerdown', 100));
    fireEvent(handle, pointer('pointermove', 180));
    fireEvent(handle, pointer('pointerup', 180));
    expect(handle).toHaveAttribute('aria-valuenow', '200');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '184');
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    const messageHandle = screen.getByRole('separator', { name: '调整议事人列宽' });
    fireEvent.keyDown(messageHandle, { key: 'ArrowRight' });
    expect(messageHandle).toHaveAttribute('aria-valuenow', '136');
    fireEvent.click(screen.getByRole('button', { name: '人榜' }));
    expect(screen.getByRole('separator', { name: '调整与会者列宽' })).toHaveAttribute('aria-valuenow', '184');
    fireEvent.doubleClick(screen.getByRole('separator', { name: '调整与会者列宽' }));
    expect(screen.getByRole('separator', { name: '调整与会者列宽' })).toHaveAttribute('aria-valuenow', '120');
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(screen.getByRole('separator', { name: '调整议事人列宽' })).toHaveAttribute('aria-valuenow', '136');
    fireEvent.click(screen.getByRole('button', { name: '重置列宽' }));
    expect(screen.getByRole('separator', { name: '调整议事人列宽' })).toHaveAttribute('aria-valuenow', '120');
    const minHandle = screen.getByRole('separator', { name: '调整排名列宽' });
    fireEvent.keyDown(minHandle, { key: 'ArrowLeft' });
    expect(minHandle).toHaveAttribute('aria-valuenow', '48');
  });

  it.each(['人榜', '消息榜'])('%s连续拖动列宽只预览，松手仅保存一次，重开恢复最终宽度', tabName => {
    const { unmount, props } = setup();
    unmount();
    const onRender = vi.fn();
    const view = render(<Profiler id="column-resize" onRender={onRender}><LeaderboardModal {...props} /></Profiler>);
    fireEvent.click(screen.getByRole('button', { name: tabName }));
    const label = tabName === '人榜' ? '与会者' : '消息摘要';
    const handle = screen.getByRole('separator', { name: `调整${label}列宽` });
    const dialog = screen.getByRole('dialog', { name: '排行榜' });
    const table = screen.getByRole('table');
    const initialWidth = Number(handle.getAttribute('aria-valuenow'));
    const initialDialogWidth = parseFloat(dialog.style.width);
    const initialTableWidth = parseFloat(table.style.width);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent(handle, pointer('pointerdown', 100));
    const initialCommits = onRender.mock.calls.length;
    for (let step = 1; step <= 30; step++) fireEvent(handle, pointer('pointermove', 100 + step * 4));
    expect(handle).toHaveAttribute('aria-valuenow', String(initialWidth + 120));
    expect(parseFloat(table.style.width)).toBe(initialTableWidth + 120);
    expect(parseFloat(dialog.style.width)).toBe(initialDialogWidth + 120);
    expect(onRender).toHaveBeenCalledTimes(initialCommits);
    expect(storage).not.toHaveBeenCalled();
    fireEvent(handle, pointer('pointerup', 220));
    fireEvent.lostPointerCapture(handle);
    expect(storage).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveStyle({ margin: 'auto' });
    const saved = JSON.parse(localStorage.getItem(LEADERBOARD_PREFERENCES_KEY)!);
    expect(saved.columnWidths[tabName === '人榜' ? 'user' : 'message'][label]).toBe(initialWidth + 120);
    view.unmount();
    render(<LeaderboardModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: tabName }));
    expect(screen.getByRole('separator', { name: `调整${label}列宽` })).toHaveAttribute('aria-valuenow', String(initialWidth + 120));
  });

  it('手动窗口拖动列宽不改变窗口尺寸，取消或丢失捕获时也只提交一次', () => {
    localStorage.setItem(LEADERBOARD_PREFERENCES_KEY, JSON.stringify({ windowSize: { width: 640, height: 400 } }));
    setup();
    const handle = screen.getByRole('separator', { name: '调整与会者列宽' });
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent(handle, pointer('pointerdown', 100));
    fireEvent(handle, pointer('pointermove', 180));
    expect(screen.getByRole('dialog', { name: '排行榜' })).toHaveStyle({ width: '640px', height: '400px' });
    expect(storage).not.toHaveBeenCalled();
    fireEvent.pointerCancel(handle);
    fireEvent.lostPointerCapture(handle);
    fireEvent(handle, pointer('pointerup', 180));
    expect(storage).toHaveBeenCalledTimes(1);
    expect(handle).toHaveAttribute('aria-valuenow', '200');
  });

  it('拖回原列宽或未拖动时不保存，调整过程中切换榜单不会留下预览尺寸', () => {
    setup();
    const handle = screen.getByRole('separator', { name: '调整与会者列宽' });
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent(handle, pointer('pointerdown', 100));
    fireEvent(handle, pointer('pointerup', 100));
    fireEvent(handle, pointer('pointerdown', 100));
    fireEvent(handle, pointer('pointermove', 180));
    fireEvent(handle, pointer('pointermove', 100));
    fireEvent(handle, pointer('pointerup', 100));
    expect(storage).not.toHaveBeenCalled();
    expect(handle).toHaveAttribute('aria-valuenow', '120');
    fireEvent(handle, pointer('pointerdown', 100));
    fireEvent(handle, pointer('pointermove', 180));
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(screen.getByRole('dialog', { name: '排行榜' })).toHaveStyle({ margin: 'auto' });
    fireEvent.click(screen.getByRole('button', { name: '人榜' }));
    expect(screen.getByRole('separator', { name: '调整与会者列宽' })).toHaveAttribute('aria-valuenow', '120');
    expect(storage).not.toHaveBeenCalled();
  });

  it('手动调整宽高后切换榜单保留尺寸，自适应窗口可恢复自动尺寸', () => {
    localStorage.setItem(LEADERBOARD_PREFERENCES_KEY, JSON.stringify({ windowSize: { width: 640, height: 400 } }));
    setup();
    const dialog = screen.getByRole('dialog', { name: '排行榜' });
    expect(dialog).toHaveStyle({ width: '640px', height: '400px' });
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(dialog).toHaveStyle({ width: '640px', height: '400px' });
    fireEvent.click(screen.getByRole('button', { name: '自适应窗口' }));
    expect(dialog).toHaveStyle({ height: 'auto', margin: 'auto' });
    const width = parseFloat(dialog.style.width);
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整消息摘要列宽' }), { key: 'ArrowRight' });
    expect(parseFloat(dialog.style.width)).toBe(width + 16);
    expect(JSON.parse(localStorage.getItem(LEADERBOARD_PREFERENCES_KEY)!).windowSize).toBeNull();
    expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled();
  });

  it('右下角只按下或轻微抖动不改变布局、不刷新或保存设置', () => {
    const { props, unmount } = setup();
    unmount();
    const commits = vi.fn();
    render(<Profiler id="resize-click" onRender={commits}><LeaderboardModal {...props} /></Profiler>);
    const dialog = screen.getByRole('dialog', { name: '排行榜' });
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 100, 640, 400));
    const originalStyle = dialog.getAttribute('style');
    const resizer = screen.getByRole('separator', { name: '调整排行榜宽高' });
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const initialCommits = commits.mock.calls.length;
    fireEvent(resizer, pointer('pointerdown', 840, 500));
    expect(dialog.getAttribute('style')).toBe(originalStyle);
    fireEvent(resizer, pointer('pointermove', 842, 501));
    expect(dialog.getAttribute('style')).toBe(originalStyle);
    fireEvent(resizer, pointer('pointerup', 842, 501));
    fireEvent.lostPointerCapture(resizer);
    expect(commits).toHaveBeenCalledTimes(initialCommits);
    expect(storage).not.toHaveBeenCalled();
  });

  it.each(['pointercancel', 'lostpointercapture'])('%s恢复拖动前的自适应布局，不遗留手动预览或保存尺寸', type => {
    setup();
    const dialog = screen.getByRole('dialog', { name: '排行榜' });
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 100, 640, 400));
    const originalStyle = dialog.getAttribute('style');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const resizer = screen.getByRole('separator', { name: '调整排行榜宽高' });
    fireEvent(resizer, pointer('pointerdown', 840, 500));
    fireEvent(resizer, pointer('pointermove', 940, 560));
    expect(dialog).toHaveAttribute('data-leaderboard-sizing', 'manual');
    fireEvent(resizer, pointer(type, 940, 560));
    fireEvent(resizer, pointer('pointerup', 940, 560));
    expect(dialog.getAttribute('style')).toBe(originalStyle);
    expect(dialog).toHaveAttribute('data-leaderboard-sizing', 'auto');
    expect(storage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '自适应窗口' }));
    expect(dialog.getAttribute('style')).toBe(originalStyle);
  });

  it('调整后自动保存两榜列宽、每页数量和窗口尺寸，重新挂载后恢复，松开拖动后居中', () => {
    const { unmount, props } = setup();
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整与会者列宽' }), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整消息摘要列宽' }), { key: 'ArrowRight' });
    fireEvent.change(screen.getByRole('combobox', { name: '每页条数' }), { target: { value: 50 } });
    const dialog = screen.getByRole('dialog', { name: '排行榜' });
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 100, 640, 400));
    const resizer = screen.getByRole('separator', { name: '调整排行榜宽高' });
    fireEvent(resizer, pointer('pointerdown', 840, 500));
    fireEvent(resizer, pointer('pointermove', 940, 560));
    expect(dialog).toHaveStyle({ width: '740px', height: '460px' });
    expect(dialog.style.margin).not.toBe('auto');
    fireEvent(resizer, pointer('pointerup', 940, 560));
    expect(dialog).toHaveStyle({ margin: 'auto' });
    unmount();
    render(<LeaderboardModal {...props} />);
    expect(screen.getByRole('dialog', { name: '排行榜' })).toHaveStyle({ width: '740px', height: '460px', margin: 'auto' });
    expect(screen.getByRole('combobox', { name: '每页条数' })).toHaveValue('50');
    expect(screen.getByRole('separator', { name: '调整与会者列宽' })).toHaveAttribute('aria-valuenow', '136');
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(screen.getByRole('separator', { name: '调整消息摘要列宽' })).toHaveAttribute('aria-valuenow', '296');
    fireEvent.click(screen.getByRole('button', { name: '重置列宽' }));
    expect(JSON.parse(localStorage.getItem(LEADERBOARD_PREFERENCES_KEY)!).columnWidths.message['消息摘要']).toBe(280);
  });

  it('连续拖动只预览尺寸，松开时统一更新和保存，重开恢复最终尺寸', () => {
    const { unmount, props } = setup();
    unmount();
    const onRender = vi.fn();
    const view = render(<Profiler id="leaderboard" onRender={onRender}><LeaderboardModal {...props} /></Profiler>);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const dialog = screen.getByRole('dialog', { name: '排行榜' });
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 100, 640, 400));
    const resizer = screen.getByRole('separator', { name: '调整排行榜宽高' });
    fireEvent(resizer, pointer('pointerdown', 840, 500));
    const initialCommits = onRender.mock.calls.length;
    for (let step = 1; step <= 30; step++) fireEvent(resizer, pointer('pointermove', 840 + step * 4, 500 + step * 2));
    expect(dialog).toHaveStyle({ width: '760px', height: '460px' });
    expect(onRender).toHaveBeenCalledTimes(initialCommits);
    expect(storage).not.toHaveBeenCalled();
    fireEvent(resizer, pointer('pointerup', 960, 560));
    fireEvent.lostPointerCapture(resizer);
    expect(storage).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveStyle({ margin: 'auto' });
    expect(JSON.parse(localStorage.getItem(LEADERBOARD_PREFERENCES_KEY)!).windowSize).toEqual({ width: 760, height: 460 });
    view.unmount();
    render(<LeaderboardModal {...props} />);
    expect(screen.getByRole('dialog', { name: '排行榜' })).toHaveStyle({ width: '760px', height: '460px', margin: 'auto' });
  });

  it('保存的大窗口可超过可视区域，外层提供滚动，恢复自适应后下次仍按内容布局', () => {
    const size = { width: window.innerWidth + 500, height: window.innerHeight + 500 };
    localStorage.setItem(LEADERBOARD_PREFERENCES_KEY, JSON.stringify({ windowSize: size, pageSize: 100 }));
    const { unmount, props } = setup();
    expect(screen.getByRole('dialog', { name: '排行榜' })).toHaveStyle({ width: `${size.width}px`, height: `${size.height}px` });
    expect(screen.getByRole('region', { name: '排行榜窗口区域' })).toHaveStyle({ overflow: 'auto' });
    fireEvent.click(screen.getByRole('button', { name: '自适应窗口' }));
    unmount();
    render(<LeaderboardModal {...props} />);
    expect(screen.getByRole('dialog', { name: '排行榜' })).toHaveStyle({ height: 'auto' });
    expect(screen.getByRole('combobox', { name: '每页条数' })).toHaveValue('100');
  });

  it('保存数据异常或浏览器禁止存储时仍能正常打开、调整和关闭', () => {
    localStorage.setItem(LEADERBOARD_PREFERENCES_KEY, JSON.stringify({ pageSize: -1, windowSize: { width: '100%', height: null }, columnWidths: { user: { '与会者名': -10 }, message: null } }));
    const { unmount, props } = setup();
    expect(screen.getByRole('combobox', { name: '每页条数' })).toHaveValue('20');
    expect(screen.getByRole('separator', { name: '调整与会者列宽' })).toHaveAttribute('aria-valuenow', '120');
    expect(screen.getByRole('dialog', { name: '排行榜' })).toHaveStyle({ height: 'auto' });
    unmount();
    localStorage.setItem(LEADERBOARD_PREFERENCES_KEY, '{invalid json');
    const invalidView = render(<LeaderboardModal {...props} />);
    expect(screen.getByRole('combobox', { name: '每页条数' })).toHaveValue('20');
    invalidView.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    render(<LeaderboardModal {...props} />);
    fireEvent.change(screen.getByRole('combobox', { name: '每页条数' }), { target: { value: 50 } });
    expect(screen.getByRole('combobox', { name: '每页条数' })).toHaveValue('50');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('总数拆分为文本数与关系数，加入和结算均计入，刷新后重新排名', () => {
    const { rerender, props, onRefresh, onClose } = setup();
    expect(cells(rows()[0]).slice(2, 7)).toEqual(['alice', '0', '6', '1', '5']);
    expect(cells(rows()[1]).slice(2, 7)).toEqual(['bob', '0', '1', '1', '0']);
    expect(screen.getByRole('columnheader', { name: '发送消息总数' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '文本消息数' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '关系消息数' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(onRefresh).toHaveBeenCalledOnce();
    rerender(<LeaderboardModal {...props} messages={[...messages, ...messages.slice(-3), ...Array.from({ length: 6 }, (_, i) => message(`new-${i}`, 'bob', 'relation'))]} />);
    expect(cells(rows()[0])[2]).toBe('bob');
    for (const row of rows()) {
      const values = cells(row).map(Number);
      expect(values[4]).toBe(values[5] + values[6]);
    }
    expect(cells(rows()[1]).slice(4, 7)).toEqual(['6', '1', '5']);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('消息榜包含关系消息，汇总押注、净支持率、人数与激烈度，并支持 ID 搜索', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(rows()).toHaveLength(7);
    expect(cells(rows()[0])).toEqual(['1', 'reply-a', 'reply-a', 'alice', '20', '10', '0', '-40.00', '0', '0', '6', '3', '23.00', 'user-alice']);
    const headers = Array.from((screen.getByRole('table') as HTMLTableElement).tHead!.rows[0].cells).map(cell => cell.textContent);
    expect(headers.slice(0, 5)).toEqual(['#', '消息ID', '消息摘要', '议事人', '被押注总点']);
    expect(headers.at(-1)).toBe('议事人ID');
    expect(screen.getByRole('columnheader', { name: '议事人ID' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '议事人' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '消息ID' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '押注人数' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '按押注人数' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('搜索消息ID/议事人ID/议事人'), { target: { value: ' REPLY-A ' } });
    expect(rows()).toHaveLength(1);
    expect(cells(rows()[0])[1]).toBe('reply-a');
    fireEvent.change(screen.getByPlaceholderText('搜索消息ID/议事人ID/议事人'), { target: { value: ' USER-BOB ' } });
    expect(rows()).toHaveLength(1);
    expect(cells(rows()[0]).slice(1, 4)).toEqual(['text-b', 'text-b', 'bob']);
    expect(cells(rows()[0]).at(-1)).toBe('user-bob');
    fireEvent.change(screen.getByPlaceholderText('搜索消息ID/议事人ID/议事人'), { target: { value: 'ALICE' } });
    expect(rows()).toHaveLength(6);
  });

  it('文本数和关系数可分别排序，结算记录归入触发用户的关系数', () => {
    const { rerender, props } = setup();
    rerender(<LeaderboardModal {...props} messages={[
      ...messages.filter(item => !['round', 'round_result'].includes(item.kind)),
      message('text-b2', 'bob'), message('text-b3', 'bob'),
      { ...message('round-a', '公论规则', 'round'), authorId: 'system', roundPayload: { roundId: 'round-a', openedBy: users[0].id } },
      { ...message('result-a', '公论规则', 'round_result'), authorId: 'system', parts: [{ id: 'allocation', type: 'data', value: {
        source: 'wager', inputs: { roundId: 'round-a' }, allocations: [],
      } }] },
    ]} />);
    expect(cells(rows()[0]).slice(2, 7)).toEqual(['alice', '0', '6', '1', '5']);
    expect(rows()).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: 'textMessageCount' } });
    expect(cells(rows()[0]).slice(2, 7)).toEqual(['bob', '0', '3', '3', '0']);
    fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: 'relationMessageCount' } });
    expect(cells(rows()[0])[2]).toBe('alice');
    fireEvent.click(screen.getByRole('button', { name: '降序' }));
    expect(cells(rows()[0])[2]).toBe('bob');
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    fireEvent.change(screen.getByPlaceholderText('搜索消息ID/议事人ID/议事人'), { target: { value: 'round-a' } });
    expect(cells(rows()[0])[1]).toBe('round-a');
    expect(cells(rows()[0])[3]).toBe('alice');
    expect(cells(rows()[0]).at(-1)).toBe('user-alice');
  });

  it('人榜与消息榜共用实际表态金额、引用和结算指标，充值分账归入接收者', () => {
    const { rerender, props } = setup();
    const createdBy = users[1];
    rerender(<LeaderboardModal {...props}
      messages={[...messages.map(item => item.id === 'round-a' || item.id === 'result-a'
        ? { ...item, settlementTargetId: 'reply-a', roundPayload: { roundId: 'round-a' } } : item),
        message('stance-b', 'bob', 'relation'), message('reference-b', 'bob', 'relation'),
        { ...message('grant', 'system', 'round_result'), parts: [{ id: 'allocation', type: 'data', value: {
          source: 'grant', inputs: { proposalId: 'proposal-a' }, allocations: [{ userId: users[0].id, amount: 80 }],
        } }] }]}
      relations={[
        { id: 'proposal-a', relationType: 'PROPOSAL', sourceMessageId: null, targetRefs: [], createdBy, createdAt: '', payload: { operationType: 'RECHARGE', amount: 100 } },
        { id: 'stance-b', relationType: 'AGREE', sourceMessageId: null, targetRefs: [{ kind: 'relation', relationId: 'reply-a' }], createdBy, createdAt: '', spending: { protocol: 1, recommendation: 0, wager: 7 } },
      ]}
      edges={[0, 1].map(index => ({ id: `reference-b:${index}`, relationMessageId: 'reference-b', relationType: 'reference', relationLabel: '引用',
        from: { messageId: 'text-b', selection: { kind: 'whole' } }, to: { messageId: 'reply-a', selection: { kind: 'whole' } } }))}
    />);
    expect(cells(rows()[0])).toEqual(['1', 'user-alice', 'alice', '80', '6', '1', '5', '20', '7', '10.00', '1', '1', '112']);
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    expect(cells(rows()[0]).slice(1, 3)).toEqual(['reply-a', 'reply-a']);
    expect(cells(rows()[0]).slice(4, 10)).toEqual(['20', '10', '7', '-40.00', '1', '1']);
  });

  it('人榜的所有排序选项与方向均生效，支持搜索和净支持率最小样本', () => {
    setup();
    for (const key of ['messageCount', 'textMessageCount', 'relationMessageCount', 'receivedTruthStake', 'totalIncome', 'rechargeIncome', 'receivedStanceStake', 'netSupportRate', 'referenceHeat', 'settlementActivity']) {
      fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: key } });
      const column = { messageCount: 4, textMessageCount: 5, relationMessageCount: 6, receivedTruthStake: 7, totalIncome: 12, rechargeIncome: 3, receivedStanceStake: 8, netSupportRate: 9, referenceHeat: 10, settlementActivity: 11 }[key]!;
      const values = () => rows().map(row => Number(cells(row)[column]));
      expect(values()).toEqual([...values()].sort((a, b) => b - a));
      fireEvent.click(screen.getByRole('button', { name: '降序' }));
      expect(values()).toEqual([...values()].sort((a, b) => a - b));
      fireEvent.click(screen.getByRole('button', { name: '升序' }));
    }
    fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: 'netSupportRate' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: 5 } });
    expect(rows()).toHaveLength(1);
    expect(cells(rows()[0])[2]).toBe('alice');
    fireEvent.change(screen.getByPlaceholderText('搜索与会者ID/与会者'), { target: { value: 'USER-BOB' } });
    expect(rows()).toHaveLength(0);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: 0 } });
    expect(cells(rows()[0])[2]).toBe('bob');
  });

  it('消息榜的所有排序选项与方向均生效，净支持率最小样本排除无押注消息', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
    for (const [key, column] of Object.entries({ stakeTotal: 4, truthStake: 5, stanceStake: 6, netSupportRate: 7, referenceHeat: 8, settlementActivity: 9, sideGap: 10, bettors: 11, intensity: 12 })) {
      fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: key } });
      const values = () => rows().map(row => Number(cells(row)[column]));
      expect(values()).toEqual([...values()].sort((a, b) => b - a));
      fireEvent.click(screen.getByRole('button', { name: '降序' }));
      expect(values()).toEqual([...values()].sort((a, b) => a - b));
      fireEvent.click(screen.getByRole('button', { name: '升序' }));
    }
    fireEvent.change(screen.getByRole('combobox', { name: '排序条件' }), { target: { value: 'netSupportRate' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: 5 } });
    expect(rows().map(row => cells(row)[1])).toEqual(['text-a', 'reply-a']);
  });
});
