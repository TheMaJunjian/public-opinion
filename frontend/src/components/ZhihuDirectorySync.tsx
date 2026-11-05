import { useEffect, useRef, useState } from 'react';
import { isZhihuViewingData } from '../utils/zhihuArchive';
import type { ExportData } from '../api/client';
import { appendZhihuJournal, canLinkZhihuDirectory, getZhihuDirectory, refreshZhihuDirectory, rememberZhihuDirectory, requireDirectoryPermission, type LinkedDirectory } from '../utils/zhihuDirectory';
import { sameZhihuValue, zhihuEditState } from '../utils/zhihuIncremental';
import { EXPORT_DISCUSSION_VIEW_SAVED, getExportCacheReference, loadExportDiscussionView } from '../utils/exportViewerCache';

export default function ZhihuDirectorySync<T extends ExportData>({ data, onUpdate }: { data: T;
  onUpdate: (next: T, options: { sourceUpdate: boolean }) => Promise<void> }) {
  const [connection, setConnection] = useState<LinkedDirectory | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef({ data, onUpdate }); latest.current = { data, onUpdate };
  const running = useRef(false);
  const queued = useRef(false);
  const retryTimer = useRef(0);
  const generation = useRef(0);
  const directoryId = canLinkZhihuDirectory() ? getExportCacheReference(data)?.viewCacheId ?? (isZhihuViewingData(data) ? data.zhihu.archiveId : 'uncached-native') : null;
  const run = useRef<(request?: boolean) => Promise<void>>(async () => {});
  run.current = async (request = false) => {
    if (!connection || document.visibilityState === 'hidden') return;
    if (running.current) { queued.current = true; return; }
    running.current = true;
    const started = generation.current, current = latest.current;
    setBusy(true);
    try {
      await requireDirectoryPermission(connection, request);
      const refreshed = await refreshZhihuDirectory(connection, current.data);
      const { signature, journalSignature } = refreshed, next = refreshed.data as T;
      if (started !== generation.current) return;
      const changed = next !== current.data && (isZhihuViewingData(next) && isZhihuViewingData(current.data)
        ? !sameZhihuValue(next.zhihu.archive, current.data.zhihu.archive) || !sameZhihuValue(zhihuEditState(next), zhihuEditState(current.data)) : true);
      if (changed) {
        await current.onUpdate(next, { sourceUpdate: signature !== connection.signature });
      }
      if (started !== generation.current) return;
      // Cache commits first. A directory failure leaves edits safe on this
      // machine and visibly pending, and the next check retries the same tail.
      const active = latest.current.data === current.data ? next : latest.current.data;
      connection.signature = signature; connection.journalSignature = journalSignature;
      const discussion = await loadExportDiscussionView(active);
      const journalData = discussion ? { ...active, view: { ...(active.view ?? {
        username: null, mode: 'graph' as const, classificationId: null,
        messageFilter: { hideJoin: false, hideSettlement: true }, homeFilter: null, cleanFilters: [],
      }), discussion: { ...discussion, collapsed: [...discussion.collapsed] } } } : active;
      await appendZhihuJournal(connection, journalData);
      await rememberZhihuDirectory(active, connection);
      if (started === generation.current) setMessage(latest.current.data === active && !queued.current ? '已同步' : '本机已保存，等待目录同步');
    } catch (error) {
      if (started === generation.current) setMessage(`目录尚未同步：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running.current = false;
      if (started === generation.current) {
        setBusy(false);
        if (queued.current) { queued.current = false; retryTimer.current = window.setTimeout(() => { void run.current(); }, 100); }
      }
    }
  };
  useEffect(() => {
    const started = ++generation.current;
    if (!directoryId) return;
    void getZhihuDirectory(data).then(value => { if (started === generation.current) setConnection(value); })
      .catch(error => { if (started === generation.current) setMessage(`目录关联读取失败：${String(error)}`); });
    return () => { generation.current++; clearTimeout(retryTimer.current); };
    // Local edits retain the same document and directory handle.
  }, [directoryId]);
  useEffect(() => {
    if (!connection) return;
    setMessage('本机已保存，等待目录同步');
    void run.current();
    const check = () => { void run.current(); };
    const interval = window.setInterval(check, 5000);
    const viewChanged = (event: Event) => {
      const reference = getExportCacheReference(latest.current.data);
      if ((event as CustomEvent<{ key: string }>).detail?.key !== `__discussion_view__:${reference?.viewCacheId}`) return;
      setMessage('本机已保存，等待目录同步'); check();
    };
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    window.addEventListener(EXPORT_DISCUSSION_VIEW_SAVED, viewChanged);
    return () => { clearInterval(interval); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); window.removeEventListener(EXPORT_DISCUSSION_VIEW_SAVED, viewChanged); };
  }, [connection]);
  useEffect(() => {
    if (!connection) return;
    setMessage('本机已保存，等待目录同步');
    const timer = window.setTimeout(() => { void run.current(); }, 100);
    return () => clearTimeout(timer);
  }, [data, connection]);
  if (!connection && !message) return null;
  const failed = message.startsWith('目录尚未同步') || message.startsWith('目录关联读取失败');
  const status = failed ? '尚未同步' : message === '已同步' ? '已同步' : busy ? '同步中…' : '等待同步';
  return <details style={{ padding: '3px 12px', fontSize: 11, color: 'var(--ink-94a3b8)' }}>
    <summary style={{ cursor: 'pointer' }}><span role="status" title={message}>本地文件 · {status}</span></summary>
    <div style={{ padding: '6px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>{connection ? `${connection.directory.name} · ${message || '等待同步'}` : message}</span>
      {connection && <button disabled={busy} onClick={() => { void run.current(true); }}>{busy ? '正在同步…' : '检查更新'}</button>}
    </div>
  </details>;
}
