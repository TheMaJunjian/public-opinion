import { useEffect, useRef, useState } from 'react';
import type { ExportData } from '../api/client';
import { readWpsMeetingDocument } from '../utils/wpsMeetingDocument';
import { WpsAccessRequired, wpsUrlFromShareText } from '../utils/wpsMeetingTransport';
import { clearPendingWpsDocument, getPendingWpsDocument, visitWpsForAccess } from '../utils/wpsAccessReturn';
import { dialogStyles } from './dialogStyles';

type Props = {
  disabled: boolean;
  onOpen(start: ExportData, url: string, signal: AbortSignal): Promise<void>;
};

export default function WpsDocumentChooser({ onOpen, disabled }: Props) {
  const [returnLink] = useState(getPendingWpsDocument);
  const [link, setLink] = useState(returnLink ?? '');
  const [error, setError] = useState('');
  const [official, setOfficial] = useState(returnLink ?? '');
  const [busy, setBusy] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const handedOff = useRef(returnLink);
  useEffect(() => () => flight.current?.abort(), []);
  useEffect(() => {
    if (returnLink && details.current) {
      details.current.open = true;
      clearPendingWpsDocument();
    }
    window.addEventListener('pageshow', clearPendingWpsDocument);
    return () => window.removeEventListener('pageshow', clearPendingWpsDocument);
  }, [returnLink]);
  function changeLink(value: string) {
    setLink(value);
    setError('');
    setOfficial('');
  }

  function pasteShare(event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text/plain');
    if (!pasted) return;
    const field = event.currentTarget;
    const value = field.value.slice(0, field.selectionStart ?? 0) + pasted +
      field.value.slice(field.selectionEnd ?? field.value.length);
    event.preventDefault();
    try {
      changeLink(wpsUrlFromShareText(value).href);
    } catch {
      // Keep separate links distinguishable in the single-line field so the user can choose one.
      changeLink(value.replace(/[\r\n]+/g, ' '));
    }
  }

  async function open() {
    if (flight.current || disabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    flight.current = controller;
    setBusy(true);
    setError('');
    setOfficial('');
    let url: URL | undefined;
    try {
      url = wpsUrlFromShareText(link);
      setLink(url.href);
      if (!navigator.onLine) throw new Error('当前设备离线，请恢复网络后再打开云文档。');
      const start = await readWpsMeetingDocument(url, signal);
      signal.throwIfAborted();
      await onOpen(start, url.href, signal);
    } catch (cause) {
      if (!signal.aborted) {
        const message = typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string'
          ? cause.message.trim() : '';
        setError(message || '未能打开 WPS 云文档，请检查文档访问权限后重试。');
        if (cause instanceof WpsAccessRequired && url && navigator.onLine) {
          setOfficial(url.href);
          if (handedOff.current !== url.href) {
            handedOff.current = url.href;
            visitWpsForAccess(url);
          }
        }
      }
    } finally {
      flight.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }
  return <details ref={details} style={{ width: '100%', minWidth: 0 }}>
    <summary className="viewer-source-action">使用 WPS 云文档</summary>
    <form onSubmit={event => { event.preventDefault(); void open(); }}
      style={{ display: 'grid', gap: 8, paddingTop: 8, minWidth: 0 }}>
      <label style={{ display: 'grid', gap: 4, minWidth: 0 }}>WPS 多维表格分享链接
        <input type="text" inputMode="url" autoCapitalize="none" spellCheck={false} required value={link} disabled={busy}
          onChange={event => changeLink(event.target.value)} onPaste={pasteShare}
          placeholder="粘贴链接或整段分享文字" style={{ ...dialogStyles.input, minWidth: 0, minHeight: 44 }} />
      </label>
      <small>请在公论里发言和回复，避免手动修改、删除或重排表中记录，以免影响同步。</small>
      <button type="submit" disabled={busy || disabled || !link.trim()} style={{ ...dialogStyles.primaryButton, minHeight: 44 }}>
        {busy ? '正在连接 WPS…' : '打开讨论'}
      </button>
      {error && <small role="alert" className="viewer-source-error">{error}</small>}
      {official && <a href={official} onClick={event => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        visitWpsForAccess(new URL(official));
      }}>在 WPS 中登录或申请权限</a>}
      <a href="https://account.wps.cn/usercenter/" target="_blank" rel="noopener noreferrer">管理 WPS 账号</a>
    </form>
  </details>;
}
