import { useEffect, useRef, useState } from 'react';
import { RELATION_LABELS, relations, textOf, type Context, type Json, type LedgerEntry, type Message, type Part, type Reference, type Session, type User } from '@gonglun/core';
import { api } from './api';
import { timeLabel } from './MessageCard';

interface Props {
  message?: Message; context: Context | null; loading: boolean; error: string | null;
  user?: User; session: Session | null; activeRef: Reference | null;
  onReference: (reference: Reference) => void; onSelect: (id: string) => void;
  onAction: (relation: string, targets: Reference[], data?: Json) => void; onClose: () => void; onReload: () => void;
  onPreview: (targetId: string, scheme: Message) => void;
  onFollow: (reference: Reference) => void;
}
const partLabels: Record<Part['type'], string> = { text: '文字', web: '网页摘录', code: '代码', relation: '关系', display: '显示方式', data: '内容数据' };

function ValueTree({ value, reference, onReference, depth = 0 }: { value: unknown; reference: Reference; onReference: (reference: Reference) => void; depth?: number }) {
  if (value === null || typeof value !== 'object') return <button type="button" className="value-leaf" onClick={() => onReference(reference)}>{JSON.stringify(value) ?? '空'}</button>;
  if (depth >= 6) return <button type="button" className="value-leaf" onClick={() => onReference(reference)}>选择此内容</button>;
  return <div className="value-tree">{Object.entries(value).slice(0, 60).map(([key, child]) => <div key={key}><button type="button" className="field-name" onClick={() => onReference({ ...reference, path: [...(reference.path || []), Array.isArray(value) ? Number(key) : key] })}>{key}</button><ValueTree value={child} reference={{ ...reference, path: [...(reference.path || []), Array.isArray(value) ? Number(key) : key] }} onReference={onReference} depth={depth + 1}/></div>)}</div>;
}

function PartView({ part, reference, selected, onReference, onFollow }: { part: Part; reference: Reference; selected: boolean; onReference: (reference: Reference) => void; onFollow: (reference: Reference) => void }) {
  const textRef = useRef<HTMLDivElement>(null);
  const selectRange = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !textRef.current) return;
    const range = selection.getRangeAt(0);
    if (!textRef.current.contains(range.startContainer) || !textRef.current.contains(range.endContainer)) return;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(textRef.current);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    onReference({ ...reference, range: { start, end: start + range.toString().length } });
  };
  return <section className={`part-block ${selected ? 'part-selected' : ''}`}>
    <button className="part-heading" type="button" onClick={() => onReference(reference)}><span>{partLabels[part.type]}</span><code>{part.id}</code><span>{selected ? '已选' : '选择'}</span></button>
    {part.type === 'relation' ? <div className="part-body"><button className="relation-field" type="button" onClick={() => onReference({ ...reference, path: ['relation'] })}>{RELATION_LABELS[part.relation] || part.relation}</button>{Object.entries(part.roles).map(([role, bindings]) => <div key={role} className="role-group"><span className="field-name">{role === 'target' ? '目标' : role === 'members' ? '成员' : role === 'parent' ? '所属组织' : role}</span>{bindings.map(binding => <div className="binding" key={binding.id}><button type="button" onClick={() => onReference({ ...reference, memberId: binding.id })}>成员项 {binding.id.slice(-5)}</button><button type="button" onClick={() => onReference({ ...reference, memberId: binding.id, path: ['reference'] })}>引用值</button><button type="button" onClick={() => onFollow(binding.reference)}>↗ {binding.reference.messageId.slice(-7)}</button><details><summary>引用字段</summary><ValueTree value={binding.reference} reference={{ ...reference, memberId: binding.id, path: ['reference'] }} onReference={onReference}/></details></div>)}</div>)}</div>
      : part.type === 'text' || part.type === 'code' || part.type === 'web' ? <div className="part-body"><div ref={textRef} className={part.type === 'code' ? 'inspect-code' : 'inspect-text'} onMouseUp={selectRange}>{part.type === 'text' ? part.text : part.type === 'code' ? part.source : part.excerpt}</div>{part.type === 'web' && <button className="value-leaf" type="button" onClick={() => onReference({ ...reference, path: ['url'] })}>{part.url}</button>}<details><summary>内容字段</summary><ValueTree value={part} reference={reference} onReference={onReference}/></details></div>
        : <div className="part-body"><ValueTree value={part} reference={reference} onReference={onReference}/></div>}
  </section>;
}

