import type { User } from '../types';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import TopicStructureView from './TopicStructureView';
import StanceHistoryPanel from './StanceHistoryPanel';
import AuditLogView from './AuditLogView';
import OperationLogView from './OperationLogView';
import RevenuePanel from './RevenuePanel';
import { useNavigate } from 'react-router-dom';

interface DraftGroup {
  messageId: string;
  wholeSelected: boolean;
  fragments: Array<{ messageId: string; selection: any }>;
}

interface TopicRightPanelProps {
  // Layout
  rightPanelRef: React.RefObject<HTMLDivElement | null> | React.Ref<HTMLDivElement>;
  TOTAL_FLEX: number;
  leftFlex: number;
  minWidth: number;

  // Mode
  isPreviewMode: boolean;
  isViewerMode?: boolean;
  viewerUsers?: User[];
  viewerUsername?: string;
  onViewerUsernameChange?: (username: string) => void;
  onExitViewer?: () => void;

  // Draft
  draftUnits: any[];
  draftGroups: DraftGroup[];
  activeTextSelectId: string | null;
  clearDraftAll: () => void;
  removeUnitFromDraft: (unit: any) => void;
  commitDraftTo: (side: 'source' | 'target') => void;
  selKey: (u: any) => string;

  // Source/Target
  sourceUnits: any[];
  targetUnits: any[];
  removeUnitFrom: (side: 'source' | 'target', unit: any) => void;
  describeUnit: (u: any) => string;

  // Focus
  focusHop: number;
  setFocusHop: (fn: (h: number) => number) => void;
  canSetFocus: boolean;
  canExitFocus: boolean;
  getSelectedWholeMessageIds: () => string[];
  lastClickedMessageId: string | null;
  enterFocusMultiple: (ids: string[], opts: { replace: boolean }) => void;
  enterFocus: (id: string, opts: { replace: boolean }) => void;
  exitFocus: () => void;
  exitAllFocus: () => void;
  onNavigateToMessage: (messageId: string) => void;
  isInsideClassify: boolean;
  currentFocusIds: string[] | null;
  classifyKey: number;
  focusKey: number;

  // Messages & edges
  messages: DemoMessage[];
  edges: DemoEdge[];

  // User
  user: User | null;

  // Relation type
  relationType: string | null;
  setRelationType?: (t: string | null) => void; // used via relationButtons
  secondaryRelationType: string;
  setSecondaryRelationType: (fn: (prev: string) => string) => void;
  hasSecondaryRelationSelector: boolean;
  tagSecondaryOptions: string[];
  correctSecondaryOptions: string[];
  proposalSecondaryOptions: string[];
  isArrangeType: boolean;
  isArrangeLayoutLocked: boolean;
  isClassifyType: boolean;
  isSummaryType: boolean;
  isMergeType: boolean;
  isGovernanceOrOpsType: boolean;
  isTagWithQuickAnnotate: boolean;
  hasTargetsAvailable: boolean;
  draftHasRelationTarget: boolean;
  hasTextContent: boolean;
  secondaryRelationLabel: (t: string) => string;
  replyAdditionalLabel: (st: string) => string;

  // SubType
  subType: string;
  setSubType: (s: string) => void;
  subTypeCustomLabel: string;
  setSubTypeCustomLabel: (s: string) => void;
  subTypeCustomBufferRef: React.MutableRefObject<string>;
  SUB_TYPE_OPTIONS: string[];
  subTypeLabel: (st: string) => string;

  // Label
  relationLabel: string;
  setRelationLabel: (s: string) => void;

  // Text
  newMessageContent: string;
  setNewMessageContent: (s: string) => void;
  composerRefreshKey: number | string;

