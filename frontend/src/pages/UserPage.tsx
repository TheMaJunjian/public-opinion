import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import MessageCard from '../components/MessageCard';
import CleanFilterPanel from '../components/CleanFilterPanel';
import type { DemoMessage } from '../utils/modelBridge';
import type { Message, User } from '../types';
import { useCleanView } from '../hooks/useCleanView';

function toDemoMessage(message: Message): DemoMessage {
  const raw = message as Message & {
    relationType?: string;
    relationPayload?: DemoMessage['relationPayload'];
    targetRefs?: unknown;
  };
  const relationType = raw.relationType?.toLowerCase() as DemoMessage['relationType'];
  return {
    id: message.id,
    author: message.createdBy.username,
    createdAt: message.createdAt,
    content: message.content,
    kind: message.kind === 'RELATION' ? 'relation' : message.kind === 'GOVERNANCE' ? 'governance' : message.kind === 'CODE' ? 'code' : message.kind === 'OPERATIONS' ? 'operations' : message.kind === 'ROUND' ? 'round' : message.kind === 'ROUND_RESULT' ? 'round_result' : 'normal',
    backendKind: message.kind,
    relationType,
    relationPayload: raw.relationPayload,
  };
}

export default function UserPage() {
  const { userId } = useParams<{ userId: string }>();
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { addFilter, clearFilters, removeFilter, updateFilter, cleanFilters, cleanVisibleIds } = useCleanView({
    messages,
    edges: [],
    stakeCounts: {},
    tagCounts: {},
  });

  useEffect(() => {
    if (!user) return;
    clearFilters();
    addFilter({ id: `user-page-sender-${user.id}`, kind: 'sender', username: user.username });
    return clearFilters;
  }, [user, addFilter, clearFilters]);

  const keepUserFilter = () => {
    clearFilters();
    if (user) {
      addFilter({ id: `user-page-sender-${user.id}`, kind: 'sender', username: user.username });
    }
  };

  useEffect(() => {
    if (!userId) return;
    setError(null);
    Promise.all([api.getUser(userId), api.getAllUserMessages(userId)])
      .then(([profile, result]) => {
        setUser(profile);
        setMessages(result.data.map(toDemoMessage));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '与会者页加载失败'));
  }, [userId]);

  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!user) return <div className="p-6 text-gray-500">加载与会者页...</div>;

  const filteredMessages = cleanVisibleIds
    ? messages.filter(message => cleanVisibleIds.visibleTextIds.has(message.id))
    : messages;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5">
      <header style={{ borderBottom: '1px solid #333', paddingBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <CleanFilterPanel
            active={cleanFilters.length > 0}
            filters={cleanFilters}
            matchCount={filteredMessages.length}
            totalCount={messages.length}
            onAdd={addFilter}
            onRemove={removeFilter}
            onUpdate={updateFilter}
            onClear={keepUserFilter}
          />
          <span style={{ fontSize: 12, opacity: 0.75 }}>发送者 ID：{user.id}</span>
          <span style={{ fontSize: 12, opacity: 0.75 }}>匹配 {filteredMessages.length} 条</span>
        </div>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filteredMessages.map(message => (
          <MessageCard
            key={message.id}
            msg={message}
            ctx={{ relType: message.relationType ?? null }}
          />
        ))}
        {filteredMessages.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af' }}>该与会者尚未发送消息。</div>}
      </div>
    </div>
  );
}
