import type {
RelationType,
UnitSelection
} from "../../../utils/modelBridge";

interface DeriveSendValidationLabelInput {
  singleButtonEnabled: boolean;
  relationType: RelationType | null;
  hasTextContent: boolean;
  draftUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  stakeAmount: number | "";
  joinOnlyAction: boolean;
  relStakeAmount: number | "";
  effectiveMinStake: number;
  totalConsumption: { groups?:unknown[]; contributionError?: string | null; stakeTotal: number; protocolFeeTotal: number; recommendationTotal: number; delegationRewardStake: number; total: number; perStake: number; textStake: number; relCount: number; joinCount: number; hasText: boolean; hasRel: boolean; joinStakeTotal: number; joinFeeTotal: number; refCount: number; refStakeTotal: number; newJoinCount: number; existingJoinAgreeCount: number; } | null;
  availablePoints: number;
  hasCorrectionRelationTarget: boolean;
  hasInvalidCorrectTarget: boolean;
  hasInvalidContainerSource: boolean;
  hasInvalidJoinTarget: boolean;
  invalidJoinTargetMessage: string | null;
  hasCrossLinkValidationError: boolean;
  crossLinkValidationMessage: string | false | null;
  hasOrphanContainerLabel: boolean;
  hasClassifyCycle: boolean;
  hasInvalidDelegationFormat: boolean;
  secondaryRelationType: string;
  hasInvalidProposalFormat: boolean;
  hasTargetsAvailable: boolean;
  isClassifyType: boolean;
  isGovernanceOrOpsType: boolean;
  isAgreeDisagreeType: boolean;
  isArrangeType: boolean;
  isMergeType: boolean;
  isTagWithQuickAnnotate: boolean;
  isTagWithInlineBadge: boolean;
}

export function deriveSendValidationLabel(input: DeriveSendValidationLabelInput): string | null {
  const { singleButtonEnabled, relationType, hasTextContent, draftUnits, targetUnits, stakeAmount, joinOnlyAction, relStakeAmount, effectiveMinStake, totalConsumption, availablePoints, hasCorrectionRelationTarget, hasInvalidCorrectTarget, hasInvalidContainerSource, hasInvalidJoinTarget, invalidJoinTargetMessage, hasCrossLinkValidationError, crossLinkValidationMessage, hasOrphanContainerLabel, hasClassifyCycle, hasInvalidDelegationFormat, secondaryRelationType, hasInvalidProposalFormat, hasTargetsAvailable, isClassifyType, isGovernanceOrOpsType, isAgreeDisagreeType, isArrangeType, isMergeType, isTagWithQuickAnnotate, isTagWithInlineBadge } = input;
  if (singleButtonEnabled) return null;
  if (relationType === null && !hasTextContent) return "请输入消息内容后发送";
  if (draftUnits.length > 0 && targetUnits.length > 0) return "候选区和目标集合不能同时有内容，请清空其中一方";
  if (totalConsumption?.contributionError) return totalConsumption.contributionError;
  if ((totalConsumption?.hasText ?? hasTextContent) && typeof stakeAmount !== 'number') return "请输入真假投入";
  if ((totalConsumption?.hasText ?? hasTextContent) && typeof stakeAmount === 'number' && stakeAmount < 0) return `真假投入不能为负数`;
  if (!joinOnlyAction && !totalConsumption?.groups && relationType && typeof relStakeAmount !== 'number') return "请输入关系消息贡献点";
  if (!joinOnlyAction && !totalConsumption?.groups && relationType && typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake) return `关系消息最低押注 ${effectiveMinStake} 点`;
  if (totalConsumption && totalConsumption.total > availablePoints) return `贡献点余额不足：需要 ${totalConsumption.total} 点，可用 ${availablePoints} 点`;
  if (hasCorrectionRelationTarget) return "关系消息不能作为更正目标，请选择普通文本消息";
  if (hasInvalidCorrectTarget) return secondaryRelationType === 'width-adjustment' ? '宽度调整需要选择一条当前完整消息，且不能有来源' : "更正只能选择原始内容中的一个文本字段";
  if (hasInvalidContainerSource) return "来源集合必须是当前关系类型对应的容器消息";
  if (joinOnlyAction && !hasTargetsAvailable) return '请选择要加入已有容器的目标消息，此处不可输入';
  if (hasInvalidJoinTarget) return invalidJoinTargetMessage as string;
  if (hasCrossLinkValidationError) return crossLinkValidationMessage as string;
  if (hasOrphanContainerLabel) return "选中的关系标签不属于当前目标集合";
  if (hasClassifyCycle) return "不能将当前分类或其上级分类作为新分类的目标";
  if (hasInvalidDelegationFormat) return secondaryRelationType === 'fulfill'
    ? "完成委托格式无效，请填写分配数量或分配比例，并选择一条委托关系"
    : "创建委托格式无效，请填写报酬数量和委托内容";
  if (hasInvalidProposalFormat) return secondaryRelationType === '充值分账'
    ? "充值分账格式无效，请填写充值总额、收入池分成和指定与会者"
    : "运营收入提案格式无效，请填写收入金额和来源";
  if (relationType === 'tag' && secondaryRelationType === 'none') return "请先选择推荐、冷藏、已读、未读或已有标签";
  if (!hasTargetsAvailable && relationType !== null && !isClassifyType && !isGovernanceOrOpsType) return "请先选择目标消息";
  if (!joinOnlyAction && relationType !== null && !hasTextContent && !isAgreeDisagreeType && !isArrangeType && !isMergeType && !isTagWithQuickAnnotate && !isTagWithInlineBadge) return "请输入消息内容";
  return null;
}
