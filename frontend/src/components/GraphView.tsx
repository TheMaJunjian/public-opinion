/**
 * GraphView.tsx — SVG-based non-linear graph view
 *
 * Renders text messages as absolutely-positioned cards in a column layout,
 * with SVG bezier edges representing relation messages.
 *
 * Layout algorithm:
 *   - col(target) >= col(source) + 1  (source LEFT, target RIGHT, edges flow left→right)
 *   - Messages with no outgoing edges start in column 0
 *   - Within each column, cards are ordered by creation time
 *
 * Interactivity:
 *   - Click a message card → calls onClickMessage(messageId)
 *   - Click an edge label → calls onClickRelation(relationId)
 *   - Selected items show a highlight border/color
 *   - Decoration badges (AGREE/DISAGREE/SUPPORT/REBUT) shown on cards
 *
 * Presentation:
 *   - edge-label:      curved bezier arrow + clickable label
 *   - edge-decoration: curved bezier arrow + clickable label + decoration badge on target
 *   - decoration:      decoration badge only on target (no edge)
 *   - inline-badge:    small badge on card (RECOMMEND/ARCHIVE)
 *   - frame-group:     dashed bounding box around target message cards (CLASSIFY/MERGE)
 *   - replace-overlay: fallback to edge-label
 */

import { useMemo, useState, useCallback } from 'react';
import type { Message, Relation, StanceStats } from '../types';
import { getPresentationSpec } from '../types';

// ─── Layout constants ────────────────────────────────────────────────────────

const CARD_W = 220;
const CARD_H = 110;
const COL_GAP = 80;
const ROW_GAP = 28;
const PAD = 40;

// Hex opacity suffixes for color string composition
const HEX_ALPHA_SEMI = '88';   // ~53% opacity  — frame stroke (unselected)
const HEX_ALPHA_LIGHT = '55';  // ~33% opacity  — frame fill background
const HEX_ALPHA_BORDER = '66'; // ~40% opacity  — edge/frame label border (unselected)

// ─── Color palette ───────────────────────────────────────────────────────────

const COLOR_STROKE: Record<string, string> = {
  blue: '#3b82f6',
  indigo: '#6366f1',
  green: '#22c55e',
  red: '#ef4444',
  yellow: '#ca8a04',
  purple: '#a855f7',
  orange: '#f97316',
  amber: '#d97706',
  gray: '#9ca3af',
  slate: '#94a3b8',
};

const COLOR_BG: Record<string, string> = {
  blue: '#dbeafe',
  indigo: '#e0e7ff',
  green: '#dcfce7',
  red: '#fee2e2',
  yellow: '#fef9c3',
  purple: '#f3e8ff',
  orange: '#ffedd5',
  amber: '#fef3c7',
  gray: '#f3f4f6',
  slate: '#f1f5f9',
};

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum iterations for the column-assignment propagation loop.
 * In a DAG (directed acyclic graph) with N messages, N iterations are sufficient
 * to stabilize column assignments. 200 provides a comfortable bound for any
 * realistic discussion graph while preventing infinite loops if circular
 * dependencies exist in the data.
 */
const MAX_LAYOUT_ITERATIONS = 200;

/**
 * Number of distinct vertical offsets to cycle through for edge labels.
 * Labels at the same bezier midpoint are staggered in LABEL_OFFSET_INCREMENT steps.
 */
const LABEL_OFFSET_POSITIONS = 5;

/**
 * Vertical pixel increment per label offset position.
 * Together with LABEL_OFFSET_POSITIONS, this ensures labels stagger over a
 * LABEL_OFFSET_POSITIONS * LABEL_OFFSET_INCREMENT px range before repeating.
 */
const LABEL_OFFSET_INCREMENT = 14;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CardPos {
  x: number;
  y: number;
}

interface EdgeLabelPos {
  cx: number; // center X
  cy: number; // center Y
}

