import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { getPointsBalance } from '../api/client';
import type { PointsBalance } from '../types';

/**
 * PointsBadge — 导航栏贡献点显示组件。
 * 显示用户可用贡献点和负债冻结状态。
 * 仅在用户已登录时渲染。
 */
export default function PointsBadge() {
  const { user } = useAuth();
  const [balance, setBalance] = useState<PointsBalance | null>(null);
  const [error, setError] = useState(false);

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

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

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
    <div className="flex items-center gap-2 text-sm" title={`可用: ${points.available} | 锁定: ${points.locked} | 余额: ${bal.amount}`}>
      <span className="text-indigo-200">
        💎 {points.available.toLocaleString()}
      </span>
      {bal.debtFrozen && (
        <span className="text-red-400 text-xs font-bold animate-pulse" title="账户负债冻结，禁止押注/投票/发起结算">
          🔒 冻结
        </span>
      )}
      {bal.amount < 0 && (
        <span className="text-orange-400 text-xs" title={`负债: ${bal.amount}`}>
          负债 {Math.abs(bal.amount).toLocaleString()}
        </span>
      )}
    </div>
  );
}
