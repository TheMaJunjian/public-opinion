import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import PopupOverlay from './PopupOverlay';
import { DIALOG_BACKDROP, dialogStyles } from './dialogStyles';
import {useWorkbenchPortalTarget} from '../context/WorkbenchPortalContext';

let bodyScrollLockCount = 0;
let bodyOverflowBeforeLock = '';

interface PromptModalProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmText?: string;
  confirmDisabled?: boolean;
  cancelText?: string;
  danger?: boolean;
  hideActions?: boolean;
  lockScroll?: boolean;
  guideSettlementConfirm?: boolean;
  zIndex?: number;
  dialogProps?: HTMLAttributes<HTMLDivElement>;
  confirmButtonRef?: Ref<HTMLButtonElement>;
  onConfirm: () => void;
  onCancel?: () => void;
}

/**
 * PromptModal - reusable modal for alert/confirm prompts.
 * Centered by default; if the confirm button would be off-screen,
 * shifts the dialog upward so the button stays visible.
 */
export default function PromptModal({
  open,
  title,
  message,
  confirmText = '确定',
  confirmDisabled = false,
  cancelText = '取消',
  danger = false,
  hideActions = false,
  lockScroll = true,
  guideSettlementConfirm = false,
  zIndex = 3000,
  dialogProps,
  confirmButtonRef,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const portalTarget=useWorkbenchPortalTarget();
  const [offsetY, setOffsetY] = useState(0);
  useLayoutEffect(() => {
    if (!open || !lockScroll) return;
    if (bodyScrollLockCount === 0) {
      bodyOverflowBeforeLock = document.body.style.overflow;
    }
    bodyScrollLockCount += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
      if (bodyScrollLockCount === 0) {
        document.body.style.overflow = bodyOverflowBeforeLock;
      }
    };
  }, [open, lockScroll]);

  useLayoutEffect(() => {
    if (!open) { setOffsetY(0); return; }
    const timer = setTimeout(() => {
      const footer = footerRef.current;
      if (!footer) return;
      const rect = footer.getBoundingClientRect();
      const viewH = window.innerHeight;
      // If confirm button is below viewport, shift dialog upward
      if (rect.bottom > viewH) {
        setOffsetY(-(rect.bottom - viewH + 16));
      } else {
        setOffsetY(0);
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <PopupOverlay
      contentRef={dialogRef}
      zIndex={zIndex}
      background={DIALOG_BACKDROP}
      dataPromptModal
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        boxSizing: 'border-box',
      }}
      onClick={() => onCancel?.()}
    >
      <div
        {...dialogProps}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => { e.stopPropagation(); dialogProps?.onClick?.(e); }}
        style={{
          ...dialogStyles.panel,
          width: 'min(460px, 100%)',
          maxHeight: '100%',
          overflow: 'auto',
          transform: `translateY(${offsetY}px)`,
          ...dialogProps?.style,
        }}
      >
        <div style={dialogStyles.header}>
          {title}
        </div>

        <div
          {...(guideSettlementConfirm ? { 'data-guide-settlement-message': 'true' } : {})}
          style={{
            ...dialogStyles.body,
            whiteSpace: 'pre-wrap',
          }}
        >
          {message}
        </div>

        {!hideActions && <div ref={footerRef} style={dialogStyles.footer}>
          {onCancel && (
            <button
              data-shortcut-cancel="true"
              onClick={onCancel}
              style={dialogStyles.button}
            >
              {cancelText}
            </button>
          )}
          <button
            ref={confirmButtonRef}
            data-shortcut-confirm="true"
            {...(guideSettlementConfirm ? { 'data-guide-settlement-confirm': 'true' } : {})}
            onClick={onConfirm}
            disabled={confirmDisabled}
            style={{
              ...dialogStyles.primaryButton,
              background: danger ? 'var(--button-danger-bg)' : dialogStyles.primaryButton.background,
              cursor: confirmDisabled ? 'not-allowed' : 'pointer',
              opacity: confirmDisabled ? 0.6 : 1,
            }}
          >
            {confirmText}
          </button>
        </div>}
      </div>
    </PopupOverlay>,
    portalTarget,
  );
}
