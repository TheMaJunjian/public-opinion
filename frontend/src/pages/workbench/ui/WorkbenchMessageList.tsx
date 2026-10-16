import React, {useMemo, type ComponentProps, type ReactNode } from 'react';
import RelatedMessages from '../../../components/RelatedMessages';
import JoinRecordBadges from '../../../components/JoinRecordBadges';
import {indexRelatedMessages,isRejectedContainer} from '../../../utils/relatedMessages';
import { useNavigate } from 'react-router-dom';
import MessageCard, { type MessageCardContext, type MessageCardProps } from '../../../components/MessageCard';
import RoundHistory from '../../../components/RoundHistory';
import SettlementPanel from '../../../components/SettlementPanel';
import type { Relation } from '../../../types';
import { getOrganizationTitle } from '../../../utils/messageDisplay';
import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import { messageScopePath } from '../../../utils/messageRoutes';
import { type CorrectionVersion, type DemoEdge, type DemoMessage, isContentKind, type RelationType, type UnitSelection } from '../../../utils/modelBridge';
import { formatCorrectionRange } from '../model/correction';
import { collectOwnedByRelation } from '../model/ownership';

interface MessageCatalog {
  messages: DemoMessage[];
  edges: DemoEdge[];
  msgMap: Map<string, DemoMessage>;
  relationById: Map<string, Relation>;
  relationTypeByRelMsgId: Map<string, RelationType>;
  joinRelationsByTarget: Map<string, Relation[]>;
  joinRelationsBySource: Map<string, Relation[]>;
  effectiveJoinRelationIds: Set<string>;
  summaryCoverageByMessageId: Map<string, { summaryId: string; title: string }[]>;
  correctionVersions: Map<string, { current?: CorrectionVersion; versions: CorrectionVersion[] }>;
}
interface MessageDisplay {
  tagSourceIdsForList: Set<string>;
  suppressedRelIds: Set<string>;
  rejectedContainerIds: Set<string>;
  overriddenStanceRelIds: Set<string>;
  readStatusByMessageId: Map<string, 'READ' | 'UNREAD'>;
  homeMatchIds?: Set<string>;
  homeDisplayRoleByMessageId: Map<string, 'source' | 'target' | 'source-target'>;
  authorStakes: Record<string, number>;
  stakeCounts: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>;
  correctionFilterTargetId: string | null;
  joinFilterTargetId: string | null;
}
interface ListComparison {
  comparisonReviewed: boolean;
  comparisonTargetId: string | null;
  comparisonRecommendedDisplay: 'agree' | 'disagree';
  activeStanceByRelMsgId: Map<string, { targetRelId: string; type: 'agree' | 'disagree' }>;
  activeStanceMap: Map<string, { relMsgId: string; type: 'agree' | 'disagree' }>;
  stanceEffectByRelMsgId: Map<string, { local: boolean; global: boolean }>;
}
interface ListSettlement {
  settlementOpenMsgId: string | null;
  settlementOpenType: 'TRUTH' | 'VALUE' | null;
  settlementEntryHighlight: ComponentProps<typeof SettlementPanel>['entryHighlight'];
  closeSettlement: () => void;
  openSettlement: (messageId: string, type?: 'TRUTH' | 'VALUE') => void;
  onMessageCreated: ComponentProps<typeof SettlementPanel>['onMessageCreated'];
}
interface Props {
  visibleMessages: DemoMessage[];
  catalog: MessageCatalog;
  display: MessageDisplay;
  comparison: ListComparison;
  settlement: ListSettlement;
  selection: { draftUnits: UnitSelection[]; activeTextSelectId: string | null; lastClickedMessageId: string | null };
  cardHandlers: Pick<MessageCardProps, 'onClick' | 'onDoubleClick' | 'onMouseDown' | 'onMouseUp' | 'onContentMouseUp'>;
  scopeMessageId: string;
  onJoinFilter: (messageId: string, direction: 'incoming' | 'outgoing') => void;
  onRemoveMember?: (joinId: string) => void;
  onNavigate: (messageId: string) => void;
  onRelatedNavigate?:(messageId:string)=>void;
  standaloneMessageIds?:ReadonlySet<string>;
  onCorrectionNavigate: (messageId: string, switchToList: boolean) => void;
  renderRelation: (message: DemoMessage) => ReactNode;
  renderContent: (message: DemoMessage) => ReactNode;
}

