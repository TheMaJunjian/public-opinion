import { useLayoutEffect, useRef, useState } from 'react';
import type { DiscussionPageState } from '../data/discussionClient';
import PromptModal from './PromptModal';
import { dialogStyles } from './dialogStyles';

export default function DiscussionStatusControl({ state, onRefresh, onOpenFull }: {
  state: DiscussionPageState | null;
  onRefresh: () => void;
  onOpenFull: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => { if (open) closeButton.current?.focus({ preventScroll: true }); }, [open]);
  const status = state?.error ? '加载失败' : state?.loading ? '正在加载' : state ? `已加载 ${state.loadedCount} 条关联消息` : '完整工作台';
  return <>
    <button ref={trigger} type="button" className="workbench-toolbar-action" aria-haspopup="dialog" aria-expanded={open}
      title={`讨论状态：${status}`} onClick={() => setOpen(true)}
      style={{ position: 'relative', flexShrink: 0, whiteSpace: 'nowrap', padding: '2px 8px', borderRadius: 4,
        border: '1px solid var(--line-666)', background: 'var(--surface-333)', color: 'var(--ink-fff)',
        fontSize: 12, fontWeight: 400, cursor: 'pointer' }}>
      讨论状态
      {state?.error && <span aria-label="加载失败" style={{ position: 'absolute', top: 1, right: 1, width: 6, height: 6, borderRadius: '50%', background: 'var(--ink-f87171)' }} />}
    </button>
    <PromptModal open={open} title="讨论状态" confirmText="关闭" confirmButtonRef={closeButton}
      onConfirm={close} onClose={close} lockScroll={false}
      dialogProps={{ onKeyDown: event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const first = buttons[0], last = buttons.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      } }}
      message={<section aria-label="当前讨论范围" style={{ display: 'grid', gap: 12, whiteSpace: 'normal' }}>
        <strong>{state ? state.classificationId === 'root' ? '根目录' : '当前讨论' : '完整工作台'}</strong>
        {state ? <>
          <span role="status">已加载 {state.loadedCount} 条关联消息{state.loading ? '，正在更新…' : ''}</span>
          <span>{state.error ? '当前范围加载未完成。' : state.loading ? '正在加载当前范围的关联消息。'
            : state.hasMore ? '还可继续加载更多消息。' : '当前范围的关联消息已全部加载。'}</span>
          <span>筛选与对比作用于已加载的消息</span>
          {state.error && <div role="alert">{state.error}</div>}
        </> : <span>当前为完整工作台，消息随浏览按需加载。</span>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" style={dialogStyles.button} disabled={state?.loading} onClick={onRefresh}>
            {state?.loading ? '正在更新…' : '刷新讨论'}
          </button>
          {state && <button type="button" style={dialogStyles.button} onClick={() => { close(); onOpenFull(); }}>打开完整工作台</button>}
        </div>
      </section>} />
  </>;
}
