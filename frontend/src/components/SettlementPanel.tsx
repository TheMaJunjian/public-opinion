import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { useAuth, useOptionalAuth } from '../context/AuthContext';
import type { SettlementRoundItem, MessageStakes } from '../types';
import { operationLog } from '../utils/debugLog';
import PromptModal from './PromptModal';

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

type PersonalSettlement = NonNullable<SettlementRoundItem['personalSettlement']>;

/**
 * SettlementPanel — 消息结算面板
 * 显示押注池状态、结算轮次、投票和结算操作
 */
export default function SettlementPanel({ messageId, highlightRoundId, entryHighlight, onMessageCreated, filterSettlementType }: Props) {
  const { user: currentUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [stakes, setStakes] = useState<MessageStakes | null>(null);
  const [rounds, setRounds] = useState<SettlementRoundItem[]>([]);
  const [activeRounds, setActiveRounds] = useState<SettlementRoundItem[]>([]);
  const [latestPersonalSettlement, setLatestPersonalSettlement] = useState<PersonalSettlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingRound, setCreatingRound] = useState(false);

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
        setLatestPersonalSettlement(null);
      } else {
        setActiveRounds([]);
        const latestSettled = roundsData.data.find(r =>
          r.status === 'SETTLED' && (!filterSettlementType || r.settlementType === filterSettlementType),
        );
        if (latestSettled) {
          const detail = await api.getRoundDetail(latestSettled.id);
          if (loadId !== loadIdRef.current) return;
          setLatestPersonalSettlement(detail.personalSettlement ?? null);
        } else {
          setLatestPersonalSettlement(null);
        }
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
        void load();
      }
    };
    window.addEventListener('stakes-refresh', handler);
    return () => window.removeEventListener('stakes-refresh', handler);
  }, [messageId, load]);

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
    if (creatingRound) return;
    try {
      setError(null);
      setCreatingRound(true);
      const stype = filterSettlementType ?? 'TRUTH';
      const round = await api.createRound(messageId, { settlementType: stype });
      operationLog('发起结算', `message=${messageId} round=${round.id} type=${stype}`);
      setActiveRounds(prev => [...prev, round]);
      setRounds(prev => [round, ...prev]);
      window.dispatchEvent(new Event('points-refresh'));
      if (onMessageCreated) {
        const settlementLabel = round.settlementType === 'VALUE' ? '价值仲裁' : '真假仲裁';
        onMessageCreated({
          id: round.roundMessageId || round.id,
          content: `发起${settlementLabel}：目标消息 ${messageId.slice(-8)}；轮次 ${round.id.slice(-8)}`,
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
    } finally {
      setCreatingRound(false);
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
  const settledRounds = rounds.filter(r => r.status === 'SETTLED' && (!filterSettlementType || r.settlementType === filterSettlementType));
  const allRoundStake = filteredStakes.reduce((sum, stake) => sum + stake.amount, 0);
  const allRoundPro = filteredStakes.filter(stake => stake.side === 'PRO').reduce((sum, stake) => sum + stake.amount, 0);
  const allRoundCon = filteredStakes.filter(stake => stake.side === 'CON').reduce((sum, stake) => sum + stake.amount, 0);
  const currentUserStakes = currentUser
    ? filteredStakes.filter(stake => stake.user.username === currentUser.username)
    : [];
  const currentUserStake = currentUserStakes.reduce((sum, stake) => sum + stake.amount, 0);
  const currentUserProStake = currentUserStakes.filter(stake => stake.side === 'PRO').reduce((sum, stake) => sum + stake.amount, 0);
  const currentUserConStake = currentUserStakes.filter(stake => stake.side === 'CON').reduce((sum, stake) => sum + stake.amount, 0);
  const projectedResult = allRoundPro > allRoundCon ? 'TRUE' : allRoundCon > allRoundPro ? 'FALSE' : 'UNKNOWN';
  const projectedWinnerTotal = projectedResult === 'TRUE' ? allRoundPro : allRoundCon;
  const projectedLoserTotal = projectedResult === 'TRUE' ? allRoundCon : allRoundPro;
  const projectedProfit = projectedWinnerTotal > 0 ? projectedLoserTotal / projectedWinnerTotal : 0;
  const projectedPayout = projectedResult === 'UNKNOWN'
    ? currentUserStake
    : Math.round((projectedResult === 'TRUE' ? currentUserProStake : currentUserConStake) * (1 + projectedProfit))
      - (projectedResult === 'TRUE' ? currentUserConStake : currentUserProStake);
  const personalSettlement = activeRounds[0]?.personalSettlement ?? latestPersonalSettlement;
  const investedContribution = personalSettlement?.principal ?? currentUserStake;
  const projectedAfter = activeRounds.length > 0
    ? Math.max(0, projectedPayout)
    : personalSettlement?.after ?? currentUserStake;
  const projectedChange = activeRounds.length > 0
    ? projectedAfter - investedContribution
    : personalSettlement?.change ?? 0;

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
            disabled={creatingRound}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-xs font-medium rounded transition-colors"
          >
            {creatingRound ? '创建中...' : '发起结算'}
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
            📊 所有已结算轮次累计押注
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
          totalRoundStake={allRoundStake}
          totalRoundPro={allRoundPro}
          totalRoundCon={allRoundCon}
          entryHighlight={entryHighlight}
          onMessageCreated={onMessageCreated}
          onSettled={(settledId) => {
            setActiveRounds(prev => prev.filter(r => r.id !== settledId));
            load();
          }}
        />
      ))}

      {/* Settled Rounds History */}
      {settledRounds.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 mb-2">结算历史（双击查看详情）</div>
          <div className="text-xs text-gray-600 bg-indigo-50 border border-indigo-200 rounded px-3 py-2 mb-2">
            所有轮次总押注 {allRoundStake} 点（PRO {allRoundPro}，CON {allRoundCon}）·{' '}
            {currentUser
              ? `当前与会者投入 ${investedContribution} 点 → ${activeRounds.length > 0 ? '预计结算后' : '当前'}贡献点 ${projectedAfter} 点，${projectedChange >= 0 ? '收益' : '损失'}${Math.abs(projectedChange)} 点`
              : '当前与会者未登录，无法显示个人变化'}
          </div>
          <div className="space-y-2">
            {settledRounds.slice(0, 5).map(round => (
              <div key={round.id}>
                <div
                  data-guide-settlement-history={round.id}
                  className={`bg-gray-50 border rounded px-3 py-2 text-xs cursor-pointer hover:bg-gray-100 transition-colors select-none ${expandedSettledRound === round.id ? 'border-indigo-300' : 'border-gray-200'}`}
                  onDoubleClick={() => setExpandedSettledRound(expandedSettledRound === round.id ? null : round.id)}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 font-mono">{round.id.slice(-6)}</span>
                    <span className={resultColor(round.result)}>{resultLabel(round.result)}</span>
                  </div>
                  {round.previousRoundId && round.result !== null && (() => {
                    const previousRound = rounds.find(r => r.id === round.previousRoundId);
                    return previousRound?.result && previousRound.result !== round.result;
                  })() && (
                    <div className="text-gray-400 mt-1">
                      ↩ 推翻自 {round.previousRoundId.slice(-6)}
                    </div>
                  )}
                  {round.closedAt && (
                    <div className="text-gray-400 mt-0.5">
                      {new Date(round.closedAt).toLocaleString('zh-CN')}
                    </div>
                  )}
                  <div className="text-gray-500 mt-1">
                    本轮押注 {(round.settlementPro ?? round.weights?.TRUE ?? 0) + (round.settlementCon ?? round.weights?.FALSE ?? 0)} 点 · 收益 {round.result === 'TRUE' ? (round.settlementCon ?? round.weights?.FALSE ?? 0) : round.result === 'FALSE' ? (round.settlementPro ?? round.weights?.TRUE ?? 0) : 0} 点
                  </div>
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
function ActiveRoundCard({ round, messageId, stakes, rounds, totalRoundStake, totalRoundPro, totalRoundCon, entryHighlight, onMessageCreated, onSettled }: {
  round: SettlementRoundItem;
  messageId: string;
  stakes: MessageStakes | null;
  rounds: SettlementRoundItem[];
  totalRoundStake: number;
  totalRoundPro: number;
  totalRoundCon: number;
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
  const [voteAmount, setVoteAmount] = useState<number | ''>(1);
  const [voting, setVoting] = useState(false);
  const [settling, setSettling] = useState(false);
  const [localRound, setLocalRound] = useState(round);
  const [roundDetails, setRoundDetails] = useState<Record<string, SettlementRoundItem>>({});
  const [settleError, setSettleError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isValue = round.settlementType === 'VALUE';
  const weights = localRound.weights ?? { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  const totalWeight = weights.TRUE + weights.FALSE + weights.UNKNOWN;

  const previousRound = localRound.previousRoundId
    ? rounds.find(r => r.id === localRound.previousRoundId)
    : null;

  useEffect(() => {
    const relevantRounds = rounds.filter(r => r.settlementType === localRound.settlementType && r.status === 'SETTLED');
    void Promise.all([
      ...relevantRounds.map(async r => [r.id, await api.getRoundDetail(r.id)] as const),
      api.getRoundDetail(localRound.id).then(detail => [localRound.id, detail] as const),
    ]).then(details => setRoundDetails(Object.fromEntries(details))).catch(() => {});
  }, [rounds, localRound.settlementType]);

  async function handleVote() {
    if (voting || settling) return;
    if (typeof voteAmount !== 'number' || !Number.isInteger(voteAmount) || voteAmount <= 0) {
      setSettleError('投票押注必须是大于 0 的整数');
      return;
    }
    try {
      setSettleError(null);
      setVoting(true);
      const result = await api.castVote(localRound.id, { vote: voteDirection, amount: voteAmount });
      operationLog('投票', `round=${localRound.id} vote=${voteDirection} amount=${voteAmount}`);
      setVoteAmount(1);
      window.dispatchEvent(new Event('points-refresh'));
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId } }));
      window.dispatchEvent(new CustomEvent('relation-created', { detail: result }));
      const updated = await api.getRoundDetail(localRound.id);
      setLocalRound(updated);
    } catch (e: unknown) {
      setSettleError((e as Error)?.message ?? '投票失败');
    } finally {
      setVoting(false);
    }
  }

  async function handleSettle() {
    if (voting || settling) return;
    setConfirmOpen(true);
  }

  const totalStake = weights.TRUE + weights.FALSE;
  const settlementWeights = { TRUE: totalRoundPro, FALSE: totalRoundCon };
  const settlementResult = settlementWeights.TRUE > settlementWeights.FALSE
    ? 'TRUE'
    : settlementWeights.FALSE > settlementWeights.TRUE
      ? 'FALSE'
      : 'UNKNOWN';
  const winningWeight = settlementResult === 'TRUE' ? settlementWeights.TRUE : settlementResult === 'FALSE' ? settlementWeights.FALSE : 0;
  const profitPool = settlementResult === 'TRUE' ? settlementWeights.FALSE : settlementResult === 'FALSE' ? settlementWeights.TRUE : 0;
  const winnerRate = winningWeight > 0 ? Math.round((profitPool / winningWeight) * 100) / 100 : 0;
  const getMyVotes = (roundItem: SettlementRoundItem) => {
    if (!currentUser) return [];
    const roundStakes = (stakes?.stakes ?? []).filter(stake =>
      (stake.roundId === roundItem.id || !stake.roundId) && stake.user.username === currentUser.username,
    );
    const stakeVotes = roundStakes.map(stake => ({
      vote: (stake.side === 'PRO' ? 'TRUE' : 'FALSE') as 'TRUE' | 'FALSE',
      amount: stake.amount,
    }));
    return stakeVotes;
  };
  const personalDetail = roundDetails[localRound.id]?.personalSettlement;
  const personalStakePrincipal = personalDetail?.stakePrincipal ?? getMyVotes(localRound).reduce((sum, vote) => sum + vote.amount, 0);
  const personalProtocolFee = personalDetail?.protocolFee ?? 0;
  const personalPrincipal = personalDetail?.principal ?? personalStakePrincipal + personalProtocolFee;
  const currentUserCumulativeVotes = rounds
    .filter(item => item.settlementType === localRound.settlementType)
    .flatMap(item => getMyVotes(item));
  const currentUserCumulativeStake = currentUserCumulativeVotes.reduce((sum, vote) => sum + vote.amount, 0);
  const currentUserWinnerStake = currentUserCumulativeVotes
    .filter(vote => vote.vote === settlementResult)
    .reduce((sum, vote) => sum + vote.amount, 0);
  const currentUserLoserStake = currentUserCumulativeVotes
    .filter(vote => vote.vote !== settlementResult)
    .reduce((sum, vote) => sum + vote.amount, 0);
  const winnerTotal = settlementResult === 'TRUE' ? totalRoundPro : totalRoundCon;
  const loserTotal = settlementResult === 'TRUE' ? totalRoundCon : totalRoundPro;
  const currentRoundPayout = settlementResult === 'UNKNOWN'
    ? currentUserCumulativeStake
    : currentUserCumulativeStake === 0
      ? 0
      : Math.round(currentUserWinnerStake * (1 + (loserTotal / winnerTotal || 0))) - currentUserLoserStake;
  const previousAfter = personalDetail?.previousAfter ?? personalPrincipal;
  const projectedAfter = Math.max(0, currentRoundPayout > 0 ? currentRoundPayout : previousAfter + currentRoundPayout);
  const projectedChange = projectedAfter - previousAfter;
  const personalSettlementPrompt = currentUser && personalPrincipal > 0
    ? `截至本轮累计投入贡献 ${personalPrincipal} 点（押注${personalStakePrincipal}点，协议费${personalProtocolFee}点） → 上一轮结算为 ${previousAfter} 点 → 本轮预计结算后贡献点为 ${projectedAfter} 点；本轮预计贡献点变化：${projectedChange >= 0 ? '收益' : '损失'}${Math.abs(projectedChange)} 点。`
    : '当前与会者未贡献押注点';
  const settlementPrompt = `本轮押注：${totalStake} 点（PRO ${weights.TRUE}，CON ${weights.FALSE}）。\n总押注：${totalRoundStake} 点（PRO ${totalRoundPro}，CON ${totalRoundCon}）。\n结算结果：${settlementResult === 'TRUE' ? '赞同胜出' : settlementResult === 'FALSE' ? '反对胜出' : 'UNKNOWN 平局'}。\n总收益池：${profitPool} 点；\n胜方每点押注收益：${settlementResult === 'UNKNOWN' ? '无（平局，双方贡献点全部返还）' : `${winnerRate} 点`}。\n当前与会者贡献结算：${personalSettlementPrompt}`;

  async function handleSettleConfirmed() {
    if (voting || settling) return;
    try {
      setSettleError(null);
      setSettling(true);
      setConfirmOpen(false);
      const result = await api.closeAndSettle(localRound.id);
      operationLog('完成结算', `round=${localRound.id} result=${result.result}`);
      const settlementLabel = localRound.settlementType === 'VALUE' ? '价值仲裁' : '真假仲裁';
      const resultLabel = result.result === 'TRUE' ? '赞成胜出' : result.result === 'FALSE' ? '反对胜出' : '平局';
      const resultContent = result.resultContent
        ?? `${settlementLabel}完成：目标消息 ${messageId.slice(-8)}；结果：${resultLabel}（${result.result}）；TRUE 权重 ${result.weights.TRUE}，FALSE 权重 ${result.weights.FALSE}`;

      const resultMsgId = result.resultMessage?.id ?? `settle-${localRound.id}`;
      const resultCreatedAt = result.resultMessage?.createdAt ?? new Date().toISOString();
      const resultAuthor = result.resultMessage?.createdBy?.username ?? '';

      if (onMessageCreated) {
        onMessageCreated({
          id: resultMsgId,
          content: resultContent,
          createdAt: resultCreatedAt,
          author: resultAuthor,
          kind: 'round_result',
          settlementTargetId: messageId,
          backendKind: 'ROUND_RESULT',
          roundPayload: { roundId: localRound.id, result: result.result, settlementType: localRound.settlementType },
        });
      }
      window.dispatchEvent(new CustomEvent('guide-settlement-confirmed', { detail: { roundId: localRound.id } }));
      onSettled(localRound.id);
      window.dispatchEvent(new Event('points-refresh'));
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId } }));
      window.dispatchEvent(new CustomEvent('points-flash'));
      window.dispatchEvent(new Event('revenue-refresh'));
    } catch (e: unknown) {
      setSettleError((e as Error)?.message ?? '结算失败');
    } finally {
      setSettling(false);
      setConfirmOpen(false);
    }
  }

  const roundStakes = (stakes?.stakes ?? []).filter(s => s.roundId === localRound.id);
  const entries = roundStakes.map(s => ({
    id: s.id, entryId: s.id, kind: 'stake' as const, username: s.user.username,
    label: s.side, amount: s.amount, createdAt: s.createdAt,
  })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const headerEmoji = isValue ? '💎' : '🔵';
  const headerLabel = isValue ? '价值仲裁' : '真假仲裁';
  const trueLabel = isValue ? '推荐' : '赞同';
  const falseLabel = isValue ? '冷藏' : '反对';

  return (
    <div className="border border-indigo-300 bg-indigo-50 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-indigo-800">
            {headerEmoji} {headerLabel} · 轮次 {localRound.id.slice(-6)}
          </span>
          {previousRound && previousRound.result && previousRound.result !== settlementResult && (
            <span className="ml-2 text-xs text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
              推翻 {previousRound.result === 'TRUE' ? '✅ TRUE' : previousRound.result === 'FALSE' ? '❌ FALSE' : '⚪ UNKNOWN'} → {settlementResult === 'TRUE' ? '✅ TRUE' : settlementResult === 'FALSE' ? '❌ FALSE' : '⚪ UNKNOWN'}
            </span>
          )}
        </div>
        <button
          onClick={() => { window.dispatchEvent(new Event('guide-settle-selected')); void handleSettle(); }}
          data-guide-settle="true"
          disabled={totalWeight === 0 || voting || settling}
          className={`px-2 py-1 text-white text-xs font-medium rounded transition-colors ${totalWeight === 0 || voting || settling ? 'bg-gray-400 cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-600'}`}
          title={totalWeight === 0 ? '暂无押注，无法结算' : voting ? '投票请求处理中' : settling ? '结算请求处理中' : '结算'}
        >
          {settling ? '结算中...' : '结算'}
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
        <div>
          <div className="text-xs text-gray-500 mb-1">本轮投票权重（按投票押注点数计算）</div>
          {weights.TRUE === weights.FALSE && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1">
              当前平局，结算结果将为 UNKNOWN
            </div>
          )}
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
          onChange={(e) => {
            const raw = e.target.value;
            setVoteAmount(raw === '' ? '' : Number(raw));
          }}
          className="w-16 text-xs border border-gray-300 rounded px-2 py-1.5 text-center bg-white text-gray-800"
        />
        <button
          onClick={handleVote}
          disabled={voting || settling}
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

      <PromptModal
        open={confirmOpen}
        title="确认结算"
        guideSettlementConfirm
        message={`${settlementPrompt}\n\n结算后将根据投票权重分配押注池贡献点，可继续发起结算，但本次结算不可撤销。\n确定要结算此轮次吗？`}
        confirmText={settling ? '结算中...' : '确认结算'}
        confirmDisabled={settling}
        cancelText="取消"
        danger
        onConfirm={() => {
          if (!settling) {
            void handleSettleConfirmed();
          }
        }}
        onCancel={() => {
          if (!settling) {
            setConfirmOpen(false);
          }
        }}
      />
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
  const [previousDetail, setPreviousDetail] = useState<import('../types').SettlementRoundItem | null>(null);
  const [stakes, setStakes] = useState<Array<{ id: string; side: string; amount: number; createdAt: string; roundId?: string | null; user: { username: string } }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getRoundDetail(roundId).then(async d => {
      const [previous, s] = await Promise.all([
        d.previousRoundId ? api.getRoundDetail(d.previousRoundId) : Promise.resolve(null),
        api.getMessageStakes(messageId),
      ]);
      setDetail(d);
      setPreviousDetail(previous);
      setStakes(s.stakes);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [roundId, messageId]);

  if (loading) return <div className="text-xs text-gray-400 p-2">加载中...</div>;
  if (!detail) return <div className="text-xs text-gray-400 p-2">加载失败</div>;

  return <SettledRoundDetailView detail={detail} previousDetail={previousDetail} stakes={stakes} roundId={roundId} entryHighlight={entryHighlight} />;
}

/** Pure render — all data already loaded, no early returns */
function SettledRoundDetailView({ detail, previousDetail, stakes, roundId, entryHighlight }: {
  detail: import('../types').SettlementRoundItem;
  previousDetail: import('../types').SettlementRoundItem | null;
  stakes: Array<{ id: string; side: string; amount: number; createdAt: string; roundId?: string | null; user: { username: string } }>;
  roundId: string;
  entryHighlight?: { side?: 'PRO' | 'CON'; vote?: 'TRUE' | 'FALSE'; username?: string; stakeId?: string; voteId?: string } | null;
}) {
  const auth = useOptionalAuth();
  const currentUser = auth?.user ?? null;

  const roundStakes = stakes.filter(s => s.roundId === roundId);
  const entries = roundStakes.map(s => ({
    id: s.id, entryId: s.id, kind: 'stake' as const, username: s.user.username,
    label: s.side, amount: s.amount, createdAt: s.createdAt,
  })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const prevStakes = detail.previousRoundId ? stakes.filter(s => s.roundId === detail.previousRoundId) : [];
  const clawbackPro = prevStakes.filter(s => s.side === 'PRO').reduce((sum, s) => sum + s.amount, 0);
  const clawbackCon = prevStakes.filter(s => s.side === 'CON').reduce((sum, s) => sum + s.amount, 0);

  const roundWeights = detail.roundWeights ?? { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  const totalProAtSettlement = detail.totalProAtSettlement ?? null;
  const totalConAtSettlement = detail.totalConAtSettlement ?? null;

  return (
    <div className="p-2 space-y-2 text-xs bg-gray-50 text-gray-700">
      <div className="flex justify-between text-gray-500">
        <span className="text-gray-600">发起者: {detail.createdBy?.username}</span>
        <span>{new Date(detail.openedAt).toLocaleString('zh-CN')}</span>
      </div>

      {detail.result && (
        <SettlementSummary
          weights={roundWeights}
          result={detail.result}
          previousResult={previousDetail?.result ?? null}
          totalProAtSettlement={totalProAtSettlement}
          totalConAtSettlement={totalConAtSettlement}
          showPersonal={!!currentUser && Boolean(detail.personalSettlement)}
          cumulativeWeights={detail.weights ?? { TRUE: 0, FALSE: 0, UNKNOWN: 0 }}
          personalSettlement={detail.personalSettlement}
        />
      )}

      {(clawbackPro > 0 || clawbackCon > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded px-2 py-1.5 text-xs">
          <span className="text-amber-700 font-medium">↩ 推翻扣回</span>
          <span className="text-gray-500 ml-2">
            PRO {clawbackPro} · CON {clawbackCon} · 合计 {clawbackPro + clawbackCon} 点
          </span>
        </div>
      )}

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

/** 我的押注 — 当前与会者在活跃轮次中的投票 */
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
function SettlementSummary({ weights, result, previousResult, totalProAtSettlement, totalConAtSettlement, showPersonal, cumulativeWeights, personalSettlement }: {
  weights: { TRUE: number; FALSE: number };
  result: 'TRUE' | 'FALSE' | 'UNKNOWN';
  previousResult: 'TRUE' | 'FALSE' | 'UNKNOWN' | null;
  totalProAtSettlement: number | null;
  totalConAtSettlement: number | null;
  showPersonal: boolean;
  cumulativeWeights: { TRUE: number; FALSE: number; UNKNOWN: number };
  personalSettlement?: { principal: number; stakePrincipal: number; protocolFee: number; change: number; after: number; previousAfter?: number };
}) {
  const totalStake = weights.TRUE + weights.FALSE;
  const totalAtSettlement = totalProAtSettlement !== null && totalConAtSettlement !== null
    ? totalProAtSettlement + totalConAtSettlement
    : null;
  const resultLabel = result === 'TRUE' ? 'TRUE（PRO 胜出）' : result === 'FALSE' ? 'FALSE（CON 胜出）' : 'UNKNOWN（PRO、CON 相等）';
  const resultChanged = previousResult !== null && previousResult !== result;
  const cumulativeTotal = cumulativeWeights.TRUE + cumulativeWeights.FALSE;

  if (result === 'UNKNOWN') {
    return (
      <div className="bg-white rounded border border-gray-200 px-3 py-2 space-y-1 text-xs">
        <div className="text-gray-600">本轮本金 {totalStake} 点：PRO 方 {weights.TRUE} 点，CON 方 {weights.FALSE} 点。</div>
        <div className="text-gray-600">结算累计总计 {cumulativeTotal} 点：PRO 方 {cumulativeWeights.TRUE} 点，CON 方 {cumulativeWeights.FALSE} 点。</div>
        {totalAtSettlement !== null && (
          <div className="text-gray-600">本次结算完成时总押注 {totalAtSettlement} 点：PRO 方 {totalProAtSettlement} 点，CON 方 {totalConAtSettlement} 点。</div>
        )}
        <div className="text-amber-700">本次结算结果：{resultLabel}。</div>
        {resultChanged && previousResult && (
          <div className="text-amber-700">上轮结果：{previousResult}；本轮结果不同，构成推翻，双方所有贡献点返还。</div>
        )}
        {showPersonal && personalSettlement && (
          <div className="text-gray-500 border-t border-gray-100 pt-1 mt-1">
            截至本轮累计投入贡献 {personalSettlement.principal} 点（押注{personalSettlement.stakePrincipal}点，协议费{personalSettlement.protocolFee}点）
            {personalSettlement.previousAfter !== undefined && ` → 上一轮结算为 ${personalSettlement.previousAfter} 点`}
            {` → 本轮结算后贡献点为 ${personalSettlement.after} 点；本轮贡献点变化：${personalSettlement.change >= 0 ? '收益' : '损失'}${Math.abs(personalSettlement.change)} 点。`}
          </div>
        )}
      </div>
    );
  }

  const loserTotal = result === 'TRUE' ? weights.FALSE : weights.TRUE;
  const winnerTotal = result === 'TRUE' ? weights.TRUE : weights.FALSE;
  const rate = winnerTotal > 0 ? Math.round((loserTotal / winnerTotal) * 100) / 100 : 0;

  return (
    <div className="bg-white rounded border border-gray-200 px-3 py-2 space-y-1 text-xs">
      {/* Public */}
      <div className="text-gray-600">
        本轮本金 {totalStake} 点：PRO 方 {weights.TRUE} 点，CON 方 {weights.FALSE} 点。
      </div>
      <div className="text-gray-600">
        结算累计总计 {cumulativeTotal} 点：PRO 方 {cumulativeWeights.TRUE} 点，CON 方 {cumulativeWeights.FALSE} 点。
      </div>
      {totalAtSettlement !== null && (
        <div className="text-gray-600">
          本次结算完成时总押注 {totalAtSettlement} 点：PRO 方 {totalProAtSettlement} 点，CON 方 {totalConAtSettlement} 点。
        </div>
      )}
      <div className="text-gray-600">
        本次结算结果：{resultLabel}。累计收益池 {loserTotal} 点；胜方每点押注收益 {rate} 点，胜方贡献本金返还后按权重分配收益。
      </div>
      {resultChanged && previousResult && (
        <div className="text-amber-700">上轮结果：{previousResult}；本轮结果不同，构成推翻，重新分配贡献点。</div>
      )}
      {/* Personal */}
      {showPersonal && personalSettlement && (
        <div className="text-gray-500 border-t border-gray-100 pt-1 mt-1">
          <span>截至本轮累计投入贡献 {personalSettlement.principal} 点（押注{personalSettlement.stakePrincipal}点，协议费{personalSettlement.protocolFee}点）</span>
          {personalSettlement.previousAfter !== undefined && <span> → 上一轮结算为 {personalSettlement.previousAfter} 点</span>}
          <span> → 本轮结算后贡献点为 {personalSettlement.after} 点；本轮贡献点变化：{personalSettlement.change >= 0 ? '收益' : '损失'}{Math.abs(personalSettlement.change)} 点</span>
        </div>
      )}
    </div>
  );
}
