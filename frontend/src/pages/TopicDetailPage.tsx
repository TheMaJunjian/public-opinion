import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { convertMessagesToDemoModel, unitSelectionToTargetRef } from '../utils/modelBridge';
import type {
  DemoMessage, DemoEdge, UnitSelection, Selection,
  RelationType,
} from '../utils/modelBridge';
import type { Topic, TargetRef } from '../types';
import { getPresentationSpec } from '../types';
import GraphView, { clearBrowserSelection, extractTextTargetsForMessage, relationTypeName, getSelectionFragment, buildAnnoTree, renderAnnoNodes } from '../components/GraphView';

// ========================= Helpers =========================

const ALL_RELATION_TYPES: RelationType[] = [
  "annotation", "reference", "reply", "agree", "disagree", "tag", "supplement",
  "correct", "classify", "merge", "summary", "recommend", "archive",
];

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

  const wholeSelected = targetUnits.some(u => u.selection.kind === "whole");
  if (wholeSelected) return replacementText;

  const textFragments = targetUnits
    .filter(u => u.selection.kind === "text")
    .map(u => u.selection as { kind: "text"; start: number; len: number; text: string });
  if (textFragments.length === 0) return replacementText;

  // Apply replacements in reverse order so earlier positions remain valid
  const sorted = [...textFragments].sort((a, b) => b.start - a.start);
  let content = targetMsg.content;
  for (const frag of sorted) {
    content = content.slice(0, frag.start) + replacementText + content.slice(frag.start + frag.len);
  }
  return content;
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
};

