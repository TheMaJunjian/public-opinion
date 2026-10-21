import { useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dismissOperation, getOperations, subscribeOperations } from '../utils/requestLifecycle';
import { useOptionalAuth } from '../context/AuthContext';
import PromptModal from './PromptModal';
import './OperationFeedback.css';

/** Keep focus outside the inert workbench until the operation completes or fails. */
export function OperationProgressDialog({ title, children }: { title: string; children: ReactNode }) {
  const message = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    message.current?.focus();
    return () => { if (previous?.isConnected && !previous.closest('[inert]')) previous.focus(); };
  }, []);
  const dialogProps = {
    'aria-busy': true,
    'data-operation-progress': 'true',
    'data-gesture-disabled': 'true',
    style: { maxHeight: '100%', overflowWrap: 'anywhere' as const },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      event.stopPropagation();
      if (event.key === 'Escape') event.preventDefault();
      if (event.key === 'Tab') {
        event.preventDefault(); message.current?.focus();
      }
    },
  };
  return <PromptModal open title={title} message={<div ref={message} className="operation-progress-message" tabIndex={-1} style={{ outline: 'none' }}>{children}</div>}
    hideActions onConfirm={() => {}}
    lockScroll={false} zIndex={3300} dialogProps={dialogProps} />;
}

/** Request feedback stays visible without blocking the workspace or opening another modal. */
export default function OperationFeedback() {
  const auth = useOptionalAuth();
  const owner = auth?.user?.id ?? 'anonymous';
  const all = useSyncExternalStore(subscribeOperations, getOperations);
  const entries = all.filter(operation => operation.owner === owner && (!operation.quiet || operation.state !== 'pending'));
  if (!entries.length) return null;
  return createPortal(<div className="operation-feedback" data-operation-progress="true" data-gesture-disabled="true">
    {entries.map(operation => <div className="operation-feedback-entry" key={operation.id}>
      <div role={operation.state === 'failed' || operation.state === 'uncertain' ? 'alert' : 'status'} aria-live="polite">
        <strong>{operation.label}</strong>：{operation.state === 'pending' ? operation.long ? '仍在等待服务器响应…' : '正在处理…'
          : operation.message ?? (operation.state === 'confirmed' ? '服务器已响应' : '请求未完成')}
      </div>
      {operation.state !== 'pending' && <button type="button" aria-label={`关闭${operation.label}提示`} onClick={() => dismissOperation(operation.id)}>关闭</button>}
    </div>)}
  </div>, document.body);
}
