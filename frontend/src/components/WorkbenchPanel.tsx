import { messageScopePath } from '../utils/messageRoutes';
import {DEFAULT_TRACE_DEPTHS} from '../utils/traceRange';
import {targetInvestmentDimension} from '@gonglun/core';
import CardWidthEditor from './graph/CardWidthEditor';
import { lazy, useMemo, useRef } from 'react';
import DeferredWorkbench from './DeferredWorkbench';
import RecentWorkbenchViews from './RecentWorkbenchViews';
import { describeUnit as describeVisibleSelection } from '../utils/selectionLabel';
import { isWholeMessageSelection } from '../utils/messageElementSelection';
import type { User } from '../types';
import { getPresentationSpec } from '../types';
import WorkbenchScrollViewport from './WorkbenchScrollViewport';
import type { DemoMessage, DemoEdge, UnitSelection } from '../utils/modelBridge';
import MessageRelationsView from './MessageRelationsView';
import OperationLogView from './OperationLogView';
import StagedMessageLabel from './StagedMessageLabel';
import StanceReadingReminder from './StanceReadingReminder';
import { useNavigate } from 'react-router-dom';
const StanceHistoryPanel = lazy(() => import('./StanceHistoryPanel'));
const AuditLogView = lazy(() => import('./AuditLogView'));
const RevenuePanel = lazy(() => import('./RevenuePanel'));

interface DraftGroup {
  messageId: string;
  wholeSelected: boolean;
  wholeUnits: UnitSelection[];
  fragments: UnitSelection[];
}

interface WorkbenchPanelProps {
  contributionGroups:Array<{type:string;label:string;count:number;truth:number|'';value:number|'';total:number}>;
  onContributionChange:(type:string,field:'truth'|'value',value:number|'')=>void;
  // Layout
  rightPanelRef: React.RefObject<HTMLDivElement | null> | React.Ref<HTMLDivElement>;
  leftPanelRef: React.RefObject<HTMLDivElement | null>;
  TOTAL_FLEX: number;
  leftFlex: number;
  minWidth: number;
  maxWidth?: number;
  stickyTop?: number | string;

  // Mode
  isPreviewMode: boolean;
  previewNotice?: string;
  singleSideReview?: { title: string; kind?:'container'|'correction'|'relation'; onExit: () => void };
  isViewerMode?: boolean;
  viewerUsers?: User[];
  viewerUsername?: string;
  onViewerUsernameChange?: (username: string) => void;
  onExitViewer?: () => void;

  // Draft
  draftUnits: UnitSelection[];
  draftGroups: DraftGroup[];
  activeTextSelectId: string | null;
  clearDraftAll: () => void;
  removeUnitFromDraft: (unit: UnitSelection) => void;
  commitDraftTo: (side: 'source' | 'target') => void;
  selKey: (u: UnitSelection) => string;

  // Source/Target
  sourceUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  removeUnitFrom: (side: 'source' | 'target', unit: UnitSelection) => void;
  describeUnit: (u: UnitSelection) => string;

  // Trace
  traceDistance: number;
  traceDirection?: import('../utils/traceRange').TraceDirection;
  onTraceDirectionChange?: (direction:import('../utils/traceRange').TraceDirection)=>void;
  traceDepths?: import('../utils/traceRange').TraceDepths;
  onTraceDepthChange?: (side:'up'|'down',value:number)=>void;
  traceReadingControls?: React.ReactNode;
  setTraceDistance?: (fn: (distance: number) => number) => void;
  canSetTrace: boolean;
  canExitTrace: boolean;
  isRelatedView?: boolean;
  getSelectedWholeMessageIds: () => string[];
  lastClickedMessageId: string | null;
  enterTraceMultiple: (ids: string[], opts: { replace: boolean }) => void;
  enterTrace: (id: string, opts: { replace: boolean }) => void;
  exitAllTrace: () => void;
  onNavigateToMessage: (messageId: string) => void;
  isInsideClassify: boolean;
  currentTraceIds: string[] | null;
  classifyKey: number;
  traceKey: number;
  viewCacheKey?:string;
  viewCacheOwner?:unknown;

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
  correctionWidth?: number;
  setCorrectionWidth?: (width: number) => void;
  proposalSecondaryOptions: string[];
  isArrangeType: boolean;
  isClassifyType: boolean;
  isSummaryType: boolean;
  isMergeType: boolean;
  joinOnlyAction?: boolean;
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

