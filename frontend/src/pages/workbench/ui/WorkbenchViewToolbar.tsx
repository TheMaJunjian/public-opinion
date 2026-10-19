import { useState, type ComponentProps, type Dispatch, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction } from 'react';
import CleanFilterPanel from '../../../components/CleanFilterPanel';
import HomeFilterPanel from '../../../components/HomeFilterPanel';
import MessageFilterPanel from '../../../components/MessageFilterPanel';
import { Z_INDEX } from '../../../constants/zIndex';
import type { Relation } from '../../../types';
import type { DemoMessage, UnitSelection } from '../../../utils/modelBridge';
import { resolveNavigationTargetId } from '../model/navigation';
import type { ExportData } from '../../../api/client';
import ExportModal from '../../../components/ExportModal';
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
}
export default function WorkbenchViewToolbar({ top, scopeHeader, scopeMessageId, exportTitle, exportData, exportUsername, home, clean, filter, view, comparison, correctionFilterTargetId, onLeaderboard }: Props) {
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
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => setExportOpen(true)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #4a9eff", background: "#1a3a5c", color: "#4a9eff", fontSize: 12, cursor: "pointer" }}>
            导出
          </button>
          <HomeFilterPanel {...home} />
          <CleanFilterPanel {...clean} />
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
          }} data-shortcut-view-toggle="true" style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 12, cursor: "pointer" }}>
            {viewMode === "list" ? "切换为消息图" : "切换为消息表"}
          </button>}
        </div>
      </div>
      </div>
      {scopeHeader}
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} scopeMessageId={scopeMessageId}
        filename={`${exportTitle}.json`} source={exportData} view={{
          username: exportUsername !== undefined ? exportUsername : exportData?.viewerUsername ?? null, mode: viewMode,
          messageFilter: { ...filter.settings }, homeFilter: home.mode,
          cleanFilters: clean.filters.map(rule => ({ ...rule })), classificationId: currentClassifyRelMsgId,
        }} />}
    </div>

  );
}
