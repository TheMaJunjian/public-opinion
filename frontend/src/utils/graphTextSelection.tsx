import React from 'react';
import { isCapturingPreview } from '../api/commandBatch';
import type { DemoEdge, UnitSelection, Selection, RelationType } from './modelBridge';
import { getPresentationSpec } from '../types';

export function selKey(u: UnitSelection): string {
  if (u.reference) { const r = u.reference; return JSON.stringify([r.messageId, r.revision ?? null, r.partId ?? null, r.memberId ?? null, r.path ?? null, r.range ?? null]); }
  const s = u.selection;
  if (s.kind === "whole") return `${u.messageId}::whole`;
  if (s.kind === "edge") return `${u.messageId}::edge:${s.edgeId}`;
  return `${u.messageId}::text:${s.start}:${s.len}:${s.text}`;
}

export function unitEquals(a: UnitSelection, b: UnitSelection) {
  return selKey(a) === selKey(b);
}

export function selectionIsText(
  s: Selection
): s is { kind: "text"; start: number; len: number; text: string } {
  return s.kind === "text";
}

export function clearBrowserSelection() {
  if (isCapturingPreview()) return;
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
}

export function getRangeStartOffsetUTF16(container: HTMLElement, range: Range): number {
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

export function getSelectionFragment(
  container: HTMLElement
): { start: number; len: number; text: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;
  const common = range.commonAncestorContainer;
  if (!(common instanceof Node)) return null;
  if (!container.contains(common)) return null;
  const raw = sel.toString();
  if (raw.trim().length === 0) return null;
  const rawStart = getRangeStartOffsetUTF16(container, range);
  return { start: rawStart, len: raw.length, text: raw };
}

export function extractTextTargetsForMessage(messageId: string, edges: DemoEdge[], partId?: string, revision?: number) {
  const res: { start: number; len: number; relationType: RelationType; edgeId: string }[] = [];
  for (const e of edges) {
        if (!(e.relationType === "annotation" || e.relationType === "reference")) continue;
    if (e.to.messageId !== messageId) continue;
    if (partId && e.to.reference?.partId && e.to.reference.partId !== partId) continue;
    if (revision && e.to.reference?.revision && e.to.reference.revision !== revision) continue;
    if (!selectionIsText(e.to.selection)) continue;
    res.push({ start: e.to.selection.start, len: e.to.selection.len, relationType: e.relationType, edgeId: e.id });
  }
  res.sort((a, b) => a.start - b.start || a.len - b.len || a.edgeId.localeCompare(b.edgeId));
  return res;
}

export function relationTypeName(t: RelationType | string): string {
  return getPresentationSpec(t).label;
}

export type AnnoNode = {
  start: number;
  end: number;
  relationType: RelationType;
  edgeId: string;
  children: AnnoNode[];
};

export function buildAnnoTree(
  items: { start: number; end: number; relationType: RelationType; edgeId: string }[]
): AnnoNode[] {
  // Sort: start ascending, end descending (larger/outer intervals first at same start)
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);

  function consume(idx: number, boundEnd: number): { nodes: AnnoNode[]; nextIdx: number } {
    const nodes: AnnoNode[] = [];
    let i = idx;
    while (i < sorted.length) {
      const item = sorted[i];
      if (item.start >= boundEnd) break;
      const { nodes: children, nextIdx } = consume(i + 1, item.end);
      nodes.push({ start: item.start, end: item.end, relationType: item.relationType, edgeId: item.edgeId, children });
      i = nextIdx;
    }
    return { nodes, nextIdx: i };
  }

  return consume(0, Infinity).nodes;
}

