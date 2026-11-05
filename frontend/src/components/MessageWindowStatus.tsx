interface Props {
  loadedCount: number;
  totalCount: number;
  loading: boolean;
}

/** A transient notice beside the scroller, without adding space above the messages. */
export default function MessageWindowStatus({ loadedCount, totalCount, loading }: Props) {
  if (!loading) return null;
  return <div role="status" aria-label="消息加载进度" aria-live="polite" style={{
    padding: '6px 10px', borderRadius: 4, background: 'var(--surface-141414)', fontSize: 12, color: 'var(--ink-94a3b8)',
  }}>
    正在加载消息… 当前已显示 {loadedCount} / {totalCount} 条。
  </div>;
}
