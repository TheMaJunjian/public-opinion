import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import AboutLink from '../components/AboutLink';
import TutorialModal from '../components/TutorialModal';
import * as aboutNavigation from '../utils/aboutNavigation';
import { useBrowsingHistory } from '../pages/workbench/useBrowsingHistory';

const replaceRealDocument = aboutNavigation.replaceAboutDocument;

const { mounted, unmounted, routed, auth } = vi.hoisted(() => ({
  mounted: vi.fn(), unmounted: vi.fn(), routed: vi.fn(),
  auth: { user: { id: 'user', username: '与会者' } as { id: string; username: string } | null },
}));
vi.mock('../context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ user: auth.user, loading: false }), useOptionalAuth: () => null,
}));
vi.mock('../components/Navbar', () => ({ default: () => <nav><AboutLink>介绍</AboutLink><AboutLink href="/about.html#guide-selection">暂存区帮助</AboutLink></nav> }));
vi.mock('../components/AppUpdateNotice', () => ({ default: () => null }));
vi.mock('../components/OperationFeedback', () => ({ default: () => null }));
vi.mock('../components/GestureShortcutManager', () => ({ default: () => null }));
vi.mock('../pages/MessageWorkbenchPage', () => ({ default: function Workbench() {
  useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
  const location = useLocation();
  routed(location.state);
  const [category, setCategory] = useState('主页');
  const history = useBrowsingHistory('workbench', () => category, setCategory, { browser: true });
  return <><textarea aria-label="消息输入" /><output aria-label="当前分类">{category}</output>
    <output aria-label="工作台地址">{location.pathname}{location.search}</output>
    <button onClick={() => { history.record(); setCategory('分类 A'); }}>进入分类 A</button>
    <button disabled={!history.canGoBack} onClick={history.back}>返回</button>
    <button disabled={!history.canGoForward} onClick={history.forward}>前进</button></>;
} }));