export default function Inspector({ message, context, loading, error, user, session, activeRef, onReference, onSelect, onAction, onClose, onReload, onPreview, onFollow }: Props) {
  const [tab, setTab] = useState('content');
  const [pinned, setPinned] = useState(false);
  const [history, setHistory] = useState<Message[]>([]);
  const [historical, setHistorical] = useState<Message | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailCursor, setDetailCursor] = useState<string | null>(null);
  useEffect(() => { setTab('content'); setPinned(false); setHistorical(null); setHistory([]); setDetailError(null); }, [message?.id]);
  useEffect(() => {
    if (!message || activeRef?.messageId !== message.id || !activeRef.revision || activeRef.revision === message.revision) return;
    const abort = new AbortController(); setDetailLoading(true); setDetailError(null);
    void api.message(message.id, activeRef.revision, abort.signal).then(version => { if (abort.signal.aborted) return; setHistorical(version); setPinned(true); setTab('content'); }).catch(issue => { if (!abort.signal.aborted) setDetailError(issue.message); }).finally(() => { if (!abort.signal.aborted) setDetailLoading(false); });
    return () => abort.abort();
  }, [message?.id, activeRef?.revision]);
  useEffect(() => {
    if ((tab !== 'history' || !message) && tab !== 'ledger') return;
    if (tab === 'ledger' && !session) return;
    const abort = new AbortController();
    setDetailLoading(true); setDetailError(null);
    const run = tab === 'history' ? api.history(message!.id, abort.signal).then(page => { setHistory(page.messages); setDetailCursor(page.nextCursor); }) : api.ledger(abort.signal).then(page => { setLedger(page.entries); setDetailCursor(page.nextCursor); });
    void run.catch(issue => { if (!abort.signal.aborted) setDetailError(issue instanceof Error ? issue.message : '读取失败'); }).finally(() => { if (!abort.signal.aborted) setDetailLoading(false); });
    return () => abort.abort();
  }, [tab, message?.id, session?.user.id]);
  const displayed = historical || message;
  const base: Reference | null = displayed ? { messageId: displayed.id, ...(pinned || historical ? { revision: displayed.revision } : {}) } : null;
  const selectedReference = (reference: Reference) => onReference({ ...reference, ...(pinned || historical ? { revision: displayed?.revision } : { revision: undefined }) });
  async function moreDetails() {
    if (!detailCursor || detailLoading || !message) return;
    setDetailLoading(true);
    try {
      if (tab === 'history') { const page = await api.history(message.id, undefined, detailCursor); setHistory(current => [...current, ...page.messages].slice(0, 300)); setDetailCursor(page.nextCursor); }
      else { const page = await api.ledger(undefined, detailCursor); setLedger(current => [...current, ...page.entries].slice(0, 300)); setDetailCursor(page.nextCursor); }
    } catch (issue) { setDetailError(issue instanceof Error ? issue.message : '读取失败'); } finally { setDetailLoading(false); }
  }
  return <aside className={`inspector ${message ? 'has-selection' : ''}`} aria-label="消息详情">
    <div className="inspector-title"><span>消息详情</span><button className="quiet" type="button" onClick={onClose} aria-label="关闭详情">×</button></div>
    {!message ? <div className="inspector-empty"><span className="empty-glyph">↗</span><h3>{loading ? '正在读取消息…' : error || '每条消息，都可以继续讨论'}</h3><p>选择消息，查看证据、关联与分配依据。也可以选择其中一段内容发言。</p></div> : <>
      <div className="inspector-meta"><strong>{user?.name || message.authorId.slice(-8)}</strong><span>{timeLabel(message.createdAt)} · v{displayed?.revision}</span><code>{message.id}</code></div>
      <div className="tabs">{[['content', '内容'], ['relations', '关联'], ['rounds', '结算'], ['history', '历史'], ['ledger', '账本']].map(([key, label]) => <button className={tab === key ? 'active' : ''} key={key} type="button" onClick={() => setTab(key)}>{label}</button>)}</div>
      <div className="inspector-scroll">
        {(error || detailError) && <div className="error-box" role="alert">{error || detailError}<button type="button" className="quiet" onClick={onReload}>重新读取</button></div>}
        {(loading || detailLoading) && <p className="loading-note" role="status">正在读取…</p>}
        {tab === 'content' && displayed && base && <>
          {historical && <div className="notice">正在查看第 {historical.revision} 版<button type="button" onClick={() => { setHistorical(null); setPinned(false); onReference({ messageId: historical.id }); }}>返回当前</button></div>}
          {displayed.authorId === 'system' && displayed.revision > 1 && <div className="notice">内容已修订，执行记录见第 1 版。编辑不会再次执行转账。<button type="button" onClick={() => onFollow({ messageId: displayed.id, revision: 1 })}>查看原始执行记录</button></div>}
          <div className="reference-mode"><label><input type="checkbox" checked={pinned || !!historical} disabled={!!historical} onChange={event => setPinned(event.target.checked)}/> 固定此版本</label><button type="button" onClick={() => onReference(base)}>选择整条消息</button></div>
          {displayed.parts.map(part => <PartView key={`${displayed.revision}-${part.id}`} part={part} reference={{ ...base, partId: part.id }} selected={activeRef?.messageId === displayed.id && activeRef.partId === part.id} onReference={selectedReference} onFollow={onFollow}/>)}
          {session?.user.founder && relations(displayed).some(part => ['amend', 'rule-change'].includes(part.relation)) && <button type="button" className="primary" onClick={() => onAction('authorize', [{ messageId: displayed.id }])}>授权此修改生效</button>}
          {relations(displayed).some(part => part.relation === 'delegate') && <button type="button" onClick={() => onAction('fulfill', [{ messageId: displayed.id }])}>提交完成说明</button>}
          {activeRef?.messageId === displayed.id && <div className="selected-reference"><strong>当前引用</strong><code>{activeRef.partId || '整条消息'}{activeRef.memberId ? ` / ${activeRef.memberId}` : ''}{activeRef.path?.length ? ` / ${activeRef.path.join('.')}` : ''}{activeRef.range ? ` / 第 ${activeRef.range.start + 1}–${activeRef.range.end} 字` : ''} · {activeRef.revision ? `固定 v${activeRef.revision}` : '跟随当前'}</code><div className="inline-actions">{[['reply', '回复'], ['agree', '赞同'], ['disagree', '反对'], ['amend', '修改']].map(([relation, label]) => <button key={relation} type="button" onClick={() => onAction(relation, [activeRef])}>{label}</button>)}</div></div>}
          <div className="inspector-spending"><span>协议费<strong>{message.spending.protocol}</strong></span><span>推荐投入<strong>{message.spending.recommendation}</strong></span><span>对赌资金<strong>{message.spending.wager}</strong></span></div>
        </>}
        {tab === 'relations' && <><p className="section-note">关联消息与显示方案</p>{context?.messages.filter(item => item.id !== message.id).map(item => <button key={item.id} type="button" className="related-item" onClick={() => onSelect(item.id)}><span>{relations(item).map(part => RELATION_LABELS[part.relation] || part.relation).join(' · ') || '发言'}</span><p>{textOf(item).slice(0, 130) || item.id.slice(-10)}</p><small>{timeLabel(item.createdAt)}</small></button>)}{!loading && !context?.messages.some(item => item.id !== message.id) && <p className="section-note">还没有关联消息。</p>}</>}
        {tab === 'rounds' && <>{context?.rounds.map(round => <section className="round-panel" key={round.id}><div><strong>{round.status === 'settled' ? '已结算' : round.status === 'waiting' ? '等待终止' : '进行中'}</strong><code>{round.id.slice(-7)}</code></div><div className="round-amounts"><span>赞同 <strong>{round.pro}</strong></span><span>反对 <strong>{round.con}</strong></span></div>{round.result && <p>{round.result === 'tie' ? '平局' : round.result === 'pro' ? '赞同方获胜' : '反对方获胜'}</p>}{round.endsAt && <p className="section-note">终止时间 {timeLabel(round.endsAt)}</p>}{round.distributionId && <button type="button" onClick={() => onSelect(round.distributionId!)}>查看分配消息 ↗</button>}{round.status === 'open' && <button type="button" onClick={() => onAction('terminate', [round.target], { roundId: round.id })}>发起终止结算</button>}</section>)}{!loading && !context?.rounds.length && <p className="section-note">尚无结算轮次。赞同或反对可以开始对赌讨论。</p>}</>}
        {tab === 'history' && <>{history.map(version => <button type="button" className="related-item" key={version.revision} onClick={() => { setHistorical(version); setPinned(true); setTab('content'); }}><span>第 {version.revision} 版</span><p>{textOf(version).slice(0, 100) || '关系与内容更新'}</p><small>{timeLabel(version.updatedAt)}</small></button>)}{!detailLoading && !history.length && <p className="section-note">暂无历史版本。</p>}</>}
        {tab === 'ledger' && (!session ? <p className="section-note">登录后查看自己的资金明细。</p> : <><p className="section-note">最近的贡献点收支</p>{ledger.map(entry => <button type="button" className="ledger-entry" key={entry.id} onClick={() => onFollow({ messageId: entry.messageId, revision: 'messageRevision' in entry ? Number(entry.messageRevision) : 1 })}><div><strong className={entry.amount >= 0 ? 'positive' : 'negative'}>{entry.amount > 0 ? '+' : ''}{entry.amount}</strong><span>{entry.reason}</span></div><small>{timeLabel(entry.createdAt)}{entry.lockedDelta ? ` · 锁定 ${entry.lockedDelta > 0 ? '+' : ''}${entry.lockedDelta}` : ''}</small></button>)}{!detailLoading && !ledger.length && <p className="section-note">暂无收支记录。</p>}</>)}
        {['history', 'ledger'].includes(tab) && detailCursor && (tab === 'history' ? history.length : ledger.length) < 300 && <button type="button" className="load-more" disabled={detailLoading} onClick={() => void moreDetails()}>加载更早记录</button>}
        {tab === 'relations' && <><button type="button" className="load-more" onClick={() => onAction('presentation', [{ messageId: message.id }])}>提出显示方案</button>{context?.messages.filter(item => item.parts.some(part => part.type === 'display' && part.target?.messageId === message.id)).map(scheme => <section className="round-panel" key={`scheme-${scheme.id}`}><strong>{textOf(scheme).slice(0, 70) || `显示方案 ${scheme.id.slice(-5)}`}</strong><div className="inline-actions"><button type="button" onClick={() => onPreview(message.id, scheme)}>预览</button><button type="button" onClick={() => onAction('agree', [{ messageId: scheme.id }])}>赞同</button><button type="button" onClick={() => onAction('disagree', [{ messageId: scheme.id }])}>反对</button></div></section>)}</>}
      </div>
    </>}
  </aside>;
}
