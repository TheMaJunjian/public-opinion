import { useEffect, useRef, useState } from 'react';

export type HomeFilterMode =
  | 'read-self'
  | 'read-related'
  | 'unread-related'
  | 'unread-other';

interface HomeFilterPanelProps {
  mode: HomeFilterMode | null;
  onChange: (mode: HomeFilterMode) => void;
}

const OPTIONS: Array<{ mode: HomeFilterMode; label: string; description: string }> = [
  { mode: 'read-self', label: '已读 · 自发', description: '我发送的内容消息' },
  { mode: 'read-related', label: '已读 · 相关', description: '我标注已读的目标及其上下文' },
  { mode: 'unread-related', label: '未读 · 相关', description: '与我发送消息有关的未读消息' },
  { mode: 'unread-other', label: '未读 · 其他', description: '未读消息中排除与我相关的消息' },
];

export default function HomeFilterPanel({ mode, onChange }: HomeFilterPanelProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedMode = mode ?? 'unread-related';
  const isActive = mode !== null;
  const activeOption = OPTIONS.find(option => option.mode === selectedMode) ?? OPTIONS[2];

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  return (
    <div ref={panelRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => {
          if (mode === null) onChange('unread-related');
          setOpen(current => !current);
        }}
        title="主页：按与我相关的范围查看消息"
        style={{
          padding: '2px 8px',
          borderRadius: 4,
          border: isActive ? '1px solid #38bdf8' : '1px solid #666',
          background: isActive ? '#123047' : '#333',
          color: isActive ? '#bae6fd' : '#fff',
          fontSize: 12,
          cursor: 'pointer',
          fontWeight: isActive ? 600 : 400,
        }}
      >
        主页
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            width: 270,
            padding: 10,
            background: '#17202b',
            border: '1px solid #3b5368',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            zIndex: 100,
          }}
        >
          <div style={{ color: '#e0f2fe', fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
            主页模式
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {OPTIONS.map(option => (
              <label
                key={option.mode}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '7px 8px',
                  borderRadius: 4,
                  border: option.mode === selectedMode ? '1px solid #38bdf8' : '1px solid transparent',
                  background: option.mode === selectedMode ? 'rgba(14,165,233,0.16)' : 'transparent',
                  color: '#e5e7eb',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="home-filter-mode"
                  checked={option.mode === selectedMode}
                  onChange={() => onChange(option.mode)}
                  style={{ marginTop: 2, accentColor: '#38bdf8' }}
                />
                <span>
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>{option.label}</span>
                  <span style={{ display: 'block', marginTop: 2, color: '#94a3b8', fontSize: 11 }}>{option.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 8, color: '#64748b', fontSize: 11 }}>
            当前：{activeOption.label}
          </div>
        </div>
      )}
    </div>
  );
}
