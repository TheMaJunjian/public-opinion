// MessageFilterPanel.tsx — 消息类型过滤面板
// 提供开关来屏蔽/显示结算消息和加入消息

import { useState, useRef, useEffect } from 'react';

export interface MessageFilterSettings {
  /** 是否屏蔽结算消息 (round / round_result) */
  hideSettlement: boolean;
  /** 是否屏蔽加入消息 (join) */
  hideJoin: boolean;
}

interface MessageFilterPanelProps {
  /** 当前过滤设置 */
  settings: MessageFilterSettings;
  /** 更新过滤设置 */
  onChange: (settings: MessageFilterSettings) => void;
}

export default function MessageFilterPanel({
  settings,
  onChange,
}: MessageFilterPanelProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // 是否有任何过滤激活
  const hasActive = settings.hideSettlement || settings.hideJoin;

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleFilter = (key: keyof MessageFilterSettings) => {
    onChange({ ...settings, [key]: !settings[key] });
  };

  return (
    <div ref={panelRef} style={{ position: 'relative', flexShrink: 0 }}>
      {/* Toggle 按钮 */}
      <button
        onClick={() => setOpen(prev => !prev)}
        title="清爽视图：快速屏蔽结算/加入消息"
        style={{
          padding: '4px 10px',
          borderRadius: 4,
          border: hasActive ? '1px solid #a78bfa' : '1px solid #555',
          background: hasActive ? '#6d28d9' : '#333',
          color: '#eee',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: hasActive ? 600 : 400,
        }}
      >
        {hasActive ? '🧹 清爽' : '清爽视图'}
      </button>

      {/* 下拉面板 */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            width: 240,
            background: '#1a1a2e',
            border: '1px solid #334155',
            borderRadius: 8,
            padding: 12,
            zIndex: 100,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: '#e2e8f0' }}>
            🧹 清爽视图
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* 结算消息开关 */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                padding: '6px 8px',
                borderRadius: 4,
                background: settings.hideSettlement ? 'rgba(167,139,250,0.1)' : 'transparent',
                border: settings.hideSettlement ? '1px solid rgba(167,139,250,0.3)' : '1px solid transparent',
                fontSize: 13,
                color: '#e2e8f0',
              }}
            >
              <input
                type="checkbox"
                checked={settings.hideSettlement}
                onChange={() => toggleFilter('hideSettlement')}
                style={{ accentColor: '#a78bfa' }}
              />
              <span>屏蔽结算消息</span>
            </label>

            {/* 加入消息开关 */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                padding: '6px 8px',
                borderRadius: 4,
                background: settings.hideJoin ? 'rgba(167,139,250,0.1)' : 'transparent',
                border: settings.hideJoin ? '1px solid rgba(167,139,250,0.3)' : '1px solid transparent',
                fontSize: 13,
                color: '#e2e8f0',
              }}
            >
              <input
                type="checkbox"
                checked={settings.hideJoin}
                onChange={() => toggleFilter('hideJoin')}
                style={{ accentColor: '#a78bfa' }}
              />
              <span>屏蔽加入消息</span>
            </label>
          </div>

          {!hasActive && (
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
              未启用任何过滤
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 根据过滤设置筛选消息 */
export function applyMessageFilter<T extends { id: string; kind: string }>(
  messages: T[],
  settings: MessageFilterSettings,
): T[] {
  if (!settings.hideSettlement && !settings.hideJoin) return messages;
  return messages.filter(m => {
    if (settings.hideSettlement && (m.kind === 'round' || m.kind === 'round_result')) return false;
    if (settings.hideJoin && m.kind === 'join') return false;
    return true;
  });
}
