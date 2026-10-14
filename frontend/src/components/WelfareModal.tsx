import { useRef, useState } from 'react';
import PopupOverlay from './PopupOverlay';

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
      background="rgba(0,0,0,0.7)"
      style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start',
        padding: '64px 0 0 180px', boxSizing: 'border-box',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={contentRef} style={{
        width: 'min(92vw, 470px)', background: '#101010', borderRadius: 8,
        border: '1px solid #444', color: '#dbe4f0', overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid #333', background: '#181818',
          color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>福利</div>
          <button data-shortcut-cancel="true" type="button" onClick={onClose} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 13, cursor: 'pointer',
            background: '#333', color: '#fff', border: '1px solid #666',
          }}>✕</button>
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