import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import WpsDocumentChooser from '../components/WpsDocumentChooser';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { readWpsMeetingDocument } from '../utils/wpsMeetingDocument';
import { visitWpsForAccess } from '../utils/wpsAccessReturn';
import { openWpsMeetingView, WpsAccessRequired, wpsUrlFromShareText } from '../utils/wpsMeetingTransport';

vi.mock('../utils/wpsMeetingDocument', () => ({ readWpsMeetingDocument: vi.fn() }));
vi.mock('../utils/wpsAccessReturn', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/wpsAccessReturn')>(), visitWpsForAccess: vi.fn(),
}));

const link = 'https://www.kdocs.cn/l/ca8P1Pr2V8tX';
const other = 'https://www.kdocs.cn/l/ck38Vz5IwDTs';
const escapedShare = '【金山文档 | WPS云文档】 公论 · 文档切换测试 B\\\nhttps\\://www\\.kdocs.cn/l/ca8P1Pr2V8tX';
const initialHistory = window.history.state;

afterEach(() => {
  cleanup();
  window.history.replaceState(initialHistory, '');
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});

function chooser() {
  const onOpen = vi.fn();
  render(<WpsDocumentChooser onOpen={onOpen} disabled={false} />);
  const toggle = screen.getByText('使用 WPS 云文档');
  if (!toggle.closest('details')?.open) fireEvent.click(toggle);
  return {
    onOpen,
    input: screen.getByRole('textbox', { name: 'WPS 多维表格分享链接' }),
    submit: screen.getByRole('button', { name: '打开讨论' }),
  };
}

it('links to the WPS account center before a document is selected', () => {
  chooser();
  expect(screen.getByRole('link', { name: '管理 WPS 账号' })).toHaveAttribute('href', 'https://account.wps.cn/usercenter/');
});

it('extracts the official URL on paste, then opens the same cloud discussion without leaving the app', async () => {
  const start = createLocalMessageFile();
  vi.mocked(readWpsMeetingDocument).mockResolvedValue(start);
  const { input, submit, onOpen } = chooser();
  fireEvent.paste(input, { clipboardData: { getData: () => escapedShare } });
  expect(input).toHaveValue(link);
  fireEvent.click(submit);
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(start, link, expect.any(AbortSignal)));
  expect(visitWpsForAccess).not.toHaveBeenCalled();
});

it.each([
  [link, link],
  ['【金山文档】讨论 B\n' + link + '，点击查看。', link],
  ['[讨论 B](' + link + '?sheet=ABC&readonly=1&from=share)', link + '?sheet=ABC&readonly='],
  [link + '\n' + link + '?from=another', link],
  [escapedShare, link],
])('accepts regular, repeated, or escaped WPS share links', (input, expected) => {
  expect(wpsUrlFromShareText(input).href).toBe(expected);
});

it.each([
  '【金山文档】只有标题',
  'https://www.kdocs.cn.evil.example/l/ca8P1Pr2V8tX',
  'https://www.kdocs.cn@evil.example/l/ca8P1Pr2V8tX',
  'https://evil.example/?redirect=' + link,
  'http://www.kdocs.cn/l/test',
])('rejects non-document text and unofficial URLs', input => {
  expect(() => wpsUrlFromShareText(input)).toThrow('未找到 WPS');
});

it('preserves separate URLs from a multiline paste and asks the user to select one before contacting WPS', async () => {
  const { input, submit } = chooser();
  fireEvent.paste(input, { clipboardData: { getData: () => link + '\n' + other } });
  expect(input).toHaveValue(link + ' ' + other);
  fireEvent.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('多个 WPS');
  expect(readWpsMeetingDocument).not.toHaveBeenCalled();
  expect(visitWpsForAccess).not.toHaveBeenCalled();
});

it('navigates automatically for an access failure, lets the returning user retry, and avoids a redirect loop', async () => {
  vi.mocked(readWpsMeetingDocument).mockRejectedValue(new WpsAccessRequired('请登录 WPS'));
  const { input, submit, onOpen } = chooser();
  fireEvent.change(input, { target: { value: '【金山文档】 B ' + link } });
  fireEvent.click(submit);
  await waitFor(() => expect(visitWpsForAccess).toHaveBeenCalledOnce());
  expect(vi.mocked(visitWpsForAccess).mock.calls[0][0].href).toBe(link);
  expect(input).toHaveValue(link);
  fireEvent.click(submit);
  await waitFor(() => expect(readWpsMeetingDocument).toHaveBeenCalledTimes(2));
  expect(visitWpsForAccess).toHaveBeenCalledOnce();
  expect(await screen.findByRole('link', { name: '在 WPS 中登录或申请权限' })).toHaveAttribute('href', link);
  const start = createLocalMessageFile();
  vi.mocked(readWpsMeetingDocument).mockResolvedValue(start);
  fireEvent.click(submit);
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(start, link, expect.any(AbortSignal)));
});

it('restores the link after a full page return without changing existing router state', async () => {
  window.history.replaceState({ idx: 4, usr: { preserved: true }, gonglunWpsAccessReturn: link }, '');
  const onOpen = vi.fn();
  render(<WpsDocumentChooser onOpen={onOpen} disabled={false} />);
  expect(screen.getByRole('textbox', { name: 'WPS 多维表格分享链接' })).toHaveValue(link);
  expect(screen.getByText('使用 WPS 云文档').closest('details')).toHaveAttribute('open');
  expect(window.history.state).toEqual({ idx: 4, usr: { preserved: true } });
  expect(readWpsMeetingDocument).not.toHaveBeenCalled();
});

it('reports document errors and offline failures inside the workbench', async () => {
  const { input, submit } = chooser();
  vi.mocked(readWpsMeetingDocument).mockRejectedValue(new Error('此表含有多场公论会议'));
  fireEvent.change(input, { target: { value: link } });
  fireEvent.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('多场公论会议');
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
  fireEvent.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('离线');
  expect(readWpsMeetingDocument).toHaveBeenCalledOnce();
  expect(visitWpsForAccess).not.toHaveBeenCalled();
});

it.each([true, false])('distinguishes a stalled sign-in handshake from a later view timeout', async handshake => {
  vi.useFakeTimers();
  const never = new Promise<never>(() => {});
  const destroy = vi.fn();
  const check = openWpsMeetingView({
    url: link, mount: document.createElement('div'),
    sdk: { config: () => ({ ready: () => handshake ? never : Promise.resolve(), destroy, Application: { ActiveView: never } }) },
  });
  const result = check.catch(error => error);
  await vi.advanceTimersByTimeAsync(20_000);
  const error = await result;
  expect(error instanceof WpsAccessRequired).toBe(handshake);
  expect(destroy).toHaveBeenCalledOnce();
});

it.each([403, 'not_logged_in', { statusCode: 401 }])('recognizes explicit SDK sign-in errors during initialization', async error => {
  const connection = openWpsMeetingView({
    url: link, mount: document.createElement('div'), sdk: { config: () => { throw error; } },
  });
  await expect(connection).rejects.toBeInstanceOf(WpsAccessRequired);
});
