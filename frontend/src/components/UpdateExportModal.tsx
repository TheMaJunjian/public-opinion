import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { mergeExportUpdate, prepareExportUpdate, type UpdatableExportData } from '../utils/exportArchive';
import { saveUpdatedExport } from '../utils/saveExport';
import PromptModal from './PromptModal';

export default function UpdateExportModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<'choose' | 'updating' | 'ready' | 'saving'>('choose');
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [result, setResult] = useState<{ data: UpdatableExportData; filename: string; added: number } | null>(null);
  const generation = useRef(0);
  const readerRef = useRef<FileReader | null>(null);
  useEffect(() => () => { generation.current++; readerRef.current?.abort(); }, []);
  const busy = phase === 'updating' || phase === 'saving';

  function chooseFile(file: File) {
    const request = ++generation.current;
    readerRef.current?.abort();
    setPhase('updating'); setError(null); setResult(null); setFilename(file.name);
    const reader = new FileReader();
    readerRef.current = reader;
    reader.onerror = () => { if (generation.current === request) { setError('文件读取失败，请重新选择'); setPhase('choose'); } };
    reader.onload = () => {
      void (async () => {
        const { data, checkpoint } = await prepareExportUpdate(JSON.parse(String(reader.result)));
        if (generation.current !== request) return;
        const update = await api.updateExportMessages(data.scope.messageId ?? 'root', checkpoint);
        if (generation.current !== request) return;
        const merged = mergeExportUpdate(data, checkpoint, update);
        setResult({ data: merged, filename: file.name, added: update.changes.length });
        setPhase('ready');
      })().catch(error => {
        if (generation.current !== request) return;
        setError(`更新导出失败：${error instanceof Error ? error.message : String(error)}`);
        setPhase('choose');
      });
    };
    reader.readAsText(file);
  }

  async function save() {
    if (!result || busy) return;
    setPhase('saving'); setError(null);
    try {
      await saveUpdatedExport(result.data, result.filename);
      onClose();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')) {
        setError(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
      setPhase('ready');
    }
  }

  return <PromptModal open title="更新已有导出" confirmText="保存更新文件" confirmDisabled={phase !== 'ready'}
    cancelText="关闭" onConfirm={() => { void save(); }} onCancel={phase === 'saving' ? undefined : onClose}
    message={<div style={{ display: 'grid', gap: 12 }}>
      <div>选择已有的 JSON 导出文件，只下载缺少的执行记录，并更新消息状态。</div>
      <input aria-label="选择要更新的导出文件" type="file" accept=".json,application/json" disabled={busy}
        onChange={event => { const file = event.target.files?.[0]; if (file) chooseFile(file); event.target.value = ''; }} />
      {filename && <div style={{ fontSize: 13 }}>文件：{filename}</div>}
      {busy && <div role="status">{phase === 'updating' ? '正在校验旧文件、补充新增记录并更新消息，请稍候…' : '正在保存更新文件，请稍候…'}</div>}
      {result && !busy && <div role="status" style={{ color: '#86efac' }}>
        {result.added ? `已补充 ${result.added} 次变更` : '执行记录已是最新'}，现有 {result.data.messages.length} 条消息。完整性及资金守恒校验通过。
      </div>}
      {result && !busy && <div style={{ fontSize: 12, color: '#94a3b8' }}>保存时选择原文件即可覆盖更新；部分浏览器会下载一个更新后的文件。</div>}
      {error && <div role="alert" style={{ color: '#f87171' }}>{error}</div>}
    </div>} />;
}
