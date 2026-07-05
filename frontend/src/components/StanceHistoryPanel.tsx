import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUserStances } from '../api/client';
import type { StanceRelation, StanceStake, StanceTag } from '../types';

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
const TAG_TYPE_LABEL: Record<string, string> = {
  RECOMMEND: '推荐', ARCHIVE: '冷藏',
};
const SUB_TYPE_LABEL: Record<string, string> = {
  SPAM: '垃圾', OFFTOPIC: '跑题', LOWVALUE: '低质', IMPORTANT: '重要', CUSTOM: '自定义',
};
const MESSAGE_KIND_LABEL: Record<string, string> = {
  TEXT: '文本消息', RELATION: '关系消息', ROUND: '结算轮次',
  ROUND_RESULT: '结算结果', GOVERNANCE: '治理提案', CODE: '代码变更',
};

type TabKey = 'relations' | 'stakes' | 'tags';

/**
 * StanceHistoryPanel — 用户表态历史面板
 * 站队（赞同/反对/赞同自己） + 立场（发消息消耗的贡献点） + 表态（标注）
 */
export default function StanceHistoryPanel({ userId, topicId }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relations, setRelations] = useState<StanceRelation[]>([]);
  const [stakes, setStakes] = useState<StanceStake[]>([]);
  const [tags, setTags] = useState<StanceTag[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('relations');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getUserStances(userId, { topicId, limit: 30 });
      setRelations(data.stances.relations);
      setStakes(data.stances.stakes);
      setTags(data.stances.tags ?? []);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [userId, topicId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-sm text-gray-500 p-4">加载中...</div>;
  if (error) return <div className="text-sm text-red-600 p-4">{error}</div>;

  const totalCount = relations.length + stakes.length + tags.length;
  if (totalCount === 0) {
    return (
      <div className="text-sm text-gray-500 p-4 space-y-2">
        <div>暂无记录</div>
        <div className="text-xs text-gray-400">赞同/反对记录在「站队」中，标注记录在「表态」中，其他消息消耗的贡献点记录在「立场」中。</div>
      </div>
    );
  }

  const TABS: { key: TabKey; label: string; count: number }[] = [
    { key: 'relations', label: '站队', count: relations.length },
    { key: 'stakes', label: '立场', count: stakes.length },
    { key: 'tags', label: '表态', count: tags.length },
  ];

  function navigateToRecord(rTopicId: string, msgId: string, options?: { settlementId?: string | null; stakeId?: string | null; settlementType?: 'TRUTH' | 'VALUE' }) {
    const params = new URLSearchParams();
    params.set('msg', msgId);
    if (options?.settlementId) params.set('settlement', options.settlementId);
    if (options?.stakeId) params.set('stakeId', options.stakeId);
    if (options?.settlementType) params.set('settlementType', options.settlementType);
    navigate(`/topics/${rTopicId}?${params}`);
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab.key ? 'border-indigo-500 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      <div className="space-y-2 max-h-96 overflow-auto">
        {activeTab === 'relations' && relations.map(r => {
          const topicSuffix = topicId ? '' : ` · ${r.topicTitle}`;
          return (
            <StanceCard
              key={`rel-${r.id}`}
              icon={TYPE_ICON[r.type] ?? '❓'}
              title={`${TYPE_LABEL[r.type] ?? r.type}${topicSuffix}`}
              subtitle={`${r.amount} 点`}
              highlight={r.type === 'SELF_AGREE'}
              time={r.createdAt}
              onDoubleClick={() => navigateToRecord(r.topicId, r.relationMessageId, { settlementId: r.targetMessageId, stakeId: r.stakeId })}
            />
          );
        })}

        {activeTab === 'stakes' && stakes.map(s => {
          const topicSuffix = topicId ? '' : ` · ${s.topicTitle}`;
          const kindLabel = MESSAGE_KIND_LABEL[s.messageKind] ?? s.messageKind;
          const detail = s.content
            ? (s.content.length > 40 ? s.content.slice(0, 40) + '…' : s.content)
            : `[${kindLabel}]`;
          return (
            <StanceCard
              key={`stake-${s.id}`}
              icon="🔒"
              title={`消耗 ${s.amount} 点${topicSuffix}`}
              subtitle={detail}
              time={s.createdAt}
              onDoubleClick={() => navigateToRecord(s.topicId, s.messageId, { settlementId: s.messageId, stakeId: s.id })}
            />
          );
        })}

        {activeTab === 'tags' && tags.map(t => {
          const typeLabel = TAG_TYPE_LABEL[t.relationType] ?? t.relationType;
          const reason = t.subType
            ? (t.subType === 'CUSTOM' && t.customLabel ? t.customLabel : (SUB_TYPE_LABEL[t.subType] ?? t.subType))
            : null;
          const topicSuffix = topicId ? '' : ` · ${t.topicTitle}`;
          return (
            <StanceCard
              key={`tag-${t.id}`}
              icon="🏷️"
              title={`${typeLabel}${reason ? ` · ${reason}` : ''}${topicSuffix}`}
              subtitle={`${t.amount} 点${t.targetMessageId ? ` · 目标: ${t.targetMessageId.slice(-8)}` : ''}`}
              time={t.createdAt}
              onDoubleClick={() => navigateToRecord(t.topicId, t.relationMessageId, { settlementId: t.targetMessageId, stakeId: t.stakeId, settlementType: 'VALUE' })}
            />
          );
        })}
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
