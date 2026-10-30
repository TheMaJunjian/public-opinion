import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const readCss = (file) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../theme', file), 'utf8');
const gpt = readCss('gpt.css');
const opus = readCss('opus.css');

const sources = import.meta.glob(['../components/**/*.{ts,tsx,css}', '../pages/**/*.{ts,tsx}', '../utils/*.{ts,tsx}', '../types/*.ts', '../theme/*.tsx', '../App.tsx', '../index.css'], {
  query: '?raw', import: 'default', eager: true,
});
for (const file of ['gpt.css', 'opus.css', 'shared.css', 'opus-layout.css', 'message-skins.css', 'opus-paper.css', 'gpt-arena.css', 'stake-tiers.css', 'specimen-skins.css', 'specimen-layout.css']) sources[file] = readCss(file);
const declarations = (source) => new Set([...source.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));

describe('theme coverage', () => {
  it('defines the same tokens for both appearances', () => {
    expect(declarations(gpt).size).toBeGreaterThan(20);
    expect([...declarations(gpt)].sort()).toEqual([...declarations(opus)].sort());
  });

  it('resolves every static paint token used by pages, popups and shared controls', () => {
    const defined = new Set(Object.values(sources).flatMap(source => [...declarations(source)]));
    // Recommendation intensity is supplied per message; other layout variables have fallbacks.
    defined.add('--recommendation-level');
    const missing = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/var\((--[\w-]+)\)/g)) {
        if (!defined.has(match[1])) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it('keeps raw paint out of UI components, including guide SVGs', () => {
    const leaked = Object.entries(sources).filter(([file, source]) => (!file.endsWith('.css') || file.startsWith('../components/'))
      && /#[\da-fA-F]{3,8}\b|rgba?\(\s*\d|\b(?:bg|text|border|ring|divide|outline|accent|fill|stroke)-(?:white|black|(?:gray|slate|zinc|neutral|stone|red|green|blue|indigo|amber|yellow|orange|pink|purple|violet|rose|sky|cyan|teal|emerald)-\d{2,3})\b/.test(source)).map(([file]) => file);
    expect(leaked).toEqual([]);
  });
});
