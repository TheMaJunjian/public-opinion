import { useState, useEffect } from 'react';
import { api } from '../api';
import type { RevenuePoolData, RevenueDistributionItem } from '../types';

export default function RevenuePanel() {
  const [pool, setPool] = useState<RevenuePoolData | null>(null);
  const [dists, setDists] = useState<RevenueDistributionItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () => {
      setLoading(true);
      Promise.all([
        api.getRevenuePool().catch(() => null),
        api.getRevenueDistributions({ limit: 20 }).catch(() => ({ data: [] })),
      ]).then(([p, d]) => {
        setPool(p);
        setDists(d.data);
      }).finally(() => setLoading(false));
    };

    load();
    window.addEventListener('revenue-refresh', load);
    return () => window.removeEventListener('revenue-refresh', load);
  }, []);

  if (loading) return <div className="text-sm text-[color:var(--ink-6b7280)] p-4">加载收入数据...</div>;

  return (
    <div className="border border-[color:var(--line-e5e7eb)] rounded-lg p-4 bg-[color:var(--surface-fff)] space-y-4">
      <h3 className="font-semibold text-[color:var(--ink-1f2937)] text-sm">💰 收入池</h3>

      {pool ? (
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-[color:var(--surface-f0fdf4)] rounded p-2">
            <div className="text-lg font-bold text-[color:var(--ink-15803d)]">{pool.totalReceived}</div>
            <div className="text-xs text-[color:var(--ink-6b7280)]">累计收入</div>
          </div>
          <div className="bg-[color:var(--surface-eff6ff)] rounded p-2">
            <div className="text-lg font-bold text-[color:var(--ink-1d4ed8)]">{pool.totalDistributed}</div>
            <div className="text-xs text-[color:var(--ink-6b7280)]">已分配</div>
          </div>
          <div className="bg-[color:var(--surface-fffbeb)] rounded p-2">
            <div className="text-lg font-bold text-[color:var(--ink-b45309)]">{pool.balance}</div>
            <div className="text-xs text-[color:var(--ink-6b7280)]">待分配</div>
          </div>
        </div>
      ) : (
        <div className="text-sm text-[color:var(--ink-9ca3af)]">收入池尚未初始化</div>
      )}

      {dists.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-[color:var(--ink-4b5563)] mb-2">最近分配记录</h4>
          <div className="space-y-1 max-h-48 overflow-y-auto text-xs">
            {dists.map(d => (
              <div key={d.id} className="flex justify-between py-1 border-b border-[color:var(--line-f3f4f6)]">
                <span className="text-[color:var(--ink-4b5563)]">{d.user?.username ?? d.userId}</span>
                <span className="text-[color:var(--ink-16a34a)] font-medium">+{d.amount}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-[color:var(--line-f3f4f6)] pt-3 text-xs text-[color:var(--ink-6b7280)]">
        充值分账和运营收入注入必须发起提案，经讨论、结算和生效条件确认后才会进入收入池。
      </div>
    </div>
  );
}
