/**
 * TopicDetailPage.tsx — Main topic view with graph, focus mode, and relation management.
 *
 * ============================================================
 * Architecture overview
 * ============================================================
 *
 * This page is the core of the public-opinion app. It integrates:
 *
 * 1. MESSAGE VIEW (tree / linear)
 *    - Tree view: relations with formsTrees=true create a parent-child hierarchy.
 *    - Linear view: messages in chronological order.
 *
 * 2. RELATION DISPLAY
 *    Relations are rendered according to their PresentationSpec:
 *    - edge-label / edge-decoration: displayed as a sidebar list with source→target
 *    - decoration: shown as stance badges on message cards
 *    - Other kinds: partially implemented, extensible
 *
 * 3. FOCUS MODE
 *    When enabled, filters to only show text messages within N hops of the
 *    selected focus message. Hop = one relation step between text messages.
 *    Relations are shown only when both their text-message endpoints are visible.
 *    (See buildFocusSubgraph() in graph.ts for the algorithm.)
 *
 * 4. RELATION FORM
 *    Allows creating relations with:
 *    - Source: text message only (per design spec)
 *    - Target: text message, text fragment, OR relation message (bug fix)
 *
 * ============================================================
 * Key bug fix
 * ============================================================
 * OLD: targetRefs used { targetMessageId } — always resolved to a text message.
 * NEW: targetRefs use { kind: 'message'|'text-fragment'|'relation', ... }
 *      When targeting a relation, the target correctly resolves to the
 *      RELATION MESSAGE ITSELF, not the text messages it connects.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Topic, Message, Relation } from '../types';
import { getPresentationSpec, PRESENTATION_SPECS } from '../types';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import MessageCard from '../components/MessageCard';
import MessageThread from '../components/MessageThread';
import MessageForm from '../components/MessageForm';
import RelationForm from '../components/RelationForm';
import RelationBadge from '../components/RelationBadge';
import { buildMessageTree, computeStanceStats, buildFocusSubgraph } from '../utils/graph';

// ============================================================
// Sub-components
// ============================================================

/** Inline display of a single relation (for the relations sidebar list) */
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

  // Render target refs inline
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
    <div className={`text-xs flex flex-wrap items-center gap-1.5 py-1 ${isFiltered ? 'opacity-40' : ''}`}>
      <span className="font-medium text-gray-700">{src?.createdBy.username ?? '?'}</span>
      <RelationBadge type={relation.relationType} />
      {targetLabels}
      {spec.kind === 'edge-label' || spec.kind === 'edge-decoration' ? (
        <span className="text-gray-400">→</span>
      ) : null}
    </div>
  );
}

