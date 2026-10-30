import type { CSSProperties } from 'react';

export const DIALOG_BACKDROP = 'var(--surface-rgba-0-0-0-0-4)';

export const dialogStyles = {
  panel: {
    background: 'var(--dialog-surface)', border: '1px solid var(--dialog-border)', borderLeft: 'var(--dialog-accent-border)', borderRadius: 'var(--dialog-radius)',
    boxShadow: 'var(--dialog-shadow)', color: 'var(--text-primary)', boxSizing: 'border-box',
  },
  header: { padding: '14px 16px', borderBottom: '1px solid var(--dialog-border)', fontFamily: 'var(--dialog-heading-font)', fontSize: 'var(--dialog-heading-size)', fontWeight: 'var(--dialog-heading-weight)' },
  body: { padding: 16, fontSize: 'var(--dialog-body-size)', lineHeight: 1.6, color: 'var(--dialog-body-color)' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--dialog-border)' },
  input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--border-default)', borderRadius: 'var(--button-radius)', background: 'var(--surface-card)', color: 'var(--text-primary)', font: 'inherit' },
  button: {
    padding: '6px 14px', borderRadius: 'var(--button-radius)', minHeight: 'var(--button-min-height)', border: '1px solid var(--button-secondary-border)',
    background: 'var(--button-secondary-bg)', color: 'var(--button-secondary-text)', cursor: 'pointer', fontSize: 13,
  },
  primaryButton: {
    padding: '6px 14px', borderRadius: 'var(--button-radius)', minHeight: 'var(--button-min-height)', border: '1px solid transparent',
    background: 'var(--button-primary-bg)', color: 'var(--button-primary-text)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
  },
} satisfies Record<string, CSSProperties>;
