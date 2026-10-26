import type { Relation } from "../../../types";
import type {
  DemoMessage,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";

interface DeriveSingleButtonEnabledInput {
  relationType: RelationType | null;
  newMessageContent: string;
  hasTextContent: boolean;
  stakeAmount: number | "";
  joinOnlyAction: boolean;
  relStakeAmount: number | "";
  effectiveMinStake: number;
  totalConsumption: { groups?:unknown[]; contributionError?: string | null; stakeTotal: number; protocolFeeTotal: number; recommendationTotal: number; delegationRewardStake: number; total: number; perStake: number; textStake: number; relCount: number; joinCount: number; hasText: boolean; hasRel: boolean; joinStakeTotal: number; joinFeeTotal: number; refCount: number; refStakeTotal: number; newJoinCount: number; existingJoinAgreeCount: number; } | null;
  availablePoints: number;
  draftUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  hasInvalidCorrectTarget: boolean;
  hasInvalidContainerSource: boolean;
  hasInvalidJoinTarget: boolean;
  hasCrossLinkValidationError: boolean;
  hasOrphanContainerLabel: boolean;
  hasClassifyCycle: boolean;
  hasInvalidDelegationFormat: boolean;
  hasInvalidProposalFormat: boolean;
  hasCorrectionRelationTarget: boolean;
  isClassifyType: boolean;
  sourceUnits: UnitSelection[];
  relations: Relation[];
  hasTargetsAvailable: boolean;
  isSummaryType: boolean;
  isMergeType: boolean;
  secondaryRelationType: string;
  effectiveTargetUnits: UnitSelection[];
  isGovernanceOrOpsType: boolean;
  msgMap: Map<string, DemoMessage>;
  isTagWithInlineBadge: boolean;
  subType: string;
  isTagWithQuickAnnotate: boolean;
  isAgreeDisagreeType: boolean;
  isArrangeType: boolean;
  isNotifyType: boolean;
  hasAttentionNotifyTarget: boolean;
}

export function deriveSingleButtonEnabled(input: DeriveSingleButtonEnabledInput): boolean {
  const { relationType, newMessageContent, hasTextContent, stakeAmount, joinOnlyAction, relStakeAmount, effectiveMinStake, totalConsumption, availablePoints, draftUnits, targetUnits, hasInvalidCorrectTarget, hasInvalidContainerSource, hasInvalidJoinTarget, hasCrossLinkValidationError, hasOrphanContainerLabel, hasClassifyCycle, hasInvalidDelegationFormat, hasInvalidProposalFormat, hasCorrectionRelationTarget, isClassifyType, sourceUnits, relations, hasTargetsAvailable, isSummaryType, isMergeType, secondaryRelationType, effectiveTargetUnits, isGovernanceOrOpsType, msgMap, isTagWithInlineBadge, subType, isTagWithQuickAnnotate, isAgreeDisagreeType, isArrangeType, isNotifyType, hasAttentionNotifyTarget } = input;
  if (totalConsumption?.contributionError) return false;
  if (relationType === null) return newMessageContent.trim().length > 0 && typeof stakeAmount === 'number' && stakeAmount >= 0
    && (!totalConsumption || totalConsumption.total <= availablePoints);
  // Check that relation stake meets the effective minimum (type + subType combined)
  if ((totalConsumption?.hasText ?? hasTextContent) && typeof stakeAmount !== 'number') return false;
  if ((totalConsumption?.hasText ?? hasTextContent) && typeof stakeAmount === 'number' && stakeAmount < 0) return false;
  if (!joinOnlyAction && !totalConsumption?.groups && relationType && typeof relStakeAmount !== 'number') return false;
  if (!joinOnlyAction && !totalConsumption?.groups && relationType && typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake) return false;
  if (totalConsumption && totalConsumption.total > availablePoints) return false;
  // Ambiguous: both draft and target non-empty — force user to clear one
  if (draftUnits.length > 0 && targetUnits.length > 0) return false;
  if (hasInvalidCorrectTarget || hasInvalidContainerSource || hasInvalidJoinTarget || hasCrossLinkValidationError || hasOrphanContainerLabel || hasClassifyCycle || hasInvalidDelegationFormat || hasInvalidProposalFormat) return false;
  if (hasCorrectionRelationTarget) return false;
  if (isClassifyType) {
    const hasExistingClassifySource = sourceUnits.some(unit =>
      relations.find(relation => relation.id === unit.messageId)?.relationType?.toUpperCase() === 'CLASSIFY'
    );
    return hasExistingClassifySource && joinOnlyAction
      ? hasTargetsAvailable
      : newMessageContent.trim().length > 0;
  }
  if (isSummaryType) {
    return joinOnlyAction
      ? hasTargetsAvailable
      : hasTargetsAvailable && newMessageContent.trim().length > 0;
  }
  if (isMergeType) {
    return joinOnlyAction
      ? hasTargetsAvailable
      : hasTargetsAvailable && sourceUnits.length === 0 && newMessageContent.trim().length === 0;
  }
  if (relationType === 'delegation') {
    if (secondaryRelationType === 'fulfill') {
      return newMessageContent.trim().length > 0 && sourceUnits.length === 0 && effectiveTargetUnits.length === 1;
    }
    return sourceUnits.length === 0 && newMessageContent.trim().length > 0;
  }
  if (isGovernanceOrOpsType) {
    if (sourceUnits.length > 0) return false;
    // 分配收入：必须完全清空
    if (relationType === 'proposal' && secondaryRelationType === '分配收入') {
      return !hasTargetsAvailable && newMessageContent.trim().length === 0;
    }
    if (relationType === 'proposal' && secondaryRelationType === '充值分账') {
      return newMessageContent.trim().length > 0;
    }
    // 终止结算：目标必须是 governance 消息
    if (relationType === 'proposal' && secondaryRelationType === '终止结算') {
      return targetUnits.some(t => msgMap.get(t.messageId)?.kind === 'governance');
    }
    return newMessageContent.trim().length > 0 || hasTargetsAvailable;
  }
  // TAG with recommend/archive (inline badge): needs targets; if CUSTOM subType, also needs text
  if (isTagWithInlineBadge) {
    if (!hasTargetsAvailable) return false;
    if (['attention','block'].includes(secondaryRelationType) && subType !== 'YES' && subType !== 'NO') return false;
    if (subType === 'CUSTOM') return newMessageContent.trim().length > 0;
    return true;
  }
  // TAG with existing tag label (non-recommend/archive): needs only targets, no text
  if (isTagWithQuickAnnotate) return hasTargetsAvailable;
  // TAG with secondary=none: invalid state, cannot send
  if (relationType === "tag") return false;
  if (isAgreeDisagreeType || isArrangeType || relationType === 'authorize') return hasTargetsAvailable;
  if (relationType === 'correct') {
    if (hasCorrectionRelationTarget) return secondaryRelationType !== 'none' && !hasTextContent && sourceUnits.length === 0;
    return !hasInvalidCorrectTarget && hasTargetsAvailable && sourceUnits.length === 0;
  }
  if (isNotifyType) return (sourceUnits.length > 0 || newMessageContent.trim().length > 0) && hasAttentionNotifyTarget;
  // sourceUnits + targetUnits explicitly committed (no draft): relation can be built without new text
  if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) return true;
  return hasTargetsAvailable && newMessageContent.trim().length > 0;
}
