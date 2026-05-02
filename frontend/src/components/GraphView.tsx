/**
 * GraphView.tsx — SVG-based non-linear graph view
 *
 * Renders text messages as absolutely-positioned cards in a column layout,
 * with SVG bezier edges representing relation messages.
 *
 * Layout algorithm:
 *   - col(source) = col(target) + 1 for edge-label/edge-decoration relation types
 *   - Messages with no incoming edges start in column 0
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
 *   - replace-overlay / frame-group: fallback to edge-label for now
 */

import { useMemo } from 'react';
import type { Message, Relation, StanceStats } from '../types';
import { getPresentationSpec } from '../types';

// ─── Layout constants ────────────────────────────────────────────────────────

const CARD_W = 220;
const CARD_H = 110;
const COL_GAP = 80;
const ROW_GAP = 28;
const PAD = 40;

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

/** Build a self-loop / fallback path when source === target or no target found */
function buildSelfLoopPath(from: CardPos): { path: string; labelPos: EdgeLabelPos; arrowEnd: { x: number; y: number } } {
  const x = from.x + CARD_W / 2;
  const y = from.y;
  const path = `M ${x} ${y} C ${x + 40} ${y - 40} ${x - 40} ${y - 40} ${x} ${y}`;
  return { path, labelPos: { cx: x, cy: y - 30 }, arrowEnd: { x, y } };
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

  // Propagate: source should be at col(target) + 1
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
        const tgtCol = colMap.get(ref.messageId)!;
        const curSrcCol = colMap.get(srcId)!;
        if (curSrcCol < tgtCol + 1) {
          colMap.set(srcId, tgtCol + 1);
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
}: Props) {
  const visibleMessages = focusVisibleMessages
    ? messages.filter(m => focusVisibleMessages.has(m.id))
    : messages;

  const visibleRelations = focusVisibleRelations
    ? relations.filter(r => focusVisibleRelations.has(r.id))
    : relations;

  // ── Layout ───────────────────────────────────────────────────────────────
  const { posMap, canvasWidth, canvasHeight } = useMemo(
    () => computeLayout(messages, relations, focusVisibleMessages),
    [messages, relations, focusVisibleMessages],
  );

  // ── Build edge renders ────────────────────────────────────────────────────
  const edges = useMemo<EdgeRender[]>(() => {
    const result: EdgeRender[] = [];

    for (const rel of visibleRelations) {
      const spec = getPresentationSpec(rel.relationType);
      if (spec.kind !== 'edge-label' && spec.kind !== 'edge-decoration') continue;

      const fromPos = posMap.get(rel.sourceMessageId);
      if (!fromPos) continue;

      // Find the primary target position
      let toPos: CardPos | undefined;
      for (const ref of rel.targetRefs) {
        if (ref.kind === 'message' || ref.kind === 'text-fragment') {
          const p = posMap.get(ref.messageId);
          if (p) { toPos = p; break; }
        }
        // If targeting a relation message, find the relation's source message position
        if (ref.kind === 'relation') {
          const targetRel = relations.find(r => r.id === ref.relationId);
          if (targetRel) {
            const p = posMap.get(targetRel.sourceMessageId);
            if (p) { toPos = p; break; }
          }
        }
      }

      const { path, labelPos, arrowEnd } = toPos
        ? buildEdgePath(fromPos, toPos)
        : buildSelfLoopPath(fromPos);

      result.push({
        id: rel.id,
        relationType: rel.relationType,
        label: `${rel.createdBy.username} · ${spec.label}`,
        color: spec.color,
        path,
        labelPos,
        arrowEnd,
        targetCardPos: spec.kind === 'edge-decoration' ? toPos : undefined,
      });
    }

    return result;
  }, [visibleRelations, posMap, relations]);

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
    <div className="overflow-auto border border-gray-200 rounded-lg bg-gray-50">
      {/* SVG + cards in a relative container */}
      <div
        className="relative"
        style={{ width: canvasWidth, height: canvasHeight, minWidth: '100%' }}
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
        </svg>

        {/* ── Edge labels layer (interactive, above SVG) ──────────────────── */}
        {edges.map(edge => {
          const isSelected = selectedRelationIds.has(edge.id);
          const bgColor = COLOR_BG[edge.color] ?? '#f3f4f6';
          const textColor = COLOR_STROKE[edge.color] ?? '#6b7280';
          return (
            <button
              key={`label-${edge.id}`}
              onClick={() => onClickRelation(edge.id)}
              title={`点击选中关系消息: ${edge.label}`}
              className="absolute text-xs font-medium px-1.5 py-0.5 rounded border transition-all cursor-pointer select-none"
              style={{
                left: edge.labelPos.cx - 50,
                top: edge.labelPos.cy - 10,
                width: 100,
                textAlign: 'center',
                backgroundColor: isSelected ? textColor : bgColor,
                color: isSelected ? 'white' : textColor,
                borderColor: isSelected ? textColor : textColor + '66',
                zIndex: 10,
                boxShadow: isSelected ? `0 0 0 2px ${textColor}44` : undefined,
              }}
            >
              {edge.label}
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

          return (
            <div
              key={msg.id}
              onClick={() => onClickMessage(msg.id)}
              title={`${msg.createdBy.username}: ${msg.content}\n\n点击选中/取消选中消息`}
              className="absolute cursor-pointer select-none rounded-lg border-2 bg-white transition-all"
              style={{
                left: pos.x,
                top: pos.y,
                width: CARD_W,
                height: CARD_H,
                borderColor: isSelected ? '#6366f1' : '#e5e7eb',
                boxShadow: isSelected
                  ? '0 0 0 3px #6366f133, 0 1px 3px rgba(0,0,0,0.1)'
                  : '0 1px 2px rgba(0,0,0,0.06)',
                zIndex: 5,
                overflow: 'hidden',
              }}
            >
              {/* Card body */}
              <div className="p-2.5 flex flex-col h-full">
                {/* Author + timestamp */}
                <div className="flex items-center justify-between mb-1.5 gap-1">
                  <span
                    className="text-xs font-semibold truncate"
                    style={{ color: isSelected ? '#4f46e5' : '#374151' }}
                  >
                    {msg.createdBy.username}
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">
                    {new Date(msg.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                </div>

                {/* Content (truncated to fit card height) */}
                <p className="text-xs text-gray-700 leading-relaxed flex-1 overflow-hidden line-clamp-3">
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
                        borderColor: (COLOR_STROKE[spec.color] ?? '#9ca3af') + '66',
                      }}
                    >
                      {spec.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Selected indicator */}
              {isSelected && (
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
