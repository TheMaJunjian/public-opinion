import { useContext, useEffect, useSyncExternalStore } from 'react';
import { WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import { OperationProgressDialog } from './OperationFeedback';

const noSubscription = () => () => {};

/** Progress updates stay isolated from the workbench's scene render. */
export default function SendPreviewProgress({ phase, active }: { phase:'idle'|'preparing'|'sending'; active:boolean }) {
  const drawing = useContext(WorkbenchDrawingContext);
  const pending = useSyncExternalStore(drawing?.subscribe ?? noSubscription, () => !!drawing?.pending && !drawing.failure);
  const waiting = phase !== 'idle' || active && pending;
  useEffect(() => {
    if (!waiting) return;
    const blockScroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest('[data-operation-progress="true"]'))) event.preventDefault();
    };
    window.addEventListener('wheel', blockScroll, {capture:true,passive:false});
    window.addEventListener('touchmove', blockScroll, {capture:true,passive:false});
    return () => {
      window.removeEventListener('wheel', blockScroll, true);
      window.removeEventListener('touchmove', blockScroll, true);
    };
  }, [waiting]);
  if (!waiting) return null;
  return <OperationProgressDialog title={phase === 'sending' ? '正在发送' : '正在生成发送预览'}>
    {phase === 'sending' ? '正在等待服务器确认发送，请勿重复提交。' : pending && phase === 'idle' ? '正在完成预览布局和消息定位，请稍候。' : '正在检查消息并生成预览，请稍候。'}
    <p>{phase === 'sending' ? '确认后自动关闭；发送失败会保留输入和预览。' : '完成后自动关闭，可继续编辑或确认发送。'}</p>
  </OperationProgressDialog>;
}
