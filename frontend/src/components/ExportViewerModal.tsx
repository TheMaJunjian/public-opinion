import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExportData } from '../api/client';
import { validateExportForViewing,prepareExportForViewing } from '../utils/exportArchive';
import { inheritExportCacheReference, loadCachedExport, loadCachedNativeExport, loadLastExport, loadLastExportPreview, loadReferencedExport, loadExportNavigation, openFolderMeetingExport, saveLastExport, type ExportCacheReference, type ExportNavigation } from '../utils/exportViewerCache';
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
import { createLocalMessageFile } from '../utils/localMessageFile';
import { handoffMeetingDirectory } from '../utils/meetingDirectoryHandoff';
import MeetingFolderDialog from './MeetingFolderDialog';
import WpsDocumentChooser from './WpsDocumentChooser';
import GitMeetingChooser from './GitMeetingChooser';
import type { GitMeetingCommentSource } from '../utils/gitMeetingComments';
import { requestCloudMeetingLogout } from '../utils/cloudMeetingAccount';
import './ExportViewerModal.css';

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

  const enterViewer = (data: ExportData, navigation: ExportNavigation | null, directory?: FileSystemDirectoryHandle) => {
    window.dispatchEvent(new Event('prepare-export-viewer'));
    const state = createExportViewerState(data, navigation);
    if (directory && data.meeting && state.viewerInstanceKey) handoffMeetingDirectory(state.viewerInstanceKey, data.meeting.id, directory);
    navigate('/viewer', { state, replace: true });
    onClose();
  };

  const openMeeting = async (start: ExportData, source: FileSystemDirectoryHandle | string | GitMeetingCommentSource, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const generation = ++readingGeneration.current;
    const cloudSource = typeof source === 'string' || 'repository' in source;
    const cached = await openFolderMeetingExport(start, cloudSource ? source : undefined, signal);
    signal?.throwIfAborted();
    const data = inheritExportCacheReference((await prepareExportForViewing(cached)).data, cached);
    const navigation = await loadExportNavigation(data).catch(() => null);
    signal?.throwIfAborted();
    if (generation === readingGeneration.current) enterViewer(data, navigation, cloudSource ? undefined : source);
  };

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
          enterViewer(openedData, navigation);
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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="viewer-source-title"
        data-dialog-layout="scroll" className="viewer-source-panel" style={dialogStyles.panel}>
        <div data-dialog-header="true" className="viewer-source-header" style={dialogStyles.header}>
          <h2 id="viewer-source-title">打开讨论或文件</h2>
          <button type="button" data-dialog-close="true" aria-label="关闭阅览" onClick={onClose} style={dialogStyles.button}>✕</button>
        </div>
        <div data-dialog-body="true" className="viewer-source-list">
          {lastExport && (
            <button type="button" className="viewer-source-recent" disabled={opening}
              aria-label={`上次阅览：${lastExport.title}`} onClick={() => openData(lastExport.data, true, lastExport.reference)}>
              <span><small>继续上次阅览</small><strong>{lastExport.title}</strong></span>
              <span aria-hidden="true">›</span>
            </button>
          )}
          {!selectedFile && lastExport?.verification && <div role="status" className="viewer-source-status">{lastExport.verification}</div>}
          {cacheError && <div role="alert" className="viewer-source-error">{cacheError}</div>}

          <section className="viewer-source" aria-labelledby="viewer-cloud-heading">
            <h3 id="viewer-cloud-heading">云文档</h3>
            <p>每份云表是一场独立讨论。切换后只读写所选云表。</p>
            <WpsDocumentChooser onOpen={openMeeting} disabled={opening || processing} />
          </section>
          <section className="viewer-source" aria-labelledby="viewer-git-heading">
            <h3 id="viewer-git-heading">Git 仓库</h3>
            <p>用 GitHub 仓库存储发言和回复，成员在公论中讨论。</p>
            <GitMeetingChooser onOpen={openMeeting} disabled={opening || processing} />
          </section>
          <button type="button" className="viewer-source-action" onClick={() => requestCloudMeetingLogout()}>退出云端讨论并清除本机登录状态</button>
          <section className="viewer-source" aria-labelledby="viewer-folder-heading">
            <h3 id="viewer-folder-heading">共享文件夹</h3>
            <p>选择大家都能读写的文件夹，在其中创建或加入会议。</p>
            <MeetingFolderDialog onOpen={openMeeting} disabled={opening || processing} />
          </section>

          <section className="viewer-source" aria-labelledby="viewer-file-heading">
            <h3 id="viewer-file-heading">本地消息文件</h3>
            <div className="viewer-local-actions">
              <button type="button" className="viewer-file-picker" data-dragging={dragging || undefined}
                disabled={processing || opening} onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}>
                <strong>{processing ? '正在处理…' : selectedFile?.name ?? '选择 JSON 文件'}</strong>
                <small>{selectedFile ? '重新选择文件' : '拖拽 JSON 文件到此处'}</small>
              </button>
              <button type="button" className="viewer-source-action" disabled={opening || processing}
                onClick={() => openData(createLocalMessageFile())}>新建本地消息文件</button>
            </div>
            <input ref={fileInputRef} type="file" aria-label="选择导出文件" accept=".json"
              onChange={handleFileChange} hidden />
            {prepared?.verification && <div role="status" className="viewer-source-status">{prepared.verification}</div>}
            {prepared && !processing && <button type="button" onClick={processAndOpen} style={dialogStyles.primaryButton}>
              {linkedDirectory ? '关联并阅览' : '阅览此文件'}
            </button>}
            <div className="viewer-file-status">
              <span>文件仅在本机读取，不会上传</span><OfflineViewerStatus />
            </div>
            <details className="viewer-file-import">
              <summary>知乎导入</summary>
              <p>在上方选择知乎导出的 JSON 文件即可阅览。</p>
              {canLinkZhihuDirectory() && <button type="button" style={dialogStyles.button} disabled={processing || opening}
                onClick={() => { void selectDirectory(); }}>关联知乎导出目录</button>}
            </details>
          </section>
          {error && <div role="alert" className="viewer-source-error">{error}</div>}
        </div>
      </div>
    </PopupOverlay>
    <PromptModal open={opening} title="正在加载" message="正在打开阅览文件，请稍候…" hideActions lockScroll={false} onConfirm={() => undefined} />
    </>
  );
}
