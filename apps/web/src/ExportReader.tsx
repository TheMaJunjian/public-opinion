import { useMemo, useRef, useEffect, useState } from 'react';
import { replayArchive, textOf, relations, RELATION_LABELS, type Replay } from '@gonglun/core';

export default function ExportReader({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<Replay | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(30);
  const [filename, setFilename] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const messages = useMemo(() => result?.messages.filter(m => textOf(m).toLowerCase().includes(query.toLowerCase())).reverse() ?? [], [result, query]);
  async function read(file?: File) {
    if (!file) return;
    setError(''); setResult(null);
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('请使用小于 50 MB 的记录文件');
      const parsed: unknown = JSON.parse(await file.text());
      setResult(replayArchive(parsed)); setFilename(file.name); setLimit(30);
    } catch (issue) { setError(issue instanceof Error ? issue.message : '无法读取记录'); }
  }
  return <dialog ref={dialog} className="account-dialog" onCancel={onClose} style={{ width: 'min(800px, 92vw)' }}>
    <div className="dialog-header"><h2>阅览导出记录</h2><button type="button" className="quiet" onClick={onClose} aria-label="关闭记录阅览">×</button></div>
    <p>选择公论导出的记录文件，在本地阅览消息并复算收支。</p>
    <input type="file" accept=".json,application/json" aria-label="选择记录文件" onChange={event => void read(event.target.files?.[0])} />
    {error && <p className="error-box" role="alert">{error}</p>}
    {result && <>
      <p className="positive" role="status">{filename} · 已核对 {result.sequence} 次变更，资金守恒。</p>
      <div className="account-stats"><div><span>消息</span><strong>{result.messages.length}</strong></div><div><span>账户</span><strong>{result.accounts.size}</strong></div><div><span>运营资金</span><strong>{result.operating}</strong></div></div>
      <details><summary>复算后的账户余额</summary><div className="ledger-list">{[...result.accounts].map(([id, account]) => <p key={id} style={{ overflowWrap: 'anywhere' }}>{id} · 可用 {account.available} · 锁定 {account.locked}{account.available < 0 ? ' · 存在待偿还金额' : ''}</p>)}</div></details>
      <input type="search" aria-label="搜索导出消息" placeholder="在导出记录中搜索" value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} style={{ width: '100%', padding: 12, margin: '12px 0' }} />
      <div className="ledger-list">{messages.slice(0, limit).map(message => <article key={message.id} style={{ borderBottom: '1px solid #e2e8e8', padding: '12px 0' }}>
        <small>{relations(message).map(p => RELATION_LABELS[p.relation] ?? p.relation).join(' · ') || '发言'} · 版本 {message.revision}</small>
        {result.states.find(state => state.messageId === message.id)?.suppressed && <p className="trace-label">覆盖已取消 · 组织记录仍可讨论</p>}
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{textOf(message) || '关系及执行记录'}</p>
        <details><summary>查看部件与引用</summary><pre style={{ overflowX: 'auto', fontSize: 12 }}>{JSON.stringify(message.parts, null, 2)}</pre></details>
        {(result.revisions.get(message.id)?.length ?? 0) > 1 && <details><summary>历史版本</summary>{result.revisions.get(message.id)!.map(version => <div key={version.revision}><strong>第 {version.revision} 版</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{textOf(version) || '关系与执行记录'}</p><pre style={{ overflowX: 'auto', fontSize: 12 }}>{JSON.stringify(version.parts, null, 2)}</pre></div>)}</details>}
      </article>)}</div>
      {messages.length > limit && <button type="button" className="quiet" onClick={() => setLimit(value => value + 30)}>继续阅览</button>}
    </>}
  </dialog>;
}
