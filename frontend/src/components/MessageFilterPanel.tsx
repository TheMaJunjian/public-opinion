// Saved-view compatibility: ordinary views exclude records independently of old flags.
// JOIN records are explicitly opened through the membership labels.

import { useState, useRef, useEffect } from 'react';
import {dialogStyles} from './dialogStyles';
import ThemeIcon from '../theme/ThemeIcon';
import { isSettlementRecord } from '../utils/modelBridge';

export interface MessageFilterSettings {
  /** Legacy saved-view field; settlement records now stay in the target's entry. */
  hideSettlement: boolean;
  /** Legacy saved-view field; JOIN records are shown only in temporary categories. */
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
  const hasActive = settings.hideJoin;

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
        className="workbench-clean-toggle"
        onClick={() => setOpen(prev => !prev)}
        title="清爽视图：快速屏蔽加入消息"
        style={{
          padding: '4px 10px',
          borderRadius: 4,
          border: hasActive ? '1px solid var(--line-a78bfa)' : '1px solid var(--line-555)',
          background: hasActive ? 'var(--surface-6d28d9)' : 'var(--surface-333)',
          color: 'var(--ink-eee)',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: hasActive ? 600 : 400,
        }}
        aria-pressed={hasActive}
        aria-expanded={open}
      >
        {hasActive ? <><ThemeIcon name="clean" fallback="🧹" /> 清爽</> : '清爽视图'}
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
            ...dialogStyles.panel,
            padding: 12,
            zIndex: 100,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--ink-e2e8f0)' }}>
            <ThemeIcon name="clean" fallback="🧹" /> 清爽视图
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* 加入消息开关 */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                padding: '6px 8px',
                borderRadius: 4,
                background: settings.hideJoin ? 'var(--surface-rgba-167-139-250-0-1)' : 'transparent',
                border: settings.hideJoin ? '1px solid var(--line-rgba-167-139-250-0-3)' : '1px solid transparent',
                fontSize: 13,
                color: 'var(--ink-e2e8f0)',
              }}
            >
              <input
                type="checkbox"
                checked={settings.hideJoin}
                onChange={() => toggleFilter('hideJoin')}
                style={{ accentColor: 'var(--ink-a78bfa)' }}
              />
              <span>屏蔽加入消息</span>
            </label>
          </div>

          {!hasActive && (
            <div style={{ fontSize: 11, color: 'var(--ink-64748b)', marginTop: 8 }}>
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
  // Keep accepting legacy saved-view settings without letting them reveal records.
  void settings;
  return messages.filter(m => {
    if (isSettlementRecord(m)) return false;
    if (m.kind === 'join') return false;
    return true;
  });
}