export function renderAnnoNodes(
  text: string,
  nodes: AnnoNode[],
  from: number,
  to: number,
  depth: number,
  messageId: string,
  isFragSel: (id: string, start: number, len: number, text: string) => boolean,
  onFragClick: (id: string, start: number, len: number, text: string) => void,
  isTargetHintFrag?: (id: string, start: number, len: number, relationType: RelationType) => boolean,
): React.ReactNode[] {
  const selectedStyles = [
    {
      bg: "var(--surface-rgba-11-132-255-0-24)",
      outline: "2px solid var(--line-rgba-11-132-255-0-95)",
      ring: "inset 0 0 0 1px var(--ink-rgba-147-197-253-0-7)",
    },
    {
      bg: "var(--surface-rgba-56-189-248-0-28)",
      outline: "2px dashed var(--line-rgba-56-189-248-0-95)",
      ring: "inset 0 0 0 1px var(--ink-rgba-125-211-252-0-78)",
    },
    {
      bg: "var(--surface-rgba-14-165-233-0-32)",
      outline: "2px dotted var(--line-rgba-14-165-233-0-98)",
      ring: "inset 0 0 0 1px var(--ink-rgba-103-232-249-0-86)",
    },
  ] as const;
  const result: React.ReactNode[] = [];
  let cursor = from;
  for (const node of nodes) {
    if (node.start >= to) break;
    if (node.start > cursor) {
      result.push(<span key={`t-${cursor}`} style={{whiteSpace:"pre-wrap"}}>{text.slice(cursor, node.start)}</span>);
    }
    const len = node.end - node.start;
    const frag = text.slice(node.start, node.end);
    const isAnno = node.relationType === "annotation";
    const selected = isFragSel(messageId, node.start, len, frag);
    const isTargetHint = !selected && (isTargetHintFrag?.(messageId, node.start, len, node.relationType) ?? false);
    const isInner = depth > 0;
    const selectedStyle = selectedStyles[Math.min(depth, selectedStyles.length - 1)];
    const bgColor = selected
      ? selectedStyle.bg
      : isTargetHint
        ? (isInner ? "var(--ink-rgba-16-185-129-0-20)" : "var(--ink-rgba-16-185-129-0-12)")
      : isInner
        ? (isAnno ? "var(--ink-rgba-255-220-0-0-30)" : "var(--ink-rgba-80-180-255-0-20)")
        : (isAnno ? "var(--ink-rgba-255-255-0-0-12)" : "var(--ink-rgba-80-180-255-0-08)");
    const outlineStyle = selected
      ? selectedStyle.outline
      : isTargetHint
        ? "2px dashed var(--line-rgba-16-185-129-0-95)"
      : isInner
        ? (isAnno ? "2px solid var(--line-rgba-255-210-0-0-95)" : "2px solid var(--line-rgba-80-180-255-0-85)")
        : (isAnno ? "1px solid var(--line-rgba-255-255-0-0-8)" : "1px solid var(--line-rgba-80-180-255-0-45)");
    const innerContent = node.children.length > 0
      ? renderAnnoNodes(text, node.children, node.start, node.end, depth + 1, messageId, isFragSel, onFragClick, isTargetHintFrag)
      : text.slice(node.start, node.end);
    result.push(
      <span key={`h-${node.start}-${node.end}`}
        data-rel-anchor={`${node.relationType}::${node.start}:${node.end}`}
        data-fragment-selected={selected || undefined}
        onClick={e => { e.stopPropagation(); onFragClick(messageId, node.start, len, frag); }}
        title="点击：进入文本选择状态并切换选中该片段"
        style={{whiteSpace:"pre-wrap",cursor:"pointer",position:"relative",zIndex:isInner?Math.min(9,1+depth):undefined,
          backgroundColor:bgColor,outline:outlineStyle,borderRadius:2,
          boxShadow:selected?selectedStyle.ring:(isTargetHint?"inset 0 0 0 1px var(--shadow-rgba-110-231-183-0-85)":undefined)}}
      >
        {innerContent}
      </span>
    );
    cursor = node.end;
  }
  if (cursor < to) {
    result.push(<span key={`t-${cursor}`} style={{whiteSpace:"pre-wrap"}}>{text.slice(cursor, to)}</span>);
  }
  return result;
}
