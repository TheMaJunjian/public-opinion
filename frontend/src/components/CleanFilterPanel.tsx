// CleanFilterPanel.tsx — 聚焦模式过滤器面板
// 提供可视化界面来添加/移除/查看过滤规则，以及匹配结果统计。

import { useState, useRef, useEffect } from 'react';
import type { CleanFilterRule } from '../types';
import { CLEAN_FILTER_LABELS, defaultCleanRule } from '../types';

interface CleanFilterPanelProps {
  /** 是否激活聚焦模式 */
  active: boolean;
  /** 当前规则列表 */
  filters: CleanFilterRule[];
  /** 匹配的消息数 */
  matchCount: number;
  /** 总消息数 */
  totalCount: number;
  /** 添加规则 */
  onAdd: (rule: CleanFilterRule) => void;
  /** 移除规则 */
  onRemove: (ruleId: string) => void;
  /** 更新规则 */
  onUpdate: (ruleId: string, updater: (rule: CleanFilterRule) => CleanFilterRule) => void;
  /** 清空所有规则 */
  onClear: () => void;
}

const RULE_KINDS: CleanFilterRule['kind'][] = ['sender', 'stake', 'participants', 'rounds', 'tag', 'relationType'];

/** 单条规则的简要描述 */
function ruleSummary(rule: CleanFilterRule): string {
  switch (rule.kind) {
    case 'sender':
      return rule.username ? `发送者: ${rule.username}` : '发送者: (未设置)';
    case 'stake': {
      const side = rule.side ? ` (${rule.side === 'PRO' ? '赞同方' : '反对方'})` : '';
      return `押注 ≥ ${rule.minAmount} 点${side}`;
    }
    case 'participants':
      return `站队人数 ≥ ${rule.minCount}`;
    case 'rounds':
      return `结算轮次 ≥ ${rule.minRounds}`;
    case 'tag':
      return `${rule.tagType} 标签 ≥ ${rule.minCount}`;
    case 'relationType':
      return `关系类型: ${rule.relationType}`;
    default:
      return '未知规则';
  }
}

