import { clearBrowserSelection, relationTypeName } from "../../../utils/graphTextSelection";
import type {
  UnitSelection
} from "../../../utils/modelBridge";
import { subTypeLabel } from '../model/relationComposition';
import { isCorrectableCorrectionTarget } from '../model/correction';
import { sendAuthorizationDraft, sendNotifyDraft, sendSelectedTagDraft, sendWrittenTagDraft } from './sendAnnotationDraft';
import { sendArrangeDraft } from './sendArrangementDraft';
import { sendClassificationDraft } from './sendClassificationDraft';
import { prepareAddressedCorrection, prepareCorrectionChain, prepareTextCorrection } from './sendCorrectionDraft';
import { sendDelegationDraft } from './sendDelegationDraft';
import type { DraftSendDependencies } from './sendDraftTypes';
import { sendGovernanceDraft } from './sendGovernanceDraft';
import { sendMergeDraft } from './sendMergeDraft';
import { sendOrganizationJoin } from './sendOrganizationJoin';
import { sendStanceDraft } from './sendStanceDraft';
import { sendSummaryDraft } from './sendSummaryDraft';
import { CARD_W } from '../../../utils/layout';
import { isCardWidth } from '../../../utils/cardWidth';
import { isWholeMessageSelection } from '../../../utils/messageElementSelection';



