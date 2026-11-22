import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import type { DiscussionPageState } from '../data/discussionClient';
import DiscussionNavigation from './DiscussionNavigation';
import { DiscussionLoadMoreButton } from './DiscussionReplies';
import PromptModal from './PromptModal';
import { dialogStyles } from './dialogStyles';

export default function DiscussionStatusControl({ state, navigation, onLoadMore, onRefresh, onOpenFull }: {
  state: DiscussionPageState | null;
  navigation?: ComponentProps<typeof DiscussionNavigation>;
  onLoadMore?: (messageId: string) => Promise<void>;
  onRefresh: () => void;
  onOpenFull: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => { if (open) closeButton.current?.focus({ preventScroll: true }); }, [open]);
  const status = state?.error ? '加载失败' : state?.loading ? '正在加载' : state ? `已加载 ${state.loadedCount} 条关联消息` : '完整工作台';
  const scopeNotice = state?.error ? '当前范围加载未完成。'
    : state?.loading ? '正在加载当前范围的关联消息。'
    : !state?.hasMore ? '当前范围的关联消息已全部加载。'
    : onLoadMore ? null : '还可继续加载更多消息。';
  return <>
    <button ref={trigger} type="button" className="workbench-toolbar-action" aria-haspopup="dialog" aria-expanded={open}
      title={`讨论详情：${status}`} onClick={() => setOpen(true)}
      style={{ position: 'relative', flexShrink: 0, whiteSpace: 'nowrap', padding: '2px 8px', borderRadius: 4,
        border: '1px solid var(--line-666)', background: 'var(--surface-333)', color: 'var(--ink-fff)',
        fontSize: 12, fontWeight: 400, cursor: 'pointer' }}>
      讨论详情
      {state?.error && <span aria-label="加载失败" style={{ position: 'absolute', top: 1, right: 1, width: 6, height: 6, borderRadius: '50%', background: 'var(--ink-f87171)' }} />}
    </button>
    <PromptModal open={open} title="讨论详情" closeOnly confirmButtonRef={closeButton}
      onConfirm={close} lockScroll={false}
      dialogProps={{ onKeyDown: event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary');
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      } }}
      message={<section aria-label="当前讨论范围" style={{ display: 'grid', gap: 12, whiteSpace: 'normal' }}>
        <strong>{state ? state.classificationId === 'root' ? '根目录' : '当前讨论' : '完整工作台'}</strong>
        {state ? <>
          <span role="status">已加载 {state.loadedCount} 条关联消息{state.loading ? '，正在更新…' : ''}</span>
          {scopeNotice && <span>{scopeNotice}</span>}
          <span>筛选与对比作用于已加载的消息</span>
          {state.error && <div role="alert">{state.error}</div>}
        </> : <span>消息随浏览按需加载。</span>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {state && onLoadMore && <DiscussionLoadMoreButton state={state} style={dialogStyles.button} onMore={id => {
            closeButton.current?.focus({ preventScroll: true });
            return onLoadMore(id);
          }} />}
          <button type="button" style={dialogStyles.button} disabled={state?.loading} onClick={onRefresh}>
            {state?.loading && !state.loadingMore ? '正在更新…' : state ? '刷新讨论' : '刷新工作台'}
          </button>
          {state && <button type="button" style={dialogStyles.button} onClick={() => { close(); onOpenFull(); }}>打开完整工作台</button>}
        </div>
        {navigation && <DiscussionNavigation {...navigation}
          onCategory={id => { close(); navigation.onCategory(id); }}
          onRelated={() => { close(); navigation.onRelated(); }} />}
      </section>} />
  </>;
}
