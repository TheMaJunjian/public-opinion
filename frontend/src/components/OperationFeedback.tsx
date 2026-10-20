import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dismissOperation, getOperations, subscribeOperations } from '../utils/requestLifecycle';
import { useOptionalAuth } from '../context/AuthContext';
import PromptModal from './PromptModal';
import './OperationFeedback.css';

/** Controls live outside the inert workbench and remain keyboard accessible. */
export function OperationProgressDialog({ title, children, onHide }: { title: string; children: ReactNode; onHide(): void }) {
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { if (previous?.isConnected && !previous.closest('[inert]')) previous.focus(); };
  }, []);
  const dialogProps = {
    'aria-busy': true,
    'data-operation-progress': 'true',
    'data-gesture-disabled': 'true',
    style: { maxHeight: '100%', overflowWrap: 'anywhere' as const },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onHide(); }
      if (event.key === 'Tab') {
        const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    },
  };
  return <PromptModal open title={title} message={children} confirmText="收起进度" onConfirm={onHide}
    lockScroll={false} zIndex={3300} dialogProps={dialogProps} confirmButtonRef={close} />;
}

/** Pending feedback is immediate; longer requests expose details without opening a modal. */
export default function OperationFeedback() {
  const auth = useOptionalAuth();
  const owner = auth?.user?.id ?? 'anonymous';
  const all = useSyncExternalStore(subscribeOperations, getOperations);
  const entries = all.filter(operation => operation.owner === owner && (!operation.quiet || operation.state !== 'pending'));
  const [hidden, setHidden] = useState(false);
  const [details, setDetails] = useState(false);
  const lastId = entries.at(-1)?.id;
  useEffect(() => { setHidden(false); setDetails(false); }, [lastId]);
  if (!entries.length) return null;
  const pending = entries.filter(operation => operation.state === 'pending').length;
  const content = <>
    {entries.map(operation => <div className="operation-feedback-entry" key={operation.id}>
      <div role={operation.state === 'failed' || operation.state === 'uncertain' ? 'alert' : 'status'} aria-live="polite">
        <strong>{operation.label}</strong>：{operation.state === 'pending' ? operation.long ? '仍在等待服务器响应…' : '正在处理…'
          : operation.message ?? (operation.state === 'confirmed' ? '服务器已响应' : '请求未完成')}
      </div>
      {operation.state !== 'pending' && <button type="button" aria-label={`关闭${operation.label}提示`} onClick={() => dismissOperation(operation.id)}>关闭</button>}
    </div>)}
    {pending > 0 && <p>收起只隐藏提示，请求仍会继续；请等待结果，避免重复操作。</p>}
  </>;
  return createPortal(<div className="operation-feedback" data-operation-progress="true" data-gesture-disabled="true" aria-hidden={details || undefined}>
    {hidden ? <button type="button" onClick={() => setHidden(false)}>{pending ? `${pending} 项请求进行中` : '查看操作结果'}</button> : <>
      {content}
      <div className="operation-feedback-actions">
        {entries.some(operation => operation.long) && <button type="button" onClick={() => setDetails(true)}>查看进度</button>}
        <button type="button" onClick={() => setHidden(true)}>收起提示</button>
      </div>
    </>}
    {details && <OperationProgressDialog title="操作进度" onHide={() => setDetails(false)}>{content}</OperationProgressDialog>}
  </div>, document.body);
}
