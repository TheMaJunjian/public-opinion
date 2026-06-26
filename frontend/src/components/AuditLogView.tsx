import { useState, useEffect } from 'react';
import { api } from '../api';
import type { AuditLogEntry } from '../types';

const ACTION_LABELS: Record<string, string> = {
  USER_REGISTERED: '用户注册',
  TOPIC_CREATED: '创建议题',
  TOPIC_ARCHIVED: '归档议题',
  TOPIC_REOPENED: '重开议题',
  MESSAGE_CREATED: '发布消息',
  RELATION_CREATED: '建立关系',
  STAKE_PLACED: '押注',
  ROUND_CREATED: '发起结算',
  ROUND_SETTLED: '结算完成',
  SETTLEMENT_CLAWBACK: '结算回滚',
  POINT_MINTED: '贡献点铸造',
};

export default function AuditLogView({ topicId }: { topicId?: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    api.getAuditLogs({ topicId, page, limit: 30 })
      .then(r => setEntries(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [topicId, page]);

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <h3 className="font-semibold text-gray-800 text-sm mb-3">📋 审计日志</h3>
      {loading ? (
        <div className="text-sm text-gray-500">加载中...</div>
      ) : entries.length === 0 ? (
        <div className="text-sm text-gray-400">暂无记录</div>
        <div className="text-xs text-gray-500 mt-1">系统尚无操作记录。当你或他人进行发消息、押注、发起结算、投票等操作后，所有记录会在此透明展示，任何人都可查阅。</div>
      ) : (
        <div className="space-y-1 max-h-96 overflow-y-auto text-xs">
          {entries.map(e => (
            <div key={e.id} className="flex items-center gap-2 py-1 border-b border-gray-100">
              <span className="text-gray-400 w-24 flex-shrink-0">
                {new Date(e.createdAt).toLocaleTimeString('zh-CN')}
              </span>
              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                e.action.includes('SETTLE') || e.action.includes('CLAW')
                  ? 'bg-amber-100 text-amber-700'
                  : e.action.includes('STAKE')
                  ? 'bg-green-100 text-green-700'
                  : 'bg-blue-100 text-blue-700'
              }`}>
                {ACTION_LABELS[e.action] ?? e.action}
              </span>
              <span className="text-gray-600 truncate">
                {e.actor?.username ?? '系统'}
              </span>
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
