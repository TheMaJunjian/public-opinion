import { useEffect, useRef, useState } from 'react';
import type { ExportData } from '../api/client';
import type { PreparedExport } from '../utils/exportTask';
import { startArchiveExport } from '../utils/exportWorker';
import { downloadExport, saveUpdatedExport } from '../utils/saveExport';
import PromptModal from './PromptModal';
import { conversionFailure } from '@gonglun/core';

interface Props {
  onClose: () => void; scopeMessageId: string; filename: string;
  source?: ExportData | null; view: NonNullable<ExportData['view']>;
}
export default function ExportModal({ onClose, scopeMessageId, filename, source, view }: Props) {
  const [phase, setPhase] = useState<'choose' | 'preparing' | 'ready' | 'saving'>('choose');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<PreparedExport | null>(null);
  const generation = useRef(0);
  const job = useRef<ReturnType<typeof startArchiveExport> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { generation.current++; job.current?.cancel(); }, []);
  const busy = phase === 'preparing' || phase === 'saving';

  async function prepare() {
    const request = ++generation.current;
    setPhase('preparing'); setError(null); setStatus('正在准备导出…');
    try {
      job.current = startArchiveExport(file ? { kind: 'update', file } : { kind: 'full', scopeMessageId, source, view },
        message => { if (generation.current === request) setStatus(message); });
      const prepared = await job.current.result;
      if (generation.current !== request) return;
      job.current = null;
      if (file) { setResult(prepared); setPhase('ready'); }
      else { downloadExport(prepared.blob, filename); onClose(); }
    } catch (error) {
      if (generation.current !== request) return;
      setError(`导出失败\n${conversionFailure(error,'unchanged','本次文件处理已取消，原 JSON 文件和缓存均未修改。').message}`);
      setPhase('choose');
    }
  }

  async function save() {
    if (!result || !file) return;
    setPhase('saving'); setError(null);
    try {
      await saveUpdatedExport(result.blob, file.name);
      onClose();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')) {
        setError(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
      setPhase('ready');
    }
  }

  return <PromptModal open title="导出" confirmText={phase === 'ready' ? '保存更新文件' : file ? '更新文件' : '导出文件'}
    confirmDisabled={busy} cancelText="关闭" onConfirm={() => { if (!busy) void (phase === 'ready' ? save() : prepare()); }}
    onCancel={phase === 'saving' ? undefined : () => { generation.current++; job.current?.cancel(); onClose(); }}
    message={<div style={{ display: 'grid', gap: 12 }}>
      <div>直接导出完整文件；也可以选择已有文件，只获取新增记录并更新消息状态。</div>
      <input ref={inputRef} aria-label="选择要更新的导出文件（可选）" type="file" accept=".json,application/json" disabled={busy}
        onChange={event => { setFile(event.target.files?.[0] ?? null); setResult(null); setError(null); setPhase('choose'); }} />
      {file && <div style={{ fontSize: 13 }}>文件：{file.name}</div>}
      {file && <button type="button" disabled={busy} onClick={() => { setFile(null); setResult(null); setError(null); setPhase('choose');
        if (inputRef.current) inputRef.current.value = ''; }}>
        移除所选文件，改为完整导出
      </button>}
      {busy && <div role="status">{phase === 'preparing' ? status : '正在保存更新文件，请稍候…'}</div>}
      {result && !busy && <div role="status" style={{ color: 'var(--ink-86efac)' }}>
        {result.added ? `已补充 ${result.added} 次变更` : '执行记录已是最新'}，现有 {result.messageCount} 条消息。完整性及资金守恒校验通过。
      </div>}
      {result && !busy && <div style={{ fontSize: 12, color: 'var(--ink-94a3b8)' }}>保存时选择原文件即可覆盖更新；部分浏览器会下载一个更新后的文件。</div>}
      {error && <div role="alert" style={{ color: 'var(--ink-f87171)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error}</div>}
    </div>} />;
}
