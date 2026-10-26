import React, {useMemo, type ComponentProps, type ReactNode } from 'react';
import RelatedMessages from '../../../components/RelatedMessages';
import CrossCanvasRelatedMessages from '../../../components/CrossCanvasRelatedMessages';
import type { CrossCanvasRelationGroups } from '../../../utils/crossCanvasRelations';
import JoinRecordBadges from '../../../components/JoinRecordBadges';
import {indexRelatedMessages,isRejectedContainer} from '../../../utils/relatedMessages';
import { useNavigate } from 'react-router-dom';
import MessageCard, { type MessageCardContext, type MessageCardProps } from '../../../components/MessageCard';
import MessageSettlementActions from '../../../components/MessageSettlementActions';
import MessageAuthors from '../../../components/MessageAuthors';
import {deriveMessageAuthorship} from '../../../utils/messageAuthorship';
import { MessageDisplayMarker } from '../../../components/MessageDisplayHints';
import RoundHistory from '../../../components/RoundHistory';
import SettlementPanel from '../../../components/SettlementPanel';
import type { Relation } from '../../../types';
import { getOrganizationTitle } from '../../../utils/messageDisplay';
import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import { messageScopePath } from '../../../utils/messageRoutes';
import { type CorrectionVersion, type DemoEdge, type DemoMessage, isCardMessage, isContentKind, type RelationType, type UnitSelection } from '../../../utils/modelBridge';
import { collectOwnedByRelation } from '../model/ownership';
import { getJoinStatusPresentation, type JoinStatus } from '../model/membership';
import type { JoinEffectSource } from '../model/joinDisplay';
import type { ContainerEffect } from '../model/containerEffect';
import { filterMessageListContext } from '../projections/messageListContext';
import VirtualMessageList from '../../../components/VirtualMessageList';
import { renderSettlementContentWithTarget } from '../actions/messageRendering';
import {groupContainerJoinRecords,JOIN_TARGET_LOCATION_LABELS} from '../model/joinRecordGroups';

interface MessageCatalog {
  messages: DemoMessage[];
  edges: DemoEdge[];
  msgMap: Map<string, DemoMessage>;
  relationById: Map<string, Relation>;
  relationTypeByRelMsgId: Map<string, RelationType>;
  joinRelationsByTarget: Map<string, Relation[]>;
  joinRelationsBySource: Map<string, Relation[]>;
  effectiveJoinRelationIds: Set<string>;
  joinStatusByMessage?: ReadonlyMap<string, JoinStatus>;
  joinEffectSourcesByMessage?: ReadonlyMap<string, ReadonlySet<JoinEffectSource>>;
  containerOwnership?: ContainerEffect['ownership'];
  summaryCoverageByMessageId: Map<string, { summaryId: string; title: string }[]>;
  correctionVersions: Map<string, { current?: CorrectionVersion; versions: CorrectionVersion[] }>;
}
interface MessageDisplay {
  embeddedMessageIds: Set<string>;
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
  joinRecordContext?:{containerId:string;effect:ContainerEffect};
  onJoinFilter: (messageId: string, direction: 'incoming' | 'outgoing') => void;
  onNavigate: (messageId: string) => void;
  onRelatedNavigate?:(messageId:string)=>void;
  crossCanvasRelations?:Map<string,CrossCanvasRelationGroups>;
  onRelatedRelationView?:(messageId:string)=>void;
  standaloneMessageIds?:ReadonlySet<string>;
  onCorrectionNavigate: (messageId: string, switchToList: boolean) => void;
  onCorrectionHistory?: (event:React.MouseEvent,messageId:string)=>void;
  renderRelation: (message: DemoMessage) => ReactNode;
  renderContent: (message: DemoMessage) => ReactNode;
}