interface EdgeRender {
  id: string;
  relationType: string;
  label: string;
  color: string;
  path: string;
  labelPos: EdgeLabelPos;
  arrowEnd: { x: number; y: number };
  /** For edge-decoration: the position to draw the decoration badge on the target card */
  targetCardPos?: CardPos;
  /** Sequential index used to offset label position slightly to reduce overlap */
  edgeIndex: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Cubic bezier midpoint at t=0.5 */
function bezierMid(
  x1: number, y1: number,
  cpx1: number, cpy1: number,
  cpx2: number, cpy2: number,
  x2: number, y2: number,
): { cx: number; cy: number } {
  const t = 0.5;
  const mt = 1 - t;
  const cx = mt * mt * mt * x1 + 3 * mt * mt * t * cpx1 + 3 * mt * t * t * cpx2 + t * t * t * x2;
  const cy = mt * mt * mt * y1 + 3 * mt * mt * t * cpy1 + 3 * mt * t * t * cpy2 + t * t * t * y2;
  return { cx, cy };
}

/** Build a cubic bezier SVG path from right edge of 'from' to left edge of 'to' */
function buildEdgePath(
  from: CardPos, to: CardPos,
): { path: string; labelPos: EdgeLabelPos; arrowEnd: { x: number; y: number } } {
  // From: right center of source card
  const x1 = from.x + CARD_W;
  const y1 = from.y + CARD_H / 2;
  // To: left center of target card
  const x2 = to.x;
  const y2 = to.y + CARD_H / 2;

  const dx = Math.abs(x2 - x1);
  const cpx1 = x1 + dx * 0.45;
  const cpy1 = y1;
  const cpx2 = x2 - dx * 0.45;
  const cpy2 = y2;

  const path = `M ${x1} ${y1} C ${cpx1} ${cpy1} ${cpx2} ${cpy2} ${x2} ${y2}`;
  const labelPos = bezierMid(x1, y1, cpx1, cpy1, cpx2, cpy2, x2, y2);
  return { path, labelPos, arrowEnd: { x: x2, y: y2 } };
}

// ─── Layout algorithm ─────────────────────────────────────────────────────────

function computeLayout(
  messages: Message[],
  relations: Relation[],
  visibleMessageIds: Set<string> | null,
): {
  posMap: Map<string, CardPos>;
  canvasWidth: number;
  canvasHeight: number;
} {
  const filtered = visibleMessageIds
    ? messages.filter(m => visibleMessageIds.has(m.id))
    : messages;

  const colMap = new Map<string, number>();
  filtered.forEach(m => colMap.set(m.id, 0));

  // Only edge-label and edge-decoration affect column layout
  const edgeRels = relations.filter(r => {
    if (visibleMessageIds && !visibleMessageIds.has(r.sourceMessageId)) return false;
    const spec = getPresentationSpec(r.relationType);
    return spec.kind === 'edge-label' || spec.kind === 'edge-decoration';
  });

  // Propagate: target should be at col(source) + 1 (source is left, target is right).
  // This ensures edges flow left→right: source right-border → target left-border,
  // with the arrow pointing toward the target (rightward).
  let changed = true;
  let guard = 0;
  while (changed && guard++ < MAX_LAYOUT_ITERATIONS) {
    changed = false;
    for (const rel of edgeRels) {
      const srcId = rel.sourceMessageId;
      if (!colMap.has(srcId)) continue;
      for (const ref of rel.targetRefs) {
        if (ref.kind !== 'message' && ref.kind !== 'text-fragment') continue;
        if (!colMap.has(ref.messageId)) continue;
        const curSrcCol = colMap.get(srcId)!;
        const curTgtCol = colMap.get(ref.messageId)!;
        if (curTgtCol < curSrcCol + 1) {
          colMap.set(ref.messageId, curSrcCol + 1);
          changed = true;
        }
      }
    }
  }

  // Sort by creation time for stable row assignment
  const sorted = [...filtered].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const colRows = new Map<number, number>();
  const posMap = new Map<string, CardPos>();
  const maxCol = Math.max(0, ...Array.from(colMap.values()));
  for (let c = 0; c <= maxCol; c++) colRows.set(c, 0);

  for (const msg of sorted) {
    const col = colMap.get(msg.id) ?? 0;
    const row = colRows.get(col) ?? 0;
    colRows.set(col, row + 1);
    posMap.set(msg.id, {
      x: PAD + col * (CARD_W + COL_GAP),
      y: PAD + row * (CARD_H + ROW_GAP),
    });
  }

  const totalCols = maxCol + 1;
  const maxRows = Math.max(1, ...Array.from(colRows.values()));
  const canvasWidth = PAD * 2 + totalCols * CARD_W + (totalCols - 1) * COL_GAP;
  const canvasHeight = PAD * 2 + maxRows * CARD_H + (maxRows - 1) * ROW_GAP;

  return { posMap, canvasWidth, canvasHeight };
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  messages: Message[];
  relations: Relation[];
  stanceStatsMap: Map<string, StanceStats>;
  selectedMessageIds: Set<string>;
  selectedRelationIds: Set<string>;
  focusVisibleMessages: Set<string> | null;
  focusVisibleRelations: Set<string> | null;
  onClickMessage: (id: string) => void;
  onClickRelation: (id: string) => void;
  /** Called when user drag-selects text in a message card (double-click → text selection mode) */
  onSelectFragment?: (messageId: string, text: string, hash: string) => void;
  /**
   * Called when user clicks on blank area (not on a card or relation label).
   * Parent should use this to clear the draft/candidates.
   */
  onBlankClick?: () => void;
  /**
   * Controlled text-selection mode: which message ID is in text-selection mode.
   * If provided, parent manages this state (enabling cross-component sync on clear).
   */
  textSelectionModeId?: string | null;
  /**
   * Callback when text-selection mode changes (if using controlled mode).
   */
  onTextModeChange?: (id: string | null) => void;
}

// ─── Simple hash for text fragment identification ────────────────────────────

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GraphView({
  messages,
  relations,
  stanceStatsMap,
  selectedMessageIds,
  selectedRelationIds,
  focusVisibleMessages,
  focusVisibleRelations,
  onClickMessage,
  onClickRelation,
  onSelectFragment,
  onBlankClick,
  textSelectionModeId: controlledTextModeId,
  onTextModeChange,
}: Props) {
  const visibleMessages = focusVisibleMessages
    ? messages.filter(m => focusVisibleMessages.has(m.id))
    : messages;

  const visibleRelations = focusVisibleRelations
    ? relations.filter(r => focusVisibleRelations.has(r.id))
    : relations;

  // ── Text selection mode state ─────────────────────────────────────────────
  // Supports both internal (default) and controlled (from parent) mode.
  // Controlled mode is used when parent needs to reset this on draft clear.
  const [internalTextModeId, setInternalTextModeId] = useState<string | null>(null);

  const textSelectionModeId = controlledTextModeId !== undefined ? controlledTextModeId : internalTextModeId;

  const setTextSelectionModeId = useCallback((id: string | null) => {
    if (controlledTextModeId !== undefined && onTextModeChange) {
      onTextModeChange(id);
    } else {
      setInternalTextModeId(id);
    }
  }, [controlledTextModeId, onTextModeChange]);

  const handleCardDoubleClick = useCallback((msgId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTextSelectionModeId(textSelectionModeId === msgId ? null : msgId);
  }, [textSelectionModeId, setTextSelectionModeId]);

  const handleCardMouseUp = useCallback((msgId: string) => {
    if (textSelectionModeId !== msgId) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length > 0 && onSelectFragment) {
      onSelectFragment(msgId, text, hashText(msgId + ':' + text));
      sel.removeAllRanges();
    }
  }, [textSelectionModeId, onSelectFragment]);

