import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { placeStake } from '../api/client';
import type { StakeResult } from '../types';

interface StakeInputProps {
  messageId: string;
  onStakePlaced?: (result: StakeResult) => void;
}

/**
 * StakeInput — PRO/CON 押注金额输入组件 (Phase 2).
 * 允许用户对消息下注 PRO（认为 TRUE）或 CON（认为 FALSE）。
 */
export default function StakeInput({ messageId, onStakePlaced }: StakeInputProps) {
  const { user } = useAuth();
  const [amount, setAmount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<StakeResult | null>(null);

  if (!user) return null;

  async function handleStake(side: 'PRO' | 'CON') {
    if (amount < 1) {
      setError('最小押注额为 1 点');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await placeStake(messageId, { side, amount });
      setLastResult(result);
      onStakePlaced?.(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : '押注失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border border-indigo-200 rounded-lg p-3 bg-white">
      <h4 className="text-sm font-semibold text-gray-700 mb-2">⚖️ 押注</h4>

      <div className="flex items-center gap-2 mb-2">
        <label className="text-xs text-gray-500">金额:</label>
        <input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(Math.max(1, parseInt(e.target.value) || 1))}
          className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-center"
          disabled={loading}
        />
        <span className="text-xs text-gray-400">点</span>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => handleStake('PRO')}
          disabled={loading}
          className="flex-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-green-300 text-white text-sm font-medium rounded transition-colors"
        >
          👍 PRO
        </button>
        <button
          onClick={() => handleStake('CON')}
          disabled={loading}
          className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:bg-red-300 text-white text-sm font-medium rounded transition-colors"
        >
          👎 CON
        </button>
      </div>

      {error && (
        <p className="text-red-500 text-xs mt-2">{error}</p>
      )}

      {lastResult && !error && (
        <p className="text-green-600 text-xs mt-2">
          ✅ 已{lastResult.side === 'PRO' ? '支持' : '反对'} {lastResult.amount} 点
        </p>
      )}
    </div>
  );
}
