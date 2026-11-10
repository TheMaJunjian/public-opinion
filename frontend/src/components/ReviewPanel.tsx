import {useContext,useEffect,useMemo,useRef,useState} from 'react';
import {reviewEconomy,reviewResult,type ReviewVerdict,type NativeMessageView,type ReviewEligibility} from '@gonglun/core';
import {api} from '../api';
import {reviewStatusLabel} from './ModerationContext';
import ThemeIcon from '../theme/ThemeIcon';
import {ReviewDetailContext,useReviewDetail} from '../hooks/useReviewDetail';
import ArbitrationVoteForm from './ArbitrationVoteForm';
import PromptModal from './PromptModal';
import {useOptionalAuth} from '../context/AuthContext';

const button='record-action px-3 py-1.5 border border-[color:var(--border-default)] rounded text-xs font-medium disabled:opacity-50';
const field={width:'100%',padding:6,border:'1px solid var(--border-default)',borderRadius:4,background:'var(--surface-card)',color:'var(--text-primary)'};
const eligibilityLabels:Partial<Record<ReviewEligibility,string>>={
  'login-required':'登录后，只要能阅读被审核消息，就可以提交审核。',
  closed:'本轮审核窗口已结束，当前不能追加审核。',
  'content-restricted':'当前无权查看被审核正文，暂不能提交审核。',
};
interface Props {
  messageId:string;revision?:number;
  onRecords?:(ids:string[],target?:NativeMessageView)=>Promise<void>;
}
export default function ReviewPanel({messageId,revision,onRecords}:Props){
  const user=useOptionalAuth()?.user;
  const shared=useContext(ReviewDetailContext);
  const sharedCase=shared?.messageId===messageId&&(revision===undefined||shared.revision===undefined||shared.revision===revision);
  const local=useReviewDetail(sharedCase?undefined:messageId,revision);
  const {detail,error:loadError,refresh:load,expired,lostReadAccess,records,target}=sharedCase?shared!:local;
  const [reason,setReason]=useState(''),[amount,setAmount]=useState('2');
  const [direction,setDirection]=useState<ReviewVerdict>('pass');
  const [confirmSettle,setConfirmSettle]=useState(false);
  const [pendingAction,setPendingAction]=useState<string|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const busy=pendingAction!==null;
  const mutationPending=useRef(false);
  const recordsCallback=useRef(onRecords);recordsCallback.current=onRecords;
  useEffect(()=>{
    setError('');setNotice('');setReason('');setDirection('pass');setConfirmSettle(false);setAmount(String(detail?reviewEconomy(detail.policy).minWager:2));
  },[messageId,revision,detail?.summary.caseId,detail?.summary.round]);
  const stakes=useMemo(()=>lostReadAccess?[]:(detail?.stakes??[]).filter(stake=>stake.user&&(stake.side==='PRO'||stake.side==='CON')&&stake.amount>0),[detail?.stakes,lostReadAccess]);
  const myStakes=stakes.filter(stake=>stake.user.id===user?.id);
  useEffect(()=>{const ids=records.map(record=>record.id);void (target?recordsCallback.current?.(ids,target):recordsCallback.current?.(ids))?.catch(e=>setError(e.message));},[records,target]);
  async function act(action:'review'|'review-appeal'|'review-settle'|'review-finalize',verdict?:ReviewVerdict){
    if(!detail||mutationPending.current)return;
    const wager=Number(amount),minimum=reviewEconomy(detail.policy).minWager;
    if(action==='review'&&(!Number.isSafeInteger(wager)||wager<minimum)){setError(`审核押注至少 ${minimum} 点`);return;}
    if(action==='review-appeal'&&!reason.trim()){setError('请填写复核理由');return;}
    mutationPending.current=true;setPendingAction(action);setError('');setNotice('');
    try{
      const side=action==='review-appeal'?(detail.appealVerdict??(detail.summary.status==='unknown'?direction:detail.summary.status==='approved'?'reject':'pass')):verdict;
      const result=await api.sendReviewAction(detail,action,reason.trim(),side,action==='review'?wager:undefined);
      window.dispatchEvent(new CustomEvent('relation-created',{detail:result}));window.dispatchEvent(new Event('points-refresh'));
      window.dispatchEvent(new CustomEvent('stakes-refresh',{detail:{messageId}}));
      setReason('');setAmount(String(minimum));setConfirmSettle(false);setNotice(action==='review'?'投票已记录':'已记录本次审核操作');
      try{await load();}catch{setNotice('操作已获服务器确认，但最新数据读取失败。请刷新查看，勿重复提交。');}
    }catch(e){setError(e instanceof Error?e.message:'提交失败');}finally{mutationPending.current=false;setPendingAction(null);}
  }
  const summary=detail?.summary,settled=summary?.status==='approved'||summary?.status==='rejected'||summary?.status==='unknown';
  const result=summary?reviewResult(summary):'unknown';
  const canReview=!!detail?.canReview&&!lostReadAccess&&!summary?.finalized;
  const economy=detail?reviewEconomy(detail.policy):null;
  const appealCost=detail?.costs?.appealTotal??(economy?1+economy.appealFee+economy.appealDeposit:0);
  const appealVerdict=detail?.appealVerdict??(summary?.status==='unknown'?direction:summary?.status==='approved'?'reject':'pass');
  const eligibility=lostReadAccess?'content-restricted':summary?.finalized?'closed':detail?.reviewEligibility;
  const canSettle=!!detail?.canSettle&&!lostReadAccess&&!summary?.finalized;
  const status=<>{(error||loadError)&&<p role="alert" className="text-xs text-[color:var(--ink-f87171)]">{error||loadError}</p>}{notice&&<p role="status" className="text-xs">{notice}</p>}
    {!detail&&!error&&!loadError&&<p role="status" className="text-sm text-[color:var(--text-muted)]">正在加载审核记录…</p>}
    {eligibility&&eligibilityLabels[eligibility]&&<p className="text-xs text-[color:var(--text-muted)]">{eligibilityLabels[eligibility]}</p>}
    {canReview&&<p className="text-xs text-[color:var(--text-muted)]">你可以阅读该版本，因此可以提交审核，无需等待随机分配。</p>}
    {expired&&<p className="text-xs text-[color:var(--text-muted)]">随机审核任务已到期{lostReadAccess?'，临时阅读权限已收回，受限正文和理由已隐藏':'；阅读和审核资格不受影响'}。</p>}</>;
  return <section aria-label="审核仲裁" className="settlement-panel border border-[color:var(--border-default)] rounded-lg p-4 bg-[color:var(--surface-card)] space-y-4" onClick={event=>event.stopPropagation()}>
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-[color:var(--text-primary)] text-sm"><ThemeIcon name="review" fallback="🛡️"/> 审核仲裁</h3></div>
    {status}
    {detail&&summary&&economy&&<>
      <div className="text-xs text-[color:var(--text-muted)]">累计押注（含自押）</div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        {(['pass','reject'] as const).map(verdict=><div key={verdict} className={`border rounded px-3 py-2 text-center ${verdict==='pass'?'bg-[color:var(--surface-f0fdf4)] border-[color:var(--line-bbf7d0)]':'bg-[color:var(--surface-fef2f2)] border-[color:var(--line-fecaca)]'}`}>
          <div style={{fontSize:18,fontWeight:600,color:verdict==='pass'?'var(--ink-4ade80)':'var(--ink-f87171)'}}>{summary[verdict]} 点</div>
          <div>{verdict==='pass'?'通过':'不通过'}押注</div>
          <div className="text-[color:var(--text-muted)]">含自押 {summary[verdict==='pass'?'selfPass':'selfReject']??0} 点</div>
        </div>)}
      </div>
      <div className="border border-[color:var(--line-a5b4fc-2)] bg-[color:var(--surface-eef2ff)] rounded-lg p-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[color:var(--ink-3730a3)]"><ThemeIcon name="review" fallback="🛡️"/> 审核仲裁</span>
          <button type="button" disabled={busy||!canSettle} onClick={()=>setConfirmSettle(true)}
            title={summary.finalized?'资金已划转':!detail.canSettle?'作者、本轮审核参与者或有效任务接收者可结算':'结算并立即分配资金'}
            className={`px-2 py-1 text-[color:var(--ink-fff-2)] text-xs font-medium rounded transition-colors ${busy||!canSettle?'bg-[color:var(--surface-9ca3af)] cursor-not-allowed':'bg-[color:var(--surface-f59e0b)] hover:bg-[color:var(--surface-d97706)]'}`}>
            {pendingAction==='review-settle'||pendingAction==='review-finalize'?'结算中...':summary.finalized?'已结算':'结算'}
          </button>
        </div>
        <p className="text-xs text-[color:var(--text-muted)]">{reviewStatusLabel[summary.status]}</p>
        <div>
          <div className="text-xs text-[color:var(--text-muted)] mb-1">投票权重（按累计押注点数计算，含自押）</div>
          {result==='unknown'&&summary.pass+summary.reject>0&&<p className="text-xs text-[color:var(--ink-fbbf24)] mb-1">当前平局，结算结果为未定（UNKNOWN），退还双方押注本金。</p>}
          <div className="flex items-stretch gap-1 text-center text-xs">
            <div className="flex-1 bg-[color:var(--surface-card)] rounded px-2 py-1 border border-[color:var(--border-default)]"><div className="font-semibold text-[color:var(--ink-166534)]">{summary.pass}</div><div>通过（PRO）</div></div>
            <span className="flex items-center px-1">{result==='pass'?'>':result==='reject'?'<':'='}</span>
            <div className="flex-1 bg-[color:var(--surface-card)] rounded px-2 py-1 border border-[color:var(--border-default)]"><div className="font-semibold text-[color:var(--ink-991b1b)]">{summary.reject}</div><div>不通过（CON）</div></div>
          </div>
        </div>
        <p className="text-xs text-[color:var(--text-muted)]">按双方累计押注决定结果，不设人数门槛或逐级扩审。自押参与权重与分配，不领取参与报酬。</p>
        {summary.finalized&&summary.releaseAt&&<p className="text-xs">资金已划转 · {new Date(summary.releaseAt).toLocaleString('zh-CN')}</p>}
        {user&&<div className="text-xs text-[color:var(--text-muted)]">我的押注：PRO {myStakes.filter(stake=>stake.side==='PRO').reduce((total,stake)=>total+stake.amount,0)} 点 · CON {myStakes.filter(stake=>stake.side==='CON').reduce((total,stake)=>total+stake.amount,0)} 点</div>}
        {canReview&&<>
          <ArbitrationVoteForm direction={direction} onDirection={value=>setDirection(value as ReviewVerdict)}
            options={[{value:'pass',label:'通过（PRO）'},{value:'reject',label:'不通过（CON）'}]}
            amount={amount} onAmount={setAmount} minimum={economy.minWager} busy={busy} voting={pendingAction==='review'} onVote={()=>void act('review',direction)}/>
          <details className="text-xs"><summary style={{cursor:'pointer'}}>填写审核理由（可选）</summary><textarea aria-label="审核理由" value={reason} maxLength={50000} disabled={busy} onChange={e=>setReason(e.target.value)} rows={3} style={field}/></details>
        </>}
        {!!stakes.length&&<div>
          <div className="text-xs text-[color:var(--text-muted)] mb-1">记录 ({stakes.length}):</div>
          <ul aria-label="审核押注记录" className="divide-y divide-[color:var(--border-default)] max-h-32 overflow-y-auto bg-[color:var(--surface-card)] rounded">
            {stakes.map(stake=><li key={stake.id} className="py-1 flex justify-between px-1.5 rounded text-xs">
              <span className="text-[color:var(--text-primary)]">{stake.user.username}</span>
              <span className={stake.side==='PRO'?'text-[color:var(--ink-utility-green-700)]':'text-[color:var(--ink-utility-red-700)]'}>{stake.side} {stake.amount}点</span>
            </li>)}
          </ul>
        </div>}
      </div>
      <div className="flex gap-2 flex-wrap">
        {detail.canAppeal&&settled&&<button type="button" className={button} disabled={busy||detail.available!==undefined&&detail.available<appealCost} onClick={()=>void act('review-appeal')}>申请复核</button>}
        <button type="button" className={button} disabled={busy} onClick={()=>void load().catch(e=>setError(e.message))}>刷新</button>
      </div>
      {detail.canAppeal&&summary.status==='unknown'&&<label className="text-xs">复核自押方向 <select aria-label="复核自押方向" value={direction} disabled={busy} onChange={event=>setDirection(event.target.value as ReviewVerdict)}><option value="pass">通过（PRO）</option><option value="reject">不通过（CON）</option></select></label>}
      {detail.canAppeal&&settled&&<label style={{display:'block',fontSize:12}}>复核理由（必填）<textarea aria-label="复核理由" value={reason} maxLength={50000} disabled={busy} onChange={e=>setReason(e.target.value)} rows={3} style={field}/></label>}
      {detail.canAppeal&&settled&&<p className="text-xs">本次复核需 {appealCost} 点：审核费 {economy.appealFee}＋自押{appealVerdict==='pass'?'通过':'不通过'} {economy.appealDeposit}＋协议费 {detail.costs?.protocol??1}。{detail.available!==undefined?`可用 ${detail.available} 点。`:''}</p>}
      <details className="text-xs text-[color:var(--text-muted)]"><summary style={{cursor:'pointer'}}>资金与奖励：审核费 {summary.fee} · 累计自押 {summary.deposit}</summary>
        <p>本轮前 {summary.rewardSlots??economy.rewardSlots} 名不同有效审核者各得 {summary.rewardAmount??economy.rewardAmount} 点，已占用 {summary.rewardCount??0} 个名额；剩余预算退付款人。</p>
        <p>发布自押支持通过，复核自押支持所申请的相反结论。自押与审核押注合并结算，胜方按投入比例取回本金并分享反方押注。</p>
        <p>平局为未定（UNKNOWN），退还双方押注本金；再次复核可选择自押方向。</p>
        <p>复核冲正旧押注与自押分配，已完成参与报酬保留。每次操作另付协议费，新增费用须有足够可用点。</p>
      </details>
      <PromptModal open={confirmSettle} title="确认结算" confirmText={busy?'结算中...':'确认结算'} confirmDisabled={busy} cancelText="取消" danger
        message={`通过方押注 ${summary.pass} 点，不通过方押注 ${summary.reject} 点（均含自押）。\n按累计押注点数结算，当前结果：${result==='pass'?'通过（PRO）':result==='reject'?'不通过（CON）':'未定（UNKNOWN），退还双方押注本金'}。\n确认后立即分配押注与自押资金，并结清本轮审核参与报酬。\n本次操作另付协议费 ${detail.costs?.protocol??1} 点。`}
        onConfirm={()=>{if(canSettle)void act(settled?'review-finalize':'review-settle');}} onCancel={()=>{if(!busy)setConfirmSettle(false);}}/>
    </>}
  </section>;
}
