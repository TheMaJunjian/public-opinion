/**
 * InteractiveMessageList.tsx — Linear list view with full interaction support
 *
 * Provides the same interaction model as GraphView but in a scrollable list layout:
 *   - Single click  → toggle whole-message selection (calls onClickMessage)
 *   - Double click  → toggle text-selection mode for this card
 *   - In text-selection mode, drag-select text → calls onSelectFragment
 *   - Click highlighted fragment badge → calls onSelectFragment (toggle)
 *
 * Visual states:
 *   - Selected  : indigo border + check indicator
 *   - Text mode : amber border + "文本选择中" label
 *   - Normal    : gray border
 */

import { useState, useCallback } from 'react';
import type { Message, Relation, StanceStats } from '../types';
import { getPresentationSpec } from '../types';

// ─── Color palette (matches GraphView) ──────────────────────────────────────

const COLOR_BG: Record<string, string> = {
  blue: '#dbeafe', indigo: '#e0e7ff', green: '#dcfce7', red: '#fee2e2',
  yellow: '#fef9c3', purple: '#f3e8ff', orange: '#ffedd5', amber: '#fef3c7',
  gray: '#f3f4f6', slate: '#f1f5f9',
};
const COLOR_STROKE: Record<string, string> = {
  blue: '#3b82f6', indigo: '#6366f1', green: '#22c55e', red: '#ef4444',
  yellow: '#ca8a04', purple: '#a855f7', orange: '#f97316', amber: '#d97706',
  gray: '#9ca3af', slate: '#94a3b8',
};

// ─── Simple hash for fragment identification ────────────────────────────────

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  messages: Message[];
  relations: Relation[];
  stanceStatsMap: Map<string, StanceStats>;
  selectedMessageIds: Set<string>;
  selectedRelationIds: Set<string>;
  onClickMessage: (id: string) => void;
  onClickRelation: (id: string) => void;
  onSelectFragment?: (messageId: string, text: string, hash: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function InteractiveMessageList({
  messages,
  relations,
  stanceStatsMap,
  selectedMessageIds,
  selectedRelationIds,
  onClickMessage,
  onClickRelation,
  onSelectFragment,
}: Props) {
  const [textSelectionModeId, setTextSelectionModeId] = useState<string | null>(null);

  const handleDoubleClick = useCallback((msgId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setTextSelectionModeId(prev => prev === msgId ? null : msgId);
  }, []);

  const handleMouseUp = useCallback((msgId: string) => {
    if (textSelectionModeId !== msgId) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length > 0 && onSelectFragment) {
      onSelectFragment(msgId, text, hashText(msgId + ':' + text));
      sel.removeAllRanges();
    }
  }, [textSelectionModeId, onSelectFragment]);

  // Build decoration map: messageId → list of relation decorations
  const decorationMap = new Map<string, { rel: Relation; spec: ReturnType<typeof getPresentationSpec> }[]>();
  for (const rel of relations) {
    const spec = getPresentationSpec(rel.relationType);
    if (spec.kind !== 'decoration' && spec.kind !== 'edge-decoration' && spec.kind !== 'inline-badge') continue;
    for (const ref of rel.targetRefs) {
      if (ref.kind !== 'message' && ref.kind !== 'text-fragment') continue;
      const list = decorationMap.get(ref.messageId) ?? [];
      list.push({ rel, spec });
      decorationMap.set(ref.messageId, list);
    }
  }

  if (messages.length === 0) {
    return (
      <div className="text-center py-10 text-gray-400">暂无消息</div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-400 mb-1">
        单击卡片选中/取消选中；双击卡片进入文本选择模式（拖选文字创建片段）；点击关系标签将关系加入候选区。
      </p>
      {messages.map(msg => {
        const isSelected = selectedMessageIds.has(msg.id);
        const isTextMode = textSelectionModeId === msg.id;
        const stats = stanceStatsMap.get(msg.id);
        const decos = decorationMap.get(msg.id) ?? [];

        return (
          <div
            key={msg.id}
            onClick={isTextMode ? undefined : () => onClickMessage(msg.id)}
            onDoubleClick={e => handleDoubleClick(msg.id, e)}
            onMouseUp={() => handleMouseUp(msg.id)}
            title={
              isTextMode
                ? '文本选择模式：拖选文字创建片段，双击退出'
                : `单击选中/取消选中，双击进入文本选择模式`
            }
            className="relative bg-white rounded-lg border-2 p-3 transition-all"
            style={{
              borderColor: isTextMode ? '#f59e0b' : isSelected ? '#6366f1' : '#e5e7eb',
              boxShadow: isTextMode
                ? '0 0 0 3px #f59e0b33'
                : isSelected
                  ? '0 0 0 3px #6366f133'
                  : 'none',
              cursor: isTextMode ? 'text' : 'pointer',
              userSelect: isTextMode ? 'text' : 'none',
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-1.5 gap-2">
              <span
                className="text-xs font-semibold"
                style={{ color: isTextMode ? '#92400e' : isSelected ? '#4f46e5' : '#374151' }}
              >
                {msg.createdBy.username}
                {isTextMode && (
                  <span className="ml-1.5 text-[10px] text-amber-500 font-normal bg-amber-50 px-1 rounded">
                    文本选择中
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {stats && (stats.support > 0 || stats.oppose > 0) && (
                  <span className="flex items-center gap-1 text-xs">
                    {stats.support > 0 && <span className="text-green-600 font-medium">▲{stats.support}</span>}
                    {stats.oppose > 0 && <span className="text-red-500 font-medium">▼{stats.oppose}</span>}
                  </span>
                )}
                <span className="text-xs text-gray-400">
                  {new Date(msg.createdAt).toLocaleDateString('zh-CN')}
                </span>
              </div>
            </div>

            {/* Content */}
            <p
              className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap"
              style={{ userSelect: isTextMode ? 'text' : 'none' }}
            >
              {msg.content}
            </p>

            {/* Decorations */}
            {decos.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {decos.map(({ rel, spec }) => (
                  <button
                    key={rel.id}
                    onClick={e => { e.stopPropagation(); onClickRelation(rel.id); }}
                    title={`关系消息: ${spec.label} by ${rel.createdBy.username}`}
                    className="text-xs px-1.5 py-0.5 rounded border font-medium"
                    style={{
                      backgroundColor: selectedRelationIds.has(rel.id)
                        ? (COLOR_STROKE[spec.color] ?? '#9ca3af')
                        : (COLOR_BG[spec.color] ?? '#f3f4f6'),
                      color: selectedRelationIds.has(rel.id)
                        ? 'white'
                        : (COLOR_STROKE[spec.color] ?? '#6b7280'),
                      borderColor: (COLOR_STROKE[spec.color] ?? '#9ca3af') + '66',
                    }}
                  >
                    {spec.label} · {rel.createdBy.username}
                  </button>
                ))}
              </div>
            )}

            {/* State indicator (top-right corner) */}
            {isTextMode && (
              <div className="absolute top-2 right-2 text-amber-600 text-xs font-bold bg-amber-50 px-1 rounded border border-amber-200">
                T
              </div>
            )}
            {!isTextMode && isSelected && (
              <div className="absolute top-2 right-2 text-indigo-600 text-xs font-bold">✓</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