export async function handleQuickSendAndRelateFromDraftTargets(dependencies: DraftSendDependencies): Promise<void> {
  const { requireAuth, singleButtonEnabled, newMessageContent, savedTextOnTypeSwitchRef, draftUnits, targetUnits, setSendError, sourceUnits, resolveEffectiveTargetUnits, relationType, hasTextContent, stakeAmount, containerRelationTypes, appendContainerType, relStakeAmount, effectiveMinStake, subType, subTypeStakeMap, relationStakeMap, totalConsumption, availablePoints, handleSendMessageOnly, guideTargetIdRef, setNewMessageContent, getContainerMembershipTargetError, joinOnlyAction, getContainerCycleError, showAlert, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setSubType, setRelationType, setSecondaryRelationType, relationLabel, handleCreateRelationWithSourcesAndTargets, secondaryRelationType, msgMap, isGovernanceOrOpsType } = dependencies;
  if (!requireAuth()) return;
  if (!singleButtonEnabled) return;
  const text = newMessageContent.trim();
  // Clear saved text on type switch since user is sending/committing
  savedTextOnTypeSwitchRef.current = "";

  if (draftUnits.length > 0 && targetUnits.length > 0) {
    setSendError('候选区和目标集合不能同时有内容，请先将候选区移入目标集合或清空其中一方');
    return;
  }
  const sourceMessageIds = new Set(sourceUnits.map(unit => unit.messageId));
  if (draftUnits.some(unit => sourceMessageIds.has(unit.messageId)) || targetUnits.some(unit => sourceMessageIds.has(unit.messageId))) {
    setSendError('同一消息不能同时出现在来源集合和候选暂存区或目标集合中');
    return;
  }

  // Effective targets: candidates (draftUnits) if non-empty, else explicit target collection.
  const effectiveTargets = resolveEffectiveTargetUnits(draftUnits, targetUnits, relationType);
  // Validate both stakes — collect all errors
  const errors: string[] = [];
  if (totalConsumption?.contributionError) errors.push(totalConsumption.contributionError);
  if (totalConsumption?.hasText ?? hasTextContent) {
    if (typeof stakeAmount !== 'number') {
      errors.push('请输入真假投入');
    } else if (stakeAmount < 0) {
      errors.push(`真假投入不能为负数（当前 ${stakeAmount}）`);
    }
  }
  if (relationType) {
    const isContainerRelation = containerRelationTypes.has(relationType.toUpperCase());
    const hasSelectedSource = sourceUnits.length > 0;
    if (isContainerRelation && hasSelectedSource && !appendContainerType) {
      setSendError('加入消息的来源必须是当前关系类型对应的容器消息，目标消息来自当前选择');
      return;
    }
    if (!joinOnlyAction && !totalConsumption?.groups && typeof relStakeAmount !== 'number') {
      errors.push('请输入关系消息贡献点');
    }
    if (!joinOnlyAction && !totalConsumption?.groups && typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake) {
      const subTypeNote = (subType && subTypeStakeMap.current[subType] && subTypeStakeMap.current[subType] > (relationStakeMap.current[relationType.toUpperCase()] ?? 0))
        ? `（「${subTypeLabel(subType)}」理由要求最低 ${effectiveMinStake} 点）` : '';
      errors.push(`关系消息最低押注 ${effectiveMinStake} 点（当前 ${relStakeAmount}）${subTypeNote}`);
    }
    // Check total consumption (text stake + relation stakes × count + all burn fees) against available balance
    if (totalConsumption && totalConsumption.total > availablePoints) {
      const parts = [`真假 ${totalConsumption.stakeTotal}`, `价值 ${totalConsumption.recommendationTotal}`, `协议费 ${totalConsumption.protocolFeeTotal}`];
      if (totalConsumption.delegationRewardStake > 0) parts.push(`委托报酬 ${totalConsumption.delegationRewardStake}`);
      errors.push(`贡献点余额不足（可用 ${availablePoints}，总计需要 ${totalConsumption.total} 点 = ${parts.join(' + ')}）`);
    }
  }
  if (errors.length > 0) {
    setSendError(errors.join('；'));
    return;
  }
  setSendError(null);

  // With no relation selected, the composer sends a standalone text message.
  // CORRECT uses its own branch below and never creates a replacement text message.
  if (relationType === null) {
    if (text.length === 0) return;
    const sentMessage = await handleSendMessageOnly(text);
    if (sentMessage) {
      guideTargetIdRef.current = sentMessage.id;
      window.dispatchEvent(new CustomEvent('guide-text-message-sent', {
        detail: { messageId: sentMessage.id, title: sentMessage.content.slice(0, 40) },
      }));
    }
    setNewMessageContent("");
    return;
  }

  const isContainerRelation = ['classify', 'summary', 'merge', 'arrange'].includes(relationType);
  const membershipTargetError = isContainerRelation
    ? getContainerMembershipTargetError(effectiveTargets)
    : null;
  const containerCycleError = isContainerRelation && !joinOnlyAction
    ? getContainerCycleError(effectiveTargets)
    : null;
  if (containerCycleError) {
    showAlert(containerCycleError);
    return;
  }
  if (membershipTargetError) {
    showAlert(membershipTargetError);
    return;
  }

  // Adding targets to an existing container uses one JOIN per target.
  if (joinOnlyAction) {
    await sendOrganizationJoin(dependencies, { effectiveTargets });
    return;
  }

  // Scenario: source collection + target collection explicitly committed (no draft candidates).
  // Build the relation directly without creating a new text message.
  if (relationType !== "merge" && relationType !== "arrange" && draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0 && (relationType !== 'classify' || joinOnlyAction)) {
    const labelDefault = relationTypeName(relationType);
    const label = relationLabel.trim() || labelDefault;
    await handleCreateRelationWithSourcesAndTargets({ sources: sourceUnits, targets: targetUnits, label });
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
    setNewMessageContent(""); setSubType("");
    setRelationType(null); setSecondaryRelationType("none");
    return;
  }

  if (effectiveTargets.length === 0 && relationType !== "classify" && relationType !== "proposal" && relationType !== "code_change" && relationType !== "operations" && !(relationType === 'delegation' && secondaryRelationType === 'create')) return;
  const isAgreeDisagree = relationType === "agree" || relationType === "disagree";
  const isArrange = relationType === "arrange";


  if (relationType === "notify") {
    await sendNotifyDraft(dependencies, { text, effectiveTargets });
    return;
  }

  // TAG + secondary relation: create RECOMMEND/ARCHIVE or quick-annotate TAG with label from secondary
  if (relationType === "tag" && secondaryRelationType !== "none") {
    await sendSelectedTagDraft(dependencies, { effectiveTargets });
    return;
  }

  if (relationType === 'correct' && secondaryRelationType === 'width-adjustment') {
    const target = effectiveTargets[0], width = dependencies.correctionWidth ?? CARD_W;
    if (sourceUnits.length || effectiveTargets.length !== 1 || !target || !isWholeMessageSelection(target, target.messageId) || target.reference?.revision !== undefined || !isCardWidth(width)) {
      setSendError('宽度调整需要选择一条当前完整消息，宽度须为 320–2400 的整数');
      return;
    }
    const backendRel = await dependencies.createRel(dependencies.scopeMessageId, {
      relationType: 'CORRECT', sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: target.messageId }],
      payload: { correctionKind: 'WIDTH', correctionWidth: width },
    });
    await dependencies.registerCreatedRelationInCurrentClassify(backendRel);
    dependencies.setEdges(previous => previous.some(edge => edge.relationMessageId === backendRel.id) ? previous : [...previous, {
      id: `${backendRel.id}:width`, relationMessageId: backendRel.id, relationType: 'correct', relationLabel: '宽度调整',
      from: { messageId: `anon:${backendRel.id}`, selection: { kind: 'whole' } },
      to: { messageId: target.messageId, selection: { kind: 'whole' } },
    }]);
    setDraftUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
    setNewMessageContent(''); setRelationType(null); setSecondaryRelationType('none');
    return;
  }
  if (relationType === 'correct' && effectiveTargets.length === 1 && msgMap.get(effectiveTargets[0].messageId)?.parts) {
    await prepareAddressedCorrection(dependencies, { effectiveTargets });
    return;
  }
  if (relationType === 'authorize') {
    await sendAuthorizationDraft(dependencies, { effectiveTargets });
    return;
  }
  // Legacy exported messages retain their original correction preview.
  const hasRelationTarget = effectiveTargets.some(u => msgMap.get(u.messageId)?.kind === 'relation' && !isCorrectableCorrectionTarget(msgMap.get(u.messageId)));
  if (relationType === 'correct' && hasRelationTarget) {
    setSendError('关系消息不能更正，请选择普通文本消息');
    return;
  }
  if (relationType === 'correct' && !hasRelationTarget && effectiveTargets.length === 1) {
    await prepareTextCorrection(dependencies, { effectiveTargets, text });
    return;
  }

  if (isAgreeDisagree && text.length === 0) {
    await sendStanceDraft(dependencies, { effectiveTargets });
    return;
  }

  // ARRANGE relation: create new, or append targets to an existing ARRANGE.
  // When sourceUnits contains an existing ARRANGE relation, append targets
  // to its frame instead of creating a new ARRANGE.
  if (isArrange) {
    await sendArrangeDraft(dependencies, { text, effectiveTargets });
    return;
  }

  // CLASSIFY relation: user-to-message relation with no source message.
  // Targets can be text messages and/or classify relation messages, and can be empty.
  if (relationType === "classify") {
    await sendClassificationDraft(dependencies, { effectiveTargets });
    return;
  }

  // SUMMARY relation: user-to-message relation, like CLASSIFY but with multi-column layout.
  // Requires both non-empty targets and non-empty title text.
  if (relationType === "summary") {
    await sendSummaryDraft(dependencies, { effectiveTargets });
    return;
  }

  // MERGE relation: user-to-message relation with no source message.
  // Targets may be text messages or relation messages; fragments are folded up to whole targets.
  // If text is present, create a standalone text message first — it appears outside the merge frame.
  if (relationType === "merge") {
    await sendMergeDraft(dependencies, { text, effectiveTargets });
    return;
  }

  // For most types below, text is required. Governance/ops types allow empty text when targets exist.
  if (text.length === 0 && !isGovernanceOrOpsType && relationType !== "correct") return;
  const labelDefault = relationTypeName(relationType);
  const label = relationLabel.trim() || labelDefault;

  // CORRECT relation: auto-generate the new message content by applying the replacement
  // (text box content) to the selected fragment(s) or whole of the target message.
  if (relationType === "correct") {
    await prepareCorrectionChain(dependencies, { effectiveTargets, text, label });
    return;
  }

  // TAG relation: do NOT create a text message. Store the label as tagLabel on the relation,
  // making it a pure user-to-message relation without a source text message.
  if (relationType === "tag") {
    await sendWrittenTagDraft(dependencies, { text, effectiveTargets });
    return;
  }

  // DELEGATION: create a commission or claim completion of one.
  if (relationType === 'delegation') {
    await sendDelegationDraft(dependencies, { effectiveTargets });
    return;
  }

  // PROPOSAL / CODE_CHANGE / OPERATIONS: governance & operational messages.
  if (relationType === "proposal" || relationType === "code_change" || relationType === "operations") {
    await sendGovernanceDraft(dependencies, { effectiveTargets });
    return;
  }

  const msg = await handleSendMessageOnly(text);
  if (!msg) return;
  const sources: UnitSelection[] = [{ messageId: msg.id, selection: { kind: "whole" } }];
  const targets: UnitSelection[] = [...effectiveTargets];
  await handleCreateRelationWithSourcesAndTargets({ sources, targets, label });
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent("");
  setRelationType(null); setSecondaryRelationType("none");
}
