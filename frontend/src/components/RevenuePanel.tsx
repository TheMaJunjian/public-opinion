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

  if (loading) return <div className="text-sm text-gray-500 p-4">加载收入数据...</div>;

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-4">
      <h3 className="font-semibold text-gray-800 text-sm">💰 收入池</h3>

      {pool ? (
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-green-50 rounded p-2">
            <div className="text-lg font-bold text-green-700">{pool.totalReceived}</div>
            <div className="text-xs text-gray-500">累计收入</div>
          </div>
          <div className="bg-blue-50 rounded p-2">
            <div className="text-lg font-bold text-blue-700">{pool.totalDistributed}</div>
            <div className="text-xs text-gray-500">已分配</div>
          </div>
          <div className="bg-amber-50 rounded p-2">
            <div className="text-lg font-bold text-amber-700">{pool.balance}</div>
            <div className="text-xs text-gray-500">待分配</div>
          </div>
        </div>
      ) : (
        <div className="text-sm text-gray-400">收入池尚未初始化</div>
      )}

      {dists.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-gray-600 mb-2">最近分配记录</h4>
          <div className="space-y-1 max-h-48 overflow-y-auto text-xs">
            {dists.map(d => (
              <div key={d.id} className="flex justify-between py-1 border-b border-gray-100">
                <span className="text-gray-600">{d.user?.username ?? d.userId}</span>
                <span className="text-green-600 font-medium">+{d.amount}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-gray-100 pt-3 text-xs text-gray-500">
        充值分账和运营收入注入必须发起提案，经讨论、结算和生效条件确认后才会进入收入池。
      </div>
    </div>
  );
}
