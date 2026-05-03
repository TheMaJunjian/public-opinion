/**
 * InteractiveMessageList.tsx — Linear list view with full interaction support
 *
 * Provides the same interaction model as GraphView but in a scrollable list layout:
 *   - Single click  → toggle whole-message selection (calls onClickMessage)
 *   - Double click  → toggle text-selection mode for this card
 *   - In text-selection mode, drag-select text → calls onSelectFragment
 *   - Click highlighted fragment badge → calls onSelectFragment (toggle)
 *   - Click edge-label/edge-decoration relation row below card → calls onClickRelation (toggle)
 *   - Click blank area (not on a card) → calls onBlankClick (to clear candidates)
 *
 * Visual states:
 *   - Selected  : indigo border + check indicator
 *   - Text mode : amber border + "文本选择中" label
 *   - Normal    : gray border
 *
 * Relation rows (edge-label types):
 *   - Shown below each source message card
 *   - Selected: filled color background
 *   - Normal  : light color background
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
  /**
   * Called when user clicks on blank area (not on a card or relation row).
   * Parent should use this to clear the draft/candidates.
   */
  onBlankClick?: () => void;
  /**
   * Controlled text-selection mode: which message ID is in text-selection mode.
   * If provided, parent manages this state (enabling cross-component sync).
   * If omitted, component manages its own internal state.
   */
  textSelectionModeId?: string | null;
  /**
   * Callback when text-selection mode changes (if using controlled mode).
   */
  onTextModeChange?: (id: string | null) => void;
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
  onBlankClick,
  textSelectionModeId: controlledTextModeId,
  onTextModeChange,
}: Props) {
  // Internal state as fallback when not controlled by parent
  const [internalTextModeId, setInternalTextModeId] = useState<string | null>(null);

  // Use controlled value if provided, otherwise internal
  const textSelectionModeId = controlledTextModeId !== undefined ? controlledTextModeId : internalTextModeId;

  const setTextSelectionModeId = useCallback((id: string | null) => {
    if (controlledTextModeId !== undefined && onTextModeChange) {
      onTextModeChange(id);
    } else {
      setInternalTextModeId(id);
    }
  }, [controlledTextModeId, onTextModeChange]);

  const handleDoubleClick = useCallback((msgId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setTextSelectionModeId(textSelectionModeId === msgId ? null : msgId);
  }, [textSelectionModeId, setTextSelectionModeId]);

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

  // Handle blank area click: fire onBlankClick for any click that reaches the container.
  // Message cards and relation rows call e.stopPropagation() to prevent this from
  // firing when the user clicks on an actual card or relation row.
  const handleContainerClick = useCallback(() => {
    if (onBlankClick) onBlankClick();
  }, [onBlankClick]);

  // Build decoration map: messageId → list of relation decorations (for badges on target)
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

  // Build outgoing relation rows map: sourceMessageId → list of directed relations
  // Includes edge-label AND edge-decoration types (both have a directed connector).
  // These are shown as interactive "relation rows" below the source message card.
  const outgoingRelationRowsMap = new Map<string, { rel: Relation; spec: ReturnType<typeof getPresentationSpec> }[]>();
  for (const rel of relations) {
    const spec = getPresentationSpec(rel.relationType);
    if (spec.kind !== 'edge-label' && spec.kind !== 'edge-decoration') continue;
    const list = outgoingRelationRowsMap.get(rel.sourceMessageId) ?? [];
    list.push({ rel, spec });
    outgoingRelationRowsMap.set(rel.sourceMessageId, list);
  }

  if (messages.length === 0) {
    return (
      <div className="text-center py-10 text-gray-400">暂无消息</div>
    );
  }

  return (
    <div
      className="space-y-2"
      onClick={handleContainerClick}
    >
      <p className="text-xs text-gray-400 mb-1">
        单击卡片选中/取消选中；双击卡片进入文本选择模式（拖选文字创建片段）；点击关系标签将关系加入候选区；点击空白处清空候选区。
      </p>
      {messages.map(msg => {
        const isSelected = selectedMessageIds.has(msg.id);
        const isTextMode = textSelectionModeId === msg.id;
        const stats = stanceStatsMap.get(msg.id);
        const decos = decorationMap.get(msg.id) ?? [];
        const outgoingRelationRows = outgoingRelationRowsMap.get(msg.id) ?? [];

        return (
          <div key={msg.id} className="space-y-0.5">
            {/* ── Message card ──────────────────────────────────────────── */}
            <div
              onClick={(e) => { e.stopPropagation(); if (!isTextMode) onClickMessage(msg.id); }}
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

              {/* Decorations (decoration / edge-decoration / inline-badge targeting this message) */}
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

            {/* ── Outgoing edge-label relation rows ─────────────────────── */}
            {/* Show edge-label type relations (REPLY, ANNOTATION, REFERENCE, SUPPLEMENT)
                originating from this message as clickable rows below the card.
                Clicking a row adds/removes the relation from the draft (candidates). */}
            {outgoingRelationRows.map(({ rel, spec }) => {
              const isRelSelected = selectedRelationIds.has(rel.id);
              const bgColor = isRelSelected
                ? (COLOR_STROKE[spec.color] ?? '#9ca3af')
                : (COLOR_BG[spec.color] ?? '#f3f4f6');
              const textColor = isRelSelected ? 'white' : (COLOR_STROKE[spec.color] ?? '#6b7280');
              const borderColor = (COLOR_STROKE[spec.color] ?? '#9ca3af') + (isRelSelected ? '' : '66');

              // Build a short label for each target ref
              const targetLabels = rel.targetRefs.map((ref, i) => {
                if (ref.kind === 'message' || ref.kind === 'text-fragment') {
                  const tgtMsg = messages.find(m => m.id === ref.messageId);
                  if (!tgtMsg) return <span key={i} className="opacity-50">…</span>;
                  const excerpt = tgtMsg.content.slice(0, 20) + (tgtMsg.content.length > 20 ? '…' : '');
                  return (
                    <span key={i} className="font-medium">
                      {tgtMsg.createdBy.username}
                      {ref.kind === 'text-fragment' && (
                        <em className="ml-1 opacity-75">"{ref.text.slice(0, 12)}…"</em>
                      )}
                      {i === 0 && <span className="opacity-50 ml-1 text-[9px]">"{excerpt}"</span>}
                    </span>
                  );
                }
                if (ref.kind === 'relation') {
                  const tgtRel = relations.find(r => r.id === ref.relationId);
                  const tgtSpec = tgtRel ? getPresentationSpec(tgtRel.relationType) : null;
                  return (
                    <span key={i} className="opacity-75">
                      [关系:{tgtSpec?.label ?? '?'}]
                    </span>
                  );
                }
                return null;
              });

              return (
                <button
                  key={`rel-row-${rel.id}`}
                  onClick={e => { e.stopPropagation(); onClickRelation(rel.id); }}
                  title={`点击${isRelSelected ? '取消选中' : '选中'}此关系 · ${spec.label} by ${rel.createdBy.username}`}
                  className="w-full flex items-center gap-1.5 text-xs px-3 py-1 rounded border transition-all text-left ml-4"
                  style={{
                    backgroundColor: bgColor,
                    color: textColor,
                    borderColor,
                    maxWidth: 'calc(100% - 1rem)',
                  }}
                >
                  <span className="shrink-0 font-semibold">↳ {spec.label}</span>
                  <span className="shrink-0 opacity-70">→</span>
                  <span className="flex items-center gap-1 min-w-0 flex-wrap">
                    {targetLabels}
                  </span>
                  <span className="ml-auto shrink-0 opacity-60 text-[10px]">
                    {rel.createdBy.username}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
