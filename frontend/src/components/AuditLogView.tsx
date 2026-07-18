import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { AuditLogEntry } from '../types';

const ACTION_LABELS: Record<string, string> = {
  USER_REGISTERED: '用户注册',
  TOPIC_CREATED: '创建议题',
  TOPIC_ARCHIVED: '归档议题',
  TOPIC_REOPENED: '重开议题',
  MESSAGE_CREATED: '发布消息',
  RELATION_CREATED: '建立关系',
  RELATION_SUPERSEDED: '替换关系',
  RELATION_TARGETS_UPDATED: '更新关系目标',
  STAKE_PLACED: '押注',
  ROUND_CREATED: '发起结算',
  VOTE_CAST: '投票',
  ROUND_SETTLED: '结算完成',
  SETTLEMENT_CLAWBACK: '结算回滚',
  POINT_MINTED: '贡献点铸造',
  POINT_TRANSFERRED: '贡献点转移',
};

const ACTION_COLORS: Record<string, string> = {
  SETTLE: 'bg-amber-100 text-amber-700',
  CLAW: 'bg-red-100 text-red-700',
  STAKE: 'bg-green-100 text-green-700',
  VOTE: 'bg-purple-100 text-purple-700',
  ROUND: 'bg-orange-100 text-orange-700',
  MINT: 'bg-emerald-100 text-emerald-700',
};

function actionColor(action: string): string {
  for (const [key, cls] of Object.entries(ACTION_COLORS)) {
    if (action.includes(key)) return cls;
  }
  return 'bg-blue-100 text-blue-700';
}

/** 生成可跳转链接的描述文字 */
function entityLinkLabel(entityType: string, entityId: string | null): string | null {
  if (!entityId) return null;
  const short = entityId.slice(-6);
  switch (entityType) {
    case 'Message': return `消息 #${short}`;
    case 'Topic': return `议题 #${short}`;
    case 'User': return `用户 #${short}`;
    case 'Stake': return `押注 #${short}`;
    case 'VoteStake': return `投票 #${short}`;
    case 'SettlementRound': return `轮次 #${short}`;
    case 'Relation': return `关系 #${short}`;
    case 'PointTransaction': return `积分 #${short}`;
    default: return `${entityType} #${short}`;
  }
}

/** 结算相关 action：跳转时带 roundId 以自动展开对应轮次 */
const SETTLEMENT_ACTIONS = new Set([
  'ROUND_CREATED', 'VOTE_CAST', 'ROUND_SETTLED', 'SETTLEMENT_CLAWBACK',
]);

/** 根据 entityType + entityId + details 生成跳转 URL */
function resolveNavUrl(e: AuditLogEntry): string | null {
  if (!e.topicId) return null;

  const d = e.data?.details as Record<string, unknown> | undefined;

  // 优先从 details 取 messageId（结算/关系类 action 都有）
  // 其次：Message 实体的 entityId 就是消息 ID
  // 最后：Relation 实体的 entityId 是关系消息 ID，可作为跳转目标
  const msgId = (d?.messageId as string)
    || (e.entityType === 'Message' && e.entityId ? e.entityId : undefined)
    || (e.entityType === 'Relation' && e.entityId ? e.entityId : undefined);

  if (!msgId) return `/topics/${e.topicId}`;

  const params = new URLSearchParams();
  params.set('msg', msgId);

  // 结算相关记录：设 settlement 参数以触发 SettlementPanel 展开
  const roundId = d?.roundId as string | undefined;
  if (roundId && SETTLEMENT_ACTIONS.has(e.action)) {
    params.set('settlement', msgId);
    params.set('highlightRound', roundId);
  }

  return `/topics/${e.topicId}?${params.toString()}`;
}

export default function AuditLogView({ topicId }: { topicId?: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filterAction, setFilterAction] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    api.getAuditLogs({ topicId, page, limit: 30, action: filterAction || undefined })
      .then(r => setEntries(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [topicId, page, filterAction]);

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-800 text-sm">📋 审计日志</h3>
        <select
          value={filterAction}
          onChange={e => { setFilterAction(e.target.value); setPage(1); }}
          className="text-xs border border-gray-300 rounded px-2 py-0.5 bg-white"
        >
          <option value="">全部操作</option>
          {Object.entries(ACTION_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>
      {loading ? (
        <div className="text-sm text-gray-500">加载中...</div>
      ) : entries.length === 0 ? (
        <div>
          <div className="text-sm text-gray-400">暂无记录</div>
          <div className="text-xs text-gray-500 mt-1">系统尚无操作记录。当你或他人进行发消息、押注、发起结算、投票等操作后，所有记录会在此透明展示，任何人都可查阅。</div>
        </div>
      ) : (
        <div className="space-y-1 max-h-96 overflow-y-auto text-xs">
          {entries.map(e => (
            <div key={e.id}>
              <div
                className="flex items-center gap-2 py-1 border-b border-gray-100 cursor-pointer hover:bg-gray-50"
                onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
              >
                <span className="text-gray-400 w-20 flex-shrink-0">
                  {new Date(e.createdAt).toLocaleTimeString('zh-CN')}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${actionColor(e.action)}`}>
                  {ACTION_LABELS[e.action] ?? e.action}
                </span>
                <span className="text-gray-600 truncate flex-1">
                  {e.data?.summary ?? e.actor?.username ?? '系统'}
                </span>
                {e.topicId && (
                  <button
                    onClick={ev => {
                      ev.stopPropagation();
                      const url = resolveNavUrl(e);
                      if (url) navigate(url);
                    }}
                    className="text-blue-500 hover:text-blue-700 flex-shrink-0 text-xs font-medium"
                    title="查看对应消息"
                  >查看 →</button>
                )}
              </div>
              {expandedId === e.id && (
                <div className="ml-24 mb-1 p-2 bg-gray-50 rounded text-xs text-gray-600">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-gray-400">{e.actor?.username ?? '系统'}</span>
                    {e.entityType && e.entityId && (
                      <span className="text-gray-500">
                        {entityLinkLabel(e.entityType, e.entityId)}
                      </span>
                    )}
                    {e.topicId && (
                      <button
                        onClick={() => {
                          const url = resolveNavUrl(e);
                          if (url) navigate(url);
                        }}
                        className="text-blue-500 hover:text-blue-700"
                      >
                        查看 →
                      </button>
                    )}
                  </div>
                  {e.data?.details && Object.keys(e.data.details).length > 0 && (
                    <pre className="mt-1 text-gray-500 overflow-x-auto max-h-32">
                      {JSON.stringify(e.data.details, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="px-2 py-1 text-xs border rounded disabled:opacity-50"
        >上一页</button>
        <button
          onClick={() => setPage(p => p + 1)}
          className="px-2 py-1 text-xs border rounded"
        >下一页</button>
      </div>
    </div>
  );
}
