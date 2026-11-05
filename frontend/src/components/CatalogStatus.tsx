import { useSyncExternalStore } from 'react';
import type { CatalogClient } from '../data/catalogClient';

export default function CatalogStatus({ client, inline = false }: { client: CatalogClient; inline?: boolean }) {
  const progress = useSyncExternalStore(client.subscribe, client.getProgress);
  if (progress.ready && !progress.syncing && !progress.error) return null;
  return <div data-message-loading-notice style={inline ? undefined : { position: 'sticky', bottom: 8, height: 0, zIndex: 25, pointerEvents: 'none' }}>
    <div role="status" aria-live="polite" style={{ ...(inline ? {} : { position: 'absolute' as const, bottom: 0, right: 12, maxWidth: 'calc(100% - 24px)' }),
      padding: '6px 10px', borderRadius: 4, background: 'var(--surface-141414)', color: 'var(--ink-94a3b8)', fontSize: 12 }}>
    {progress.error ? `全局消息同步暂未完成：${progress.error}，将自动重试。`
      : progress.ready ? (progress.syncing ? '正在更新全局消息…' : '全局消息已就绪')
      : `正在准备全局消息，已获取 ${progress.count} 条。筛选和排行榜将在补齐后显示。`}
    </div>
  </div>;
}
