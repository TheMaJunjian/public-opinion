import { useState, useRef, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExportData } from '../api/client';

const LAST_EXPORT_KEY = 'lastExportData';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ExportViewerModal({ open, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Reset state on every open
  useEffect(() => {
    if (open) {
      setSelectedFile(null);
      setProcessing(false);
      setError(null);
    }
  }, [open]);

  const lastExport = useMemo<{ data: ExportData; title: string } | null>(() => {
    try {
      const raw = sessionStorage.getItem(LAST_EXPORT_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as ExportData;
      return { data, title: data.topic.title };
    } catch { return null; }
  }, []);

  const openData = (data: ExportData) => {
    onClose();
    // Navigate to home first to clear preloaded state, then to viewer.
    // Needed when already on /topics/__preloaded__ — same-route nav won't re-render.
    navigate('/', { replace: true });
    setTimeout(() => navigate('/topics/__preloaded__', { state: { exportData: data }, replace: true }), 0);
  };

  const processAndOpen = () => {
    if (!selectedFile) return;
    setError(null);
    setProcessing(true);
    const reader = new FileReader();
    let cancelled = false;
    reader.onload = () => {
      if (cancelled) return;
      try {
        const text = reader.result as string;
        const data = JSON.parse(text) as ExportData;
        if (!data.topic || !Array.isArray(data.messages)) {
          setError('格式无效：缺少 topic 或 messages 字段');
          setProcessing(false);
          return;
        }
        sessionStorage.setItem(LAST_EXPORT_KEY, text);
        openData(data);
      } catch (error: unknown) {
        setError(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
        setProcessing(false);
      }
    };
    reader.onerror = () => { if (!cancelled) { setError('文件读取失败'); setProcessing(false); } };
    reader.readAsText(selectedFile);
    return () => { cancelled = true; };
  };

  const selectFile = (file: File) => {
    setError(null);
    setSelectedFile(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) selectFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) selectFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '90vw', maxWidth: 500,
        background: '#101010', borderRadius: 12, border: '1px solid #333',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid #333',
          background: '#181818', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>阅览导出文本</div>
          <button onClick={onClose} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 13, cursor: 'pointer',
            background: '#333', color: '#fff', border: '1px solid #666',
          }}>✕</button>
        </div>

        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
          <div style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center' }}>
            选择导出的 JSON 文件，将使用系统中已有的线性和非线性视图进行阅览。
          </div>

          {lastExport && (
            <button onClick={() => openData(lastExport.data)} style={{
              width: '100%', padding: '12px 16px', borderRadius: 8,
              border: '1px solid #4a9eff', background: '#1a2a3c',
              color: '#4a9eff', fontSize: 13, cursor: 'pointer',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>📋 上次阅览：{lastExport.title}</span>
              <span style={{ fontSize: 11, opacity: 0.7 }}>点击打开</span>
            </button>
          )}

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => { if (!selectedFile) fileInputRef.current?.click(); }}
            style={{
              width: '100%', height: 140,
              border: `2px dashed ${dragging ? '#0b84ff' : selectedFile ? '#4ade80' : '#444'}`,
              borderRadius: 10,
              background: dragging ? 'rgba(11,132,255,0.08)' : selectedFile ? 'rgba(74,222,128,0.06)' : '#1a1a1a',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              cursor: selectedFile ? 'default' : 'pointer', gap: 8,
              transition: 'border-color 0.2s, background 0.2s',
            }}
          >
            {processing ? (
              <>
                <div style={{ fontSize: 20 }}>⏳</div>
                <div style={{ color: '#94a3b8', fontSize: 14 }}>正在处理…</div>
              </>
            ) : selectedFile ? (
              <>
                <div style={{ fontSize: 20 }}>📄</div>
                <div style={{ color: '#e2e8f0', fontSize: 14 }}>{selectedFile.name}</div>
                <div style={{ color: '#64748b', fontSize: 11 }}>点击下方按钮阅览</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 24 }}>📁</div>
                <div style={{ color: '#94a3b8', fontSize: 14 }}>拖拽 JSON 文件到此处</div>
                <div style={{ color: '#64748b', fontSize: 11 }}>或点击选择文件</div>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />

          {selectedFile && !processing && (
            <button onClick={processAndOpen} style={{
              width: '100%', padding: '10px 16px', borderRadius: 8,
              border: 'none', background: '#0b84ff',
              color: '#fff', fontSize: 14, cursor: 'pointer',
            }}>
              阅览此文件
            </button>
          )}

          {error && (
            <div style={{ color: '#f87171', fontSize: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 6, width: '100%' }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
