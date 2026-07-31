import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { Message, User } from '../types';

export default function UserPage() {
  const { userId } = useParams<{ userId: string }>();
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contextMessages, setContextMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    setError(null);
    Promise.all([api.getUser(userId), api.getUserMessages(userId, { limit: 200 })])
      .then(([profile, result]) => {
        setUser(profile);
        setMessages(result.data);
        setContextMessages((result as typeof result & { context?: Message[] }).context ?? []);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '用户页加载失败'));
  }, [userId]);

  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!user) return <div className="p-6 text-gray-500">加载用户页...</div>;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5">
      <header className="border-b border-gray-200 pb-4">
        <div className="text-xs text-gray-500">用户页 · 过滤视图</div>
        <h1 className="text-2xl font-semibold text-gray-900">{user.username}</h1>
        <div className="text-xs text-gray-500 mt-1">用户 ID：{user.id}</div>
        <div className="text-sm text-gray-600 mt-3">显示该用户发送的消息及其必要上下文，本人消息 {messages.length} 条，关联消息 {contextMessages.length} 条</div>
      </header>
      <div className="space-y-3">
        {messages.map(message => (
          <article key={message.id} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
              <span>{message.kind}</span>
              <span>{new Date(message.createdAt).toLocaleString('zh-CN')}</span>
            </div>
            <div className="whitespace-pre-wrap text-sm text-gray-800">{message.content || '（无内容）'}</div>
            <Link className="inline-block mt-3 text-xs text-indigo-600 hover:underline" to={`/topics/${message.topicId}`}>
              查看所在分类
            </Link>
          </article>
        ))}
        {contextMessages.map(message => (
          <article key={`context-${message.id}`} className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
              <span>关联上下文 · {message.kind}</span>
              <span>{new Date(message.createdAt).toLocaleString('zh-CN')}</span>
            </div>
            <div className="whitespace-pre-wrap text-sm text-gray-800">{message.content || '（无内容）'}</div>
            <Link className="inline-block mt-3 text-xs text-indigo-600 hover:underline" to={`/topics/${message.topicId}`}>
              查看所在分类
            </Link>
          </article>
        ))}
        {messages.length === 0 && <div className="text-sm text-gray-500">该用户尚未发送消息。</div>}
      </div>
    </div>
  );
}
