import { lazy, Suspense, useEffect, useId, useRef, useState, type ComponentProps, type Dispatch, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction } from 'react';
import DeferredWorkbench from '../../../components/DeferredWorkbench';
import HistoryArrowIcon from '../../../components/HistoryArrowIcon';
import MessageJumpControl from '../../../components/MessageJumpControl';
import {useThemeSettings} from '../../../theme/theme';
import HomeFilterPanel from '../../../components/HomeFilterPanel';
import type MessageFilterPanel from '../../../components/MessageFilterPanel';
import { Z_INDEX } from '../../../constants/zIndex';
import type { Relation } from '../../../types';
import type { DemoMessage, UnitSelection } from '../../../utils/modelBridge';
import { resolveNavigationTargetId } from '../model/navigation';
import type { ExportData } from '../../../api/client';
import { copyDiscussionView, type DiscussionView } from '../../../utils/discussionView';
import { dialogStyles } from '../../../components/dialogStyles';
import { isNativeZhihuView } from '../../../utils/nativeZhihuView';
const ExportModal = lazy(() => import('../../../components/ExportModal'));
const CleanFilterPanel = lazy(() => import('../../../components/CleanFilterPanel'));
type ViewMode = 'list' | 'graph';
interface ViewNavigation {
  viewMode: ViewMode; setViewMode: Dispatch<SetStateAction<ViewMode>>;
  leftPanelRef: RefObject<HTMLDivElement>;
  viewModeScrollRef: MutableRefObject<Record<ViewMode, { top: number; left: number } | null>>;
  draftUnits: UnitSelection[]; targetUnits: UnitSelection[]; traceCount: number;
  currentClassifyRelMsgId: string | null; messages: DemoMessage[]; relations: Relation[];
  findContainingClassification: (messageId: string) => string | null;
  exitClassification: (options?: { restoreSnapshot?: boolean }) => void;
  enterClassification: (messageId: string) => void;
  scheduleViewNavigation: (messageId: string) => void;
}
interface ComparisonControls {
  singleSideReview?: boolean; comparisonMode: boolean; comparisonReviewed: boolean; comparisonTargetId: string | null;
  setComparisonTargetId: Dispatch<SetStateAction<string | null>>;
  onStartComparison: () => void;
}
interface Props {
  onJump: (id: string) => void;
  scopeHeader?: ReactNode;
  top: number; scopeMessageId: string; exportTitle: string; showAlert: (message: string) => void;
  exportData?: ExportData | null; exportUsername?: string | null;
  onLocalExport?: (view: NonNullable<ExportData['view']>) => void;
  discussion?: { value: DiscussionView; onChange: (value: DiscussionView) => void; error: string | null; retry: () => void };
  home: ComponentProps<typeof HomeFilterPanel>; clean: ComponentProps<typeof CleanFilterPanel>; filter: ComponentProps<typeof MessageFilterPanel>;
  view: ViewNavigation; comparison: ComparisonControls;
  correctionFilterTargetId: string | null; onLeaderboard: () => void;
  history?: { canGoBack: boolean; canGoForward: boolean; back: () => void; forward: () => void };
}
function LayoutSettings({ value, onChange }: NonNullable<Props['discussion']>) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId();
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return <div ref={container} style={{ position: 'relative', flexShrink: 0 }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={trigger} type="button" className="workbench-view-toggle" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen(current => !current)}>布局设置</button>
    {open && <div id={id} role="dialog" aria-label="布局设置" onKeyDown={event => event.stopPropagation()}
      style={{ ...dialogStyles.panel, position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 224, maxWidth: 'calc(100vw - 32px)', padding: 12, zIndex: 100, fontSize: 12 }}>
      <div role="radiogroup" aria-label="消息图布局" style={{ display: 'grid', gap: 12 }}>
        {(['discussion', 'graph'] as const).map(mode => <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="radio" name={id} value={mode} checked={value.mode === mode}
            onChange={() => onChange({ ...value, mode })} />
          {mode === 'discussion' ? '讨论布局（默认）' : '原关系图排布'}
        </label>)}
      </div>
      <button type="button" className="workbench-popover-close" aria-label="关闭布局设置" onClick={close} style={{ marginTop: 12 }}>关闭</button>
    </div>}
  </div>;
}
export default function WorkbenchViewToolbar({ top, scopeHeader, scopeMessageId, exportTitle, exportData, exportUsername, onLocalExport, discussion, home, clean, filter, view, comparison, correctionFilterTargetId, onLeaderboard, history, onJump }: Props) {
  const {layout}=useThemeSettings();
  const [exportOpen, setExportOpen] = useState(false);
  const nativeZhihuExport = isNativeZhihuView(exportData);
  const { viewMode, setViewMode, leftPanelRef, viewModeScrollRef, draftUnits, targetUnits, traceCount, currentClassifyRelMsgId, messages, relations, findContainingClassification, exitClassification, enterClassification, scheduleViewNavigation } = view;
  const { singleSideReview, comparisonMode, comparisonReviewed, comparisonTargetId, setComparisonTargetId, onStartComparison } = comparison;
  const exportView: NonNullable<ExportData['view']> = {
    username: exportUsername !== undefined ? exportUsername : exportData?.viewerUsername ?? null, mode: viewMode,
    messageFilter: { ...filter.settings }, homeFilter: home.mode,
    cleanFilters: clean.filters.map(rule => ({ ...rule })), classificationId: currentClassifyRelMsgId,
    ...(discussion ? { discussion: copyDiscussionView(discussion.value) } : {}),
  };
  return (
    <div data-workbench-view-toolbar="true" style={{ flex: "0 0 auto", borderBottom: "1px solid var(--line-333)", background: "var(--surface-141414)", position: "sticky", top, zIndex: Z_INDEX.header - 1 }}>
      <div style={{ padding: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600 }}>{viewMode === "list" ? "消息列表" : "消息图"}</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {viewMode === "list" ? "按线性结构查看消息。" : "按非线性结构查看消息。"}
          </div>
        </div>
        <div className="workbench-view-actions" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button onClick={() => onLocalExport && !nativeZhihuExport ? onLocalExport(exportView) : setExportOpen(true)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--line-666)", background: "var(--surface-333)", color: "var(--ink-fff)", fontSize: 12, cursor: "pointer", fontWeight: 400 }}>
            {onLocalExport || nativeZhihuExport ? '下载阅览文件' : '导出'}
          </button>
          {layout.messageJump==='clipboard-dialog'&&<MessageJumpControl knownIds={new Set(messages.map(message=>message.id))} onJump={onJump}/>}
          <HomeFilterPanel {...home} />
          <DeferredWorkbench label="过滤选项" blocksDrawing><CleanFilterPanel {...clean} /></DeferredWorkbench>
          {!comparisonMode && !comparisonReviewed && <button
            onClick={onStartComparison}
            style={{ padding: "2px 8px", borderRadius: 4, border: comparisonMode ? "1px solid var(--line-22c55e)" : "1px solid var(--line-666)", background: comparisonMode ? "var(--surface-12351f)" : "var(--surface-333)", color: comparisonMode ? "var(--ink-86efac)" : "var(--ink-fff)", fontSize: 12, cursor: "pointer" }}
            title="查看赞同/反对生效后的不同显示效果"
          >
            {comparisonMode ? '退出对比' : '对比'}
          </button>}
          <button
            className="workbench-leaderboard-button"
            onClick={() => {
              onLeaderboard();
            }}
            style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--line-d97706)", background: "var(--surface-3f2a06)", color: "var(--ink-fbbf24)", fontSize: 12, cursor: "pointer" }}
            title="查看人榜与消息榜"
          >
            排行榜
          </button>
          <div style={{display:'flex',gap:6,alignItems:'center',flexShrink:0}}>
            {viewMode === 'graph' && discussion && <LayoutSettings {...discussion} />}
            {history && <div role="group" aria-label="浏览历史" style={{display:'flex',gap:4}}>
              {(['back','forward'] as const).map(direction => {
                const enabled = direction === 'back' ? history.canGoBack : history.canGoForward;
                return <button key={direction} type="button" disabled={!enabled} onClick={history[direction]}
                  className="workbench-history-button" aria-label={direction === 'back' ? '返回' : '前进'}
                  title={direction === 'back' ? '返回上一个浏览位置' : '前进到下一个浏览位置'}
                >
                  <HistoryArrowIcon direction={direction}/>
                </button>;
              })}
            </div>}
            {!singleSideReview && !comparisonMode && !comparisonReviewed && correctionFilterTargetId === null && <button onClick={() => {
              if (leftPanelRef.current) {
                viewModeScrollRef.current[viewMode] = { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft };
              }
              const nextViewMode = viewMode === "list" ? "graph" : "list";
              const restoreTraceViewport = traceCount > 0 && viewModeScrollRef.current[nextViewMode] !== null;
              const navigationUnits = draftUnits.length > 0 ? draftUnits : targetUnits;
              const comparisonId = navigationUnits.length === 1 ? navigationUnits[0].messageId : comparisonTargetId;
              if (comparisonMode && nextViewMode === 'list') {
                setComparisonTargetId(null);
              }
              setViewMode(nextViewMode);
              const selectedMessageIds = new Set(navigationUnits.map(unit => unit.messageId));
              const selectedMessageId = selectedMessageIds.size === 1
                ? selectedMessageIds.values().next().value ?? null
                : null;
              if (nextViewMode === 'graph' && selectedMessageId && traceCount === 0) {
                const containingClassifyId = findContainingClassification(selectedMessageId);
                if (containingClassifyId && containingClassifyId !== currentClassifyRelMsgId) {
                  if (currentClassifyRelMsgId) exitClassification({ restoreSnapshot: false });
                  enterClassification(containingClassifyId);
                }
              }
              const scrollTargetId = comparisonMode
                ? comparisonId
                : selectedMessageId;
              // A trace's saved viewport takes priority over its staged selection.
              // Delayed selection navigation would cancel an unfinished restore.
              if (scrollTargetId && !restoreTraceViewport) {
                const scrollTargetMessage = messages.find(message => message.id === scrollTargetId);
                const scrollTargetRelation = relations.find(relation => relation.id === scrollTargetId);
                const isCorrectionTarget = scrollTargetMessage?.relationType?.toUpperCase() === 'CORRECT'
                  || scrollTargetRelation?.relationType?.toUpperCase() === 'CORRECT';
                const navigationTargetId = isCorrectionTarget
                  ? scrollTargetId
                  : resolveNavigationTargetId(scrollTargetId, messages, relations);
                scheduleViewNavigation(navigationTargetId);
              }
            }} data-shortcut-view-toggle="true" className="workbench-view-toggle">
              <span key={viewMode} className="workbench-view-toggle-content">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {viewMode === 'list' ? <>
                    <path d="m7.5 6 9 0M7 8l4 9m6-9-4 9" />
                    <circle cx="6" cy="5" r="2.5" /><circle cx="18" cy="5" r="2.5" /><circle cx="12" cy="19" r="2.5" />
                  </> : <>
                    <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 10h18M9 10v10m6-10v10" />
                  </>}
                </svg>
                {viewMode === "list" ? "切换为消息图" : "切换为消息表"}
              </span>
            </button>}
          </div>
        </div>
      </div>
      </div>
      {discussion?.error && <div role="alert" style={{ padding: '4px 8px', color: 'var(--ink-f87171)', fontSize: 12 }}>
        {discussion.error} <button type="button" onClick={discussion.retry}>重试保存布局</button>
      </div>}
      {scopeHeader}
      {exportOpen && <Suspense fallback={<div role="status">正在打开导出…</div>}><ExportModal onClose={() => setExportOpen(false)} scopeMessageId={scopeMessageId}
        filename={nativeZhihuExport ? '知乎阅览.json' : `${exportTitle}.json`} source={exportData} view={exportView} /></Suspense>}
    </div>

  );
}
