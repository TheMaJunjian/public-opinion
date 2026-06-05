import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { convertMessagesToDemoModel, unitSelectionToTargetRef, computeCorrectedEdgeMap } from '../utils/modelBridge';
import type {
  DemoMessage, DemoEdge, UnitSelection, Selection,
  RelationType,
} from '../utils/modelBridge';
import type { Topic, TargetRef, Relation, RelationPayload } from '../types';
import { getPresentationSpec, getRelationLabel, getRelationTitle } from '../types';
import GraphView, { clearBrowserSelection, extractTextTargetsForMessage, relationTypeName, getSelectionFragment, buildAnnoTree, renderAnnoNodes } from '../components/GraphView';
import ErrorBoundary from '../components/ErrorBoundary';

// ========================= Helpers =========================

const ALL_RELATION_TYPES: RelationType[] = [
  "annotation", "reference", "reply", "agree", "disagree", "tag", "supplement",
  "correct", "classify", "merge", "summary",
  // "recommend" and "archive" are now accessible via TAG's secondary relation selector
];

/** Max characters to display for an existing tag label in the secondary relation selector. */
const MAX_TAG_LABEL_DISPLAY_LENGTH = 20;
const CLASSIFY_TARGET_HINT = "文本消息、补充关系消息、分类话题消息或归并关系消息";

/** Return the display label for a secondary relation option button. */
function secondaryRelationLabel(t: string): string {
  if (t === "none") return "无";
  if (t === "question") return "疑问";
  if (t === "answer") return "回答";
  if (t === "recommend" || t === "archive") return relationTypeName(t);
  if (ALL_RELATION_TYPES.includes(t as RelationType)) return relationTypeName(t as RelationType);
  return t; // existing tag label text
}

function replyAdditionalLabel(t: string): string {
  if (t === "question") return "疑问";
  if (t === "answer") return "回答";
  return "回复";
}

/** True when a TAG edge's relationLabel carries actual user-entered label text (not the bare type name). */
function isValidTagLabel(label: string | undefined): label is string {
  return !!label && label !== 'tag';
}

function selKey(u: UnitSelection): string {
  const s = u.selection;
  if (s.kind === "whole") return `${u.messageId}::whole`;
  if (s.kind === "edge") return `${u.messageId}::edge:${s.edgeId}`;
  return `${u.messageId}::text:${s.start}:${s.len}:${s.text}`;
}

function unitEquals(a: UnitSelection, b: UnitSelection) {
  return selKey(a) === selKey(b);
}

function mergeUnits(base: UnitSelection[], added: UnitSelection[]) {
  const set = new Set(base.map(selKey));
  const res = [...base];
  for (const u of added) {
    const k = selKey(u);
    if (!set.has(k)) { set.add(k); res.push(u); }
  }
  return res;
}

function foldUpToWhole(units: UnitSelection[]) {
  const seen = new Set<string>(); const res: UnitSelection[] = [];
  for (const u of units) {
    if (seen.has(u.messageId)) continue;
    seen.add(u.messageId);
    res.push({ messageId: u.messageId, selection: { kind: "whole" } });
  }
  return res;
}

function describeUnit(u: UnitSelection): string {
  const s = u.selection;
  if (s.kind === "whole") return `整条消息 ${u.messageId}`;
  if (s.kind === "edge") return `关系消息 ${u.messageId} 的边片段 @edge:${s.edgeId}`;
  return `消息 ${u.messageId} 的片段(start=${s.start}, len=${s.len})「${s.text}」`;
}

let _nextIdCounter = 1;
function nextId(prefix: string): string {
  return `${prefix}-local-${Date.now()}-${_nextIdCounter++}`;
}

/** Extract a short display ID from a TargetRef for use in relation message content strings. */
function targetRefDisplayId(r: TargetRef): string {
  if (r.kind === 'message' || r.kind === 'text-fragment') return r.messageId;
  return r.relationId;
}

