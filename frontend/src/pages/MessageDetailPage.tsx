import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Message, Relation } from '../types';
import { api } from '../api';
import { computeStanceStats } from '../utils/graph';
import MessageCard from '../components/MessageCard';
import RelationView from '../components/RelationView';

/** 消息详情页：展示单条观点及其完整关联分析（非线性节点视图） */
export default function MessageDetailPage() {
  const { topicId, messageId } = useParams<{ topicId: string; messageId: string }>();
  const [message, setMessage] = useState<Message | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!topicId || !messageId) return;
    setLoading(true);
    Promise.all([
      api.getMessages(topicId, { limit: 50 }),
      api.getRelations(topicId, { limit: 50 }),
    ]).then(([msgRes, relRes]) => {
      setMessages(msgRes.data);
      setRelations(relRes.data);
      const found = msgRes.data.find(m => m.id === messageId);
      if (!found) throw new Error('观点不存在');
      setMessage(found);
    }).catch(err => {
      setError(err instanceof Error ? err.message : '加载失败');
    }).finally(() => {
      setLoading(false);
    });
  }, [topicId, messageId]);

  if (loading) return <div className="text-center py-20 text-gray-400">加载中…</div>;
  if (error) return <div className="text-center py-20 text-red-500">{error}</div>;
  if (!message) return null;

  const stanceStatsMap = computeStanceStats(messages, relations);

  // 与当前消息相关的其他节点
  const relatedIds = new Set<string>();
  relations
    .filter(r => r.sourceMessageId === messageId || r.targetRefs.some(ref => ref.targetMessageId === messageId))
    .forEach(r => {
      relatedIds.add(r.sourceMessageId);
      r.targetRefs.forEach(ref => relatedIds.add(ref.targetMessageId));
    });
  relatedIds.delete(messageId!);
  const relatedMessages = messages.filter(m => relatedIds.has(m.id));

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link to={`/topics/${topicId}`} className="text-sm text-indigo-600 hover:underline">
          ← 返回话题
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h2 className="text-base font-semibold text-gray-700 mb-3">节点详情</h2>
          <MessageCard
            message={message}
            topicId={topicId!}
            highlighted
            stanceStats={stanceStatsMap.get(message.id)}
          />
        </div>

        <div>
          <h2 className="text-base font-semibold text-gray-700 mb-3">关联分析</h2>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <RelationView
              messageId={messageId!}
              topicId={topicId!}
              relations={relations}
              messages={messages}
            />
          </div>
          {relatedMessages.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-gray-600 mb-2">相关节点</h3>
              <div className="space-y-2">
                {relatedMessages.map(m => (
                  <MessageCard
                    key={m.id}
                    message={m}
                    topicId={topicId!}
                    stanceStats={stanceStatsMap.get(m.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
