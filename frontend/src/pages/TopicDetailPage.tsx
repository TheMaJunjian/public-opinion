import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { convertMessagesToDemoModel, unitSelectionToTargetRef } from '../utils/modelBridge';
import type {
  DemoMessage, DemoEdge, UnitSelection, Selection,
  RelationType, SecondaryRelationType,
} from '../utils/modelBridge';
import type { Topic } from '../types';
import GraphView, { clearBrowserSelection, extractTextTargetsForMessage, relationTypeName, getSelectionFragment } from '../components/GraphView';

// ========================= Helpers =========================

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

// ========================= StructureView / IncomingOutgoingList =========================

function fmtSel(u: UnitSelection) {
  if (u.selection.kind === "whole") return `${u.messageId}`;
  if (u.selection.kind === "edge") return `${u.messageId}(@edge:${u.selection.edgeId})`;
  return `${u.messageId}(start=${u.selection.start},len=${u.selection.len})`;
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
      <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0 }}>
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

  const [relationType, setRelationType] = useState<RelationType>("annotation");
  const [secondaryRelationType, setSecondaryRelationType] = useState<SecondaryRelationType>("none");
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
            if (e.relationType === "support" || e.relationType === "agree") res[mid].agreeCount++;
            if (e.relationType === "rebut" || e.relationType === "disagree") res[mid].disagreeCount++;
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
  const lastAddedFragmentRef = useRef<{ messageId: string; unit: UnitSelection; time: number } | null>(null);
  const mouseDownRef = useRef<{ x: number; y: number; messageId: string | null } | null>(null);
  const lastDragOrSelectTimeRef = useRef<number>(0);
  const lastClickActionsRef = useRef<{ type: "toggleWhole"; messageId: string; prevExisted: boolean; time: number }[]>([]);

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

  async function handleSendMessageOnly(): Promise<DemoMessage | null> {
    const text = newMessageContent;
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
      setNewMessageContent("");
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
    const { sources, targets, label } = params;
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
      const uniqueSources = Array.from(new Set(fromReply.filter(s => !s.messageId.startsWith("rel:")).map(s => s.messageId)));
      for (const srcId of uniqueSources) {
        const targetRefs = toReply.map(t => unitSelectionToTargetRef(t));
        try {
          const backendRel = await api.createRelation(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, targetRefs });
          const relId = `rel:${backendRel.id}`;
          const relMsg: DemoMessage = { id: relId, author: "System", createdAt: backendRel.createdAt, kind: "relation", content: `${relationType}: ${srcId} → ${toReply.map(t => t.messageId).join(",")}` };
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
    } else if (relationType === "agree" || relationType === "disagree" || relationType === "support" || relationType === "rebut") {
      const decKind = (relationType === "disagree" || relationType === "rebut") ? "disagree" : "agree";
      const uniqueSources = Array.from(new Set(sources.filter(s => !s.messageId.startsWith("rel:")).map(s => s.messageId)));
      for (const srcId of uniqueSources) {
        const targetRefs = targets.map(t => unitSelectionToTargetRef(t));
        try {
          const backendRel = await api.createRelation(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, targetRefs });
          const relId = `rel:${backendRel.id}`;
          const relMsg: DemoMessage = { id: relId, author: "System", createdAt: backendRel.createdAt, kind: "relation", content: `${relationType}: ${srcId} → ${targets.map(t => t.messageId).join(",")}` };
          setMessages(prev => [...prev, relMsg]);
          for (const s of sources) {
            for (const t of targets) {
              const targetMid = t.messageId;
              newEdgesList.push(buildEdges({ ...s }, { messageId: targetMid, selection: { kind: "edge", edgeId: `dec:${decKind}:${targetMid}` } }, relationType, label, relId));
            }
          }
        } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
      }
    } else {
      const uniqueSources = Array.from(new Set(sources.filter(s => !s.messageId.startsWith("rel:")).map(s => s.messageId)));
      for (const srcId of uniqueSources) {
        const srcs = sources.filter(s => s.messageId === srcId);
        for (const srcUnit of srcs) {
          const targetRefs = targets.map(t => unitSelectionToTargetRef(t));
          try {
            const backendRel = await api.createRelation(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, targetRefs });
            const relId = `rel:${backendRel.id}`;
            const relMsg: DemoMessage = { id: relId, author: "System", createdAt: backendRel.createdAt, kind: "relation", content: `${relationType}: ${srcId} → ${targets.map(t => t.messageId).join(",")}` };
            setMessages(prev => [...prev, relMsg]);
            for (const t of targets) {
              newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, relationType, label, relId));
            }
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
      }
    }
    setEdges(prev => [...prev, ...newEdgesList]);
  }

  async function handleCreateRelation(useNewMessageAsSource: boolean) {
    if (targetUnits.length === 0) return;
    if (!useNewMessageAsSource && sourceUnits.length === 0) return;
    if (useNewMessageAsSource && newMessageContent.trim().length === 0) return;
    const labelDefault = relationTypeName(relationType);
    const label = relationLabel.trim() || labelDefault;
    let sources: UnitSelection[] = [];
    if (useNewMessageAsSource) {
      const msg = await handleSendMessageOnly();
      if (!msg) return;
      sources = [{ messageId: msg.id, selection: { kind: "whole" } }];
    } else {
      sources = [...sourceUnits];
    }
    const targets = [...targetUnits];
    await handleCreateRelationWithSourcesAndTargets({ sources, targets, label });
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  }

  async function handleQuickSendAndRelateFromDraftTargets() {
    if (newMessageContent.trim().length === 0 || draftUnits.length === 0) return;
    const labelDefault = relationTypeName(relationType);
    const label = relationLabel.trim() || labelDefault;
    const msg = await handleSendMessageOnly();
    if (!msg) return;
    const sources: UnitSelection[] = [{ messageId: msg.id, selection: { kind: "whole" } }];
    const targets: UnitSelection[] = [...draftUnits];
    await handleCreateRelationWithSourcesAndTargets({ sources, targets, label });
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
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

  function getSelectedWholeMessageIds(): string[] {
    const ids = draftUnits.filter(u => u.selection.kind === "whole").map(u => u.messageId);
    return Array.from(new Set(ids));
  }

  const recentRelations = useMemo(() => messages.filter(m => m.kind === "relation").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5), [messages]);
  const recentNormals = useMemo(() => messages.filter(m => m.kind === "normal").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8), [messages]);

  const quickButtonEnabled = newMessageContent.trim().length > 0 && draftUnits.length > 0;

  function renderMessageContentWithAnchorsForList(message: DemoMessage) {
    const targets = extractTextTargetsForMessage(message.id, edges);
    if (targets.length === 0) return <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{message.content}</pre>;
    const text = message.content;
    const segs: { start: number; end: number; relationType: RelationType }[] = [];
    let lastEnd = -1;
    for (const t of targets) {
      const start = t.start; const end = t.start + t.len;
      if (start < 0 || end > text.length || t.len <= 0 || start < lastEnd) continue;
      segs.push({ start, end, relationType: t.relationType }); lastEnd = end;
    }
    const nodes: React.ReactNode[] = []; let cursor = 0;
    for (const s of segs) {
      if (cursor < s.start) nodes.push(<span key={`t-${cursor}`}>{text.slice(cursor, s.start)}</span>);
      const frag = text.slice(s.start, s.end), isAnno = s.relationType === "annotation", len = s.end - s.start;
      const selected = isFragmentSelected(message.id, s.start, len, frag);
      nodes.push(
        <span key={`h-${s.start}-${s.end}`} onClick={e => { e.stopPropagation(); handleFragmentAnchorClick(message.id, s.start, len, frag); }}
          style={{ cursor: "pointer", backgroundColor: selected ? "rgba(11,132,255,0.18)" : isAnno ? "rgba(255,255,0,0.12)" : "rgba(80,180,255,0.08)", outline: selected ? "2px solid rgba(11,132,255,0.95)" : isAnno ? "1px solid rgba(255,255,0,0.8)" : "1px solid rgba(80,180,255,0.45)", borderRadius: 2, whiteSpace: "pre-wrap" }}
          title="点击：进入文本选择状态并切换选中该片段">{frag}</span>
      );
      cursor = s.end;
    }
    if (cursor < text.length) nodes.push(<span key={`t-${cursor}`}>{text.slice(cursor)}</span>);
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
    const effectiveStartIds = new Set<string>(startIds);
    if (focusHop === 0) {
      for (const id of startIds) {
        const m = msgMap.get(id);
        if (m && m.kind === "relation") {
          for (const e of edges) {
            if (e.relationMessageId !== id) continue;
            const mf = msgMap.get(e.from.messageId), mt = msgMap.get(e.to.messageId);
            if (mf && mf.kind === "normal") effectiveStartIds.add(e.from.messageId);
            if (mt && mt.kind === "normal") effectiveStartIds.add(e.to.messageId);
          }
        }
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

  function handleDecorationClick(messageId: string, kind: "agree" | "disagree") {
    const now = new Date().toISOString();
    const msg: DemoMessage = { id: nextId("msg"), author: user?.username ?? "You", createdAt: now, content: kind === "agree" ? "赞同" : "反对", kind: "normal" };
    const relMsgId = nextId("rel");
    const relMsg: DemoMessage = { id: relMsgId, author: "System", createdAt: now, kind: "relation", content: `${msg.id} ${relationTypeName(kind)} ${messageId}` };
    const edge: DemoEdge = { id: nextId("edge"), relationMessageId: relMsg.id, relationType: kind, from: { messageId: msg.id, selection: { kind: "whole" } }, to: { messageId, selection: { kind: "edge", edgeId: `dec:${kind}:${messageId}` } }, relationLabel: relationTypeName(kind) };
    setMessages(prev => [...prev, msg, relMsg]);
    setEdges(prev => [...prev, edge]);
  }

  async function handleArchiveTopic() {
    if (!topicId || !topic) return;
    try {
      const updated = await api.updateTopic(topicId, { status: topic.status === 'ARCHIVED' ? 'OPEN' : 'ARCHIVED' });
      setTopic(updated);
    } catch (e: any) { alert(`操作失败: ${e?.message ?? e}`); }
  }

  async function handleDeleteTopic() {
    if (!topicId || !confirm('确定要删除这个话题吗？')) return;
    try {
      await api.deleteTopic(topicId);
      navigate('/');
    } catch (e: any) { alert(`删除失败: ${e?.message ?? e}`); }
  }

  if (loading) {
    return <div style={{ padding: 16, background: "#101010", color: "#eee", height: "calc(100vh - 56px)" }}>加载中…</div>;
  }
  if (loadError) {
    return (
      <div style={{ padding: 16, background: "#101010", color: "#eee", height: "calc(100vh - 56px)" }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>加载失败</div>
        <pre style={{ whiteSpace: "pre-wrap", color: "#ff8080" }}>{loadError}</pre>
      </div>
    );
  }

  const messagesToRender = focusEntries.length > 0 ? messagesToShow : messages;
  const edgesToRender = focusEntries.length > 0 ? edgesToShow : edges;
  const isOwner = user && topic && (topic as any).author?.id === user.id;

  return (
    <div style={{ height: "calc(100vh - 56px)", margin: 0, display: "flex", flexDirection: "column", background: "#101010", color: "#eee", fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif" }}>
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
          {(["annotation", "reference", "reply", "agree", "disagree", "support", "rebut"] as RelationType[]).map(rt => (
            <button key={rt} onClick={() => { setRelationType(rt); setSecondaryRelationType("none"); }}
              style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: relationType === rt ? "#0b84ff" : "#222", color: relationType === rt ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
              {relationTypeName(rt)}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 2, borderRight: "1px solid #333", display: "flex", flexDirection: "column", minWidth: 0 }}>
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

          <div ref={leftPanelRef} style={{ flex: "1 1 auto", overflow: "auto", padding: 8 }}>
            {viewMode === "list" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {messagesToRender.map(msg => {
                  const isWholeSelected = draftUnits.some(u => u.messageId === msg.id && u.selection.kind === "whole");
                  const isActiveText = activeTextSelectId === msg.id;
                  return (
                    <div key={msg.id} onClick={e => handleMessageClick(e, msg.id)} onDoubleClick={e => handleMessageDoubleClick(e, msg.id)} onMouseDown={e => handleMessageMouseDown(e, msg.id)} onMouseUp={e => handleMessageMouseUp(e, msg.id)}
                      style={{ borderRadius: 6, border: msg.kind === "relation" ? "1px solid #886400" : isActiveText ? "2px dashed #0b84ff" : isWholeSelected ? "2px solid #0b84ff" : "1px solid #444", background: msg.kind === "relation" ? "#232018" : "#1f1f1f", padding: 8, cursor: "pointer", fontSize: 13, outline: lastClickedMessageId === msg.id ? "1px dashed #0b84ff" : "none", userSelect: isActiveText ? "text" : "auto" }}>
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
              <div style={{ minHeight: 900 }}>
                <GraphView
                  messages={messagesToRender} edges={edgesToRender} draftUnits={draftUnits}
                  activeTextSelectId={activeTextSelectId} lastClickedMessageId={lastClickedMessageId}
                  onMessageClick={handleMessageClick} onMessageDoubleClick={handleMessageDoubleClick}
                  onTextMouseUp={handleTextMouseUp} onEdgeLabelSingleClick={handleEdgeLabelSingleClick}
                  onEdgeLabelDoubleClick={handleEdgeLabelDoubleClick} onFragmentAnchorClick={handleFragmentAnchorClick}
                  isFragmentSelected={isFragmentSelected} onCanvasBlankClick={handleCanvasBlankClick}
                  onMessageMouseDown={handleMessageMouseDown} onMessageMouseUp={handleMessageMouseUp}
                  voteStats={voteStats} onDecorationClick={handleDecorationClick}
                />
              </div>
            )}
          </div>
        </div>

        <div ref={rightPanelRef} style={{ flex: 2, padding: 8, display: "flex", flexDirection: "column", gap: 8, overflow: "auto", minWidth: 0 }}>
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
              {relationType === "reply" && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                  <span style={{ opacity: 0.85 }}>附加关系：</span>
                  {(["none", "annotation", "reference"] as SecondaryRelationType[]).map(t => (
                    <button key={t} onClick={() => setSecondaryRelationType(t)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: secondaryRelationType === t ? "#0b84ff" : "#222", color: secondaryRelationType === t ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                      {t === "none" ? "无" : t === "annotation" ? "注释" : "引用"}
                    </button>
                  ))}
                </div>
              )}
              <input style={{ width: "100%", padding: 4, borderRadius: 4, border: "1px solid #555", background: "#222", color: "#eee", fontSize: 12 }} placeholder={relationType === "annotation" ? "注释标签" : relationType === "reference" ? "引用标签" : relationType === "reply" ? "回复标签" : "关系标签"} value={relationLabel} onChange={e => setRelationLabel(e.target.value)} />
              <textarea style={{ width: "100%", minHeight: 90, maxHeight: 220, padding: 4, borderRadius: 4, border: "1px solid #555", background: "#222", color: "#eee", fontSize: 13, resize: "vertical" }} placeholder="输入一条新普通消息（支持自由换行）" value={newMessageContent} onChange={e => setNewMessageContent(e.target.value)} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => handleSendMessageOnly()} disabled={newMessageContent.trim().length === 0} style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #666", background: newMessageContent.trim().length === 0 ? "#333" : "#444", color: newMessageContent.trim().length === 0 ? "#777" : "#fff", cursor: newMessageContent.trim().length === 0 ? "default" : "pointer", fontSize: 12 }}>仅发送消息</button>
                <button onClick={handleQuickSendAndRelateFromDraftTargets} disabled={!quickButtonEnabled} style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #666", background: !quickButtonEnabled ? "#333" : "#0b84ff", color: !quickButtonEnabled ? "#777" : "#fff", cursor: !quickButtonEnabled ? "default" : "pointer", fontSize: 12 }} title="文本框作为来源（整条），候选区作为目标">发送消息并建立关系（用候选作目标）</button>
                <button onClick={() => handleCreateRelation(true)} disabled={newMessageContent.trim().length === 0 || targetUnits.length === 0} style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #666", background: newMessageContent.trim().length === 0 || targetUnits.length === 0 ? "#333" : "#444", color: newMessageContent.trim().length === 0 || targetUnits.length === 0 ? "#777" : "#fff", cursor: newMessageContent.trim().length === 0 || targetUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>发送新消息并建立关系（Targets集合）</button>
                <button onClick={() => handleCreateRelation(false)} disabled={sourceUnits.length === 0 || targetUnits.length === 0} style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #666", background: sourceUnits.length === 0 || targetUnits.length === 0 ? "#333" : "#444", color: sourceUnits.length === 0 || targetUnits.length === 0 ? "#777" : "#fff", cursor: sourceUnits.length === 0 || targetUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>仅用已有消息建立关系（Sources/Targets集合）</button>
              </div>
            </div>
          )}

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

          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
            <div style={{ fontWeight: 600 }}>焦点</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>当前焦点：{currentFocusIds ? currentFocusIds.join(", ") : "（无）"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
