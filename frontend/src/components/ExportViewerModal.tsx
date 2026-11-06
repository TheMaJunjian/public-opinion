import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExportData } from '../api/client';
import { validateExportForViewing,prepareExportForViewing } from '../utils/exportArchive';
import { inheritExportCacheReference, loadCachedExport, loadCachedNativeExport, loadLastExport, loadLastExportPreview, loadReferencedExport, loadExportNavigation, saveLastExport, type ExportCacheReference } from '../utils/exportViewerCache';
import { createExportViewerState } from '../utils/exportViewerSession';
import { isZhihuViewingData } from '../utils/zhihuArchive';
import { canLinkZhihuDirectory, chooseZhihuDirectory, readZhihuDirectory, rememberZhihuDirectory, type LinkedDirectory } from '../utils/zhihuDirectory';
import { mergeZhihuSourceUpdate } from '../utils/zhihuIncremental';
import { isNativeZhihuView, mergeNativeZhihuUpdate } from '../utils/nativeZhihuView';
import PopupOverlay from './PopupOverlay';
import { DIALOG_BACKDROP, dialogStyles } from './dialogStyles';
import PromptModal from './PromptModal';
import OfflineViewerStatus from './OfflineViewerStatus';
import { conversionFailure } from '@gonglun/core';
import { readViewerFile } from '../utils/readViewerFile';

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
  const [lastExport, setLastExport] = useState<{ title: string; data?: ExportData; reference?: ExportCacheReference; verification?: string | null } | null>(null);
  const [opening, setOpening] = useState(false);
  const [linkedDirectory, setLinkedDirectory] = useState<LinkedDirectory | null>(null);
  const readingGeneration = useRef(0);
  const fileRead = useRef<AbortController | null>(null);
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
      setLinkedDirectory(null);
      setProcessing(false);
      setError(null);
      setCacheError(null);
      setPrepared(null);
      setOpening(false);
      setLastExport(null);
      // Display the chooser before loading and verifying a large cached archive.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          void (async () => {
            const preview = await loadLastExportPreview();
            if (cancelled) return;
            if (preview) { setLastExport(preview); return; }
            // Older caches have no preview record. Keep their validation and
            // recovery path, while new caches never prepare data for a label.
            const cached = await loadLastExport({ sourceOnly: true });
            if (cancelled || cached===null) return;
            const prepared=await prepareExportForViewing(cached);
            if(!cancelled)setLastExport({ ...prepared, title: prepared.data.scope.title });
          })().catch(error=>{
            if(!cancelled)setCacheError(`缓存 JSON 读取或转换失败\n${conversionFailure(error,'unchanged','本次处理已取消，原缓存未修改；可重新选择原 JSON 文件。').message}`);
          });
        });
      });
    }
    return () => { cancelled = true; fileRead.current?.abort(); cancelAnimationFrame(frame); cancelAnimationFrame(openingFrame.current); readingGeneration.current += 1; };
  }, [open]);

  const openData = (data: ExportData | undefined, fromCache = false, reference?: ExportCacheReference) => {
    if (opening) return;
    const generation = ++readingGeneration.current;
    setOpening(true);
    // Paint the prompt before serialization, storage and route preparation can
    // occupy the main thread. File selection and cache reopening share this path.
    openingFrame.current = requestAnimationFrame(() => {
      openingFrame.current = requestAnimationFrame(() => {
        if (generation !== readingGeneration.current) return;
        void (async () => {
          if (!fromCache) {
            if (!data) throw new Error('请先选择阅览文件。');
            await saveLastExport(data, { immutable: true });
            if (linkedDirectory) await rememberZhihuDirectory(data, linkedDirectory);
            return data;
          }
          const latest = reference ? await loadReferencedExport(reference, { sourceOnly: true, paged: true })
            : isZhihuViewingData(data) ? await loadCachedExport(data.zhihu.archiveId, { fresh: true, sourceOnly: true })
            : await loadLastExport({ sourceOnly: true, fresh: true, paged: true });
          if (!latest) throw new Error('上次阅览缓存已不存在，请重新选择 JSON 文件。');
          return inheritExportCacheReference((await prepareExportForViewing(latest)).data, latest);
        })().then(async openedData => {
          const navigation = fromCache ? await loadExportNavigation(openedData).catch(() => null) : null;
          if (generation !== readingGeneration.current) return;
          window.dispatchEvent(new Event('prepare-export-viewer'));
          navigate('/viewer', { state: createExportViewerState(openedData, navigation), replace: true });
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
    fileRead.current?.abort();
    const controller = new AbortController(); fileRead.current = controller;
    const generation = ++readingGeneration.current;
    setError(null);
    setPrepared(null);
    setLinkedDirectory(null);
    setSelectedFile(file);
    setProcessing(true);
    void readViewerFile(file, controller.signal).then(prepared => {
      if (generation === readingGeneration.current) setPrepared(prepared);
    }).catch(error => {
      if (generation === readingGeneration.current && !controller.signal.aborted)
        setError(`JSON 文件转换或校验失败\n${conversionFailure(error,'unchanged','本次处理已取消，原 JSON 文件和缓存均未修改。').message}`);
    }).finally(() => { if (generation === readingGeneration.current) setProcessing(false); });
  };

  const selectDirectory = async () => {
    const generation = ++readingGeneration.current;
    try {
      const directory = await chooseZhihuDirectory();
      if (generation !== readingGeneration.current) return;
      setProcessing(true); setError(null); setPrepared(null); setLinkedDirectory(null);
      setSelectedFile(new File([], `${directory.name}/gonglun.json`));
      // Give the chooser a paint before validating a large exported document.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const opened = await readZhihuDirectory(directory);
      const cached = isZhihuViewingData(opened.data) ? await loadCachedExport(opened.data.zhihu.archiveId, { fresh: true, sourceOnly: true })
        : isNativeZhihuView(opened.data) ? await loadCachedNativeExport(opened.data, { paged: true }) : null;
      const previous = cached ? (await prepareExportForViewing(cached)).data : null;
      const data = previous && isZhihuViewingData(previous) && isZhihuViewingData(opened.data) ? mergeZhihuSourceUpdate(previous, opened.data)
        : previous && isNativeZhihuView(previous) && isNativeZhihuView(opened.data) ? mergeNativeZhihuUpdate(previous, opened.data) : opened.data;
      const prepared = await prepareExportForViewing(data);
      if (generation !== readingGeneration.current) return;
      setPrepared(prepared); setLinkedDirectory(opened.connection);
    } catch (error) {
      if (generation === readingGeneration.current && (error as DOMException).name !== 'AbortError') setError(`关联目录失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { if (generation === readingGeneration.current) setProcessing(false); }
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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="阅览导出文本" data-dialog-layout="scroll" style={{
        ...dialogStyles.panel, width: '100%', maxWidth: 500, maxHeight: '100%',
        display: 'flex', flexDirection: 'column', overflow: 'auto',
      }}>
        <div data-dialog-header="true" style={{
          ...dialogStyles.header, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>阅览导出文本</div>
          <button data-dialog-close="true" aria-label="关闭阅览" onClick={onClose} style={dialogStyles.button}>✕</button>
        </div>

        <div data-dialog-body="true" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          <div style={{ color: 'var(--ink-94a3b8)', fontSize: 13, textAlign: 'center' }}>
            打开公论导出的 JSON 文件，在本机阅览。
          </div>

          {lastExport && (
            <button disabled={opening} onClick={() => openData(lastExport.data, true, lastExport.reference)} style={{
              width: '100%', padding: '12px 16px', borderRadius: 8,
              border: '1px solid var(--line-4a9eff)', background: 'var(--surface-1a2a3c)',
              color: 'var(--ink-4a9eff)', fontSize: 13, cursor: 'pointer',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>📋 上次阅览：{lastExport.title}</span>
              <span style={{ fontSize: 11, opacity: 0.7 }}>点击打开</span>
            </button>
          )}
          {!selectedFile && lastExport?.verification && <div role="status" style={{ color: 'var(--ink-86efac)', fontSize: 12 }}>{lastExport.verification}</div>}
          {cacheError && <div role="alert" style={{ color: 'var(--ink-f87171)', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: '100%' }}>{cacheError}</div>}

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => { if (!processing) fileInputRef.current?.click(); }}
            style={{
              width: '100%', height: 112,
              border: `2px dashed ${dragging ? 'var(--line-0b84ff)' : selectedFile ? 'var(--line-4ade80)' : 'var(--line-444)'}`,
              borderRadius: 10,
              background: dragging ? 'var(--surface-rgba-11-132-255-0-08)' : selectedFile ? 'var(--surface-rgba-74-222-128-0-06)' : 'var(--surface-1a1a1a)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              cursor: selectedFile ? 'default' : 'pointer', gap: 8,
              transition: 'border-color 0.2s, background 0.2s',
            }}
          >
            {processing ? (
              <>
                <div style={{ fontSize: 20 }}>⏳</div>
                <div style={{ color: 'var(--ink-94a3b8)', fontSize: 14 }}>正在处理…</div>
              </>
            ) : selectedFile ? (
              <>
                <div style={{ fontSize: 20 }}>📄</div>
                <div style={{ color: 'var(--ink-e2e8f0)', fontSize: 14 }}>{selectedFile.name}</div>
                <div style={{ color: 'var(--ink-64748b)', fontSize: 11 }}>{prepared ? '点击下方按钮阅览；点击此处更换文件' : '点击此处更换文件'}</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 24 }}>📁</div>
                <div style={{ color: 'var(--ink-94a3b8)', fontSize: 14 }}>拖拽 JSON 文件到此处</div>
                <div style={{ color: 'var(--ink-64748b)', fontSize: 11 }}>或点击选择文件</div>
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

          {prepared?.verification && <div role="status" style={{ color: 'var(--ink-86efac)', fontSize: 12, padding: '8px 12px', background: 'var(--surface-rgba-34-197-94-0-1)', borderRadius: 6, width: '100%' }}>{prepared.verification}</div>}

          {prepared && !processing && (
            <button onClick={processAndOpen} style={{
              width: '100%', padding: '10px 16px', borderRadius: 8,
              border: 'none', background: 'var(--surface-0b84ff)',
              color: 'var(--ink-fff)', fontSize: 14, cursor: 'pointer',
            }}>
              {linkedDirectory ? '关联并阅览' : '阅览此文件'}
            </button>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', width: '100%', fontSize: 11, color: 'var(--ink-94a3b8)' }}>
            <span>文件仅在本机读取，不会上传</span><OfflineViewerStatus />
          </div>
          <details style={{ width: '100%', fontSize: 12, color: 'var(--ink-94a3b8)' }}>
            <summary style={{ cursor: 'pointer' }}>本地辅助</summary>
            <p style={{ margin: '8px 0', lineHeight: 1.6 }}>也可选择知乎导出的 JSON，在本机阅览和整理。</p>
            {canLinkZhihuDirectory() && <>
              <button disabled={processing || opening} onClick={() => { void selectDirectory(); }} style={dialogStyles.button}>关联知乎导出目录</button>
              <p style={{ margin: '8px 0 0', lineHeight: 1.6 }}>关联导出目录后可持续更新，并保留本地整理。</p>
            </>}
          </details>

          {error && (
            <div role="alert" style={{ color: 'var(--ink-f87171)', fontSize: 12, padding: '8px 12px', background: 'var(--surface-rgba-239-68-68-0-1)', borderRadius: 6, width: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
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
