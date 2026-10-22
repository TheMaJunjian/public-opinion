import { lazy, Suspense, useState, type ComponentProps, type Dispatch, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction } from 'react';
import DeferredWorkbench from '../../../components/DeferredWorkbench';
import HomeFilterPanel from '../../../components/HomeFilterPanel';
import MessageFilterPanel from '../../../components/MessageFilterPanel';
import { Z_INDEX } from '../../../constants/zIndex';
import type { Relation } from '../../../types';
import type { DemoMessage, UnitSelection } from '../../../utils/modelBridge';
import { resolveNavigationTargetId } from '../model/navigation';
import type { ExportData } from '../../../api/client';
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
  scopeHeader?: ReactNode;
  top: number; scopeMessageId: string; exportTitle: string; showAlert: (message: string) => void;
  exportData?: ExportData | null; exportUsername?: string | null;
  home: ComponentProps<typeof HomeFilterPanel>; clean: ComponentProps<typeof CleanFilterPanel>; filter: ComponentProps<typeof MessageFilterPanel>;
  view: ViewNavigation; comparison: ComparisonControls;
  correctionFilterTargetId: string | null; onLeaderboard: () => void;
  history?: { canGoBack: boolean; canGoForward: boolean; back: () => void; forward: () => void };
}
export default function WorkbenchViewToolbar({ top, scopeHeader, scopeMessageId, exportTitle, exportData, exportUsername, home, clean, filter, view, comparison, correctionFilterTargetId, onLeaderboard, history }: Props) {
  const [exportOpen, setExportOpen] = useState(false);
  const { viewMode, setViewMode, leftPanelRef, viewModeScrollRef, draftUnits, targetUnits, traceCount, currentClassifyRelMsgId, messages, relations, findContainingClassification, exitClassification, enterClassification, scheduleViewNavigation } = view;
  const { singleSideReview, comparisonMode, comparisonReviewed, comparisonTargetId, setComparisonTargetId, onStartComparison } = comparison;
  return (
    <div data-workbench-view-toolbar="true" style={{ flex: "0 0 auto", borderBottom: "1px solid #333", background: "#141414", position: "sticky", top, zIndex: Z_INDEX.header - 1 }}>
      <div style={{ padding: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600 }}>{viewMode === "list" ? "消息列表" : "消息图"}</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {viewMode === "list" ? "按线性结构查看消息。" : "按非线性结构查看消息。"}
          </div>
        </div>
        <div className="workbench-view-actions" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button onClick={() => setExportOpen(true)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 400 }}>
            导出
          </button>
          <HomeFilterPanel {...home} />
          <DeferredWorkbench label="过滤选项" blocksDrawing><CleanFilterPanel {...clean} /></DeferredWorkbench>
          <MessageFilterPanel {...filter} />
          {!comparisonMode && !comparisonReviewed && <button
            onClick={onStartComparison}
            style={{ padding: "2px 8px", borderRadius: 4, border: comparisonMode ? "1px solid #22c55e" : "1px solid #666", background: comparisonMode ? "#12351f" : "#333", color: comparisonMode ? "#86efac" : "#fff", fontSize: 12, cursor: "pointer" }}
            title="查看赞同/反对生效后的不同显示效果"
          >
            {comparisonMode ? '退出对比' : '对比'}
          </button>}
          <button
            onClick={() => {
              onLeaderboard();
            }}
            style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #d97706", background: "#3f2a06", color: "#fbbf24", fontSize: 12, cursor: "pointer" }}
            title="查看人榜与消息榜"
          >
            排行榜
          </button>
          <div style={{display:'flex',gap:6,alignItems:'center',flexShrink:0}}>
            {history && <div role="group" aria-label="浏览历史" style={{display:'flex',gap:4}}>
              {(['back','forward'] as const).map(direction => {
                const enabled = direction === 'back' ? history.canGoBack : history.canGoForward;
                return <button key={direction} type="button" disabled={!enabled} onClick={history[direction]}
                  className="workbench-history-button" aria-label={direction === 'back' ? '返回' : '前进'}
                  title={direction === 'back' ? '返回上一个浏览位置' : '前进到下一个浏览位置'}
                >
                  <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d={direction === 'back' ? 'M19 12H5m7 7-7-7 7-7' : 'M5 12h14m-7-7 7 7-7 7'} />
                  </svg>
                </button>;
              })}
            </div>}
            {!singleSideReview && !comparisonMode && !comparisonReviewed && correctionFilterTargetId === null && <button onClick={() => {
              if (leftPanelRef.current) {
                viewModeScrollRef.current[viewMode] = { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft };
              }
              const nextViewMode = viewMode === "list" ? "graph" : "list";
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
              if (scrollTargetId) {
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
      {scopeHeader}
      {exportOpen && <Suspense fallback={<div role="status">正在打开导出…</div>}><ExportModal onClose={() => setExportOpen(false)} scopeMessageId={scopeMessageId}
        filename={`${exportTitle}.json`} source={exportData} view={{
          username: exportUsername !== undefined ? exportUsername : exportData?.viewerUsername ?? null, mode: viewMode,
          messageFilter: { ...filter.settings }, homeFilter: home.mode,
          cleanFilters: clean.filters.map(rule => ({ ...rule })), classificationId: currentClassifyRelMsgId,
        }} /></Suspense>}
    </div>

  );
}
