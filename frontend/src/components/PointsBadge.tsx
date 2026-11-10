import { messageScopePath } from '../utils/messageRoutes';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import {dialogStyles} from './dialogStyles';
import ThemeIcon from '../theme/ThemeIcon';
import type { PointsBalance, PointTransaction, PointTransactionMessage } from '../types';
import { useUsagePoints } from './useUsagePoints';
import UsagePointsProgress from './UsagePointsProgress';
import MessageReferenceControl from './MessageReferenceControl';
import PointsTransactionDetails from './PointsTransactionDetails';
import {balanceChange,transactionReferences} from '../utils/pointTransactions';

/**
 * PointsBadge — 导航栏贡献点显示组件。
 * - 窗口聚焦时自动刷新余额
 * - 点击展开贡献点流水面板
 * - 双击记录项：同 view 原地定位（发事件），跨 view 路由跳转
 */
export default function PointsBadge() {
  const { user } = useAuth();
  const usage = useUsagePoints(user?.id);
  const navigate = useNavigate();
  const location = useLocation();
  const [balance, setBalance] = useState<PointsBalance | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [detailTx,setDetailTx]=useState<PointTransaction|null>(null);
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [flash, setFlash] = useState<'gain' | 'loss' | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(()=>{setDetailTx(null);},[user?.id]);

  const fetchBalance = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api.getPointsBalance();
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
        const res = await api.getPointsTransactions({ limit: 1 });
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
    if (!open||detailTx) return;
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-guide-overlay="true"]')) return;
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open,detailTx]);

  useEffect(() => {
    if (!open || !user) return;
    let active = true;
    setTxLoading(true);
    api.getPointsTransactions({ page, limit: 20 }).then(res => {
      if (active) { setTransactions(res.data); setTotalPages(res.pagination.totalPages); }
    }).catch(() => {}).finally(() => { if (active) setTxLoading(false); });
    return () => { active = false; };
  }, [open, user, balance, page]);

  function handleClick() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setPage(1);
    window.dispatchEvent(new Event('guide-points-opened'));
  }

  function changePage(next: number) {
    setTransactions([]);
    setPage(next);
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }

  function navigateToMessage(tx: PointTransaction, reference: PointTransactionMessage) {
    const { messageId, scopeMessageId = 'root', roundId } = reference;
    const targetPath = messageScopePath(scopeMessageId);
    if (location.pathname.replace(/\/+$/, '') === targetPath) {
      window.dispatchEvent(new CustomEvent('points-navigate', {
        detail: { messageId, scopeMessageId, roundId: roundId ?? null, txType: tx.type, txData: tx.data, username: user?.username },
      }));
    } else {
      const params = new URLSearchParams({ msg: messageId });
      // Match in-place navigation: native ledger entries point at the source message.
      if (roundId && ['STAKE_LOCK', 'VOTE_LOCK', 'SETTLEMENT_GAIN', 'SETTLEMENT_LOSS', 'CLAWBACK'].includes(tx.type)) {
        params.set('settlement', messageId);
        params.set('highlightRound', roundId);
      }
      navigate(`${targetPath}?${params.toString()}`);
    }
    setOpen(false);
    setDetailTx(null);
  }

  if (!user) return null;

  if (error || !balance) {
    return (
      <span className="text-[color:var(--ink-a5b4fc-3)] text-xs" title="贡献点加载失败">
        ⚠ 贡献点
      </span>
    );
  }

  const { points, balance: bal, breakdown } = balance;

  return (
    <div className="relative" ref={popRef}>
      <button
        data-guide-points="true"
        aria-label={`贡献点：可用 ${points.available}，锁定 ${points.locked}，累计损失 ${breakdown.totalLost}，累计协议费 ${breakdown.totalProtocolFees}，累计收益 ${breakdown.totalEarned}`}
        onClick={handleClick}
        className={`flex flex-col items-stretch gap-1.5 text-sm hover:opacity-80 transition-opacity cursor-pointer ${flash ? `animate-pulse ring-2 rounded px-1 ${flash === 'gain' ? 'ring-[color:var(--ink-f87171)]' : 'ring-[color:var(--ink-4ade80)]'}` : ''}`}
        title={`可用${points.available} · 锁定${points.locked} · 损失${breakdown.totalLost} · 协议费${breakdown.totalProtocolFees} · 收益${breakdown.totalEarned}`}
      >
        <span className="flex items-center gap-2">
        <span className="text-[color:var(--ink-c7d2fe)]">
          <ThemeIcon name="points" fallback="🪙" /> {points.available.toLocaleString()}
        </span>
        <span className="text-[color:var(--ink-818cf8-3)] text-xs" title={`锁定: ${points.locked}`}>
          <ThemeIcon name="lock" fallback="🔒" />{points.locked}
        </span>
        <span className="text-[color:var(--ink-f87171)] text-xs" title={`累计损失: ${breakdown.totalLost}`}>
          <ThemeIcon name="loss" fallback="📉" />{breakdown.totalLost}
        </span>
        <span className="text-[color:var(--ink-utility-orange-400)] text-xs" title={`累计协议费: ${breakdown.totalProtocolFees}`}>
          <ThemeIcon name="proposal" fallback="🏛" />{breakdown.totalProtocolFees}
        </span>
        <span className="text-[color:var(--ink-4ade80)] text-xs" title={`累计收益: ${breakdown.totalEarned}`}>
          <ThemeIcon name="gain" fallback="📈" />{breakdown.totalEarned}
        </span>
        {bal.debtFrozen && (
          <span className="text-[color:var(--ink-f87171)] text-xs font-bold animate-pulse" title="账户负债冻结">
            ❄️冻结
          </span>
        )}
        {bal.amount < 0 && (
          <span className="text-[color:var(--ink-utility-orange-400)] text-xs" title={`负债: ${bal.amount}`}>
            负债{Math.abs(bal.amount)}
          </span>
        )}
        </span>
        <UsagePointsProgress compact completion={usage.completion} roundId={usage.progress?.roundId} unavailable={!usage.progress || usage.error} />
      </button>

      {/* Popover: transaction list */}
      {open && (
        <div
          ref={panelRef}
          role="dialog" aria-label="贡献点记录"
          aria-hidden={detailTx?true:undefined}
          data-guide-points-panel="true"
          className="absolute right-0 top-full mt-2 w-[30rem] max-w-[calc(100vw-2rem)] z-50 overflow-auto"
          style={{...dialogStyles.panel,maxHeight:'min(44rem, calc(100dvh - 5rem))'}}
          aria-busy={txLoading}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b border-[color:var(--dialog-border)] font-semibold text-sm text-[color:var(--text-primary)] sticky top-0 bg-[color:var(--dialog-surface)]">
            贡献点记录
            <span className="ml-2 font-normal text-xs text-[color:var(--text-muted)]">
              可用 {points.available} · 锁定 {points.locked}
            </span>
          </div>
          <div className="px-3 py-2 border-b border-[color:var(--dialog-border)] text-[color:var(--text-muted)]" style={{lineHeight:1.7,fontSize:11}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',fontSize:12,color:'var(--text-secondary)'}}>
              <span>本轮时间</span><span>{usage.error ? '暂时无法同步' : usage.progress ? `${usage.progress.waitSeconds} 秒` : '同步中'}</span>
            </div>
            <div style={{marginTop:8}}><UsagePointsProgress completion={usage.completion} roundId={usage.progress?.roundId} unavailable={!usage.progress || usage.error} /></div>
            <div style={{marginTop:5}}>每天 00:00 重置时长 · 使用贡献按天汇总</div>
          </div>
          {txLoading && transactions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[color:var(--text-muted)] text-center">加载中...</div>
          ) : transactions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[color:var(--text-muted)] text-center">暂无记录</div>
          ) : (
            <ul className="divide-y divide-[color:var(--dialog-border)]">
              {transactions.map((tx) => {
                const txData = tx.data as Record<string, unknown> | null;
                // Rejection removes excerpts and nested metadata, but the ledger's
                // source ID must still offer a route to the covered message.
                const sourceId=tx.messageId??(typeof txData?.messageId==='string'?txData.messageId:undefined);
                const references=transactionReferences(tx);
                const canNavigate = references.length === 1;
                return (
                <li
                  key={tx.id}
                  data-guide-points-record={txData?.roundId ? String(txData.roundId) : undefined}
                  data-guide-points-message={[...new Set([sourceId,...references.map(reference=>reference.messageId)].filter(Boolean))].join(' ')||undefined}
                  className={`px-3 py-2 text-xs select-none ${canNavigate ? 'cursor-pointer hover:bg-[color:var(--surface-hover)]' : ''}`}
                  onDoubleClick={canNavigate ? (e) => {
                    e.preventDefault();
                    navigateToMessage(tx, references[0]);
                  } : undefined}
                  title={canNavigate ? '双击跳转到相关消息' : undefined}
                >
                  <div className="mb-2 space-y-1">
                    {tx.createdAt&&<div className="text-[color:var(--text-muted)]">{tx.type==='USAGE_REWARD'?'最近记录':'记录时间'} <time dateTime={tx.createdAt}>{new Date(tx.createdAt).toLocaleString('zh-CN')}</time></div>}
                    {references.length===1&&<div style={{overflowWrap:'anywhere'}}>
                      <span className="text-[color:var(--text-secondary)]">关联消息 · ID </span>
                      <MessageReferenceControl messageId={references[0].messageId} type={references[0].messageType??'消息'} summary={references[0].summary}
                        wholeMessage={false} onNavigate={()=>navigateToMessage(tx,references[0])} navigateLabel={`定位消息 ${references[0].messageId}`} />
                    </div>}
                    {references.length>1&&<details onDoubleClick={event=>event.stopPropagation()}>
                      <summary className="cursor-pointer text-[color:var(--text-secondary)]">关联消息 · {references.length} 条</summary>
                      <ul className="mt-1 space-y-1" style={{overflowWrap:'anywhere'}}>
                        {references.map(reference=><li key={`${reference.messageId}:${reference.messageRevision??''}`}>
                          <MessageReferenceControl messageId={reference.messageId} type={reference.messageType??'消息'} summary={reference.summary}
                            wholeMessage={false} onNavigate={()=>navigateToMessage(tx,reference)} navigateLabel={`定位消息 ${reference.messageId}`} />
                        </li>)}
                      </ul>
                    </details>}
                  </div>
                  <div className="flex justify-between items-center gap-2">
                  <div>
                    <span className="font-medium text-[color:var(--text-primary)]">
                      {typeLabel(tx.type)}
                    </span>
                    <span className="ml-1 text-[color:var(--text-muted)]">
                      {txDetail(tx)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className={tx.amount >= 0 ? 'text-[color:var(--ink-4ade80)]' : 'text-[color:var(--ink-ef4444)]'}>
                      {tx.amount >= 0 ? '+' : ''}{tx.amount.toLocaleString()}
                    </span>
                    {tx.type !== 'USAGE_REWARD' && <span className="ml-2 text-[color:var(--text-muted)]">
                      余额 {balanceChange(tx)}
                    </span>}
                    {canNavigate && <span className="ml-1 text-[color:var(--ink-818cf8-3)]" title="双击跳转到相关消息">↗</span>}
                  </div>
                  </div>
                  <div className="flex justify-between items-center gap-2 mt-2">
                    <span className="text-[color:var(--text-muted)]">{!!tx.lockedDelta&&`${tx.lockedDelta>0?'锁定':'解锁'} ${Math.abs(tx.lockedDelta)} 点`}</span>
                    <button type="button" className="text-[color:var(--ink-818cf8-3)] hover:underline" aria-label={`查看${tx.type==='USAGE_REWARD'?'使用贡献':'收支'}详情 ${tx.id}`}
                      onDoubleClick={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();setDetailTx(tx);}}>详情 ›</button>
                  </div>
                </li>
                );
              })}
            </ul>
          )}
          {totalPages > 1 && <div className="px-3 py-2 border-t border-[color:var(--dialog-border)] text-xs text-[color:var(--text-muted)]" style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
            <button type="button" disabled={page <= 1 || txLoading} onClick={() => changePage(page - 1)} style={{...dialogStyles.button,padding:'3px 8px',opacity:page <= 1 ? .4 : 1}}>上一页</button>
            <span>{page} / {totalPages}</span>
            <button type="button" disabled={page >= totalPages || txLoading} onClick={() => changePage(page + 1)} style={{...dialogStyles.button,padding:'3px 8px',opacity:page >= totalPages ? .4 : 1}}>下一页</button>
          </div>}
        </div>
      )}
      {detailTx&&<PointsTransactionDetails transaction={detailTx} onClose={()=>setDetailTx(null)} onNavigate={reference=>navigateToMessage(detailTx,reference)}/>}
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
    LOCK: '锁定',
    SPEND: '支出',
    TRANSFER: '转入',
    MESSAGE_GROUP: '消息收支',
    OPERATION_GROUP: '操作收支',
    USAGE_REWARD: '使用贡献',
    REVENUE_DISTRIBUTION: '收入分配',
    REVENUE_WITHDRAWAL: '收入撤回',
  };
  return labels[type] ?? type;
}

function txDetail(tx: import('../types').PointTransaction): string {
  const d = tx.data??{reason:tx.reason};
  if(tx.type==='MESSAGE_GROUP'||tx.type==='OPERATION_GROUP')return `${tx.entryCount??tx.entries?.length??0} 笔合计`;
  if (tx.type === 'USAGE_REWARD') return `${String(d.day ?? '')} · ${Number(d.count ?? 0)} 次`;

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
  if (d.reason) return String(d.reason).replace('使用公论计时奖励','使用公论计时贡献').replace('使用奖励汇总','使用贡献汇总');

  if (tx.type === 'REVENUE_DISTRIBUTION') return '按贡献点比例分配';
  if (tx.type === 'REVENUE_WITHDRAWAL') return '收入撤回';

  return '';
}

