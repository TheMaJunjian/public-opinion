import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUserStances } from '../api/client';
import type { StanceRelation, StanceStake } from '../types';

interface Props {
  userId: string;
  topicId?: string;
}

const TYPE_ICON: Record<string, string> = {
  AGREE: '👍', DISAGREE: '👎', SELF_AGREE: '✍️',
};
const TYPE_LABEL: Record<string, string> = {
  AGREE: '赞同', DISAGREE: '反对', SELF_AGREE: '赞同自己',
};

/**
 * StanceHistoryPanel — 用户表态历史面板
 * 站队（赞同/反对/赞同自己） + 立场（发消息消耗的贡献点）
 */
export default function StanceHistoryPanel({ userId, topicId }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relations, setRelations] = useState<StanceRelation[]>([]);
  const [stakes, setStakes] = useState<StanceStake[]>([]);
  const [activeTab, setActiveTab] = useState<'relations' | 'stakes'>('relations');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getUserStances(userId, { topicId, limit: 30 });
      setRelations(data.stances.relations);
      setStakes(data.stances.stakes);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [userId, topicId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-sm text-gray-500 p-4">加载中...</div>;
  if (error) return <div className="text-sm text-red-600 p-4">{error}</div>;

  const totalCount = relations.length + stakes.length;
  if (totalCount === 0) {
    return (
      <div className="text-sm text-gray-500 p-4 space-y-2">
        <div>暂无记录</div>
        <div className="text-xs text-gray-400">发送消息会消耗贡献点，记录在「立场」中。对他人消息的赞同/反对，记录在「站队」中。赞同自己的消息会在站队中标注。</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-gray-200">
        {(['relations', 'stakes'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab ? 'border-indigo-500 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'relations' ? `站队 (${relations.length})` : `立场 (${stakes.length})`}
          </button>
        ))}
      </div>

      <div className="space-y-2 max-h-96 overflow-auto">
        {activeTab === 'relations' && relations.map(r => (
          <StanceCard
            key={`rel-${r.id}`}
            icon={TYPE_ICON[r.type] ?? '❓'}
            title={`${TYPE_LABEL[r.type] ?? r.type} · ${r.topicTitle}`}
            subtitle={`${r.amount} 点`}
            highlight={r.type === 'SELF_AGREE'}
            time={r.createdAt}
            onDoubleClick={() => {
              const params = new URLSearchParams();
              params.set('msg', r.id);
              if (r.targetMessageId) params.set('settlement', r.targetMessageId);
              navigate(`/topics/${r.topicId}?${params}`);
            }}
          />
        ))}

        {activeTab === 'stakes' && stakes.map(s => (
          <StanceCard
            key={`stake-${s.id}`}
            icon="🔒"
            title={`消耗 ${s.amount} 点 · ${s.topicTitle}`}
            subtitle={s.content ? (s.content.length > 40 ? s.content.slice(0, 40) + '…' : s.content) : '(无文本)'}
            time={s.createdAt}
            onDoubleClick={() => navigate(`/topics/${s.topicId}?msg=${s.messageId}`)}
          />
        ))}
      </div>
    </div>
  );
}

/** Single stance entry card */
function StanceCard({
  icon, title, subtitle, time, highlight, onDoubleClick,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  time: string;
  highlight?: boolean;
  onDoubleClick: () => void;
}) {
  return (
    <div
      className={`border rounded-lg px-3 py-2 cursor-pointer hover:shadow-sm transition-shadow bg-white ${highlight ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}
      onDoubleClick={onDoubleClick}
      title="双击跳转到对应消息"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">{icon}</span>
          <div>
            <div className="text-xs font-medium text-gray-800">{title}</div>
            {subtitle && <div className="text-xs text-gray-500">{subtitle}</div>}
          </div>
        </div>
        <span className="text-xs text-gray-400">
          {new Date(time).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}