  // Stakes
  stakeAmount: number | '';
  setStakeAmount: (v: number | '') => void;
  relStakeAmount: number | '';
  setRelStakeAmount: (v: number | '') => void;
  availablePoints: number;
  effectiveMinStake: number;
  singleButtonEnabled: boolean;
  singleButtonLabel: string;
  sendValidationLabel: string | null;
  totalConsumption: any;
  stakeFeeAmountRef: React.MutableRefObject<number>;
  subTypeStakeMap: React.MutableRefObject<Record<string, number>>;
  relationStakeMap: React.MutableRefObject<Record<string, number>>;

  // Send
  handleQuickSendAndRelateFromDraftTargets: () => void;
  sendError: string | null;
  sendWarning: string | null;

  // Recent
  recentNormals: DemoMessage[];
  recentRelations: DemoMessage[];

  // Panels
  showStanceHistory: boolean;
  setShowStanceHistory: (v: boolean) => void;
  showAuditLog: boolean;
  setShowAuditLog: (v: boolean) => void;
  showRevenue: boolean;
  setShowRevenue: (v: boolean) => void;
  topicId: string;

  // Comparison review
  comparisonMode?: boolean;
  comparisonTargetId?: string | null;
  comparisonSide?: 'agree' | 'disagree';
  comparisonReviewed?: boolean;
  onComparisonSideChange?: (side: 'agree' | 'disagree') => void;
  onComparisonReview?: () => void;
  onComparisonVote?: (side?: 'agree' | 'disagree') => void;
  onReturnToComparisonCategory?: () => void;
  onExitComparison?: () => void;
  comparisonMinStake?: number;

}

