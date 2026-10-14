import type { ComponentProps, Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { api } from '../../../api';
import CleanFilterPanel from '../../../components/CleanFilterPanel';
import HomeFilterPanel from '../../../components/HomeFilterPanel';
import MessageFilterPanel from '../../../components/MessageFilterPanel';
import { Z_INDEX } from '../../../constants/zIndex';
import type { Relation } from '../../../types';
import type { DemoEdge, DemoMessage, UnitSelection } from '../../../utils/modelBridge';
import { resolveNavigationTargetId } from '../model/navigation';
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
  comparisonMode: boolean; comparisonReviewed: boolean; comparisonTargetId: string | null;
  setComparisonMode: Dispatch<SetStateAction<boolean>>; setComparisonTargetId: Dispatch<SetStateAction<string | null>>;
  setComparisonReviewed: Dispatch<SetStateAction<boolean>>;
  setComparisonReviewBaseMessages: Dispatch<SetStateAction<DemoMessage[] | null>>;
  setComparisonReviewBaseEdges: Dispatch<SetStateAction<DemoEdge[] | null>>;
  setDraftUnits: Dispatch<SetStateAction<UnitSelection[]>>;
  enterTemporaryCategory: (force?: boolean) => void;
}
interface Props {
  top: number; scopeMessageId: string; exportTitle: string; showAlert: (message: string) => void;
  home: ComponentProps<typeof HomeFilterPanel>; clean: ComponentProps<typeof CleanFilterPanel>; filter: ComponentProps<typeof MessageFilterPanel>;
  view: ViewNavigation; comparison: ComparisonControls;
  correctionFilterTargetId: string | null; onLeaderboard: () => void;
}
export default function WorkbenchViewToolbar({ top, scopeMessageId, exportTitle, showAlert, home, clean, filter, view, comparison, correctionFilterTargetId, onLeaderboard }: Props) {
  const { viewMode, setViewMode, leftPanelRef, viewModeScrollRef, draftUnits, targetUnits, traceCount, currentClassifyRelMsgId, messages, relations, findContainingClassification, exitClassification, enterClassification, scheduleViewNavigation } = view;
  const { comparisonMode, comparisonReviewed, comparisonTargetId, setComparisonMode, setComparisonTargetId, setComparisonReviewed, setComparisonReviewBaseMessages, setComparisonReviewBaseEdges, setDraftUnits, enterTemporaryCategory } = comparison;
  return (
    <div style={{ flex: "0 0 auto", padding: 8, borderBottom: "1px solid #333", background: "#141414", position: "sticky", top, zIndex: Z_INDEX.header - 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600 }}>{viewMode === "list" ? "消息列表" : "消息图"}</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {viewMode === "list" ? "按线性结构查看消息。" : "按非线性结构查看消息。"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={async () => {
            try {
              const data = await api.exportMessages(scopeMessageId!);
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${exportTitle}.json`;
              a.click();
              URL.revokeObjectURL(url);
            } catch (e: unknown) {
              showAlert(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
            }
          }} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #4a9eff", background: "#1a3a5c", color: "#4a9eff", fontSize: 12, cursor: "pointer" }}>
            导出
          </button>
          <HomeFilterPanel {...home} />
          <CleanFilterPanel {...clean} />
          <MessageFilterPanel {...filter} />
          {!comparisonMode && !comparisonReviewed && <button
            onClick={() => {
              setComparisonMode(current => {
                const next = !current;
                if (next) enterTemporaryCategory(true);
                setComparisonTargetId(null);
                setComparisonReviewed(false);
                setComparisonReviewBaseMessages(null);
                setComparisonReviewBaseEdges(null);
                if (next) setDraftUnits([]);
                return next;
              });
              setViewMode('list');
            }}
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
          {!comparisonMode && !comparisonReviewed && correctionFilterTargetId === null && <button onClick={() => {
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

  );
}
