import { useSyncExternalStore } from 'react';
import { getOfflineViewerState, retryOfflineViewer, subscribeOfflineViewer } from '../utils/offlineViewer';

export default function OfflineViewerStatus() {
  const state = useSyncExternalStore(subscribeOfflineViewer, getOfflineViewerState);
  const message = {
    preparing: '正在准备离线阅览，请先保持联网。',
    ready: '离线阅览已就绪。断网后仍可打开本站，阅览和保存本机文件。',
    unavailable: '当前浏览器无法保存离线界面；请使用支持离线缓存的浏览器访问 HTTPS 网站。',
    failed: '离线界面尚未准备完成，请联网后重试。',
    preview: '当前开发预览不提供离线缓存；正式版本会自动准备。',
  }[state];
  if (state === 'preview') return null;
  const label = { preparing: '正在准备离线阅览…', ready: '离线可用', unavailable: '离线不可用', failed: '离线未就绪' }[state];
  return <span role="status" title={message} style={{ fontSize: 11, color: 'var(--ink-94a3b8)' }}>
    {label}
    {state === 'failed' && <button type="button" onClick={() => { void retryOfflineViewer(); }} style={{ marginLeft: 8 }}>重试准备</button>}
  </span>;
}