  // ── Layout ───────────────────────────────────────────────────────────────
  const { posMap, canvasWidth, canvasHeight } = useMemo(
    () => computeLayout(messages, relations, focusVisibleMessages),
    [messages, relations, focusVisibleMessages],
  );

  // ── Build edge renders ────────────────────────────────────────────────────
  // Two-pass approach to correctly target relation-message labels:
  //   Pass 1: build edges that target TEXT messages (record each edge's label position)
  //   Pass 2: build edges that target RELATION messages (point to the label position
  //           recorded in Pass 1, not the relation's source card position)
  const edges = useMemo<EdgeRender[]>(() => {
    const result: EdgeRender[] = [];
    // Map from relationId → label center (populated during Pass 1)
    const relLabelPositions = new Map<string, EdgeLabelPos>();
    let edgeIndex = 0;

    // Pass 1: relations whose primary target is a TEXT message
    for (const rel of visibleRelations) {
      const spec = getPresentationSpec(rel.relationType);
      if (spec.kind !== 'edge-label' && spec.kind !== 'edge-decoration') continue;

      const fromPos = posMap.get(rel.sourceMessageId);
      if (!fromPos) continue;

      let toPos: CardPos | undefined;
      for (const ref of rel.targetRefs) {
        if (ref.kind === 'message' || ref.kind === 'text-fragment') {
          const p = posMap.get(ref.messageId);
          if (p) { toPos = p; break; }
        }
      }
      if (!toPos) continue; // no text-message target — will be handled in Pass 2

      const { path, labelPos, arrowEnd } = buildEdgePath(fromPos, toPos);
      relLabelPositions.set(rel.id, labelPos);
      result.push({
        id: rel.id,
        relationType: rel.relationType,
        label: `${rel.createdBy.username} · ${spec.label}`,
        color: spec.color,
        path,
        labelPos,
        arrowEnd,
        targetCardPos: spec.kind === 'edge-decoration' ? toPos : undefined,
        edgeIndex: edgeIndex++,
      });
    }

    // Pass 2: relations that target RELATION MESSAGES
    // Arrow points to the target relation's label position (its clickable badge),
    // NOT to the source text message of that relation.
    for (const rel of visibleRelations) {
      if (relLabelPositions.has(rel.id)) continue; // already handled in Pass 1

      const spec = getPresentationSpec(rel.relationType);
      if (spec.kind !== 'edge-label' && spec.kind !== 'edge-decoration') continue;

      const fromPos = posMap.get(rel.sourceMessageId);
      if (!fromPos) continue;

      let targetPoint: { x: number; y: number } | undefined;
      for (const ref of rel.targetRefs) {
        if (ref.kind === 'relation') {
          const lp = relLabelPositions.get(ref.relationId);
          if (lp) { targetPoint = { x: lp.cx, y: lp.cy }; break; }
        }
      }
      if (!targetPoint) continue;

      // Build bezier from source-message right-center to the target label point
      const x1 = fromPos.x + CARD_W;
      const y1 = fromPos.y + CARD_H / 2;
      const dx = Math.abs(targetPoint.x - x1);
      const cpx1 = x1 + dx * 0.45;
      const cpy1 = y1;
      const cpx2 = targetPoint.x - dx * 0.45;
      const cpy2 = targetPoint.y;
      const path = `M ${x1} ${y1} C ${cpx1} ${cpy1} ${cpx2} ${cpy2} ${targetPoint.x} ${targetPoint.y}`;
      const labelPos = bezierMid(x1, y1, cpx1, cpy1, cpx2, cpy2, targetPoint.x, targetPoint.y);

      relLabelPositions.set(rel.id, labelPos);
      result.push({
        id: rel.id,
        relationType: rel.relationType,
        label: `${rel.createdBy.username} · ${spec.label}`,
        color: spec.color,
        path,
        labelPos,
        arrowEnd: { x: targetPoint.x, y: targetPoint.y },
        edgeIndex: edgeIndex++,
      });
    }

    return result;
  }, [visibleRelations, posMap]);