export default function TopicDetailPage() {
  const { topicId } = useParams<{ topicId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [topic, setTopic] = useState<Topic | null>(null);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [edges, setEdges] = useState<DemoEdge[]>([]);
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
  const [focusEntries, setFocusEntries] = useState<{ ids: string[]; snapshot: FocusSnapshot | null }[]>([]);
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

  const currentFocusIds = focusEntries.length > 0 ? focusEntries[focusEntries.length - 1].ids : null;
  const msgMap = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

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

  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
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

  // Scroll the left panel canvas so the message with the given ID is centered.
  // Polls via requestAnimationFrame until the card appears in the DOM.
  // MAX_SCROLL_ATTEMPTS × ~16ms/frame ≈ 1 second maximum wait time.
  const MAX_SCROLL_ATTEMPTS = 60;
  function scrollMsgToCenter(msgId: string) {
    pendingScrollMsgIdRef.current = msgId;
    let attempts = 0;
    function tryScroll() {
      attempts++;
      if (attempts > MAX_SCROLL_ATTEMPTS) { pendingScrollMsgIdRef.current = null; return; }
      if (pendingScrollMsgIdRef.current !== msgId) return; // superseded by newer message
      const container = leftPanelRef.current;
      if (!container) { requestAnimationFrame(tryScroll); return; }
      const el = container.querySelector(`[data-msgid="${msgId}"]`) as HTMLElement | null;
      if (!el) { requestAnimationFrame(tryScroll); return; }
      pendingScrollMsgIdRef.current = null;
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
      const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
      container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
      container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
    }
    requestAnimationFrame(tryScroll);
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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clampAndSetScroll(leftPanelRef.current, s.leftScroll?.top ?? null, s.leftScroll?.left ?? null);
        clampAndSetScroll(rightPanelRef.current, s.rightScroll?.top ?? null, s.rightScroll?.left ?? null);
      });
    });
  }

  function enterFocus(messageId: string, options?: { replace?: boolean }) {
    if (!messageId) return;
    const snapshot = captureSnapshot();
    const entry = { ids: [messageId], snapshot };
    setFocusEntries(prev => options?.replace ? [entry] : [...prev, entry]);
  }

  function enterFocusMultiple(messageIds: string[], options?: { replace?: boolean }) {
    if (!messageIds || messageIds.length === 0) return;
    const snapshot = captureSnapshot();
    const entry = { ids: messageIds, snapshot };
    setFocusEntries(prev => options?.replace ? [entry] : [...prev, entry]);
  }

  function exitFocus() {
    setFocusEntries(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const rest = prev.slice(0, -1);
      restoreSnapshot(last.snapshot);
      return rest;
    });
  }

  function exitAllFocus() {
    setFocusEntries(prev => {
      if (prev.length === 0) return prev;
      restoreSnapshot(prev[0].snapshot);
      return [];
    });
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

  function getEdgeIdsForRelation(relationMessageId: string) {
    return edges.filter(e => e.relationMessageId === relationMessageId).map(e => e.id);
  }

  function relationAllFragmentsSelected(relationMessageId: string, units: UnitSelection[]) {
    const edgeIds = getEdgeIdsForRelation(relationMessageId);
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
    const edgeIds = getEdgeIdsForRelation(relationMessageId);
    const edgeUnits = edgeIds.map(id => ({ messageId: relationMessageId, selection: { kind: "edge", edgeId: id } as Selection }));
    setDraftUnits(prev => {
      const hasWhole = prev.some(u => unitEquals(u, wholeUnit));
      if (hasWhole) return prev.filter(u => !(u.messageId === relationMessageId && (u.selection.kind === "whole" || u.selection.kind === "edge")));
      const merged = mergeUnits(prev, edgeUnits as UnitSelection[]);
      if (!merged.some(u => unitEquals(u, wholeUnit))) merged.push(wholeUnit);
      return merged;
    });
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
      for (const srcId of uniqueSources) {
        const targetRefs = toReply.map(t => unitSelectionToTargetRef(t, msgMap));
        try {
          const backendRel = await api.createRelation(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, targetRefs });
          const relId = backendRel.id;
          const relMsg: DemoMessage = { id: relId, author: backendRel.createdBy.username, createdAt: backendRel.createdAt, kind: "relation", content: `${relationType}: ${srcId} → ${toReply.map(t => t.messageId).join(",")}` };
          setMessages(prev => [...prev, relMsg]);
          for (const s of fromReply) {
            for (const t of toReply) {
              newEdgesList.push(buildEdges({ ...s }, { ...t }, "reply", label, relId));
            }
          }
          if (secondaryRelationType !== "none") {
            const secType = secondaryRelationType as RelationType;
            for (const s of sources) for (const t of targets) {
              newEdgesList.push(buildEdges({ ...s }, { ...t }, secType, label, relId));
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
            const relMsg: DemoMessage = { id: relId, author: backendRel.createdBy.username, createdAt: backendRel.createdAt, kind: "relation", content: `${relationType}: ${srcId} → ${uniqueTargetMids.join(",")}` };
            setMessages(prev => [...prev, relMsg]);
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
            const relMsg: DemoMessage = { id: relId, author: backendRel.createdBy.username, createdAt: backendRel.createdAt, kind: "relation", content: `${relationType}: (无来源消息) → ${targetMid}` };
            setMessages(prev => [...prev, relMsg]);
            const anonSrcId = `anon:${backendRel.id}`;
            newEdgesList.push(buildEdges({ messageId: anonSrcId, selection: { kind: "whole" } }, { messageId: targetMid, selection: { kind: "whole" } }, relationType, label, relId));
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
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
            const relMsg: DemoMessage = { id: relId, author: backendRel.createdBy.username, createdAt: backendRel.createdAt, kind: "relation", content: `${relationType}: ${srcId} → ${targets.map(t => t.messageId).join(",")}` };
            setMessages(prev => [...prev, relMsg]);
            for (const t of targets) {
              newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, relationType, label, relId));
            }
            if (secondaryRelationType !== "none") {
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

    // Scenario: source collection + target collection explicitly committed (no draft candidates).
    // Build the relation directly without creating a new text message.
    if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) {
      const labelDefault = relationTypeName(relationType);
      const label = relationLabel.trim() || labelDefault;
      await handleCreateRelationWithSourcesAndTargets({ sources: sourceUnits, targets: targetUnits, label });
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // Effective targets: candidates (draftUnits) if non-empty, else explicit target collection.
    // This lets users either click on the canvas to pick draft candidates (quick path) or
    // explicitly commit messages to the target collection via "加入目标集合".
    const effectiveTargets = draftUnits.length > 0 ? draftUnits : targetUnits;

    if (effectiveTargets.length === 0) return;
    const isAgreeDisagree = relationType === "agree" || relationType === "disagree";
    const isSupplement = relationType === "supplement";

    // Relation target with reply/correct: no text, no source — create null-source relation
    const hasDraftRelTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation');
    const hasSecSelector = (relationType === "reply" || relationType === "correct") && hasDraftRelTarget;
    if (hasSecSelector) {
      if (text.length > 0 || sourceUnits.length > 0) return; // validation: state must be clean

      // CORRECT targeting a relation message with a secondary relation type:
      // Create a new relation of the secondary type (with the same endpoints as the old relation),
      // then create a CORRECT relation pointing from the new relation to the old relation.
      if (relationType === "correct" && secondaryRelationType !== "none" && draftUnits.length === 1) {
        const targetRelMsgId = draftUnits[0].messageId;
        const oldRelEdges = edges.filter(e => e.relationMessageId === targetRelMsgId);
        if (oldRelEdges.length === 0) {
          alert(`无法找到目标关系消息的边（ID：${targetRelMsgId}），无法创建更正关系`);
          return;
        }
        const secType = secondaryRelationType as RelationType;
        const secTypeName = relationTypeName(secType);
        const oldSourceId = oldRelEdges[0].from.messageId;
        const newSourceId = oldSourceId.startsWith('anon:') ? null : oldSourceId;
        // Collect all unique target refs from the old relation's edges
        const newTargetRefs = uniqueTargetRefsFromEdges(oldRelEdges, msgMap);
        const newEdgesList: DemoEdge[] = [];
        try {
          // Step 1: Create the new relation of secondary type with the same endpoints
          const newRelBackend = await api.createRelation(topicId!, { relationType: secType.toUpperCase(), sourceMessageId: newSourceId, targetRefs: newTargetRefs });
          const newRelId = newRelBackend.id;
          const targetDisplayIds = newTargetRefs.map(targetRefDisplayId).join(",");
          const newRelMsg: DemoMessage = {
            id: newRelId, author: newRelBackend.createdBy.username, createdAt: newRelBackend.createdAt, kind: "relation",
            content: newSourceId
              ? `建立${secTypeName}关系\n来源：${newSourceId}\n目标：${targetDisplayIds}`
              : `建立${secTypeName}关系（无来源消息）\n目标：${targetDisplayIds}`,
          };
          setMessages(prev => [...prev, newRelMsg]);
          const newFromId = newSourceId ?? `anon:${newRelId}`;
          for (const e of oldRelEdges) {
            newEdgesList.push({ id: nextId("edge"), relationMessageId: newRelId, relationType: secType, from: { messageId: newFromId, selection: { kind: "whole" } }, to: { ...e.to }, relationLabel: secTypeName } as DemoEdge);
          }
          // Step 2: Create the CORRECT relation with the new relation as source, old relation as target
          const corrTypeName = relationTypeName("correct");
          const corrBackendRel = await api.createRelation(topicId!, { relationType: 'CORRECT', sourceMessageId: newRelId, targetRefs: [{ kind: 'relation', relationId: targetRelMsgId }] });
          const corrRelId = corrBackendRel.id;
          const corrRelMsg: DemoMessage = {
            id: corrRelId, author: corrBackendRel.createdBy.username, createdAt: corrBackendRel.createdAt, kind: "relation",
            content: `建立${corrTypeName}关系\n来源：${newRelId}\n目标：关系 ${targetRelMsgId}`,
          };
          setMessages(prev => [...prev, corrRelMsg]);
          newEdgesList.push({ id: nextId("edge"), relationMessageId: corrRelId, relationType: "correct", from: { messageId: newRelId, selection: { kind: "whole" } }, to: { messageId: targetRelMsgId, selection: { kind: "whole" } }, relationLabel: corrTypeName } as DemoEdge);
        } catch (e: any) { alert(`建立更正关系失败: ${e?.message ?? e}`); }
        setEdges(prev => [...prev, ...newEdgesList]);
        setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
        setRelationType(null); setSecondaryRelationType("none");
        return;
      }

      // REPLY or CORRECT (no secondary) targeting a relation message: create null-source relation
      const targetRefs = draftUnits.map(u => unitSelectionToTargetRef(u, msgMap));
      const typeName = relationTypeName(relationType);
      const newEdgesList: DemoEdge[] = [];
      try {
        const backendRel = await api.createRelation(topicId!, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs });
        const relId = backendRel.id;
        const relMsg: DemoMessage = { id: relId, author: backendRel.createdBy.username, createdAt: backendRel.createdAt, kind: "relation", content: `建立${typeName}关系（无来源消息）\n目标：${draftUnits.slice(0, 3).map(u => u.messageId).join(",") + (draftUnits.length > 3 ? "…" : "")}` };
        setMessages(prev => [...prev, relMsg]);
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

    if ((isAgreeDisagree || isSupplement) && text.length === 0) {
      // Pure-stance agree/disagree or no-source supplement: no text message.
      // Supplement: ONE relation message containing all targets in a single frame.
      // Agree/disagree: one relation message per target (separate decoration badges).
      // Relation messages are first-class messages — persist all of them to the backend.
      const newEdgesList: DemoEdge[] = [];
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      if (isSupplement) {
        const targetRefs = uniqueTargetMids.map(mid => unitSelectionToTargetRef({ messageId: mid, selection: { kind: "whole" } }, msgMap));
        try {
          const backendRel = await api.createRelation(topicId!, { relationType: 'SUPPLEMENT', sourceMessageId: null, targetRefs });
          const relId = backendRel.id;
          const typeName = relationTypeName("supplement");
          const relMsg: DemoMessage = { id: relId, author: backendRel.createdBy.username, createdAt: backendRel.createdAt, kind: "relation", content: `建立${typeName}关系（无来源消息）；类型：${typeName}` };
          setMessages(prev => [...prev, relMsg]);
          const anonSrcId = `anon:${backendRel.id}`;
          for (const tgtMid of uniqueTargetMids) {
            newEdgesList.push({
              id: nextId("edge"), relationMessageId: relId, relationType: "supplement",
              from: { messageId: anonSrcId, selection: { kind: "whole" } },
              to: { messageId: tgtMid, selection: { kind: "whole" } },
              relationLabel: typeName,
            } as DemoEdge);
          }
        } catch (e: any) { alert(`建立无来源补充关系失败: ${e?.message ?? e}`); }
      } else {
        // Agree/disagree: one relation per target — persist to backend
        for (const tgtMid of uniqueTargetMids) {
          const backendTargetRef = unitSelectionToTargetRef({ messageId: tgtMid, selection: { kind: "whole" } }, msgMap);
          try {
            const backendRel = await api.createRelation(topicId!, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [backendTargetRef] });
            const relId = backendRel.id;
            const relMsg: DemoMessage = { id: relId, author: backendRel.createdBy.username, createdAt: backendRel.createdAt, kind: "relation", content: `${relationType}: (无来源消息) → ${tgtMid}` };
            setMessages(prev => [...prev, relMsg]);
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
      const generated = generateCorrectionContent(effectiveTargets, text, msgMap);
      if (generated === null) {
        alert("更正关系目标必须是普通文本消息");
        return;
      }
      const msg = await handleSendMessageOnly(generated);
      if (!msg) return;
      const sources: UnitSelection[] = [{ messageId: msg.id, selection: { kind: "whole" } }];
      const targets: UnitSelection[] = [...effectiveTargets];
      await handleCreateRelationWithSourcesAndTargets({ sources, targets, label });
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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
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

  function getSelectedWholeMessageIds(): string[] {
    const ids = draftUnits.filter(u => u.selection.kind === "whole").map(u => u.messageId);
    return Array.from(new Set(ids));
  }

  const recentRelations = useMemo(() => messages.filter(m => m.kind === "relation").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5), [messages]);
  const recentNormals = useMemo(() => messages.filter(m => m.kind === "normal").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8), [messages]);

  const isAgreeDisagreeType = relationType === "agree" || relationType === "disagree";
  const isSupplementType = relationType === "supplement";

  // Whether any draft unit points to a relation message (vs. text message or fragment)
  const draftHasRelationTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation');

  // Additional relation selector: only show when draft targets include a relation message
  // and the primary relation type is reply or correct
  const hasSecondaryRelationSelector =
    (relationType === "reply" || relationType === "correct") && draftHasRelationTarget;

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
    if (draftHasRelationTarget && hasSecondaryRelationSelector) {
      return draftUnits.length > 0 && newMessageContent.trim().length === 0 && sourceUnits.length === 0;
    }
    const effectiveHasTargets = draftUnits.length > 0 || targetUnits.length > 0;
    if (isAgreeDisagreeType || isSupplementType) return effectiveHasTargets;
    // sourceUnits + targetUnits explicitly committed (no draft): relation can be built without new text
    if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) return true;
    return effectiveHasTargets && newMessageContent.trim().length > 0;
  })();

  // Dynamic label describing what the send button will do
  const singleButtonLabel = (() => {
    if (relationType === null) {
      if (newMessageContent.trim().length === 0) return "请输入消息内容后发送";
      return "仅发送这条消息（未选择关系类型）";
    }
    const typeName = relationTypeName(relationType);
    if (draftHasRelationTarget && hasSecondaryRelationSelector) {
      if (newMessageContent.trim().length > 0) return `请清空文本输入框（目标为关系消息时不应有文本）`;
      if (sourceUnits.length > 0) return `请清空来源集合（目标为关系消息时来源必须为空）`;
      const secLabel = secondaryRelationType === "none" ? "无" : relationTypeName(secondaryRelationType as RelationType);
      return `建立「${typeName}」关系（目标为关系消息，附加：${secLabel}）`;
    }
    const effectiveHasTargets = draftUnits.length > 0 || targetUnits.length > 0;
    const usingDraft = draftUnits.length > 0;
    if (isAgreeDisagreeType || isSupplementType) {
      if (!effectiveHasTargets) return "请在画布中选择目标消息";
      return newMessageContent.trim().length > 0
        ? `发送消息并建立「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标）`
        : `建立纯立场「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) {
      return `建立「${typeName}」关系（来源集合 → 目标集合）`;
    }
    if (!effectiveHasTargets) return "请在画布中选择目标消息";
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
    const sameKindTypes = ALL_RELATION_TYPES.filter(rt => getPresentationSpec(rt).kind === targetSpec.kind);
    return ['none', ...sameKindTypes];
  }, [relationType, draftUnits, targetUnits, edges, msgMap]);

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
      addEdgeAdj(e.from.messageId, e.to.messageId); addEdgeAdj(e.relationMessageId, e.from.messageId); addEdgeAdj(e.relationMessageId, e.to.messageId);
    }
    // When a relation message is the focus, use its connected normal (text) messages as BFS roots.
    // This ensures focusHop correctly measures distance from the relation's text messages,
    // so hop=0 shows only those text messages and hop=1 shows their 1-hop neighbors.
    const effectiveStartIds = new Set<string>();
    for (const id of startIds) {
      const m = msgMap.get(id);
      if (m && m.kind === "relation") {
        let foundNormal = false;
        for (const e of edges) {
          if (e.relationMessageId !== id) continue;
          const mf = msgMap.get(e.from.messageId), mt = msgMap.get(e.to.messageId);
          if (mf && mf.kind === "normal") { effectiveStartIds.add(e.from.messageId); foundNormal = true; }
          if (mt && mt.kind === "normal") { effectiveStartIds.add(e.to.messageId); foundNormal = true; }
        }
        // Fallback: relation has no connected normal messages (e.g. pure-stance with anon source);
        // keep the relation message itself as BFS root so focus mode still shows something.
        if (!foundNormal) effectiveStartIds.add(id);
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
    for (const rmId of relationMessagesToAdd) {
      if (!shownIds.has(rmId)) { const m = messages.find(x => x.id === rmId); if (m) messagesToShowArr.push(m); }
    }
    const shownSet = new Set(messagesToShowArr.map(m => m.id));
    const edgesToShowArr = edges.filter(e => shownSet.has(e.from.messageId) || shownSet.has(e.to.messageId) || shownSet.has(e.relationMessageId));
    return { messagesToShow: messagesToShowArr, edgesToShow: edgesToShowArr };
  }, [messages, edges, focusEntries, focusHop, msgMap]);

  const canSetFocus = (!!lastClickedMessageId && messages.some(m => m.id === lastClickedMessageId)) || getSelectedWholeMessageIds().length > 0;
  const canExitFocus = focusEntries.length > 0;

  function handleCanvasBlankClick() {
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection(); setLastClickedMessageId(null);
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
      const relMsg: DemoMessage = { id: relId, author: backendRel.createdBy.username, createdAt: backendRel.createdAt, kind: "relation", content: `${kind}: (无来源消息) → ${messageId}` };
      const anonSrcId = `anon:${backendRel.id}`;
      const edge: DemoEdge = { id: nextId("edge"), relationMessageId: relId, relationType: kind, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { messageId, selection: { kind: "whole" } }, relationLabel: relationTypeName(kind) };
      setMessages(prev => [...prev, relMsg]);
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
    // For summary (replace-overlay): show comparison popup
    const relEdges = edges.filter(ed => ed.relationMessageId === relMsgId);
    const relType = relEdges[0]?.relationType ?? "";
    const spec = getPresentationSpec(relType);
    if (spec.kind === 'replace-overlay') {
      setComparisonPopup({ relMsgId, x: e.clientX, y: e.clientY });
      return;
    }
    // For frame-group (classify/merge): enter focus mode
    enterFocus(relMsgId);
  }

  function handleInlineBadgeClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relMsgId);
    toggleWholeUnit(relMsgId);
  }

  function handleInlineBadgeDoubleClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    // Show operation details popup (reuse the comparison popup to show who operated, when, etc.)
    setComparisonPopup({ relMsgId, x: e.clientX, y: e.clientY });
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

  const messagesToRender = focusEntries.length > 0 ? messagesToShow : messages;
  const edgesToRender = focusEntries.length > 0 ? edgesToShow : edges;
  const isOwner = user && topic && (topic as any).author?.id === user.id;

  return (
    <>
    <div style={{ height: "100%", overflow: "hidden", margin: 0, display: "flex", flexDirection: "column", background: "#101010", color: "#eee", fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #333", background: "#181818", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontWeight: 600 }}>{topic?.title ?? "加载中…"}</span>
          {topic && <span style={{ fontSize: 11, opacity: 0.7, border: "1px solid #444", borderRadius: 4, padding: "1px 6px" }}>{topic.status}</span>}
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
              <button onClick={() => setViewMode(prev => prev === "list" ? "graph" : "list")} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                {viewMode === "list" ? "切换为结构图" : "切换为列表"}
              </button>
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {viewMode === "list" ? "线性视图：支持自由换行内容；双击 normal 进入文本选择模式；可点击高亮片段切换选中。" : "结构图：注释/引用 source 自动推到 target 右侧列（规则1）；label避让文字；高亮片段可点击。"}
            </div>
          </div>

          <div ref={leftPanelRef} style={{ flex: "1 1 auto", overflow: "auto", padding: 8, minHeight: 0 }}>
            {viewMode === "list" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {messagesToRender.map(msg => {
                  const isWholeSelected = draftUnits.some(u => u.messageId === msg.id && u.selection.kind === "whole");
                  const isActiveText = activeTextSelectId === msg.id;
                  return (
                    <div key={msg.id} data-msgid={msg.id} onClick={e => handleMessageClick(e, msg.id)} onDoubleClick={e => handleMessageDoubleClick(e, msg.id)} onMouseDown={e => handleMessageMouseDown(e, msg.id)} onMouseUp={e => handleMessageMouseUp(e, msg.id)}
                      style={{ borderRadius: 6, border: msg.kind === "relation" ? "1px solid #886400" : isActiveText ? "2px dashed #0b84ff" : isWholeSelected ? "2px solid #0b84ff" : "1px solid #444", background: msg.kind === "relation" ? "#232018" : "#1f1f1f", padding: "10px 14px", cursor: "pointer", fontSize: 13, outline: lastClickedMessageId === msg.id ? "1px dashed #0b84ff" : "none", userSelect: isActiveText ? "text" : "auto" }}>
                      <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
                        <span>{msg.kind === "relation" ? `关系消息 ${msg.id}` : `消息 ${msg.id}`}</span>
                        <span>作者：{msg.author}</span>
                      </div>
                      {isActiveText && msg.kind === "normal" && <div style={{ fontSize: 11, color: "#0b84ff", marginBottom: 4 }}>文本选择模式：拖选记录 start+len；或点击高亮片段</div>}
                      <div style={{ fontSize: 13, color: "#f5f5f5" }} onMouseUp={e => msg.kind === "normal" && handleTextMouseUp(e, msg.id)}>
                        {msg.kind === "normal" ? renderMessageContentWithAnchorsForList(msg) : <div style={{ whiteSpace: "pre-wrap", fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 12 }}>{msg.content}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <GraphView
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
                    <button onClick={exitFocus} disabled={!canExitFocus} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: canExitFocus ? "#444" : "#333", color: canExitFocus ? "#fff" : "#777", cursor: canExitFocus ? "pointer" : "default" }} title="退出最近一次进入的焦点并恢复进入该焦点前的现场">退出焦点</button>
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
              {hasSecondaryRelationSelector && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                  <span style={{ opacity: 0.85 }}>附加关系：</span>
                  {(relationType === "reply" ? ["none", "annotation", "reference"] : correctSecondaryOptions).map(t => (
                    <button key={t} onClick={() => setSecondaryRelationType(prev => (prev === t && t !== "none") ? "none" : t)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: secondaryRelationType === t ? "#0b84ff" : "#222", color: secondaryRelationType === t ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                      {t === "none" ? "无" : relationTypeName(t)}
                    </button>
                  ))}
                </div>
              )}
              <input style={{ width: "100%", padding: 4, borderRadius: 4, border: "1px solid #555", background: "#222", color: "#eee", fontSize: 12 }} placeholder={relationType === "annotation" ? "注释标签" : relationType === "reference" ? "引用标签" : relationType === "reply" ? "回复标签" : "关系标签"} value={relationLabel} onChange={e => setRelationLabel(e.target.value)} />
              <textarea
                style={{ width: "100%", minHeight: 80, maxHeight: 220, padding: 4, borderRadius: 4, border: "1px solid #555", background: draftHasRelationTarget && hasSecondaryRelationSelector ? "#1a1a1a" : "#222", color: draftHasRelationTarget && hasSecondaryRelationSelector ? "#666" : "#eee", fontSize: 13, resize: "vertical" }}
                placeholder={draftHasRelationTarget && hasSecondaryRelationSelector ? "目标为关系消息时，此处不应有内容" : "输入一条新普通消息（支持自由换行）"}
                value={newMessageContent}
                onChange={e => setNewMessageContent(e.target.value)}
              />
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
          )}

          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
            <div style={{ fontWeight: 600 }}>焦点</div>
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
    {comparisonPopup && (()=>{
      const relEdges = edges.filter(e => e.relationMessageId === comparisonPopup.relMsgId);
      const sourceMsg = relEdges[0] && !relEdges[0].from.messageId.startsWith('anon:')
        ? msgMap.get(relEdges[0].from.messageId) : null;
      const targetMids = Array.from(new Set(relEdges.map(e => e.to.messageId)));
      const targetMsgs = targetMids.map(id => msgMap.get(id)).filter((m): m is DemoMessage => m != null);
      const relType = relEdges[0]?.relationType ?? "";

      // CORRECT relation: side-by-side comparison with highlighting
      if (relType === "correct" && targetMsgs.length > 0 && sourceMsg) {
        const origMsg = targetMsgs[0];
        // Prefer precise position-based highlighting for single-fragment corrections:
        // The correction edge carries the exact text selection (start + len) in the
        // original message, so we can pinpoint the changed region without the LCS
        // algorithm incorrectly matching repeated substrings elsewhere in the text.
        // Fall back to LCS for whole-message corrections or edge cases.
        let origParts: DiffPart[];
        let nextParts: DiffPart[];
        const textEdge = relEdges.find(e => e.to.selection.kind === 'text');
        const textEdges = relEdges.filter(e => e.to.selection.kind === 'text');
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
