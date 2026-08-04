import { createPortal } from 'react-dom';
import { useEffect, useRef } from 'react';

interface PromptModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  confirmDisabled?: boolean;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

/**
 * PromptModal - reusable modal for alert/confirm prompts.
 * Centered by default; if the confirm button would be off-screen,
 * the overlay auto-scrolls to bring it into the visible area.
 */
export default function PromptModal({
  open,
  title,
  message,
  confirmText = '确定',
  confirmDisabled = false,
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Wait for layout, then check if footer is in viewport
    const timer = setTimeout(() => {
      const footer = footerRef.current;
      const overlay = overlayRef.current;
      if (!footer || !overlay) return;
      const rect = footer.getBoundingClientRect();
      const viewH = window.innerHeight;
      // If footer bottom is below viewport, scroll overlay to show it
      if (rect.bottom > viewH) {
        overlay.scrollTop = overlay.scrollHeight;
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      data-prompt-modal="true"
      role="presentation"
      onClick={() => onCancel?.()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        overflow: 'auto',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(460px, 100%)',
          maxHeight: 'calc(100vh - 32px)',
          background: '#1f2937',
          border: '1px solid #374151',
          borderRadius: 12,
          boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
          color: '#f3f4f6',
          overflow: 'auto',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #374151', fontSize: 15, fontWeight: 700 }}>
          {title}
        </div>

        <div style={{ padding: '16px', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {message}
        </div>

        <div ref={footerRef} style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid #374151' }}>
          {onCancel && (
            <button
              onClick={onCancel}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                border: '1px solid #4b5563',
                background: '#374151',
                color: '#e5e7eb',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {cancelText}
            </button>
          )}
          <button
            onClick={onConfirm}
            disabled={confirmDisabled}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: '1px solid transparent',
              background: danger ? '#b91c1c' : '#2563eb',
              color: '#fff',
              cursor: confirmDisabled ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
              opacity: confirmDisabled ? 0.6 : 1,
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
