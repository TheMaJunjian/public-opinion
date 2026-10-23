import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExportData } from '../api/client';
import { validateExportForViewing,prepareExportForViewing } from '../utils/exportArchive';
import { loadLastExport, saveLastExport } from '../utils/exportViewerCache';
import PopupOverlay from './PopupOverlay';
import { DIALOG_BACKDROP, dialogStyles } from './dialogStyles';
import PromptModal from './PromptModal';
import { conversionFailure } from '@gonglun/core';

export { validateExportForViewing } from '../utils/exportArchive';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ExportViewerModal({ open, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
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
      setCacheError(null);
      setPrepared(null);
      setOpening(false);
      setLastExport(null);
      // Display the chooser before loading and verifying a large cached archive.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          void loadLastExport().then(async cached => {
            if (cancelled || cached===null) return;
            const prepared=await prepareExportForViewing(cached);
            if(!cancelled)setLastExport(prepared);
          }).catch(error=>{
            if(!cancelled)setCacheError(`缓存 JSON 读取或转换失败\n${conversionFailure(error,'unchanged','本次处理已取消，原缓存未修改；可重新选择原 JSON 文件。').message}`);
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
          setError(`打开阅览文件失败\n${conversionFailure(error,'unconfirmed','打开未完成，原 JSON 文件未修改；缓存保存结果无法确认。').message}`);
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
    reader.onload = async () => {
      if (generation !== readingGeneration.current) return;
      try {
        const prepared=await prepareExportForViewing(JSON.parse(reader.result as string));
        if(generation===readingGeneration.current)setPrepared(prepared);
      } catch (error: unknown) {
        if(generation===readingGeneration.current)setError(`JSON 文件转换或校验失败\n${conversionFailure(error,'unchanged','本次处理已取消，原 JSON 文件和缓存均未修改。').message}`);
      } finally {
        if(generation===readingGeneration.current)setProcessing(false);
      }
    };
    reader.onerror = () => { if (generation === readingGeneration.current) {
      setError(`JSON 文件读取失败\n${conversionFailure(reader.error??new Error('文件读取失败'),'unchanged','原 JSON 文件和缓存均未修改。').message}`);
      setProcessing(false);
    } };
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
      background={DIALOG_BACKDROP}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, boxSizing: 'border-box',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="阅览导出文本" style={{
        ...dialogStyles.panel, width: '100%', maxWidth: 500, maxHeight: '100%',
        display: 'flex', flexDirection: 'column', overflow: 'auto',
      }}>
        <div style={{
          ...dialogStyles.header, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>阅览导出文本</div>
          <button aria-label="关闭阅览" onClick={onClose} style={dialogStyles.button}>✕</button>
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
          {cacheError && <div role="alert" style={{ color: '#f87171', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: '100%' }}>{cacheError}</div>}

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
            <div role="alert" style={{ color: '#f87171', fontSize: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 6, width: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
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
