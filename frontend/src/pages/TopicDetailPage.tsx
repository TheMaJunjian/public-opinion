import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Topic, Message, Relation } from '../types';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import MessageCard from '../components/MessageCard';
import MessageThread from '../components/MessageThread';
import MessageForm from '../components/MessageForm';
import RelationForm from '../components/RelationForm';
import RelationBadge from '../components/RelationBadge';
import { buildMessageTree, computeStanceStats } from '../utils/graph';

/** 话题详情页：展示消息流与关系图谱，支持"线性"与"非线性"两种视图切换 */
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
  /** 视图模式：非线性树视图（默认）或线性时间轴 */
  const [viewMode, setViewMode] = useState<'tree' | 'linear'>('tree');

  const load = useCallback(async () => {
    if (!topicId) return;
    setLoading(true);
    setError('');
    try {
      const [topicRes, msgRes, relRes] = await Promise.all([
        api.getTopic(topicId),
        api.getMessages(topicId, { page: msgPage, limit: 20 }),
        api.getRelations(topicId, { limit: 50 }),
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

  // 构建非线性树结构与立场统计（仅 tree 视图使用）
  const messageTree = viewMode === 'tree' ? buildMessageTree(messages, relations) : [];
  const stanceStatsMap = computeStanceStats(messages, relations);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* 话题头部 */}
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

      <div className="flex gap-6">
        {/* 主区域：消息视图 */}
        <div className="flex-1 min-w-0">
          {/* 视图切换工具栏 */}
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500">
              共 {messages.length} 条观点 · {relations.length} 条关系
            </span>
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              <button
                onClick={() => setViewMode('tree')}
                className={`px-3 py-1.5 font-medium transition-colors ${
                  viewMode === 'tree'
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
                title="非线性树状视图：按关系结构展示讨论分支"
              >
                非线性视图
              </button>
              <button
                onClick={() => setViewMode('linear')}
                className={`px-3 py-1.5 font-medium transition-colors border-l border-gray-200 ${
                  viewMode === 'linear'
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
                title="线性时间轴视图：按发布时间顺序排列"
              >
                时间轴
              </button>
            </div>
          </div>

          {messages.length === 0 ? (
            <div className="text-center py-10 text-gray-400 bg-white border border-gray-200 rounded-lg">
              暂无观点，来第一个发言吧！
            </div>
          ) : viewMode === 'tree' ? (
            /* 非线性树视图 */
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
                /* 无树型关系时，降级为平铺卡片 */
                messages.map(msg => (
                  <MessageCard
                    key={msg.id}
                    message={msg}
                    topicId={topicId!}
                    stanceStats={stanceStatsMap.get(msg.id)}
                  />
                ))
              )}
            </div>
          ) : (
            /* 线性时间轴视图 */
            <div className="space-y-4">
              {messages.map(msg => (
                <MessageCard
                  key={msg.id}
                  message={msg}
                  topicId={topicId!}
                  stanceStats={stanceStatsMap.get(msg.id)}
                />
              ))}
            </div>
          )}

          {/* 分页 */}
          {msgTotalPages > 1 && (
            <div className="flex justify-center gap-3 mt-4">
              <button onClick={() => setMsgPage(p => Math.max(1, p - 1))} disabled={msgPage === 1}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50">← 上一页</button>
              <span className="text-sm text-gray-500">{msgPage} / {msgTotalPages}</span>
              <button onClick={() => setMsgPage(p => Math.min(msgTotalPages, p + 1))} disabled={msgPage === msgTotalPages}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50">下一页 →</button>
            </div>
          )}

          {/* 发言表单 */}
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

        {/* 侧边栏：关联图谱 */}
        <aside className="w-80 shrink-0 space-y-4">
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="flex border-b border-gray-200">
              <button
                onClick={() => setActiveTab('relations')}
                className={`flex-1 py-2.5 text-sm font-medium ${activeTab === 'relations' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                关联图谱 ({relations.length})
              </button>
              {user && topic.status === 'OPEN' && (
                <button
                  onClick={() => setActiveTab('addRelation')}
                  className={`flex-1 py-2.5 text-sm font-medium ${activeTab === 'addRelation' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-gray-500 hover:bg-gray-50'}`}
                >
                  + 添加关联
                </button>
              )}
            </div>
            <div className="p-4">
              {activeTab === 'relations' ? (
                relations.length === 0 ? (
                  <p className="text-sm text-gray-400">暂无关联</p>
                ) : (
                  <div className="space-y-2">
                    {relations.map(rel => {
                      const src = messages.find(m => m.id === rel.sourceMessageId);
                      const tgts = rel.targetRefs
                        .map(ref => messages.find(m => m.id === ref.targetMessageId))
                        .filter(Boolean);
                      return (
                        <div key={rel.id} className="text-xs text-gray-600 flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{src?.createdBy.username ?? '?'}</span>
                          <RelationBadge type={rel.relationType} />
                          {tgts.map(t => t && (
                            <span key={t.id} className="font-medium">{t.createdBy.username}</span>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                <RelationForm messages={messages} onSubmit={handleCreateRelation} />
              )}
            </div>
          </div>

          {/* 立场统计汇总 */}
          {messages.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">立场统计</h3>
              <div className="space-y-1.5">
                {messages.map(msg => {
                  const stats = stanceStatsMap.get(msg.id);
                  if (!stats || (stats.support === 0 && stats.oppose === 0)) return null;
                  const total = stats.support + stats.oppose;
                  const supportPct = total > 0 ? Math.round((stats.support / total) * 100) : 0;
                  return (
                    <div key={msg.id} className="text-xs">
                      <div className="text-gray-500 truncate mb-0.5">{msg.content.slice(0, 28)}…</div>
                      <div className="flex items-center gap-1">
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full bg-green-400 rounded-full"
                            style={{ width: `${supportPct}%` }}
                          />
                        </div>
                        <span className="text-green-600 w-8 text-right">{stats.support}↑</span>
                        <span className="text-red-500 w-8 text-right">{stats.oppose}↓</span>
                      </div>
                    </div>
                  );
                })}
                {messages.every(m => {
                  const s = stanceStatsMap.get(m.id);
                  return !s || (s.support === 0 && s.oppose === 0);
                }) && <p className="text-xs text-gray-400">尚无立场表达</p>}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
