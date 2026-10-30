import type { ReactNode } from 'react';

const shapes = {
  truth: <><path d="M12 3v17M6 21h12M4 7h16M6 7l-3 7h6L6 7Zm12 0-3 7h6l-3-7Z" /><path d="M3 14c0 3 6 3 6 0m6 0c0 3 6 3 6 0" /></>,
  value: <><path d="m7 4-5 7 10 11 10-11-5-7H7Zm-5 7h20M7 4l5 18 5-18" /></>,
  proposal: <><path d="m3 8 9-5 9 5H3Zm2 3v7m5-7v7m4-7v7m5-7v7M3 21h18" /></>,
  delegation: <><path d="m2 8 4-3 5 2 3-2 8 5-4 9-4 2-7-5-5-8Z" /><path d="m11 7-3 5 2 2 4-4 5 4m-5 3 3 2" /></>,
  code: <path d="m7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18" />,
  operations: <path d="M3 3v18h18M7 16v-5m5 5V6m5 10V9" />,
  message: <path d="M21 4H3v13h5v4l5-4h8V4Z" />,
  points: <><circle cx="12" cy="12" r="9" /><path d="m12 7 5 5-5 5-5-5 5-5Z" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
  loss: <path d="m3 5 6 6 4-4 8 11m-6 0h6v-6" />,
  gain: <path d="m3 19 6-6 4 4 8-11m-6 0h6v6" />,
  clean: <><path d="m14 3 7 7M16 5l-5 5m-5 0 8 8-5 3-6-6 3-5Zm0 0 4-1 5 5-1 4M6 16l4-4" /></>,
  pin: <path d="m9 3 12 12-3 1-4-2-5 5-4-4 5-5-2-4 1-3ZM5 19l-3 3" />,
} satisfies Record<string, ReactNode>;

/** CSS swaps only the paint; labels, handlers and the other appearances stay intact. */
export default function ThemeIcon({ name, fallback, beforeLabel = false }: { name: keyof typeof shapes; fallback: ReactNode; beforeLabel?: boolean }) {
  return <><span className="theme-icon-legacy">{fallback}</span><svg className={`theme-icon-arena${beforeLabel ? ' theme-icon-before-label' : ''}`} aria-hidden="true" focusable="false"
    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg></>;
}

const prefixes = [['🏛️', 'proposal'], ['🤝', 'delegation'], ['💻', 'code'], ['📊', 'operations'], ['⚖️', 'truth'], ['💎', 'value']] as const;
const labelIcons: Partial<Record<string, keyof typeof shapes>> = {
  '提案': 'proposal', '治理提案': 'proposal', '委托': 'delegation', '创建委托': 'delegation', '完成委托': 'delegation',
  '代码': 'code', '运营': 'operations', '真假仲裁': 'truth', '真假仲裁结算': 'truth', '价值仲裁': 'value', '价值仲裁结算': 'value',
};

/** For application-owned labels only; message content is rendered verbatim elsewhere. */
export function ThemeLabel({ text }: { text: string }) {
  const prefix = prefixes.find(([symbol]) => text.startsWith(symbol));
  const icon = prefix?.[1] ?? labelIcons[text];
  return icon ? <><ThemeIcon name={icon} fallback={prefix?.[0] ?? null} beforeLabel={!prefix} />{prefix ? text.slice(prefix[0].length) : text}</> : <>{text}</>;
}
