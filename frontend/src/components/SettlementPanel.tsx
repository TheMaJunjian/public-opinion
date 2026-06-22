import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import type { SettlementRoundItem, MessageStakes } from '../types';
import { debugLog } from '../utils/debugLog';

interface Props {
  messageId: string;
  topicId: string;
  highlightRoundId?: string | null;
  entryHighlight?: {
    side?: 'PRO' | 'CON';
    vote?: 'TRUE' | 'FALSE';
    username?: string;
    stakeId?: string;
    voteId?: string;
  } | null;
  onMessageCreated?: (msg: { id: string; content: string; createdAt: string; author: string; kind: string }) => void;
}

/**
 * SettlementPanel — 消息结算面板
 * 显示押注池状态、结算轮次、投票和结算操作
 */
export default function SettlementPanel({ messageId, topicId: _topicId, highlightRoundId, entryHighlight, onMessageCreated }: Props) {
  const [loading, setLoading] = useState(true);
  const [stakes, setStakes] = useState<MessageStakes | null>(null);
  const [rounds, setRounds] = useState<SettlementRoundItem[]>([]);
  const [activeRound, setActiveRound] = useState<SettlementRoundItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Vote form state
  const [voteDirection, setVoteDirection] = useState<'TRUE' | 'FALSE'>('TRUE');
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

  // Listen for stakes-refresh to reload when new stakes are placed (e.g. via agree/disagree)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { messageId?: string };
      if (!detail.messageId || detail.messageId === messageId) {
        api.getMessageStakes(messageId).then(setStakes).catch(() => {});
      }
    };
    window.addEventListener('stakes-refresh', handler);
    return () => window.removeEventListener('stakes-refresh', handler);
  }, [messageId]);

  // Auto-expand highlighted round from points-navigate
  useEffect(() => {
    if (highlightRoundId && rounds.some(r => r.id === highlightRoundId)) {
      setExpandedSettledRound(highlightRoundId);
      sessionStorage.removeItem('settlementHighlightRound');
    }
  }, [highlightRoundId, rounds]);

  // Phase 5: Auto-expand most recent settled round when entryHighlight is set
  useEffect(() => {
    if (!entryHighlight || rounds.length === 0) return;
    const settled = rounds.filter(r => r.status === 'SETTLED');
    if (settled.length > 0) {
      setExpandedSettledRound(settled[0].id);
    }
  }, [entryHighlight, rounds]);

  async function handleCreateRound() {
    try {
      setError(null);
      const round = await api.createRound(messageId);
      debugLog('结算', `创建轮次 msg=${messageId.slice(-6)} round=${round.id.slice(-6)}`);
      setActiveRound(round);
      setRounds(prev => [round, ...prev]);
      window.dispatchEvent(new Event('points-refresh'));
      // Phase 6: add ROUND message to parent's message list immediately
      if (onMessageCreated) {
        onMessageCreated({
          id: round.roundMessageId || round.id,
          content: '⚖️ 发起结算',
          createdAt: new Date().toISOString(),
          author: '', // will be filled by parent from user context
          kind: 'round',
        });
      }
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '创建轮次失败');
    }
  }

  async function handleVote() {
    if (!activeRound) return;
    try {
      setVoting(true);
      setError(null);
      const result = await api.castVote(activeRound.id, { vote: voteDirection, amount: voteAmount });
      debugLog('结算', `投票 round=${activeRound.id.slice(-6)} ${voteDirection} ${voteAmount}`);
      setVoteAmount(1);
      window.dispatchEvent(new Event('points-refresh'));
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId } }));
      // Notify TopicDetailPage to add the created AGREE/DISAGREE relation message
      // result is the RELATION_CREATED response: { message, id, relationType, relationPayload, createdBy, targetRefs, ... }
      window.dispatchEvent(new CustomEvent('relation-created', { detail: result }));
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
      debugLog('结算', `结算完成 round=${activeRound.id.slice(-6)} result=${result.result}`);
      // Phase 6: add ROUND_RESULT (will be replaced by real data on next load)
      (window as any).__addSettlementMessage?.({
        id: `settle-${activeRound.id}`,
        content: `🏁 结算完成 — ${result.result}
—— 资金池已按投票结果分配
双击卡片查看分账明细`,
        createdAt: new Date().toISOString(),
        author: '',
        kind: 'round_result',
        settlementTargetId: messageId,
        backendKind: 'ROUND_RESULT',
      });
      setActiveRound(null);
      setRounds(prev => prev.map(r =>
        r.id === activeRound.id
          ? { ...r, status: 'SETTLED' as const, result: result.result, closedAt: new Date().toISOString() }
          : r
      ));
      window.dispatchEvent(new Event('points-refresh'));
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId } }));
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
  const totalWeight = weights.TRUE + weights.FALSE + weights.UNKNOWN;

  // 上一轮（本轮开始前的历史累计）：历史累计 - 本轮新增投票
  const prevPro = Math.max(0, (stakes?.counts.pro ?? 0) - weights.TRUE);
  const prevCon = Math.max(0, (stakes?.counts.con ?? 0) - weights.FALSE);

  // Find previous round for overturn context
  const previousRound = activeRound?.previousRoundId
    ? rounds.find(r => r.id === activeRound.previousRoundId)
    : null;

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

      {/* Three-row stats: 历史累计 / 上一轮 / 投票 */}
      {totalStaked > 0 && (
        <div className="space-y-3">
          {/* Row 1: 历史累计押注（含本轮，全量） */}
          <div>
            <div className="text-xs text-gray-500 mb-1.5">📊 历史累计押注</div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-green-50 border border-green-200 rounded px-3 py-2 text-center">
                <div className="text-green-700 font-semibold text-lg">{stakes?.counts.pro ?? 0}</div>
                <div className="text-green-800">PRO 押注</div>
              </div>
              <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-center">
                <div className="text-red-700 font-semibold text-lg">{stakes?.counts.con ?? 0}</div>
                <div className="text-red-800">CON 押注</div>
              </div>
            </div>
          </div>

          {/* Row 2: 上一轮（本轮开始前的基线） */}
          {activeRound && (
            <div>
              <div className="text-xs text-gray-500 mb-1.5">📋 上一轮</div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2 text-center">
                  <div className="text-green-700 font-semibold">{prevPro}</div>
                  <div className="text-gray-500">PRO 押注</div>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2 text-center">
                  <div className="text-red-700 font-semibold">{prevCon}</div>
                  <div className="text-gray-500">CON 押注</div>
                </div>
              </div>
            </div>
          )}

          {/* Row 3: 投票（本轮新增押注） */}
          {activeRound && totalWeight > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1.5">🗳️ 投票（本轮新增）</div>
              <div className="flex items-stretch gap-1 text-center text-xs">
                <div className={`flex-1 bg-white rounded px-2 py-1 border-2 ${weights.TRUE > weights.FALSE ? 'border-green-400' : 'border-gray-200'}`}>
                  <div className="font-semibold text-green-800">{weights.TRUE}</div>
                  <div className="text-green-700">TRUE</div>
                </div>
                <div className="flex items-center justify-center px-1">
                  <span className={`text-lg font-bold ${weights.TRUE > weights.FALSE ? 'text-green-600' : weights.FALSE > weights.TRUE ? 'text-red-600' : 'text-amber-600'}`}>
                    {weights.TRUE > weights.FALSE ? '>' : weights.FALSE > weights.TRUE ? '<' : '='}
                  </span>
                </div>
                <div className={`flex-1 bg-white rounded px-2 py-1 border-2 ${weights.FALSE > weights.TRUE ? 'border-red-400' : 'border-gray-200'}`}>
                  <div className="font-semibold text-red-800">{weights.FALSE}</div>
                  <div className="text-red-700">FALSE</div>
                </div>
              </div>
              {weights.TRUE === weights.FALSE && (
                <div className="text-xs text-amber-700 text-center mt-1">⚖️ 平局 → 结算为 UNKNOWN</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Active Round */}
      {activeRound && (
        <div className="border border-indigo-300 bg-indigo-50 rounded-lg p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-indigo-800">
                🔵 结算中 · 轮次 {activeRound.id.slice(-6)}
              </span>
              {/* Overturn context */}
              {previousRound && previousRound.result && (
                <span className="ml-2 text-xs text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
                  推翻 {previousRound.result === 'TRUE' ? '✅ TRUE' : previousRound.result === 'FALSE' ? '❌ FALSE' : '⚪ UNKNOWN'}
                </span>
              )}
            </div>
            <button
              onClick={handleSettle}
              className="px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium rounded transition-colors"
              title="只有轮次发起者可以结算"
            >
              结算
            </button>
          </div>

          {/* Vote Form */}
          <div className="flex items-center gap-2">
            <select
              value={voteDirection}
              onChange={(e) => setVoteDirection(e.target.value as 'TRUE' | 'FALSE')}
              className="text-xs border border-gray-300 rounded px-2 py-1.5 flex-1 bg-white text-gray-800"
            >
              <option value="TRUE">TRUE（支持）</option>
              <option value="FALSE">FALSE（反对）</option>
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

          {/* Round entries (stakes only — votes unified into stakes in Phase 5) */}
          {(() => {
            const roundStakes = (stakes?.stakes ?? []).filter(s => s.roundId === activeRound.id);

            const entries = [
              ...roundStakes.map(s => ({
                id: s.id, entryId: s.id, kind: 'stake' as const, username: s.user.username,
                label: s.side, amount: s.amount, createdAt: s.createdAt,
              })),
            ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

            if (entries.length === 0) return null;

            return (
              <div>
                <div className="text-xs text-gray-500 mb-1">记录 ({entries.length}):</div>
                <ul className="divide-y divide-gray-200 max-h-32 overflow-y-auto bg-white rounded">
                  {entries.map(e => {
                    const isHighlighted = entryHighlight
                      ? (entryHighlight.stakeId && e.kind === 'stake' && e.entryId === entryHighlight.stakeId) ||
                        (entryHighlight.voteId && e.kind === 'vote' && e.entryId === entryHighlight.voteId) ||
                        ((!entryHighlight.stakeId && !entryHighlight.voteId) && (
                          (e.kind === 'vote' && entryHighlight.vote && e.label === entryHighlight.vote && (!entryHighlight.username || entryHighlight.username === e.username)) ||
                          (e.kind === 'stake' && entryHighlight.side && e.label === entryHighlight.side && (!entryHighlight.username || entryHighlight.username === e.username))
                        ))
                      : false;
                    const colorClass = e.label === 'TRUE' || e.label === 'PRO' ? 'text-green-700' : 'text-red-700';
                    return (
                      <li key={e.id} className={`py-1 flex justify-between px-1.5 rounded text-xs ${isHighlighted ? 'bg-yellow-100 border border-yellow-300' : ''}`}>
                        <span className="text-gray-700">{e.username}</span>
                        <span className={colorClass}>{e.label} {e.amount}点</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })()}
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
                    <SettledRoundDetail roundId={round.id} messageId={messageId} entryHighlight={entryHighlight} />
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
function SettledRoundDetail({ roundId, messageId, entryHighlight }: {
  roundId: string;
  messageId: string;
  entryHighlight?: { side?: 'PRO' | 'CON'; vote?: 'TRUE' | 'FALSE'; username?: string; stakeId?: string; voteId?: string } | null;
}) {
  const [detail, setDetail] = useState<import('../types').SettlementRoundItem | null>(null);
  const [stakes, setStakes] = useState<Array<{ id: string; side: string; amount: number; createdAt: string; roundId?: string | null; user: { username: string } }>>([]);
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

  // Merge stakes into chronological list (votes unified into stakes in Phase 5)
  const roundStakes = stakes.filter(s => s.roundId === roundId);
  const entries = [
    ...roundStakes.map(s => ({
      id: s.id, entryId: s.id, kind: 'stake' as const, username: s.user.username,
      label: s.side, amount: s.amount, createdAt: s.createdAt,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="p-2 space-y-2 text-xs bg-gray-50 text-gray-700">
      <div className="flex justify-between text-gray-500">
        <span className="text-gray-600">发起者: {detail.createdBy?.username}</span>
        <span>{new Date(detail.openedAt).toLocaleString('zh-CN')}</span>
      </div>

      {/* Merged chronological entries */}
      <div>
        <div className="font-medium text-gray-600 mb-1">记录 ({entries.length}):</div>
        {entries.length > 0 ? (
          <ul className="divide-y divide-gray-200 max-h-48 overflow-y-auto">
            {entries.map(e => {
              const isHighlighted = entryHighlight
                ? (entryHighlight.stakeId && e.kind === 'stake' && e.entryId === entryHighlight.stakeId) ||
                  (entryHighlight.voteId && e.kind === 'vote' && e.entryId === entryHighlight.voteId) ||
                  ((!entryHighlight.stakeId && !entryHighlight.voteId) && (
                    (e.kind === 'vote' && entryHighlight.vote && e.label === entryHighlight.vote && (!entryHighlight.username || entryHighlight.username === e.username)) ||
                    (e.kind === 'stake' && entryHighlight.side && e.label === entryHighlight.side && (!entryHighlight.username || entryHighlight.username === e.username))
                  ))
                : false;
              const colorClass = e.label === 'TRUE' || e.label === 'PRO' ? 'text-green-700' : 'text-red-700';
              return (
                <li key={e.id} className={`py-1 flex justify-between px-1 rounded ${isHighlighted ? 'bg-yellow-100 border border-yellow-300' : ''}`}>
                  <span className="text-gray-700">{e.username}</span>
                  <span className={colorClass}>{e.label} {e.amount}点</span>
                </li>
              );
            })}
          </ul>
        ) : <div className="text-gray-400">无记录</div>}
      </div>
    </div>
  );
}