export default function TopicRightPanel(props: TopicRightPanelProps) {
  const p = props;
  const navigate = useNavigate();
  const showContributionControls = !p.isPreviewMode;
  const handlePanelWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const panel = event.currentTarget;
    if (event.deltaY === 0) return;
    const maxScrollTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
    const previousScrollTop = panel.scrollTop;
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, previousScrollTop + event.deltaY));
    const consumedDelta = nextScrollTop - previousScrollTop;
    const remainingDelta = event.deltaY - consumedDelta;
    const documentScroller = document.scrollingElement;
    event.preventDefault();
    if (consumedDelta !== 0) panel.scrollTop = nextScrollTop;
    if (documentScroller && remainingDelta !== 0) {
      documentScroller.scrollTop += remainingDelta;
    }
  };
  const panelStyle = {
    flex: p.TOTAL_FLEX - p.leftFlex,
    padding: 8,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    overflowY: "auto" as const,
    overflowX: "hidden" as const,
    height: "100vh",
    minWidth: p.minWidth,
    boxSizing: "border-box" as const,
    alignSelf: "flex-start",
    touchAction: "pan-y" as const,
    overscrollBehaviorY: "auto" as const,
    position: "sticky" as const,
    top: 0,
    zIndex: 10,
  };

  const renderSendControls = () => (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {showContributionControls && <>
        {/* Text stake */}
        {p.hasTextContent && p.relationType !== "delegation" && !p.isClassifyType && !p.isSummaryType && !p.isMergeType && !p.isArrangeType && !p.isGovernanceOrOpsType && !(p.draftHasRelationTarget && p.relationType === "correct") && !(p.isTagWithQuickAnnotate && p.hasTargetsAvailable) && (
          <>
            <span style={{ fontSize: 11, color: "#888" }}>文本:</span>
            <input type="number" min={10} max={p.availablePoints} value={p.stakeAmount}
              data-guide-contribution-stake="true"
              onChange={e => { const raw = e.target.value; if (raw === '') { p.setStakeAmount(''); return; } const v = parseInt(raw); if (isNaN(v)) return; p.setStakeAmount(Math.min(v, p.availablePoints)); }}
              style={{ width: 48, padding: "2px 4px", borderRadius: 4, border: "1px solid #555", background: "#1a1a1a", color: "#eee", fontSize: 12, textAlign: "center" }} />
          </>
        )}
        {!p.hasTextContent && !p.relationType && (
          <>
            <span style={{ fontSize: 11, color: "#888" }}>押注:</span>
            <input type="number" min={10} max={p.availablePoints} value={p.stakeAmount}
              data-guide-contribution-stake="true"
              onChange={e => { const raw = e.target.value; if (raw === '') { p.setStakeAmount(''); return; } const v = parseInt(raw); if (isNaN(v)) return; p.setStakeAmount(Math.min(v, p.availablePoints)); }}
              style={{ width: 48, padding: "2px 4px", borderRadius: 4, border: "1px solid #555", background: "#1a1a1a", color: "#eee", fontSize: 12, textAlign: "center" }} />
          </>
        )}
        {/* Relation stake */}
        {p.relationType && (
          <>
            <span style={{ fontSize: 11, color: "#888" }}>{p.hasTextContent && !p.isClassifyType && !p.isSummaryType && !p.isMergeType && !p.isGovernanceOrOpsType && !(p.draftHasRelationTarget && p.relationType === "correct") && !(p.isTagWithQuickAnnotate && p.hasTargetsAvailable) ? '+关系:' : '押注:'}</span>
            <input type="number" min={p.effectiveMinStake} max={p.availablePoints} value={p.relStakeAmount}
              data-guide-contribution-stake="true"
              onChange={e => { const raw = e.target.value; if (raw === '') { p.setRelStakeAmount(''); return; } const v = parseInt(raw); if (isNaN(v)) return; p.setRelStakeAmount(Math.min(v, p.availablePoints)); }}
              style={{ width: 48, padding: "2px 4px", borderRadius: 4, border: typeof p.relStakeAmount === 'number' && p.relStakeAmount < p.effectiveMinStake ? "1px solid #f87171" : "1px solid #666", background: "#1a1a1a", color: "#eee", fontSize: 12, textAlign: "center" }} />
            {p.subType && p.subTypeStakeMap.current[p.subType] && p.subTypeStakeMap.current[p.subType] > (p.relationStakeMap.current[(p.relationType ?? '').toUpperCase()] ?? 0) && (
              <span style={{ fontSize: 10, color: "#f59e0b" }}>（「{p.subTypeLabel(p.subType)}」最低 {p.subTypeStakeMap.current[p.subType]} 点）</span>
            )}
          </>
        )}
        <span style={{ fontSize: 11, color: "#666" }}>点 / {p.availablePoints}</span>
        {p.totalConsumption && (
          <span data-guide-contribution-consumption="true" style={{ fontSize: 11, color: p.totalConsumption.total > p.availablePoints ? "#f87171" : "#f59e0b" }}>
            总计 {p.totalConsumption.total} 点
            <span style={{ color: "#888" }}>
              （{[p.totalConsumption.hasText ? `文本 ${p.totalConsumption.textStake}` : null,
                p.totalConsumption.hasRel ? `关系 ${p.totalConsumption.perStake}×${p.totalConsumption.relCount}` : null,
                (p.totalConsumption as any).refCount > 0 ? `引用 ${(p.totalConsumption as any).refStakeTotal}` : null,
                (p.totalConsumption as any).joinCount > 0 ? `加入 ${(p.totalConsumption as any).joinStakeTotal + ((p.totalConsumption as any).joinFeeTotal ?? (p.totalConsumption as any).joinBurnTotal ?? 0)}（${(p.totalConsumption as any).joinCount}×${1 + p.stakeFeeAmountRef.current}）` : null,
                p.totalConsumption.burnTotal > 0 ? `燃烧 ${p.totalConsumption.burnTotal}` : null,
              ].filter(Boolean).join(' + ')}）
            </span>
            {' '}
            <span style={{ color: p.availablePoints - p.totalConsumption.total < 0 ? "#f87171" : "#4ade80" }}>
              剩余 {p.availablePoints - p.totalConsumption.total} 点
            </span>
          </span>
        )}
        </>}
        <button data-guide-send="true" data-guide-text-message-send="true" onClick={() => { window.dispatchEvent(new Event('guide-send-selected')); p.handleQuickSendAndRelateFromDraftTargets(); }} disabled={p.isPreviewMode || !p.singleButtonEnabled}
          style={{ padding: "4px 14px", borderRadius: 4, border: "1px solid #666", background: (p.singleButtonEnabled && !p.isPreviewMode) ? "#0b84ff" : "#333", color: (p.singleButtonEnabled && !p.isPreviewMode) ? "#fff" : "#777", cursor: (p.singleButtonEnabled && !p.isPreviewMode) ? "pointer" : "default", fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
          发送
        </button>
        <span style={{ fontSize: 11, color: "#fff" }}>{p.singleButtonLabel}</span>
      </div>
      {p.sendValidationLabel && <div style={{ color: "#fbbf24", fontSize: 11, marginTop: 4 }}>{p.sendValidationLabel}</div>}
      {p.sendError && <div style={{ color: "#f87171", fontSize: 11, marginTop: 4 }}>{p.sendError}</div>}
      {p.sendWarning && <div style={{ color: "#fbbf24", fontSize: 11, marginTop: 4 }}>⚠️ {p.sendWarning}</div>}
    </>
  );
  const isComparison = Boolean(p.comparisonMode || p.comparisonReviewed);
  const comparisonDraft = p.draftUnits.length === 1 && p.draftUnits[0].selection.kind === 'whole'
    ? p.draftUnits[0]
    : null;
  const comparisonTarget = p.messages.find(message => message.id === (p.comparisonTargetId ?? comparisonDraft?.messageId ?? null));
  const comparisonCanReview = Boolean(comparisonDraft && comparisonTarget);
  const renderComparisonHeader = () => isComparison && (
    <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontWeight: 600 }}>对比审阅</div>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{comparisonTarget ? `当前目标：${comparisonTarget.author} · ${comparisonTarget.content || comparisonTarget.id}` : "请在左侧选择目标消息"}</div>
      {!p.comparisonReviewed && <button disabled={!comparisonCanReview} onClick={p.onComparisonReview} style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid #38bdf8", background: "#123047", color: "#7dd3fc", cursor: comparisonCanReview ? "pointer" : "default", opacity: comparisonCanReview ? 1 : 0.5 }}>
        审阅
      </button>}
      {p.comparisonReviewed && p.isViewerMode && <div style={{ padding: "6px 8px", border: "1px solid #475569", borderRadius: 4, background: "#111827", color: "#cbd5e1", fontSize: 12 }}>
        当前为只读对比审阅状态，可查看赞同后与反对后的结构，不支持发送关系或消息。
      </div>}
      {p.comparisonReviewed && <button onClick={p.onReturnToComparisonCategory} style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid #38bdf8", background: "#123047", color: "#7dd3fc", cursor: "pointer" }}>
        回到临时分类
      </button>}
      <button onClick={p.onExitComparison} style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>
        退出对比
      </button>
    </div>
  );

  if (p.isViewerMode) {
    return (
      <div ref={p.rightPanelRef as React.Ref<HTMLDivElement>} className="topic-right-panel" onWheel={handlePanelWheel} style={panelStyle}>
        {renderComparisonHeader()}
        <div style={{ border: "1px solid #444", borderRadius: 6, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontWeight: 600, color: "#e2e8f0" }}>只读阅览</div>
          <div style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.6 }}>当前为导出数据阅览模式，不支持发送消息、建立关系或结算操作。</div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, color: "#cbd5e1", fontSize: 12 }}>
            当前与会者
            <input
              list="viewer-user-options"
              placeholder="输入与会者名"
              value={p.viewerUsername ?? ""}
              onChange={event => p.onViewerUsernameChange?.(event.target.value)}
              style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid #666", background: "#222", color: "#eee", fontSize: 12 }}
            />
            <datalist id="viewer-user-options">
              {(p.viewerUsers ?? []).map(viewer => <option key={viewer.id} value={viewer.username} />)}
            </datalist>
          </label>
          <button onClick={p.onExitViewer} style={{ padding: "5px 12px", borderRadius: 4, border: "1px solid #f59e0b", background: "#2a1a00", color: "#f59e0b", fontSize: 12, cursor: "pointer" }}>
            退出阅览
          </button>
        </div>
      </div>
    );
  }
  return (
    <div ref={p.rightPanelRef as React.Ref<HTMLDivElement>} className="topic-right-panel" onWheel={handlePanelWheel} data-guide-right-panel="true" style={panelStyle}>
      {renderComparisonHeader()}
      {p.isPreviewMode && (
        <div style={{ border: "1px solid #856404", borderRadius: 6, padding: "8px 12px", background: "#3d3200", color: "#ffc107", fontSize: 13, fontWeight: 600 }}>
          ⚠ 预览模式 — 该分类已被反对，无法发送消息或修改
        </div>
      )}
      <div data-guide-selection-staging="true" style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}>
          <div style={{ fontWeight: 600 }}>选择暂存区</div>
          <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
            <button onClick={p.clearDraftAll} disabled={p.draftUnits.length === 0 && !p.activeTextSelectId}
              style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.draftUnits.length === 0 && !p.activeTextSelectId ? "#333" : "#444", color: p.draftUnits.length === 0 && !p.activeTextSelectId ? "#777" : "#fff", cursor: p.draftUnits.length === 0 && !p.activeTextSelectId ? "default" : "pointer" }}>
              清空
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => { const selWhole = p.getSelectedWholeMessageIds(); if (selWhole.length > 0) p.enterFocusMultiple(selWhole, { replace: false }); else if (p.lastClickedMessageId) p.enterFocus(p.lastClickedMessageId, { replace: false }); }} disabled={!p.canSetFocus}
                style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.canSetFocus ? "#444" : "#333", color: p.canSetFocus ? "#fff" : "#777", cursor: p.canSetFocus ? "pointer" : "default" }}>
                设为焦点消息
              </button>
              {p.canExitFocus && <div style={{ display: "flex", gap: 6 }}>
                <button onClick={p.exitFocus} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#444", color: "#fff", cursor: "pointer" }} title="退出最近一次进入的焦点并恢复进入该焦点前的现场">退出焦点</button>
                <button onClick={p.exitAllFocus} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", cursor: "pointer" }} title="退出所有焦点并恢复进入第一个焦点前的现场">退出全部</button>
              </div>}
            </div>
          </div>
        </div>

        {p.canExitFocus && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>焦点范围：{p.focusHop}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => p.setFocusHop(h => Math.max(0, h - 1))} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#222", color: "#fff", cursor: "pointer" }}>-</button>
            <button onClick={() => p.setFocusHop(h => Math.min(8, h + 1))} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#222", color: "#fff", cursor: "pointer" }}>+</button>
            <div style={{ fontSize: 12, opacity: 0.7 }}>（数值越大，显示的关联消息越多；默认 1，最大 8）</div>
          </div>
        </div>}

        {p.draftGroups.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>当前未选择任何候选。</div>
        ) : (
          <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 220, overflow: "auto", fontSize: 12, marginTop: 8 }}>
            {p.draftGroups.map(g => (
              <li key={`DG-${g.messageId}`} style={{ borderBottom: "1px solid #333", paddingBottom: 6, marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span>{g.messageId} · 整条：{g.wholeSelected ? "是" : "否"} · 片段数：{g.fragments.length}</span>
                  {g.wholeSelected && <button onClick={() => p.removeUnitFromDraft({ messageId: g.messageId, selection: { kind: "whole" } })} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除整条</button>}
                </div>
                {g.fragments.length > 0 && (
                  <ul style={{ listStyle: "disc", marginLeft: 18, marginTop: 2, marginBottom: 0 }}>
                    {g.fragments.map((u: any) => {
                      const s = u.selection;
                      const label = s.kind === "edge" ? `@edge:${s.edgeId}` : s.kind === "text" ? `start=${s.start} len=${s.len} "${s.text}"` : "(whole)";
                      return (
                        <li key={p.selKey(u)} style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                          <button onClick={() => p.removeUnitFromDraft(u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer", flex: "0 0 auto" }}>删除片段</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={() => p.commitDraftTo("source")} disabled={p.draftUnits.length === 0} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.draftUnits.length === 0 ? "#333" : "#444", color: p.draftUnits.length === 0 ? "#777" : "#fff", cursor: p.draftUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>加入来源集合</button>
          <button onClick={() => p.commitDraftTo("target")} disabled={p.draftUnits.length === 0} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.draftUnits.length === 0 ? "#333" : "#444", color: p.draftUnits.length === 0 ? "#777" : "#fff", cursor: p.draftUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>加入目标集合</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, marginBottom: 4 }}>
            <span>来源集合</span>
            <span style={{ fontSize: 11, opacity: 0.65 }}>{p.sourceUnits.length} 项</span>
          </div>
          {p.sourceUnits.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div> : (
            <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 120, overflow: "auto", fontSize: 12 }}>
              {p.sourceUnits.map((u: any) => (
                <li key={p.selKey(u)} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <span>{p.describeUnit(u)}</span>
                  <button onClick={() => p.removeUnitFrom("source", u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, marginBottom: 4 }}>
            <span>目标集合</span>
            <span style={{ fontSize: 11, opacity: 0.65 }}>{p.targetUnits.length} 项</span>
          </div>
          {p.targetUnits.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div> : (
            <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 120, overflow: "auto", fontSize: 12 }}>
              {p.targetUnits.map((u: any) => (
                <li key={p.selKey(u)} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <span>{p.describeUnit(u)}</span>
                  <button onClick={() => p.removeUnitFrom("target", u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {p.draftUnits.length > 0 && p.targetUnits.length > 0 && (
        <div style={{ border: "1px solid #b45309", borderRadius: 4, padding: "6px 8px", background: "#3b2708", color: "#fbbf24", fontSize: 12 }}>
          候选区和目标集合同时有内容。发送前请将候选区移入目标集合，或清空其中一方。
        </div>
      )}

      <>
        <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 600 }}>输入框（消息与关系设置）</div>
          {p.hasSecondaryRelationSelector && (() => {
            const opts = p.relationType === "reply"
              ? ["none", "question", "answer"]
              : p.relationType === "tag"
                ? p.tagSecondaryOptions
                : p.relationType === "arrange"
                  ? ["vertical", "horizontal"]
                  : p.relationType === "reference"
                    ? ["none", "evidence", "delegation", "custom"]
                      : p.relationType === "proposal"
                        ? p.proposalSecondaryOptions
                      : p.relationType === "delegation"
                        ? ["create", "fulfill"]
                      : p.correctSecondaryOptions;
            return (
              <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, flexWrap: "wrap" }}>
                <span style={{ opacity: 0.85 }}>附加关系：</span>
                {opts.map(t => (
                  <button key={t} onClick={() => {
                    if (p.isArrangeType && p.isArrangeLayoutLocked) return;
                    p.setSecondaryRelationType(prev => (prev === t && t !== "none") ? "none" : t);
                  }}
                    disabled={p.isArrangeType && p.isArrangeLayoutLocked}
                    style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.secondaryRelationType === t ? "#0b84ff" : "#222", color: p.secondaryRelationType === t ? "#fff" : "rgba(255,255,255,0.7)", cursor: (p.isArrangeType && p.isArrangeLayoutLocked) ? "not-allowed" : "pointer", opacity: (p.isArrangeType && p.isArrangeLayoutLocked) ? 0.5 : 1 }}>
                    {p.secondaryRelationLabel(t)}
                  </button>
                ))}
              </div>
            );
          })()}
          {/* SubType selector */}
          {((p.relationType === "tag" && (p.secondaryRelationType === "recommend" || p.secondaryRelationType === "archive")) || p.relationType === "recommend" || p.relationType === "archive") && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, flexWrap: "wrap" }}>
              <span style={{ opacity: 0.85 }}>标注理由：</span>
              {p.SUB_TYPE_OPTIONS.map(st => (
                <button key={st || 'none'} onClick={() => {
                  if (st === 'CUSTOM') {
                    p.setNewMessageContent(p.subTypeCustomBufferRef.current);
                    p.setSubType(st);
                  } else if (p.subType === 'CUSTOM') {
                    p.subTypeCustomBufferRef.current = p.newMessageContent;
                    p.setNewMessageContent('');
                    p.setSubType(st);
                    p.setSubTypeCustomLabel('');
                  } else {
                    p.setSubType(st);
                    p.setNewMessageContent('');
                    if (st !== 'CUSTOM') p.setSubTypeCustomLabel('');
                  }
                }}
                  style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.subType === st ? (p.secondaryRelationType === "recommend" ? "#f59e0b" : "#64748b") : "#222", color: p.subType === st ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                  {st ? p.subTypeLabel(st) : '无'}
                </button>
              ))}
            </div>
          )}
          {/* Label input */}
          {p.relationType === "reply" && (
          <input
            style={{ width: "100%", padding: 4, borderRadius: 4, border: "1px solid #555", background: "#1a1a1a", color: "#999", fontSize: 12 }}
            placeholder="回复标签由附加关系决定"
            value={p.replyAdditionalLabel(p.secondaryRelationType)}
            readOnly
          />
          )}
          {p.relationType === "reference" && p.secondaryRelationType === "custom" && (
          <input
            style={{ width: "100%", padding: 4, borderRadius: 4, border: "1px solid #555", background: "#222", color: "#eee", fontSize: 12 }}
            placeholder="输入自定义引用标签"
            value={p.relationLabel}
            onChange={e => p.setRelationLabel(e.target.value)}
          />
          )}
          <div key={p.composerRefreshKey}>
          {(() => {
            const isCustomSubType = p.subType === 'CUSTOM' && ((p.relationType === "tag" && (p.secondaryRelationType === "recommend" || p.secondaryRelationType === "archive")) || p.relationType === "recommend" || p.relationType === "archive");
            const isTagWithoutSecondary = p.relationType === "tag" && p.secondaryRelationType === "none";
            const textAreaDisabled =
              isTagWithoutSecondary
              || (isCustomSubType ? false : (
                (p.draftHasRelationTarget && p.relationType === "correct")
                || (p.isTagWithQuickAnnotate && p.hasTargetsAvailable)
                || (p.isMergeType && p.hasTargetsAvailable)
                || (p.isGovernanceOrOpsType && p.relationType === "proposal" && (p.secondaryRelationType === '分配收入' || p.secondaryRelationType === '终止结算'))
              ));
            const placeholderText = isCustomSubType ? "输入自定义理由（最长20字）"
              : isTagWithoutSecondary ? "请先在上方选择推荐或冷藏"
              : textAreaDisabled
              ? (p.isTagWithQuickAnnotate ? "已选择附加关系，此处不可输入" : p.isMergeType ? "归并关系为与会者-消息关系，此处不应输入内容" : "更正关系目标为关系消息时，此处不应有内容")
              : p.isClassifyType ? "输入分类名称（不能为空）"
              : p.isSummaryType ? "输入总结内容（不能为空）"
              : p.isArrangeType ? "可选：输入文本消息加入排列框架"
              : p.isGovernanceOrOpsType ? (p.relationType === "proposal"
                ? (p.secondaryRelationType === '分配收入' ? "系统自动生成分配提案内容" : p.secondaryRelationType === '终止结算' ? "系统自动生成终止结算提案内容" : "输入提案内容（不能为空，支持 Markdown）")
                : "输入运营公告内容（不能为空，支持 Markdown）")
              : "输入一条新普通消息（支持自由换行）";
            return (
              <textarea
                data-guide-message-input="true"
                style={{ width: "100%", minHeight: 80, maxHeight: 220, padding: 4, borderRadius: 4, border: "1px solid #555", background: textAreaDisabled ? "#1a1a1a" : "#222", color: textAreaDisabled ? "#666" : "#eee", fontSize: 13, resize: "vertical" }}
                placeholder={placeholderText}
                value={p.newMessageContent}
                readOnly={textAreaDisabled}
                onChange={e => !textAreaDisabled && p.setNewMessageContent(e.target.value)}
              />
            );
          })()}
          {renderSendControls()}
          </div>
        </div>
      </>

      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
        <div style={{ fontWeight: 600 }}>焦点</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{p.isInsideClassify ? "当前模式：分类" : "当前模式：焦点"}</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>当前焦点：{p.currentFocusIds ? p.currentFocusIds.join(", ") : "（无）"}</div>
      </div>

      <TopicStructureView key={`sv-${p.classifyKey}-${p.focusKey}`} topicId={p.topicId} focusIds={p.currentFocusIds ?? []} messages={p.messages} edges={p.edges} onNavigateToMessage={p.onNavigateToMessage} />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>最近普通消息</div>
          <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, fontSize: 12, maxHeight: 200, overflow: "auto" }}>
            {p.recentNormals.map(m => <li key={m.id} style={{ marginBottom: 2, wordBreak: "break-all" }}>{m.id}：{m.content}</li>)}
          </ul>
        </div>
        <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>最近关系消息</div>
          <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, fontSize: 12, maxHeight: 200, overflow: "auto" }}>
            {p.recentRelations.map(m => {
              const notifyUsers = m.relationType === 'notify'
                ? (Array.isArray(m.relationPayload?.notifyUsers) && m.relationPayload.notifyUsers.length > 0
                  ? m.relationPayload.notifyUsers
                  : (m.relationPayload?.notifyUserIds ?? []).map(id => ({ id, username: `与会者 ${id}` })))
                : [];
              return (
                <li key={m.id} style={{ marginBottom: 2, wordBreak: "break-all" }}>
                  {m.id}：{m.content}
                  {notifyUsers.length > 0 && (
                    <span>（通知与会者：{notifyUsers.map((notifyUser, index) => (
                      <span key={notifyUser.id}>
                        {index > 0 && '、'}
                        <span onClick={() => navigate(`/topics/${p.topicId}?sender=${encodeURIComponent(notifyUser.username)}`)} style={{ color: '#a5f3fc', textDecoration: 'underline', cursor: 'pointer' }}>
                          {notifyUser.username}
                        </span>
                      </span>
                    ))}）</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Stance History */}
      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600 }}>📋 站队 · 立场 · 表态</div>
          <button onClick={() => p.setShowStanceHistory(!p.showStanceHistory)}
            style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.showStanceHistory ? "#0b84ff" : "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
            {p.showStanceHistory ? '收起' : '展开'}
          </button>
        </div>
        {p.showStanceHistory && p.user && (
          <div style={{ marginTop: 8 }}><StanceHistoryPanel userId={p.user.id} topicId={p.topicId} /></div>
        )}
      </div>

      {/* Audit Log */}
      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600 }}>📋 审计日志</div>
          <button onClick={() => p.setShowAuditLog(!p.showAuditLog)}
            style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.showAuditLog ? "#0b84ff" : "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
            {p.showAuditLog ? '收起' : '展开'}
          </button>
        </div>
        {p.showAuditLog && (
          <div style={{ marginTop: 8 }}><AuditLogView topicId={p.topicId} /></div>
        )}
      </div>

      {/* Revenue */}
      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600 }}>💰 收入</div>
          <button onClick={() => p.setShowRevenue(!p.showRevenue)}
            style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.showRevenue ? "#0b84ff" : "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
            {p.showRevenue ? '收起' : '展开'}
          </button>
        </div>
        {p.showRevenue && (
          <div style={{ marginTop: 8 }}><RevenuePanel /></div>
        )}
      </div>

      <OperationLogView />

    </div>
  );
}
