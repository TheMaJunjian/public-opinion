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
import MessageCard from '../components/MessageCard';
import MessageForm from '../components/MessageForm';
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

  // Focus mode
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

  async function handleCreateMessage(data: Parameters<typeof api.createMessage>[1]) {
    await api.createMessage(topicId!, data);
    await load();
  }

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

  /** Called when user selects a text fragment from a message card (double-click mode) */
  function handleAddTextFragment(messageId: string, text: string, hash: string) {
    // Check if this exact fragment is already in draft (same messageId + same hash)
    const exists = draft.some(d => d.type === 'text-fragment' && d.id === messageId && d.hash === hash);
    if (!exists) {
      setDraft(prev => [...prev, { type: 'text-fragment', id: messageId, text, hash }]);
    }
  }

  function handleDraftRemove(idx: number) {
    setDraft(prev => prev.filter((_, i) => i !== idx));
  }

  function handleDraftToSources(idx: number) {
    const item = draft[idx];
    // Sources: text messages and their fragments only
    if (item.type !== 'message' && item.type !== 'text-fragment') return;
    setSources([item]); // one source at a time
    setDraft(prev => prev.filter((_, i) => i !== idx));
  }

  function handleDraftToTargets(idx: number) {
    const item = draft[idx];
    // Deduplicate by type + id, and for text-fragments also by hash to allow different fragments from same message
    const exists = targets.some(t => {
      if (t.type !== item.type || t.id !== item.id) return false;
      if (item.type === 'text-fragment') return t.hash === item.hash;
      return true;
    });
    if (!exists) setTargets(prev => [...prev, item]);
    setDraft(prev => prev.filter((_, i) => i !== idx));
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

  // ── Create relation ─────────────────────────────────────────────────────────

  async function handleCreateRelation(data: {
    relationType: string;
    sourceMessageId: string;
    targetRefs: TargetRef[];
    newMessageContent?: string;
  }) {
    if (!topicId) return;

    let sourceId = data.sourceMessageId;
    if (data.newMessageContent) {
      const newMsg = await api.createMessage(topicId, { content: data.newMessageContent });
      sourceId = newMsg.id;
    }
    if (!sourceId) throw new Error('来源消息 ID 为空');

    await api.createRelation(topicId, {
      relationType: data.relationType,
      sourceMessageId: sourceId,
      targetRefs: data.targetRefs,
    });

    await load();
  }

  /** Workflow: send message only without creating a relation */
  async function handleSendMessage(content: string) {
    if (!topicId) return;
    await api.createMessage(topicId, { content });
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
    ...draft.filter(d => d.type === 'message').map(d => d.id),
    ...sources.map(d => d.id),
    ...targets.filter(d => d.type === 'message').map(d => d.id),
  ]);
  const selectedRelationIds = new Set<string>([
    ...draft.filter(d => d.type === 'relation').map(d => d.id),
    ...targets.filter(d => d.type === 'relation').map(d => d.id),
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
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-sm text-gray-500 mr-1">
          {focusMode && focusSubgraph
            ? `焦点模式：${visibleMessages.length}/${messages.length} 条`
            : `${messages.length} 条消息 · ${relations.length} 条关系`}
        </span>

        {/* View mode toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
          {(
            [
              { key: 'graph',  label: '图视图',  title: '非线性图视图（message cards + relation edges）' },
              { key: 'tree',   label: '树视图',  title: '非线性树视图' },
              { key: 'linear', label: '时间轴',  title: '线性时间轴视图' },
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

        {/* Focus mode toggle */}
        <button
          onClick={() => { setFocusMode(f => !f); if (focusMode) setFocusMessageId(''); }}
          className={`px-3 py-1.5 text-sm font-medium rounded border transition-colors ${
            focusMode
              ? 'bg-amber-100 text-amber-700 border-amber-300'
              : 'text-gray-500 border-gray-200 hover:bg-gray-50'
          }`}
        >
          {focusMode ? '◎ 焦点模式' : '○ 焦点模式'}
        </button>
      </div>

      {/* Focus controls */}
      {focusMode && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm font-medium text-amber-800">焦点消息</label>
            <select
              value={focusMessageId}
              onChange={e => setFocusMessageId(e.target.value)}
              className="flex-1 min-w-0 border border-amber-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              <option value="">选择焦点消息…</option>
              {messages.map(m => (
                <option key={m.id} value={m.id}>
                  [{m.createdBy.username}] {m.content.slice(0, 40)}{m.content.length > 40 ? '…' : ''}
                </option>
              ))}
            </select>
            <label className="text-sm font-medium text-amber-800 shrink-0">跳数</label>
            <select
              value={focusHops}
              onChange={e => setFocusHops(Number(e.target.value))}
              className="border border-amber-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <p className="text-xs text-amber-600">
            hop = 文本消息之间经过的关系消息数；仅显示焦点消息 {focusHops} 跳以内的消息与关系。
          </p>
        </div>
      )}

      {/* Main layout */}
      <div className="flex gap-5 items-start">

        {/* Message view (left) */}
        <div className="flex-1 min-w-0 space-y-4">

          {visibleMessages.length === 0 ? (
            <div className="text-center py-10 text-gray-400 bg-white border border-gray-200 rounded-lg">
              {focusMode ? '焦点范围内暂无消息' : '暂无观点，来第一个发言吧！'}
            </div>
          ) : viewMode === 'graph' ? (
            <div>
              <p className="text-xs text-gray-400 mb-2">
                单击消息卡片加入候选区；双击进入文本选择模式（拖选片段后点击"加入候选"）；单击关系标签加入候选区。
              </p>
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
                onAddTextFragment={handleAddTextFragment}
              />
            </div>
          ) : viewMode === 'tree' ? (
            <div className="space-y-3">
              {viewMode === 'tree' && user && (
                <p className="text-xs text-gray-400">点击消息卡片将其加入候选区</p>
              )}
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
                : visibleMessages.map(msg => (
                    <MessageCard
                      key={msg.id}
                      message={msg}
                      topicId={topicId!}
                      stanceStats={stanceStatsMap.get(msg.id)}
                      onClick={user ? () => handleClickMessage(msg.id) : undefined}
                      isSelected={selectedMessageIds.has(msg.id)}
                    />
                  ))}
            </div>
          ) : (
            <div className="space-y-3">
              {user && (
                <p className="text-xs text-gray-400">点击消息卡片将其加入候选区</p>
              )}
              {visibleMessages.map(msg => (
                <MessageCard
                  key={msg.id}
                  message={msg}
                  topicId={topicId!}
                  stanceStats={stanceStatsMap.get(msg.id)}
                  onClick={user ? () => handleClickMessage(msg.id) : undefined}
                  isSelected={selectedMessageIds.has(msg.id)}
                />
              ))}
            </div>
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

          {/* New message form */}
          {user && topic.status === 'OPEN' && (
            <div className="mt-2">
              <MessageForm onSubmit={handleCreateMessage} />
            </div>
          )}
          {!user && (
            <p className="text-center text-sm text-gray-400 py-4">
              <a href="/login" className="text-indigo-600 hover:underline">登录</a> 后参与讨论
            </p>
          )}
        </div>

        {/* Right panel */}
        <div className="shrink-0 space-y-4" style={{ width: 300 }}>

          {/* Draft + Create relation panel */}
          {user && topic.status === 'OPEN' && (
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
                <span className="text-indigo-600">⊕</span> 关系操作
              </h3>
              <DraftPanel
                messages={messages}
                relations={relations}
                draft={draft}
                sources={sources}
                targets={targets}
                onDraftRemove={handleDraftRemove}
                onDraftToSources={handleDraftToSources}
                onDraftToTargets={handleDraftToTargets}
                onSourcesRemove={handleSourcesRemove}
                onTargetsRemove={handleTargetsRemove}
                onClearAll={handleClearAll}
                onCreateRelation={handleCreateRelation}
                onSendMessage={topic.status === 'OPEN' ? handleSendMessage : undefined}
                onImport={handleImport}
                onExport={handleExport}
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
