import type { CSSProperties } from 'react';

export const DIALOG_BACKDROP = 'rgba(0,0,0,0.4)';

export const dialogStyles = {
  panel: {
    background: '#1f2937', border: '1px solid #374151', borderRadius: 12,
    boxShadow: '0 16px 40px rgba(0,0,0,0.45)', color: '#f3f4f6', boxSizing: 'border-box',
  },
  header: { padding: '14px 16px', borderBottom: '1px solid #374151', fontSize: 15, fontWeight: 700 },
  body: { padding: 16, fontSize: 14, lineHeight: 1.6 },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid #374151' },
  button: {
    padding: '6px 14px', borderRadius: 8, border: '1px solid #4b5563',
    background: '#374151', color: '#e5e7eb', cursor: 'pointer', fontSize: 13,
  },
  primaryButton: {
    padding: '6px 14px', borderRadius: 8, border: '1px solid transparent',
    background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
  },
} satisfies Record<string, CSSProperties>;