  // Spending
  recommendationAmount: number | '';
  setRecommendationAmount: (value: number | '') => void;
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
  recentTexts: DemoMessage[];
  recentRelations: DemoMessage[];

  // Panels
  showStanceHistory: boolean;
  setShowStanceHistory: (v: boolean) => void;
  showAuditLog: boolean;
  setShowAuditLog: (v: boolean) => void;
  showRevenue: boolean;
  setShowRevenue: (v: boolean) => void;
  scopeMessageId: string;

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

export default function WorkbenchPanel(props: WorkbenchPanelProps) {
  const p = props;
  const messageMap = useMemo(() => new Map(p.messages.map(message => [message.id, message])), [p.messages]);
  const describeSelection = (unit: UnitSelection) => describeVisibleSelection(unit, messageMap.get(unit.messageId));
  const collectionContent = (unit: UnitSelection) => {
    if (unit.selection.kind === 'text') return unit.selection.text;
    const message = messageMap.get(unit.messageId);
    const historic = unit.reference?.revision !== undefined && message?.revision !== undefined && unit.reference.revision !== message.revision;
    return isWholeMessageSelection(unit, unit.messageId) && !historic ? undefined : describeSelection(unit);
  };
  const navigate = useNavigate();
  const touchStartXRef = useRef<number | null>(null);
  const showContributionControls = !p.isPreviewMode;
  const handlePanelTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    touchStartXRef.current = event.touches.length === 1 ? event.touches[0].clientX : null;
  };
  const handlePanelTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1 || touchStartXRef.current === null) {
      touchStartXRef.current = null;
      return;
    }
    const panel = event.currentTarget;
    const documentScroller = document.scrollingElement;
    if (!documentScroller) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - touchStartXRef.current;
    const panelMax = Math.max(0, panel.scrollWidth - panel.clientWidth);
    const documentMax = Math.max(0, documentScroller.scrollWidth - documentScroller.clientWidth);
    const panelAtEdge = (panel.scrollLeft <= 0 && deltaX > 0) || (panel.scrollLeft >= panelMax - 1 && deltaX < 0);
    if (panelAtEdge && documentMax > 0) {
      const next = Math.max(0, Math.min(documentMax, documentScroller.scrollLeft - deltaX));
      if (next !== documentScroller.scrollLeft) {
        event.preventDefault();
        documentScroller.scrollLeft = next;
      }
    }
    touchStartXRef.current = touch.clientX;
  };
  const handlePanelTouchEnd = () => {
    touchStartXRef.current = null;
  };
  // 悬浮视口承接滚动，真实内容始终自然展开，禁止给内容层添加 height/maxHeight 上限。
  // 可视范围由 WorkbenchScrollViewport 跟随 visualViewport 测量，避免手机缩放后的截短问题。
  const viewportStyle = {
    flex: p.TOTAL_FLEX - p.leftFlex,
    minWidth: p.minWidth,
    maxWidth: p.maxWidth,
    alignSelf: "flex-start",
    position: "sticky" as const,
    top: p.stickyTop ?? 0,
    zIndex: 0,
  };
  const panelStyle = {
    padding: 8,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    boxSizing: "border-box" as const,
    overflowWrap: "anywhere" as const,
  };

  const renderSendControls = () => (
    <>
      {showContributionControls && <div data-contribution-policy="true" style={{display:'flex',alignItems:'baseline',gap:8,fontSize:11,color:'#94a3b8',whiteSpace:'nowrap'}}>
        <span style={{flexShrink:0}}>协议费 {p.stakeFeeAmountRef.current} 点/条</span>
        <span>每条消息的真假、价值至少一项大于 0</span>
      </div>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {showContributionControls && <>
          {p.contributionGroups.map(group=><div key={group.type} data-contribution-type={group.type} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 6px',border:'1px solid #444',borderRadius:4}}>
            <span style={{fontSize:11}}>{group.label}消息 × {group.count}</span>
            {(['truth','value'] as const).map(field=><label key={field} style={{fontSize:11}}>{field==='truth'?'真假':'价值'}
              <input aria-label={`${group.type==='TEXT'?'':group.label}${field==='truth'?'真假':'价值'}投入`} type="number" min={0} max={Math.max(0,p.availablePoints)} value={group[field]}
                disabled={targetInvestmentDimension(group.type)===(field==='truth'?'VALUE':'TRUTH')}
                title={targetInvestmentDimension(group.type)===(field==='truth'?'VALUE':'TRUTH')?'此项固定为 0，投入计入目标消息的另一维度':undefined}
                data-guide-contribution-stake={field==='truth'?'true':undefined}
                onChange={event=>p.onContributionChange(group.type,field,event.target.value===''?'':Math.max(0,Math.min(Number(event.target.value),Math.max(0,p.availablePoints))))}
                style={{width:54,marginLeft:4,padding:'2px 4px',background:'#1a1a1a',color:targetInvestmentDimension(group.type)===(field==='truth'?'VALUE':'TRUTH')?'#666':'#eee',border:'1px solid #555',borderRadius:4}}/>
            </label>)}
            <span style={{fontSize:11,color:'#94a3b8'}}>每条同额，小计 {group.total} 点</span>
          </div>)}
          <span style={{ fontSize: 11, color: '#94a3b8' }}>可用 {p.availablePoints} 点</span>
          {p.totalConsumption && <span data-guide-contribution-consumption="true" style={{ fontSize: 11, color: p.totalConsumption.total > p.availablePoints ? '#f87171' : '#f59e0b' }}>
            本次 {p.totalConsumption.messageCount} 条消息，预计 {p.totalConsumption.total} 点（协议费 {p.totalConsumption.protocolFeeTotal} + 真假 {p.totalConsumption.stakeTotal} + 价值 {p.totalConsumption.recommendationTotal}{p.totalConsumption.delegationRewardStake > 0 ? ` + 委托报酬 ${p.totalConsumption.delegationRewardStake}` : ''}）
          </span>}
        </>}
        <button data-guide-send="true" data-guide-text-message-send="true" onClick={() => { window.dispatchEvent(new Event('guide-send-selected')); p.handleQuickSendAndRelateFromDraftTargets(); }} disabled={p.isPreviewMode || !p.singleButtonEnabled}
          style={{ padding: "4px 14px", borderRadius: 4, border: "1px solid #666", background: (p.singleButtonEnabled && !p.isPreviewMode) ? "#0b84ff" : "#333", color: (p.singleButtonEnabled && !p.isPreviewMode) ? "#fff" : "#777", cursor: (p.singleButtonEnabled && !p.isPreviewMode) ? "pointer" : "default", fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
          发送
        </button>
        <span style={{ fontSize: 11, color: "#fff" }}>{p.singleButtonLabel}</span>
      </div>
      {p.sendValidationLabel
        ? <div style={{ color: "#fbbf24", fontSize: 11, marginTop: 4 }}>{p.sendValidationLabel}</div>
        : p.sendError && <div style={{ color: "#f87171", fontSize: 11, marginTop: 4 }}>{p.sendError}</div>}
      {p.sendWarning && <div style={{ color: "#fbbf24", fontSize: 11, marginTop: 4 }}>⚠️ {p.sendWarning}</div>}
      <StanceReadingReminder relationType={p.relationType} secondaryRelationType={p.secondaryRelationType} targetIds={(p.draftUnits.length?p.draftUnits:p.targetUnits).map(unit=>unit.messageId)}/>
    </>
  );
  const isComparison = !p.singleSideReview && Boolean(p.comparisonMode || p.comparisonReviewed);
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
        返回对比消息
      </button>}
      <button onClick={p.onExitComparison} style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>
        退出对比
      </button>
    </div>
  );

  return (
    <WorkbenchScrollViewport ref={p.rightPanelRef as React.Ref<HTMLDivElement>} className="workbench-right-panel" role="region" aria-label="发言与关系操作" tabIndex={-1} onTouchStart={handlePanelTouchStart} onTouchMove={handlePanelTouchMove} onTouchEnd={handlePanelTouchEnd} onTouchCancel={handlePanelTouchEnd} data-guide-right-panel="true" data-workbench-scroll-panel="true" data-workbench-panel-surface="true" style={viewportStyle}>
    <div data-workbench-panel-content="true" style={panelStyle}>
      {p.singleSideReview && <div role="region" aria-label="单侧对比" style={{ border: "1px solid #444", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>{p.singleSideReview.kind==='correction'?'更正查看':p.singleSideReview.kind==='relation'?'消息效果查看':'容器查看'}</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>当前目标：{p.singleSideReview.title}</div>
      </div>}
      <RecentWorkbenchViews ownerKey={p.viewCacheOwner??p.scopeMessageId} viewKey={p.traceReadingControls?'reading':'none'} limit={2}>
        {p.traceReadingControls}
      </RecentWorkbenchViews>
      {(p.singleSideReview || p.canExitTrace) && <button onClick={p.canExitTrace ? p.exitAllTrace : p.singleSideReview?.onExit}
        style={{ padding: '5px 8px', borderRadius: 4, border: '1px solid #666', background: '#333', color: '#eee', cursor: 'pointer' }}
        title={p.canExitTrace ? '退出全部追溯并恢复进入第一次追溯前的现场' : '退出当前查看'}>{p.singleSideReview || p.isRelatedView ? '退出查看' : '退出追溯'}</button>}
      {p.isViewerMode && <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontWeight: 600 }}>阅览操作</span>
          <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#cbd5e1", fontSize: 12 }}>
            当前用户
            <input
              list="viewer-user-options"
              placeholder="输入用户名"
              value={p.viewerUsername ?? ""}
              onChange={event => p.onViewerUsernameChange?.(event.target.value)}
              style={{ flex: 1, minWidth: 120, padding: "5px 8px", borderRadius: 4, border: "1px solid #666", background: "#222", color: "#eee", fontSize: 12 }}
            />
            <datalist id="viewer-user-options">
              {(p.viewerUsers ?? []).map(viewer => <option key={viewer.id} value={viewer.username} />)}
            </datalist>
          </label>
        </div>
        <button onClick={p.onExitViewer} style={{ width: "100%", boxSizing: "border-box", padding: "5px 12px", borderRadius: 4, border: "1px solid #f59e0b", background: "#2a1a00", color: "#f59e0b", fontSize: 12, cursor: "pointer" }}>退出阅览</button>
      </div>}
      {renderComparisonHeader()}
      {p.isPreviewMode && !p.singleSideReview && (
        <div style={{ border: "1px solid #856404", borderRadius: 6, padding: "8px 12px", background: "#3d3200", color: "#ffc107", fontSize: 13, fontWeight: 600 }}>
          {p.previewNotice ?? '⚠ 预览模式 — 该分类已被反对，无法发送消息或修改'}
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
              <button onClick={() => { const selWhole = p.getSelectedWholeMessageIds(); if (selWhole.length > 0) p.enterTraceMultiple(selWhole, { replace: false }); else if (p.lastClickedMessageId) p.enterTrace(p.lastClickedMessageId, { replace: false }); }} disabled={!p.canSetTrace}
                style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.canSetTrace ? "#444" : "#333", color: p.canSetTrace ? "#fff" : "#777", cursor: p.canSetTrace ? "pointer" : "default" }}>
                设为追溯消息
              </button>
            </div>
          </div>
        </div>

        {p.canExitTrace && <div style={{ display: "flex", gap: 8, alignItems: "center",flexWrap:'wrap' }}>
          {(['up','down'] as const).map(side=>{const name=side==='up'?'向上':'向下',value=p.traceDepths?.[side]??DEFAULT_TRACE_DEPTHS[side];
            return <label key={side} style={{display:'flex',alignItems:'center',gap:5,fontSize:12}}>
              {name}（{side==='up'?'前因／依据':'后续／影响'}）
              <button type="button" aria-label={`减少${name}追溯距离`} disabled={value===0} onClick={()=>p.onTraceDepthChange?.(side,value-1)}>−</button>
              <input type="number" aria-label={`${name}追溯距离`} min={0} max={8} value={value} onChange={event=>p.onTraceDepthChange?.(side,Number(event.target.value))}
                style={{width:45,padding:'3px 4px',background:'#222',color:'#fff',border:'1px solid #666',borderRadius:4}}/>
              <button type="button" aria-label={`增加${name}追溯距离`} disabled={value===8} onClick={()=>p.onTraceDepthChange?.(side,value+1)}>+</button>
            </label>;})}
          <span style={{fontSize:11,color:'#94a3b8'}}>0 为关闭该方向，最大 8</span>
        </div>}

        {p.draftGroups.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>当前未选择任何候选。</div>
        ) : (
          <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 220, overflow: "auto", fontSize: 12, marginTop: 8 }}>
            {p.draftGroups.map(g => (
              <li key={`DG-${g.messageId}`} style={{ borderBottom: "1px solid #333", paddingBottom: 6, marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <StagedMessageLabel messageId={g.messageId} message={messageMap.get(g.messageId)} onNavigate={p.onNavigateToMessage} wholeMessage={g.wholeSelected} status={g.wholeSelected ? '已选择整条' : `已选择 ${g.fragments.length} 处`} />
                  {g.wholeSelected && <button onClick={() => g.wholeUnits.forEach(p.removeUnitFromDraft)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除整条</button>}
                </div>
                {g.fragments.length > 0 && (
                  <ul style={{ listStyle: "disc", marginLeft: 18, marginTop: 2, marginBottom: 0 }}>
                    {g.fragments.map(u => {
                      const label = describeSelection(u);
                      return (
                        <li key={p.selKey(u)} style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                          <StagedMessageLabel messageId={u.messageId} message={messageMap.get(u.messageId)} wholeMessage={false}
                            content={u.selection.kind === 'text' ? u.selection.text : label}
                            ariaLabel={`暂存片段 ${p.selKey(u)}`} onNavigate={p.onNavigateToMessage} status={u.selection.kind === 'text' ? '已选择片段' : '已选择消息部件'} />
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

        {!p.isViewerMode && <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={() => p.commitDraftTo("source")} disabled={p.draftUnits.length === 0} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.draftUnits.length === 0 ? "#333" : "#444", color: p.draftUnits.length === 0 ? "#777" : "#fff", cursor: p.draftUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>加入来源集合</button>
          <button onClick={() => p.commitDraftTo("target")} disabled={p.draftUnits.length === 0} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.draftUnits.length === 0 ? "#333" : "#444", color: p.draftUnits.length === 0 ? "#777" : "#fff", cursor: p.draftUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>加入目标集合</button>
        </div>}
      </div>

      {!p.isViewerMode && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, marginBottom: 4 }}>
            <span>来源集合</span>
            <span style={{ fontSize: 11, opacity: 0.65 }}>{p.sourceUnits.length} 项</span>
          </div>
          {p.sourceUnits.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div> : (
            <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 120, overflow: "auto", fontSize: 12 }}>
              {p.sourceUnits.map(u => (
                <li key={p.selKey(u)} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <StagedMessageLabel messageId={u.messageId} message={messageMap.get(u.messageId)} ariaLabel={`来源消息 ${p.selKey(u)}`} wholeMessage={isWholeMessageSelection(u,u.messageId)}
                    content={collectionContent(u)} />
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
              {p.targetUnits.map(u => (
                <li key={p.selKey(u)} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <StagedMessageLabel messageId={u.messageId} message={messageMap.get(u.messageId)} ariaLabel={`目标消息 ${p.selKey(u)}`} wholeMessage={isWholeMessageSelection(u,u.messageId)}
                    content={collectionContent(u)} />
                  <button onClick={() => p.removeUnitFrom("target", u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>}
      {!p.isViewerMode && p.draftUnits.length > 0 && p.targetUnits.length > 0 && (
        <div style={{ border: "1px solid #b45309", borderRadius: 4, padding: "6px 8px", background: "#3b2708", color: "#fbbf24", fontSize: 12 }}>
          候选区和目标集合同时有内容。发送前请将候选区移入目标集合，或清空其中一方。
        </div>
      )}

      {!p.isViewerMode && <>
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
                  <button key={t} aria-pressed={p.secondaryRelationType === t} onClick={() => {
                    p.setSecondaryRelationType(prev => p.relationType === 'correct' ? t : (prev === t && t !== "none") ? "none" : t);
                  }}
                    style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.secondaryRelationType === t ? "#0b84ff" : "#222", color: p.secondaryRelationType === t ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                    {p.secondaryRelationLabel(t)}
                  </button>
                ))}
              </div>
            );
          })()}
          {p.relationType === 'correct' && p.secondaryRelationType === 'width-adjustment' && <CardWidthEditor
            width={p.correctionWidth ?? 320} onChange={width => p.setCorrectionWidth?.(width)} />}
          {p.relationType === 'correct' && <div style={{ fontSize: 11, color: '#9ca3af' }}>
            {p.secondaryRelationType === 'width-adjustment' ? '宽度按本人立场优先、公共统计其次显示有效更正，不改变正文。' : '正文按本人立场优先、公共统计其次显示有效更正。选字可基于显示内容，更正始终以原文为准。'}
          </div>}
          {/* SubType selector */}
          {((p.relationType === "tag" && ['recommend','archive','attention','block'].includes(p.secondaryRelationType)) || ['recommend','archive','attention','block'].includes(p.relationType ?? '')) && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, flexWrap: "wrap" }}>
              <span style={{ opacity: 0.85 }}>标注原因：</span>
              {((p.secondaryRelationType === 'attention' || p.secondaryRelationType === 'block') ? ['YES','NO'] : p.SUB_TYPE_OPTIONS).map(st => (
                <button key={st || 'none'} aria-pressed={p.subType === st} onClick={() => {
                  p.setSubType(st);
                }}
                  style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: p.subType === st ? (p.secondaryRelationType === "recommend" ? "#f59e0b" : "#64748b") : "#222", color: p.subType === st ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                  {st ? p.subTypeLabel(st) : '无'}
                </button>
              ))}
              {p.subType === 'CUSTOM' && <input type="text" aria-label="自定义标注原因" placeholder="输入自定义原因（最长20字）" maxLength={20}
                value={p.subTypeCustomLabel} onChange={event=>p.setSubTypeCustomLabel(event.target.value)}
                style={{flex:'1 1 160px',minWidth:120,padding:'3px 6px',borderRadius:4,border:'1px solid #555',background:'#222',color:'#eee'}}/>}
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
          {!(p.relationType === 'correct' && p.secondaryRelationType === 'width-adjustment') && (() => {
            const isTagWithoutSecondary = p.relationType === "tag" && p.secondaryRelationType === "none";
            const textAreaDisabled =
              p.joinOnlyAction || isTagWithoutSecondary
              || (
                (p.draftHasRelationTarget && p.relationType === "correct")
                || (p.isMergeType && p.hasTargetsAvailable)
                || (p.isGovernanceOrOpsType && p.relationType === "proposal" && (p.secondaryRelationType === '分配收入' || p.secondaryRelationType === '终止结算'))
              );
            const placeholderText = p.joinOnlyAction ? "加入已有容器消息，此处不可输入"
              : isTagWithoutSecondary ? "请先在上方选择推荐或冷藏"
              : textAreaDisabled
              ? (p.draftHasRelationTarget && p.relationType === "correct" ? "关系消息不能作为更正目标，请选择普通文本消息" : p.isTagWithQuickAnnotate ? "已选择附加关系，此处不可输入" : p.isMergeType ? "归并关系为与会者-消息关系，此处不应输入内容" : p.isGovernanceOrOpsType && p.relationType === "proposal"
                ? (p.secondaryRelationType === '分配收入' ? "系统自动生成分配收入提案内容" : p.secondaryRelationType === '终止结算' ? "系统自动生成终止结算提案内容" : "输入提案内容（不能为空，支持 Markdown）")
                : "更正关系目标为关系消息时，此处不应有内容")
              : p.isClassifyType ? "输入分类名称（不能为空）"
              : p.isSummaryType ? "输入总结内容（不能为空）"
              : p.isArrangeType ? "可选：输入文本消息加入排列框架"
              : p.isGovernanceOrOpsType ? (p.relationType === "proposal"
                ? (p.secondaryRelationType === '分配收入' ? "系统自动生成分配提案内容" : p.secondaryRelationType === '终止结算' ? "系统自动生成终止结算提案内容" : "输入提案内容（不能为空，支持 Markdown）")
                : "输入运营公告内容（不能为空，支持 Markdown）")
              : "输入一条新文本消息（支持自由换行）";
            return (
              <textarea
                data-guide-message-input="true"
                style={{ width: "100%", minHeight: 80, maxHeight: 220, padding: 4, borderRadius: 4, border: "1px solid #555", background: textAreaDisabled ? "#1a1a1a" : "#222", color: textAreaDisabled ? "#666" : "#eee", fontSize: 13, resize: "vertical" }}
                placeholder={placeholderText}
                value={p.joinOnlyAction ? '' : p.newMessageContent}
                readOnly={textAreaDisabled}
                onChange={e => !textAreaDisabled && p.setNewMessageContent(e.target.value)}
              />
            );
          })()}
          {renderSendControls()}
          </div>
        </div>
      </>}

      {!p.comparisonReviewed && <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
        <div style={{ fontWeight: 600 }}>追溯</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{p.isInsideClassify ? "当前模式：分类" : "当前模式：追溯"}</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>当前追溯消息：{p.currentTraceIds ? p.currentTraceIds.join(", ") : "（无）"}</div>
      </div>}

      <RecentWorkbenchViews ownerKey={p.viewCacheOwner??p.scopeMessageId} viewKey={p.viewCacheKey??JSON.stringify(p.currentTraceIds)}>
        <MessageRelationsView scopeMessageId={p.scopeMessageId} traceIds={p.currentTraceIds ?? []} messages={p.messages} edges={p.edges} onNavigateToMessage={p.onNavigateToMessage} />
      </RecentWorkbenchViews>

      {!p.isViewerMode && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
          <div title="独立文本消息；带正文的回复、提案等仍属于关系消息。" style={{ fontWeight: 600, marginBottom: 4 }}>最近文本消息</div>
          <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, fontSize: 12, maxHeight: 200, overflow: "auto" }}>
            {p.recentTexts.map(m => <li key={m.id} style={{ marginBottom: 2, wordBreak: "break-all" }}>{m.id}：{m.content}</li>)}
          </ul>
        </div>
        <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
          <div title="包含回复、引用、赞同、分类、提案、加入、发起结算和结算结果等关系消息，可带正文。" style={{ fontWeight: 600, marginBottom: 4 }}>最近关系消息</div>
          <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, fontSize: 12, maxHeight: 200, overflow: "auto" }}>
            {p.recentRelations.map(m => {
              const notifyUsers = m.relationType === 'notify'
                ? (Array.isArray(m.relationPayload?.notifyUsers) && m.relationPayload.notifyUsers.length > 0
                  ? m.relationPayload.notifyUsers
                  : (m.relationPayload?.notifyUserIds ?? []).map(id => ({ id, username: `与会者 ${id}` })))
                : [];
              return (
                <li key={m.id} style={{ marginBottom: 2, wordBreak: "break-all" }}>
                  {`【${m.kind === 'round' ? '发起结算' : m.kind === 'round_result' ? '结算结果' : m.kind === 'join' ? '加入' : m.relationType ? getPresentationSpec(m.relationType).label : '关系消息'}】`}{m.id}：{m.content}
                  {notifyUsers.length > 0 && (
                    <span>（通知与会者：{notifyUsers.map((notifyUser, index) => (
                      <span key={notifyUser.id}>
                        {index > 0 && '、'}
                        <span onClick={() => navigate(`${messageScopePath(p.scopeMessageId)}?sender=${encodeURIComponent(notifyUser.username)}`)} style={{ color: '#a5f3fc', textDecoration: 'underline', cursor: 'pointer' }}>
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
      </div>}

      {!p.isViewerMode && <>
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
          <div style={{ marginTop: 8 }}><DeferredWorkbench label="表态历史"><StanceHistoryPanel userId={p.user.id} scopeMessageId={p.scopeMessageId} /></DeferredWorkbench></div>
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
          <div style={{ marginTop: 8 }}><DeferredWorkbench label="执行历史"><AuditLogView scopeMessageId={p.scopeMessageId} /></DeferredWorkbench></div>
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
          <div style={{ marginTop: 8 }}><DeferredWorkbench label="收入记录"><RevenuePanel /></DeferredWorkbench></div>
        )}
      </div>

      <OperationLogView />
      </>}

    </div>
    </WorkbenchScrollViewport>
  );
}
