import { useEffect, useRef, useState } from 'react';
import { replayArchive } from '@gonglun/core';
import { request } from './api';
import { collectArchive, type ExportPage } from './export';

export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [cutoff, setCutoff] = useState('');
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => controller.current?.abort(); }, []);
  async function download() {
    setBusy(true); setError(''); setCount(0);
    const abort = new AbortController(); controller.current = abort;
    try {
      const through = cutoff ? new Date(cutoff).getTime() : undefined;
      if (through !== undefined && !Number.isFinite(through)) throw new Error('请选择有效的截止时间');
      const snapshot = await request<{ sequence: number }>('/messages?limit=1', { signal: abort.signal });
      const archive = await collectArchive(snapshot.sequence, after => request<ExportPage>(`/export?after=${after}&limit=100`, { signal: abort.signal }), through, setCount);
      replayArchive(archive);
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(archive)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `公论-${(through === undefined ? new Date() : new Date(through)).toISOString().slice(0, 10)}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (issue) { if (!abort.signal.aborted) setError(issue instanceof Error ? issue.message : '导出失败'); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <dialog ref={dialog} className="account-dialog" onCancel={onClose}>
    <div className="dialog-header"><h2>导出记录</h2><button type="button" className="quiet" aria-label="关闭导出" onClick={onClose}>×</button></div>
    <p>保存截止时间前的公开消息、历史版本、规则和账本，便于重新阅览和复算。</p>
    <label>截止时间（留空表示当前）<input type="datetime-local" aria-label="导出截止时间" value={cutoff} disabled={busy} onChange={event => setCutoff(event.target.value)} style={{ display: 'block', width: '100%', padding: 12, margin: '12px 0' }}/></label>
    {error && <p className="error-box" role="alert">{error}</p>}
    {busy && <p role="status">已读取 {count} 次变更…</p>}
    <button type="button" className="primary" disabled={busy} onClick={() => void download()}>{busy ? '正在导出…' : '下载记录'}</button>
  </dialog>;
}