  // ── Decoration map: messageId → list of relation decorations ─────────────
  const decorationMap = useMemo(() => {
    const map = new Map<string, { rel: Relation; spec: ReturnType<typeof getPresentationSpec> }[]>();
    for (const rel of visibleRelations) {
      const spec = getPresentationSpec(rel.relationType);
      if (spec.kind !== 'decoration' && spec.kind !== 'edge-decoration' && spec.kind !== 'inline-badge') continue;
      for (const ref of rel.targetRefs) {
        if (ref.kind !== 'message' && ref.kind !== 'text-fragment') continue;
        const list = map.get(ref.messageId) ?? [];
        list.push({ rel, spec });
        map.set(ref.messageId, list);
      }
    }
    return map;
  }, [visibleRelations]);

  // ── Frame-group bounding boxes (CLASSIFY / MERGE) ─────────────────────────
  // For each frame-group relation, compute a bounding rect around all target cards.
  const frameGroups = useMemo(() => {
    const FRAME_PAD = 8; // extra padding around the grouped cards
    const result: Array<{
      id: string;
      relationType: string;
      color: string;
      label: string;
      x: number; y: number; w: number; h: number;
    }> = [];
    for (const rel of visibleRelations) {
      const spec = getPresentationSpec(rel.relationType);
      if (spec.kind !== 'frame-group') continue;
      const targetPositions: CardPos[] = [];
      for (const ref of rel.targetRefs) {
        if (ref.kind !== 'message' && ref.kind !== 'text-fragment') continue;
        const p = posMap.get(ref.messageId);
        if (p) targetPositions.push(p);
      }
      if (targetPositions.length === 0) continue;
      const minX = Math.min(...targetPositions.map(p => p.x)) - FRAME_PAD;
      const minY = Math.min(...targetPositions.map(p => p.y)) - FRAME_PAD;
      const maxX = Math.max(...targetPositions.map(p => p.x + CARD_W)) + FRAME_PAD;
      const maxY = Math.max(...targetPositions.map(p => p.y + CARD_H)) + FRAME_PAD;
      result.push({
        id: rel.id,
        relationType: rel.relationType,
        color: spec.color,
        label: `${rel.createdBy.username} · ${spec.label}`,
        x: minX, y: minY, w: maxX - minX, h: maxY - minY,
      });
    }
    return result;
  }, [visibleRelations, posMap]);

