import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExportData } from '../api/client';
import { validateExportForViewing } from '../utils/exportArchive';
import { loadLastExport, saveLastExport } from '../utils/exportViewerCache';
import PopupOverlay from './PopupOverlay';
import PromptModal from './PromptModal';

export { validateExportForViewing } from '../utils/exportArchive';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ExportViewerModal({ open, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [prepared, setPrepared] = useState<ReturnType<typeof validateExportForViewing> | null>(null);
  const [lastExport, setLastExport] = useState<ReturnType<typeof validateExportForViewing> | null>(null);
  const [opening, setOpening] = useState(false);
  const readingGeneration = useRef(0);
  const openingFrame = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Reset state on every open
  useEffect(() => {
    readingGeneration.current += 1;
    let frame = 0;
    let cancelled = false;
    if (open) {
      setSelectedFile(null);
      setProcessing(false);
      setError(null);
      setPrepared(null);
      setOpening(false);
      setLastExport(null);
      // Display the chooser before loading and verifying a large cached archive.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          void loadLastExport().then(cached => {
            if (cancelled || !cached) return;
            try { setLastExport(validateExportForViewing(cached)); }
            catch { /* Invalid historical caches cannot be reopened. */ }
          });
        });
      });
    }
    return () => { cancelled = true; cancelAnimationFrame(frame); cancelAnimationFrame(openingFrame.current); readingGeneration.current += 1; };
  }, [open]);

  const openData = (data: ExportData) => {
    if (opening) return;
    const generation = ++readingGeneration.current;
    setOpening(true);
    // Paint the prompt before serialization, storage and route preparation can
    // occupy the main thread. File selection and cache reopening share this path.
    openingFrame.current = requestAnimationFrame(() => {
      openingFrame.current = requestAnimationFrame(() => {
        if (generation !== readingGeneration.current) return;
        void saveLastExport(data).then(() => {
          if (generation !== readingGeneration.current) return;
          window.dispatchEvent(new Event('prepare-export-viewer'));
          navigate('/viewer', { state: { exportData: data }, replace: true });
          onClose();
        }).catch(error => {
          if (generation !== readingGeneration.current) return;
          setError(`打开阅览文件失败：${error instanceof Error ? error.message : String(error)}`);
          setOpening(false);
        });
      });
    });
  };

  const processAndOpen = () => {
    if (!prepared) return;
    openData(prepared.data);
  };

  const selectFile = (file: File) => {
    const generation = ++readingGeneration.current;
    setError(null);
    setPrepared(null);
    setSelectedFile(file);
    setProcessing(true);
    const reader = new FileReader();
    reader.onload = () => {
      if (generation !== readingGeneration.current) return;
      try {
        setPrepared(validateExportForViewing(JSON.parse(reader.result as string)));
      } catch (error: unknown) {
        setError(`文件校验失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setProcessing(false);
      }
    };
    reader.onerror = () => { if (generation === readingGeneration.current) { setError('文件读取失败'); setProcessing(false); } };
    reader.readAsText(file);
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
    <><PopupOverlay
      contentRef={dialogRef}
      zIndex={1000}
      background="rgba(0,0,0,0.85)"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} style={{
        width: '90vw', maxWidth: 500,
        background: '#101010', borderRadius: 12, border: '1px solid #333',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', color: '#f8fafc',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid #333',
          background: '#181818', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontWeight: 600, fontSize: 16, color: '#f8fafc' }}>阅览导出文本</div>
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
              <span>📋 上次阅览：{lastExport.data.scope.title}</span>
              <span style={{ fontSize: 11, opacity: 0.7 }}>点击打开</span>
            </button>
          )}
          {!selectedFile && lastExport?.verification && <div role="status" style={{ color: '#86efac', fontSize: 12 }}>{lastExport.verification}</div>}

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => { if (!processing) fileInputRef.current?.click(); }}
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
                <div style={{ color: '#64748b', fontSize: 11 }}>{prepared ? '点击下方按钮阅览；点击此处更换文件' : '点击此处更换文件'}</div>
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
            aria-label="选择导出文件"
            accept=".json"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />

          {prepared?.verification && <div role="status" style={{ color: '#86efac', fontSize: 12, padding: '8px 12px', background: 'rgba(34,197,94,0.1)', borderRadius: 6, width: '100%' }}>{prepared.verification}</div>}

          {prepared && !processing && (
            <button onClick={processAndOpen} style={{
              width: '100%', padding: '10px 16px', borderRadius: 8,
              border: 'none', background: '#0b84ff',
              color: '#fff', fontSize: 14, cursor: 'pointer',
            }}>
              阅览此文件
            </button>
          )}

          {error && (
            <div role="alert" style={{ color: '#f87171', fontSize: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 6, width: '100%' }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </PopupOverlay>
    <PromptModal open={opening} title="正在加载" message="正在打开阅览文件，请稍候…" hideActions lockScroll={false} onConfirm={() => undefined} />
    </>
  );
}
