import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFullscreenShortcut } from '../hooks/useFullscreenShortcut';

const original = {
  request: Object.getOwnPropertyDescriptor(document.documentElement, 'requestFullscreen'),
  exit: Object.getOwnPropertyDescriptor(document, 'exitFullscreen'),
  element: Object.getOwnPropertyDescriptor(document, 'fullscreenElement'),
  enabled: Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled'),
};
let fullscreenElement: Element | null = null;
const request = vi.fn(async () => { fullscreenElement = document.documentElement; });
const exit = vi.fn(async () => { fullscreenElement = null; });

beforeEach(() => {
  fullscreenElement = null;
  request.mockReset().mockImplementation(async () => { fullscreenElement = document.documentElement; });
  exit.mockReset().mockImplementation(async () => { fullscreenElement = null; });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: request });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
});

afterEach(() => {
  cleanup(); vi.useRealTimers();
  for (const [target, key, descriptor] of [
    [document.documentElement, 'requestFullscreen', original.request],
    [document, 'exitFullscreen', original.exit],
    [document, 'fullscreenElement', original.element],
    [document, 'fullscreenEnabled', original.enabled],
  ] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});

function Harness({ onEditorKey = vi.fn() }: { onEditorKey?: () => void }) {
  const { notice } = useFullscreenShortcut();
  return <><textarea aria-label="草稿" defaultValue="保留未发送内容" onKeyDown={onEditorKey} />
    {notice && <div role="alert">{notice.message}</div>}</>;
}

it('uses Alt+Enter from the editor without submitting or altering the draft, then exits the actual fullscreen element', async () => {
  const onEditorKey = vi.fn();
  render(<Harness onEditorKey={onEditorKey} />);
  const draft = screen.getByRole('textbox', { name: '草稿' });
  expect(fireEvent.keyDown(draft, { key: 'Enter', altKey: true })).toBe(false);
  // The request must be invoked in the key handler, while user activation is live.
  expect(request).toHaveBeenCalledExactlyOnceWith({ navigationUI: 'hide' });
  expect(request.mock.contexts[0]).toBe(document.documentElement);
  expect(onEditorKey).not.toHaveBeenCalled();
  expect(draft).toHaveValue('保留未发送内容');
  await act(async () => {});
  fireEvent.keyDown(draft, { key: 'Enter', altKey: true });
  expect(exit).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button')).toBeNull();
});

it('reads current browser state after a native exit instead of keeping a stale fullscreen flag', async () => {
  render(<Harness />);
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  await act(async () => {});
  fullscreenElement = null; // Browser Esc / native menu exit.
  document.dispatchEvent(new Event('fullscreenchange'));
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  expect(request).toHaveBeenCalledTimes(2);
  expect(exit).not.toHaveBeenCalled();
});

it('exits fullscreen with Esc when the browser forwards it, without also dismissing the focused editor', async () => {
  fullscreenElement = document.documentElement;
  const onEditorKey = vi.fn();
  render(<Harness onEditorKey={onEditorKey} />);
  const draft = screen.getByRole('textbox', { name: '草稿' });
  expect(fireEvent.keyDown(draft, { key: 'Escape' })).toBe(false);
  expect(exit).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
  expect(onEditorKey).not.toHaveBeenCalled();
  await act(async () => {});
  expect(fireEvent.keyDown(draft, { key: 'Escape' })).toBe(true);
  expect(onEditorKey).toHaveBeenCalledOnce();
});

it('ignores held keys and serializes requests until the browser settles', async () => {
  let complete!: () => void;
  request.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  render(<Harness />);
  fireEvent.keyDown(window, { key: 'Enter', altKey: true, repeat: true });
  expect(request).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  expect(request).toHaveBeenCalledOnce();
  await act(async () => complete());
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => complete());
});

it.each([
  { key: 'Enter' }, { key: 'F11' }, { key: 'Escape' },
  { key: 'Enter', altKey: true, isComposing: true },
  { key: 'Enter', altKey: true, ctrlKey: true },
  { key: 'Enter', altKey: true, metaKey: true },
  { key: 'Enter', altKey: true, shiftKey: true },
])('preserves unrelated shortcuts and IME input: %j', event => {
  render(<Harness />);
  expect(fireEvent.keyDown(window, event)).toBe(true);
  expect(request).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
});

it('reports a rejected request and lets the next deliberate key press retry', async () => {
  request.mockRejectedValueOnce(new TypeError('not granted'));
  render(<Harness />);
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  expect(await screen.findByRole('alert')).toHaveTextContent('浏览器未允许进入全屏');
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(request).toHaveBeenCalledTimes(2);
});

it('reports unavailable fullscreen and dismisses the notice without adding controls', async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
  render(<Harness />);
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  expect(screen.getByRole('alert')).toHaveTextContent('当前页面无法使用全屏快捷键');
  expect(request).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(8000));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reports an exit failure and removes its listener on unmount', async () => {
  fullscreenElement = document.documentElement;
  exit.mockRejectedValueOnce(new TypeError('not granted'));
  const view = render(<Harness />);
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  expect(await screen.findByRole('alert')).toHaveTextContent('未能退出全屏');
  view.unmount();
  fireEvent.keyDown(window, { key: 'Enter', altKey: true });
  expect(exit).toHaveBeenCalledOnce();
});
