import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import entryHtml from '../../index.html?raw';
import ThemeSwitcher from '../theme/ThemeSwitcher';
import { getTheme, normalizeTheme, setTheme, THEME_STORAGE_KEY, THEMES } from '../theme/theme';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.appearance;
  vi.restoreAllMocks();
});

describe('appearance preference', () => {
  it('restores all three saved choices before mounting the app and accepts legacy values', () => {
    const bootstrap = entryHtml.match(/<script>([\s\S]*?)<\/script>/)![1];
    for (const {id, base} of THEMES) {
      localStorage.setItem(THEME_STORAGE_KEY, id);
      delete document.documentElement.dataset.appearance;
      new Function(bootstrap)();
      expect(getTheme()).toBe(id);
      expect(document.documentElement.dataset.theme).toBe(base);
    }
    localStorage.setItem(THEME_STORAGE_KEY, 'opus');
    new Function(bootstrap)();
    expect(getTheme()).toBe('opus-paper');
  });

  it('keeps an in-progress draft, selection and portal mounted when changing and remembering the theme', () => {
    function Workbench() {
      const [draft, setDraft] = useState('');
      const [selected, setSelected] = useState(false);
      return <><ThemeSwitcher /><textarea aria-label="正文" value={draft} onChange={e => setDraft(e.target.value)} />
        <button aria-pressed={selected} onClick={() => setSelected(!selected)}>消息</button>
        {createPortal(<div role="dialog">相关记录</div>, document.body)}</>;
    }
    render(<Workbench />);
    fireEvent.click(screen.getByRole('button', { name: '风格' }));
    const input = screen.getByRole('textbox');
    const portal = screen.getByText('相关记录');
    fireEvent.change(input, { target: { value: '尚未发送的内容' } });
    fireEvent.click(screen.getByRole('button', { name: '消息' }));
    for (const {id:theme, name, base} of THEMES) {
      fireEvent.click(screen.getByRole('radio', { name }));
      expect(getTheme()).toBe(theme);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(theme);
      expect(screen.getByRole('textbox')).toBe(input);
      expect(input).toHaveValue('尚未发送的内容');
      expect(screen.getByRole('button', { name: '消息' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('相关记录')).toBe(portal);
      expect(portal.closest('html')).toHaveAttribute('data-theme', base);
      expect(portal.closest('html')).toHaveAttribute('data-appearance', theme);
    }
  });

  it('accepts a saved preference from another tab and resets a removed preference to Opus', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: '风格' }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'gpt' })));
    expect(screen.getByRole('radio', { name: '原版' })).toBeChecked();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: null })));
    expect(screen.getByRole('radio', { name: 'opus5.5-high · 案卷·印信' })).toBeChecked();
  });

  it('works when preference storage is blocked and rejects an unknown theme', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => setTheme('gpt')).not.toThrow();
    expect(getTheme()).toBe('gpt');
    expect(normalizeTheme('unknown')).toBe('opus-paper');
    expect(normalizeTheme('opus')).toBe('opus-paper');
  });
});
