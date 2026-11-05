import { getThemeSettings, type Theme } from './theme';

const documentTokens = [
  '--surface-page', '--surface-card', '--surface-panel', '--surface-hover',
  '--text-primary', '--text-secondary', '--text-muted', '--border-default',
  '--selection-accent', '--selection-bg', '--fragment-accent', '--font-reading',
  '--button-primary-bg', '--button-primary-text', '--button-secondary-bg',
  '--button-secondary-text', '--button-secondary-border', '--button-radius',
  '--recommendation-accent',
];

/** Share appearance tokens with the script-free document without navigating its iframe. */
export function applyDocumentTheme(target: Document, theme: Theme) {
  const root = target.documentElement;
  if (!root) return; // A newly created or navigating iframe may not have parsed its root yet.
  const source = getComputedStyle(document.documentElement);
  const { base } = getThemeSettings(theme);
  root.dataset.appearance = theme;
  root.dataset.theme = base;
  root.dataset.embedded = 'true';
  root.style.colorScheme = base === 'gpt' ? 'dark' : 'light';
  for (const token of documentTokens) {
    const value = source.getPropertyValue(token).trim();
    if (value) root.style.setProperty(token, value);
    else root.style.removeProperty(token);
  }
  // Plain-text AI guides also inherit the page and text colors without changing their content.
  root.style.color = 'var(--text-primary)';
  root.style.backgroundColor = 'var(--surface-page)';
}