  // ── Stance decorations per message ────────────────────────────────────────
  // (support/oppose counts already computed externally via stanceStatsMap)

  if (visibleMessages.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        暂无消息
      </div>
    );
  }

  return (
    <div
      className="overflow-auto border border-gray-200 rounded-lg bg-gray-50"
      onClick={e => {
        // Blank area click: clear candidates if clicking directly on this container
        if (e.target === e.currentTarget && onBlankClick) onBlankClick();
      }}
    >
      {/* SVG + cards in a relative container */}
      <div
        className="relative"
        style={{ width: canvasWidth, height: canvasHeight, minWidth: '100%' }}
        onClick={e => {
          // Also handle clicks on the relative container background
          if (e.target === e.currentTarget && onBlankClick) onBlankClick();
        }}
      >
        {/* ── SVG edges layer (behind cards) ──────────────────────────────── */}
        <svg
          className="absolute inset-0 pointer-events-none"
          width={canvasWidth}
          height={canvasHeight}
          style={{ zIndex: 0 }}
        >
          <defs>
            {/* Arrow markers per color */}
            {Object.entries(COLOR_STROKE).map(([colorName, hex]) => (
              <marker
                key={colorName}
                id={`arrow-${colorName}`}
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 Z" fill={hex} />
              </marker>
            ))}
            {/* Dimmed variant for filtered-out edges */}
            <marker id="arrow-gray-dim" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#d1d5db" />
            </marker>
          </defs>

          {edges.map(edge => {
            const isSelected = selectedRelationIds.has(edge.id);
            const stroke = COLOR_STROKE[edge.color] ?? '#9ca3af';
            return (
              <g key={edge.id}>
                <path
                  d={edge.path}
                  fill="none"
                  stroke={isSelected ? stroke : stroke + '99'}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                  markerEnd={`url(#arrow-${edge.color})`}
                />
              </g>
            );
          })}

          {/* Frame-group dashed bounding boxes (CLASSIFY / MERGE) */}
          {frameGroups.map(frame => {
            const isSelected = selectedRelationIds.has(frame.id);
            const stroke = COLOR_STROKE[frame.color] ?? '#9ca3af';
            const fill = COLOR_BG[frame.color] ?? '#f3f4f6';
            return (
              <rect
                key={`frame-${frame.id}`}
                x={frame.x}
                y={frame.y}
                width={frame.w}
                height={frame.h}
                fill={fill + HEX_ALPHA_LIGHT}
                stroke={isSelected ? stroke : stroke + HEX_ALPHA_SEMI}
                strokeWidth={isSelected ? 2 : 1.5}
                strokeDasharray="6 3"
                rx={6}
              />
            );
          })}
        </svg>

        {/* ── Edge labels layer (interactive, above SVG) ──────────────────── */}
        {edges.map(edge => {
          const isSelected = selectedRelationIds.has(edge.id);
          const bgColor = COLOR_BG[edge.color] ?? '#f3f4f6';
          const textColor = COLOR_STROKE[edge.color] ?? '#6b7280';
          // Apply a small vertical offset per edge index to reduce label overlap
          const labelYOffset = (edge.edgeIndex % LABEL_OFFSET_POSITIONS) * LABEL_OFFSET_INCREMENT;
          return (
            <button
              key={`label-${edge.id}`}
              onClick={() => onClickRelation(edge.id)}
              title={`点击选中关系消息: ${edge.label}`}
              className="absolute text-xs font-medium px-1.5 py-0.5 rounded border transition-all cursor-pointer select-none"
              style={{
                left: edge.labelPos.cx - 50,
                top: edge.labelPos.cy - 10 + labelYOffset,
                width: 100,
                textAlign: 'center',
                backgroundColor: isSelected ? textColor : bgColor,
                color: isSelected ? 'white' : textColor,
                borderColor: isSelected ? textColor : textColor + HEX_ALPHA_BORDER,
                zIndex: 10,
                boxShadow: isSelected ? `0 0 0 2px ${textColor}44` : undefined,
              }}
            >
              {edge.label}
            </button>
          );
        })}

        {/* ── Frame-group labels (CLASSIFY / MERGE) ────────────────────────── */}
        {frameGroups.map(frame => {
          const isSelected = selectedRelationIds.has(frame.id);
          const bgColor = COLOR_BG[frame.color] ?? '#f3f4f6';
          const textColor = COLOR_STROKE[frame.color] ?? '#6b7280';
          return (
            <button
              key={`frame-label-${frame.id}`}
              onClick={() => onClickRelation(frame.id)}
              title={`点击选中关系消息: ${frame.label}`}
              className="absolute text-xs font-medium px-1.5 py-0.5 rounded border transition-all cursor-pointer select-none"
              style={{
                left: frame.x + 4,
                top: frame.y - 12,
                maxWidth: frame.w - 8,
                textAlign: 'left',
                backgroundColor: isSelected ? textColor : bgColor,
                color: isSelected ? 'white' : textColor,
                borderColor: isSelected ? textColor : textColor + HEX_ALPHA_BORDER,
                borderStyle: 'dashed',
                zIndex: 10,
              }}
            >
              {frame.label}
            </button>
          );
        })}

        {/* ── Message cards ────────────────────────────────────────────────── */}
        {visibleMessages.map(msg => {
          const pos = posMap.get(msg.id);
          if (!pos) return null;

          const isSelected = selectedMessageIds.has(msg.id);
          const stats = stanceStatsMap.get(msg.id);
          const decos = decorationMap.get(msg.id) ?? [];
          const isTextSelectMode = textSelectionModeId === msg.id;

          return (
            <div
              key={msg.id}
              onClick={isTextSelectMode ? undefined : () => onClickMessage(msg.id)}
              onDoubleClick={e => handleCardDoubleClick(msg.id, e)}
              onMouseUp={() => handleCardMouseUp(msg.id)}
              title={isTextSelectMode
                ? `文本选择模式：拖选文字创建片段，双击退出`
                : `${msg.createdBy.username}: ${msg.content}\n\n单击选中/取消选中，双击进入文本选择模式`}
              className="absolute rounded-lg border-2 bg-white transition-all"
              style={{
                left: pos.x,
                top: pos.y,
                width: CARD_W,
                height: CARD_H,
                borderColor: isTextSelectMode ? '#f59e0b' : isSelected ? '#6366f1' : '#e5e7eb',
                boxShadow: isTextSelectMode
                  ? '0 0 0 3px #f59e0b33, 0 1px 3px rgba(0,0,0,0.1)'
                  : isSelected
                    ? '0 0 0 3px #6366f133, 0 1px 3px rgba(0,0,0,0.1)'
                    : '0 1px 2px rgba(0,0,0,0.06)',
                cursor: isTextSelectMode ? 'text' : 'pointer',
                zIndex: isTextSelectMode ? 15 : 5,
                overflow: 'hidden',
                userSelect: isTextSelectMode ? 'text' : 'none',
              }}
            >
              {/* Card body */}
              <div className="p-2.5 flex flex-col h-full">
                {/* Author + timestamp */}
                <div className="flex items-center justify-between mb-1.5 gap-1">
                  <span
                    className="text-xs font-semibold truncate"
                    style={{ color: isTextSelectMode ? '#92400e' : isSelected ? '#4f46e5' : '#374151' }}
                  >
                    {msg.createdBy.username}
                    {isTextSelectMode && <span className="ml-1 text-[10px] text-amber-500 font-normal">文本选择中</span>}
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">
                    {new Date(msg.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                </div>

                {/* Content */}
                <p
                  className="text-xs text-gray-700 leading-relaxed flex-1 overflow-hidden line-clamp-3"
                  style={{ userSelect: isTextSelectMode ? 'text' : 'none' }}
                >
                  {msg.content}
                </p>

                {/* Footer: stance stats + decorations */}
                <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                  {stats && (stats.support > 0 || stats.oppose > 0) && (
                    <>
                      {stats.support > 0 && (
                        <span className="text-xs text-green-600 font-medium">▲{stats.support}</span>
                      )}
                      {stats.oppose > 0 && (
                        <span className="text-xs text-red-500 font-medium">▼{stats.oppose}</span>
                      )}
                    </>
                  )}
                  {decos.map(({ rel, spec }) => (
                    <button
                      key={rel.id}
                      onClick={e => { e.stopPropagation(); onClickRelation(rel.id); }}
                      title={`关系消息: ${spec.label} by ${rel.createdBy.username}`}
                      className="text-xs px-1 py-0.5 rounded border font-medium leading-none"
                      style={{
                        backgroundColor: selectedRelationIds.has(rel.id)
                          ? (COLOR_STROKE[spec.color] ?? '#9ca3af')
                          : (COLOR_BG[spec.color] ?? '#f3f4f6'),
                        color: selectedRelationIds.has(rel.id)
                          ? 'white'
                          : (COLOR_STROKE[spec.color] ?? '#6b7280'),
                        borderColor: (COLOR_STROKE[spec.color] ?? '#9ca3af') + HEX_ALPHA_BORDER,
                      }}
                    >
                      {spec.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Mode indicator badge */}
              {isTextSelectMode && (
                <div
                  className="absolute top-1 right-1 text-amber-600 text-xs font-bold bg-amber-50 px-1 rounded"
                  title="文本选择模式（双击退出）"
                >
                  T
                </div>
              )}
              {!isTextSelectMode && isSelected && (
                <div
                  className="absolute top-1 right-1 text-indigo-600 text-xs font-bold"
                  title="已选中"
                >
                  ✓
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
