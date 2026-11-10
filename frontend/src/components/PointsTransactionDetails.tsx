import {useEffect,useState} from 'react';
import {api} from '../api';
import type {PointTransaction,PointTransactionMessage} from '../types';
import {balanceChange,lockedChangeLabel,pointsReasonExplanation,pointsReasonLabel,settlementResultLabel,signedPoints,transactionAssetChange,transactionReferences,transactionSummaryQuery,wagerSettlementSummary} from '../utils/pointTransactions';
import PromptModal from './PromptModal';
import MessageReferenceControl from './MessageReferenceControl';
import {dialogStyles} from './dialogStyles';
import PointsReasonBreakdown from './PointsReasonBreakdown';

export default function PointsTransactionDetails({transaction,onClose,onNavigate}:{
  transaction:PointTransaction;onClose:()=>void;onNavigate:(reference:PointTransactionMessage)=>void;
}){
  const [summary,setSummary]=useState<PointTransaction|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;setSummary(null);setError('');
    const query=transactionSummaryQuery(transaction);
    if(!query){setSummary(transaction);return;}
    api.getPointsTransactions(query).then(response=>{
      if(!active)return;
      const value=response.data[0];
      if(value)setSummary(value);else setError('未找到这条记录的汇总');
    }).catch(()=>{if(active)setError('详情加载失败，请重试');});
    return()=>{active=false;};
  },[transaction,attempt]);
  const usage=transaction.type==='USAGE_REWARD',entries=summary?.entries??(summary?[summary]:[]);
  const operation=!!transaction.operationId,scope=operation?'本次操作':'同一消息';
  const income=entries.reduce((total,row)=>total+Math.max(0,row.amount),0),expense=entries.reduce((total,row)=>total+Math.max(0,-row.amount),0);
  const settlement=summary?wagerSettlementSummary(summary,!!transactionSummaryQuery(transaction)):undefined,assetChange=summary?transactionAssetChange(summary):0;
  const references=transactionReferences(summary??transaction),day=String(summary?.data?.day??transaction.data?.day??'');
  return <PromptModal open title="贡献点详情" onConfirm={onClose} confirmText="返回记录" onClose={onClose} onCancel={onClose} hideActions
    dialogProps={{'data-points-detail':'true',style:{width:'min(760px, 100%)',userSelect:'text',WebkitUserSelect:'text'}} as React.HTMLAttributes<HTMLDivElement>}
    message={<div style={{whiteSpace:'normal'}}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="font-semibold">{usage?'使用贡献汇总':operation?'本次操作收支汇总':'消息收支汇总'}</h2>
        <button type="button" style={dialogStyles.button} onClick={onClose}>返回记录</button>
      </div>
      {!summary&&!error?<div role="status">正在加载详情…</div>:error?<div role="alert">{error} <button type="button" style={dialogStyles.button} onClick={()=>setAttempt(value=>value+1)}>重试</button></div>:summary&&<>
        {usage?<div className="space-y-2" aria-label="使用贡献汇总">
          <div>日期：{day}</div>
          <div>累计获得：<strong className="text-[color:var(--ink-4ade80)]">{signedPoints(summary.amount)} 点</strong></div>
          <div>发放次数：{Number(summary.data?.count??summary.amount).toLocaleString()} 次</div>
          <div>最近记录：{new Date(summary.createdAt).toLocaleString('zh-CN')}</div>
          <p className="text-[color:var(--text-muted)]">使用贡献按天累计，同一天持续更新汇总记录。</p>
        </div>:<>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4" aria-label={operation?'本次操作收支合计':'消息收支合计'}>
            <div><dt className="text-[color:var(--text-muted)]">可用增加</dt><dd className={income>0?'text-[color:var(--ink-4ade80)]':undefined}>{signedPoints(income)} 点</dd></div>
            <div><dt className="text-[color:var(--text-muted)]">可用减少</dt><dd className={expense>0?'text-[color:var(--ink-ef4444)]':undefined}>{expense?'-':''}{expense.toLocaleString()} 点</dd></div>
            <div><dt className="text-[color:var(--text-muted)]">锁定变化</dt><dd>{signedPoints(summary.lockedDelta??0)} 点</dd></div>
            <div><dt className="text-[color:var(--text-muted)]">总资产净变化</dt><dd className={assetChange<0?'text-[color:var(--ink-ef4444)]':assetChange>0?'text-[color:var(--ink-4ade80)]':undefined}>{assetChange===0?'0':signedPoints(assetChange)} 点{assetChange===0&&'（总额不变）'}</dd><dd className="text-xs text-[color:var(--text-muted)]">可用 + 锁定</dd></div>
          </dl>
          <p className="mb-4 text-xs text-[color:var(--text-muted)]" aria-label="资产变化说明">本次可用净变化 {signedPoints(summary.amount)} 点，锁定净变化 {signedPoints(summary.lockedDelta??0)} 点。{assetChange===0?'两者相抵，总资产不变。':''}锁定部分仍计入总资产，但暂不可用；预留费用和押注的实际支出或盈亏以结算为准。</p>
          {settlement&&<div className="mb-4 space-y-1" role="group" aria-label="对赌结算结果">
            <div className={`font-semibold ${settlement.net<0?'text-[color:var(--ink-ef4444)]':settlement.net>0?'text-[color:var(--ink-4ade80)]':''}`}>
              {settlementResultLabel(settlement.net)}{settlement.net!==0&&` ${Math.abs(settlement.net).toLocaleString()} 点`}
            </div>
            <div className="text-sm">结算本金 {settlement.principal.toLocaleString()} 点 · 结算到账 {settlement.payout.toLocaleString()} 点</div>
            {settlement.adjustment!==0&&<div className="text-sm">先前结算冲正 {signedPoints(settlement.adjustment)} 点</div>}
            <p className="text-xs text-[color:var(--text-muted)]">投入时已从可用余额转入锁定。结算盈亏 = 到账 − 本金{settlement.adjustment!==0?' + 先前结算冲正':''}；输掉的本金不退回，也不再重复扣减可用余额。</p>
          </div>}
          <PointsReasonBreakdown transaction={summary}/>
          <p className="mt-2 mb-4 text-xs text-[color:var(--text-muted)]">金额单位为点。资产 = 可用余额 + 锁定余额；冻结只在两者之间转移。锁定减少可能是结算扣除或退回，实际到账以可用余额增加为准。</p>
          <div className="mb-2 text-[color:var(--text-secondary)]">{scope}共 {entries.length} 笔记录 · 时间倒序</div>
          <p className="mb-3 text-xs text-[color:var(--text-muted)]">{operation?'同一次操作产生的消息和费用合并展示，以下保留每笔收支及其发生后的可用余额。':'余额为每笔发生时的账户可用余额，期间可能有其他消息的收支。'}</p>
          <div style={{overflowX:'auto'}}><table className="w-full text-left text-xs" aria-label={`${scope}收支明细`}>
            <thead><tr className="text-[color:var(--text-muted)]"><th className="pb-2 pr-3">时间与事项</th><th className="pb-2 pr-3">可用增减</th><th className="pb-2 pr-3">可用余额</th><th className="pb-2">锁定变化</th></tr></thead>
            <tbody>{entries.map(entry=>{
              const reason=entry.reason??String(entry.data?.reason??'收支记录'),explanation=pointsReasonExplanation(reason);
              const reference:PointTransactionMessage=references.find(ref=>ref.messageId===entry.messageId&&ref.messageRevision===entry.messageRevision)
                ??{messageId:entry.messageId!,messageRevision:entry.messageRevision};
              return <tr key={entry.id} className="border-t border-[color:var(--dialog-border)]" aria-current={entry.id===transaction.id?'true':undefined}>
              <td className="py-3 pr-3" style={{overflowWrap:'anywhere'}}>
                <div>{new Date(entry.createdAt).toLocaleString('zh-CN')}</div><div className="font-medium">{pointsReasonLabel(reason)}</div>
                {explanation&&<p className="my-1 text-[color:var(--text-muted)]" style={{lineHeight:1.5}}>{explanation}</p>}
                {entry.messageId&&<MessageReferenceControl messageId={entry.messageId} type={reference.messageType??'消息'} summary={reference.summary} wholeMessage={false} truncateSummary={false}
                  onNavigate={()=>onNavigate(reference)} navigateLabel={`定位明细消息 ${entry.messageId}`} />}
                {entry.id===transaction.id&&<span className="text-[color:var(--text-muted)]">当前查看</span>}
              </td>
              <td className={`py-3 pr-3 whitespace-nowrap ${entry.amount>0?'text-[color:var(--ink-4ade80)]':entry.amount<0?'text-[color:var(--ink-ef4444)]':''}`}>{signedPoints(entry.amount)}</td>
              <td className="py-3 pr-3 whitespace-nowrap">{balanceChange(entry)}</td>
              <td className="py-3 whitespace-nowrap">{lockedChangeLabel(entry.lockedDelta??0)}</td>
            </tr>;})}</tbody>
          </table></div>
        </>}
      </>}
      {!!references.length&&<div className="mt-4 pt-3 border-t border-[color:var(--dialog-border)]" style={{overflowWrap:'anywhere'}}>
        <div className="text-[color:var(--text-muted)] mb-1">关联消息</div>
        {references.map(reference=><div key={`${reference.messageId}:${reference.messageRevision??''}`}>
          <MessageReferenceControl messageId={reference.messageId} type={reference.messageType??'消息'} summary={reference.summary} wholeMessage={false} truncateSummary={false}
            navigateLabel={`定位消息 ${reference.messageId}`} onNavigate={()=>onNavigate(reference)}/>
        </div>)}
      </div>}
    </div>}/>;
}