function buildRelationPayload(params: {
  relationType: string;
  label?: string;
  title?: string;
  targetLayout?: RelationPayload['targetLayout'];
}): RelationPayload | undefined {
  const payload: RelationPayload = {};
  if (params.label) payload.label = params.label;
  if (params.title) payload.title = params.title;
  if (params.targetLayout) payload.targetLayout = params.targetLayout;
  if ((params.relationType.toUpperCase() === 'MERGE' || params.relationType.toUpperCase() === 'SUMMARY') && !payload.targetLayout) {
    payload.targetLayout = 'multi-column';
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function relationTargetRefsSummary(targetRefs: TargetRef[]): string {
  if (targetRefs.length === 0) return '（无目标）';
  return targetRefs.map(ref => {
    if (ref.kind === 'message') return `消息 ${ref.messageId}`;
    if (ref.kind === 'text-fragment') return `消息 ${ref.messageId} 的片段`;
    return `关系 ${ref.relationId}`;
  }).join('；');
}

function buildRelationDemoMessage(relation: Relation): DemoMessage {
  const relType = relation.relationType.toLowerCase() as RelationType;
  const label = getRelationLabel(relation.payload);
  const title = getRelationTitle(relation.payload);
  const typeName = relationTypeName(relType);
  const targetSummary = relationTargetRefsSummary(relation.targetRefs);
  let content: string;
  if (relType === 'classify') {
    content = `话题：${title ?? `分类话题（${relation.targetRefs.length}）`}\n目标：${targetSummary}`;
  } else if (relType === 'summary') {
    content = `总结：${title ?? `总结（${relation.targetRefs.length}）`}\n目标：${targetSummary}`;
  } else if (relType === 'tag' && label) {
    content = `建立${typeName}关系「${label}」\n目标：${targetSummary}`;
  } else if (relation.sourceMessageId) {
    content = `建立${typeName}关系\n来源：${relation.sourceMessageId}\n目标：${targetSummary}`;
  } else {
    content = `建立${typeName}关系（无来源消息）\n目标：${targetSummary}`;
  }
  return {
    id: relation.id,
    author: relation.createdBy.username,
    createdAt: relation.createdAt,
    kind: 'relation',
    relationType: relType,
    relationPayload: relation.payload,
    content,
  };
}

function getTextTargetIds(targetRefs: TargetRef[]): string[] {
  return Array.from(new Set(
    targetRefs
      .filter((ref): ref is Extract<TargetRef, { kind: 'message' | 'text-fragment' }> =>
        ref.kind === 'message' || ref.kind === 'text-fragment'
      )
      .map(ref => ref.messageId)
  ));
}

function getRelationTargetIds(targetRefs: TargetRef[]): string[] {
  return Array.from(new Set(
    targetRefs
      .filter((ref): ref is Extract<TargetRef, { kind: 'relation' }> => ref.kind === 'relation')
      .map(ref => ref.relationId)
  ));
}

function collectOwnedByRelation(
  relationId: string,
  relationById: Map<string, Relation>,
  visited = new Set<string>()
): { textIds: Set<string>; relationIds: Set<string> } {
  const textIds = new Set<string>();
  const relationIds = new Set<string>();
  if (visited.has(relationId)) return { textIds, relationIds };
  visited.add(relationId);
  const relation = relationById.get(relationId);
  if (!relation) return { textIds, relationIds };

  // Collect text messages from targetRefs
  for (const textId of getTextTargetIds(relation.targetRefs)) textIds.add(textId);
  // For SUPPLEMENT relations, the sourceMessageId is also an owned text message
  // (the supplementary message is part of the supplement frame).
  const relType = relation.relationType.toUpperCase();
  if (relType === 'SUPPLEMENT' && relation.sourceMessageId) {
    textIds.add(relation.sourceMessageId);
  }
  for (const childRelationId of getRelationTargetIds(relation.targetRefs)) {
    relationIds.add(childRelationId);
    const child = relationById.get(childRelationId);
    if (!child) continue;
    const childType = child.relationType.toUpperCase();
    if (childType !== 'CLASSIFY' && childType !== 'MERGE' && childType !== 'SUPPLEMENT' && childType !== 'SUMMARY') continue;
    const nested = collectOwnedByRelation(childRelationId, relationById, visited);
    nested.textIds.forEach(id => textIds.add(id));
    nested.relationIds.forEach(id => relationIds.add(id));
  }

  return { textIds, relationIds };
}

/**
 * Expand a set of text message IDs by following CORRECT (更正) relations.
 * When text message T is in the input set, this function also adds the other
 * text message T2 from any CORRECT relation that involves T (as source or target).
 * The traversal is repeated until no new messages are found (handles correction chains).
 *
 * Returns a new Set with all the original IDs plus any additionally discovered ones.
 */
function expandTextIdsWithCorrections(
  textIds: Set<string>,
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): Set<string> {
  const expanded = new Set(textIds);
  const queue = Array.from(textIds);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const tid = queue.shift()!;
    if (visited.has(tid)) continue;
    visited.add(tid);
    for (const e of edges) {
      if (e.relationType !== 'correct') continue;
      if (msgMap.get(e.from.messageId)?.kind !== 'normal' || msgMap.get(e.to.messageId)?.kind !== 'normal') continue;
      if (e.from.messageId === tid && !expanded.has(e.to.messageId)) {
        expanded.add(e.to.messageId);
        queue.push(e.to.messageId);
      } else if (e.to.messageId === tid && !expanded.has(e.from.messageId)) {
        expanded.add(e.from.messageId);
        queue.push(e.from.messageId);
      }
    }
  }
  return expanded;
}

/** Deduplicate UnitSelection edges by (messageId + selection.kind), returning unique TargetRefs. */
function uniqueTargetRefsFromEdges(
  relEdges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): TargetRef[] {
  const seen = new Set<string>();
  const refs: TargetRef[] = [];
  for (const e of relEdges) {
    const key = e.to.messageId + '::' + e.to.selection.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(unitSelectionToTargetRef(e.to, msgMap));
  }
  return refs;
}

// ========================= Correction content generation =========================

/**
 * For a CORRECT relation, generate the new message content by applying
 * the replacement text to the selected fragment(s) or whole of the target message.
 * Returns null if the inputs are invalid (e.g. multiple target messages).
 */
function generateCorrectionContent(
  targetUnits: UnitSelection[],
  replacementText: string,
  msgMap: Map<string, DemoMessage>
): string | null {
  const uniqueTargetMids = Array.from(new Set(targetUnits.map(u => u.messageId)));
  if (uniqueTargetMids.length !== 1) return null;
  const targetMid = uniqueTargetMids[0];
  const targetMsg = msgMap.get(targetMid);
  if (!targetMsg || targetMsg.kind !== "normal") return null;

  // Collect text-fragment selections; if any exist, prefer fragment-level correction
  // even when a whole-message selection is also present (Bug 4 fix: whole→fragment support).
  const textFragments = targetUnits
    .filter(u => u.selection.kind === "text")
    .map(u => u.selection as { kind: "text"; start: number; len: number; text: string });

  if (textFragments.length > 0) {
    // Apply replacements in reverse order so earlier positions remain valid
    const sorted = [...textFragments].sort((a, b) => b.start - a.start);
    let content = targetMsg.content;
    for (const frag of sorted) {
      content = content.slice(0, frag.start) + replacementText + content.slice(frag.start + frag.len);
    }
    return content;
  }

  // Whole-message selection only: full replacement
  return replacementText;
}

function buildTextCorrectionReplacementMap(
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): Map<string, string> {
  const raw = new Map<string, string>();
  for (const e of edges) {
    if (e.relationType !== "correct") continue;
    if (e.from.messageId.startsWith("anon:")) continue;
    const fromMsg = msgMap.get(e.from.messageId);
    const toMsg = msgMap.get(e.to.messageId);
    if (fromMsg?.kind !== "normal" || toMsg?.kind !== "normal") continue;
    raw.set(e.to.messageId, e.from.messageId);
  }
  const resolved = new Map<string, string>();
  function resolve(id: string, seen = new Set<string>()): string {
    const next = raw.get(id);
    if (!next) return id;
    if (seen.has(id)) return id;
    seen.add(id);
    const finalId = resolve(next, seen);
    resolved.set(id, finalId);
    return finalId;
  }
  for (const oldId of raw.keys()) resolve(oldId);
  return resolved;
}

function applyTextCorrectionInheritance(
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): DemoEdge[] {
  const replaceMap = buildTextCorrectionReplacementMap(edges, msgMap);
  if (replaceMap.size === 0) return edges;
  const next: DemoEdge[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const e of edges) {
    if (e.relationType === "correct") {
      next.push(e);
      continue;
    }
    const fromIsNormal = msgMap.get(e.from.messageId)?.kind === "normal";
    const toIsNormal = msgMap.get(e.to.messageId)?.kind === "normal";
    const mappedFrom = fromIsNormal ? (replaceMap.get(e.from.messageId) ?? e.from.messageId) : e.from.messageId;
    const mappedTo = toIsNormal ? (replaceMap.get(e.to.messageId) ?? e.to.messageId) : e.to.messageId;
    const updated: DemoEdge = (mappedFrom === e.from.messageId && mappedTo === e.to.messageId)
      ? e
      : {
          ...e,
          from: { ...e.from, messageId: mappedFrom },
          to: { ...e.to, messageId: mappedTo },
        };
    const edgeKey = `${updated.relationMessageId}::${updated.relationType}::${selKey(updated.from)}::${selKey(updated.to)}::${updated.relationLabel}`;
    if (seen.has(edgeKey)) {
      changed = true;
      continue;
    }
    seen.add(edgeKey);
    if (updated !== e) changed = true;
    next.push(updated);
  }
  if (!changed && next.length === edges.length) return edges;
  return next;
}

// ========================= Character-level diff for comparison popup =========================

type DiffPart = { type: 'keep' | 'del' | 'ins'; text: string };

/** Maximum string length (chars) for which character-level diff is computed. Beyond this, plain display is used. */
const MAX_DIFF_LENGTH = 500;

/**
 * Compute a character-level diff between two strings.
 * Returns separate part arrays for the original and new text, each annotated
 * with keep/del/ins so changed characters can be highlighted.
 * Falls back to plain (no diff) for strings longer than MAX_DIFF_LENGTH chars.
 */
function computeCharDiff(orig: string, next: string): { origParts: DiffPart[]; nextParts: DiffPart[] } {
  const n = orig.length, m = next.length;
  if (n > MAX_DIFF_LENGTH || m > MAX_DIFF_LENGTH) {
    return { origParts: [{ type: 'keep', text: orig }], nextParts: [{ type: 'keep', text: next }] };
  }
  // LCS dynamic programming
  const dp: number[][] = Array(n + 1).fill(null).map(() => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = orig[i - 1] === next[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack
  const origSegs: DiffPart[] = [], nextSegs: DiffPart[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && orig[i - 1] === next[j - 1]) {
      origSegs.unshift({ type: 'keep', text: orig[i - 1] });
      nextSegs.unshift({ type: 'keep', text: next[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      nextSegs.unshift({ type: 'ins', text: next[j - 1] });
      j--;
    } else {
      origSegs.unshift({ type: 'del', text: orig[i - 1] });
      i--;
    }
  }
  // Merge consecutive same-type segments
  function merge(segs: DiffPart[]): DiffPart[] {
    const res: DiffPart[] = [];
    for (const s of segs) {
      if (res.length > 0 && res[res.length - 1].type === s.type) res[res.length - 1].text += s.text;
      else res.push({ ...s });
    }
    return res;
  }
  return { origParts: merge(origSegs), nextParts: merge(nextSegs) };
}

function renderDiffParts(parts: DiffPart[], side: 'orig' | 'next'): React.ReactNode {
  return parts.map((p, idx) => {
    const isChanged = (side === 'orig' && p.type === 'del') || (side === 'next' && p.type === 'ins');
    return (
      <span key={idx} style={isChanged ? {
        background: side === 'orig' ? 'rgba(220,50,50,0.35)' : 'rgba(50,200,80,0.35)',
        borderRadius: 2,
        outline: side === 'orig' ? '1px solid rgba(220,50,50,0.6)' : '1px solid rgba(50,200,80,0.6)',
      } : undefined}>{p.text}</span>
    );
  });
}

// ========================= StructureView / IncomingOutgoingList =========================

const INCOMING_OUTGOING_LIST_MAX_H = 120; // max height (px) for each incoming/outgoing edge list in the structure view

function fmtSel(u: UnitSelection) {
  if (u.selection.kind === "whole") return `${u.messageId}（整条消息）`;
  if (u.selection.kind === "edge") return `${u.messageId}（关系边 ${u.selection.edgeId}）`;
  const sel = u.selection;
  const preview = sel.text.slice(0, 12) + (sel.text.length > 12 ? '…' : '');
  return `${u.messageId}（文本片段 第${sel.start}位起 共${sel.len}字「${preview}」）`;
}

function IncomingOutgoingList(props: { focusIds: string[]; edges: DemoEdge[]; kind: "in" | "out"; messages: DemoMessage[] }) {
  const { focusIds, edges, kind, messages } = props;
  const rows = focusIds.map(id => {
    const m = messages.find(mm => mm.id === id);
    let arr: DemoEdge[] = [];
    if (m && m.kind === "relation") {
      arr = edges.filter(e => e.relationMessageId === id);
    } else {
      arr = kind === "in" ? edges.filter(e => e.to.messageId === id) : edges.filter(e => e.from.messageId === id);
    }
    return { focusId: id, entries: arr };
  });
  const hasAny = rows.some(r => r.entries.length > 0);
  if (!hasAny) return <div style={{ fontSize: 12, opacity: 0.6 }}>无</div>;
  return (
    <div style={{ fontSize: 12 }}>
      <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: INCOMING_OUTGOING_LIST_MAX_H, overflow: "auto" }}>
        {rows.map(r => (
          <li key={r.focusId} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{r.focusId}</div>
            {r.entries.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>无</div> : (
              <ul style={{ listStyle: "none", paddingLeft: 10, margin: 0 }}>
                {r.entries.map(e => (
                  <li key={e.id} style={{ marginBottom: 4 }}>
                    {relationTypeName(e.relationType)}：{fmtSel(e.from)} → {fmtSel(e.to)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StructureView(props: { focusIds: string[]; messages: DemoMessage[]; edges: DemoEdge[] }) {
  const { focusIds, messages, edges } = props;
  const msgMap = new Map(messages.map(m => [m.id, m]));
  if (!focusIds || focusIds.length === 0) {
    return (
      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>结构视图（全局模式·简化）</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>（进入焦点后显示：左侧指向我 / 右侧我指向）</div>
      </div>
    );
  }
  return (
    <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>结构视图（焦点模式 · 多焦点）</div>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
        当前焦点消息：
        {focusIds.map((id, idx) => {
          const m = msgMap.get(id);
          return <span key={id} style={{ marginLeft: idx === 0 ? 4 : 8 }}>{m ? `${m.id} · ${m.author}` : id}</span>;
        })}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1, border: "1px solid #333", borderRadius: 6, padding: 6, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>左侧（Incoming：指向焦点集合）</div>
          <IncomingOutgoingList focusIds={focusIds} edges={edges} kind="in" messages={messages} />
        </div>
        <div style={{ flex: 1, border: "1px solid #333", borderRadius: 6, padding: 6, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>右侧（Outgoing：焦点集合指向）</div>
          <IncomingOutgoingList focusIds={focusIds} edges={edges} kind="out" messages={messages} />
        </div>
      </div>
    </div>
  );
}

// ========================= TopicDetailPage =========================

type ViewMode = "list" | "graph";

type FocusSnapshot = {
  leftScroll: { top: number; left: number } | null;
  rightScroll: { top: number; left: number } | null;
  draftUnits: UnitSelection[];
  sourceUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  activeTextSelectId: string | null;
  lastClickedMessageId: string | null;
  focusHop: number;
};

type FocusEntry = {
  ids: string[];
  snapshot: FocusSnapshot | null;
  mode: "focus" | "topic";
  topicRelMsgId?: string;
};

export default function TopicDetailPage() {
  const { topicId } = useParams<{ topicId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [topic, setTopic] = useState<Topic | null>(null);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [edges, setEdges] = useState<DemoEdge[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!topicId) return;
    let cancelled = false;
    async function load() {
      try {
        setLoading(true); setLoadError(null);
        const [topicData, messagesData, relationsData] = await Promise.all([
          api.getTopic(topicId!),
          api.getMessages(topicId!, { limit: 200 }),
          api.getRelations(topicId!, { limit: 200 }),
        ]);
        if (cancelled) return;
        setTopic(topicData);
        const { messages: demoMsgs, edges: demoEdges } = convertMessagesToDemoModel(
          messagesData.data, relationsData.data
        );
        setRelations(relationsData.data);
        setMessages(demoMsgs);
        setEdges(demoEdges);
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(String(e?.message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [topicId]);

  const [relationType, setRelationType] = useState<RelationType | null>(null);
  const [secondaryRelationType, setSecondaryRelationType] = useState<string>("none");
  const [relationLabel, setRelationLabel] = useState("");
  const [newMessageContent, setNewMessageContent] = useState("");
  const [draftUnits, setDraftUnits] = useState<UnitSelection[]>([]);
  const [sourceUnits, setSourceUnits] = useState<UnitSelection[]>([]);
  const [targetUnits, setTargetUnits] = useState<UnitSelection[]>([]);
  const [activeTextSelectId, setActiveTextSelectId] = useState<string | null>(null);
  const [focusEntries, setFocusEntries] = useState<FocusEntry[]>([]);
  // Counter incremented on every exitFocus/exitAllFocus to force GraphView
  // remount, avoiding React DOM reconciliation bugs (removeChild errors)
  // that occur when the SVG canvas structure changes drastically.
  const [focusExitKey, setFocusExitKey] = useState(0);
  const [lastClickedMessageId, setLastClickedMessageId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [focusHop, setFocusHop] = useState<number>(1);
  // Popup state for decoration double-click (shows sender info)
  const [decorationPopup, setDecorationPopup] = useState<{
    messageId: string; kind: "agree" | "disagree";
    x: number; y: number;
  } | null>(null);
  // Popup state for tag badge double-click (shows who tagged)
  const [tagPopup, setTagPopup] = useState<{
    messageId: string; tagLabel: string; relMsgIds: string[];
    x: number; y: number;
  } | null>(null);
  const [comparisonPopup, setComparisonPopup] = useState<{
    relMsgId: string;
    x: number; y: number;
  } | null>(null);
  const [mergeInfoPopup, setMergeInfoPopup] = useState<{
    relMsgId: string;
    x: number; y: number;
  } | null>(null);

  const currentFocusEntry = focusEntries.length > 0 ? focusEntries[focusEntries.length - 1] : null;
  const currentFocusIds = currentFocusEntry?.ids ?? null;
  const relationById = useMemo(() => new Map(relations.map(relation => [relation.id, relation])), [relations]);
  const msgMap = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);
  const appendCreatedRelation = useCallback((backendRel: Relation) => {
    setRelations(prev => [...prev, backendRel]);
    setMessages(prev => [...prev, buildRelationDemoMessage(backendRel)]);
  }, []);

  // Per-edge corrected index: old relation-message ID → set of corrected edge IDs.
  // Used to skip corrected fragments when double-clicking to select all fragments.
  const correctedEdgeMap = useMemo(() => computeCorrectedEdgeMap(edges), [edges]);
  const lastInheritedEdgeSignatureRef = useRef<string>('');

  useEffect(() => {
    if (edges.length === 0) return;
    const inherited = applyTextCorrectionInheritance(edges, msgMap);
    const signature = inherited.map(e =>
      `${e.id}::${e.relationMessageId}::${e.relationType}::${selKey(e.from)}::${selKey(e.to)}::${e.relationLabel}`
    ).join('|');
    if (inherited !== edges && signature !== lastInheritedEdgeSignatureRef.current) {
      lastInheritedEdgeSignatureRef.current = signature;
      setEdges(inherited);
      return;
    }
    if (inherited === edges) {
      lastInheritedEdgeSignatureRef.current = signature;
    }
  }, [edges, msgMap, setEdges]);

  /** Returns edge IDs for a relation message, excluding any that have been individually corrected. */
  function getUncorrectedEdgeIds(relationMessageId: string): string[] {
    const correctedIds = correctedEdgeMap.get(relationMessageId);
    return getEdgeIdsForRelation(relationMessageId).filter(id => !correctedIds?.has(id));
  }

  // TAG-only source messages in the linear list view: messages used exclusively as old-style
  // TAG relation sources should not appear as list items (their label is shown on the tag badge).
  const tagSourceIdsForList = useMemo(() => {
    const hiddenTagSourceIds = new Set<string>();
    const shouldKeepVisible = new Set<string>();
    for (const e of edges) {
      const fromKind = msgMap.get(e.from.messageId)?.kind;
      if (e.relationType === "tag" && fromKind === "normal") {
        hiddenTagSourceIds.add(e.from.messageId);
      }
      if (msgMap.get(e.to.messageId)?.kind === "normal") shouldKeepVisible.add(e.to.messageId);
      if (e.relationType !== "tag" && fromKind === "normal") {
        shouldKeepVisible.add(e.from.messageId);
      }
    }
    for (const id of shouldKeepVisible) hiddenTagSourceIds.delete(id);
    return hiddenTagSourceIds;
  }, [edges, msgMap]);

  const voteStats = useMemo(() => {
    const res: Record<string, { agreeCount: number; disagreeCount: number; agreeKey: string; disagreeKey: string }> = {};
    for (const e of edges) {
      if (e.to.selection.kind === "edge") {
        const eid = e.to.selection.edgeId || "";
        if (eid.startsWith("dec:")) {
          const parts = eid.split(":");
          if (parts.length >= 3) {
            const mid = parts.slice(2).join(":");
            if (!res[mid]) res[mid] = { agreeCount: 0, disagreeCount: 0, agreeKey: `dec:agree:${mid}`, disagreeKey: `dec:disagree:${mid}` };
            if (e.relationType === "agree") res[mid].agreeCount++;
            if (e.relationType === "disagree") res[mid].disagreeCount++;
          }
        }
      } else if (e.to.selection.kind === "whole") {
        const mid = e.to.messageId;
        if (!res[mid]) res[mid] = { agreeCount: 0, disagreeCount: 0, agreeKey: `dec:agree:${mid}`, disagreeKey: `dec:disagree:${mid}` };
        if (e.relationType === "agree") res[mid].agreeCount++;
        if (e.relationType === "disagree") res[mid].disagreeCount++;
      }
    }
    return res;
  }, [edges]);
  const relationTypeByRelMsgId = useMemo(() => {
    const map = new Map<string, RelationType>();
    for (const relation of relations) {
      map.set(relation.id, relation.relationType.toLowerCase() as RelationType);
    }
    return map;
  }, [relations]);
  const replacedRelationMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.relationType !== "correct") continue;
      if (e.from.messageId.startsWith("anon:")) continue;
      const fromKind = msgMap.get(e.from.messageId)?.kind;
      const toKind = msgMap.get(e.to.messageId)?.kind;
      if (fromKind === "relation" && toKind === "relation") ids.add(e.to.messageId);
    }
    return ids;
  }, [edges, msgMap]);
  const classifyOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'CLASSIFY') continue;
      const owned = collectOwnedByRelation(relation.id, relationById);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById]);
  const mergeOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'MERGE') continue;
      const owned = collectOwnedByRelation(relation.id, relationById);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById]);
  const summaryOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'SUMMARY') continue;
      const owned = collectOwnedByRelation(relation.id, relationById);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById]);

  // Expand classify/summary ownership text IDs to include text messages that have
  // CORRECT (更正) relations with any already-owned message. This ensures that when
  // T1 is classified/summarized, the correcting message T2 (and the CORRECT relation
  // message) are automatically treated as part of the same group.
  const classifyOwnershipTextIdsExpanded = useMemo(
    () => expandTextIdsWithCorrections(classifyOwnership.textIds, edges, msgMap),
    [classifyOwnership, edges, msgMap]
  );
  const summaryOwnershipTextIdsExpanded = useMemo(
    () => expandTextIdsWithCorrections(summaryOwnership.textIds, edges, msgMap),
    [summaryOwnership, edges, msgMap]
  );

  const classifiedTargetTextIds = classifyOwnershipTextIdsExpanded;
  const classifiedTargetClassifyRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    classifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType === 'CLASSIFY') ids.add(id);
    });
    return ids;
  }, [classifyOwnership, relationById]);
  const classifiedTargetMergeRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    classifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType === 'MERGE') ids.add(id);
    });
    return ids;
  }, [classifyOwnership, relationById]);
  const classifiedTargetSupplementRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    classifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType === 'SUPPLEMENT') ids.add(id);
    });
    return ids;
  }, [classifyOwnership, relationById]);
  const classifiedTargetSummaryRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    classifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType === 'SUMMARY') ids.add(id);
    });
    return ids;
  }, [classifyOwnership, relationById]);

  function collectExclusiveRelationMsgIds(hiddenTextIds: Set<string>, ownedRelationIds: Set<string>) {
    const ids = new Set<string>();
    const edgesByRel = new Map<string, DemoEdge[]>();
    for (const e of edges) {
      const arr = edgesByRel.get(e.relationMessageId) ?? [];
      arr.push(e);
      edgesByRel.set(e.relationMessageId, arr);
    }
    for (const [relMsgId, relEdges] of edgesByRel) {
      const relType = relEdges[0]?.relationType;
      if (relType === 'classify' || relType === 'summary' || relType === 'merge') continue;
      if (ownedRelationIds.has(relMsgId)) continue;
      const textEndpoints = relEdges
        .flatMap(e => [e.from.messageId, e.to.messageId])
        .filter(mid => msgMap.get(mid)?.kind === 'normal');
      if (textEndpoints.length === 0) continue;
      if (textEndpoints.every(mid => hiddenTextIds.has(mid))) {
        ids.add(relMsgId);
      }
    }
    return ids;
  }

  const listExclusiveRelMsgIds = useMemo(
    () => collectExclusiveRelationMsgIds(classifyOwnershipTextIdsExpanded, classifyOwnership.relationIds),
    [edges, msgMap, classifyOwnershipTextIdsExpanded, classifyOwnership.relationIds]
  );
  const graphHiddenTextIds = useMemo(() => {
    const ids = new Set<string>(classifyOwnershipTextIdsExpanded);
    summaryOwnershipTextIdsExpanded.forEach(id => ids.add(id));
    // MERGE displays as a group frame whose targets remain visible as cards on the canvas,
    // so mergeOwnership.textIds is intentionally excluded here.
    return ids;
  }, [classifyOwnershipTextIdsExpanded, summaryOwnershipTextIdsExpanded]);
  const graphOwnedRelationIds = useMemo(() => {
    const ids = new Set<string>(classifyOwnership.relationIds);
    mergeOwnership.relationIds.forEach(id => ids.add(id));
    summaryOwnership.relationIds.forEach(id => ids.add(id));
    return ids;
  }, [classifyOwnership, mergeOwnership, summaryOwnership]);
  const graphExclusiveRelMsgIds = useMemo(
    () => collectExclusiveRelationMsgIds(graphHiddenTextIds, graphOwnedRelationIds),
    [edges, msgMap, graphHiddenTextIds, graphOwnedRelationIds]
  );
  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  // Saved scroll positions for each view mode, so switching modes does not reset to top.
  const viewModeScrollRef = useRef<{ graph: { top: number; left: number } | null; list: { top: number; left: number } | null }>({ graph: null, list: null });
  const prevFocusLenRef = useRef(0);
  const lastAddedFragmentRef = useRef<{ messageId: string; unit: UnitSelection; time: number } | null>(null);
  const mouseDownRef = useRef<{ x: number; y: number; messageId: string | null } | null>(null);
  const lastDragOrSelectTimeRef = useRef<number>(0);
  const lastClickActionsRef = useRef<{ type: "toggleWhole"; messageId: string; prevExisted: boolean; time: number }[]>([]);
  const TOTAL_FLEX = 4;
  const MIN_LEFT_FLEX = 0.6;
  const MAX_LEFT_FLEX = TOTAL_FLEX - MIN_LEFT_FLEX;
  const [leftFlex, setLeftFlex] = useState(TOTAL_FLEX / 2);
  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const splitterDragRef = useRef<{ startX: number; startFlex: number } | null>(null);
  // Ref to track the ID of a newly sent message that should be scrolled into view.
  const pendingScrollMsgIdRef = useRef<string | null>(null);
  // Track pending requestAnimationFrame handles so they can be cancelled before
  // React reconciles the DOM, preventing "removeChild" errors caused by stale
  // rAF callbacks accessing nodes that React has already removed.
  const scrollRafRef = useRef<number | null>(null);
  const scrollRaf2Ref = useRef<number | null>(null);

  function cancelScrollRafs() {
    if (scrollRafRef.current !== null) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null; }
    if (scrollRaf2Ref.current !== null) { cancelAnimationFrame(scrollRaf2Ref.current); scrollRaf2Ref.current = null; }
  }

  // Cleanup on unmount
  useEffect(() => () => cancelScrollRafs(), []);

  // Scroll the left panel canvas so the message with the given ID is centered.
  // Polls via requestAnimationFrame until the card appears in the DOM.
  // MAX_SCROLL_ATTEMPTS × ~16ms/frame ≈ 1 second maximum wait time.
  const MAX_SCROLL_ATTEMPTS = 60;
  function scrollMsgToCenter(msgId: string) {
    pendingScrollMsgIdRef.current = msgId;
    let attempts = 0;
    const tryScroll = () => {
      attempts++;
      if (attempts > MAX_SCROLL_ATTEMPTS) { pendingScrollMsgIdRef.current = null; return; }
      if (pendingScrollMsgIdRef.current !== msgId) return; // superseded by newer message
      const container = leftPanelRef.current;
      if (!container) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
      const el = container.querySelector(`[data-msgid="${msgId}"]`) as HTMLElement | null;
      if (!el) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
      pendingScrollMsgIdRef.current = null;
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
      const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
      container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
      container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
    };
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(tryScroll);
  }

  function captureSnapshot(): FocusSnapshot {
    return {
      leftScroll: leftPanelRef.current ? { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft } : null,
      rightScroll: rightPanelRef.current ? { top: rightPanelRef.current.scrollTop, left: rightPanelRef.current.scrollLeft } : null,
      draftUnits: draftUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
      sourceUnits: sourceUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
      targetUnits: targetUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
      activeTextSelectId,
      lastClickedMessageId,
      focusHop,
    };
  }

  function clampAndSetScroll(container: HTMLDivElement | null, top: number | null, left: number | null) {
    if (!container) return;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    if (top !== null) container.scrollTop = Math.min(Math.max(0, top), maxTop);
    if (left !== null) container.scrollLeft = Math.min(Math.max(0, left), maxLeft);
  }

  function restoreSnapshot(s: FocusSnapshot | null) {
    if (!s) return;
    setDraftUnits(s.draftUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
    setSourceUnits(s.sourceUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
    setTargetUnits(s.targetUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
    setActiveTextSelectId(s.activeTextSelectId);
    setLastClickedMessageId(s.lastClickedMessageId);
    setFocusHop(s.focusHop);
    // Cancel any in-flight scroll rAF before scheduling new ones so that stale
    // callbacks never touch DOM nodes after React has reconciled them away.
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRaf2Ref.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        scrollRaf2Ref.current = null;
        clampAndSetScroll(leftPanelRef.current, s.leftScroll?.top ?? null, s.leftScroll?.left ?? null);
        clampAndSetScroll(rightPanelRef.current, s.rightScroll?.top ?? null, s.rightScroll?.left ?? null);
      });
    });
  }

  function enterFocus(messageId: string, options?: { replace?: boolean; mode?: "focus" | "topic"; topicRelMsgId?: string }) {
    if (!messageId) return;
    const snapshot = captureSnapshot();
    const entry: FocusEntry = { ids: [messageId], snapshot, mode: options?.mode ?? "focus", topicRelMsgId: options?.topicRelMsgId };
    setFocusEntries(prev => options?.replace ? [entry] : [...prev, entry]);
  }

  function enterFocusMultiple(messageIds: string[], options?: { replace?: boolean; mode?: "focus" | "topic"; topicRelMsgId?: string }) {
    if (!messageIds || messageIds.length === 0) return;
    const snapshot = captureSnapshot();
    const entry: FocusEntry = { ids: messageIds, snapshot, mode: options?.mode ?? "focus", topicRelMsgId: options?.topicRelMsgId };
    setFocusEntries(prev => options?.replace ? [entry] : [...prev, entry]);
  }

  function exitFocus() {
    // Pop the focus stack and bump the exit key to force GraphView remount,
    // avoiding React 18 concurrent reconciliation bugs (removeChild errors).
    // The ErrorBoundary provides a safety net with automatic retry.
    const snapshot = focusEntries.length > 0 ? focusEntries[focusEntries.length - 1].snapshot : null;
    setFocusEntries(prev => {
      if (prev.length === 0) return prev;
      return prev.slice(0, -1);
    });
    setFocusExitKey(k => k + 1);
    if (snapshot) restoreSnapshot(snapshot);
  }

  function exitAllFocus() {
    const snapshot = focusEntries.length > 0 ? focusEntries[0].snapshot : null;
    setFocusEntries(prev => {
      if (prev.length === 0) return prev;
      return [];
    });
    setFocusExitKey(k => k + 1);
    if (snapshot) restoreSnapshot(snapshot);
  }

  function clearDraftAll() {
    setDraftUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  }

  const isFragmentSelected = useCallback((messageId: string, start: number, len: number, text: string) => {
    const u: UnitSelection = { messageId, selection: { kind: "text", start, len, text } };
    return draftUnits.some(x => unitEquals(x, u));
  }, [draftUnits]);

  function toggleFragmentSelection(messageId: string, start: number, len: number, text: string) {
    const u: UnitSelection = { messageId, selection: { kind: "text", start, len, text } };
    setDraftUnits(prev => {
      const exists = prev.some(x => unitEquals(x, u));
      return exists ? prev.filter(x => !unitEquals(x, u)) : [...prev, u];
    });
  }

  async function handleSendMessageOnly(overrideContent?: string): Promise<DemoMessage | null> {
    const text = overrideContent ?? newMessageContent;
    if (text.trim().length === 0) return null;
    if (!topicId) return null;
    try {
      const backendMsg = await api.createMessage(topicId, { content: text, contentType: 'TEXT' });
      const msg: DemoMessage = {
        id: backendMsg.id,
        author: backendMsg.createdBy.username,
        createdAt: backendMsg.createdAt,
        content: backendMsg.content,
        kind: "normal",
      };
      setMessages(prev => [...prev, msg]);
      if (isTopicFocus) {
        setFocusEntries(prev => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.mode !== "topic") return prev;
          return [...prev.slice(0, -1), { ...last, ids: [...last.ids, msg.id] }];
        });
        if (topicFocusRelMsgId) {
          // Persist the new message as a target of the classify topic in the backend,
          // so the message remains inside the topic after page reload.
          const topicRelation = relationById.get(topicFocusRelMsgId);
          if (topicRelation) {
            const existingRefs = (topicRelation.targetRefs ?? []) as TargetRef[];
            const newTargetRef: TargetRef = { kind: 'message', messageId: msg.id };
            const updatedRefs = [...existingRefs, newTargetRef];
            api.updateRelation(topicId!, topicFocusRelMsgId, { targetRefs: updatedRefs })
              .then(updatedRel => {
                setRelations(prev => prev.map(r => r.id === updatedRel.id ? updatedRel : r));
              })
              .catch(e => console.warn('更新分类目标失败:', e));
          }
          // Also update local edges state so the UI reflects the change immediately.
          setEdges(prev => {
            const alreadyLinked = prev.some(e =>
              (e.relationType === "classify" || e.relationType === "summary") &&
              e.relationMessageId === topicFocusRelMsgId &&
              e.to.messageId === msg.id &&
              e.to.selection.kind === "whole"
            );
            if (alreadyLinked) return prev;
            const relType = (topicFocusRelType === "summary" ? "summary" : "classify") as RelationType;
            return [...prev, {
              id: nextId("edge"),
              relationMessageId: topicFocusRelMsgId,
              relationType: relType,
              from: { messageId: `anon:${topicFocusRelMsgId}`, selection: { kind: "whole" } },
              to: { messageId: msg.id, selection: { kind: "whole" } },
              relationLabel: relationTypeName(relType),
            }];
          });
        }
      }
      if (!overrideContent) setNewMessageContent("");
      scrollMsgToCenter(msg.id);
      return msg;
    } catch (e: any) {
      alert(`发送消息失败: ${e?.message ?? e}`);
      return null;
    }
  }

  function handleMessageMouseDown(e: React.MouseEvent, messageId: string) {
    if (e.button !== 0) return;
    mouseDownRef.current = { x: e.clientX, y: e.clientY, messageId };
  }

  function undoRecentClickActionsForMessage(messageId: string) {
    const now = Date.now(); const windowMs = 600;
    const arr = lastClickActionsRef.current;
    if (!arr || arr.length === 0) return;
    const indices: number[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i];
      if (now - a.time > windowMs) continue;
      if (a.messageId === messageId) indices.push(i);
    }
    if (indices.length === 0) return;
    setDraftUnits(prev => {
      let cur = [...prev];
      for (const idx of indices) {
        const a = arr[idx];
        if (a.type === "toggleWhole") {
          const wholeUnit: UnitSelection = { messageId: a.messageId, selection: { kind: "whole" } };
          if (a.prevExisted) { if (!cur.some(u => unitEquals(u, wholeUnit))) cur.push(wholeUnit); }
          else { cur = cur.filter(u => !unitEquals(u, wholeUnit)); }
        }
      }
      return cur;
    });
    lastClickActionsRef.current = arr.filter((_v, idx) => !indices.includes(idx));
  }

  function handleMessageMouseUp(e: React.MouseEvent, messageId: string) {
    if (!mouseDownRef.current) return;
    const md = mouseDownRef.current; mouseDownRef.current = null;
    if (md.messageId !== messageId) return;
    const dx = Math.abs(md.x - e.clientX), dy = Math.abs(md.y - e.clientY);
    const moved = dx > 6 || dy > 6;
    if (moved) { lastDragOrSelectTimeRef.current = Date.now(); undoRecentClickActionsForMessage(messageId); }
  }

  function handleMessageClick(e: React.MouseEvent, messageId: string) {
    if (e.button !== 0) return;
    if (Date.now() - lastDragOrSelectTimeRef.current < 350) return;
    e.stopPropagation();
    setLastClickedMessageId(messageId);
    const wholeUnit: UnitSelection = { messageId, selection: { kind: "whole" } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, wholeUnit));
      const next = exists ? prev.filter(u => !unitEquals(u, wholeUnit)) : [...prev, wholeUnit];
      lastClickActionsRef.current.push({ type: "toggleWhole", messageId, prevExisted: exists, time: Date.now() });
      const now = Date.now();
      lastClickActionsRef.current = lastClickActionsRef.current.filter(a => now - a.time < 2000);
      return next;
    });
  }

  function handleMessageDoubleClick(e: React.MouseEvent, messageId: string) {
    e.stopPropagation();
    undoRecentClickActionsForMessage(messageId);
    const m = msgMap.get(messageId);
    setLastClickedMessageId(messageId);
    const currentlyActive = activeTextSelectId === messageId;
    if (m?.kind === "relation") {
      const relType = relationTypeByRelMsgId.get(messageId);
      if (relType === "classify" || relType === "summary") {
        // Always clear any text selection before entering classification to prevent
        // the browser's native double-click text selection from persisting into the new view.
        setActiveTextSelectId(null);
        clearBrowserSelection();
        enterClassifyTopic(messageId);
        return;
      }
      if (currentlyActive) { setActiveTextSelectId(null); clearBrowserSelection(); }
      return;
    }
    if (currentlyActive) {
      const laf = lastAddedFragmentRef.current;
      if (laf && laf.messageId === messageId && Date.now() - laf.time < 450) {
        setDraftUnits(prev => prev.filter(u => !unitEquals(u, laf.unit)));
        lastAddedFragmentRef.current = null;
      }
      setActiveTextSelectId(null); clearBrowserSelection(); return;
    }
    setActiveTextSelectId(messageId); clearBrowserSelection();
  }

  function handleTextMouseUp(e: React.MouseEvent, messageId: string) {
    if (!activeTextSelectId || activeTextSelectId !== messageId) return;
    const m = msgMap.get(messageId);
    if (!m || m.kind !== "normal") return;
    const container = e.currentTarget as HTMLElement;
    const frag = getSelectionFragment(container);
    clearBrowserSelection();
    if (!frag || frag.len <= 0) return;
    const fragmentUnit: UnitSelection = { messageId, selection: { kind: "text", start: frag.start, len: frag.len, text: frag.text } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, fragmentUnit));
      return exists ? prev.filter(u => !unitEquals(u, fragmentUnit)) : [...prev, fragmentUnit];
    });
    lastAddedFragmentRef.current = { messageId, unit: fragmentUnit, time: Date.now() };
    lastDragOrSelectTimeRef.current = Date.now();
    undoRecentClickActionsForMessage(messageId);
  }

  function handleFragmentAnchorClick(messageId: string, start: number, len: number, text: string) {
    setActiveTextSelectId(messageId); clearBrowserSelection();
    toggleFragmentSelection(messageId, start, len, text);
    setLastClickedMessageId(messageId);
    undoRecentClickActionsForMessage(messageId);
  }

  function commitDraftTo(role: "source" | "target") {
    if (draftUnits.length === 0) return;
    if (role === "source") setSourceUnits(prev => mergeUnits(prev, draftUnits));
    else setTargetUnits(prev => mergeUnits(prev, draftUnits));
    setDraftUnits([]); setActiveTextSelectId(null);
  }

  function removeUnitFrom(role: "source" | "target", unit: UnitSelection) {
    const update = (list: UnitSelection[]) => list.filter(u => !unitEquals(u, unit));
    if (role === "source") setSourceUnits(prev => update(prev));
    else setTargetUnits(prev => update(prev));
  }

  function removeUnitFromDraft(unit: UnitSelection) {
    setDraftUnits(prev => prev.filter(u => !unitEquals(u, unit)));
  }

  function getGroupedTargetTextMessageIds(units: UnitSelection[]): string[] {
    const ids = new Set<string>();
    for (const unit of foldUpToWhole(units)) {
      if (msgMap.get(unit.messageId)?.kind === "normal") {
        ids.add(unit.messageId);
        continue;
      }
      const relType = relationTypeByRelMsgId.get(unit.messageId);
      if (relType !== "classify" && relType !== "merge" && relType !== "supplement" && relType !== "summary") continue;
      const owned = collectOwnedByRelation(unit.messageId, relationById);
      owned.textIds.forEach(id => ids.add(id));
    }
    return [...ids];
  }

  function getClassifyTargetRefs(units: UnitSelection[]): TargetRef[] {
    const res: TargetRef[] = [];
    const seen = new Set<string>();
    for (const u of foldUpToWhole(units)) {
      const mid = u.messageId;
      const m = msgMap.get(mid);
      if (!m) continue;
      if (m.kind === "normal") {
        const key = `message:${mid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        res.push({ kind: "message", messageId: mid });
        continue;
      }
      const relType = relationTypeByRelMsgId.get(mid);
      if (relType !== "classify" && relType !== "merge" && relType !== "supplement" && relType !== "summary") continue;
      const key = `relation:${mid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      res.push({ kind: "relation", relationId: mid });
    }
    return res;
  }

  /**
   * Check whether any selected text messages have non-reference edges to
   * already-classified text messages that are NOT part of the current selection.
   *
   * Defensive expansion: when a selected text message is connected via an edge
   * to a classify/merge/supplement/summary relation message, the relation's
   * owned text messages are also treated as "selected".  This prevents false
   * positives when getGroupedTargetTextMessageIds has already expanded the
   * selection but an edge exists between a selected text and a classified text
   * that belongs to the same relation group.
   */
  function hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds: string[]): boolean {
    if (targetTextIds.length === 0) return false;
    const selected = new Set(targetTextIds);

    // Defensive expansion: when a selected normal message has an edge to an
    // expandable relation message (classify/merge/supplement/summary), treat
    // that relation's owned text messages as also selected.
    const expandableTypes = new Set(['classify', 'merge', 'supplement', 'summary']);
    for (const e of edges) {
      const fromMsg = msgMap.get(e.from.messageId);
      const toMsg = msgMap.get(e.to.messageId);
      const fromIsSelectedNormal = fromMsg?.kind === 'normal' && selected.has(e.from.messageId);
      const toIsSelectedNormal = toMsg?.kind === 'normal' && selected.has(e.to.messageId);
      const relationEndpoint = fromIsSelectedNormal
        ? (toMsg?.kind === 'relation' && expandableTypes.has(toMsg.relationType ?? '') ? e.to.messageId : null)
        : toIsSelectedNormal
          ? (fromMsg?.kind === 'relation' && expandableTypes.has(fromMsg.relationType ?? '') ? e.from.messageId : null)
          : null;
      if (!relationEndpoint) continue;
      const owned = collectOwnedByRelation(relationEndpoint, relationById);
      for (const ownedTextId of owned.textIds) {
        if (!selected.has(ownedTextId)) selected.add(ownedTextId);
      }
    }

    for (const e of edges) {
      // Skip reference and correct edges: reference is a citation that does
      // not imply semantic grouping; correct edges are already handled by
      // expandTextIdsWithCorrections and should not trigger cross-link blocks.
      if (e.relationType === "reference" || e.relationType === "correct") continue;
      const fromKind = msgMap.get(e.from.messageId)?.kind;
      const toKind = msgMap.get(e.to.messageId)?.kind;
      if (fromKind !== "normal" || toKind !== "normal") continue;
      const fromSelected = selected.has(e.from.messageId);
      const toSelected = selected.has(e.to.messageId);
      if (fromSelected !== toSelected) {
        const nonTargetMessageId = fromSelected ? e.to.messageId : e.from.messageId;
        if (classifiedTargetTextIds.has(nonTargetMessageId)) return true;
      }
    }
    return false;
  }

  function getClassifyTargetTextIdsByRelMsgId(relMsgId: string): string[] {
    const relation = relationById.get(relMsgId);
    return relation ? getTextTargetIds(relation.targetRefs) : [];
  }

  function getClassifyTargetRelationIdsByRelMsgId(relMsgId: string): string[] {
    const relation = relationById.get(relMsgId);
    return relation
      ? getRelationTargetIds(relation.targetRefs).filter(mid =>
          msgMap.get(mid)?.kind === "relation" &&
          (
            relationTypeByRelMsgId.get(mid) === "classify" ||
            relationTypeByRelMsgId.get(mid) === "merge" ||
            relationTypeByRelMsgId.get(mid) === "supplement" ||
            relationTypeByRelMsgId.get(mid) === "summary"
          )
        )
      : [];
  }

  function enterClassifyTopic(relMsgId: string) {
    const targetTextIds = getClassifyTargetTextIdsByRelMsgId(relMsgId);
    const targetRelationIds = getClassifyTargetRelationIdsByRelMsgId(relMsgId);
    const targetIds = new Set<string>(targetTextIds);
    for (const targetRelationId of targetRelationIds) {
      if (relationTypeByRelMsgId.get(targetRelationId) === "classify" ||
          relationTypeByRelMsgId.get(targetRelationId) === "summary") {
        targetIds.add(targetRelationId);
        continue;
      }
      const owned = collectOwnedByRelation(targetRelationId, relationById);
      owned.textIds.forEach(id => targetIds.add(id));
      owned.relationIds.forEach(id => targetIds.add(id));
    }
    if (targetIds.size === 0) {
      if (!msgMap.has(relMsgId)) return;
      enterFocusMultiple([relMsgId], { mode: "topic", topicRelMsgId: relMsgId });
      setFocusHop(0);
      return;
    }
    enterFocusMultiple(Array.from(targetIds), { mode: "topic", topicRelMsgId: relMsgId });
    setFocusHop(0);
  }

  function getEdgeIdsForRelation(relationMessageId: string) {
    return edges.filter(e => e.relationMessageId === relationMessageId).map(e => e.id);
  }

  function relationAllFragmentsSelected(relationMessageId: string, units: UnitSelection[]) {
    const edgeIds = getUncorrectedEdgeIds(relationMessageId);
    if (edgeIds.length === 0) return units.some(u => u.messageId === relationMessageId && u.selection.kind === "whole");
    const have = new Set(units.filter(u => u.messageId === relationMessageId && u.selection.kind === "edge").map(u => (u.selection as any).edgeId));
    return edgeIds.every(id => have.has(id));
  }

  function ensureRelationWholeSynced(relationMessageId: string) {
    setDraftUnits(prev => {
      const shouldHaveWhole = relationAllFragmentsSelected(relationMessageId, prev);
      const wholeUnit: UnitSelection = { messageId: relationMessageId, selection: { kind: "whole" } };
      const hasWhole = prev.some(u => unitEquals(u, wholeUnit));
      let next = [...prev];
      if (shouldHaveWhole && !hasWhole) next.push(wholeUnit);
      else if (!shouldHaveWhole && hasWhole) next = next.filter(u => !unitEquals(u, wholeUnit));
      return next;
    });
  }

  function handleEdgeLabelSingleClick(e: React.MouseEvent, relationMessageId: string, edgeId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relationMessageId);
    const unit: UnitSelection = { messageId: relationMessageId, selection: { kind: "edge", edgeId } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, unit));
      const next = exists ? prev.filter(u => !unitEquals(u, unit)) : [...prev, unit];
      setTimeout(() => ensureRelationWholeSynced(relationMessageId), 0);
      return next;
    });
  }

  function handleEdgeLabelDoubleClick(e: React.MouseEvent, relationMessageId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relationMessageId);
    const wholeUnit: UnitSelection = { messageId: relationMessageId, selection: { kind: "whole" } };
    const edgeIds = getUncorrectedEdgeIds(relationMessageId);
    const edgeUnits = edgeIds.map(id => ({ messageId: relationMessageId, selection: { kind: "edge", edgeId: id } as Selection }));
    setDraftUnits(prev => {
      const hasWhole = prev.some(u => unitEquals(u, wholeUnit));
      if (hasWhole) return prev.filter(u => !(u.messageId === relationMessageId && (u.selection.kind === "whole" || u.selection.kind === "edge")));
      const merged = mergeUnits(prev, edgeUnits as UnitSelection[]);
      if (!merged.some(u => unitEquals(u, wholeUnit))) merged.push(wholeUnit);
      return merged;
    });
  }

  /**
   * Create a single TAG relation for `targetMid` with the given label, register the
   * new relation message in state, and return a DemoEdge for the caller to append.
   * Returns null if the API call fails (error is shown via alert).
   */
  async function sendTagRelation(targetMid: string, tagLabel: string): Promise<DemoEdge | null> {
    if (!topicId) return null;
    const backendTargetRef = unitSelectionToTargetRef({ messageId: targetMid, selection: { kind: "whole" } }, msgMap);
    try {
      const backendRel = await api.createRelation(topicId, {
        relationType: 'TAG',
        sourceMessageId: null,
        targetRefs: [backendTargetRef],
        payload: buildRelationPayload({ relationType: 'TAG', label: tagLabel }),
      });
      const relId = backendRel.id;
      appendCreatedRelation(backendRel);
      const anonSrcId = `anon:${relId}`;
      return { id: nextId("edge"), relationMessageId: relId, relationType: "tag", from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { messageId: targetMid, selection: { kind: "whole" } }, relationLabel: tagLabel } as DemoEdge;
    } catch (e: any) {
      alert(`建立标注关系失败: ${e?.message ?? e}`);
      return null;
    }
  }

  async function handleCreateRelationWithSourcesAndTargets(params: {
    sources: UnitSelection[]; targets: UnitSelection[]; label: string;
  }) {
    if (!topicId) return;
    if (!relationType) return;
    const { sources, label } = params;
    // Deduplicate relation-message targets: when both a whole and edge selection exist for the same
    // relation message, keep only the whole (it covers all edges, preventing duplicate
    // targetRefs that the backend would reject and that GraphView would render as extra arrows).
    const wholeRelIds = new Set(
      params.targets
        .filter(t => msgMap.get(t.messageId)?.kind === "relation" && t.selection.kind === 'whole')
        .map(t => t.messageId)
    );
    let targets = params.targets.filter(t =>
      !(msgMap.get(t.messageId)?.kind === "relation" && t.selection.kind === 'edge' && wholeRelIds.has(t.messageId))
    );
    const newEdgesList: DemoEdge[] = [];

    const buildEdges = (src: UnitSelection, tgt: UnitSelection, type: RelationType, lbl: string, relId: string) => {
      return {
        id: nextId("edge"),
        relationMessageId: relId,
        relationType: type,
        from: src,
        to: tgt,
        relationLabel: lbl,
      } as DemoEdge;
    };

    if (relationType === "reply") {
      const fromReply = foldUpToWhole(sources);
      const toReply = foldUpToWhole(targets);
      // Relation messages are also messages — include relation-message sources
      const uniqueSources = Array.from(new Set(fromReply.map(s => s.messageId)));
      const replyAdditional = secondaryRelationType === "question" || secondaryRelationType === "answer"
        ? secondaryRelationType
        : "none";
      const replyEdgeLabel = replyAdditional === "none" ? "reply" : replyAdditional;
      for (const srcId of uniqueSources) {
        const targetRefs = toReply.map(t => unitSelectionToTargetRef(t, msgMap));
        try {
          const backendRel = await api.createRelation(topicId, {
            relationType: relationType.toUpperCase(),
            sourceMessageId: srcId,
            targetRefs,
            payload: buildRelationPayload({
              relationType: relationType.toUpperCase(),
              label: replyAdditional === "none" ? undefined : replyAdditional,
            }),
          });
          const relId = backendRel.id;
          appendCreatedRelation(backendRel);
          for (const s of fromReply) {
            for (const t of toReply) {
              newEdgesList.push(buildEdges({ ...s }, { ...t }, "reply", replyEdgeLabel, relId));
            }
          }
        } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
      }
    } else if (relationType === "agree" || relationType === "disagree") {
      // Relation messages are also messages — include relation-message sources
      const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
      // Deduplicate targets by messageId — agree/disagree always creates one edge per unique target
      const uniqueTargetMids = Array.from(new Set(targets.map(t => t.messageId)));
      if (uniqueSources.length > 0) {
        for (const srcId of uniqueSources) {
          try {
            const targetRefs = targets.map(t => unitSelectionToTargetRef(t, msgMap));
            const backendRel = await api.createRelation(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, targetRefs });
            const relId = backendRel.id;
            appendCreatedRelation(backendRel);
            for (const targetMid of uniqueTargetMids) {
              newEdgesList.push(buildEdges({ messageId: srcId, selection: { kind: "whole" } }, { messageId: targetMid, selection: { kind: "whole" } }, relationType, label, relId));
            }
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
      } else {
        // Pure-stance: no source — persist to backend (relation messages are first-class messages)
        for (const targetMid of uniqueTargetMids) {
          try {
            const backendRel = await api.createRelation(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [unitSelectionToTargetRef({ messageId: targetMid, selection: { kind: "whole" } }, msgMap)] });
            const relId = backendRel.id;
            appendCreatedRelation(backendRel);
            const anonSrcId = `anon:${backendRel.id}`;
            newEdgesList.push(buildEdges({ messageId: anonSrcId, selection: { kind: "whole" } }, { messageId: targetMid, selection: { kind: "whole" } }, relationType, label, relId));
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
      }
    } else if (relationType === "recommend" || relationType === "archive") {
      // RECOMMEND/ARCHIVE: user-to-message relations with no source message, one per target.
      // Source units are intentionally ignored — these relations never carry a source message.
      const uniqueTargetMids = Array.from(new Set(targets.map(t => t.messageId)));
      for (const targetMid of uniqueTargetMids) {
        try {
          const backendRel = await api.createRelation(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [unitSelectionToTargetRef({ messageId: targetMid, selection: { kind: "whole" } }, msgMap)] });
          const relId = backendRel.id;
          appendCreatedRelation(backendRel);
          const anonSrcId = `anon:${backendRel.id}`;
          newEdgesList.push(buildEdges({ messageId: anonSrcId, selection: { kind: "whole" } }, { messageId: targetMid, selection: { kind: "whole" } }, relationType, label, relId));
        } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
      }
    } else if (relationType === "tag") {
      // TAG: user-to-message relation with no source message; label stored as tagLabel.
      // Source units are intentionally ignored — TAG never uses a source text message.
      const uniqueTargetMids = Array.from(new Set(targets.map(t => t.messageId)));
      const tagLabel = label;
      for (const targetMid of uniqueTargetMids) {
        const edge = await sendTagRelation(targetMid, tagLabel);
        if (edge) newEdgesList.push(edge);
      }
    } else {
      // Relation messages are also messages — include relation-message sources
      const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
      for (const srcId of uniqueSources) {
        const srcs = sources.filter(s => s.messageId === srcId);
        for (const srcUnit of srcs) {
          const targetRefs = targets.map(t => unitSelectionToTargetRef(t, msgMap));
          try {
            const backendRel = await api.createRelation(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, targetRefs });
            const relId = backendRel.id;
            appendCreatedRelation(backendRel);
            for (const t of targets) {
              newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, relationType, label, relId));
            }
            if (secondaryRelationType !== "none" && relationType === "correct") {
              const secType = secondaryRelationType as RelationType;
              for (const t of targets) {
                newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, secType, label, relId));
              }
            }
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
      }
    }
    setEdges(prev => [...prev, ...newEdgesList]);
  }

  async function handleQuickSendAndRelateFromDraftTargets() {
    const text = newMessageContent.trim();

    // No relation type selected: just send a plain message
    if (relationType === null) {
      if (text.length === 0) return;
      await handleSendMessageOnly(text);
      setNewMessageContent("");
      return;
    }

    // Effective targets: candidates (draftUnits) if non-empty, else explicit target collection.
    // This lets users either click on the canvas to pick draft candidates (quick path) or
    // explicitly commit messages to the target collection via "加入目标集合".
    const effectiveTargets = draftUnits.length > 0 ? draftUnits : targetUnits;

    // Scenario: source collection + target collection explicitly committed (no draft candidates).
    // Build the relation directly without creating a new text message.
    if (relationType !== "classify" && relationType !== "merge" && draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) {
      const labelDefault = relationTypeName(relationType);
      const label = relationLabel.trim() || labelDefault;
      await handleCreateRelationWithSourcesAndTargets({ sources: sourceUnits, targets: targetUnits, label });
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    if (effectiveTargets.length === 0 && relationType !== "classify") return;
    const isAgreeDisagree = relationType === "agree" || relationType === "disagree";
    const isSupplement = relationType === "supplement";
    // isInlineBadge kept for backwards-compat but recommend/archive are no longer top-level types
    const isInlineBadge = false;

    // TAG + secondary relation: create RECOMMEND/ARCHIVE or quick-annotate TAG with label from secondary
    if (relationType === "tag" && secondaryRelationType !== "none") {
      const secType = secondaryRelationType;
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      const newEdgesList: DemoEdge[] = [];
      if (secType === "recommend" || secType === "archive") {
        // Create inline badge relation (no source message), one per target
        for (const tgtMid of uniqueTargetMids) {
          const backendTargetRef = unitSelectionToTargetRef({ messageId: tgtMid, selection: { kind: "whole" } }, msgMap);
          try {
            const backendRel = await api.createRelation(topicId!, { relationType: secType.toUpperCase(), sourceMessageId: null, targetRefs: [backendTargetRef] });
            const relId = backendRel.id;
            appendCreatedRelation(backendRel);
            const anonSrcId = `anon:${backendRel.id}`;
            newEdgesList.push({ id: nextId("edge"), relationMessageId: relId, relationType: secType as RelationType, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { messageId: tgtMid, selection: { kind: "whole" } }, relationLabel: relationTypeName(secType) } as DemoEdge);
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
        setEdges(prev => [...prev, ...newEdgesList]);
      } else {
        // Existing tag label selected: create TAG relation directly without a source message.
        // The label text is stored in tagLabel on the relation itself.
        const tagLabel = secType;
        const newTagEdges: DemoEdge[] = [];
        for (const tgtMid of uniqueTargetMids) {
          const edge = await sendTagRelation(tgtMid, tagLabel);
          if (edge) newTagEdges.push(edge);
        }
        setEdges(prev => [...prev, ...newTagEdges]);
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // Relation target with CORRECT: no text, no source — create null-source relation
    const hasDraftRelTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation');
    const hasSecSelector = relationType === "correct" && hasDraftRelTarget;
    if (hasSecSelector) {
      if (text.length > 0 || sourceUnits.length > 0) return; // validation: state must be clean

      // CORRECT targeting a relation message with a secondary relation type:
      // Create a new relation of the secondary type (with the same endpoints as the old relation),
      // then create a CORRECT relation pointing from the new relation to the old relation.
      // A double-click on an edge label adds both a "whole" unit and one or more "edge" units for
      // the same relation message, so we count unique relation-message IDs rather than raw units.
      const relDraftMsgIds = Array.from(new Set(
        draftUnits.filter(u => msgMap.get(u.messageId)?.kind === 'relation').map(u => u.messageId)
      ));
      if (relationType === "correct" && secondaryRelationType !== "none" && relDraftMsgIds.length === 1) {
        const targetRelMsgId = relDraftMsgIds[0];
        const oldRelEdges = edges.filter(e => e.relationMessageId === targetRelMsgId);
        if (oldRelEdges.length === 0) {
          alert(`无法找到目标关系消息的边（ID：${targetRelMsgId}），无法创建更正关系`);
          return;
        }
        const secType = secondaryRelationType as RelationType;
        const secTypeName = relationTypeName(secType);
        const oldSourceId = oldRelEdges[0].from.messageId;
        const newSourceId = oldSourceId.startsWith('anon:') ? null : oldSourceId;
        const corrTypeName = relationTypeName("correct");

        // Determine which edges the user selected:
        // "whole" means the user selected the entire relation (all edges) → one combined correction.
        // Specific "edge" selections (no "whole") → one separate correction per selected fragment.
        const wholeSelected = draftUnits.some(u => u.messageId === targetRelMsgId && u.selection.kind === "whole");
        const selectedEdgeIds = new Set(
          draftUnits
            .filter(u => u.messageId === targetRelMsgId && u.selection.kind === "edge")
            .map(u => (u.selection as { kind: "edge"; edgeId: string }).edgeId)
        );
        const edgesToCorrect = wholeSelected
          ? oldRelEdges
          : oldRelEdges.filter(e => selectedEdgeIds.has(e.id));
        if (edgesToCorrect.length === 0) {
          alert(`没有选中的片段，无法创建更正关系`);
          return;
        }

        const newEdgesList: DemoEdge[] = [];
        try {
          if (wholeSelected) {
            // Whole selected: one combined correction covering all edges (original behavior)
            const newTargetRefs = uniqueTargetRefsFromEdges(edgesToCorrect, msgMap);
            // Step 1: Create the new relation of secondary type with the same endpoints
            const newRelBackend = await api.createRelation(topicId!, { relationType: secType.toUpperCase(), sourceMessageId: newSourceId, targetRefs: newTargetRefs });
            const newRelId = newRelBackend.id;
            appendCreatedRelation(newRelBackend);
            const newFromId = newSourceId ?? `anon:${newRelId}`;
            for (const e of edgesToCorrect) {
              newEdgesList.push({ id: nextId("edge"), relationMessageId: newRelId, relationType: secType, from: { messageId: newFromId, selection: { kind: "whole" } }, to: { ...e.to }, relationLabel: secTypeName } as DemoEdge);
            }
            // Step 2: Create the CORRECT relation with the new relation as source, old relation as target
            const corrBackendRel = await api.createRelation(topicId!, { relationType: 'CORRECT', sourceMessageId: newRelId, targetRefs: [{ kind: 'relation', relationId: targetRelMsgId }] });
            const corrRelId = corrBackendRel.id;
            appendCreatedRelation(corrBackendRel);
            newEdgesList.push({ id: nextId("edge"), relationMessageId: corrRelId, relationType: "correct", from: { messageId: newRelId, selection: { kind: "whole" } }, to: { messageId: targetRelMsgId, selection: { kind: "whole" } }, relationLabel: corrTypeName } as DemoEdge);
          } else {
            // Specific fragments selected: one separate correction per selected edge fragment
            for (const edge of edgesToCorrect) {
              const newTargetRefs = uniqueTargetRefsFromEdges([edge], msgMap);
              // Step 1: Create a new relation of secondary type for this fragment only
              const newRelBackend = await api.createRelation(topicId!, { relationType: secType.toUpperCase(), sourceMessageId: newSourceId, targetRefs: newTargetRefs });
              const newRelId = newRelBackend.id;
              appendCreatedRelation(newRelBackend);
              const newFromId = newSourceId ?? `anon:${newRelId}`;
              newEdgesList.push({ id: nextId("edge"), relationMessageId: newRelId, relationType: secType, from: { messageId: newFromId, selection: { kind: "whole" } }, to: { ...edge.to }, relationLabel: secTypeName } as DemoEdge);
              // Step 2: Create the CORRECT relation for this fragment
              const corrBackendRel = await api.createRelation(topicId!, { relationType: 'CORRECT', sourceMessageId: newRelId, targetRefs: [{ kind: 'relation', relationId: targetRelMsgId }] });
              const corrRelId = corrBackendRel.id;
              appendCreatedRelation(corrBackendRel);
              newEdgesList.push({ id: nextId("edge"), relationMessageId: corrRelId, relationType: "correct", from: { messageId: newRelId, selection: { kind: "whole" } }, to: { messageId: targetRelMsgId, selection: { kind: "whole" } }, relationLabel: corrTypeName } as DemoEdge);
            }
          }
        } catch (e: any) { alert(`建立更正关系失败: ${e?.message ?? e}`); }
        setEdges(prev => [...prev, ...newEdgesList]);
        setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
        setRelationType(null); setSecondaryRelationType("none");
        return;
      }

      // CORRECT (no secondary) targeting a relation message: create null-source relation
      const targetRefs = draftUnits.map(u => unitSelectionToTargetRef(u, msgMap));
      const typeName = relationTypeName(relationType);
      const newEdgesList: DemoEdge[] = [];
      try {
        const backendRel = await api.createRelation(topicId!, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs });
        const relId = backendRel.id;
        appendCreatedRelation(backendRel);
        const anonSrcId = `anon:${backendRel.id}`;
        for (const t of draftUnits) {
          newEdgesList.push({ id: nextId("edge"), relationMessageId: relId, relationType, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { ...t }, relationLabel: typeName } as DemoEdge);
        }
        if (secondaryRelationType !== "none") {
          const secType = secondaryRelationType as RelationType;
          for (const t of draftUnits) {
            newEdgesList.push({ id: nextId("edge"), relationMessageId: relId, relationType: secType, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { ...t }, relationLabel: relationTypeName(secType) } as DemoEdge);
          }
        }
      } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
      setEdges(prev => [...prev, ...newEdgesList]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    if ((isAgreeDisagree || isInlineBadge) && text.length === 0) {
      // Agree/disagree/inline-badge: one relation message per target (separate decoration badges).
      // Relation messages are first-class messages — persist all of them to the backend.
      const newEdgesList: DemoEdge[] = [];
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      {
        // Agree/disagree/inline-badge (recommend/archive): one relation per target — persist to backend
        for (const tgtMid of uniqueTargetMids) {
          const backendTargetRef = unitSelectionToTargetRef({ messageId: tgtMid, selection: { kind: "whole" } }, msgMap);
          try {
            const backendRel = await api.createRelation(topicId!, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [backendTargetRef] });
            const relId = backendRel.id;
            appendCreatedRelation(backendRel);
            const anonSrcId = `anon:${backendRel.id}`;
            newEdgesList.push({
              id: nextId("edge"), relationMessageId: relId, relationType,
              from: { messageId: anonSrcId, selection: { kind: "whole" } },
              to: { messageId: tgtMid, selection: { kind: "whole" } },
              relationLabel: relationTypeName(relationType),
            } as DemoEdge);
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
      }
      setEdges(prev => [...prev, ...newEdgesList]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // SUPPLEMENT relation: user-to-message relation (like CLASSIFY/MERGE/SUMMARY), no source message.
    // If text is present, create a text message first and include it as a target of the frame.
    // This avoids creating normal→normal edges that could falsely trigger cross-link checks.
    if (isSupplement) {
      const newEdgesList: DemoEdge[] = [];
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      let extraTargetMid: string | null = null;
      if (text.length > 0) {
        const msg = await handleSendMessageOnly(text);
        // If message creation fails, handleSendMessageOnly shows an alert.
        // Keep UI state intact (selections, relation type) so the user can retry.
        if (!msg) return;
        extraTargetMid = msg.id;
      }
      const allTargetMids = extraTargetMid ? [...uniqueTargetMids, extraTargetMid] : uniqueTargetMids;
      const targetRefs = allTargetMids.map(mid => unitSelectionToTargetRef({ messageId: mid, selection: { kind: "whole" } }, msgMap));
      try {
        const backendRel = await api.createRelation(topicId!, { relationType: 'SUPPLEMENT', sourceMessageId: null, targetRefs });
        const relId = backendRel.id;
        const typeName = relationTypeName("supplement");
        appendCreatedRelation(backendRel);
        const anonSrcId = `anon:${backendRel.id}`;
        for (const tgtMid of allTargetMids) {
          newEdgesList.push({
            id: nextId("edge"), relationMessageId: relId, relationType: "supplement",
            from: { messageId: anonSrcId, selection: { kind: "whole" } },
            to: { messageId: tgtMid, selection: { kind: "whole" } },
            relationLabel: typeName,
          } as DemoEdge);
        }
      } catch (e: any) { alert(`建立补充关系失败: ${e?.message ?? e}`); }
      setEdges(prev => [...prev, ...newEdgesList]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // CLASSIFY relation: user-to-message relation with no source message.
    // Targets can be text messages and/or classify relation messages, and can be empty.
    if (relationType === "classify") {
      const targetTextIds = getGroupedTargetTextMessageIds(effectiveTargets);
      if (hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds)) {
        alert("分类目标与已分类消息存在非引用关联，无法建立分类关系");
        return;
      }
      const selectedSet = new Set(targetTextIds);
      const supplementTargetsByRelMsg = new Map<string, string[]>();
      for (const e of edges) {
        if (e.relationType !== "supplement") continue;
        if (msgMap.get(e.to.messageId)?.kind !== "normal") continue;
        const arr = supplementTargetsByRelMsg.get(e.relationMessageId) ?? [];
        arr.push(e.to.messageId);
        supplementTargetsByRelMsg.set(e.relationMessageId, arr);
      }
      for (const [, mids] of supplementTargetsByRelMsg) {
        const uniqueMids = Array.from(new Set(mids));
        if (uniqueMids.length <= 1) continue;
        const selectedCount = uniqueMids.filter(mid => selectedSet.has(mid)).length;
        if (selectedCount > 0 && selectedCount < uniqueMids.length) {
          alert(`同一条补充关系关联了 ${uniqueMids.length} 条文本消息，分类前需全部选中`);
          return;
        }
      }
      const classifyTitle = newMessageContent.trim();
      if (!classifyTitle) {
        alert("话题名称不能为空");
        return;
      }
      const targetRefs = getClassifyTargetRefs(effectiveTargets);
      try {
        const backendRel = await api.createRelation(topicId!, {
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs,
          payload: buildRelationPayload({ relationType: 'CLASSIFY', title: classifyTitle }),
        });
        const relId = backendRel.id;
        appendCreatedRelation(backendRel);
        const anonSrcId = `anon:${backendRel.id}`;
        const edgeTargetIds = Array.from(new Set(
          targetRefs.map(ref => ref.kind === "relation" ? ref.relationId : ref.messageId)
        ));
        const newEdges = edgeTargetIds.map(targetMid => ({
          id: nextId("edge"),
          relationMessageId: relId,
          relationType: "classify" as RelationType,
          from: { messageId: anonSrcId, selection: { kind: "whole" as const } },
          to: { messageId: targetMid, selection: { kind: "whole" as const } },
          relationLabel: relationTypeName("classify"),
        }));
        setEdges(prev => [...prev, ...newEdges]);
      } catch (e: any) {
        alert(`建立关系失败: ${e?.message ?? e}`);
        return;
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // SUMMARY relation: user-to-message relation, like CLASSIFY but with multi-column layout.
    // Requires both non-empty targets and non-empty title text.
    if (relationType === "summary") {
      const summaryTitle = newMessageContent.trim();
      if (!summaryTitle) {
        alert("总结内容不能为空");
        return;
      }
      const targetTextIds = getGroupedTargetTextMessageIds(effectiveTargets);
      if (hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds)) {
        alert("总结目标与已分类消息存在非引用关联，无法建立总结关系");
        return;
      }
      const summaryTargetRefs = getClassifyTargetRefs(effectiveTargets);
      if (summaryTargetRefs.length === 0) {
        alert("总结关系至少需要一个目标消息");
        return;
      }
      try {
        const backendRel = await api.createRelation(topicId!, {
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: summaryTargetRefs,
          payload: buildRelationPayload({ relationType: 'SUMMARY', title: summaryTitle, targetLayout: 'multi-column' }),
        });
        const relId = backendRel.id;
        appendCreatedRelation(backendRel);
        const anonSrcId = `anon:${backendRel.id}`;
        const edgeTargetIds = Array.from(new Set(
          summaryTargetRefs.map(ref => ref.kind === "relation" ? ref.relationId : ref.messageId)
        ));
        const newEdges = edgeTargetIds.map(targetMid => ({
          id: nextId("edge"),
          relationMessageId: relId,
          relationType: "summary" as RelationType,
          from: { messageId: anonSrcId, selection: { kind: "whole" as const } },
          to: { messageId: targetMid, selection: { kind: "whole" as const } },
          relationLabel: relationTypeName("summary"),
        }));
        setEdges(prev => [...prev, ...newEdges]);
      } catch (e: any) {
        alert(`建立总结关系失败: ${e?.message ?? e}`);
        return;
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // MERGE relation: user-to-message relation with no source message.
    // Targets may be text messages or relation messages; fragments are folded up to whole targets.
    // If text is present, create a standalone text message first — it appears outside the merge frame.
    if (relationType === "merge") {
      // Create a standalone text message if text is present (outside the merge frame).
      if (text.length > 0) {
        const msg = await handleSendMessageOnly(text);
        if (!msg) return; // message creation failed, keep UI state for retry
        // The new message is NOT added to merge targets — it stays outside the frame.
      }

      const mergeTargetTextIds = getGroupedTargetTextMessageIds(effectiveTargets);
      if (hasCrossNonReferenceTextLinkForClassifyTargets(mergeTargetTextIds)) {
        alert("归并目标与已分类消息存在非引用关联，无法建立归并关系");
        return;
      }
      const mergeTargetRefs = Array.from(new Map(
        foldUpToWhole(effectiveTargets).map(u => {
          const ref = unitSelectionToTargetRef(u, msgMap);
          return [targetRefDisplayId(ref), ref] as const;
        })
      ).values());
      if (mergeTargetRefs.length === 0) {
        alert("归并关系至少需要一个文本消息或关系消息作为目标");
        return;
      }
      try {
        const backendRel = await api.createRelation(topicId!, {
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: mergeTargetRefs,
          payload: buildRelationPayload({ relationType: 'MERGE', targetLayout: 'multi-column' }),
        });
        const relId = backendRel.id;
        appendCreatedRelation(backendRel);
        const virtualFrameNodeId = `anon:${backendRel.id}`;
        const newEdges = mergeTargetRefs.map(targetRef => ({
          id: nextId("edge"),
          relationMessageId: relId,
          relationType: "merge" as RelationType,
          from: { messageId: virtualFrameNodeId, selection: { kind: "whole" as const } },
          to: targetRef.kind === "relation"
            ? { messageId: targetRef.relationId, selection: { kind: "whole" as const } }
            : { messageId: targetRef.messageId, selection: { kind: "whole" as const } },
          relationLabel: relationTypeName("merge"),
        }));
        setEdges(prev => [...prev, ...newEdges]);
      } catch (e: any) {
        alert(`建立归并关系失败: ${e?.message ?? e}`);
        return;
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    if (text.length === 0) return;
    const labelDefault = relationTypeName(relationType);
    const label = relationLabel.trim() || labelDefault;

    // CORRECT relation: auto-generate the new message content by applying the replacement
    // (text box content) to the selected fragment(s) or whole of the target message.
    if (relationType === "correct") {
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      if (uniqueTargetMids.length !== 1) {
        alert("更正关系目前仅支持单个目标消息");
        return;
      }
      const rawTargetMid = uniqueTargetMids[0];

      // Resolve correction chain: if the target is itself a correction source
      // (i.e., it corrects another message), find the ultimate ancestor so the
      // new CORRECT points directly to the origin, avoiding orphaned intermediate
      // correction messages (Bug 4 fix: chain corrections).
      let ancestorTargetMid = rawTargetMid;
      const visited = new Set<string>();
      while (true) {
        if (visited.has(ancestorTargetMid)) break; // cycle guard
        visited.add(ancestorTargetMid);
        const parentEdge = edges.find(e =>
          e.relationType === 'correct' &&
          e.from.messageId === ancestorTargetMid &&
          !e.from.messageId.startsWith('anon:') &&
          msgMap.get(e.to.messageId)?.kind === 'normal'
        );
        if (!parentEdge) break;
        ancestorTargetMid = parentEdge.to.messageId;
      }

      // Build effective targets pointing to the ancestor
      const resolvedTargets: UnitSelection[] = ancestorTargetMid === rawTargetMid
        ? effectiveTargets
        : effectiveTargets.map(u => ({ ...u, messageId: ancestorTargetMid }));

      const generated = generateCorrectionContent(resolvedTargets, text, msgMap);
      if (generated === null) {
        alert("更正关系目标必须是普通文本消息");
        return;
      }
      const msg = await handleSendMessageOnly(generated);
      if (!msg) return;
      const sources: UnitSelection[] = [{ messageId: msg.id, selection: { kind: "whole" } }];
      await handleCreateRelationWithSourcesAndTargets({ sources, targets: resolvedTargets, label });
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // TAG relation: do NOT create a text message. Store the label as tagLabel on the relation,
    // making it a pure user-to-message relation without a source text message.
    if (relationType === "tag") {
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      const tagLabel = text;
      const newTagEdges: DemoEdge[] = [];
      for (const tgtMid of uniqueTargetMids) {
        const edge = await sendTagRelation(tgtMid, tagLabel);
        if (edge) newTagEdges.push(edge);
      }
      setEdges(prev => [...prev, ...newTagEdges]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    const msg = await handleSendMessageOnly(text);
    if (!msg) return;
    const sources: UnitSelection[] = [{ messageId: msg.id, selection: { kind: "whole" } }];
    const targets: UnitSelection[] = [...effectiveTargets];
    await handleCreateRelationWithSourcesAndTargets({ sources, targets, label });
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
    setNewMessageContent("");
    setRelationType(null); setSecondaryRelationType("none");
  }

  type DraftGroup = { messageId: string; wholeSelected: boolean; fragments: UnitSelection[] };
  const draftGroups: DraftGroup[] = useMemo(() => {
    const map = new Map<string, DraftGroup>();
    for (const u of draftUnits) {
      const g = map.get(u.messageId) || ({ messageId: u.messageId, wholeSelected: false, fragments: [] } as DraftGroup);
      if (u.selection.kind === "whole") g.wholeSelected = true; else g.fragments.push(u);
      map.set(u.messageId, g);
    }
    return Array.from(map.values());
  }, [draftUnits]);

  const prevDraftCountRef = useRef<number>(draftUnits.length);
  useEffect(() => {
    const prev = prevDraftCountRef.current; const cur = draftUnits.length;
    if (prev > 0 && cur === 0 && activeTextSelectId !== null) setActiveTextSelectId(null);
    prevDraftCountRef.current = cur;
  }, [draftUnits, activeTextSelectId]);

  // Bug 3: scroll to center focused message when entering focus mode
  useEffect(() => {
    const newLen = focusEntries.length;
    if (newLen <= prevFocusLenRef.current) { prevFocusLenRef.current = newLen; return; }
    prevFocusLenRef.current = newLen;
    if (viewMode !== "graph") return;
    const entry = focusEntries[newLen - 1];
    if (!entry || entry.ids.length === 0) return;
    const focusId = entry.ids[0];
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRaf2Ref.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        scrollRaf2Ref.current = null;
        const container = leftPanelRef.current;
        if (!container) return;
        const el = container.querySelector(`[data-msgid="${focusId}"]`) as HTMLElement | null;
        if (!el) return;
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
        const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
        container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
        container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
      });
    });
  }, [focusEntries, viewMode]);

  // Restore saved scroll position after view mode switch so switching does not auto-scroll to top.
  useEffect(() => {
    const saved = viewModeScrollRef.current[viewMode];
    if (saved !== null) {
      viewModeScrollRef.current[viewMode] = null;
      cancelScrollRafs();
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRaf2Ref.current = requestAnimationFrame(() => {
          scrollRafRef.current = null;
          scrollRaf2Ref.current = null;
          clampAndSetScroll(leftPanelRef.current, saved.top, saved.left);
        });
      });
    }
  }, [viewMode]);

  function getSelectedWholeMessageIds(): string[] {
    const ids = draftUnits.filter(u => u.selection.kind === "whole").map(u => u.messageId);
    return Array.from(new Set(ids));
  }

  const recentRelations = useMemo(() => messages.filter(m => m.kind === "relation").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5), [messages]);
  const recentNormals = useMemo(() => messages.filter(m => m.kind === "normal").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8), [messages]);

  const isAgreeDisagreeType = relationType === "agree" || relationType === "disagree";
  const isSupplementType = relationType === "supplement";
  const isClassifyType = relationType === "classify";
  const isMergeType = relationType === "merge";
  const isSummaryType = relationType === "summary";
  // TAG + secondary = recommend/archive acts as an inline badge (no text needed)
  const isTagWithQuickAnnotate = relationType === "tag" && secondaryRelationType !== "none";
  const isTagWithInlineBadge = relationType === "tag" && (secondaryRelationType === "recommend" || secondaryRelationType === "archive");

  // Whether any draft unit points to a relation message (vs. text message or fragment)
  const draftHasRelationTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation');
  const hasTargetsAvailable = draftUnits.length > 0 || targetUnits.length > 0;
  const composerRefreshKey = `${relationType ?? "plain"}::${secondaryRelationType}::${draftUnits.length === 0 ? "draft-empty" : "draft-has"}::${targetUnits.length === 0 ? "target-empty" : "target-has"}::${sourceUnits.length === 0 ? "source-empty" : "source-has"}::${draftHasRelationTarget ? "draft-rel" : "draft-text"}`;

  // Additional relation selector:
  // - REPLY: always available (none/question/answer)
  // - CORRECT: only when targeting relation messages
  // - TAG: always available (none/recommend/archive/existing-tag shortcuts)
  const hasSecondaryRelationSelector =
    relationType === "reply"
    || (relationType === "correct" && draftHasRelationTarget)
    || relationType === "tag";

  // Send button enabled logic (single button):
  //   - No relation type: just send message → need text
  //   - Relation target + reply/correct with secondary selector: text must be empty, source must be empty
  //   - agree/disagree/supplement (pure-stance): draft or target collection not empty
  //   - sourceUnits + targetUnits explicitly set (draft empty): can build relation without new text
  //   - Other types: (draft or target collection) not empty AND text not empty
  // Note: draftUnits (候选区) is a quick substitute for targetUnits (目标集合).
  // If draftUnits is non-empty it takes precedence; otherwise targetUnits is used.
  const singleButtonEnabled = (() => {
    if (relationType === null) return newMessageContent.trim().length > 0;
    // CORRECT targeting a relation message: special mode (no text, no source, use secondary selector)
    if (draftHasRelationTarget && relationType === "correct") {
      return draftUnits.length > 0 && newMessageContent.trim().length === 0 && sourceUnits.length === 0;
    }
    if (isClassifyType) return newMessageContent.trim().length > 0;
    if (isSummaryType) return hasTargetsAvailable && newMessageContent.trim().length > 0;
    if (isMergeType) return hasTargetsAvailable && sourceUnits.length === 0 && newMessageContent.trim().length === 0;
    // TAG with any non-none secondary (recommend/archive/existing-tag) needs only targets, no text
    if (isAgreeDisagreeType || isSupplementType || isTagWithQuickAnnotate) return hasTargetsAvailable;
    // sourceUnits + targetUnits explicitly committed (no draft): relation can be built without new text
    if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) return true;
    return hasTargetsAvailable && newMessageContent.trim().length > 0;
  })();

  // Dynamic label describing what the send button will do
  const singleButtonLabel = (() => {
    if (relationType === null) {
      if (newMessageContent.trim().length === 0) return "请输入消息内容后发送";
      return "仅发送这条消息（未选择关系类型）";
    }
    const typeName = relationTypeName(relationType);
    if (draftHasRelationTarget && relationType === "correct") {
      if (newMessageContent.trim().length > 0) return `请清空文本输入框（更正关系目标为关系消息时不应有文本）`;
      if (sourceUnits.length > 0) return `请清空来源集合（更正关系目标为关系消息时来源必须为空）`;
      const secLabel = secondaryRelationType === "none" ? "无" : relationTypeName(secondaryRelationType as RelationType);
      return `建立「${typeName}」关系（目标为关系消息，附加：${secLabel}）`;
    }
    const usingDraft = draftUnits.length > 0;
    if (isClassifyType) {
      const targetCount = getClassifyTargetRefs(usingDraft ? draftUnits : targetUnits).length;
      if (targetCount === 0) return "建立分类话题（无目标）";
      return `建立分类话题（${targetCount} 个${CLASSIFY_TARGET_HINT}目标）`;
    }
    if (isSummaryType) {
      const targetCount = getClassifyTargetRefs(usingDraft ? draftUnits : targetUnits).length;
      if (!hasTargetsAvailable) return "请在画布中选择要总结的目标消息";
      if (newMessageContent.trim().length === 0) return "请输入总结内容（不能为空）";
      return `建立总结关系（${targetCount} 个目标）`;
    }
    if (isMergeType) {
      if (sourceUnits.length > 0) return "归并关系不需要来源消息，请清空来源集合";
      if (!hasTargetsAvailable) return "请在画布中选择要归并的目标消息";
      if (newMessageContent.trim().length > 0) return "归并关系不需要输入文本消息";
      return `建立归并关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    if (isAgreeDisagreeType) {
      if (!hasTargetsAvailable) return "请在画布中选择目标消息";
      return newMessageContent.trim().length > 0
        ? `发送消息并建立「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标）`
        : `建立纯立场「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    if (isSupplementType) {
      if (!hasTargetsAvailable) return "请在画布中选择目标消息";
      return newMessageContent.trim().length > 0
        ? `发送消息并建立「${typeName}」关系（文本消息加入补充框架）`
        : `建立「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    // TAG + secondary = recommend/archive: quick inline-badge shortcut
    if (isTagWithInlineBadge) {
      if (!hasTargetsAvailable) return "请在画布中选择目标消息";
      const secName = relationTypeName(secondaryRelationType as RelationType);
      return `建立「${secName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    // TAG + secondary = existing tag label: quick re-annotation shortcut
    if (isTagWithQuickAnnotate) {
      if (!hasTargetsAvailable) return "请在画布中选择目标消息";
      return `快速标注「${secondaryRelationType}」（用${usingDraft ? "候选" : "目标集合"}作目标）`;
    }
    if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) {
      return `建立「${typeName}」关系（来源集合 → 目标集合）`;
    }
    if (!hasTargetsAvailable) return "请在画布中选择目标消息";
    if (newMessageContent.trim().length === 0) return "请输入消息内容（将作为来源）";
    return `发送消息并建立「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标）`;
  })();

  // Secondary relation options for CORRECT type: relations of the same PresentationKind as the targeted relation message, plus "none".
  const correctSecondaryOptions = useMemo((): string[] => {
    if (relationType !== 'correct') return ['none'];
    const allUnits = [...draftUnits, ...targetUnits];
    const targetRelMsgId = allUnits.find(u => msgMap.get(u.messageId)?.kind === 'relation')?.messageId;
    if (!targetRelMsgId) return ['none'];
    const relEdgesForTarget = edges.filter(e => e.relationMessageId === targetRelMsgId);
    if (relEdgesForTarget.length === 0) return ['none'];
    // All edges sharing the same relationMessageId are created from the same Relation record
    // and therefore have identical relationType. Using the first edge is sufficient.
    const targetRelType = relEdgesForTarget[0].relationType;
    const targetSpec = getPresentationSpec(targetRelType);
    const sameKindTypes = ALL_RELATION_TYPES.filter(rt => getPresentationSpec(rt).kind === targetSpec.kind && rt !== targetRelType);
    return ['none', ...sameKindTypes];
  }, [relationType, draftUnits, targetUnits, edges, msgMap]);

  // Secondary relation options for TAG type: none, recommend, archive, plus existing tags on target messages.
  const tagSecondaryOptions = useMemo((): string[] => {
    if (relationType !== 'tag') return ['none'];
    const allUnits = [...draftUnits, ...targetUnits];
    const targetMids = Array.from(new Set(allUnits.map(u => u.messageId)));
    const existingTagLabels = new Set<string>();
    for (const mid of targetMids) {
      for (const e of edges) {
        if (e.relationType === 'tag' && e.to.messageId === mid && e.to.selection.kind === 'whole') {
          const label = isValidTagLabel(e.relationLabel) ? e.relationLabel : null;
          if (label) existingTagLabels.add(label.slice(0, MAX_TAG_LABEL_DISPLAY_LENGTH));
        }
      }
    }
    return ['none', 'recommend', 'archive', ...Array.from(existingTagLabels)];
  }, [relationType, draftUnits, targetUnits, edges]);

  function renderMessageContentWithAnchorsForList(message: DemoMessage) {
    const targets = extractTextTargetsForMessage(message.id, edges);
    if (targets.length === 0) return <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{message.content}</pre>;
    const text = message.content;
    const validItems = targets
      .filter(t => t.start >= 0 && t.start + t.len <= text.length && t.len > 0)
      .map(t => ({ start: t.start, end: t.start + t.len, relationType: t.relationType, edgeId: t.edgeId }));
    const tree = buildAnnoTree(validItems);
    const nodes = renderAnnoNodes(text, tree, 0, text.length, 0, message.id, isFragmentSelected, handleFragmentAnchorClick);
    return <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{nodes}</pre>;
  }

  const { messagesToShow, edgesToShow } = useMemo(() => {
    if (focusEntries.length === 0) return { messagesToShow: messages, edgesToShow: edges };
    const startIds = focusEntries[focusEntries.length - 1].ids.filter(Boolean);
    if (startIds.length === 0) return { messagesToShow: messages, edgesToShow: edges };
    const adj = new Map<string, Set<string>>();
    function addEdgeAdj(a: string, b: string) {
      if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b); adj.get(b)!.add(a);
    }
    for (const e of edges) {
      // Only add a direct from↔to hop if at least one endpoint is a normal text message.
      // Relation-to-relation connections (e.g. a CORRECT relation linking two relation messages)
      // should not count as focus-distance hops.
      const fromIsNormal = msgMap.get(e.from.messageId)?.kind === "normal";
      const toIsNormal = msgMap.get(e.to.messageId)?.kind === "normal";
      if (fromIsNormal || toIsNormal) addEdgeAdj(e.from.messageId, e.to.messageId);
      // Connect the relation message to both endpoints so BFS can traverse through
      // relation messages (including those with anon: sources).  Skip anon: IDs
      // since they are not real messages and should not appear as BFS nodes.
      const fromId = e.from.messageId;
      const toId = e.to.messageId;
      if (!fromId.startsWith('anon:')) addEdgeAdj(e.relationMessageId, fromId);
      if (!toId.startsWith('anon:')) addEdgeAdj(e.relationMessageId, toId);
    }
    // When a relation message is the focus, resolve it to its connected normal (text)
    // messages and use those as BFS roots.  This preserves the original hop semantics:
    //   1 hop = one relation message connecting two text messages.
    // Distance is measured TEXT-MESSAGE to TEXT-MESSAGE through relation messages.
    // The relation message itself does NOT act as a BFS node — it is the connector.
    //
    // The relation edges are always shown when their text-message endpoints are visible
    // (ensured by the edge filter below with relationFocusIds / focusRelationMsgIds guards).
    //
    // This way:
    //   hop=0 → text messages directly connected to the focused relation
    //   hop=1 → those text messages + their 1-hop neighbours through other relations
    const effectiveStartIds = new Set<string>();
    const relationFocusIds = new Set<string>();
    function collectNormalMessagesForRelation(relId: string, seen: Set<string>): void {
      if (seen.has(relId)) return;
      seen.add(relId);
      for (const e of edges) {
        if (e.relationMessageId !== relId) continue;
        const mf = msgMap.get(e.from.messageId);
        if (mf?.kind === "normal") effectiveStartIds.add(e.from.messageId);
        else if (mf?.kind === "relation") collectNormalMessagesForRelation(e.from.messageId, seen);
        const mt = msgMap.get(e.to.messageId);
        if (mt?.kind === "normal") effectiveStartIds.add(e.to.messageId);
        else if (mt?.kind === "relation") collectNormalMessagesForRelation(e.to.messageId, seen);
      }
    }
    for (const id of startIds) {
      const m = msgMap.get(id);
      if (m && m.kind === "relation") {
        relationFocusIds.add(id);
        const sizeBefore = effectiveStartIds.size;
        collectNormalMessagesForRelation(id, new Set<string>());
        // Fallback: relation has no connected normal messages (e.g. pure-stance
        // with anon source).  Keep the relation message itself as BFS root so
        // focus mode still shows something.
        if (effectiveStartIds.size === sizeBefore) effectiveStartIds.add(id);
      } else {
        effectiveStartIds.add(id);
      }
    }
    const dist = new Map<string, number>(); const q: string[] = [];
    for (const id of Array.from(effectiveStartIds)) { if (!dist.has(id)) { dist.set(id, 0); q.push(id); } }
    while (q.length > 0) {
      const cur = q.shift()!; const d = dist.get(cur)!;
      if (d >= focusHop) continue;
      const neighbors = adj.get(cur); if (!neighbors) continue;
      for (const nb of neighbors) { if (!dist.has(nb)) { dist.set(nb, d + 1); q.push(nb); } }
    }
    const messagesToShowArr = messages.filter(m => dist.has(m.id));
    const shownIds = new Set(messagesToShowArr.map(m => m.id));
    const relationMessagesToAdd = new Set<string>();
    for (const e of edges) {
      if (shownIds.has(e.from.messageId) || shownIds.has(e.to.messageId)) relationMessagesToAdd.add(e.relationMessageId);
    }
    const relationMsgsAdded = new Set<string>();
    for (const rmId of relationMessagesToAdd) {
      if (!shownIds.has(rmId)) { const m = messages.find(x => x.id === rmId); if (m) { messagesToShowArr.push(m); relationMsgsAdded.add(rmId); } }
    }
    // Always ensure the original focus-entry IDs are in messagesToShow.
    // When a startId is a classify relation message, collectNormalMessagesForRelation resolves
    // through it to normal message targets; the classify message itself may not appear via
    // BFS dist or the relation-adjacency step above (if its edges point to other relations,
    // not directly to text messages).
    for (const id of startIds) {
      if (!shownIds.has(id) && !relationMsgsAdded.has(id)) {
        const m = msgMap.get(id);
        if (m) messagesToShowArr.push(m);
      }
    }
    const shownSet = new Set(messagesToShowArr.map(m => m.id));
    // An edge is visible when its relationMessageId is in shownSet AND at least one
    // of its endpoints is either in shownSet or is an anon: placeholder.
    // Additionally, edges belonging to a directly-focused relation message are always
    // shown so that the relation structure is fully visible even at hop=0
    // (Bug fix: focus mode relation message visibility).
    const edgesToShowArr = edges.filter(e => {
      if (!shownSet.has(e.relationMessageId)) return false;
      // Always show all edges of a directly-focused relation message
      if (relationFocusIds.has(e.relationMessageId)) return true;
      const fromOk = shownSet.has(e.from.messageId) || e.from.messageId.startsWith('anon:');
      const toOk = shownSet.has(e.to.messageId);
      return fromOk || toOk;
    });
    return { messagesToShow: messagesToShowArr, edgesToShow: edgesToShowArr };
  }, [messages, edges, focusEntries, focusHop, msgMap]);

  const canSetFocus = (!!lastClickedMessageId && messages.some(m => m.id === lastClickedMessageId)) || getSelectedWholeMessageIds().length > 0;
  const canExitFocus = focusEntries.length > 0;
  const isTopicFocus = currentFocusEntry?.mode === "topic";
  const topicFocusRelMsgId = currentFocusEntry?.mode === "topic" ? currentFocusEntry.topicRelMsgId ?? null : null;

  // Set of relation-message IDs that are directly in the current focus set.
  // Used to ensure that edges of focused relations are always visible regardless
  // of endpoint checks (fix: REFERENCE edge not showing when relation is focused).
  const focusRelationMsgIds = useMemo(() => {
    if (focusEntries.length === 0) return new Set<string>();
    const ids = new Set<string>();
    for (const id of focusEntries[focusEntries.length - 1].ids) {
      if (msgMap.get(id)?.kind === 'relation') ids.add(id);
    }
    return ids;
  }, [focusEntries, msgMap]);
  const topicFocusTargetCount = useMemo(
    () => topicFocusRelMsgId ? collectOwnedByRelation(topicFocusRelMsgId, relationById).textIds.size : 0,
    [topicFocusRelMsgId, relationById]
  );
  const topicFocusRelMsg = useMemo(
    () => topicFocusRelMsgId ? msgMap.get(topicFocusRelMsgId) : null,
    [topicFocusRelMsgId, msgMap]
  );
  const topicFocusRelType = useMemo(
    () => {
      if (topicFocusRelMsg?.relationType === "summary") return "summary";
      if (topicFocusRelMsg?.relationType === "classify") return "classify";
      return null;
    },
    [topicFocusRelMsg]
  );
  const topicFocusKindLabel = topicFocusRelType === "summary" ? "总结" : topicFocusRelType === "classify" ? "分类" : "话题";
  const topicFocusExitLabel = topicFocusRelType === "summary" ? "退出总结" : topicFocusRelType === "classify" ? "退出分类" : "退出话题";
  const topicFocusTitle = topicFocusRelMsg
    ? (getRelationTitle(topicFocusRelMsg.relationPayload) || `${topicFocusKindLabel}（${topicFocusTargetCount}）`)
    : "";
  const { graphMessagesToRender, graphEdgesToRender, listMessagesToRender, listEdgesToRender } = useMemo(() => {
    const useFocusWindow = focusEntries.length > 0 && !isTopicFocus;
    const baseMessages = useFocusWindow ? messagesToShow : messages;
    const baseEdges = useFocusWindow ? edgesToShow : edges;
    if (isTopicFocus && topicFocusRelMsgId) {
      const topicRelation = relationById.get(topicFocusRelMsgId);
      const topicTextIds = new Set<string>();
      const topicRelationIds = new Set<string>();
      if (topicRelation) {
        getTextTargetIds(topicRelation.targetRefs).forEach(id => topicTextIds.add(id));
        getRelationTargetIds(topicRelation.targetRefs).forEach(id => topicRelationIds.add(id));
        const queue = Array.from(topicRelationIds);
        const visited = new Set<string>();
        while (queue.length > 0) {
          const relId = queue.shift();
          if (!relId || visited.has(relId)) continue;
          visited.add(relId);
          const rel = relationById.get(relId);
          if (!rel) continue;
          const relType = rel.relationType.toUpperCase();
          if (relType !== 'CLASSIFY' && relType !== 'MERGE' && relType !== 'SUPPLEMENT' && relType !== 'SUMMARY') continue;
          // Include the source message of nested relations (not applicable to SUPPLEMENT/CLASSIFY/MERGE/SUMMARY
          // which are user-to-message relations with no sourceMessageId, but may apply to other relation
          // types that appear as nested targets via future extensions).
          if (rel.sourceMessageId) {
            const srcId = rel.sourceMessageId;
            if (!topicTextIds.has(srcId) && !topicRelationIds.has(srcId)) {
              const srcMsg = msgMap.get(srcId);
              if (srcMsg?.kind === 'normal') {
                topicTextIds.add(srcId);
              } else if (srcMsg?.kind === 'relation') {
                topicRelationIds.add(srcId);
                queue.push(srcId);
              }
            }
          }
          if (relType === 'SUPPLEMENT' || relType === 'MERGE') {
            // SUPPLEMENT and MERGE are framing relations: all content (text targets and
            // nested framing relations) is expanded inline. CLASSIFY and SUMMARY targets
            // are shown as topic cards but not recursively expanded (user must double-click
            // to enter them).
            getTextTargetIds(rel.targetRefs).forEach(id => topicTextIds.add(id));
            getRelationTargetIds(rel.targetRefs).forEach(id => {
              topicRelationIds.add(id);
              const childRelType = relationById.get(id)?.relationType?.toUpperCase();
              if ((childRelType === 'SUPPLEMENT' || childRelType === 'MERGE') && !visited.has(id)) {
                queue.push(id);
              }
              // CLASSIFY and SUMMARY targets are shown as topic cards but not recursively expanded.
            });
          } else {
            // CLASSIFY and SUMMARY: these are opaque topic cards — they are already in
            // topicRelationIds (added when first encountered as targets), and GraphView
            // will render them as cards. Do NOT recursively expand their internal content
            // into the current view; the user must double-click to enter them.
          }
        }
      }
      // Expand topicTextIds with text messages that have CORRECT (更正) relations
      // with any text message already in the topic, and add the CORRECT relation
      // messages between such pairs to topicRelationIds.
      // This implements: when T1 is in the topic, CORRECT-related T2 and the
      // CORRECT relation message are automatically included in the topic view.
      {
        const correctQ = Array.from(topicTextIds);
        const correctVisited = new Set<string>();
        while (correctQ.length > 0) {
          const tid = correctQ.shift()!;
          if (correctVisited.has(tid)) continue;
          correctVisited.add(tid);
          for (const e of baseEdges) {
            if (e.relationType !== 'correct') continue;
            if (msgMap.get(e.from.messageId)?.kind !== 'normal' || msgMap.get(e.to.messageId)?.kind !== 'normal') continue;
            if (e.from.messageId !== tid && e.to.messageId !== tid) continue;
            topicRelationIds.add(e.relationMessageId);
            const other = e.from.messageId === tid ? e.to.messageId : e.from.messageId;
            if (!topicTextIds.has(other)) {
              topicTextIds.add(other);
              correctQ.push(other);
            }
          }
        }
      }
      const edgesByRel = new Map<string, DemoEdge[]>();
      for (const e of baseEdges) {
        const arr = edgesByRel.get(e.relationMessageId) ?? [];
        arr.push(e);
        edgesByRel.set(e.relationMessageId, arr);
      }
      for (const [relMsgId, relEdges] of edgesByRel) {
        if (relMsgId === topicFocusRelMsgId || topicRelationIds.has(relMsgId)) continue;
        const textEndpoints = relEdges
          .flatMap(e => [e.from.messageId, e.to.messageId])
          .filter(mid => msgMap.get(mid)?.kind === 'normal');
        if (textEndpoints.length > 0 && textEndpoints.every(mid => topicTextIds.has(mid))) {
          topicRelationIds.add(relMsgId);
        }
      }
      const visibleIds = new Set<string>([...topicTextIds, ...topicRelationIds]);
      const topicMessages = baseMessages.filter(m => visibleIds.has(m.id));
      const topicEdges = baseEdges.filter(e =>
        visibleIds.has(e.relationMessageId) &&
        (e.from.messageId.startsWith("anon:") || visibleIds.has(e.from.messageId)) &&
        visibleIds.has(e.to.messageId)
      );
      return {
        graphMessagesToRender: topicMessages,
        graphEdgesToRender: topicEdges,
        listMessagesToRender: topicMessages,
        listEdgesToRender: topicEdges,
      };
    }

    // listHiddenRelationIds: relation messages to hide in the linear list view.
    // CLASSIFY and SUMMARY relation messages that are owned by CLASSIFY are hidden (they are
    // the classification containers and are shown in the graph view as topic cards).
    // MERGE owned by CLASSIFY is also hidden (intermediate grouping structure).
    // SUPPLEMENT owned by CLASSIFY is unconditionally hidden — its text messages are already
    // classified, and the SUPPLEMENT container itself should not appear in the main view.
    // SUPPLEMENT NOT owned by CLASSIFY is only hidden when ALL its text endpoints
    // are classified (via listExclusiveRelMsgIds).
    const listHiddenRelationIds = new Set<string>([
      ...classifiedTargetClassifyRelMsgIds,
      ...classifiedTargetMergeRelMsgIds,
      ...classifiedTargetSummaryRelMsgIds,
      ...classifiedTargetSupplementRelMsgIds,
      ...listExclusiveRelMsgIds,
      ...replacedRelationMsgIds,
    ]);
    const listMessages = baseMessages.filter(m => {
      if (m.kind === "normal" && classifiedTargetTextIds.has(m.id)) return false;
      if (m.kind === "relation" && listHiddenRelationIds.has(m.id)) return false;
      return true;
    });
    const listVisibleIds = new Set(listMessages.map(m => m.id));
    // Edge is visible in list view when the relation message is visible AND
    // the edge does not connect to a classified (hidden) text endpoint.
    // Edges of directly-focused relation messages are always included
    // so the relation structure is fully visible (fix: REFERENCE edge focus).
    const listEdges = baseEdges.filter(e => {
      if (!listVisibleIds.has(e.relationMessageId) && !focusRelationMsgIds.has(e.relationMessageId)) return false;
      // Edges of focused relations: always visible
      if (focusRelationMsgIds.has(e.relationMessageId)) return true;
      const fromOk = e.from.messageId.startsWith('anon:') || listVisibleIds.has(e.from.messageId);
      const toOk = listVisibleIds.has(e.to.messageId);
      return fromOk && toOk;
    });

    // graphHiddenRelationIds: relation messages to hide in the non-linear graph view.
    // Unconditionally hide CLASSIFY-owned CLASSIFY/SUMMARY/MERGE/SUPPLEMENT containers and replaced relations.
    // SUPPLEMENT owned by CLASSIFY is unconditionally hidden — its text messages are already
    // classified via collectOwnedByRelation, and the SUPPLEMENT container should not appear.
    // SUPPLEMENT NOT owned by CLASSIFY is only hidden when ALL its text endpoints
    // are in the hidden set (via graphExclusiveRelMsgIds).
    const graphHiddenRelationIds = new Set<string>([
      ...classifiedTargetClassifyRelMsgIds,
      ...classifiedTargetMergeRelMsgIds,
      ...classifiedTargetSummaryRelMsgIds,
      ...classifiedTargetSupplementRelMsgIds,
      ...summaryOwnership.relationIds,
      ...graphExclusiveRelMsgIds,
      ...replacedRelationMsgIds,
    ]);
    const graphMessages = baseMessages.filter(m => {
      if (m.kind === "normal" && graphHiddenTextIds.has(m.id)) return false;
      if (m.kind === "relation" && graphHiddenRelationIds.has(m.id)) return false;
      return true;
    });
    const graphVisibleIds = new Set(graphMessages.map(m => m.id));
    // Edge is visible in graph view when the relation message is visible AND
    // the edge does not connect to a classified (hidden) text endpoint.
    // Edges of directly-focused relation messages are always included
    // so the relation structure is fully visible (fix: REFERENCE edge focus).
    const graphEdges = baseEdges.filter(e => {
      if (!graphVisibleIds.has(e.relationMessageId) && !focusRelationMsgIds.has(e.relationMessageId)) return false;
      // Edges of focused relations: always visible
      if (focusRelationMsgIds.has(e.relationMessageId)) return true;
      const fromOk = e.from.messageId.startsWith('anon:') || graphVisibleIds.has(e.from.messageId);
      const toOk = graphVisibleIds.has(e.to.messageId);
      return fromOk && toOk;
    });
    return {
      graphMessagesToRender: graphMessages,
      graphEdgesToRender: graphEdges,
      listMessagesToRender: listMessages,
      listEdgesToRender: listEdges,
    };
  }, [messages, edges, relationById, messagesToShow, edgesToShow, focusEntries, isTopicFocus, topicFocusRelMsgId, msgMap, classifiedTargetTextIds, classifiedTargetClassifyRelMsgIds, classifiedTargetMergeRelMsgIds, classifiedTargetSupplementRelMsgIds, classifiedTargetSummaryRelMsgIds, listExclusiveRelMsgIds, replacedRelationMsgIds, summaryOwnership, graphExclusiveRelMsgIds, graphHiddenTextIds, focusRelationMsgIds]);

  function handleCanvasBlankClick() {
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection(); setLastClickedMessageId(null);
    setRelationType(null); setSecondaryRelationType("none");
  }

  async function handleDecorationIconClick(messageId: string, kind: "agree" | "disagree") {
    // Quick send: pure-stance agree/disagree — relation messages are first-class, persist to backend
    if (!topicId) return;
    try {
      const backendRel = await api.createRelation(topicId, {
        relationType: kind.toUpperCase(),
        sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId }],
      });
      const relId = backendRel.id;
      const anonSrcId = `anon:${backendRel.id}`;
      const edge: DemoEdge = { id: nextId("edge"), relationMessageId: relId, relationType: kind, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { messageId, selection: { kind: "whole" } }, relationLabel: relationTypeName(kind) };
      appendCreatedRelation(backendRel);
      setEdges(prev => [...prev, edge]);
    } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
  }

  function handleDecorationBodyClick(e: React.MouseEvent, messageId: string, kind: "agree" | "disagree") {
    e.stopPropagation();
    // Toggle selection of all agree/disagree relation messages targeting this message
    const matchingRelMsgs = edges.filter(edge =>
      edge.relationType === kind &&
      edge.to.messageId === messageId &&
      edge.to.selection.kind === "whole"
    ).map(edge => edge.relationMessageId);
    const uniqueRelMsgIds = Array.from(new Set(matchingRelMsgs));
    setLastClickedMessageId(messageId);
    for (const relMsgId of uniqueRelMsgIds) {
      const wholeUnit: UnitSelection = { messageId: relMsgId, selection: { kind: "whole" } };
      setDraftUnits(prev => {
        const exists = prev.some(u => unitEquals(u, wholeUnit));
        return exists ? prev.filter(u => !unitEquals(u, wholeUnit)) : [...prev, wholeUnit];
      });
    }
  }

  function handleDecorationDoubleClick(e: React.MouseEvent, messageId: string, kind: "agree" | "disagree") {
    e.stopPropagation();
    setDecorationPopup({ messageId, kind, x: e.clientX, y: e.clientY });
  }

  function handleTagBodyClick(e: React.MouseEvent, messageId: string, _tagLabel: string, relMsgIds: string[]) {
    e.stopPropagation();
    setLastClickedMessageId(messageId);
    setDraftUnits(prev => {
      const anySelected = relMsgIds.some(id => prev.some(u => u.messageId === id && u.selection.kind === "whole"));
      if (anySelected) {
        return prev.filter(u => !(relMsgIds.includes(u.messageId) && u.selection.kind === "whole"));
      } else {
        const toAdd = relMsgIds.filter(id => !prev.some(u => u.messageId === id && u.selection.kind === "whole"));
        return [...prev, ...toAdd.map(id => ({ messageId: id, selection: { kind: "whole" as const } }))];
      }
    });
  }

  function handleTagDoubleClick(e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]) {
    e.stopPropagation();
    setTagPopup({ messageId, tagLabel, relMsgIds, x: e.clientX, y: e.clientY });
  }

  function handleGroupFrameClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relMsgId);
    toggleWholeUnit(relMsgId);
  }

  function handleGroupFrameDoubleClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relMsgId);
    const relEdges = edges.filter(ed => ed.relationMessageId === relMsgId);
    const relType = relEdges[0]?.relationType ?? relationTypeByRelMsgId.get(relMsgId) ?? "";
    if (relType === "classify" || relType === "summary") {
      enterClassifyTopic(relMsgId);
      return;
    }
    if (relType === "merge") {
      setMergeInfoPopup({ relMsgId, x: e.clientX, y: e.clientY });
      return;
    }
    enterFocus(relMsgId);
  }

  function handleInlineBadgeClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relMsgId);
    toggleWholeUnit(relMsgId);
  }

  function handleInlineBadgeDoubleClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    // Recommend/archive: show who recommended/archived (tag-style popup, same as annotation double-click)
    const relEdges = edges.filter(ed => ed.relationMessageId === relMsgId);
    const relType = relEdges[0]?.relationType;
    if (relType === 'recommend' || relType === 'archive') {
      const targetMid = relEdges[0]?.to.messageId;
      if (!targetMid) return;
      const typeName = relationTypeName(relType);
      const allRelMsgIds = Array.from(new Set(
        edges.filter(ed => ed.relationType === relType && ed.to.messageId === targetMid && ed.to.selection.kind === 'whole')
          .map(ed => ed.relationMessageId)
      ));
      setTagPopup({ messageId: targetMid, tagLabel: typeName, relMsgIds: allRelMsgIds, x: e.clientX, y: e.clientY });
    } else {
      // Correction badge and other inline badges: show comparison popup
      setComparisonPopup({ relMsgId, x: e.clientX, y: e.clientY });
    }
  }

  function toggleWholeUnit(msgId: string) {
    const wholeUnit: UnitSelection = { messageId: msgId, selection: { kind: "whole" } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, wholeUnit));
      return exists ? prev.filter(u => !unitEquals(u, wholeUnit)) : [...prev, wholeUnit];
    });
  }

  async function handleArchiveTopic() {
    if (!topicId || !topic) return;
    try {
      const updated = await api.updateTopic(topicId, { status: topic.status === 'ARCHIVED' ? 'OPEN' : 'ARCHIVED' });
      setTopic(updated);
    } catch (e: any) { alert(`操作失败: ${e?.message ?? e}`); }
  }

  function handleSplitterMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    splitterDragRef.current = { startX: e.clientX, startFlex: leftFlex };
    function onMouseMove(ev: MouseEvent) {
      if (!splitterDragRef.current || !panelContainerRef.current) return;
      const dx = ev.clientX - splitterDragRef.current.startX;
      const containerW = panelContainerRef.current.clientWidth;
      const flexChange = containerW > 0 ? (dx / containerW) * TOTAL_FLEX : 0;
      const newLeft = Math.max(MIN_LEFT_FLEX, Math.min(MAX_LEFT_FLEX, splitterDragRef.current.startFlex + flexChange));
      setLeftFlex(newLeft);
    }
    function onMouseUp() {
      splitterDragRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  async function handleDeleteTopic() {
    if (!topicId || !confirm('确定要删除这个话题吗？')) return;
    try {
      await api.deleteTopic(topicId);
      navigate('/');
    } catch (e: any) { alert(`删除失败: ${e?.message ?? e}`); }
  }

  if (loading) {
    return <div style={{ padding: 16, background: "#101010", color: "#eee", height: "100%" }}>加载中…</div>;
  }
  if (loadError) {
    return (
      <div style={{ padding: 16, background: "#101010", color: "#eee", height: "100%" }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>加载失败</div>
        <pre style={{ whiteSpace: "pre-wrap", color: "#ff8080" }}>{loadError}</pre>
      </div>
    );
  }

  const messagesToRender = viewMode === "list" ? listMessagesToRender : graphMessagesToRender;
  const edgesToRender = viewMode === "list" ? listEdgesToRender : graphEdgesToRender;
  const isOwner = user && topic && (topic as any).author?.id === user.id;

  return (
    <>
    <ErrorBoundary>
    <div style={{ height: "100%", overflow: "hidden", margin: 0, display: "flex", flexDirection: "column", background: "#101010", color: "#eee", fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #333", background: "#181818", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {isOwner && <>
            <button onClick={handleArchiveTopic} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 11, cursor: "pointer" }}>
              {topic?.status === 'ARCHIVED' ? '重新开放' : '归档'}
            </button>
            <button onClick={handleDeleteTopic} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #a00", background: "#300", color: "#faa", fontSize: 11, cursor: "pointer" }}>删除</button>
          </>}
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
          <span>关系类型：</span>
          {ALL_RELATION_TYPES.map(rt => (
            <button key={rt} onClick={() => { setRelationType(prev => prev === rt ? null : rt); setSecondaryRelationType("none"); }}
              style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: relationType === rt ? "#0b84ff" : "#222", color: relationType === rt ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
              {relationTypeName(rt)}
            </button>
          ))}
        </div>
      </div>

      <div ref={panelContainerRef} style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        <div style={{ flex: leftFlex, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden", paddingBottom: 8 }}>
          <div style={{ flex: "0 0 auto", padding: 8, borderBottom: "1px solid #333", background: "#141414" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontWeight: 600 }}>{viewMode === "list" ? "消息列表（线性）" : "结构图（非线性）"}</div>
              <button onClick={() => {
                if (leftPanelRef.current) {
                  viewModeScrollRef.current[viewMode] = { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft };
                }
                setViewMode(prev => prev === "list" ? "graph" : "list");
              }} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                {viewMode === "list" ? "切换为结构图" : "切换为列表"}
              </button>
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {viewMode === "list" ? "线性视图：支持自由换行内容；双击 normal 进入文本选择模式；可点击高亮片段切换选中。" : "结构图：注释/引用 source 自动推到 target 右侧列（规则1）；label避让文字；高亮片段可点击。"}
            </div>
          </div>
          {isTopicFocus && (
            <div style={{ flex: "0 0 auto", padding: "8px 8px 12px 8px", background: "#101010" }}>
              <div style={{ border: "1px solid #334155", borderRadius: 10, padding: "8px 10px", background: "linear-gradient(180deg, #162036 0%, #0f172a 100%)", color: "#e2e8f0", boxShadow: "0 6px 16px rgba(0,0,0,0.25)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {topicFocusTitle || topicFocusKindLabel}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: "rgba(34,197,94,0.18)", color: "#86efac", border: "1px solid rgba(34,197,94,0.35)", flexShrink: 0 }}>
                      进行中
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>由 <span style={{ fontWeight: 600, color: "#cbd5e1" }}>{topicFocusRelMsg?.author ?? "系统"}</span> 发起</span>
                    <span>💬 {topicFocusTargetCount} 条观点</span>
                    <span>{topicFocusRelMsg ? new Date(topicFocusRelMsg.createdAt).toLocaleDateString('zh-CN') : ""}</span>
                  </div>
                </div>
                <button onClick={exitFocus} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #475569", background: "#1e293b", color: "#e2e8f0", cursor: "pointer", flexShrink: 0 }}>
                  {topicFocusExitLabel}
                </button>
              </div>
            </div>
          )}

          <div ref={leftPanelRef} style={{ flex: "1 1 auto", overflow: "auto", padding: 8, minHeight: 0 }}
            onMouseDown={e => {
              const t = e.target as HTMLElement;
              // Skip if clicked on a message card, SVG edge, or relation overlay
              if (t.closest?.("[data-msgid]") || t.closest?.("svg") || t.closest?.('[title^="relation="]') || t.closest?.("[data-rel-overlay]")) return;
              handleCanvasBlankClick();
            }}>
            {messagesToRender.length === 0 ? (
              <div style={{ padding: 48, textAlign: "center", color: "#666", fontSize: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 36, opacity: 0.3 }}>📭</div>
                <div>{isTopicFocus ? `当前${topicFocusKindLabel}中暂无消息` : focusEntries.length > 0 ? "焦点范围内没有可见消息" : "暂无消息，请先发送一条消息或创建关系"}</div>
                {canExitFocus && (
                  <button onClick={exitFocus} style={{ marginTop: 8, padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "#333", color: "#ccc", cursor: "pointer", fontSize: 13 }}>
                    {isTopicFocus ? topicFocusExitLabel : "退出焦点"}
                  </button>
                )}
              </div>
            ) : viewMode === "list" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {messagesToRender
                  .filter(msg => !tagSourceIdsForList.has(msg.id))
                  .map(msg => {
                  const isWholeSelected = draftUnits.some(u => u.messageId === msg.id && u.selection.kind === "whole");
                  const isActiveText = activeTextSelectId === msg.id;
                  const relType = msg.kind === "relation" ? relationTypeByRelMsgId.get(msg.id) : null;
                  const isClassifyTopicMsg = relType === "classify";
                  const isSummaryTopicMsg = relType === "summary";
                  const isMergeTopicMsg = relType === "merge";
                  const isTopicMsg = isClassifyTopicMsg || isSummaryTopicMsg || isMergeTopicMsg;
                  const topicMsgTargetCount = isTopicMsg
                    ? collectOwnedByRelation(msg.id, relationById).textIds.size
                    : 0;
                  const topicMsgTitle = isTopicMsg ? (getRelationTitle(msg.relationPayload) || (isClassifyTopicMsg ? `分类话题（${topicMsgTargetCount}）` : isMergeTopicMsg ? `归并（${topicMsgTargetCount}）` : `总结（${topicMsgTargetCount}）`)) : "";
                  return (
                    <div key={msg.id} data-msgid={msg.id} onClick={e => handleMessageClick(e, msg.id)} onDoubleClick={e => handleMessageDoubleClick(e, msg.id)} onMouseDown={e => handleMessageMouseDown(e, msg.id)} onMouseUp={e => handleMessageMouseUp(e, msg.id)}
                      style={{
                        borderRadius: isTopicMsg ? 8 : 6,
                        border: isWholeSelected
                          ? "2px solid #0b84ff"
                          : isTopicMsg
                            ? "1px solid #334155"
                            : isActiveText ? "2px dashed #0b84ff" : "1px solid #444",
                        borderLeft: isWholeSelected
                          ? "3px solid #0b84ff"
                          : isTopicMsg ? "3px solid #6366f1" : undefined,
                        background: isWholeSelected
                          ? "#1e3a5f"
                          : isTopicMsg ? "#1e293b" : "#1f1f1f",
                        color: undefined,
                        padding: isTopicMsg ? "10px 12px" : "10px 14px",
                        cursor: "pointer",
                        fontSize: 13,
                        boxShadow: isWholeSelected
                          ? "0 2px 12px rgba(11,132,255,0.2)"
                          : isTopicMsg ? "0 2px 8px rgba(0,0,0,0.15)" : undefined,
                        outline: lastClickedMessageId === msg.id ? "1px dashed #0b84ff" : "none",
                        userSelect: isActiveText ? "text" : "auto"
                      }}>
                      <div style={{ fontSize: 11, opacity: isTopicMsg ? 0.65 : 0.8, marginBottom: 4, display: "flex", justifyContent: "space-between", color: isTopicMsg ? "#94a3b8" : undefined }}>
                        <span>{isClassifyTopicMsg ? `分类话题 ${msg.id}` : isSummaryTopicMsg ? `总结 ${msg.id}` : isMergeTopicMsg ? `归并 ${msg.id}` : msg.kind === "relation" ? `关系消息 ${msg.id}` : `消息 ${msg.id}`}</span>
                        <span>{isTopicMsg ? "双击进入话题" : `作者：${msg.author}`}</span>
                      </div>
                      {isTopicMsg && (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                          <div style={{ fontWeight: 600, color: "#f1f5f9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {topicMsgTitle}
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: isMergeTopicMsg ? "rgba(148,163,184,0.18)" : "rgba(34,197,94,0.15)", color: isMergeTopicMsg ? "#94a3b8" : "#4ade80" }}>
                            {isMergeTopicMsg ? "归并" : "进行中"}
                          </span>
                        </div>
                      )}
                      {!isTopicMsg && msg.kind === "relation" && (
                        <div style={{ marginBottom: 4 }}>
                          <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.08)", color: "#9ca3af" }}>
                            {relType ? String(relType) : "关系"}
                          </span>
                        </div>
                      )}
                      {isActiveText && msg.kind === "normal" && <div style={{ fontSize: 11, color: "#0b84ff", marginBottom: 4 }}>文本选择模式：拖选记录 start+len；或点击高亮片段</div>}
                      <div style={{ fontSize: 13, color: "#f5f5f5" }} onMouseUp={e => msg.kind === "normal" && handleTextMouseUp(e, msg.id)}>
                        {msg.kind === "normal"
                          ? renderMessageContentWithAnchorsForList(msg)
                          : isTopicMsg
                            ? (
                              <div style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 12, flexWrap: "wrap" }}>
                                <span>由 <span style={{ fontWeight: 600, color: "#cbd5e1" }}>{msg.author}</span> 发起</span>
                                <span>💬 {topicMsgTargetCount} 条观点</span>
                                <span>{new Date(msg.createdAt).toLocaleDateString('zh-CN')}</span>
                              </div>
                            )
                            : <div style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#d1d5db" }}>{msg.content}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <GraphView
                  key={`gv-${focusExitKey}`}
                  messages={messagesToRender} edges={edgesToRender} draftUnits={draftUnits}
                  activeTextSelectId={activeTextSelectId} lastClickedMessageId={lastClickedMessageId}
                  onMessageClick={handleMessageClick} onMessageDoubleClick={handleMessageDoubleClick}
                  onTextMouseUp={handleTextMouseUp} onEdgeLabelSingleClick={handleEdgeLabelSingleClick}
                  onEdgeLabelDoubleClick={handleEdgeLabelDoubleClick} onFragmentAnchorClick={handleFragmentAnchorClick}
                  isFragmentSelected={isFragmentSelected} onCanvasBlankClick={handleCanvasBlankClick}
                  onMessageMouseDown={handleMessageMouseDown} onMessageMouseUp={handleMessageMouseUp}
                  voteStats={voteStats}
                  onDecorationIconClick={handleDecorationIconClick}
                  onDecorationBodyClick={handleDecorationBodyClick}
                  onDecorationDoubleClick={handleDecorationDoubleClick}
                  onTagBodyClick={handleTagBodyClick}
                  onTagDoubleClick={handleTagDoubleClick}
                  onGroupFrameClick={handleGroupFrameClick}
                  onGroupFrameDoubleClick={handleGroupFrameDoubleClick}
                  onInlineBadgeClick={handleInlineBadgeClick}
                  onInlineBadgeDoubleClick={handleInlineBadgeDoubleClick}
                />
            )}
          </div>
        </div>

        {/* Draggable splitter */}
        <div
          onMouseDown={handleSplitterMouseDown}
          style={{ width: 6, flexShrink: 0, background: "#2a2a2a", cursor: "col-resize", borderLeft: "1px solid #383838", borderRight: "1px solid #383838", transition: "background 0.15s" }}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#3a3a3a"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#2a2a2a"; }}
        />

        <div ref={rightPanelRef} style={{ flex: TOTAL_FLEX - leftFlex, padding: 8, display: "flex", flexDirection: "column", gap: 8, overflow: "auto", minWidth: 0 }}>
          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>候选区（Draft）</div>
              <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
                <button onClick={clearDraftAll} disabled={draftUnits.length === 0 && !activeTextSelectId}
                  style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: draftUnits.length === 0 && !activeTextSelectId ? "#333" : "#444", color: draftUnits.length === 0 && !activeTextSelectId ? "#777" : "#fff", cursor: draftUnits.length === 0 && !activeTextSelectId ? "default" : "pointer" }}>
                  清空
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => { const selWhole = getSelectedWholeMessageIds(); if (selWhole.length > 0) enterFocusMultiple(selWhole, { replace: false }); else if (lastClickedMessageId) enterFocus(lastClickedMessageId, { replace: false }); }} disabled={!canSetFocus}
                    style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: canSetFocus ? "#444" : "#333", color: canSetFocus ? "#fff" : "#777", cursor: canSetFocus ? "pointer" : "default" }}>
                    设为焦点消息
                  </button>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={exitFocus} disabled={!canExitFocus} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: canExitFocus ? "#444" : "#333", color: canExitFocus ? "#fff" : "#777", cursor: canExitFocus ? "pointer" : "default" }} title={isTopicFocus ? `退出当前${topicFocusKindLabel}并恢复进入前现场` : "退出最近一次进入的焦点并恢复进入该焦点前的现场"}>{isTopicFocus ? topicFocusExitLabel : "退出焦点"}</button>
                    <button onClick={exitAllFocus} disabled={!canExitFocus} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: canExitFocus ? "#333" : "#222", color: canExitFocus ? "#fff" : "#777", cursor: canExitFocus ? "pointer" : "default" }} title="退出所有焦点并恢复进入第一个焦点前的现场">退出全部</button>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>焦点距离（hop）：{focusHop}</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setFocusHop(h => Math.max(0, h - 1))} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#222", color: "#fff", cursor: "pointer" }}>-</button>
                <button onClick={() => setFocusHop(h => Math.min(8, h + 1))} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#222", color: "#fff", cursor: "pointer" }}>+</button>
                <div style={{ fontSize: 12, opacity: 0.7 }}>（可设置 hop，默认 1，最大 8）</div>
              </div>
            </div>

            {draftGroups.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>当前未选择任何候选。</div>
            ) : (
              <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 220, overflow: "auto", fontSize: 12, marginTop: 8 }}>
                {draftGroups.map(g => (
                  <li key={`DG-${g.messageId}`} style={{ borderBottom: "1px solid #333", paddingBottom: 6, marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span>{g.messageId} · 整条：{g.wholeSelected ? "是" : "否"} · 片段数：{g.fragments.length}</span>
                      {g.wholeSelected && <button onClick={() => removeUnitFromDraft({ messageId: g.messageId, selection: { kind: "whole" } })} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除整条</button>}
                    </div>
                    {g.fragments.length > 0 && (
                      <ul style={{ listStyle: "disc", marginLeft: 18, marginTop: 2, marginBottom: 0 }}>
                        {g.fragments.map(u => {
                          const s = u.selection;
                          const label = s.kind === "edge" ? `@edge:${s.edgeId}` : s.kind === "text" ? `start=${s.start} len=${s.len} "${s.text}"` : "(whole)";
                          return (
                            <li key={selKey(u)} style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                              <button onClick={() => removeUnitFromDraft(u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer", flex: "0 0 auto" }}>删除片段</button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => commitDraftTo("source")} disabled={draftUnits.length === 0} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: draftUnits.length === 0 ? "#333" : "#444", color: draftUnits.length === 0 ? "#777" : "#fff", cursor: draftUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>加入来源集合</button>
              <button onClick={() => commitDraftTo("target")} disabled={draftUnits.length === 0} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: draftUnits.length === 0 ? "#333" : "#444", color: draftUnits.length === 0 ? "#777" : "#fff", cursor: draftUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>加入目标集合</button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Sources</div>
              {sourceUnits.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div> : (
                <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 120, overflow: "auto", fontSize: 12 }}>
                  {sourceUnits.map(u => (
                    <li key={selKey(u)} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span>{describeUnit(u)}</span>
                      <button onClick={() => removeUnitFrom("source", u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Targets</div>
              {targetUnits.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div> : (
                <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 120, overflow: "auto", fontSize: 12 }}>
                  {targetUnits.map(u => (
                    <li key={selKey(u)} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span>{describeUnit(u)}</span>
                      <button onClick={() => removeUnitFrom("target", u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {user && (
            <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontWeight: 600 }}>关系标签与消息文本</div>
              {hasSecondaryRelationSelector && (() => {
                const opts = relationType === "reply"
                  ? ["none", "question", "answer"]
                  : relationType === "tag"
                    ? tagSecondaryOptions
                    : correctSecondaryOptions;
                return (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, flexWrap: "wrap" }}>
                    <span style={{ opacity: 0.85 }}>附加关系：</span>
                    {opts.map(t => (
                      <button key={t} onClick={() => setSecondaryRelationType(prev => (prev === t && t !== "none") ? "none" : t)}
                        style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: secondaryRelationType === t ? "#0b84ff" : "#222", color: secondaryRelationType === t ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                        {secondaryRelationLabel(t)}
                      </button>
                    ))}
                  </div>
                );
              })()}
              <input
                style={{ width: "100%", padding: 4, borderRadius: 4, border: "1px solid #555", background: relationType === "reply" ? "#1a1a1a" : "#222", color: relationType === "reply" ? "#999" : "#eee", fontSize: 12 }}
                placeholder={relationType === "annotation" ? "注释标签" : relationType === "reference" ? "引用标签" : relationType === "reply" ? "回复标签由附加关系决定" : "关系标签"}
                value={relationType === "reply" ? replyAdditionalLabel(secondaryRelationType) : relationLabel}
                readOnly={relationType === "reply"}
                onChange={e => relationType !== "reply" && setRelationLabel(e.target.value)}
              />
              <div key={composerRefreshKey}>
              {(() => {
                const textAreaDisabled =
                  (draftHasRelationTarget && relationType === "correct")
                  || (isTagWithQuickAnnotate && hasTargetsAvailable)
                  || (isMergeType && hasTargetsAvailable);
                return (
                  <textarea
                    style={{ width: "100%", minHeight: 80, maxHeight: 220, padding: 4, borderRadius: 4, border: "1px solid #555", background: textAreaDisabled ? "#1a1a1a" : "#222", color: textAreaDisabled ? "#666" : "#eee", fontSize: 13, resize: "vertical" }}
                    placeholder={textAreaDisabled ? (isTagWithQuickAnnotate ? "已选择附加关系，此处不可输入" : isMergeType ? "归并关系为用户-消息关系，此处不应输入内容" : "更正关系目标为关系消息时，此处不应有内容") : isClassifyType ? "输入分类话题名称（不能为空）" : isSummaryType ? "输入总结内容（不能为空）" : "输入一条新普通消息（支持自由换行）"}
                    value={newMessageContent}
                    readOnly={textAreaDisabled}
                    onChange={e => !textAreaDisabled && setNewMessageContent(e.target.value)}
                  />
                );
              })()}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={handleQuickSendAndRelateFromDraftTargets}
                  disabled={!singleButtonEnabled}
                  style={{ padding: "4px 14px", borderRadius: 4, border: "1px solid #666", background: singleButtonEnabled ? "#0b84ff" : "#333", color: singleButtonEnabled ? "#fff" : "#777", cursor: singleButtonEnabled ? "pointer" : "default", fontSize: 13, fontWeight: 600, flexShrink: 0 }}
                >
                  发送
                </button>
                <span style={{ fontSize: 11, opacity: singleButtonEnabled ? 0.9 : 0.5, color: singleButtonEnabled ? "#cce4ff" : "#999" }}>
                  {singleButtonLabel}
                </span>
              </div>
              </div>
            </div>
          )}

          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
            <div style={{ fontWeight: 600 }}>焦点</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{isTopicFocus ? "当前模式：话题" : "当前模式：焦点"}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>当前焦点：{currentFocusIds ? currentFocusIds.join(", ") : "（无）"}</div>
          </div>

          <StructureView focusIds={currentFocusIds ?? []} messages={messages} edges={edges} />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>最近普通消息</div>
              <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, fontSize: 12, maxHeight: 100, overflow: "auto" }}>
                {recentNormals.map(m => <li key={m.id}>{m.id}：{m.content.slice(0, 40)}{m.content.length > 40 ? "…" : ""}</li>)}
              </ul>
            </div>
            <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>最近关系消息</div>
              <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, fontSize: 12, maxHeight: 100, overflow: "auto" }}>
                {recentRelations.map(m => <li key={m.id}>{m.id}：{m.content.slice(0, 60)}{m.content.length > 60 ? "…" : ""}</li>)}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
    </ErrorBoundary>

    {/* Decoration double-click popup: shows sender info for agree/disagree relations */}
    {decorationPopup && (() => {
      const { messageId, kind, x, y } = decorationPopup;
      const matchingRelations = edges.filter(e =>
        e.relationType === kind && e.to.messageId === messageId && e.to.selection.kind === "whole"
      ).map(e => {
        const relMsg = messages.find(m => m.id === e.relationMessageId);
        return relMsg ? { id: relMsg.id, author: relMsg.author, createdAt: relMsg.createdAt } : null;
      }).filter(Boolean) as { id: string; author: string; createdAt: string }[];
      return (
        <div key="dec-popup" onClick={() => setDecorationPopup(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 200), width: 260, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
              {kind === "agree" ? "👍 赞同" : "👎 反对"} 记录（共 {matchingRelations.length} 条）
            </div>
            {matchingRelations.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>暂无记录</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 160, overflow: "auto", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {matchingRelations.map(r => (
                  <li key={r.id} style={{ padding: "4px 6px", borderRadius: 4, background: "#2a2a2a", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{r.author}</span>
                    <span style={{ opacity: 0.6 }}>{new Date(r.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
            <button onClick={() => setDecorationPopup(null)}
              style={{ marginTop: 10, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}

    {/* Tag double-click popup: shows who tagged with the given label */}
    {tagPopup && (() => {
      const { messageId, tagLabel, relMsgIds, x, y } = tagPopup;
      const taggers = relMsgIds.map(id => {
        const relMsg = messages.find(m => m.id === id);
        return relMsg ? { id: relMsg.id, author: relMsg.author, createdAt: relMsg.createdAt } : null;
      }).filter(Boolean) as { id: string; author: string; createdAt: string }[];
      return (
        <div key="tag-popup" onClick={() => setTagPopup(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 200), width: 260, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
              🏷 标注「{tagLabel}」（共 {taggers.length} 人）<br />
              <span style={{ fontSize: 11, opacity: 0.7 }}>消息：{messageId}</span>
            </div>
            {taggers.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>暂无记录</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 160, overflow: "auto", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {taggers.map(r => (
                  <li key={r.id} style={{ padding: "4px 6px", borderRadius: 4, background: "#2a2a2a", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{r.author}</span>
                    <span style={{ opacity: 0.6 }}>{new Date(r.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
            <button onClick={() => setTagPopup(null)}
              style={{ marginTop: 10, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}
    {mergeInfoPopup && (() => {
      const relMsg = messages.find(m => m.id === mergeInfoPopup.relMsgId);
      const left = Math.min(mergeInfoPopup.x, window.innerWidth - 320);
      const top = Math.min(mergeInfoPopup.y, window.innerHeight - 180);
      return (
        <div key="merge-info-popup" onClick={() => setMergeInfoPopup(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left, top, width: 300, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>
              归并关系信息
            </div>
            <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <div>创建者：<span style={{ fontWeight: 600 }}>{relMsg?.author ?? "未知"}</span></div>
              <div>发送时间：<span style={{ opacity: 0.8 }}>{relMsg ? new Date(relMsg.createdAt).toLocaleString() : "未知"}</span></div>
            </div>
            <button onClick={() => setMergeInfoPopup(null)}
              style={{ marginTop: 12, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}
    {comparisonPopup && (()=>{
      const relEdges = edges.filter(e => e.relationMessageId === comparisonPopup.relMsgId);
      const sourceMsg = relEdges[0] && !relEdges[0].from.messageId.startsWith('anon:')
        ? msgMap.get(relEdges[0].from.messageId) : null;
      const targetMids = Array.from(new Set(relEdges.map(e => e.to.messageId)));
      const targetMsgs = targetMids.map(id => msgMap.get(id)).filter((m): m is DemoMessage => m != null);
      const relType = relEdges[0]?.relationType ?? "";

      // CORRECT relation: side-by-side comparison with highlighting
      if (relType === "correct" && targetMsgs.length > 0) {
        const origMsg = targetMsgs[0];

        // Relation-message correction: show structured relation summary instead of text diff.
        // sourceMsg may be null when secondary relation is "none" (no replacement relation).
        if (origMsg.kind === "relation") {
          // Edges belonging to the old relation (not the CORRECT edge itself)
          const oldRelEdges = edges.filter(e => e.relationMessageId === origMsg.id);
          // Edges belonging to the new relation, excluding the CORRECT edge (empty when no replacement)
          const newRelEdges = sourceMsg
            ? edges.filter(e => e.relationMessageId === sourceMsg.id && e.relationType !== 'correct')
            : [];
          const oldType = oldRelEdges[0]?.relationType ?? "";
          const newType = newRelEdges[0]?.relationType ?? "";
          const oldTypeName = relationTypeName(oldType as RelationType);
          const newTypeName = newType ? relationTypeName(newType as RelationType) : "";
          const oldSrcRaw = oldRelEdges[0]?.from.messageId ?? "";
          const newSrcRaw = newRelEdges[0]?.from.messageId ?? "";
          const oldSrc = oldSrcRaw.startsWith('anon:') ? null : oldSrcRaw;
          const newSrc = newSrcRaw.startsWith('anon:') ? null : newSrcRaw;
          const oldTargets = Array.from(new Set(oldRelEdges.map(e => e.to.messageId)));
          const newTargets = Array.from(new Set(newRelEdges.map(e => e.to.messageId)));
          const oldTargetStr = oldTargets.join(",");
          const newTargetStr = newTargets.join(",");
          const popupW = Math.min(700, window.innerWidth - 32);
          const left = Math.min(Math.max(comparisonPopup.x - popupW / 2, 8), window.innerWidth - popupW - 8);
          const top = Math.min(comparisonPopup.y + 8, window.innerHeight - 400);
          return (
            <div style={{position:"fixed",left:0,top:0,right:0,bottom:0,zIndex:200,background:"rgba(0,0,0,0.6)"}}
              onClick={()=>setComparisonPopup(null)}>
              <div style={{position:"fixed",left:left,top:top,zIndex:201,background:"#1e1e1e",
                border:"1px solid #555",borderRadius:8,padding:16,width:popupW,maxHeight:"80vh",
                overflow:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.8)",color:"#eee"}}
                onClick={e=>e.stopPropagation()}>
                <div style={{fontWeight:700,marginBottom:12,fontSize:14}}>✏ 更正对比（关系消息）</div>
                <div style={{display:"flex",gap:10}}>
                  {/* Left: old relation */}
                  <div style={{flex:1,minWidth:0,borderRadius:6,border:"1px solid #554",background:"#211e14",padding:10}}>
                    <div style={{fontSize:11,marginBottom:6}}>
                      <span style={{fontWeight:600}}>原关系</span>
                      <span style={{opacity:0.45,marginLeft:6,fontSize:10}}>{origMsg.id}</span>
                    </div>
                    <div style={{fontSize:13,fontFamily:"monospace",lineHeight:1.8}}>
                      <span style={{color:"#ff9944",fontWeight:700}}>{oldTypeName}</span>
                      <span style={{color:"#ddd"}}>
                        {oldSrc ? `: ${oldSrc} → ${oldTargetStr}` : `: ${oldTargetStr}`}
                      </span>
                    </div>
                  </div>
                  {/* Right: new relation — blank when secondary is "none" (no replacement relation) */}
                  <div style={{flex:1,minWidth:0,borderRadius:6,border:"1px solid #255",background:"#14201e",padding:10}}>
                    <div style={{fontSize:11,marginBottom:6}}>
                      <span style={{fontWeight:600}}>更正后</span>
                      {sourceMsg && <span style={{opacity:0.45,marginLeft:6,fontSize:10}}>{sourceMsg.id}</span>}
                    </div>
                    {sourceMsg && (
                      <div style={{fontSize:13,fontFamily:"monospace",lineHeight:1.8}}>
                        <span style={{color:"#44ddaa",fontWeight:700}}>{newTypeName}</span>
                        <span style={{color:"#ddd"}}>
                          {newSrc ? `: ${newSrc} → ${newTargetStr}` : `: ${newTargetStr}`}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div style={{marginTop:12,textAlign:"right"}}>
                  <button onClick={()=>setComparisonPopup(null)}
                    style={{padding:"4px 12px",borderRadius:4,border:"1px solid #555",background:"#333",color:"#eee",cursor:"pointer",fontSize:12}}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          );
        }

        // Text correction requires a real source message
        if (sourceMsg) {
        // Prefer precise position-based highlighting for single-fragment corrections:
        // The correction edge carries the exact text selection (start + len) in the
        // original message, so we can pinpoint the changed region without the LCS
        // algorithm incorrectly matching repeated substrings elsewhere in the text.
        // Fall back to LCS for whole-message corrections or edge cases.
        //
        // For whole-message corrections where the content is completely replaced,
        // show the full original and new content side by side without diff highlights,
        // since there's no shared structure to align (Bug 4 fix).
        let origParts: DiffPart[];
        let nextParts: DiffPart[];
        const textEdge = relEdges.find(e => e.to.selection.kind === 'text');
        const textEdges = relEdges.filter(e => e.to.selection.kind === 'text');
        const hasWholeEdge = relEdges.some(e => e.to.selection.kind === 'whole');
        if (textEdge && textEdges.length === 1) {
          const sel = textEdge.to.selection as { kind: 'text'; start: number; len: number; text: string };
          const s = sel.start, l = sel.len;
          const origLen = origMsg.content.length, nextLen = sourceMsg.content.length;
          // For a single-fragment correction: prefix [0,s) is identical in both messages,
          // deleted region is orig[s,s+l), inserted region is next[s,s+insertedLen), and
          // suffix next[s+insertedLen,) equals orig[s+l,). Verify this before using it.
          const insertedLen = nextLen - origLen + l;
          const prefixOk = s >= 0 && l >= 0 && insertedLen >= 0 && s + l <= origLen && s + insertedLen <= nextLen;
          const contentOk = prefixOk &&
            origMsg.content.slice(0, s) === sourceMsg.content.slice(0, s) &&
            origMsg.content.slice(s + l) === sourceMsg.content.slice(s + insertedLen);
          if (contentOk) {
            origParts = [];
            if (s > 0) origParts.push({ type: 'keep', text: origMsg.content.slice(0, s) });
            if (l > 0) origParts.push({ type: 'del', text: origMsg.content.slice(s, s + l) });
            if (s + l < origLen) origParts.push({ type: 'keep', text: origMsg.content.slice(s + l) });
            nextParts = [];
            if (s > 0) nextParts.push({ type: 'keep', text: sourceMsg.content.slice(0, s) });
            if (insertedLen > 0) nextParts.push({ type: 'ins', text: sourceMsg.content.slice(s, s + insertedLen) });
            if (s + insertedLen < nextLen) nextParts.push({ type: 'keep', text: sourceMsg.content.slice(s + insertedLen) });
          } else {
            ({ origParts, nextParts } = computeCharDiff(origMsg.content, sourceMsg.content));
          }
        } else if (hasWholeEdge && origMsg.content !== sourceMsg.content) {
          // Whole-message correction: if the content is completely different
          // (no common prefix/suffix), show as full replacement without diff.
          // Otherwise use LCS diff for partial similarity (Bug 4 fix).
          ({ origParts, nextParts } = computeCharDiff(origMsg.content, sourceMsg.content));
        } else {
          ({ origParts, nextParts } = computeCharDiff(origMsg.content, sourceMsg.content));
        }
        // Clamp popup so it stays within viewport
        const popupW = Math.min(700, window.innerWidth - 32);
        const left = Math.min(Math.max(comparisonPopup.x - popupW / 2, 8), window.innerWidth - popupW - 8);
        const top = Math.min(comparisonPopup.y + 8, window.innerHeight - 400);
        return (
          <div style={{position:"fixed",left:0,top:0,right:0,bottom:0,zIndex:200,background:"rgba(0,0,0,0.6)"}}
            onClick={()=>setComparisonPopup(null)}>
            <div style={{position:"fixed",left:left,top:top,zIndex:201,background:"#1e1e1e",
              border:"1px solid #555",borderRadius:8,padding:16,width:popupW,maxHeight:"80vh",
              overflow:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.8)",color:"#eee"}}
              onClick={e=>e.stopPropagation()}>
              <div style={{fontWeight:700,marginBottom:12,fontSize:14}}>✏ 更正对比</div>
              <div style={{display:"flex",gap:10}}>
                {/* Left: original message */}
                <div style={{flex:1,minWidth:0,borderRadius:6,border:"1px solid #554",background:"#211e14",padding:10}}>
                  <div style={{fontSize:11,marginBottom:6}}>
                    <span style={{fontWeight:600}}>原文</span>
                    <span style={{marginLeft:6}}>{origMsg.author}</span>
                    <span style={{opacity:0.6,marginLeft:6}}>{new Date(origMsg.createdAt).toLocaleString()}</span>
                    <span style={{opacity:0.45,marginLeft:6,fontSize:10}}>{origMsg.id}</span>
                  </div>
                  <pre style={{margin:0,whiteSpace:"pre-wrap",fontSize:12,color:"#ddd",fontFamily:"monospace",lineHeight:1.6}}>
                    {renderDiffParts(origParts, 'orig')}
                  </pre>
                </div>
                {/* Right: new (corrected) message */}
                <div style={{flex:1,minWidth:0,borderRadius:6,border:"1px solid #255",background:"#14201e",padding:10}}>
                  <div style={{fontSize:11,marginBottom:6}}>
                    <span style={{fontWeight:600}}>更正后</span>
                    <span style={{marginLeft:6}}>{sourceMsg.author}</span>
                    <span style={{opacity:0.6,marginLeft:6}}>{new Date(sourceMsg.createdAt).toLocaleString()}</span>
                    <span style={{opacity:0.45,marginLeft:6,fontSize:10}}>{sourceMsg.id}</span>
                  </div>
                  <pre style={{margin:0,whiteSpace:"pre-wrap",fontSize:12,color:"#ddd",fontFamily:"monospace",lineHeight:1.6}}>
                    {renderDiffParts(nextParts, 'next')}
                  </pre>
                </div>
              </div>
              <div style={{marginTop:12,textAlign:"right"}}>
                <button onClick={()=>setComparisonPopup(null)}
                  style={{padding:"4px 12px",borderRadius:4,border:"1px solid #555",background:"#333",color:"#eee",cursor:"pointer",fontSize:12}}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        );
        } // end if (sourceMsg)
      }

      return (
        <div style={{position:"fixed",left:0,top:0,right:0,bottom:0,zIndex:200,background:"rgba(0,0,0,0.6)"}}
          onClick={()=>setComparisonPopup(null)}>
          <div style={{position:"fixed",left:comparisonPopup.x,top:comparisonPopup.y,zIndex:201,background:"#1e1e1e",
            border:"1px solid #555",borderRadius:8,padding:16,minWidth:320,maxWidth:600,maxHeight:"80vh",
            overflow:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.8)",color:"#eee"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{fontWeight:700,marginBottom:12,fontSize:14}}>
              {relationTypeName(relType)}对比：{comparisonPopup.relMsgId}
            </div>
            <div style={{display:"flex",gap:12,flexDirection:"column"}}>
              {targetMsgs.map(tm=>(
                <div key={tm.id} style={{borderRadius:6,border:"1px solid #554",background:"#232018",padding:8}}>
                  <div style={{fontSize:11,marginBottom:4}}>
                    <span style={{fontWeight:600}}>原文</span>
                    <span style={{marginLeft:6}}>{tm.author}</span>
                    <span style={{opacity:0.6,marginLeft:6}}>{new Date(tm.createdAt).toLocaleString()}</span>
                    <span style={{opacity:0.45,marginLeft:6,fontSize:10}}>{tm.id}</span>
                  </div>
                  <pre style={{margin:0,whiteSpace:"pre-wrap",fontSize:12,color:"#ddd",fontFamily:"monospace"}}>{tm.content}</pre>
                </div>
              ))}
              {sourceMsg && (
                <div style={{borderRadius:6,border:"1px solid #255",background:"#182028",padding:8}}>
                  <div style={{fontSize:11,marginBottom:4}}>
                    <span style={{fontWeight:600}}>更新</span>
                    <span style={{marginLeft:6}}>{sourceMsg.author}</span>
                    <span style={{opacity:0.6,marginLeft:6}}>{new Date(sourceMsg.createdAt).toLocaleString()}</span>
                    <span style={{opacity:0.45,marginLeft:6,fontSize:10}}>{sourceMsg.id}</span>
                  </div>
                  <pre style={{margin:0,whiteSpace:"pre-wrap",fontSize:12,color:"#ddd",fontFamily:"monospace"}}>{sourceMsg.content}</pre>
                </div>
              )}
            </div>
            <div style={{marginTop:12,textAlign:"right"}}>
              <button onClick={()=>setComparisonPopup(null)}
                style={{padding:"4px 12px",borderRadius:4,border:"1px solid #555",background:"#333",color:"#eee",cursor:"pointer",fontSize:12}}>
                关闭
              </button>
            </div>
          </div>
        </div>
      );
    })()}
    </>
  );
}
