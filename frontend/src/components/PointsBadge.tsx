import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getPointsBalance, getPointsTransactions } from '../api/client';
import type { PointsBalance, PointTransaction } from '../types';

/**
 * PointsBadge — 导航栏贡献点显示组件。
 * - 窗口聚焦时自动刷新余额
 * - 点击展开贡献点流水面板
 */
export default function PointsBadge() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [balance, setBalance] = useState<PointsBalance | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  const fetchBalance = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getPointsBalance();
      setBalance(data);
      setError(false);
    } catch {
      setError(true);
    }
  }, [user]);

  // Initial fetch
  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  // Refresh on window focus
  useEffect(() => {
    const onFocus = () => fetchBalance();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchBalance]);

  // Refresh on custom event (dispatched after stake/message actions)
  useEffect(() => {
    const onRefresh = () => fetchBalance();
    window.addEventListener('points-refresh', onRefresh);
    return () => window.removeEventListener('points-refresh', onRefresh);
  }, [fetchBalance]);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function handleClick() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setTxLoading(true);
    try {
      const res = await getPointsTransactions({ limit: 20 });
      setTransactions(res.data);
    } catch {
      // ignore
    } finally {
      setTxLoading(false);
    }
  }

  if (!user) return null;

  if (error || !balance) {
    return (
      <span className="text-indigo-300 text-xs" title="贡献点加载失败">
        ⚠ 贡献点
      </span>
    );
  }

  const { points, balance: bal } = balance;

  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={handleClick}
        className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity cursor-pointer"
        title="点击查看流水"
      >
        <span className="text-indigo-200">
          💎 {points.available.toLocaleString()}
        </span>
        {points.locked > 0 && (
          <span className="text-indigo-400 text-xs" title={`锁定: ${points.locked}`}>
            🔒{points.locked}
          </span>
        )}
        {bal.debtFrozen && (
          <span className="text-red-400 text-xs font-bold animate-pulse" title="账户负债冻结">
            ❄️冻结
          </span>
        )}
        {bal.amount < 0 && (
          <span className="text-orange-400 text-xs" title={`负债: ${bal.amount}`}>
            负债{Math.abs(bal.amount)}
          </span>
        )}
      </button>

      {/* Popover: transaction list */}
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-xl z-50 max-h-80 overflow-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b border-gray-100 font-semibold text-sm text-gray-700 sticky top-0 bg-white">
            贡献点记录
            <span className="ml-2 font-normal text-xs text-gray-400">
              可用 {points.available} · 锁定 {points.locked}
            </span>
          </div>
          {txLoading ? (
            <div className="px-3 py-4 text-sm text-gray-400 text-center">加载中...</div>
          ) : transactions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-gray-400 text-center">暂无记录</div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {transactions.map((tx) => {
                const txData = tx.data as Record<string, unknown> | null;
                const hasMessage = !!(txData?.messageId);
                const canNavigate = !!(txData?.messageId && txData?.topicId);
                return (
                <li
                  key={tx.id}
                  className={`px-3 py-2 text-xs flex justify-between items-center select-none ${hasMessage ? 'cursor-pointer hover:bg-indigo-50' : ''}`}
                  onDoubleClick={canNavigate ? (e) => {
                    e.preventDefault();
                    const params = new URLSearchParams();
                    params.set('msg', txData!.messageId as string);
                    if (txData?.roundId) {
                      params.set('settlement', txData!.messageId as string);
                      params.set('highlightRound', txData.roundId as string);
                    }
                    navigate(`/topics/${txData!.topicId}?${params.toString()}`);
                  } : undefined}
                  title={canNavigate ? '双击跳转到相关消息并展开结算记录' : hasMessage ? '关联消息（无法跳转）' : undefined}
                >
                  <div>
                    <span className="font-medium text-gray-700">
                      {typeLabel(tx.type)}
                    </span>
                    {(tx.data as Record<string, unknown> | null)?.reason && (
                      <span className="ml-1 text-gray-400">
                        ({(tx.data as Record<string, unknown>).reason as string})
                      </span>
                    )}
                    {hasMessage && !canNavigate && (
                      <span className="ml-1 text-gray-300 text-xs">📎</span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className={tx.amount >= 0 ? 'text-green-600' : 'text-red-500'}>
                      {tx.amount >= 0 ? '+' : ''}{tx.amount.toLocaleString()}
                    </span>
                    <span className="ml-2 text-gray-400">
                      余额 {tx.balanceAfter.toLocaleString()}
                    </span>
                    {canNavigate && <span className="ml-1 text-indigo-400" title="双击跳转到相关消息">↗</span>}
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    MINT: '铸造',
    LOCK: '锁定',
    UNLOCK: '解锁',
    SPEND: '支出',
    TRANSFER: '转入',
  };
  return labels[type] ?? type;
}

