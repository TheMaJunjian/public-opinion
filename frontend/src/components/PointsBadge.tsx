import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getPointsBalance, getPointsTransactions } from '../api/client';
import type { PointsBalance, PointTransaction } from '../types';

/**
 * PointsBadge — 导航栏贡献点显示组件。
 * - 窗口聚焦时自动刷新余额
 * - 点击展开贡献点流水面板
 * - 双击记录项：同 Topic 原地定位（发事件），跨 Topic 路由跳转
 */
export default function PointsBadge() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [balance, setBalance] = useState<PointsBalance | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [flash, setFlash] = useState<'gain' | 'loss' | null>(null);
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

  // Flash animation on settlement — detect gain/loss from latest transaction
  useEffect(() => {
    const onFlash = async () => {
      if (!user) return;
      try {
        const res = await getPointsTransactions({ limit: 1 });
        const latest = res.data[0];
        if (latest) {
          setFlash(latest.type === 'SETTLEMENT_GAIN' ? 'gain' : latest.type === 'SETTLEMENT_LOSS' ? 'loss' : null);
        }
      } catch {
        // ignore
      }
      setTimeout(() => setFlash(null), 2000);
    };
    window.addEventListener('points-flash', onFlash);
    return () => window.removeEventListener('points-flash', onFlash);
  }, [user]);

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

  const { points, balance: bal, breakdown } = balance;

  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={handleClick}
        className={`flex items-center gap-2 text-sm hover:opacity-80 transition-opacity cursor-pointer ${flash ? `animate-pulse ring-2 rounded px-1 ${flash === 'gain' ? 'ring-red-400' : 'ring-green-400'}` : ''}`}
        title={`可用${points.available} · 锁定${points.locked} · 损失${breakdown.totalLost} · 协议费${breakdown.totalProtocolFees} · 收益${breakdown.totalEarned}`}
      >
        <span className="text-indigo-200">
          💎 {points.available.toLocaleString()}
        </span>
        <span className="text-indigo-400 text-xs" title={`锁定: ${points.locked}`}>
          🔒{points.locked}
        </span>
        <span className="text-red-400 text-xs" title={`累计损失: ${breakdown.totalLost}`}>
          📉{breakdown.totalLost}
        </span>
        <span className="text-orange-400 text-xs" title={`累计协议费: ${breakdown.totalProtocolFees}`}>
          🏛{breakdown.totalProtocolFees}
        </span>
        <span className="text-green-400 text-xs" title={`累计收益: ${breakdown.totalEarned}`}>
          📈{breakdown.totalEarned}
        </span>
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
                    const msgId = txData!.messageId as string;
                    const tId = txData!.topicId as string;
                    const roundId = txData?.roundId as string | undefined;

                    // Check if we're already on the same topic page
                    const currentPath = location.pathname;
                    const targetPath = `/topics/${tId}`;
                    if (currentPath === targetPath || currentPath.startsWith(targetPath + '/')) {
                      // Same topic — dispatch event for in-place navigation
                      window.dispatchEvent(new CustomEvent('points-navigate', {
                        detail: {
                          messageId: msgId,
                          topicId: tId,
                          roundId: roundId ?? null,
                          txType: tx.type,
                          txData: txData,  // pass full tx data for settlement highlighting
                          username: user.username,
                        },
                      }));
                      setOpen(false);
                    } else {
                      // Different topic — full navigation with URL params
                      const params = new URLSearchParams();
                      params.set('msg', msgId);
                      if (roundId) {
                        params.set('settlement', msgId);
                        params.set('highlightRound', roundId);
                      }
                      navigate(`${targetPath}?${params.toString()}`);
                    }
                  } : undefined}
                  title={canNavigate ? '双击跳转到相关消息并展开结算记录' : hasMessage ? '关联消息（无法跳转）' : undefined}
                >
                  <div>
                    <span className="font-medium text-gray-700">
                      {typeLabel(tx.type)}
                    </span>
                    <span className="ml-1 text-gray-500">
                      {txDetail(tx)}
                    </span>
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
    STAKE_LOCK: '押注',
    VOTE_LOCK: '投票',
    SETTLEMENT_GAIN: '结算收益',
    SETTLEMENT_LOSS: '结算损失',
    CLAWBACK: '推翻扣回',
    UNLOCK: '解锁',
    SPEND: '支出',
    TRANSFER: '转入',
    REVENUE_DISTRIBUTION: '收入分配',
    REVENUE_WITHDRAWAL: '收入撤回',
  };
  return labels[type] ?? type;
}

function txDetail(tx: import('../types').PointTransaction): string {
  const d = tx.data as Record<string, unknown> | null;
  if (!d) return '';

  // Stake: show side + staked/burned
  if (tx.type === 'STAKE_LOCK') {
    const side = d.side === 'PRO' ? '看好' : '看空';
    const staked = d.staked as number | undefined;
    const burned = d.burned as number | undefined;
    let detail = `${side}`;
    if (staked) detail += ` · 押 ${staked} 点`;
    if (burned && burned > 0) detail += ` · 燃 ${burned} 点`;
    return detail;
  }

  // Vote: show direction + staked/burned
  if (tx.type === 'VOTE_LOCK') {
    const vote = d.vote === 'TRUE' ? '支持' : '反对';
    const staked = d.staked as number | undefined;
    const burned = d.burned as number | undefined;
    let detail = `投${vote}`;
    if (staked) detail += ` · ${staked} 点`;
    if (burned && burned > 0) detail += ` · 燃 ${burned} 点`;
    return detail;
  }

  // Settlement
  if (tx.type === 'SETTLEMENT_GAIN' || tx.type === 'SETTLEMENT_LOSS') {
    const result = d.settlementResult as string | undefined;
    return result ? `结果 ${result}` : '';
  }

  // Clawback
  if (tx.type === 'CLAWBACK') {
    const reLocked = d.reLockedStake as number | undefined;
    return reLocked ? `重新锁定 ${reLocked} 点` : '';
  }

  // Mint: show reason
  if (d.reason) return String(d.reason);

  if (tx.type === 'REVENUE_DISTRIBUTION') return '按贡献点比例分配';
  if (tx.type === 'REVENUE_WITHDRAWAL') return '收入撤回';

  return '';
}

