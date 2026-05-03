/**
 * TopicDetailPage.tsx — Main topic view integrating GraphView, DraftPanel, and list view.
 *
 * This page is the core of the public-opinion app. It integrates:
 *
 * 1. GRAPH VIEW (图视图)
 *    - SVG-based non-linear view with message cards + relation edges.
 *    - Clicking a card/label sends it to the Draft area.
 *
 * 2. TREE / LINEAR VIEW (树视图 / 时间轴)
 *    - Fallback linear views for browsing.
 *
 * 3. DRAFT PANEL (候选区 / 来源集合 / 目标集合)
 *    - Draft → Sources (text only) or Targets (any).
 *    - Sources + Targets + relation type → create relation.
 *
 * 4. FOCUS MODE
 *    - Filters to N hops from a focal message.
 *    - hop = text-message-to-text-message distance through relations.
 *
 * 5. IMPORT / EXPORT
 *    - JSON v2 format (no old format compatibility).
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Topic, Message, Relation, TargetRef } from '../types';
import { getPresentationSpec, PRESENTATION_SPECS } from '../types';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import GraphView from '../components/GraphView';
import MessageThread from '../components/MessageThread';
import InteractiveMessageList from '../components/InteractiveMessageList';
import RelationBadge from '../components/RelationBadge';
import DraftPanel, { type DraftItem } from '../components/DraftPanel';
import { buildMessageTree, computeStanceStats, buildFocusSubgraph } from '../utils/graph';

// ─── RelationItem sub-component ──────────────────────────────────────────────

function RelationItem({
  relation,
  messages,
  relations,
  isFiltered,
}: {
  relation: Relation;
  messages: Message[];
  relations: Relation[];
  isFiltered: boolean;
}) {
  const src = messages.find(m => m.id === relation.sourceMessageId);
  const spec = getPresentationSpec(relation.relationType);

  const targetLabels = relation.targetRefs.map((ref, i) => {
    if (ref.kind === 'message' || ref.kind === 'text-fragment') {
      const msg = messages.find(m => m.id === ref.messageId);
      if (!msg) return <span key={i} className="text-gray-400 text-xs">…</span>;
      return (
        <span key={i} className="font-medium text-gray-700">
          {msg.createdBy.username}
          {ref.kind === 'text-fragment' && (
            <em className="text-xs text-yellow-700 ml-1 bg-yellow-50 px-1 rounded">
              "{ref.text.slice(0, 15)}…"
            </em>
          )}
        </span>
      );
    }
    if (ref.kind === 'relation') {
      const rel = relations.find(r => r.id === ref.relationId);
      return (
        <span key={i} className="inline-flex items-center gap-1">
          <span className="text-gray-400 text-xs">关系:</span>
          {rel ? <RelationBadge type={rel.relationType} /> : <span className="text-gray-400 text-xs">?</span>}
          {ref.part && ref.part !== 'whole' && (
            <span className="text-gray-400 text-xs">.{ref.part}</span>
          )}
        </span>
      );
    }
    return null;
  });

  return (
    <div className={`text-xs flex flex-wrap items-center gap-1.5 py-1.5 ${isFiltered ? 'opacity-40' : ''}`}>
      <span className="font-medium text-gray-700">{src?.createdBy.username ?? '?'}</span>
      <RelationBadge type={relation.relationType} />
      {(spec.kind === 'edge-label' || spec.kind === 'edge-decoration') && (
        <span className="text-gray-400">→</span>
      )}
      {targetLabels}
    </div>
  );
}

// ─── Export / Import helpers ──────────────────────────────────────────────────

interface ExportData {
  version: 2;
  exportedAt: string;
  topic: { id: string; title: string; body?: string };
  messages: Message[];
  relations: Relation[];
}

function buildExportJson(topic: Topic, messages: Message[], relations: Relation[]): string {
  const data: ExportData = {
    version: 2,
    exportedAt: new Date().toISOString(),
    topic: { id: topic.id, title: topic.title, body: topic.body },
    messages,
    relations,
  };
  return JSON.stringify(data, null, 2);
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TopicDetailPage() {
  const { topicId } = useParams<{ topicId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [topic, setTopic] = useState<Topic | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msgPage, setMsgPage] = useState(1);
  const [msgTotalPages, setMsgTotalPages] = useState(1);

  const [viewMode, setViewMode] = useState<'graph' | 'tree' | 'linear'>('graph');
  const [relTab, setRelTab] = useState<'list' | 'legend'>('list');

  // Relation type (lifted to top-level, shown in toolbar + passed to DraftPanel)
  const [relationType, setRelationType] = useState('REPLY');

  // Focus mode (lifted to TopicDetailPage, controls passed to DraftPanel)
  const [focusMode, setFocusMode] = useState(false);
  const [focusMessageId, setFocusMessageId] = useState('');
  const [focusHops, setFocusHops] = useState(2);

  // Draft / Sources / Targets
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [sources, setSources] = useState<DraftItem[]>([]);
  const [targets, setTargets] = useState<DraftItem[]>([]);

  // ── Load ────────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!topicId) return;
    setLoading(true);
    setError('');
    try {
      const [topicRes, msgRes, relRes] = await Promise.all([
        api.getTopic(topicId),
        api.getMessages(topicId, { page: msgPage, limit: 50 }),
        api.getRelations(topicId, { limit: 200 }),
      ]);
      setTopic(topicRes);
      setMessages(msgRes.data);
      setMsgTotalPages(msgRes.pagination.totalPages);
      setRelations(relRes.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [topicId, msgPage]);

  useEffect(() => { load(); }, [load]);

  // ── Topic actions ───────────────────────────────────────────────────────────

  async function handleArchive() {
    if (!topic) return;
    await api.updateTopic(topicId!, { status: topic.status === 'OPEN' ? 'ARCHIVED' : 'OPEN' });
    await load();
  }

  async function handleDelete() {
    if (!confirm('确认删除该话题？此操作不可撤销。')) return;
    await api.deleteTopic(topicId!);
    navigate('/');
  }

  // ── Draft management ────────────────────────────────────────────────────────

  function handleClickMessage(id: string) {
    const existsIdx = draft.findIndex(d => d.type === 'message' && d.id === id);
    if (existsIdx >= 0) {
      setDraft(prev => prev.filter((_, i) => i !== existsIdx));
    } else {
      setDraft(prev => [...prev, { type: 'message', id }]);
    }
  }

  function handleClickRelation(id: string) {
    const existsIdx = draft.findIndex(d => d.type === 'relation' && d.id === id);
    if (existsIdx >= 0) {
      setDraft(prev => prev.filter((_, i) => i !== existsIdx));
    } else {
      setDraft(prev => [...prev, { type: 'relation', id, part: 'label' }]);
    }
  }

  function handleSelectFragment(messageId: string, text: string, hash: string) {
    // Toggle: if this exact fragment is already in draft, remove it; otherwise add
    const existsIdx = draft.findIndex(
      d => d.type === 'text-fragment' && d.messageId === messageId && d.text === text,
    );
    if (existsIdx >= 0) {
      setDraft(prev => prev.filter((_, i) => i !== existsIdx));
    } else {
      setDraft(prev => [...prev, { type: 'text-fragment', messageId, text, hash }]);
    }
  }

  function handleDraftRemove(idx: number) {
    setDraft(prev => prev.filter((_, i) => i !== idx));
  }

  function handleDraftRemoveBatch(indices: number[]) {
    const idxSet = new Set(indices);
    setDraft(prev => prev.filter((_, i) => !idxSet.has(i)));
  }

  function handleDraftToSources(idx: number) {
    const item = draft[idx];
    // Sources: only text messages (not relation messages, not text-fragments per design)
    if (item.type !== 'message') return;
    setSources([item]); // one source at a time
    setDraft(prev => prev.filter((_, i) => i !== idx));
  }

  function handleDraftToSourcesBatch(indices: number[]) {
    const idxSet = new Set(indices);
    const items = draft.filter((item, i) => idxSet.has(i) && item.type === 'message');
    if (items.length > 0) setSources([items[items.length - 1]]); // keep last (one source at a time)
    setDraft(prev => prev.filter((_, i) => !idxSet.has(i)));
  }

  function handleDraftToTargets(idx: number) {
    const item = draft[idx];
    // Check for duplicates by comparing type and id/messageId
    const isDuplicate = targets.some(t => {
      if (t.type !== item.type) return false;
      if (t.type === 'message' && item.type === 'message') return t.id === item.id;
      if (t.type === 'text-fragment' && item.type === 'text-fragment') return t.messageId === item.messageId && t.text === item.text;
      if (t.type === 'relation' && item.type === 'relation') return t.id === item.id;
      return false;
    });
    if (!isDuplicate) setTargets(prev => [...prev, item]);
    setDraft(prev => prev.filter((_, i) => i !== idx));
  }

  function handleDraftToTargetsBatch(indices: number[]) {
    const idxSet = new Set(indices);
    const newItems = draft.filter((item, i) => {
      if (!idxSet.has(i)) return false;
      return !targets.some(t => {
        if (t.type !== item.type) return false;
        if (t.type === 'message' && item.type === 'message') return t.id === item.id;
        if (t.type === 'text-fragment' && item.type === 'text-fragment') return t.messageId === item.messageId && t.text === item.text;
        if (t.type === 'relation' && item.type === 'relation') return t.id === item.id;
        return false;
      });
    });
    if (newItems.length > 0) setTargets(prev => [...prev, ...newItems]);
    setDraft(prev => prev.filter((_, i) => !idxSet.has(i)));
  }

  function handleDraftToTargetsAll() {
    const nonDuplicates = draft.filter(item => !targets.some(t => {
      if (t.type !== item.type) return false;
      if (t.type === 'message' && item.type === 'message') return t.id === item.id;
      if (t.type === 'text-fragment' && item.type === 'text-fragment') return t.messageId === item.messageId && t.text === item.text;
      if (t.type === 'relation' && item.type === 'relation') return t.id === item.id;
      return false;
    }));
    setTargets(prev => [...prev, ...nonDuplicates]);
    setDraft([]);
  }

  function handleSourcesRemove(idx: number) {
    setSources(prev => prev.filter((_, i) => i !== idx));
  }

  function handleTargetsRemove(idx: number) {
    setTargets(prev => prev.filter((_, i) => i !== idx));
  }

  function handleClearAll() {
    setDraft([]);
    setSources([]);
    setTargets([]);
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleSendMessage(content: string) {
    if (!topicId) return;
    await api.createMessage(topicId, { content });
    await load();
  }

  async function handleSendAndRelate(data: {
    relationType: string;
    newMessageContent: string;
    targetRefs: TargetRef[];
  }) {
    if (!topicId) return;
    const newMsg = await api.createMessage(topicId, { content: data.newMessageContent });
    await api.createRelation(topicId, {
      relationType: data.relationType,
      sourceMessageId: newMsg.id,
      targetRefs: data.targetRefs,
    });
    await load();
  }

  async function handleRelateOnly(data: {
    relationType: string;
    sourceMessageId: string;
    targetRefs: TargetRef[];
  }) {
    if (!topicId) return;
    await api.createRelation(topicId, {
      relationType: data.relationType,
      sourceMessageId: data.sourceMessageId,
      targetRefs: data.targetRefs,
    });
    await load();
  }

  // ── Import / Export ─────────────────────────────────────────────────────────

  function handleExport(): string {
    if (!topic) return '{}';
    return buildExportJson(topic, messages, relations);
  }

  function handleImport(json: string) {
    let data: ExportData;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('JSON 格式错误');
    }
    if (data.version !== 2) throw new Error('仅支持 version: 2 格式');
    alert(
      `导入预览：${data.messages?.length ?? 0} 条消息，${data.relations?.length ?? 0} 条关系\n` +
        `话题：${data.topic?.title ?? '未知'}\n\n⚠️ 后端批量导入 API 尚未实现，数据仅做预览。`,
    );
  }

  // ── Render guards ───────────────────────────────────────────────────────────

  if (loading) return <div className="text-center py-20 text-gray-400">加载中…</div>;
  if (error) return <div className="text-center py-20 text-red-500">{error}</div>;
  if (!topic) return null;

  const isOwner = user?.id === topic.createdBy.id;

  // ── Focus mode ──────────────────────────────────────────────────────────────
  let focusSubgraph: { visibleMessages: Set<string>; visibleRelations: Set<string> } | null = null;
  if (focusMode && focusMessageId) {
    focusSubgraph = buildFocusSubgraph(messages, relations, new Set([focusMessageId]), focusHops);
  }

  const visibleMessages = focusSubgraph
    ? messages.filter(m => focusSubgraph!.visibleMessages.has(m.id))
    : messages;
  const visibleRelations = focusSubgraph
    ? relations.filter(r => focusSubgraph!.visibleRelations.has(r.id))
    : relations;

  // ── Selection sets for graph highlighting ────────────────────────────────────
  const selectedMessageIds = new Set<string>([
    ...draft.filter((d): d is Extract<DraftItem, { type: 'message' }> => d.type === 'message').map(d => d.id),
    ...sources.filter((d): d is Extract<DraftItem, { type: 'message' }> => d.type === 'message').map(d => d.id),
    ...targets.filter((d): d is Extract<DraftItem, { type: 'message' }> => d.type === 'message').map(d => d.id),
  ]);
  const selectedRelationIds = new Set<string>([
    ...draft.filter((d): d is Extract<DraftItem, { type: 'relation' }> => d.type === 'relation').map(d => d.id),
    ...targets.filter((d): d is Extract<DraftItem, { type: 'relation' }> => d.type === 'relation').map(d => d.id),
  ]);

  // ── Tree building ───────────────────────────────────────────────────────────
  const messageTree = viewMode === 'tree' ? buildMessageTree(visibleMessages, visibleRelations) : [];
  const stanceStatsMap = computeStanceStats(visibleMessages, visibleRelations);

  // ── Relations for sidebar ────────────────────────────────────────────────────
  const filteredOutRelations =
    focusMode && focusSubgraph
      ? relations.filter(r => !focusSubgraph!.visibleRelations.has(r.id))
      : [];

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6">
      {/* Topic header */}
      <div className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h1 className="text-2xl font-bold text-gray-900">{topic.title}</h1>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  topic.status === 'OPEN' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {topic.status === 'OPEN' ? '进行中' : '已归档'}
              </span>
            </div>
            {topic.body && <p className="text-gray-600 text-sm">{topic.body}</p>}
            <p className="text-xs text-gray-400 mt-1">
              由 <span className="font-medium text-gray-600">{topic.createdBy.username}</span> 发起
              · {new Date(topic.createdAt).toLocaleDateString('zh-CN')}
            </p>
          </div>
          {isOwner && (
            <div className="flex gap-2 shrink-0">
              <button
                onClick={handleArchive}
                className="text-sm px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 text-gray-600"
              >
                {topic.status === 'OPEN' ? '归档' : '重开'}
              </button>
              <button
                onClick={handleDelete}
                className="text-sm px-3 py-1.5 border border-red-300 text-red-600 rounded hover:bg-red-50"
              >
                删除
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="mb-4 space-y-3">
        {/* Row 1: Stats + view mode + focus indicator */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-gray-500">
            {focusMode && focusSubgraph
              ? `◎ 焦点模式：${visibleMessages.length}/${messages.length} 条`
              : `${messages.length} 条消息 · ${relations.length} 条关系`}
          </span>

          {/* View mode toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            {(
              [
                { key: 'graph',  label: '图视图',  title: '非线性图视图（message cards + relation edges）' },
                { key: 'tree',   label: '树视图',  title: '非线性树视图' },
                { key: 'linear', label: '列表视图', title: '线性列表视图（带交互选择）' },
              ] as const
            ).map(({ key, label, title }, i) => (
              <button
                key={key}
                onClick={() => setViewMode(key)}
                title={title}
                className={`px-3 py-1.5 font-medium transition-colors ${i > 0 ? 'border-l border-gray-200' : ''} ${
                  viewMode === key ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Row 2: Relation type buttons */}
        <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-200 rounded-lg px-3 py-2">
          <span className="text-xs font-medium text-gray-500 shrink-0">关系类型</span>
          <div className="flex flex-wrap gap-1">
            {Object.entries(PRESENTATION_SPECS)
              .filter(([, s]) =>
                s.kind === 'edge-label' ||
                s.kind === 'edge-decoration' ||
                s.kind === 'decoration',
              )
              .map(([key, s]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRelationType(key)}
                  title={`${s.label} · ${s.kind}`}
                  className={`text-xs px-2 py-0.5 rounded border font-medium transition-all ${
                    relationType === key
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600'
                  }`}
                >
                  {s.label}
                </button>
              ))}
          </div>
          {(() => {
            const spec = getPresentationSpec(relationType);
            return (
              <span className="text-xs text-gray-400 ml-1">
                {spec.kind === 'edge-label' ? '连接+标签' :
                  spec.kind === 'edge-decoration' ? '连接+装饰' :
                  spec.kind === 'decoration' ? '装饰' : spec.kind}
                {spec.stanceEffect ? ` · ${spec.stanceEffect === 'support' ? '✓支持' : '✗反对'}` : ''}
              </span>
            );
          })()}
          <span className="text-xs text-gray-300 ml-auto hidden sm:block">焦点/候选/建关系等控制在右侧面板</span>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex gap-5 items-start">

        {/* Message view (left) — min-height matches viewport so content doesn't look cramped */}
        <div className="flex-1 min-w-0 space-y-4" style={{ minHeight: 'calc(100vh - 220px)' }}>

          {visibleMessages.length === 0 ? (
            <div className="text-center py-10 text-gray-400 bg-white border border-gray-200 rounded-lg">
              {focusMode ? '焦点范围内暂无消息' : '暂无观点，来第一个发言吧！'}
            </div>
          ) : viewMode === 'graph' ? (
            <GraphView
              messages={visibleMessages}
              relations={visibleRelations}
              stanceStatsMap={stanceStatsMap}
              selectedMessageIds={selectedMessageIds}
              selectedRelationIds={selectedRelationIds}
              focusVisibleMessages={focusSubgraph?.visibleMessages ?? null}
              focusVisibleRelations={focusSubgraph?.visibleRelations ?? null}
              onClickMessage={handleClickMessage}
              onClickRelation={handleClickRelation}
              onSelectFragment={handleSelectFragment}
            />
          ) : viewMode === 'tree' ? (
            <div className="space-y-3">
              {messageTree.length > 0
                ? messageTree.map(node => (
                    <MessageThread
                      key={node.message.id}
                      node={node}
                      topicId={topicId!}
                      stanceStatsMap={stanceStatsMap}
                      depth={0}
                    />
                  ))
                : (
                  <InteractiveMessageList
                    messages={visibleMessages}
                    relations={visibleRelations}
                    stanceStatsMap={stanceStatsMap}
                    selectedMessageIds={selectedMessageIds}
                    selectedRelationIds={selectedRelationIds}
                    onClickMessage={handleClickMessage}
                    onClickRelation={handleClickRelation}
                    onSelectFragment={handleSelectFragment}
                  />
                )}
            </div>
          ) : (
            /* Linear list view — interactive */
            <InteractiveMessageList
              messages={visibleMessages}
              relations={visibleRelations}
              stanceStatsMap={stanceStatsMap}
              selectedMessageIds={selectedMessageIds}
              selectedRelationIds={selectedRelationIds}
              onClickMessage={handleClickMessage}
              onClickRelation={handleClickRelation}
              onSelectFragment={handleSelectFragment}
            />
          )}

          {/* Pagination (tree/linear only) */}
          {msgTotalPages > 1 && viewMode !== 'graph' && !focusMode && (
            <div className="flex justify-center gap-3">
              <button
                onClick={() => setMsgPage(p => Math.max(1, p - 1))}
                disabled={msgPage === 1}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
              >
                ← 上一页
              </button>
              <span className="text-sm text-gray-500">{msgPage} / {msgTotalPages}</span>
              <button
                onClick={() => setMsgPage(p => Math.min(msgTotalPages, p + 1))}
                disabled={msgPage === msgTotalPages}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
              >
                下一页 →
              </button>
            </div>
          )}

          {/* New message form - moved to right panel */}
          {!user && (
            <p className="text-center text-sm text-gray-400 py-4">
              <a href="/login" className="text-indigo-600 hover:underline">登录</a> 后参与讨论
            </p>
          )}
        </div>

        {/* Right panel — wider than default to match demo layout */}
        <div className="shrink-0 space-y-4" style={{ width: 400 }}>

          {/* Draft + Action panel */}
          {user && topic.status === 'OPEN' && (
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
                <span className="text-indigo-600">⊕</span> 消息与关系操作
              </h3>
              <DraftPanel
                messages={messages}
                relations={relations}
                draft={draft}
                sources={sources}
                targets={targets}
                onDraftRemove={handleDraftRemove}
                onDraftRemoveBatch={handleDraftRemoveBatch}
                onDraftToSources={handleDraftToSources}
                onDraftToSourcesBatch={handleDraftToSourcesBatch}
                onDraftToTargets={handleDraftToTargets}
                onDraftToTargetsBatch={handleDraftToTargetsBatch}
                onDraftToTargetsAll={handleDraftToTargetsAll}
                onSourcesRemove={handleSourcesRemove}
                onTargetsRemove={handleTargetsRemove}
                onClearAll={handleClearAll}
                onSendMessage={handleSendMessage}
                onSendAndRelate={handleSendAndRelate}
                onRelateOnly={handleRelateOnly}
                onImport={handleImport}
                onExport={handleExport}
                relationType={relationType}
                onRelationTypeChange={setRelationType}
                focusMode={focusMode}
                focusMessageId={focusMessageId}
                focusHops={focusHops}
                onFocusToggle={() => { setFocusMode(f => !f); if (focusMode) setFocusMessageId(''); }}
                onFocusMessageChange={setFocusMessageId}
                onFocusHopsChange={setFocusHops}
                onFocusExit={() => setFocusMessageId('')}
                onFocusExitAll={() => { setFocusMode(false); setFocusMessageId(''); }}
                recentTextMessages={[...messages].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5)}
                recentRelations={[...relations].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5)}
              />
            </div>
          )}

          {/* Relations list */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="flex border-b border-gray-200">
              <button
                onClick={() => setRelTab('list')}
                className={`flex-1 py-2.5 text-sm font-medium ${
                  relTab === 'list'
                    ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500'
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                关系列表 ({relations.length})
              </button>
              <button
                onClick={() => setRelTab('legend')}
                className={`flex-1 py-2.5 text-sm font-medium ${
                  relTab === 'legend'
                    ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500'
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                类型图例
              </button>
            </div>

            <div className="p-3">
              {relTab === 'list' ? (
                relations.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-3">暂无关系</p>
                ) : (
                  <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
                    {visibleRelations.map(rel => (
                      <RelationItem
                        key={rel.id}
                        relation={rel}
                        messages={messages}
                        relations={relations}
                        isFiltered={false}
                      />
                    ))}
                    {filteredOutRelations.length > 0 && (
                      <>
                        <div className="pt-2 pb-1">
                          <span className="text-xs text-gray-400">
                            焦点范围外（{filteredOutRelations.length}条）：
                          </span>
                        </div>
                        {filteredOutRelations.slice(0, 5).map(rel => (
                          <RelationItem
                            key={rel.id}
                            relation={rel}
                            messages={messages}
                            relations={relations}
                            isFiltered={true}
                          />
                        ))}
                        {filteredOutRelations.length > 5 && (
                          <p className="text-xs text-gray-400 pt-1">
                            还有 {filteredOutRelations.length - 5} 条…
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(PRESENTATION_SPECS).map(([type, spec]) => (
                      <div key={type} title={`显示形式：${spec.kind}`}>
                        <RelationBadge type={type} />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-gray-500">
                    <p><span className="font-medium">→</span> 连接线+标签</p>
                    <p><span className="font-medium">⇒</span> 连接线+装饰</p>
                    <p><span className="font-medium">◆</span> 消息装饰</p>
                    <p><span className="font-medium">★</span> 内联标记</p>
                    <p><span className="font-medium">↺</span> 替换覆盖</p>
                    <p><span className="font-medium">⬡</span> 分组框架</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Stance statistics */}
          {visibleMessages.some(m => {
            const s = stanceStatsMap.get(m.id);
            return s && (s.support > 0 || s.oppose > 0);
          }) && (
            <div className="bg-white border border-gray-200 rounded-lg p-3">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">立场统计</h3>
              <div className="space-y-1.5">
                {visibleMessages.map(msg => {
                  const stats = stanceStatsMap.get(msg.id);
                  if (!stats || (stats.support === 0 && stats.oppose === 0)) return null;
                  const total = stats.support + stats.oppose;
                  const supportPct = total > 0 ? Math.round((stats.support / total) * 100) : 0;
                  return (
                    <div key={msg.id} className="text-xs">
                      <div className="text-gray-500 truncate mb-0.5">
                        {msg.content.slice(0, 28)}…
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full bg-green-400 rounded-full"
                            style={{ width: `${supportPct}%` }}
                          />
                        </div>
                        <span className="text-green-600 w-8 text-right">▲{stats.support}</span>
                        <span className="text-red-500 w-8 text-right">▼{stats.oppose}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
