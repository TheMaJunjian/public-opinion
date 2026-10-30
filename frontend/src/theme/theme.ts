import { useSyncExternalStore } from 'react';

export interface ThemeLayout {
  readonly messageJump: 'inline' | 'clipboard-dialog';
  readonly relationControls: 'toolbar' | 'desk';
}

interface ThemeDefinition {
  readonly id: string;
  readonly base: 'gpt' | 'opus';
  readonly name: string;
  readonly description: string;
  readonly layout: ThemeLayout;
}

/** Each appearance explicitly declares its controls; a new name never implies a layout. */
export const THEMES = [
  { id: 'gpt', base: 'gpt', name: '原版', description: '保留原来的深色界面',
    layout: { messageJump: 'inline', relationControls: 'toolbar' } },
  { id: 'gpt-arena', base: 'gpt', name: 'gpt6astra-max · 议事厅·卡牌', description: '深色桌面、金属边缘与独立的关系载体',
    layout: { messageJump: 'clipboard-dialog', relationControls: 'desk' } },
  { id: 'opus-paper', base: 'opus', name: 'opus5.5-high · 案卷·印信', description: '暖纸案卷、页签框架与印信装饰',
    layout: { messageJump: 'clipboard-dialog', relationControls: 'desk' } },
] as const satisfies readonly ThemeDefinition[];
export type Theme = typeof THEMES[number]['id'];
export const THEME_STORAGE_KEY = 'gonglun.theme';
const CHANGE_EVENT = 'gonglun-theme-change';

export function normalizeTheme(value: unknown): Theme {
  return THEMES.some(theme => theme.id === value) ? value as Theme : 'opus-paper';
}

export function getTheme(): Theme {
  return typeof document === 'undefined' ? 'opus-paper' : normalizeTheme(document.documentElement.dataset.appearance ?? document.documentElement.dataset.theme);
}

export function getThemeSettings(theme: Theme) {
  return THEMES.find(option => option.id === theme)!;
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.appearance = theme;
  document.documentElement.dataset.theme = getThemeSettings(theme).base;
}

export function setTheme(theme: Theme | 'opus'): void {
  const normalized = normalizeTheme(theme);
  applyTheme(normalized);
  try { localStorage.setItem(THEME_STORAGE_KEY, normalized); } catch { /* The current tab still works without storage. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    applyTheme(normalizeTheme(event.newValue));
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useTheme() {
  return useSyncExternalStore(subscribe, getTheme, () => 'opus-paper' as const);
}

export function useThemeSettings() {
  return getThemeSettings(useTheme());
}
