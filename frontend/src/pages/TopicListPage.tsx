import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Topic } from '../types';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import TopicCard from '../components/TopicCard';

export default function TopicListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const fetchTopics = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getTopics({ query: query || undefined, page, limit: 10 });
      setTopics(res.data);
      setTotalPages(res.pagination.totalPages);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [query, page]);

  useEffect(() => { fetchTopics(); }, [fetchTopics]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchTopics();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) { setCreateError('请输入话题标题'); return; }
    setCreateError('');
    setCreating(true);
    try {
      const topic = await api.createTopic({ title: newTitle.trim(), body: newBody.trim() || undefined });
      setShowCreateForm(false);
      setNewTitle('');
      setNewBody('');
      navigate(`/topics/${topic.id}`);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">话题广场</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            非线性表显示和交互系统 · 消息是节点，关系也是消息
          </p>
        </div>
        {user && (
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            + 发起话题
          </button>
        )}
      </div>

      {showCreateForm && (
        <form onSubmit={handleCreate} className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-6">
          <h3 className="text-base font-semibold text-gray-800 mb-3">发起新话题</h3>
          {createError && <p className="text-red-500 text-sm mb-2">{createError}</p>}
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="话题标题（必填）"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <textarea
            value={newBody}
            onChange={e => setNewBody(e.target.value)}
            placeholder="话题描述（可选）"
            rows={3}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
          />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => { setShowCreateForm(false); setCreateError(''); }}
              className="px-4 py-1.5 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-100"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={creating}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-5 py-1.5 rounded text-sm font-medium"
            >
              {creating ? '创建中…' : '创建话题'}
            </button>
          </div>
        </form>
      )}

      <form onSubmit={handleSearch} className="flex gap-2 mb-6">
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setPage(1); }}
          placeholder="搜索话题…"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        <button
          type="submit"
          className="bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"
        >
          搜索
        </button>
      </form>

      {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

      {loading ? (
        <div className="text-center py-12 text-gray-400">加载中…</div>
      ) : topics.length === 0 ? (
        <div className="text-center py-12 text-gray-400">暂无话题</div>
      ) : (
        <div className="space-y-3">
          {topics.map(topic => <TopicCard key={topic.id} topic={topic} />)}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
          >
            ← 上一页
          </button>
          <span className="text-sm text-gray-500">{page} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
          >
            下一页 →
          </button>
        </div>
      )}
    </div>
  );
}
