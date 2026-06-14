import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import type { SettlementRoundItem } from '../types';

interface Props {
  messageId: string;
  compact?: boolean;
}

/**
 * RoundHistory — 结算轮次历史与推翻链展示
 */
export default function RoundHistory({ messageId, compact = false }: Props) {
  const [rounds, setRounds] = useState<SettlementRoundItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRound, setExpandedRound] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getMessageRounds(messageId);
      setRounds(data.data);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [messageId]);

  useEffect(() => { load(); }, [load]);

  function resultLabel(result: string | null): string {
    if (!result) return '—';
    const labels: Record<string, string> = { TRUE: 'TRUE', FALSE: 'FALSE', UNKNOWN: 'UNKNOWN' };
    return labels[result] ?? result;
  }

  function resultColor(result: string | null): string {
    if (!result) return 'text-gray-400';
    if (result === 'TRUE') return 'text-green-700';
    if (result === 'FALSE') return 'text-red-700';
    return 'text-amber-700';
  }

  function statusLabel(status: string): string {
    const labels: Record<string, string> = {
      OPEN: '待投票', VOTING: '投票中', SETTLED: '已结算', CANCELLED: '已取消',
    };
    return labels[status] ?? status;
  }

  // Build chain order: follow previousRoundId links
  const chain = buildChain(rounds);

  if (loading) {
    return <div className="text-xs text-gray-500 py-2">加载结算历史...</div>;
  }

  if (error) {
    return <div className="text-xs text-red-700 py-2">{error}</div>;
  }

  if (rounds.length === 0) {
    return <div className="text-xs text-gray-500 py-2">暂无结算记录</div>;
  }

  if (compact) {
    // Compact view: just show latest result
    const latest = rounds.filter(r => r.status === 'SETTLED')[0];
    if (!latest) return <span className="text-xs text-gray-500">未结算</span>;
    return (
      <span className={`text-xs font-semibold ${resultColor(latest.result)}`}>
        {resultLabel(latest.result)}
      </span>
    );
  }

  return (
    <div className="space-y-2">
      {/* Chain visualization */}
      <div className="flex items-center gap-1 text-xs flex-wrap">
        {chain.map((round, idx) => (
          <span key={round.id} className="inline-flex items-center gap-1">
            {idx > 0 && <span className="text-gray-300">→</span>}
            <button
              onDoubleClick={(e) => { e.stopPropagation(); setExpandedRound(expandedRound === round.id ? null : round.id); }}
              className={`px-2 py-0.5 rounded-full border text-xs font-mono transition-colors cursor-pointer select-none ${
                round.status === 'SETTLED'
                  ? `border-gray-300 ${resultColor(round.result)} bg-white hover:bg-gray-50`
                  : round.status === 'VOTING'
                    ? 'border-indigo-300 text-indigo-600 bg-indigo-50'
                    : 'border-gray-200 text-gray-500 bg-gray-50'
              }`}
              title={`${statusLabel(round.status)} · ${resultLabel(round.result)}`}
            >
              {round.status === 'CANCELLED' && '⊘'}
              {resultLabel(round.result)}
            </button>
          </span>
        ))}
      </div>

      {/* Expanded round detail */}
      {expandedRound && (
        <RoundDetail
          roundId={expandedRound}
          messageId={messageId}
          round={rounds.find(r => r.id === expandedRound) ?? null}
          onClose={() => setExpandedRound(null)}
        />
      )}
    </div>
  );
}

/** Build chain from linked list of rounds */
function buildChain(rounds: SettlementRoundItem[]): SettlementRoundItem[] {
  const byId = new Map(rounds.map(r => [r.id, r]));
  const hasPrev = new Set(rounds.filter(r => r.previousRoundId).map(r => r.id));

  // Find the head (round that no other round points to via previousRoundId)
  let head = rounds.find(r => !r.previousRoundId || !byId.has(r.previousRoundId));
  if (!head) head = rounds[rounds.length - 1]; // fallback

  const chain: SettlementRoundItem[] = [];
  const visited = new Set<string>();
  let cur: SettlementRoundItem | undefined = head;
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    chain.push(cur);
    // Find next round that has this round as previous
    cur = rounds.find(r => r.previousRoundId === cur!.id && !visited.has(r.id));
  }

  return chain;
}