// ============================================================
// Main Page Component
// ============================================================

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
  const [activeTab, setActiveTab] = useState<'relations' | 'addRelation'>('relations');
  const [viewMode, setViewMode] = useState<'tree' | 'linear'>('tree');

  // ── Focus mode state ──────────────────────────────────────
  const [focusMode, setFocusMode] = useState(false);
  const [focusMessageId, setFocusMessageId] = useState<string>('');
  const [focusHops, setFocusHops] = useState(2);

  const load = useCallback(async () => {
    if (!topicId) return;
    setLoading(true);
    setError('');
    try {
      const [topicRes, msgRes, relRes] = await Promise.all([
        api.getTopic(topicId),
        api.getMessages(topicId, { page: msgPage, limit: 20 }),
        api.getRelations(topicId, { limit: 100 }),
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

  async function handleCreateMessage(data: Parameters<typeof api.createMessage>[1]) {
    await api.createMessage(topicId!, data);
    await load();
  }

  async function handleCreateRelation(data: Parameters<typeof api.createRelation>[1]) {
    await api.createRelation(topicId!, data);
    await load();
    setActiveTab('relations');
  }

  async function handleArchive() {
    if (!topic) return;
    await api.updateTopic(topicId!, { status: topic.status === 'OPEN' ? 'ARCHIVED' : 'OPEN' });
    await load();
  }

  async function handleDelete() {
    if (!confirm('确认删除该话题？')) return;
    await api.deleteTopic(topicId!);
    navigate('/');
  }

  if (loading) return <div className="text-center py-20 text-gray-400">加载中…</div>;
  if (error) return <div className="text-center py-20 text-red-500">{error}</div>;
  if (!topic) return null;

  const isOwner = user?.id === topic.createdBy.id;

  // ── Focus mode filtering ──────────────────────────────────
  let visibleMessages = messages;
  let visibleRelations = relations;
  let focusSubgraph: { visibleMessages: Set<string>; visibleRelations: Set<string> } | null = null;

  if (focusMode && focusMessageId) {
    focusSubgraph = buildFocusSubgraph(
      messages,
      relations,
      new Set([focusMessageId]),
      focusHops,
    );
    visibleMessages = messages.filter(m => focusSubgraph!.visibleMessages.has(m.id));
    visibleRelations = relations.filter(r => focusSubgraph!.visibleRelations.has(r.id));
  }

  // ── Tree building + stats ─────────────────────────────────
  const messageTree = viewMode === 'tree' ? buildMessageTree(visibleMessages, visibleRelations) : [];
  const stanceStatsMap = computeStanceStats(visibleMessages, visibleRelations);

  // ── Relations sidebar categorization ─────────────────────
  // Non-tree relations to show in the sidebar (with relation-as-target highlight)
  const sidebarRelations = visibleRelations.filter(r => {
    const spec = getPresentationSpec(r.relationType);
    return spec.kind !== 'decoration'; // decorations are shown on message cards via stanceStats
  });
  // All filtered-out relations (for dimmed display in focus mode)
  const filteredOutRelations = focusMode && focusSubgraph
    ? relations.filter(r => !focusSubgraph!.visibleRelations.has(r.id))
    : [];

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Topic header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-gray-900">{topic.title}</h1>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                topic.status === 'OPEN' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
              }`}>
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
              <button onClick={handleArchive}
                className="text-sm px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 text-gray-600">
                {topic.status === 'OPEN' ? '归档' : '重开'}
              </button>
              <button onClick={handleDelete}
                className="text-sm px-3 py-1.5 border border-red-300 text-red-600 rounded hover:bg-red-50">
                删除
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-6">
        {/* Main area: message view */}
        <div className="flex-1 min-w-0">
          {/* Toolbar */}
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <span className="text-sm text-gray-500">
              {focusMode && focusSubgraph
                ? `焦点模式：显示 ${visibleMessages.length}/${messages.length} 条消息`
                : `共 ${messages.length} 条观点 · ${relations.length} 条关系`}
            </span>

            <div className="flex items-center gap-2">
              {/* View mode toggle */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                <button onClick={() => setViewMode('tree')}
                  className={`px-3 py-1.5 font-medium transition-colors ${
                    viewMode === 'tree' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'
                  }`} title="非线性树状视图">
                  非线性视图
                </button>
                <button onClick={() => setViewMode('linear')}
                  className={`px-3 py-1.5 font-medium transition-colors border-l border-gray-200 ${
                    viewMode === 'linear' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'
                  }`} title="线性时间轴">
                  时间轴
                </button>
              </div>

              {/* Focus mode toggle */}
              <button
                onClick={() => { setFocusMode(f => !f); if (focusMode) setFocusMessageId(''); }}
                className={`px-3 py-1.5 text-sm font-medium rounded border transition-colors ${
                  focusMode
                    ? 'bg-amber-100 text-amber-700 border-amber-300'
                    : 'text-gray-500 border-gray-200 hover:bg-gray-50'
                }`}
                title="焦点模式：只显示与焦点消息相关的子图"
              >
                {focusMode ? '◎ 焦点模式' : '○ 焦点模式'}
              </button>
            </div>
          </div>

          {/* Focus mode controls */}
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
                <label className="text-sm font-medium text-amber-800">跳数 (hop)</label>
                <select
                  value={focusHops}
                  onChange={e => setFocusHops(Number(e.target.value))}
                  className="border border-amber-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                >
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <p className="text-xs text-amber-600">
                hop = 文本消息之间经过的关系消息数。仅显示在焦点消息 {focusHops} 跳以内的消息与关系。
              </p>
            </div>
          )}

          {/* Message list */}
          {visibleMessages.length === 0 ? (
            <div className="text-center py-10 text-gray-400 bg-white border border-gray-200 rounded-lg">
              {focusMode ? '焦点范围内暂无消息' : '暂无观点，来第一个发言吧！'}
            </div>
          ) : viewMode === 'tree' ? (
            <div className="space-y-4">
              {messageTree.length > 0 ? (
                messageTree.map(node => (
                  <MessageThread
                    key={node.message.id}
                    node={node}
                    topicId={topicId!}
                    stanceStatsMap={stanceStatsMap}
                    depth={0}
                  />
                ))
              ) : (
                visibleMessages.map(msg => (
                  <MessageCard key={msg.id} message={msg} topicId={topicId!}
                    stanceStats={stanceStatsMap.get(msg.id)} />
                ))
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {visibleMessages.map(msg => (
                <MessageCard key={msg.id} message={msg} topicId={topicId!}
                  stanceStats={stanceStatsMap.get(msg.id)} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {msgTotalPages > 1 && !focusMode && (
            <div className="flex justify-center gap-3 mt-4">
              <button onClick={() => setMsgPage(p => Math.max(1, p - 1))} disabled={msgPage === 1}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50">← 上一页</button>
              <span className="text-sm text-gray-500">{msgPage} / {msgTotalPages}</span>
              <button onClick={() => setMsgPage(p => Math.min(msgTotalPages, p + 1))} disabled={msgPage === msgTotalPages}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50">下一页 →</button>
            </div>
          )}

          {/* Post new message */}
          {user && topic.status === 'OPEN' && (
            <div className="mt-6">
              <MessageForm onSubmit={handleCreateMessage} />
            </div>
          )}
          {!user && (
            <p className="text-center text-sm text-gray-400 py-4">
              <a href="/login" className="text-indigo-600 hover:underline">登录</a> 后参与讨论
            </p>
          )}
        </div>

        {/* Sidebar */}
        <aside className="w-80 shrink-0 space-y-4">
          {/* Relations panel */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="flex border-b border-gray-200">
              <button onClick={() => setActiveTab('relations')}
                className={`flex-1 py-2.5 text-sm font-medium ${activeTab === 'relations' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-gray-500 hover:bg-gray-50'}`}>
                关系列表 ({relations.length})
              </button>
              {user && topic.status === 'OPEN' && (
                <button onClick={() => setActiveTab('addRelation')}
                  className={`flex-1 py-2.5 text-sm font-medium ${activeTab === 'addRelation' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-gray-500 hover:bg-gray-50'}`}>
                  + 添加关系
                </button>
              )}
            </div>
            <div className="p-4">
              {activeTab === 'relations' ? (
                relations.length === 0 ? (
                  <p className="text-sm text-gray-400">暂无关系</p>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {/* Visible relations in focus mode */}
                    {sidebarRelations.map(rel => (
                      <RelationItem
                        key={rel.id}
                        relation={rel}
                        messages={messages}
                        relations={relations}
                        isFiltered={false}
                      />
                    ))}
                    {/* Dimmed filtered-out relations in focus mode */}
                    {filteredOutRelations.length > 0 && (
                      <>
                        <div className="pt-2 pb-1">
                          <span className="text-xs text-gray-400">焦点范围外的关系（{filteredOutRelations.length}条）：</span>
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
                          <p className="text-xs text-gray-400 pt-1">还有 {filteredOutRelations.length - 5} 条…</p>
                        )}
                      </>
                    )}
                  </div>
                )
              ) : (
                <RelationForm
                  messages={messages}
                  relations={relations}
                  onSubmit={handleCreateRelation}
                />
              )}
            </div>
          </div>

          {/* Stance statistics */}
          {visibleMessages.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">立场统计</h3>
              <div className="space-y-1.5">
                {visibleMessages.map(msg => {
                  const stats = stanceStatsMap.get(msg.id);
                  if (!stats || (stats.support === 0 && stats.oppose === 0)) return null;
                  const total = stats.support + stats.oppose;
                  const supportPct = total > 0 ? Math.round((stats.support / total) * 100) : 0;
                  return (
                    <div key={msg.id} className="text-xs">
                      <div className="text-gray-500 truncate mb-0.5">{msg.content.slice(0, 28)}…</div>
                      <div className="flex items-center gap-1">
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                          <div className="h-full bg-green-400 rounded-full" style={{ width: `${supportPct}%` }} />
                        </div>
                        <span className="text-green-600 w-8 text-right">▲{stats.support}</span>
                        <span className="text-red-500 w-8 text-right">▼{stats.oppose}</span>
                      </div>
                    </div>
                  );
                })}
                {visibleMessages.every(m => {
                  const s = stanceStatsMap.get(m.id);
                  return !s || (s.support === 0 && s.oppose === 0);
                }) && <p className="text-xs text-gray-400">尚无立场表达</p>}
              </div>
            </div>
          )}

          {/* Relation types legend */}
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">关系类型图例</h3>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(PRESENTATION_SPECS).map(type => (
                <RelationBadge key={type} type={type} />
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