export default function WorkbenchMessageList(props: Props) {
  const navigate = useNavigate();
  const { visibleMessages: messagesToRenderFiltered, scopeMessageId, onJoinFilter, cardHandlers,
    onNavigate: handleNavigateToMessage, onCorrectionNavigate: handleNavigateFromCorrectionTemporaryCategory,
    renderRelation: renderRelationContentWithTargets, renderContent: renderMessageContentWithAnchorsForList } = props;
  const { messages, edges, msgMap, relationById, relationTypeByRelMsgId, joinRelationsByTarget, joinRelationsBySource, effectiveJoinRelationIds, summaryCoverageByMessageId, correctionVersions } = props.catalog;
  const { embeddedMessageIds, suppressedRelIds, rejectedContainerIds, overriddenStanceRelIds, readStatusByMessageId, homeMatchIds, homeDisplayRoleByMessageId, authorStakes, stakeCounts, correctionFilterTargetId } = props.display;
  const { comparisonReviewed, comparisonTargetId, comparisonRecommendedDisplay, activeStanceByRelMsgId, activeStanceMap } = props.comparison;
  const { draftUnits, activeTextSelectId, lastClickedMessageId } = props.selection;
  const relatedByTarget=useMemo(()=>indexRelatedMessages(messages,rejectedContainerIds),[messages,rejectedContainerIds]);
  const standaloneMessageIds = props.standaloneMessageIds;
  const listMessages = useMemo(() => filterMessageListContext(
    messagesToRenderFiltered
      .filter(msg => !embeddedMessageIds.has(msg.id))
      .filter(msg => !isRejectedContainer(msg,rejectedContainerIds) || standaloneMessageIds?.has(msg.id)),
    messages, edges, standaloneMessageIds,
  ), [messagesToRenderFiltered, messages, edges, embeddedMessageIds, rejectedContainerIds, standaloneMessageIds]);
  const { settlementOpenMsgId, settlementOpenType, settlementEntryHighlight, closeSettlement, openSettlement, onMessageCreated } = props.settlement;
  const rowIds = useMemo(() => listMessages.map(message => message.id), [listMessages]);
  const rowMap = useMemo(() => new Map(listMessages.map(message => [message.id, message])), [listMessages]);
  const joinGroups=useMemo(()=>props.joinRecordContext?groupContainerJoinRecords(props.joinRecordContext.containerId,
    rowIds.flatMap(id=>{const record=relationById.get(id);return record?[record]:[];}),props.joinRecordContext.effect):undefined,
  [props.joinRecordContext,rowIds,relationById]);
  const joinEntries=useMemo(()=>new Map([...(joinGroups?.adopted??[]),...(joinGroups?.unadopted??[])].map(entry=>[entry.id,entry])),[joinGroups]);
  const pins = useMemo(() => new Set([lastClickedMessageId, activeTextSelectId, settlementOpenMsgId].filter((id): id is string => !!id)),
    [lastClickedMessageId, activeTextSelectId, settlementOpenMsgId]);
  const renderMessage=(id:string)=>{
          const msg = rowMap.get(id)!;
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
            ? (props.catalog.containerOwnership?.owned(msg.id)??collectOwnedByRelation(msg.id, relationById)).textIds.size
            : 0;
          const organizationTitle = isOrganizationMessage ? getOrganizationTitle(msg, memberCount) : "";
          const summaryCoverages = summaryCoverageByMessageId.get(msg.id) ?? [];
          const settleTargetId = msg.settlementTargetId;
          const targetMsg = settleTargetId ? msgMap.get(settleTargetId) : undefined;
          const relatedJoinRelations = joinRelationsByTarget.get(msg.id) ?? [];
          const outgoingJoinRelations = joinRelationsBySource.get(msg.id) ?? [];
          const joinRelation = msg.kind === 'join' ? relationById.get(msg.id) : undefined;
          const joinIsEffective = !!joinRelation && effectiveJoinRelationIds.has(joinRelation.id);
          const joinStatus = props.catalog.joinStatusByMessage?.get(msg.id) ?? (joinIsEffective ? 'valid' : 'inactive');
          const joinPresentation = getJoinStatusPresentation(joinStatus, props.catalog.joinEffectSourcesByMessage?.get(msg.id));
          const joinEntry=joinEntries.get(msg.id);
          const ctx: MessageCardContext = {
            isRelationRecord: msg.kind === 'join' || msg.kind === 'round' || msg.kind === 'round_result' || (msg.kind === 'relation' && !isCardMessage(msg)),
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
          const correctionContent = msg.relationPayload?.correctionAfterContent ?? msg.relationPayload?.correctionContent ?? correctionSource?.content ?? msg.content;
          const correctionBefore = msg.relationPayload?.correctionBeforeContent ?? correctionTargetOriginal?.content ?? '';
          const correctionSelection = correctionTargetEdge?.to.selection;
          const correctionPart = correctionTargetOriginal?.parts?.find(part => part.id === correctionTargetEdge?.to.reference?.partId);
          const correctionField = correctionPart?.type === 'text' ? correctionPart.text : correctionPart?.type === 'code' ? correctionPart.source
            : correctionPart?.type === 'web' ? correctionPart.excerpt || correctionPart.url : correctionBefore;
          const correctionTargetText = correctionSelection?.kind === 'text'
            ? correctionSelection.text || correctionField.slice(correctionSelection.start, correctionSelection.start + correctionSelection.len)
            : correctionField;
          const correctionRange = correctionSelection?.kind === 'text' ? correctionSelection : { start: 0, len: correctionTargetText.length };
          const correctionTargetLabel = correctionTargetText ? `「${correctionTargetText}」` : '所选内容';
          const correctionReplacement = (() => {
            if (typeof msg.relationPayload?.correctionValue === 'string') return msg.relationPayload.correctionValue;
            if (correctionSelection?.kind !== 'text') return correctionContent;
            let start = correctionSelection.start;
            if (correctionPart) for (const part of correctionTargetOriginal?.parts ?? []) {
              if (part.id === correctionPart.id) break;
              if (part.type === 'text' || part.type === 'code' || part.type === 'web')
                start += (part.type === 'text' ? part.text : part.type === 'code' ? part.source : part.excerpt || part.url).length + 1;
            }
            const end = start + correctionSelection.len;
            const prefix = correctionBefore.slice(0, start), suffix = correctionBefore.slice(end);
            return start >= 0 && end <= correctionBefore.length && correctionContent.length >= prefix.length + suffix.length
              && correctionContent.startsWith(prefix) && correctionContent.endsWith(suffix)
              ? correctionContent.slice(start, correctionContent.length - suffix.length)
              : msg.relationPayload?.correctionContent ?? correctionContent;
          })();
          const activeStanceInfo = activeStanceByRelMsgId.get(msg.id);
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
              relatedMessages={<><RelatedMessages rows={relatedByTarget.get(msg.id)} selectedUnits={draftUnits} onNavigate={props.onRelatedNavigate??handleNavigateToMessage}/>
                <CrossCanvasRelatedMessages groups={props.crossCanvasRelations?.get(msg.id)} messages={msgMap} selectedUnits={draftUnits} onView={props.onRelatedRelationView??handleNavigateToMessage}/></>}
              selectedUnits={draftUnits}
              key={msg.id} msg={msg} ctx={ctx}
              onClick={cardHandlers.onClick}
              onDoubleClick={cardHandlers.onDoubleClick}
              onMouseDown={cardHandlers.onMouseDown}
              onMouseUp={cardHandlers.onMouseUp}
              onContentMouseUp={cardHandlers.onContentMouseUp}
              headerBetweenIdAuthor={
                <>
                  {activeStanceInfo && activeStanceInfo.targetRelId === comparisonTargetId && comparisonReviewed && (
                    <span style={{ color: recommendationMatchesUser ? '#86efac' : '#fbbf24', fontWeight: 600 }}>
                      当前统计结果：{comparisonRecommendedDisplay === 'disagree' ? '反对' : '赞同'} · {recommendationMatchesUser ? '与你相同' : '与你不同'}
                    </span>
                  )}
                  {!activeStanceInfo && isCurrentComparisonTarget && activeTargetStanceInfo && (
                    <span style={{ color: recommendationMatchesUser ? '#86efac' : '#fbbf24', fontWeight: 600 }}>
                      当前统计结果：{comparisonRecommendedDisplay === 'disagree' ? '反对' : '赞同'} · {recommendationMatchesUser ? '与你相同' : '与你不同'}
                    </span>
                  )}
                  <JoinRecordBadges messageId={msg.id} memberRecords={relatedJoinRelations} containerRecords={outgoingJoinRelations}
                    isContainer={isOrganizationMessage} isEffective={join => effectiveJoinRelationIds.has(join.id)} onOpen={onJoinFilter} compact />
                </>
              }
              headerAuthor={<MessageAuthors message={msg} prefix="作者：" showSelfStake stakePlacement="inline" authorship={deriveMessageAuthorship(msg,correctionVersions.get(msg.id),msgMap,authorStakes[msg.id]??0)}/>}
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
                  <MessageDisplayMarker messageId={msg.id} viewTag />
                  <span style={{
                    marginLeft: 5,
                    color: correctionVersion?.valid && !correctionVersion.conflicted ? '#4ade80' : '#f87171',
                    textDecoration: 'none',
                  }}>
                    {correctionVersion?.valid && !correctionVersion.conflicted ? '（有效）' : '（无效）'}
                  </span>
                </span>
              ) : undefined}
              headerAfterAuthor={correctionRecords.length > 0 ? (
                <span><span role="button" tabIndex={0} style={{ color: '#fbbf24', fontWeight: 600, cursor:'pointer' }} title="双击查看更正记录"
                  onClick={event=>event.stopPropagation()} onDoubleClick={event=>{event.stopPropagation();props.onCorrectionHistory?.(event,correctionRecords[0].relationMessageId);}}
                  onKeyDown={event=>{if(event.key==='Enter'){event.stopPropagation();props.onCorrectionHistory?.(event as unknown as React.MouseEvent,correctionRecords[0].relationMessageId);}}}>
                  ✏ {correctionRecords.length}
                </span></span>
              ) : undefined}
              headerLeading={correctionFilterTargetId!==null && msg.relationType==='correct'?<></>:undefined}
              onSettlementTargetClick={(e, id) => { e.stopPropagation(); handleNavigateToMessage(id); }}
              headerExtra={
                <>
                  <MessageSettlementActions messageId={msg.id} counts={sc} fontSize={11}
                    openMessageId={settlementOpenMsgId} openType={settlementOpenType}
                    onTruth={id => isTruthOpen ? closeSettlement() : openSettlement(id, 'TRUTH')}
                    onValue={id => isValueOpen ? closeSettlement() : openSettlement(id, 'VALUE')} />
                </>
              }
              badges={
                <>
                  {msg.kind === "join" && joinRelation && (
                    <div style={{ marginBottom: ctx.isRelationRecord ? 0 : 4, order: 1, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span title={joinPresentation.hint} style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: joinIsEffective ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.16)", color: joinIsEffective ? "#86efac" : "#fca5a5", border: `1px solid ${joinIsEffective ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.35)'}` }}>
                        {joinPresentation.label}
                      </span>
                    </div>
                  )}
                  {!isOrganizationMessage && msg.kind === "relation" && (relType === 'notify' || suppressedRelIds.has(msg.id) || rejectedContainerIds.has(msg.id) || overriddenStanceRelIds.has(msg.id)) && (
                    <div style={{ marginBottom: ctx.isRelationRecord ? 0 : 4, order: 1, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
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
                    <div style={{ marginBottom: ctx.isRelationRecord ? 0 : 6, order: 1, display: "flex", gap: 6, flexWrap: "wrap" }}>
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
                <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.7, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', order: 1, minWidth: 0 }}>
                  <span>目标 ID：</span>
                  {(msg.joinInfo?.targetIds ?? []).length > 0 ? msg.joinInfo!.targetIds.map(targetId => {
                    const target=joinEntry?.targets.find(target=>target.id===targetId);
                    return <span key={targetId} data-join-target={targetId} style={{display:'inline-flex',alignItems:'center',gap:4,maxWidth:'100%',flexWrap:'wrap',fontSize:12}}>
                    <button
                      type="button"
                      onClick={event => { event.stopPropagation(); handleNavigateToMessage(targetId); }}
                      style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(59,130,246,0.45)', background: 'rgba(59,130,246,0.16)', color: '#93c5fd', cursor: 'pointer', fontFamily: 'monospace' }}
                      title={`跳转到目标消息 ${targetId}`}
                    >{targetId}</button>
                    {target&&<span data-join-target-location={target.location} data-join-target-adopted={target.adopted?'true':'false'}
                      style={{fontSize:10,padding:'0 5px',borderRadius:3,background:target.location==='container'?'rgba(16,185,129,0.14)':target.location==='nested'?'rgba(59,130,246,0.14)':'rgba(148,163,184,0.12)',
                        color:target.location==='container'?'#a7f3d0':target.location==='nested'?'#bfdbfe':'#cbd5e1'}}>
                      {JOIN_TARGET_LOCATION_LABELS[target.location]}{joinEntry?.adopted&&!target.adopted?' · 此目标未采用':''}
                    </span>}
                    </span>;
                  }) : <span>无</span>}
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
                <div style={{ display: 'contents' }}>
                  <div style={{ fontSize: 12, color: '#fbbf24', order: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    目标：
                    {correctionTarget && (
                      <button
                        type="button"
                        onClick={event => { event.stopPropagation(); handleNavigateFromCorrectionTemporaryCategory(correctionTarget.id, false); }}
                        style={{ marginLeft: 6, padding: '2px 7px', borderRadius: 999, border: '1px solid rgba(96,165,250,0.5)', background: 'rgba(59,130,246,0.16)', color: '#93c5fd', cursor: 'pointer', fontSize: 11, maxWidth: '100%', overflowWrap: 'anywhere' }}
                        title={`跳转到目标消息 ${correctionTarget.id}`}
                      >
                        {correctionTarget.id}
                      </button>
                    )}
                  </div>
                  <div style={{ borderLeft: '3px solid #0d9488', background: 'rgba(13,148,136,0.12)', padding: '6px 8px', order: 3, flexBasis: '100%', minWidth: 0, fontSize: 12 }}>
                    {msg.relationPayload?.correctionKind === 'WIDTH' ? <div style={{color:'#5eead4'}}>宽度调整 · {msg.relationPayload.correctionWidth} px</div> : <>
                    <div style={{ fontSize: 11, color: '#5eead4', marginBottom: 3 }}>{'修正文字'} · start={correctionRange.start} len={correctionRange.len}</div>
                    <div style={{ whiteSpace: 'pre-wrap', color: '#fca5a5' }}>
                      {correctionReplacement.length === 0
                        ? `删除${correctionTargetLabel}`
                        : correctionTargetText.length === 0 ? `在所选位置插入「${correctionReplacement}」`
                          : `将${correctionTargetLabel}修改为「${correctionReplacement}」`}
                    </div>
                    </>}
                  </div>
                </div>
              ) : msg.kind === 'round' || msg.kind === 'round_result' ? renderSettlementContentWithTarget({ handleNavigateToMessage }, msg)
                : msg.kind === 'relation' ? renderRelationContentWithTargets(msg)
                : hasCustomContent ? renderMessageContentWithAnchorsForList(msg) : undefined}
            </MessageCard>
          );
        };
  if(joinGroups)return <div data-container-join-records={props.joinRecordContext!.containerId} style={{display:'grid',gap:16}}>
    {([{key:'adopted',label:'当前采用',entries:joinGroups.adopted},{key:'unadopted',label:'未采用',entries:joinGroups.unadopted}] as const).map(group=><section key={group.key}
      aria-label={`${group.label}的被加入记录`} data-join-record-group={group.key}>
      <h3 style={{fontSize:13,fontWeight:600,margin:'0 0 8px',padding:'5px 8px',borderLeft:`3px solid ${group.key==='adopted'?'#34d399':'#94a3b8'}`,color:group.key==='adopted'?'#a7f3d0':'#cbd5e1',background:'#1b2430'}}>{group.label}（{group.entries.length} 条）</h3>
      {group.entries.length?<VirtualMessageList ids={group.entries.map(entry=>entry.id)} pinned={pins}>{renderMessage}</VirtualMessageList>
        :<div style={{padding:'4px 8px',fontSize:12,color:'#94a3b8'}}>暂无{group.label}的被加入记录。</div>}
    </section>)}
  </div>;
  return <VirtualMessageList ids={rowIds} pinned={pins}>{renderMessage}</VirtualMessageList>;
}
