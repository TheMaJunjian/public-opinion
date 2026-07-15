import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import type { SettlementRoundItem, MessageStakes } from '../types';
import { kindLabel } from '../utils/modelBridge';
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
  onMessageCreated?: (msg: {
    id: string;
    content: string;
    createdAt: string;
    author: string;
    kind: string;
    backendKind?: string;
    settlementTargetId?: string;
    roundPayload?: Record<string, unknown>;
  }) => void;
  /** If set, only show rounds of this settlement type */
  filterSettlementType?: 'TRUTH' | 'VALUE';
}

/**
 * SettlementPanel — 消息结算面板
 * 显示押注池状态、结算轮次、投票和结算操作
 */
export default function SettlementPanel({ messageId, highlightRoundId, entryHighlight, onMessageCreated, filterSettlementType }: Props) {
  const [loading, setLoading] = useState(true);
  const [stakes, setStakes] = useState<MessageStakes | null>(null);
  const [rounds, setRounds] = useState<SettlementRoundItem[]>([]);
  const [activeRounds, setActiveRounds] = useState<SettlementRoundItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Vote form state — removed (now per-round inside ActiveRoundCard)
  const [expandedSettledRound, setExpandedSettledRound] = useState<string | null>(null);

  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    try {
      setLoading(true);
      setError(null);
      const [stakesData, roundsData] = await Promise.all([
        api.getMessageStakes(messageId),
        api.getMessageRounds(messageId),
      ]);
      if (loadId !== loadIdRef.current) return; // cancelled by newer load
      setStakes(stakesData);
      setRounds(roundsData.data);

      // Find ALL active (VOTING/OPEN) rounds — filter by settlementType if specified
      let allActive = roundsData.data.filter(r => r.status === 'VOTING' || r.status === 'OPEN');
      if (filterSettlementType) {
        allActive = allActive.filter(r => r.settlementType === filterSettlementType);
      }
      if (allActive.length > 0) {
        const details = await Promise.all(allActive.map(r => api.getRoundDetail(r.id)));
        if (loadId !== loadIdRef.current) return;
        setActiveRounds(details);
      } else {
        setActiveRounds([]);
      }
    } catch (e: unknown) {
      if (loadId !== loadIdRef.current) return;
      setError((e as Error)?.message ?? '加载失败');
    } finally {
      if (loadId === loadIdRef.current) setLoading(false);
    }
  }, [messageId, filterSettlementType]);

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
      const stype = filterSettlementType ?? 'TRUTH';
      const round = await api.createRound(messageId, { settlementType: stype });
      debugLog('结算', `创建轮次 msg=${messageId.slice(-6)} round=${round.id.slice(-6)} type=${stype}`);
      setActiveRounds(prev => [...prev, round]);
      setRounds(prev => [round, ...prev]);
      window.dispatchEvent(new Event('points-refresh'));
      if (onMessageCreated) {
        onMessageCreated({
          id: round.roundMessageId || round.id,
          content: kindLabel('ROUND', undefined, round.settlementType),
          createdAt: new Date().toISOString(),
          author: '',
          kind: 'round',
          backendKind: 'ROUND',
          settlementTargetId: messageId,
          roundPayload: { settlementType: round.settlementType ?? 'TRUTH', roundId: round.id },
        });
      }
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '创建轮次失败');
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

  // Only count stakes from the filtered rounds for the footer
  const filteredRoundIds = new Set(rounds.filter(r => (!filterSettlementType || r.settlementType === filterSettlementType)).map(r => r.id));
  const filteredStakes = (stakes?.stakes ?? []).filter(s => !s.roundId || filteredRoundIds.has(s.roundId));
  const filteredPro = filteredStakes.filter(s => s.side === 'PRO').reduce((sum, s) => sum + s.amount, 0);
  const filteredCon = filteredStakes.filter(s => s.side === 'CON').reduce((sum, s) => sum + s.amount, 0);
  const totalStaked = filteredPro + filteredCon;
  const hasAnyActive = activeRounds.length > 0;

  const titleLabel = filterSettlementType === 'VALUE' ? '💎 价值仲裁' : filterSettlementType === 'TRUTH' ? '⚖️ 真假仲裁' : '⚖️ 结算市场';

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
        <h3 className="font-semibold text-gray-800 text-sm">
          {titleLabel}
        </h3>
        {activeRounds.length === 0 && (
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

      {/* Pool Summary — cumulative stakes */}
      {totalStaked > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1.5">
            📊 历史累计押注
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-green-50 border border-green-200 rounded px-3 py-2 text-center">
              <div className="text-green-700 font-semibold text-lg">
                {filteredPro}
              </div>
              <div className="text-green-800">PRO 押注</div>
            </div>
            <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-center">
              <div className="text-red-700 font-semibold text-lg">
                {filteredCon}
              </div>
              <div className="text-red-800">CON 押注</div>
            </div>
          </div>
        </div>
      )}

      {/* Active Rounds — each TRUTH/VALUE round in its own card */}
      {activeRounds.map(round => (
        <ActiveRoundCard
          key={round.id}
          round={round}
          messageId={messageId}
          stakes={stakes}
          rounds={rounds}
          entryHighlight={entryHighlight}
          onMessageCreated={onMessageCreated}
          onSettled={(settledId) => {
            setActiveRounds(prev => prev.filter(r => r.id !== settledId));
            load();
          }}
        />
      ))}

      {/* Settled Rounds History */}
      {rounds.filter(r => r.status === 'SETTLED' && (!filterSettlementType || r.settlementType === filterSettlementType)).length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 mb-2">结算历史（双击查看详情）</div>
          <div className="space-y-2">
            {rounds.filter(r => r.status === 'SETTLED' && (!filterSettlementType || r.settlementType === filterSettlementType)).slice(0, 5).map(round => (
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
      {!hasAnyActive && totalStaked > 0 && rounds.filter(r => r.status === 'SETTLED').length === 0 && (
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

/**
 * ActiveRoundCard — renders one active settlement round with its own vote form.
 * Each round (TRUTH or VALUE) is displayed independently.
 */
function ActiveRoundCard({ round, messageId, stakes, rounds, entryHighlight, onMessageCreated, onSettled }: {
  round: SettlementRoundItem;
  messageId: string;
  stakes: MessageStakes | null;
  rounds: SettlementRoundItem[];
  entryHighlight?: { side?: 'PRO' | 'CON'; vote?: 'TRUE' | 'FALSE'; username?: string; stakeId?: string; voteId?: string } | null;
  onMessageCreated?: (msg: {
    id: string;
    content: string;
    createdAt: string;
    author: string;
    kind: string;
    backendKind?: string;
    settlementTargetId?: string;
    roundPayload?: Record<string, unknown>;
  }) => void;
  onSettled: (settledId: string) => void;
}) {
  const { user: currentUser } = useAuth();
  const [voteDirection, setVoteDirection] = useState<'TRUE' | 'FALSE'>('TRUE');
  const [voteAmount, setVoteAmount] = useState(1);
  const [voting, setVoting] = useState(false);
  const [localRound, setLocalRound] = useState(round);
  const [settleError, setSettleError] = useState<string | null>(null);

  const isValue = round.settlementType === 'VALUE';
  const weights = localRound.weights ?? { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  const totalWeight = weights.TRUE + weights.FALSE + weights.UNKNOWN;

  const previousRound = localRound.previousRoundId
    ? rounds.find(r => r.id === localRound.previousRoundId)
    : null;

  async function handleVote() {
    try {
      setVoting(true);
      const result = await api.castVote(localRound.id, { vote: voteDirection, amount: voteAmount });
      debugLog('结算', `投票 round=${localRound.id.slice(-6)} ${voteDirection} ${voteAmount}`);
      setVoteAmount(1);
      window.dispatchEvent(new Event('points-refresh'));
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId } }));
      window.dispatchEvent(new CustomEvent('relation-created', { detail: result }));
      const updated = await api.getRoundDetail(localRound.id);
      setLocalRound(updated);
    } catch {
      // error displayed in parent
    } finally {
      setVoting(false);
    }
  }

  async function handleSettle() {
    if (!confirm('确定要结算此轮次吗？结算后将根据投票权重分配押注池资金，且不可撤销。')) return;
    try {
      setSettleError(null);
      const result = await api.closeAndSettle(localRound.id);
      debugLog('结算', `结算完成 round=${localRound.id.slice(-6)} result=${result.result}`);
      if (onMessageCreated) {
        onMessageCreated({
          id: `settle-${localRound.id}`,
          content: kindLabel('ROUND_RESULT', undefined, localRound.settlementType),
          createdAt: new Date().toISOString(),
          author: '',
          kind: 'round_result',
          settlementTargetId: messageId,
          backendKind: 'ROUND_RESULT',
          roundPayload: { roundId: localRound.id, result: result.result, settlementType: localRound.settlementType },
        });
      }
      onSettled(localRound.id);
      window.dispatchEvent(new CustomEvent('points-flash'));
    } catch (e: unknown) {
      setSettleError((e as Error)?.message ?? '结算失败');
    }
  }

  const roundStakes = (stakes?.stakes ?? []).filter(s => s.roundId === localRound.id);
  const entries = roundStakes.map(s => ({
    id: s.id, entryId: s.id, kind: 'stake' as const, username: s.user.username,
    label: s.side, amount: s.amount, createdAt: s.createdAt,
  })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const headerEmoji = isValue ? '💎' : '🔵';
  const headerLabel = isValue ? '价值仲裁' : '真假仲裁';
  const trueLabel = isValue ? '推荐' : 'TRUE';
  const falseLabel = isValue ? '冷藏' : 'FALSE';

  return (
    <div className="border border-indigo-300 bg-indigo-50 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-indigo-800">
            {headerEmoji} {headerLabel} · 轮次 {localRound.id.slice(-6)}
          </span>
          {previousRound && previousRound.result && (
            <span className="ml-2 text-xs text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
              推翻 {previousRound.result === 'TRUE' ? '✅ TRUE' : previousRound.result === 'FALSE' ? '❌ FALSE' : '⚪ UNKNOWN'}
            </span>
          )}
        </div>
        <button
          onClick={handleSettle}
          disabled={totalWeight === 0}
          className={`px-2 py-1 text-white text-xs font-medium rounded transition-colors ${totalWeight === 0 ? 'bg-gray-400 cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-600'}`}
          title={totalWeight === 0 ? '暂无押注，无法结算' : '结算'}
        >
          结算
        </button>
      </div>

      {/* Settlement error */}
      {settleError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {settleError}
        </div>
      )}

      {/* Weights summary */}
      {totalWeight > 0 && (
        <div className="flex items-stretch gap-1 text-center text-xs">
          <div className={`flex-1 bg-white rounded px-2 py-1 border-2 ${weights.TRUE > weights.FALSE ? 'border-green-400' : 'border-gray-200'}`}>
            <div className="font-semibold text-green-800">{weights.TRUE}</div>
            <div className="text-green-700">{trueLabel}</div>
          </div>
          <div className="flex items-center justify-center px-1">
            <span className={`text-lg font-bold ${weights.TRUE > weights.FALSE ? 'text-green-600' : weights.FALSE > weights.TRUE ? 'text-red-600' : 'text-amber-600'}`}>
              {weights.TRUE > weights.FALSE ? '>' : weights.FALSE > weights.TRUE ? '<' : '='}
            </span>
          </div>
          <div className={`flex-1 bg-white rounded px-2 py-1 border-2 ${weights.FALSE > weights.TRUE ? 'border-red-400' : 'border-gray-200'}`}>
            <div className="font-semibold text-red-800">{weights.FALSE}</div>
            <div className="text-red-700">{falseLabel}</div>
          </div>
        </div>
      )}

      {/* 我的押注 */}
      {currentUser && (
        <MyStakesInRound votes={localRound.votes ?? []} currentUsername={currentUser.username} />
      )}

      {/* Vote Form */}
      <div className="flex items-center gap-2">
        <select
          value={voteDirection}
          onChange={(e) => setVoteDirection(e.target.value as 'TRUE' | 'FALSE')}
          className="text-xs border border-gray-300 rounded px-2 py-1.5 flex-1 bg-white text-gray-800"
        >
          <option value="TRUE">{trueLabel}（PRO）</option>
          <option value="FALSE">{falseLabel}（CON）</option>
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

      {/* Round entries */}
      {entries.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1">记录 ({entries.length}):</div>
          <ul className="divide-y divide-gray-200 max-h-32 overflow-y-auto bg-white rounded">
            {entries.map(e => {
              const isHighlighted = entryHighlight
                ? (entryHighlight.stakeId && e.kind === 'stake' && e.entryId === entryHighlight.stakeId) ||
                  ((!entryHighlight.stakeId && !entryHighlight.voteId) && (
                    (e.kind === 'stake' && entryHighlight.side && e.label === entryHighlight.side && (!entryHighlight.username || entryHighlight.username === e.username))
                  ))
                : false;
              const colorClass = e.label === 'PRO' ? 'text-green-700' : 'text-red-700';
              return (
                <li key={e.id} className={`py-1 flex justify-between px-1.5 rounded text-xs ${isHighlighted ? 'bg-yellow-100 border border-yellow-300' : ''}`}>
                  <span className="text-gray-700">{e.username}</span>
                  <span className={colorClass}>{e.label} {e.amount}点</span>
                </li>
              );
            })}
          </ul>
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
  const { user: currentUser } = useAuth();
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

  // Current round stakes for entry list
  const roundStakes = stakes.filter(s => s.roundId === roundId);
  const entries = roundStakes.map(s => ({
    id: s.id, entryId: s.id, kind: 'stake' as const, username: s.user.username,
    label: s.side, amount: s.amount, createdAt: s.createdAt,
  })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Clawback from previous round (if overturned)
  const prevStakes = detail.previousRoundId ? stakes.filter(s => s.roundId === detail.previousRoundId) : [];
  const clawbackPro = prevStakes.filter(s => s.side === 'PRO').reduce((sum, s) => sum + s.amount, 0);
  const clawbackCon = prevStakes.filter(s => s.side === 'CON').reduce((sum, s) => sum + s.amount, 0);

  // Merge votes from detail.votes + roundStakes for current user
  const myVotes = useMemo(() => {
    const fromVotes = (detail.votes ?? [])
      .filter(v => currentUser && v.user.username === currentUser.username)
      .map(v => ({ vote: v.vote, amount: v.amount }));
    const fromStakes = roundStakes
      .filter(s => currentUser && s.user.username === currentUser.username)
      .map(s => ({ vote: (s.side === 'PRO' ? 'TRUE' : 'FALSE') as 'TRUE' | 'FALSE', amount: s.amount }));
    // Dedupe: prefer detail.votes entries (they have IDs), add stake-only entries
    const voteKeys = new Set(fromVotes.map(v => `${v.vote}_${v.amount}`));
    return [...fromVotes, ...fromStakes.filter(s => !voteKeys.has(`${s.vote}_${s.amount}`))];
  }, [detail.votes, roundStakes, currentUser]);

  return (
    <div className="p-2 space-y-2 text-xs bg-gray-50 text-gray-700">
      <div className="flex justify-between text-gray-500">
        <span className="text-gray-600">发起者: {detail.createdBy?.username}</span>
        <span>{new Date(detail.openedAt).toLocaleString('zh-CN')}</span>
      </div>

      {/* Settlement summary — public + personal */}
      {detail.result && detail.result !== 'UNKNOWN' && (
        <SettlementSummary
          weights={detail.weights ?? { TRUE: 0, FALSE: 0, UNKNOWN: 0 }}
          result={detail.result}
          myVotes={myVotes}
          showPersonal={!!currentUser && myVotes.length > 0}
        />
      )}

      {/* Clawback from previous round */}
      {(clawbackPro > 0 || clawbackCon > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded px-2 py-1.5 text-xs">
          <span className="text-amber-700 font-medium">↩ 推翻扣回</span>
          <span className="text-gray-500 ml-2">
            PRO {clawbackPro} · CON {clawbackCon} · 合计 {clawbackPro + clawbackCon} 点
          </span>
        </div>
      )}

      {/* Merged chronological entries */}
      <div>
        <div className="font-medium text-gray-600 mb-1">记录 ({entries.length}):</div>
        {entries.length > 0 ? (
          <ul className="divide-y divide-gray-200 max-h-48 overflow-y-auto">
            {entries.map(e => {
              const isHighlighted = entryHighlight
                ? (entryHighlight.stakeId && e.kind === 'stake' && e.entryId === entryHighlight.stakeId) ||
                  ((!entryHighlight.stakeId && !entryHighlight.voteId) && (
                    (e.kind === 'stake' && entryHighlight.side && e.label === entryHighlight.side && (!entryHighlight.username || entryHighlight.username === e.username))
                  ))
                : false;
              const colorClass = e.label === 'PRO' ? 'text-green-700' : 'text-red-700';
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

/** 我的押注 — 当前用户在活跃轮次中的投票 */
function MyStakesInRound({ votes, currentUsername }: { votes: SettlementRoundItem['votes']; currentUsername: string }) {
  if (!votes) return null;
  const myVotes = votes.filter(v => v.user.username === currentUsername);
  if (myVotes.length === 0) {
    return <div className="text-xs text-gray-400">我的押注：尚未投票</div>;
  }
  const trueVotes = myVotes.filter(v => v.vote === 'TRUE');
  const falseVotes = myVotes.filter(v => v.vote === 'FALSE');
  const parts: string[] = [];
  if (trueVotes.length > 0) {
    parts.push(`TRUE ${trueVotes.reduce((s, v) => s + v.amount, 0)} 点`);
  }
  if (falseVotes.length > 0) {
    parts.push(`FALSE ${falseVotes.reduce((s, v) => s + v.amount, 0)} 点`);
  }
  return <div className="text-xs text-indigo-700">我的押注：{parts.join('  ')}</div>;
}

/** 结算结果摘要 — 纯展示：公开资金流向 + 个人收益 */
function SettlementSummary({ weights, result, myVotes, showPersonal }: {
  weights: { TRUE: number; FALSE: number };
  result: 'TRUE' | 'FALSE';
  myVotes: Array<{ vote: 'TRUE' | 'FALSE'; amount: number }>;
  showPersonal: boolean;
}) {
  if (weights.TRUE === 0 && weights.FALSE === 0) return null;

  const winnerSide = result === 'TRUE' ? 'PRO' : 'CON';
  const loserSide = result === 'TRUE' ? 'CON' : 'PRO';
  const winnerTotal = result === 'TRUE' ? weights.TRUE : weights.FALSE;
  const loserTotal = result === 'TRUE' ? weights.FALSE : weights.TRUE;
  const rate = winnerTotal > 0 ? Math.round((loserTotal / winnerTotal) * 100) / 100 : 0;

  const myWinnerTotal = myVotes.filter(v => v.vote === result).reduce((s, v) => s + v.amount, 0);
  const myLoserTotal = myVotes.filter(v => v.vote !== result).reduce((s, v) => s + v.amount, 0);
  const myGain = Math.round(myWinnerTotal * rate);
  const myNet = myGain - myLoserTotal;

  return (
    <div className="bg-white rounded border border-gray-200 px-3 py-2 space-y-1 text-xs">
      {/* Public */}
      <div className="text-gray-600">
        {loserSide} 共计 {loserTotal} 点按 {winnerSide} 共计 {winnerTotal} 点分配，胜方每点收益 {rate} 点
      </div>
      {/* Personal */}
      {showPersonal && (
        <div className="text-gray-500 border-t border-gray-100 pt-1 mt-1">
          {myWinnerTotal > 0 && <span>你投了 {result} {myWinnerTotal} 点 → 收益 {myGain} 点</span>}
          {myWinnerTotal > 0 && myLoserTotal > 0 && <span className="mx-2">│</span>}
          {myLoserTotal > 0 && <span>你投了 {result === 'TRUE' ? 'FALSE' : 'TRUE'} {myLoserTotal} 点 → 损失 {myLoserTotal} 点</span>}
          <span className={`ml-2 font-semibold ${myNet >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            → 净{myNet >= 0 ? '收益' : '损失'} {Math.abs(myNet)} 点
          </span>
        </div>
      )}
    </div>
  );
}
