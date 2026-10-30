import { useSyncExternalStore } from 'react';
import type { CatalogClient } from '../data/catalogClient';

export default function CatalogStatus({ client }: { client: CatalogClient }) {
  const progress = useSyncExternalStore(client.subscribe, client.getProgress);
  return <div role="status" style={{ padding: 12, color: 'var(--ink-94a3b8)', fontSize: 12, textAlign: 'center' }}>
    {progress.error ? `全局消息同步暂未完成：${progress.error}，将自动重试。`
      : progress.ready ? (progress.syncing ? '正在更新全局消息…' : '全局消息已就绪')
      : `正在准备全局消息，已获取 ${progress.count} 条。筛选和排行榜将在补齐后显示。`}
  </div>;
}