export default function CleanFilterPanel({
  active,
  filters,
  matchCount,
  totalCount,
  onAdd,
  onRemove,
  onClear,
}: CleanFilterPanelProps) {
  const [open, setOpen] = useState(false);
  const [addingKind, setAddingKind] = useState<CleanFilterRule['kind'] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [tempRule, setTempRule] = useState<CleanFilterRule | null>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAddingKind(null);
        setTempRule(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleToggle = () => {
    if (active) {
      onClear();
    } else {
      setOpen(true);
    }
  };

  const handleAddKind = (kind: CleanFilterRule['kind']) => {
    const rule = defaultCleanRule(kind);
    setAddingKind(kind);
    setTempRule(rule);
  };

  const confirmAdd = () => {
    if (tempRule) {
      onAdd(tempRule);
      setAddingKind(null);
      setTempRule(null);
    }
  };

  const cancelAdd = () => {
    setAddingKind(null);
    setTempRule(null);
  };

  return (
    <div ref={panelRef} style={{ position: 'relative', flexShrink: 0 }}>
      {/* Toggle 按钮 */}
      <button
        onClick={handleToggle}
        title={active ? '清爽视图已激活 — 点击关闭' : '清爽视图：按规则过滤消息视图'}
        style={{
          padding: '4px 10px',
          borderRadius: 4,
          border: active ? '1px solid #3b82f6' : '1px solid #555',
          background: active ? '#2563eb' : '#333',
          color: '#eee',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: active ? 600 : 400,
        }}
      >
        {active ? `🧹 清爽 (${filters.length})` : '清爽视图'}
      </button>

      {/* 下拉面板 */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            width: 320,
            background: '#1a1a2e',
            border: '1px solid #334155',
            borderRadius: 8,
            padding: 12,
            zIndex: 100,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#e2e8f0' }}>
            🧹 清爽视图过滤器
          </div>

          {/* 已有规则列表 */}
          {filters.length === 0 && !addingKind && (
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
              添加规则来过滤消息视图。多条规则之间为 AND 关系。
            </div>
          )}
          {filters.map(rule => (
            <div
              key={rule.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                marginBottom: 4,
                borderRadius: 4,
                background: 'rgba(59,130,246,0.12)',
                border: '1px solid rgba(59,130,246,0.25)',
                fontSize: 12,
                color: '#e2e8f0',
              }}
            >
              <span>{ruleSummary(rule)}</span>
              <button
                onClick={() => onRemove(rule.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontSize: 14,
                  padding: '0 2px',
                  lineHeight: 1,
                }}
                title="移除此规则"
              >
                ✕
              </button>
            </div>
          ))}

          {/* 正在添加的规则编辑区 */}
          {addingKind && tempRule && (
            <RuleEditor
              rule={tempRule}
              onChange={setTempRule}
              onConfirm={confirmAdd}
              onCancel={cancelAdd}
            />
          )}

          {/* 添加规则按钮区 */}
          {!addingKind && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>添加规则：</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {RULE_KINDS.map(kind => (
                  <button
                    key={kind}
                    onClick={() => handleAddKind(kind)}
                    disabled={filters.some(f => f.kind === kind)}
                    style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      border: '1px solid #475569',
                      background: filters.some(f => f.kind === kind) ? '#1e293b' : '#0f172a',
                      color: filters.some(f => f.kind === kind) ? '#475569' : '#cbd5e1',
                      cursor: filters.some(f => f.kind === kind) ? 'default' : 'pointer',
                      fontSize: 11,
                    }}
                  >
                    {CLEAN_FILTER_LABELS[kind]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 匹配统计 */}
          {filters.length > 0 && (
            <div
              style={{
                marginTop: 8,
                padding: '4px 8px',
                borderRadius: 4,
                background: 'rgba(34,197,94,0.08)',
                fontSize: 11,
                color: '#86efac',
              }}
            >
              匹配 {matchCount} 条 / 共 {totalCount} 条内容消息
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 规则编辑器 ──

interface RuleEditorProps {
  rule: CleanFilterRule;
  onChange: (rule: CleanFilterRule) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function RuleEditor({ rule, onChange, onConfirm, onCancel }: RuleEditorProps) {
  switch (rule.kind) {
    case 'sender':
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>输入用户名：</div>
          <input
            autoFocus
            value={(rule as { username: string }).username}
            onChange={e => onChange({ ...rule, username: e.target.value } as CleanFilterRule)}
            onKeyDown={e => { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }}
            placeholder="例如: 张三"
            style={{
              width: '100%',
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: '#0f172a',
              color: '#e2e8f0',
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
          <EditorButtons onConfirm={onConfirm} onCancel={onCancel} />
        </div>
      );

    case 'stake':
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>最小押注额度（点）：</div>
          <input
            autoFocus
            type="number"
            min={1}
            value={(rule as { minAmount: number }).minAmount}
            onChange={e => onChange({ ...rule, minAmount: Math.max(1, Number(e.target.value) || 0) } as CleanFilterRule)}
            onKeyDown={e => { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }}
            style={{
              width: '100%',
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: '#0f172a',
              color: '#e2e8f0',
              fontSize: 12,
              boxSizing: 'border-box',
              marginBottom: 4,
            }}
          />
          <select
            value={(rule as { side?: string }).side ?? ''}
            onChange={e =>
              onChange({
                ...rule,
                side: e.target.value ? (e.target.value as 'PRO' | 'CON') : undefined,
              } as CleanFilterRule)
            }
            style={{
              width: '100%',
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: '#0f172a',
              color: '#e2e8f0',
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          >
            <option value="">不限方向</option>
            <option value="PRO">仅赞同方 (PRO)</option>
            <option value="CON">仅反对方 (CON)</option>
          </select>
          <EditorButtons onConfirm={onConfirm} onCancel={onCancel} />
        </div>
      );

    case 'participants':
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>最小站队人数：</div>
          <input
            autoFocus
            type="number"
            min={1}
            value={(rule as { minCount: number }).minCount}
            onChange={e => onChange({ ...rule, minCount: Math.max(1, Number(e.target.value) || 0) } as CleanFilterRule)}
            onKeyDown={e => { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }}
            style={{
              width: '100%',
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: '#0f172a',
              color: '#e2e8f0',
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
          <EditorButtons onConfirm={onConfirm} onCancel={onCancel} />
        </div>
      );

    case 'rounds':
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>最小结算轮次：</div>
          <input
            autoFocus
            type="number"
            min={1}
            value={(rule as { minRounds: number }).minRounds}
            onChange={e => onChange({ ...rule, minRounds: Math.max(1, Number(e.target.value) || 0) } as CleanFilterRule)}
            onKeyDown={e => { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }}
            style={{
              width: '100%',
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: '#0f172a',
              color: '#e2e8f0',
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
          <EditorButtons onConfirm={onConfirm} onCancel={onCancel} />
        </div>
      );

    case 'tag':
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>标签类型 / 最小次数：</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <select
              value={(rule as { tagType: string }).tagType}
              onChange={e => onChange({ ...rule, tagType: e.target.value } as CleanFilterRule)}
              style={{
                flex: 1,
                padding: '4px 8px',
                borderRadius: 4,
                border: '1px solid #475569',
                background: '#0f172a',
                color: '#e2e8f0',
                fontSize: 12,
              }}
            >
              <option value="ARCHIVE">冷藏 (ARCHIVE)</option>
              <option value="RECOMMEND">推荐 (RECOMMEND)</option>
              <option value="TAG">标注 (TAG)</option>
            </select>
            <input
              type="number"
              min={1}
              value={(rule as { minCount: number }).minCount}
              onChange={e => onChange({ ...rule, minCount: Math.max(1, Number(e.target.value) || 0) } as CleanFilterRule)}
              onKeyDown={e => { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }}
              style={{
                width: 60,
                padding: '4px 8px',
                borderRadius: 4,
                border: '1px solid #475569',
                background: '#0f172a',
                color: '#e2e8f0',
                fontSize: 12,
                boxSizing: 'border-box',
              }}
            />
          </div>
          <EditorButtons onConfirm={onConfirm} onCancel={onCancel} />
        </div>
      );

    case 'relationType':
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>选择关系类型：</div>
          <select
            autoFocus
            value={(rule as { relationType: string }).relationType}
            onChange={e => onChange({ ...rule, relationType: e.target.value } as CleanFilterRule)}
            onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
            style={{
              width: '100%',
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: '#0f172a',
              color: '#e2e8f0',
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          >
            <option value="OPERATIONS">📊 运营 (OPERATIONS)</option>
            <option value="PROPOSAL">🏛️ 提案 (PROPOSAL)</option>
            <option value="CODE_CHANGE">💻 代码 (CODE_CHANGE)</option>
            <option value="ANNOTATION">注释 (ANNOTATION)</option>
            <option value="REFERENCE">引用 (REFERENCE)</option>
            <option value="REPLY">回复 (REPLY)</option>
            <option value="AGREE">赞同 (AGREE)</option>
            <option value="DISAGREE">反对 (DISAGREE)</option>
            <option value="CORRECT">更正 (CORRECT)</option>
            <option value="CLASSIFY">分类 (CLASSIFY)</option>
            <option value="MERGE">归并 (MERGE)</option>
            <option value="SUMMARY">总结 (SUMMARY)</option>
            <option value="ARCHIVE">冷藏 (ARCHIVE)</option>
            <option value="RECOMMEND">推荐 (RECOMMEND)</option>
            <option value="TAG">标注 (TAG)</option>
            <option value="ARRANGE">排列 (ARRANGE)</option>
          </select>
          <EditorButtons onConfirm={onConfirm} onCancel={onCancel} />
        </div>
      );

    default:
      return null;
  }
}

function EditorButtons({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
      <button
        onClick={onConfirm}
        style={{
          padding: '2px 12px',
          borderRadius: 4,
          border: 'none',
          background: '#2563eb',
          color: '#fff',
          cursor: 'pointer',
          fontSize: 11,
        }}
      >
        确认
      </button>
      <button
        onClick={onCancel}
        style={{
          padding: '2px 12px',
          borderRadius: 4,
          border: '1px solid #475569',
          background: 'transparent',
          color: '#94a3b8',
          cursor: 'pointer',
          fontSize: 11,
        }}
      >
        取消
      </button>
    </div>
  );
}
