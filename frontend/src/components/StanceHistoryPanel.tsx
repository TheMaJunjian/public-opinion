import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUserStances } from '../api/client';
import type { StanceRelation, StanceVote, StanceStake, StanceEvidence } from '../types';

interface Props {
  userId: string;
  topicId?: string;
}

/**
 * StanceHistoryPanel — 用户表态历史面板
 * 展示用户在系统中的所有立场表态（赞同/反对、投票、押注）
 * 以及 REFERENCE(证据) 引用。
 */
export default function StanceHistoryPanel({ userId, topicId }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relations, setRelations] = useState<StanceRelation[]>([]);
  const [votes, setVotes] = useState<StanceVote[]>([]);
  const [stakes, setStakes] = useState<StanceStake[]>([]);
  const [evidence, setEvidence] = useState<StanceEvidence[]>([]);
  const [activeTab, setActiveTab] = useState<'all' | 'relations' | 'votes' | 'stakes' | 'evidence'>('all');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getUserStances(userId, { topicId, limit: 30 });
      setRelations(data.stances.relations);
      setVotes(data.stances.votes);
      setStakes(data.stances.stakes);
      setEvidence(data.stances.evidence ?? []);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [userId, topicId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="text-sm text-gray-500 p-4">加载表态历史...</div>;
  }

  if (error) {
    return <div className="text-sm text-red-600 p-4">{error}</div>;
  }

  const totalCount = relations.length + votes.length + stakes.length + evidence.length;
  if (totalCount === 0) {
    return <div className="text-sm text-gray-500 p-4">暂无表态记录</div>;
  }

  return (
    <div className="space-y-3">
      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['all', 'relations', 'votes', 'stakes', 'evidence'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-indigo-500 text-indigo-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'all' && `全部 (${totalCount})`}
            {tab === 'relations' && `赞同/反对 (${relations.length})`}
            {tab === 'votes' && `投票 (${votes.length})`}
            {tab === 'stakes' && `押注 (${stakes.length})`}
            {tab === 'evidence' && `证据 (${evidence.length})`}
          </button>
        ))}
      </div>

      {/* Stance List */}
      <div className="space-y-2 max-h-96 overflow-auto">
        {(activeTab === 'all' || activeTab === 'relations') && relations.map(r => (
          <StanceCard
            key={`rel-${r.id}`}
            icon={r.type === 'AGREE' ? '👍' : '👎'}
            title={`${r.type === 'AGREE' ? '赞同' : '反对'} · ${r.topicTitle}`}
            time={r.createdAt}
            onClick={() => navigate(`/topics/${r.topicId}?msg=${r.id}`)}
          />
        ))}

        {(activeTab === 'all' || activeTab === 'votes') && votes.map(v => (
          <StanceCard
            key={`vote-${v.id}`}
            icon={v.vote === 'TRUE' ? '✅' : '❌'}
            title={`投票${v.vote === 'TRUE' ? 'TRUE' : 'FALSE'} · ${v.topicTitle}`}
            subtitle={`${v.amount} 点 · ${v.roundStatus === 'SETTLED' ? `结果: ${v.roundResult ?? '—'}` : v.roundStatus}`}
            time={v.createdAt}
            onClick={() => v.topicId && navigate(`/topics/${v.topicId}?msg=${v.messageId}&settlement=${v.messageId}`)}
          />
        ))}

        {(activeTab === 'all' || activeTab === 'stakes') && stakes.map(s => (
          <StanceCard
            key={`stake-${s.id}`}
            icon={s.side === 'PRO' ? '📈' : '📉'}
            title={`押${s.side === 'PRO' ? '看好' : '看空'} · ${s.topicTitle}`}
            subtitle={`${s.amount} 点`}
            time={s.createdAt}
            onClick={() => navigate(`/topics/${s.topicId}?msg=${s.messageId}`)}
          />
        ))}

        {(activeTab === 'all' || activeTab === 'evidence') && evidence.map(e => {
          const payload = e.relationPayload as Record<string, unknown> | null;
          const label = payload?.label as string | undefined;
          const targets = e.targetRefs as Array<{ messageId?: string }> | undefined;
          const firstTarget = targets?.[0]?.messageId;
          return (
            <StanceCard
              key={`ev-${e.id}`}
              icon="📎"
              title={`证据${label ? ` · ${label}` : ''} · ${e.topicTitle}`}
              subtitle={firstTarget ? `→ ${firstTarget.slice(-6)}` : undefined}
              time={e.createdAt}
              onClick={() => firstTarget && navigate(`/topics/${e.topicId}?msg=${firstTarget}`)}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Single stance entry card */
function StanceCard({
  icon, title, subtitle, time, onClick,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  time: string;
  onClick: () => void;
}) {
  return (
    <div
      className="border rounded-lg px-3 py-2 cursor-pointer hover:shadow-sm transition-shadow border-gray-200 bg-white"
      onClick={onClick}
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