/** Expanded detail for a single round */
function RoundDetail({ roundId, messageId, round, onClose }: {
  roundId: string;
  messageId: string;
  round: SettlementRoundItem | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SettlementRoundItem | null>(round);
  const [loading, setLoading] = useState(!round);
  const [stakes, setStakes] = useState<Array<{ id: string; side: string; amount: number; createdAt: string; user: { username: string } }>>([]);
  const [stakesLoading, setStakesLoading] = useState(false);

  useEffect(() => {
    if (detail?.votes) return;
    setLoading(true);
    api.getRoundDetail(roundId)
      .then(d => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [roundId, detail?.votes]);

  // Fetch stakes for the message
  useEffect(() => {
    setStakesLoading(true);
    api.getMessageStakes(messageId)
      .then(s => { setStakes(s.stakes); setStakesLoading(false); })
      .catch(() => setStakesLoading(false));
  }, [messageId]);

  if (!detail) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs">
        {loading ? '加载中...' : '无法加载轮次详情'}
        <button onClick={onClose} className="ml-2 text-indigo-600 hover:underline">关闭</button>
      </div>
    );
  }

  const weights = detail.weights ?? { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  const totalVotes = weights.TRUE + weights.FALSE + weights.UNKNOWN;

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
          <div className="text-xs font-mono text-gray-600">{detail.id}</div>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="text-gray-500">状态: <span className="font-semibold text-gray-700">{detail.status}</span></div>
        <div className="text-gray-500">
          结果: <span className={`font-semibold ${detail.result === 'TRUE' ? 'text-green-700' : detail.result === 'FALSE' ? 'text-red-700' : 'text-amber-700'}`}>
            {detail.result ?? '—'}
          </span>
        </div>
        <div className="text-gray-500">发起者: {detail.createdBy?.username ?? '—'}</div>
        <div className="text-gray-500">
          投票数: {detail._count?.votes ?? 0} · 总权重: {totalVotes}
        </div>
      </div>

      {/* Vote weights bar */}
      {totalVotes > 0 && (
        <div className="flex h-3 rounded-full overflow-hidden border border-gray-200">
          {weights.TRUE > 0 && (
            <div
              className="bg-green-400 h-full"
              style={{ width: `${(weights.TRUE / totalVotes) * 100}%` }}
              title={`TRUE: ${weights.TRUE}`}
            />
          )}
          {weights.FALSE > 0 && (
            <div
              className="bg-red-400 h-full"
              style={{ width: `${(weights.FALSE / totalVotes) * 100}%` }}
              title={`FALSE: ${weights.FALSE}`}
            />
          )}
          {weights.UNKNOWN > 0 && (
            <div
              className="bg-yellow-400 h-full"
              style={{ width: `${(weights.UNKNOWN / totalVotes) * 100}%` }}
              title={`UNKNOWN: ${weights.UNKNOWN}`}
            />
          )}
        </div>
      )}

      {/* Vote list */}
      {detail.votes && detail.votes.length > 0 && (
        <div className="max-h-40 overflow-auto">
          <div className="text-xs text-gray-500 mb-1">投票记录:</div>
          <ul className="divide-y divide-gray-200 text-xs">
            {detail.votes.map(v => (
              <li key={v.id} className="py-1 flex justify-between items-center">
                <span className="text-gray-600">{v.user.username}</span>
                <span className="flex items-center gap-2">
                  <span className={`font-semibold ${
                    v.vote === 'TRUE' ? 'text-green-700' : v.vote === 'FALSE' ? 'text-red-700' : 'text-amber-700'
                  }`}>
                    {v.vote}
                  </span>
                  <span className="text-gray-400">{v.amount} 点</span>
                  <span className="text-gray-400">{new Date(v.createdAt).toLocaleString('zh-CN')}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Stakes on this message */}
      <div className="max-h-40 overflow-auto">
        <div className="text-xs text-gray-500 mb-1">消息押注记录:</div>
        {stakesLoading ? (
          <div className="text-xs text-gray-400">加载中...</div>
        ) : stakes.length === 0 ? (
          <div className="text-xs text-gray-400">无押注记录</div>
        ) : (
          <ul className="divide-y divide-gray-200 text-xs">
            {stakes.map(s => (
              <li key={s.id} className="py-1 flex justify-between items-center">
                <span className="text-gray-600">{s.user.username}</span>
                <span className="flex items-center gap-2">
                  <span className={`font-semibold ${s.side === 'PRO' ? 'text-green-700' : 'text-red-700'}`}>
                    {s.side}
                  </span>
                  <span className="text-gray-400">{s.amount} 点</span>
                  <span className="text-gray-400">{new Date(s.createdAt).toLocaleString('zh-CN')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Previous round link */}
      {detail.previousRoundId && (
        <div className="text-xs text-gray-400">
          ↩ 推翻自轮次: {detail.previousRoundId.slice(-8)}
        </div>
      )}
    </div>
  );
}
