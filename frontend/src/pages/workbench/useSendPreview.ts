import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { api, type PreparedCommandBatch } from '../../api';
import type { WorkbenchSnapshot } from '../../data/workbench';
import { WorkbenchDrawingContext } from '../../context/WorkbenchDrawingContext';
import { useWorkbenchViewOnlyDrawing } from '../../components/WorkbenchLoadingBoundary';
import type { WorkbenchComposer, ComposerCheckpoint } from './useWorkbenchComposer';

interface Options {
  composer: WorkbenchComposer; owner: string; scope: string; liveSequence: number;
  sendInFlightRef: { current: boolean };
  work(): Promise<void>;
  captureTransient(work: () => Promise<unknown>): Promise<void>;
  showSendPreview(pages: WorkbenchSnapshot[]): void;
  clearSendPreview(): void;
  confirmSendPreview(pages: WorkbenchSnapshot[]): void;
  error(message: string): void;
  onCommitted?(prepared: PreparedCommandBatch): void;
  viewport?: RefObject<HTMLElement | null>;
}
interface Preview { prepared: PreparedCommandBatch; consumed: ComposerCheckpoint; stamp: string; baseSequence: number; ids: string[]; snapshots: WorkbenchSnapshot[] }

export function useSendPreview(options: Options) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'sending'>('idle');
  const [uncertain, setUncertain] = useState(false);
  const busy = useRef(false), generation = useRef(0), abort = useRef<AbortController | null>(null);
  const origin = useRef<{top:number;left:number} | null>(null), revealed = useRef<string | null>(null);
  const drawing = useContext(WorkbenchDrawingContext);
  const stamp = JSON.stringify(options.composer.capture());
  const stale = !!preview && (stamp !== preview.stamp || options.liveSequence > preview.baseSequence);
  const owner = `${options.owner}:${options.scope}`;
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    if (!preview || stale || revealed.current === preview.prepared.envelope.requestId || !options.viewport) return;
    let frame=0; const started=performance.now();
    const reveal=()=>{
      if (drawing?.failure || performance.now()-started>30000) return;
      const viewport = options.viewport?.current;
      const target = preview.ids.map(id => viewport?.querySelector<HTMLElement>(`[data-msgid="${id}"]`)).find(Boolean);
      if (drawing?.pending || !viewport || !target) { frame=requestAnimationFrame(reveal); return; }
      const bounds = viewport.getBoundingClientRect(), rect = target.getBoundingClientRect();
      viewport.scrollTop += rect.top - bounds.top - Math.max(50,(bounds.height - rect.height)/2);
      viewport.scrollLeft += rect.left - bounds.left - Math.max(0,(bounds.width - rect.width)/2);
      revealed.current = preview.prepared.envelope.requestId;
    };
    frame=requestAnimationFrame(reveal);return()=>cancelAnimationFrame(frame);
  }, [preview, stale, drawing, options.viewport]);
  useWorkbenchViewOnlyDrawing(!!preview || phase !== 'idle');
  useEffect(() => {
    busy.current = false; latest.current.sendInFlightRef.current = false;
    origin.current = null; revealed.current = null;
    setPreview(null); setPhase('idle'); setUncertain(false);
    return () => { generation.current++; abort.current?.abort(); latest.current.clearSendPreview(); };
  }, [owner]);

  async function prepare() {
    if (busy.current || options.sendInFlightRef.current || uncertain) return;
    busy.current = true; setPhase('preparing'); options.error('');
    const version = ++generation.current, original = JSON.stringify(options.composer.capture());
    if (!preview && options.viewport?.current) origin.current = {top:options.viewport.current.scrollTop,left:options.viewport.current.scrollLeft};
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    try {
      let prepared: PreparedCommandBatch | null = null;
      options.sendInFlightRef.current = true;
      let consumed: ComposerCheckpoint;
      try {
        // Rebuild send dependencies from live records before rehearsing again.
        // Otherwise a simulated JOIN can be mistaken for an existing placement.
        if (preview) flushSync(() => options.clearSendPreview());
        const source = latest.current;
        consumed = await source.composer.captureTransient(() => source.captureTransient(async () => {
          prepared = await api.prepareCommandBatch(source.work, preview?.prepared);
        }));
      } finally {
        options.sendInFlightRef.current = false;
        if (preview && version === generation.current) options.showSendPreview(preview.snapshots);
      }
      if (!prepared) return;
      const captured = prepared as PreparedCommandBatch;
      const result = await api.previewCommandBatch(captured, [options.scope], controller.signal);
      if (version !== generation.current || original !== JSON.stringify(latest.current.composer.capture())) return;
      options.showSendPreview(result.snapshots);
      setPreview({ prepared: captured, consumed, stamp: original, baseSequence: result.baseSequence, ids: result.messageIds, snapshots: result.snapshots });
    } catch (error) {
      if (version === generation.current && !(error instanceof Error && error.name === 'AbortError')) options.error(error instanceof Error ? error.message : '预览失败，请重试');
    } finally { if (version === generation.current) { busy.current = false; setPhase('idle'); } }
  }
  function cancel() {
    if (phase === 'sending') return;
    generation.current++; abort.current?.abort(); busy.current = false;
    options.clearSendPreview(); setPreview(null); setPhase('idle'); setUncertain(false);
    if (origin.current && options.viewport?.current) { options.viewport.current.scrollTop=origin.current.top;options.viewport.current.scrollLeft=origin.current.left; }
    origin.current = null; revealed.current = null;
  }
  async function confirm() {
    if (!preview || stale && !uncertain || busy.current || drawing?.pending || drawing?.failure) return;
    const version = generation.current;
    busy.current = true; options.sendInFlightRef.current = true; setPhase('sending'); options.error('');
    try {
      const committed = await api.confirmCommandPreview(preview.prepared);
      if (!committed.snapshots?.length) {
        options.error('发送已提交，正在核对显示结果。请等待同步完成。');
        // Keep the preview until the normal catalog catches up rather than flashing old data.
        await new Promise<void>(resolve => {
          const started = Date.now();
          const poll = () => committed.sequence !== undefined && latest.current.liveSequence >= committed.sequence || Date.now() - started > 10000 ? resolve() : setTimeout(poll, 100);
          poll();
        });
        if (committed.sequence === undefined || latest.current.liveSequence < committed.sequence)
          throw Object.assign(new Error('发送已提交，显示尚未同步。请再次确认以核对同一笔发送。'), { unknownOutcome:true });
      }
      if (version !== generation.current) return;
      options.error('');
      options.confirmSendPreview(committed.snapshots ?? []);
      if (JSON.stringify(latest.current.composer.capture()) === preview.stamp) options.composer.restore(preview.consumed);
      options.onCommitted?.(preview.prepared);
      setPreview(null);
      setUncertain(false);
      origin.current = null;
    } catch (error) {
      if (version !== generation.current) return;
      if (error && typeof error === 'object' && 'unknownOutcome' in error && error.unknownOutcome) setUncertain(true);
      options.error(error instanceof Error ? error.message : '发送失败，预览与输入已保留');
    }
    finally { busy.current = false; options.sendInFlightRef.current = false; if (version === generation.current) setPhase('idle'); }
  }
  return { active: !!preview, phase, stale, uncertain, ids: preview?.ids ?? [], prepare, cancel, confirm,
    ready: !!preview && (!stale || uncertain) && phase === 'idle' && !drawing?.failure };
}
