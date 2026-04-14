import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Topic, Message, Relation } from '../types';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import MessageCard from '../components/MessageCard';
import MessageForm from '../components/MessageForm';
import RelationForm from '../components/RelationForm';
import RelationBadge from '../components/RelationBadge';

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

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
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
        {/* Main: Messages */}
        <div className="flex-1 min-w-0 space-y-4">
          {messages.length === 0 ? (
            <div className="text-center py-10 text-gray-400 bg-white border border-gray-200 rounded-lg">
              暂无观点，来第一个发言吧！
            </div>
          ) : (
            messages.map(msg => <MessageCard key={msg.id} message={msg} topicId={topicId!} />)
          )}

          {msgTotalPages > 1 && (
            <div className="flex justify-center gap-3 mt-4">
              <button onClick={() => setMsgPage(p => Math.max(1, p - 1))} disabled={msgPage === 1}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50">← 上一页</button>
              <span className="text-sm text-gray-500">{msgPage} / {msgTotalPages}</span>
              <button onClick={() => setMsgPage(p => Math.min(msgTotalPages, p + 1))} disabled={msgPage === msgTotalPages}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50">下一页 →</button>
            </div>
          )}

          {user && topic.status === 'OPEN' && (
            <MessageForm onSubmit={handleCreateMessage} />
          )}
          {!user && (
            <p className="text-center text-sm text-gray-400 py-4">
              <a href="/login" className="text-indigo-600 hover:underline">登录</a> 后参与讨论
            </p>
          )}
        </div>

        {/* Sidebar: Relations */}
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
                      const tgts = rel.targetRefs.map(ref => messages.find(m => m.id === ref.targetMessageId)).filter(Boolean);
                      return (
                        <div key={rel.id} className="text-xs text-gray-600 flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{src?.createdBy.username ?? '?'}</span>
                          <RelationBadge type={rel.relationType} />
                          {tgts.map(t => t && <span key={t.id} className="font-medium">{t.createdBy.username}</span>)}
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
        </aside>
      </div>
    </div>
  );
}