beforeEach(() => {
  vi.clearAllMocks(); auth.user = { id: 'user', username: '与会者' };
  window.history.replaceState(null, '', '/messages/classification?view=graph');
  vi.spyOn(aboutNavigation, 'replaceAboutDocument').mockImplementation((frame, url) => {
    // jsdom cannot load iframe pages. Keep its document URL in sync; browser QA covers real loads.
    frame.contentWindow!.history.replaceState(null, '', url);
    frame.contentWindow!.scrollTo = vi.fn();
    fireEvent.load(frame);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function traverseHistory(delta: number) {
  await act(async () => {
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.go(delta);
    await popped;
  });
}

function writeFrame(frame: HTMLIFrameElement, body: string) {
  const doc = frame.contentDocument!;
  doc.open(); doc.write(`<!doctype html><html><body>${body}</body></html>`); doc.close();
  frame.contentWindow!.scrollTo = vi.fn();
  fireEvent.load(frame);
  return doc;
}

it.each([false, true])('阅读介绍后保留同一个工作台、原地址和未发送输入（生产模式：%s）', async production => {
  vi.stubEnv('PROD', production);
  if (production) window.history.replaceState(null, '', '/#/messages/classification?view=graph');
  const address = window.location.href;
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.change(input, { target: { value: '尚未发送的内容' } });
  const app = document.querySelector<HTMLElement>('.app-shell')!;
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  expect(app.inert).toBe(true);
  const frame = screen.getByTitle('公论介绍与文档');
  fireEvent.click(screen.getByRole('button', { name: '关闭介绍' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(input).toHaveValue('尚未发送的内容');
  expect(app.inert).toBe(false);
  expect(window.location.href).toBe(address);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  expect(screen.getByTitle('公论介绍与文档')).toBe(frame);
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
});

it.each([false, true])('工作台链接新增访问，前进后退逐步经过介绍与文档并保留草稿（生产模式：%s）', async production => {
  vi.stubEnv('PROD', production);
  window.history.replaceState(null, '', production ? '/#/messages?view=graph' : '/messages?view=graph');
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.change(input, { target: { value: '通过页面链接往返后继续写' } });
  fireEvent.click(screen.getByRole('button', { name: '进入分类 A' }));
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = writeFrame(frame, '<a href="/docs/usage.html">规则</a><a href="/docs/usage.html#fees">费用</a><a href="/#/messages">打开工作台</a>');
  fireEvent.click(doc.querySelectorAll('a')[0]);
  fireEvent.click(doc.querySelectorAll('a')[1]);
  Object.defineProperty(frame.contentWindow!, 'scrollY', { configurable: true, writable: true, value: 640 });
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  fireEvent(doc.querySelectorAll('a')[2], click);
  expect(click.defaultPrevented).toBe(true);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(input).toHaveValue('通过页面链接往返后继续写');
  expect(screen.getByLabelText('当前分类')).toHaveTextContent('分类 A');
  expect(screen.getByLabelText('工作台地址')).toHaveTextContent('/messages');
  // The toolbar must also stop on the preceding document, without getting stuck.
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  await waitFor(() => expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible());
  expect(frame.contentWindow!.location.pathname + frame.contentWindow!.location.hash).toBe('/docs/usage.html#fees');
  expect(frame.contentWindow!.scrollTo).toHaveBeenLastCalledWith(0, 640);
  await traverseHistory(1);
  expect(screen.getByRole('button', { name: '返回' })).toBeEnabled();
  for (const expected of ['/docs/usage.html#fees', '/docs/usage.html', '/about.html']) {
    await traverseHistory(-1);
    expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
    expect(frame.contentWindow!.location.pathname + frame.contentWindow!.location.hash).toBe(expected);
  }
  await traverseHistory(-1);
  expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull();
  expect(screen.getByLabelText('工作台地址')).toHaveTextContent('/messages?view=graph');
  expect(screen.getByLabelText('当前分类')).toHaveTextContent('分类 A');
  expect(input).toHaveValue('通过页面链接往返后继续写');
  for (let step = 0; step < 4; step++) await traverseHistory(1);
  expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull();
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it.each([false, true])('公论标志进入首页，浏览器逐步返回文档和原工作台（生产模式：%s）', async production => {
  vi.stubEnv('PROD', production);
  window.history.replaceState(null, '', production ? '/#/messages' : '/messages');
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.change(input, { target: { value: '首页往返不丢失' } });
  fireEvent.click(screen.getByRole('button', { name: '进入分类 A' }));
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = writeFrame(frame, '<a href="/docs/promotion.html">推广</a><a href="/">公论</a>');
  fireEvent.click(doc.querySelectorAll('a')[0]);
  fireEvent.click(doc.querySelectorAll('a')[1]);
  expect(await screen.findByRole('heading', { name: '公论' })).toBeVisible();
  expect(production ? window.location.hash : window.location.pathname).toBe(production ? '#/' : '/');
  expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull();
  expect(unmounted).not.toHaveBeenCalled();
  await traverseHistory(-1);
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  expect(frame.contentWindow!.location.pathname).toBe('/docs/promotion.html');
  await traverseHistory(-1);
  expect(frame.contentWindow!.location.pathname).toBe('/about.html');
  await traverseHistory(-1);
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(input).toHaveValue('首页往返不丢失');
  expect(screen.getByLabelText('当前分类')).toHaveTextContent('分类 A');
  for (let step = 0; step < 3; step++) await traverseHistory(1);
  fireEvent.click(screen.getByRole('link', { name: '进入消息界面' }));
  expect(await screen.findByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(input).toHaveValue('首页往返不丢失');
  expect(screen.getByLabelText('当前分类')).toHaveTextContent('分类 A');
  expect(mounted).toHaveBeenCalledTimes(1);
});

it.each([false, true])('从本地阅览前往在线消息后，仍可逐步返回原文件和草稿（生产模式：%s）', async production => {
  vi.stubEnv('PROD', production);
  const state = { exportData: { scope: { title: '本地文件' }, messages: [] } };
  window.history.replaceState({ usr: state, key: 'file-entry', idx: 0 }, '', production ? '/#/viewer' : '/viewer');
  const nativeReplace = window.history.replaceState.bind(window.history);
  const nativePush = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((value, unused, url) => nativeReplace(structuredClone(value), unused, url));
  vi.spyOn(window.history, 'pushState').mockImplementation((value, unused, url) => nativePush(structuredClone(value), unused, url));
  render(<App />);
  const fileInput = await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.change(fileInput, { target: { value: '文件中的草稿' } });
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = writeFrame(frame, '<a href="/#/messages">参与共建</a>');
  fireEvent.click(doc.querySelector('a')!);
  const onlineInput = await screen.findByRole('textbox', { name: '消息输入' });
  expect(onlineInput).not.toBe(fileInput);
  fireEvent.change(onlineInput, { target: { value: '在线草稿' } });
  await traverseHistory(-1);
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  await traverseHistory(-1);
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(fileInput);
  expect(fileInput).toHaveValue('文件中的草稿');
  expect(routed).toHaveBeenLastCalledWith(state);
  expect(routed.mock.lastCall![0]).toBe(state);
  await traverseHistory(1); await traverseHistory(1);
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(onlineInput);
  expect(onlineInput).toHaveValue('在线草稿');
  expect(mounted).toHaveBeenCalledTimes(2);
  expect(unmounted).not.toHaveBeenCalled();
});

it('悬停预加载介绍，打开和再次打开都复用同一个文档', async () => {
  render(<App />);
  await screen.findByRole('textbox', { name: '消息输入' });
  const pushState = vi.spyOn(window.history, 'pushState');
  fireEvent.pointerEnter(screen.getByRole('link', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档');
  expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull();
  expect(pushState).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  expect(screen.getByTitle('公论介绍与文档')).toBe(frame);
  expect(pushState).toHaveBeenCalledTimes(1);
  fireEvent.load(frame);
  fireEvent.keyDown((frame as HTMLIFrameElement).contentDocument!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
});

it('完整文档入口可直接打开指定章节，返回后保留工作台与草稿', async () => {
  const onClose = vi.fn();
  render(<><App /><TutorialModal open onClose={onClose} /></>);
  const input = await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.change(input, { target: { value: '阅读教程后继续写' } });
  fireEvent.click(screen.getByRole('link', { name: '上手与界面导览' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  const frame = screen.getByTitle('公论介绍与文档');
  expect(frame).toHaveAttribute('src', '/about.html#quick-start');
  expect(aboutNavigation.aboutHistoryEntry(window.history.state)?.url).toBe('/about.html#quick-start');
  fireEvent.click(screen.getByRole('button', { name: '关闭介绍' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(input).toHaveValue('阅读教程后继续写');
  expect(mounted).toHaveBeenCalledTimes(1);
});

it('预加载的帮助页显示后才定位，再次点同一帮助仍定位，普通介绍入口保留阅读位置', async () => {
  render(<App />);
  await screen.findByRole('textbox', { name: '消息输入' });
  const help = screen.getByRole('link', { name: '暂存区帮助' });
  fireEvent.pointerEnter(help);
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = writeFrame(frame, '<h3 id="guide-selection">选择暂存区</h3>');
  const target = doc.getElementById('guide-selection')!;
  target.scrollIntoView = vi.fn(() => expect(frame.closest('[hidden]')).toBeNull());
  expect(frame.closest('[hidden]')).not.toBeNull();
  fireEvent.click(help);
  expect(target.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
  fireEvent.click(screen.getByRole('button', { name: '关闭介绍' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '关闭介绍' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  fireEvent.click(help);
  expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
});

it.each([false, true])('指定帮助链接打开对应章节，默认入口继续阅读且保留草稿（生产模式：%s）', async production => {
  vi.stubEnv('PROD', production);
  if (production) window.history.replaceState(null, '', '/#/messages/classification?view=graph');
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.change(input, { target: { value: '先查帮助，再继续编辑' } });
  const help = screen.getByRole('link', { name: '暂存区帮助' });
  expect(help).toHaveAttribute('href', '/about.html#guide-selection');
  fireEvent.click(help);
  const frame = screen.getByTitle('公论介绍与文档');
  expect(frame).toHaveAttribute('src', '/about.html#guide-selection');
  expect(aboutNavigation.aboutHistoryEntry(window.history.state)?.url).toBe('/about.html#guide-selection');
  fireEvent.click(screen.getByRole('button', { name: '关闭介绍' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  expect(input).toHaveValue('先查帮助，再继续编辑');
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  expect(screen.getByTitle('公论介绍与文档')).toBe(frame);
  expect(aboutNavigation.aboutHistoryEntry(window.history.state)?.url).toBe('/about.html#guide-selection');
  fireEvent.click(screen.getByRole('button', { name: '关闭介绍' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(input).toHaveValue('先查帮助，再继续编辑');
  expect(mounted).toHaveBeenCalledTimes(1);
});

it.each([false, true])('浏览器回退关闭介绍，前进恢复阅读，保留路由状态和草稿（生产模式：%s）', async production => {
  vi.stubEnv('PROD', production);
  const routeState = { usr: { viewerCacheRef: { key: 'local-file' }, viewerInstanceKey: 'same-viewer' }, key: 'workbench', idx: 4 };
  window.history.replaceState(routeState, '', production ? '/#/viewer?view=graph' : '/viewer?view=graph');
  const address = window.location.href;
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.change(input, { target: { value: '回退后继续编辑' } });
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  frame.contentWindow!.scrollTo = vi.fn();
  expect(window.history.state).toMatchObject(routeState);
  await traverseHistory(-1);
  expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull();
  expect(window.history.state).toMatchObject(routeState);
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(input).toHaveValue('回退后继续编辑');
  await traverseHistory(1);
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  expect(screen.getByTitle('公论介绍与文档')).toBe(frame);
  expect(window.location.href).toBe(address);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it.each([false, true])('分类与介绍共用浏览器历史，关闭介绍后继续回退分类（生产模式：%s）', async production => {
  vi.stubEnv('PROD', production);
  if (production) window.history.replaceState(null, '', '/#/messages?view=graph');
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.change(input, { target: { value: '跨介绍阅读后继续编辑' } });
  fireEvent.click(screen.getByRole('button', { name: '进入分类 A' }));
  const categoryEntry = window.history.state;
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = writeFrame(frame, '<a href="/docs/usage.html">规则</a>');
  fireEvent.click(doc.querySelector('a')!);
  await traverseHistory(-1);
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  await traverseHistory(-1);
  expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull();
  expect(screen.getByLabelText('当前分类')).toHaveTextContent('分类 A');
  expect(window.history.state).toEqual(categoryEntry);
  await traverseHistory(-1);
  expect(screen.getByLabelText('当前分类')).toHaveTextContent('主页');
  fireEvent.click(screen.getByRole('button', { name: '前进' }));
  await waitFor(() => expect(screen.getByLabelText('当前分类')).toHaveTextContent('分类 A'));
  await traverseHistory(1);
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '关闭介绍' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  expect(screen.getByLabelText('当前分类')).toHaveTextContent('分类 A');
  expect(screen.getByRole('textbox', { name: '消息输入' })).toBe(input);
  expect(input).toHaveValue('跨介绍阅读后继续编辑');
  expect(mounted).toHaveBeenCalledTimes(1);
});

it('文档和章节链接逐步回退、前进，并恢复阅读位置', async () => {
  render(<App />);
  await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = writeFrame(frame, '<a href="/docs/usage.html">规则</a><a href="/docs/usage.html#fees">收费</a>');
  Object.defineProperty(frame.contentWindow!, 'scrollY', { configurable: true, writable: true, value: 420 });
  fireEvent.click(doc.querySelector('a')!);
  expect(aboutNavigation.replaceAboutDocument).toHaveBeenLastCalledWith(frame, '/docs/usage.html');
  Object.defineProperty(frame.contentWindow!, 'scrollY', { configurable: true, value: 850 });
  fireEvent.click(doc.querySelectorAll('a')[1]);
  expect(aboutNavigation.replaceAboutDocument).toHaveBeenLastCalledWith(frame, '/docs/usage.html#fees');
  Object.defineProperty(frame.contentWindow!, 'scrollY', { configurable: true, value: 1200 });
  fireEvent.scroll(frame.contentWindow!);
  await traverseHistory(-1);
  expect(frame.contentWindow!.location.pathname + frame.contentWindow!.location.hash).toBe('/docs/usage.html');
  expect(frame.contentWindow!.scrollTo).toHaveBeenLastCalledWith(0, 850);
  Object.defineProperty(frame.contentWindow!, 'scrollY', { configurable: true, value: 850 });
  await traverseHistory(-1);
  expect(frame.contentWindow!.location.pathname).toBe('/about.html');
  expect(frame.contentWindow!.scrollTo).toHaveBeenLastCalledWith(0, 420);
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  await traverseHistory(1);
  expect(frame.contentWindow!.location.pathname).toBe('/docs/usage.html');
  expect(frame.contentWindow!.scrollTo).toHaveBeenLastCalledWith(0, 850);
  await traverseHistory(1);
  expect(frame.contentWindow!.location.hash).toBe('#fees');
  expect(frame.contentWindow!.scrollTo).toHaveBeenLastCalledWith(0, 1200);
  expect(aboutNavigation.replaceAboutDocument).toHaveBeenLastCalledWith(frame, '/docs/usage.html#fees');
});

it('关闭多层文档一次返回工作台，不留下无反应的回退步骤，也不重复关闭', async () => {
  window.history.replaceState(null, '', '/login');
  window.history.pushState(null, '', '/messages');
  render(<App />);
  await screen.findByRole('textbox', { name: '消息输入' });
  fireEvent.click(screen.getByRole('link', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = writeFrame(frame, '<a href="/docs/usage.html">规则</a><a href="/docs/promotion.html">推广</a>');
  fireEvent.click(doc.querySelector('a')!);
  fireEvent.click(doc.querySelectorAll('a')[1]);
  const close = screen.getByRole('button', { name: '关闭介绍' });
  fireEvent.click(close); fireEvent.click(close);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  expect(window.location.pathname).toBe('/messages');
  await traverseHistory(1);
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  await traverseHistory(1);
  expect(frame.contentWindow!.location.pathname).toBe('/docs/usage.html');
  await traverseHistory(1);
  expect(frame.contentWindow!.location.pathname).toBe('/docs/promotion.html');
  expect(aboutNavigation.replaceAboutDocument).toHaveBeenLastCalledWith(frame, '/docs/promotion.html');
  fireEvent.click(screen.getByRole('button', { name: '关闭介绍' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  await traverseHistory(-1);
  expect(window.location.pathname).toBe('/login');
});

it.each([undefined, '/docs/usage.html#发言与创建关系'])('保留链接 %s 的地址和Ctrl点击的新标签页行为', href => {
  const opened = vi.fn();
  window.addEventListener('open-about-viewer', opened);
  try {
    render(<AboutLink href={href}>介绍</AboutLink>);
    const link = screen.getByRole('link', { name: '介绍' });
    expect(link).toHaveAttribute('href', href ?? '/about.html');
    // Observe the native action before cancelling jsdom's unsupported full-page navigation.
    const nativeAction = vi.fn((event: MouseEvent) => {
      expect(event.defaultPrevented).toBe(false); event.preventDefault();
    });
    document.addEventListener('click', nativeAction, { once: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(nativeAction).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(opened).toHaveBeenCalledTimes(1);
    const detail = (opened.mock.calls[0][0] as CustomEvent<{ url: string }>).detail;
    if (href) expect(decodeURIComponent(detail.url)).toBe(href);
    else expect(detail).toBeUndefined();
  } finally { window.removeEventListener('open-about-viewer', opened); }
});

it.each(['/messages', 'https://example.com/about.html'])('非同源文档地址 %s 保留普通跳转', href => {
  const opened = vi.fn();
  window.addEventListener('open-about-viewer', opened);
  try {
    render(<AboutLink href={href}>其他页面</AboutLink>);
    const nativeAction = vi.fn((event: MouseEvent) => { expect(event.defaultPrevented).toBe(false); event.preventDefault(); });
    document.addEventListener('click', nativeAction, { once: true });
    fireEvent.click(screen.getByRole('link', { name: '其他页面' }));
    expect(nativeAction).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
  } finally { window.removeEventListener('open-about-viewer', opened); }
});

it('同页章节在首次调用时同步定位，不新增内嵌文档历史', () => {
  const frame = document.createElement('iframe');
  frame.src = '/about.html';
  document.body.append(frame);
  try {
    const view = frame.contentWindow!;
    const doc = frame.contentDocument!;
    doc.open(); doc.write('<!doctype html><html><body><h2 id="operate">加入共建</h2></body></html>'); doc.close();
    const target = frame.contentDocument!.getElementById('operate')!;
    target.scrollIntoView = vi.fn();
    view.scrollTo = vi.fn();
    const historyLength = view.history.length;
    replaceRealDocument(frame, '/about.html#operate');
    expect(target.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
    expect(view.location.hash).toBe('#operate');
    expect(view.history.length).toBe(historyLength);
    replaceRealDocument(frame, '/about.html');
    expect(view.location.hash).toBe('');
    expect(view.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(view.history.length).toBe(historyLength);
  } finally { frame.remove(); }
});
