import { createPortal } from 'react-dom';
import { useLayoutEffect, useState } from 'react';
import { Z_INDEX } from '../constants/zIndex';

interface RegistrationGuideHintProps {
  open: boolean;
  onClose: () => void;
}

export default function RegistrationGuideHint({ open, onClose }: RegistrationGuideHintProps) {
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const target = document.querySelector<HTMLElement>('[data-guide-button="true"]');
      setTargetRect(target?.getBoundingClientRect() ?? null);
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  if (!open) return null;

  const left = targetRect
    ? Math.max(16, Math.min(targetRect.left, window.innerWidth - 336))
    : 16;
  const top = targetRect ? targetRect.bottom + 14 : 76;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: Z_INDEX.guide, pointerEvents: 'none' }}>
      {targetRect && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            top: targetRect.top - 6,
            left: targetRect.left - 8,
            width: targetRect.width + 16,
            height: targetRect.height + 12,
            border: '2px solid #facc15',
            borderRadius: 6,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.35), 0 0 18px rgba(250,204,21,0.7)',
          }}
        />
      )}
      <div
        role="dialog"
        aria-label="新手提示"
        style={{
          position: 'fixed',
          top,
          left,
          width: 'min(320px, calc(100vw - 32px))',
          boxSizing: 'border-box',
          padding: '16px 18px',
          border: '1px solid #facc15',
          borderRadius: 10,
          background: '#18181b',
          color: '#f4f4f5',
          boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ color: '#fde68a', fontWeight: 700, fontSize: 15 }}>欢迎与会者加入公论</div>
        <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: 1.7 }}>
          点击上方的“引导”按钮，可以查看分步骤操作引导。<br />
          点击“引导”按钮右侧的“教程”按钮可以查看教程。
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: '6px 16px', border: '1px solid #facc15', borderRadius: 5, background: '#713f12', color: '#fef3c7', cursor: 'pointer', fontSize: 12 }}
          >
            已阅
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
