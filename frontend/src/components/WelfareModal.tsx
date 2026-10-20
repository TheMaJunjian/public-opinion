import { useRef, useState } from 'react';
import PopupOverlay from './PopupOverlay';
import { DIALOG_BACKDROP, dialogStyles } from './dialogStyles';

interface Props {
  open: boolean;
  onClose: () => void;
}

const welfareLinks = [
  { name: '环序', url: 'https://themajunjian.github.io/CycleOrder/' },
  { name: '天道酬勤', url: 'https://themajunjian.github.io/TianDaoChouQin' },
];

export default function WelfareModal({ open, onClose }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  if (!open) return null;

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
    } catch {
      setCopiedUrl(null);
    }
  };

  return (
    <PopupOverlay
      contentRef={contentRef}
      zIndex={1000}
      background={DIALOG_BACKDROP}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, boxSizing: 'border-box',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={contentRef} role="dialog" aria-modal="true" aria-label="福利" style={{
        ...dialogStyles.panel, width: 'min(100%, 470px)', maxHeight: '100%', overflow: 'auto',
      }}>
        <div style={{
          ...dialogStyles.header, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>福利</div>
          <button data-shortcut-cancel="true" aria-label="关闭福利" type="button" onClick={onClose} style={dialogStyles.button}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.7 }}>
          {welfareLinks.map(({ name, url }) => (
            <div key={url} style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 14 }}>{name}：</span>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => void handleCopy(url)}
                style={{
                  color: '#9ca3af', overflowWrap: 'anywhere', textDecoration: 'underline',
                }}
              >
                {url}
              </a>
              {copiedUrl === url && <span style={{ marginLeft: 8, color: '#86efac', whiteSpace: 'nowrap' }}>已复制</span>}
            </div>
          ))}
        </div>
      </div>
    </PopupOverlay>
  );
}
