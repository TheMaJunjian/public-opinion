import { useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AboutViewer from '../components/AboutViewer';
import { setTheme, THEME_STORAGE_KEY, THEMES } from '../theme/theme';
import * as aboutNavigation from '../utils/aboutNavigation';
import { applyDocumentTheme } from '../theme/documentTheme';

let palette: HTMLStyleElement;
beforeEach(() => {
  window.history.replaceState(null, '', '/messages');
  palette = document.createElement('style');
  palette.textContent = `
    [data-appearance="gpt"] { --surface-page: #101010; --text-primary: #f3f4f6; --fragment-accent: #60a5fa; --font-reading: monospace; }
    [data-appearance="gpt-arena"] { --surface-page: #0a101a; --text-primary: #e7edf7; --fragment-accent: #85c4ff; --font-reading: sans-serif; }
    [data-appearance="opus-paper"] { --surface-page: #f6f3ec; --text-primary: #1f1d1a; --fragment-accent: #2f4a8a; --font-reading: serif; }
  `;
  document.head.append(palette);
  vi.spyOn(aboutNavigation, 'replaceAboutDocument').mockImplementation((frame, url) => {
    frame.contentWindow!.history.replaceState(null, '', url);
  });
});

afterEach(() => {
  cleanup(); palette.remove(); vi.restoreAllMocks(); localStorage.removeItem(THEME_STORAGE_KEY);
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.appearance;
});

function Workspace() {
  const root = useRef<HTMLDivElement>(null);
  return <MemoryRouter><div ref={root}><textarea aria-label="草稿" defaultValue="未发送的内容" />
    <button onClick={() => window.dispatchEvent(new Event('open-about-viewer'))}>介绍</button></div>
    <AboutViewer appRoot={root} /></MemoryRouter>;
}

function loadFrame(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument!;
  doc.open(); doc.write('<!doctype html><html><body><a href="/docs/usage.html">现行规则</a></body></html>'); doc.close();
  frame.contentWindow!.scrollTo = vi.fn();
  fireEvent.load(frame);
  return doc;
}

function expectCurrentPalette(doc: Document, id: string, base: string) {
  expect(doc.documentElement.dataset.appearance).toBe(id);
  expect(doc.documentElement.dataset.theme).toBe(base);
  expect(doc.documentElement.dataset.embedded).toBe('true');
  expect(doc.documentElement.style.colorScheme).toBe(base === 'gpt' ? 'dark' : 'light');
  const parentStyle = getComputedStyle(document.documentElement);
  for (const property of ['--surface-page', '--text-primary', '--fragment-accent', '--font-reading']) {
    expect(doc.documentElement.style.getPropertyValue(property)).toBe(parentStyle.getPropertyValue(property).trim());
  }
}

it.each(THEMES)('介绍及新打开的规则沿用 $id，切换主题不重载阅读页面', ({ id, base }) => {
  setTheme(id);
  render(<Workspace />);
  const input = screen.getByRole('textbox', { name: '草稿' });
  fireEvent.click(screen.getByRole('button', { name: '介绍' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = loadFrame(frame);
  expectCurrentPalette(doc, id, base);
  const entry = window.history.state;
  const historyLength = window.history.length;
  vi.mocked(aboutNavigation.replaceAboutDocument).mockClear();
  for (const theme of THEMES) {
    act(() => setTheme(theme.id));
    expectCurrentPalette(doc, theme.id, theme.base);
    expect(screen.getByTitle('公论介绍与文档')).toBe(frame);
    expect(frame.contentDocument).toBe(doc);
    expect(window.history.state).toEqual(entry);
    expect(window.history.length).toBe(historyLength);
    expect(frame.contentWindow!.scrollTo).not.toHaveBeenCalled();
  }
  expect(aboutNavigation.replaceAboutDocument).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'gpt-arena' })));
  expectCurrentPalette(doc, 'gpt-arena', 'gpt');
  fireEvent.click(doc.querySelector('a')!);
  expect(aboutNavigation.replaceAboutDocument).toHaveBeenCalledWith(frame, '/docs/usage.html');
  const rules = loadFrame(frame);
  expectCurrentPalette(rules, 'gpt-arena', 'gpt');
  expect(input).toHaveValue('未发送的内容');
});

it.each([500, 1100, 1400])('主题同步在宽度 %s 不展开折叠菜单并保留手动状态', width => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  try {
    Object.defineProperty(frame.contentWindow!, 'innerWidth', { configurable: true, value: width });
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<details class="document-collapsible"><summary>文档导航</summary></details><details class="document-collapsible"><summary>本页目录</summary></details>';
    const [library, contents] = [...doc.querySelectorAll('details')];
    applyDocumentTheme(doc, 'opus-paper');
    expect(library.open).toBe(false);
    expect(contents.open).toBe(false);
    library.open = true;
    applyDocumentTheme(doc, 'opus-paper');
    expect(library.open).toBe(true);
    applyDocumentTheme(doc, 'gpt');
    expect(library.open).toBe(true);
    expect(contents.open).toBe(false);
  } finally { frame.remove(); }
});
