import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import type { SettlementRoundItem, MessageStakes } from '../types';

interface Props {
  messageId: string;
  topicId: string;
  highlightRoundId?: string | null;
}

/**
 * SettlementPanel — 消息结算面板
 * 显示押注池状态、结算轮次、投票和结算操作
 */
export default function SettlementPanel({ messageId, topicId: _topicId, highlightRoundId }: Props) {
  const [loading, setLoading] = useState(true);
  const [stakes, setStakes] = useState<MessageStakes | null>(null);
  const [rounds, setRounds] = useState<SettlementRoundItem[]>([]);
  const [activeRound, setActiveRound] = useState<SettlementRoundItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Vote form state
  const [voteDirection, setVoteDirection] = useState<'TRUE' | 'FALSE' | 'UNKNOWN'>('TRUE');
  const [voteAmount, setVoteAmount] = useState(1);
  const [voting, setVoting] = useState(false);
  const [expandedSettledRound, setExpandedSettledRound] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [stakesData, roundsData] = await Promise.all([
        api.getMessageStakes(messageId),
        api.getMessageRounds(messageId),
      ]);
      setStakes(stakesData);
      setRounds(roundsData.data);

      // Find active (VOTING) round and fetch its full detail (with weights)
      const active = roundsData.data.find(r => r.status === 'VOTING' || r.status === 'OPEN');
      if (active) {
        const detail = await api.getRoundDetail(active.id);
        setActiveRound(detail);
      } else {
        setActiveRound(null);
      }
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [messageId]);

  useEffect(() => { load(); }, [load]);

  // Auto-expand highlighted round from points-navigate
  useEffect(() => {
    if (highlightRoundId && rounds.some(r => r.id === highlightRoundId)) {
      setExpandedSettledRound(highlightRoundId);
      sessionStorage.removeItem('settlementHighlightRound');
    }
  }, [highlightRoundId, rounds]);

  async function handleCreateRound() {
    try {
      setError(null);
      const round = await api.createRound(messageId);
      setActiveRound(round);
      setRounds(prev => [round, ...prev]);
      window.dispatchEvent(new Event('points-refresh'));
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '创建轮次失败');
    }
  }

  async function handleVote() {
    if (!activeRound) return;
    try {
      setVoting(true);
      setError(null);
      await api.castVote(activeRound.id, { vote: voteDirection, amount: voteAmount });
      setVoteAmount(1);
      window.dispatchEvent(new Event('points-refresh'));
      // Reload round to get updated weights
      const updated = await api.getRoundDetail(activeRound.id);
      setActiveRound(updated);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '投票失败');
    } finally {
      setVoting(false);
    }
  }

  async function handleSettle() {
    if (!activeRound) return;
    if (!confirm('确定要结算此轮次吗？结算后将根据投票权重分配押注池资金，且不可撤销。')) return;
    try {
      setError(null);
      const result = await api.closeAndSettle(activeRound.id);
      setActiveRound(null);
      setRounds(prev => prev.map(r =>
        r.id === activeRound.id
          ? { ...r, status: 'SETTLED' as const, result: result.result, closedAt: new Date().toISOString() }
          : r
      ));
      window.dispatchEvent(new Event('points-refresh'));
      // Reload stakes to get updated pool
      const stakesData = await api.getMessageStakes(messageId);
      setStakes(stakesData);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '结算失败');
    }
  }

  function resultLabel(result: string | null): string {
    if (!result) return '未结算';
    const labels: Record<string, string> = { TRUE: '✅ TRUE', FALSE: '❌ FALSE', UNKNOWN: '⚪ UNKNOWN' };
    return labels[result] ?? result;
  }

  function resultColor(result: string | null): string {
    if (!result) return 'text-gray-400';
    if (result === 'TRUE') return 'text-green-700';
    if (result === 'FALSE') return 'text-red-700';
    return 'text-amber-700';
  }

  const totalStaked = (stakes?.counts.pro ?? 0) + (stakes?.counts.con ?? 0);
  const weights = activeRound?.weights ?? { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  const totalVotes = weights.TRUE + weights.FALSE + weights.UNKNOWN;

  if (loading) {
    return (
      <div className="border border-gray-200 rounded-lg p-4 bg-white">
        <div className="text-sm text-gray-500">加载结算数据...</div>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-4" onClick={e => e.stopPropagation()}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-800 text-sm">⚖️ 结算市场</h3>
        {!activeRound && (
          <button
            onClick={handleCreateRound}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded transition-colors"
          >
            发起结算
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Pool Summary */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="bg-green-50 border border-green-200 rounded px-3 py-2 text-center">
          <div className="text-green-700 font-semibold text-lg">
            {stakes?.counts.pro ?? 0}
          </div>
          <div className="text-green-800">PRO 押注</div>
        </div>
        <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-center">
          <div className="text-red-700 font-semibold text-lg">
            {stakes?.counts.con ?? 0}
          </div>
          <div className="text-red-800">CON 押注</div>
        </div>
      </div>

      {/* Active Round */}
      {activeRound && (
        <div className="border border-indigo-300 bg-indigo-50 rounded-lg p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-indigo-800">
              🔵 投票中 · 轮次 {activeRound.id.slice(-6)}
            </span>
            <button
              onClick={handleSettle}
              className="px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium rounded transition-colors"
              title="只有轮次发起者可以结算"
            >
              结算
            </button>
          </div>

          {/* Vote Weights */}
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="bg-white rounded px-2 py-1">
              <div className="font-semibold text-green-800">{weights.TRUE}</div>
              <div className="text-green-700">TRUE</div>
            </div>
            <div className="bg-white rounded px-2 py-1">
              <div className="font-semibold text-red-800">{weights.FALSE}</div>
              <div className="text-red-700">FALSE</div>
            </div>
            <div className="bg-white rounded px-2 py-1">
              <div className="font-semibold text-amber-800">{weights.UNKNOWN}</div>
              <div className="text-amber-700">UNKNOWN</div>
            </div>
          </div>

          {totalVotes > 0 && (
            <div className="text-xs text-gray-500 text-center">
              总投票权重: {totalVotes} 点
            </div>
          )}

          {/* Vote Form */}
          <div className="flex items-center gap-2">
            <select
              value={voteDirection}
              onChange={(e) => setVoteDirection(e.target.value as 'TRUE' | 'FALSE' | 'UNKNOWN')}
              className="text-xs border border-gray-300 rounded px-2 py-1.5 flex-1 bg-white text-gray-800"
            >
              <option value="TRUE">TRUE（支持）</option>
              <option value="FALSE">FALSE（反对）</option>
              <option value="UNKNOWN">UNKNOWN（未知）</option>
            </select>
            <input
              type="number"
              min={1}
              value={voteAmount}
              onChange={(e) => setVoteAmount(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-16 text-xs border border-gray-300 rounded px-2 py-1.5 text-center bg-white text-gray-800"
            />
            <button
              onClick={handleVote}
              disabled={voting}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-xs font-medium rounded transition-colors"
            >
              {voting ? '投票中...' : '投票'}
            </button>
          </div>
        </div>
      )}

      {/* Settled Rounds History */}
      {rounds.filter(r => r.status === 'SETTLED').length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 mb-2">结算历史（双击查看详情）</div>
          <div className="space-y-2">
            {rounds.filter(r => r.status === 'SETTLED').slice(0, 5).map(round => (
              <div key={round.id}>
                <div
                  className={`bg-gray-50 border rounded px-3 py-2 text-xs cursor-pointer hover:bg-gray-100 transition-colors select-none ${expandedSettledRound === round.id ? 'border-indigo-300' : 'border-gray-200'}`}
                  onDoubleClick={() => setExpandedSettledRound(expandedSettledRound === round.id ? null : round.id)}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 font-mono">{round.id.slice(-6)}</span>
                    <span className={resultColor(round.result)}>{resultLabel(round.result)}</span>
                  </div>
                  {round.previousRoundId && (
                    <div className="text-gray-400 mt-1">
                      ↩ 推翻自 {round.previousRoundId.slice(-6)}
                    </div>
                  )}
                  {round.closedAt && (
                    <div className="text-gray-400 mt-0.5">
                      {new Date(round.closedAt).toLocaleString('zh-CN')}
                    </div>
                  )}
                </div>
                {expandedSettledRound === round.id && (
                  <div className="mt-1 border border-indigo-200 rounded">
                    <SettledRoundDetail roundId={round.id} messageId={messageId} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary footer */}
      {!activeRound && totalStaked > 0 && rounds.filter(r => r.status === 'SETTLED').length === 0 && (
        <div className="text-xs text-gray-500 text-center">
          尚无结算记录。点击「发起结算」创建新一轮投票。
        </div>
      )}

      {totalStaked === 0 && (
        <div className="text-xs text-gray-500 text-center">
          暂无押注。发布消息或赞同/反对即可参与押注。
        </div>
      )}
    </div>
  );
}

/** Mini detail view for a settled round inside SettlementPanel */
function SettledRoundDetail({ roundId, messageId }: { roundId: string; messageId: string }) {
  const [detail, setDetail] = useState<import('../types').SettlementRoundItem | null>(null);
  const [stakes, setStakes] = useState<Array<{ id: string; side: string; amount: number; createdAt: string; user: { username: string } }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getRoundDetail(roundId),
      api.getMessageStakes(messageId),
    ]).then(([d, s]) => {
      setDetail(d);
      setStakes(s.stakes);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [roundId, messageId]);

  if (loading) return <div className="text-xs text-gray-400 p-2">加载中...</div>;
  if (!detail) return <div className="text-xs text-gray-400 p-2">加载失败</div>;

  return (
    <div className="p-2 space-y-2 text-xs bg-gray-50 text-gray-700">
      <div className="flex justify-between text-gray-500">
        <span className="text-gray-600">发起者: {detail.createdBy?.username}</span>
        <span>{new Date(detail.openedAt).toLocaleString('zh-CN')}</span>
      </div>

      {/* Votes */}
      <div>
        <div className="font-medium text-gray-600 mb-1">投票记录:</div>
        {detail.votes && detail.votes.length > 0 ? (
          <ul className="divide-y divide-gray-200">
            {detail.votes.map(v => (
              <li key={v.id} className="py-1 flex justify-between">
                <span className="text-gray-700">{v.user.username}</span>
                <span className={v.vote === 'TRUE' ? 'text-green-700' : v.vote === 'FALSE' ? 'text-red-700' : 'text-amber-700'}>
                  {v.vote} {v.amount}点
                </span>
              </li>
            ))}
          </ul>
        ) : <div className="text-gray-400">无投票</div>}
      </div>

      {/* Stakes */}
      <div>
        <div className="font-medium text-gray-600 mb-1">押注记录:</div>
        {stakes.length > 0 ? (
          <ul className="divide-y divide-gray-200">
            {stakes.map(s => (
              <li key={s.id} className="py-1 flex justify-between">
                <span className="text-gray-700">{s.user.username}</span>
                <span className={s.side === 'PRO' ? 'text-green-700' : 'text-red-700'}>
                  {s.side} {s.amount}点
                </span>
              </li>
            ))}
          </ul>
        ) : <div className="text-gray-400">无押注</div>}
      </div>
    </div>
  );
}