export default function WorkbenchMessageList(props: Props) {
  const navigate = useNavigate();
  const { visibleMessages: messagesToRenderFiltered, scopeMessageId, onJoinFilter, cardHandlers,
    onNavigate: handleNavigateToMessage, onCorrectionNavigate: handleNavigateFromCorrectionTemporaryCategory,
    renderRelation: renderRelationContentWithTargets, renderContent: renderMessageContentWithAnchorsForList } = props;
  const { messages, edges, msgMap, relationById, relationTypeByRelMsgId, joinRelationsByTarget, joinRelationsBySource, effectiveJoinRelationIds, summaryCoverageByMessageId, correctionVersions } = props.catalog;
  const { tagSourceIdsForList, suppressedRelIds, rejectedContainerIds, overriddenStanceRelIds, readStatusByMessageId, homeMatchIds, homeDisplayRoleByMessageId, authorStakes, stakeCounts, correctionFilterTargetId } = props.display;
  const { comparisonReviewed, comparisonTargetId, comparisonRecommendedDisplay, activeStanceByRelMsgId, activeStanceMap, stanceEffectByRelMsgId } = props.comparison;
  const { draftUnits, activeTextSelectId, lastClickedMessageId } = props.selection;
  const relatedByTarget=useMemo(()=>indexRelatedMessages(messages,rejectedContainerIds),[messages,rejectedContainerIds]);
  const { settlementOpenMsgId, settlementOpenType, settlementEntryHighlight, closeSettlement, openSettlement, onMessageCreated } = props.settlement;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {messagesToRenderFiltered
        .filter(msg => !tagSourceIdsForList.has(msg.id))
        .filter(msg=>!isRejectedContainer(msg,rejectedContainerIds)||props.standaloneMessageIds?.has(msg.id))
        .map(msg => {
          const isWholeSelected = draftUnits.some(u => isWholeMessageSelection(u, msg.id));
          const isActiveText = activeTextSelectId === msg.id;
          const relType = msg.kind === "relation" ? relationTypeByRelMsgId.get(msg.id) : null;
          const isClassification = relType === "classify";
          const isSummary = relType === "summary";
          const isMerge = relType === "merge";
          const isOrganizationMessage = isClassification || isSummary || isMerge;
          const govKind = msg.backendKind;
          const isGovernanceMsg = !isOrganizationMessage && msg.kind !== "relation" && (govKind === "GOVERNANCE" || govKind === "CODE" || govKind === "OPERATIONS");
          const governanceColor = govKind === "GOVERNANCE" ? "#f59e0b" : govKind === "CODE" ? "#3b82f6" : "#10b981";
          const memberCount = isOrganizationMessage
            ? collectOwnedByRelation(msg.id, relationById).textIds.size
            : 0;
          const organizationTitle = isOrganizationMessage ? getOrganizationTitle(msg, memberCount) : "";
          const summaryCoverages = summaryCoverageByMessageId.get(msg.id) ?? [];
          const settleTargetId = msg.settlementTargetId;
          const targetMsg = settleTargetId ? msgMap.get(settleTargetId) : undefined;
          const relatedJoinRelations = joinRelationsByTarget.get(msg.id) ?? [];
          const outgoingJoinRelations = joinRelationsBySource.get(msg.id) ?? [];
          const joinRelation = msg.kind === 'join' ? relationById.get(msg.id) : undefined;
          const joinIsEffective = !!joinRelation && effectiveJoinRelationIds.has(joinRelation.id);
          const effectiveJoinCount = relatedJoinRelations.filter(join => effectiveJoinRelationIds.has(join.id)).length;
          const ctx: MessageCardContext = {
            isWholeSelected, isActiveText, isOrganizationMessage,
            isClassification: isClassification,
            isSummary: isSummary,
            isMerge: isMerge,
            isGovernanceMsg,
            governanceColor,
            organizationTitle,
            memberCount,
            relType,
            settlementTargetId: settleTargetId,
            settlementTargetContent: targetMsg?.content ?? '',
            isValueSettlement: msg.roundPayload?.settlementType === 'VALUE',
            lastClickedMsgId: lastClickedMessageId,
            readStatus: readStatusByMessageId.get(msg.id),
            homeMatch: homeMatchIds?.has(msg.id),
            homeContextRole: homeDisplayRoleByMessageId.get(msg.id),
          };
          const sc = stakeCounts[msg.id];
          const truthPro = sc?.truth.pro ?? 0;
          const truthCon = sc?.truth.con ?? 0;
          const valuePro = sc?.value.pro ?? 0;
          const valueCon = sc?.value.con ?? 0;
          const showTruthProCon = truthPro > 0 || truthCon > 0;
          const showValueProCon = valuePro > 0 || valueCon > 0;
          const isTruthOpen = settlementOpenMsgId === msg.id && settlementOpenType === 'TRUTH';
          const isValueOpen = settlementOpenMsgId === msg.id && settlementOpenType === 'VALUE';
          const hasCustomContent = isContentKind(msg.kind) && msg.kind !== 'round' && msg.kind !== 'round_result';
          const correctionTargetEdge = msg.relationType === 'correct'
            ? edges.find(edge => edge.relationMessageId === msg.id)
            : undefined;
          const correctionTarget = correctionTargetEdge ? msgMap.get(correctionTargetEdge.to.messageId) : undefined;
          const correctionTargetOriginal = correctionTarget
            ? messages.find(message => message.id === correctionTarget.id) ?? correctionTarget
            : undefined;
          const correctionSourceEdge = correctionTargetEdge && !correctionTargetEdge.from.messageId.startsWith('anon:')
            ? correctionTargetEdge
            : undefined;
          const correctionSource = correctionSourceEdge ? msgMap.get(correctionSourceEdge.from.messageId) : undefined;
          const correctionContent = msg.relationPayload?.correctionContent ?? correctionSource?.content ?? msg.content;
          const correctionTargetText = correctionTargetEdge?.to.selection.kind === 'text'
            ? correctionTargetEdge.to.selection.text
            : correctionTargetOriginal?.content ?? '';
          const correctionTargetLabel = correctionTargetEdge?.to.selection.kind === 'text'
            ? formatCorrectionRange(correctionTargetEdge.to.selection.start, correctionTargetEdge.to.selection.len, correctionTargetText)
            : formatCorrectionRange(0, correctionTargetText.length, correctionTargetText);
          const correctionReplacement = correctionTargetEdge?.to.selection.kind === 'text' && correctionTargetOriginal
            ? (() => {
              const selection = correctionTargetEdge.to.selection;
              const suffixLength = correctionTargetOriginal.content.length - selection.start - selection.len;
              const replacementEnd = correctionContent.length - suffixLength;
              return selection.start >= 0 && selection.len >= 0 && suffixLength >= 0 &&
                replacementEnd >= selection.start && replacementEnd <= correctionContent.length
                ? correctionContent.slice(selection.start, replacementEnd)
                : correctionContent;
            })()
            : correctionContent;
          const activeStanceInfo = activeStanceByRelMsgId.get(msg.id);
          const stanceEffect = stanceEffectByRelMsgId.get(msg.id);
          const activeTargetStanceInfo = activeStanceMap.get(msg.id);
          const isCurrentComparisonTarget = comparisonReviewed && comparisonTargetId === msg.id;
          const recommendationMatchesUser = isCurrentComparisonTarget && activeTargetStanceInfo
            ? activeTargetStanceInfo.type === comparisonRecommendedDisplay
            : null;

          const correctionRecords = msg.relationType !== 'correct'
            ? edges.filter(edge => edge.relationType === 'correct' && edge.to.messageId === msg.id)
            : [];
          const correctionVersion = msg.relationType === 'correct'
            ? Array.from(correctionVersions.values())
              .flatMap(entry => entry.versions)
              .find(version => version.correctionId === msg.id)
            : undefined;

          return (
            <MessageCard
              relatedMessages={<RelatedMessages rows={relatedByTarget.get(msg.id)} selectedUnits={draftUnits} onNavigate={props.onRelatedNavigate??handleNavigateToMessage}/>}
              selectedUnits={draftUnits}
              key={msg.id} msg={msg} ctx={ctx}
              onClick={cardHandlers.onClick}
              onDoubleClick={cardHandlers.onDoubleClick}
              onMouseDown={cardHandlers.onMouseDown}
              onMouseUp={cardHandlers.onMouseUp}
              onContentMouseUp={cardHandlers.onContentMouseUp}
              headerBetweenIdAuthor={stanceEffect || (isCurrentComparisonTarget && activeTargetStanceInfo) ? (
                <>
                  {stanceEffect && (
                    <>
                      <span style={{ color: stanceEffect.local ? '#86efac' : '#fca5a5', fontWeight: 600 }}>
                        {stanceEffect.local ? '本地生效' : '本地未生效'}
                      </span>
                      <span style={{ color: stanceEffect.global ? '#86efac' : '#fca5a5', fontWeight: 600 }}>
                        {stanceEffect.global ? '对其他用户生效' : '对其他用户未生效'}
                      </span>
                    </>
                  )}
                  {activeStanceInfo && activeStanceInfo.targetRelId === comparisonTargetId && comparisonReviewed && (
                    <span style={{ color: recommendationMatchesUser ? '#86efac' : '#fbbf24', fontWeight: 600 }}>
                      当前推荐显示：{comparisonRecommendedDisplay === 'disagree' ? '反对' : '赞同'} · {recommendationMatchesUser ? '与你相同' : '与你不同'}
                    </span>
                  )}
                  {!activeStanceInfo && isCurrentComparisonTarget && activeTargetStanceInfo && (
                    <span style={{ color: recommendationMatchesUser ? '#86efac' : '#fbbf24', fontWeight: 600 }}>
                      当前推荐显示：{comparisonRecommendedDisplay === 'disagree' ? '反对' : '赞同'} · {recommendationMatchesUser ? '与你相同' : '与你不同'}
                    </span>
                  )}
                </>
              ) : undefined}
              headerLabel={msg.kind === 'join' ? (
                <span style={{ color: '#93c5fd', fontFamily: 'monospace', fontWeight: 600 }}>{msg.id}</span>
              ) : correctionFilterTargetId !== null && msg.relationType === 'correct' ? (
                <span style={{ color: '#fbbf24', fontWeight: 600 }}>
                  <span
                    role="link"
                    tabIndex={0}
                    onClick={event => { event.stopPropagation(); handleNavigateFromCorrectionTemporaryCategory(msg.id, true); }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        handleNavigateFromCorrectionTemporaryCategory(msg.id, true);
                      }
                    }}
                    style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                    title={`跳转到更正消息 ${msg.id}`}
                  >
                    {msg.id}
                  </span>
                  <span style={{
                    marginLeft: 5,
                    color: correctionVersion?.valid && !correctionVersion.conflicted ? '#4ade80' : '#f87171',
                    textDecoration: 'none',
                  }}>
                    {correctionVersion?.valid && !correctionVersion.conflicted ? '（生效）' : '（未生效）'}
                  </span>
                </span>
              ) : undefined}
              headerAfterAuthor={correctionRecords.length > 0 && correctionVersions.get(msg.id)?.current ? (
                <span style={{ color: '#fbbf24', fontWeight: 600 }} title="此消息已被更正">已被更正</span>
              ) : undefined}
              onSettlementTargetClick={(e, id) => { e.stopPropagation(); handleNavigateToMessage(id); }}
              headerExtra={
                <>
                  <div style={{ fontSize: 10, color: "#6b7280", textAlign: "right", width: "100%" }}>自押 PRO {authorStakes[msg.id] ?? 0} 点</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 1, minWidth: 0, width: "100%", gap: 8, flexWrap: "nowrap", whiteSpace: "nowrap", overflow: "hidden" }}>
                    <div style={{ display: "flex", gap: 4, alignItems: "center", minWidth: 0, overflow: "hidden" }}>
                      <JoinRecordBadges messageId={msg.id} memberRecords={relatedJoinRelations} containerRecords={outgoingJoinRelations}
                        isContainer={isOrganizationMessage} isEffective={join => effectiveJoinRelationIds.has(join.id)} onOpen={onJoinFilter}/>
                      {effectiveJoinCount === 1 && props.onRemoveMember && (
                        <button
                          onClick={event => { event.stopPropagation(); props.onRemoveMember?.(relatedJoinRelations.find(join => effectiveJoinRelationIds.has(join.id))!.id); }}
                          title="选择反对此次加入；发送后恢复到此前仍有效的归属"
                          style={{ flexShrink: 0, fontSize: 10, padding: '1px 6px', borderRadius: 4, border: '1px solid #7f1d1d', background: '#451a1a', color: '#fca5a5', cursor: 'pointer' }}
                        >移出容器</button>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                      <button data-settlement-toggle-truth onClick={(event) => { event.stopPropagation(); if (isTruthOpen) { closeSettlement(); } else { openSettlement(msg.id, 'TRUTH'); } }} style={{ flexShrink: 0, fontSize: 13, cursor: "pointer", background: isTruthOpen ? "rgba(99,102,241,0.2)" : "none", border: isTruthOpen ? "1px solid #6366f1" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: isTruthOpen ? "#a5b4fc" : "#6b7280" }} title="真假仲裁">⚖️</button>
                      <button data-settlement-toggle-value onClick={(event) => { event.stopPropagation(); if (isValueOpen) { closeSettlement(); } else { openSettlement(msg.id, 'VALUE'); } }} style={{ flexShrink: 0, fontSize: 13, cursor: "pointer", background: isValueOpen ? "rgba(245,158,11,0.2)" : "none", border: isValueOpen ? "1px solid #f59e0b" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: isValueOpen ? "#fcd34d" : "#6b7280" }} title="价值仲裁">💎</button>
                      {showTruthProCon && (
                        <span style={{ color: "#a5b4fc" }} title="真假仲裁">
                          ⚖️{truthPro > 0 && <span style={{ color: "#4ade80" }}>👍{truthPro}</span>}
                          {truthPro > 0 && truthCon > 0 && ' '}
                          {truthCon > 0 && <span style={{ color: "#f87171" }}>👎{truthCon}</span>}
                        </span>
                      )}
                      {showValueProCon && (
                        <span style={{ color: "#fcd34d" }} title="价值仲裁">
                          💎{valuePro > 0 && <span style={{ color: "#4ade80" }}>👍{valuePro}</span>}
                          {valuePro > 0 && valueCon > 0 && ' '}
                          {valueCon > 0 && <span style={{ color: "#f87171" }}>👎{valueCon}</span>}
                        </span>
                      )}
                    </div>
                  </div>
                </>
              }
              badges={
                <>
                  {msg.kind === "join" && joinRelation && (
                    <div style={{ marginBottom: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(34,197,94,0.15)", color: "#86efac", border: "1px solid rgba(34,197,94,0.3)" }}>
                        {joinIsEffective ? '生效' : '未生效'}
                      </span>
                    </div>
                  )}
                  {!isOrganizationMessage && msg.kind === "relation" && (relType === 'notify' || suppressedRelIds.has(msg.id) || rejectedContainerIds.has(msg.id) || overriddenStanceRelIds.has(msg.id)) && (
                    <div style={{ marginBottom: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {relType === 'notify' && (() => {
                        const payload = msg.relationPayload;
                        const notifyUsers = Array.isArray(payload?.notifyUsers) && payload.notifyUsers.length > 0
                          ? payload.notifyUsers
                          : (payload?.notifyUserIds ?? []).map(id => ({ id, username: id }));
                        return notifyUsers.length > 0 ? (
                          <span
                            title="通知关系标签"
                            style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(59,130,246,0.18)", color: "#93c5fd", border: "1px solid rgba(59,130,246,0.45)", display: "inline-flex", alignItems: "center", gap: 3 }}
                          >
                            {notifyUsers.map((notifyUser, index) => (
                              <React.Fragment key={notifyUser.id}>
                                {index > 0 && '、'}
                                <span
                                  role="link"
                                  tabIndex={0}
                                  onClick={(event) => { event.stopPropagation(); navigate(`${messageScopePath(scopeMessageId)}?sender=${encodeURIComponent(notifyUser.username)}`); }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      navigate(`${messageScopePath(scopeMessageId)}?sender=${encodeURIComponent(notifyUser.username)}`);
                                    }
                                  }}
                                  style={{ color: "#bfdbfe", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2, fontFamily: "monospace" }}
                                  title={`在清爽视图中查看 ${notifyUser.username} 的消息`}
                                >
                                  {notifyUser.id}
                                </span>
                              </React.Fragment>
                            ))}
                            <span>：通知</span>
                          </span>
                        ) : null;
                      })()}
                      {suppressedRelIds.has(msg.id) && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(239,68,68,0.2)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.35)" }}>你已反对 · 点赞同恢复</span>}
                      {rejectedContainerIds.has(msg.id) && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }} title="社区反对多于赞同，该分类已暂时解散">社区已反对 · 双击预览</span>}
                      {overriddenStanceRelIds.has(msg.id) && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.04)", color: "#6b7280", border: "1px solid rgba(255,255,255,0.1)" }}>已失效</span>}
                    </div>
                  )}
                  {summaryCoverages.length > 0 && (
                    <div style={{ marginBottom: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {summaryCoverages.map(item => <span key={item.summaryId} style={{ minWidth: 0, maxWidth: "100%", fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(245,158,11,0.14)", color: "#fcd34d", border: "1px solid rgba(245,158,11,0.28)", overflowWrap: 'anywhere' }}>非线性视图由总结「{item.title}」覆盖</span>)}
                    </div>
                  )}
                </>
              }
              overlays={settlementOpenMsgId === msg.id ? (
                <div data-settlement-panel style={{ position: "absolute", right: 0, top: "100%", zIndex: 100, width: 360, marginTop: 4 }}>
                  <SettlementPanel messageId={msg.id} scopeMessageId={scopeMessageId!} highlightRoundId={sessionStorage.getItem('settlementHighlightRound')} entryHighlight={settlementEntryHighlight} onMessageCreated={onMessageCreated} filterSettlementType={settlementOpenType ?? undefined} />
                  <div style={{ marginTop: 4 }}><RoundHistory messageId={msg.id} compact /></div>
                </div>
              ) : undefined}
            >
              {msg.kind === 'join' ? (
                <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.7, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span>目标 ID：</span>
                  {(msg.joinInfo?.targetIds ?? []).length > 0 ? msg.joinInfo!.targetIds.map(targetId => (
                    <button
                      key={targetId}
                      type="button"
                      onClick={event => { event.stopPropagation(); handleNavigateToMessage(targetId); }}
                      style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(59,130,246,0.45)', background: 'rgba(59,130,246,0.16)', color: '#93c5fd', cursor: 'pointer', fontFamily: 'monospace' }}
                      title={`跳转到目标消息 ${targetId}`}
                    >{targetId}</button>
                  )) : <span>无</span>}
                  <span>容器 ID：</span>
                  {msg.joinInfo?.containerId ? (
                    <button
                      type="button"
                      onClick={event => { event.stopPropagation(); handleNavigateToMessage(msg.joinInfo!.containerId); }}
                      style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(16,185,129,0.45)', background: 'rgba(16,185,129,0.16)', color: '#a7f3d0', cursor: 'pointer', fontFamily: 'monospace' }}
                      title={`跳转到容器消息 ${msg.joinInfo.containerId}`}
                    >{msg.joinInfo.containerId}</button>
                  ) : <span>无</span>}
                </div>
              ) : msg.relationType === 'correct' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, color: '#fbbf24' }}>
                    ✏ {msg.author} 更正了消息
                    {correctionTarget && (
                      <button
                        type="button"
                        onClick={event => { event.stopPropagation(); handleNavigateFromCorrectionTemporaryCategory(correctionTarget.id, false); }}
                        style={{ marginLeft: 6, padding: '2px 7px', borderRadius: 999, border: '1px solid rgba(96,165,250,0.5)', background: 'rgba(59,130,246,0.16)', color: '#93c5fd', cursor: 'pointer', fontSize: 11 }}
                        title={`跳转到目标消息 ${correctionTarget.id}`}
                      >
                        目标消息 · {correctionTarget.id}
                      </button>
                    )}
                  </div>
                  <div style={{ borderLeft: '3px solid #0d9488', background: 'rgba(13,148,136,0.12)', padding: '6px 8px' }}>
                    <div style={{ fontSize: 11, color: '#5eead4', marginBottom: 3 }}>具体更改</div>
                    <div style={{ whiteSpace: 'pre-wrap', color: '#fca5a5' }}>
                      {correctionContent.length === 0
                        ? `删除${correctionTargetLabel}`
                        : `将${correctionTargetLabel}修改为「${correctionReplacement}」`}
                    </div>
                  </div>
                </div>
              ) : msg.kind === 'relation' ? renderRelationContentWithTargets(msg)
                : hasCustomContent ? renderMessageContentWithAnchorsForList(msg) : undefined}
            </MessageCard>
          );
        })}
    </div>

  );
}
