import type { Relation, TargetRef } from "../../../types";
import { relationTypeName } from '../../../utils/graphTextSelection';
import type {
  DemoMessage,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { CLASSIFY_TARGET_HINT } from '../model/relationComposition';

interface DeriveSingleButtonLabelInput {
  relationType: RelationType | null;
  newMessageContent: string;
  draftUnits: UnitSelection[];
  isClassifyType: boolean;
  sourceUnits: UnitSelection[];
  relations: Relation[];
  getClassifyTargetRefs: (units: UnitSelection[]) => TargetRef[];
  targetUnits: UnitSelection[];
  joinOnlyAction: boolean;
  hasTargetsAvailable: boolean;
  isSummaryType: boolean;
  isMergeType: boolean;
  hasCorrectionRelationTarget: boolean;
  hasInvalidCorrectTarget: boolean;
  hasTextContent: boolean;
  isNotifyType: boolean;
  hasAttentionNotifyTarget: boolean;
  isGovernanceOrOpsType: boolean;
  secondaryRelationType: string;
  msgMap: Map<string, DemoMessage>;
  isAgreeDisagreeType: boolean;
  isArrangeType: boolean;
  isTagWithInlineBadge: boolean;
  subType: string;
  isTagWithQuickAnnotate: boolean;
}

export function deriveSingleButtonLabel(input: DeriveSingleButtonLabelInput): string {
  const { relationType, newMessageContent, draftUnits, isClassifyType, sourceUnits, relations, getClassifyTargetRefs, targetUnits, joinOnlyAction, hasTargetsAvailable, isSummaryType, isMergeType, hasCorrectionRelationTarget, hasInvalidCorrectTarget, hasTextContent, isNotifyType, hasAttentionNotifyTarget, isGovernanceOrOpsType, secondaryRelationType, msgMap, isAgreeDisagreeType, isArrangeType, isTagWithInlineBadge, subType, isTagWithQuickAnnotate } = input;
  if (relationType === null) {
    if (newMessageContent.trim().length === 0) return "请输入消息内容后发送";
    return "仅发送这条消息（未选择关系类型）";
  }
  const typeName = relationTypeName(relationType);
  const usingDraft = draftUnits.length > 0;
  if (isClassifyType) {
    const existingClassifySource = sourceUnits.some(unit =>
      relations.find(relation => relation.id === unit.messageId)?.relationType?.toUpperCase() === 'CLASSIFY'
    );
    const targetCount = getClassifyTargetRefs(usingDraft ? draftUnits : targetUnits).length;
    if (existingClassifySource && joinOnlyAction) {
      if (!hasTargetsAvailable) return "请选择要加入已有分类的目标消息";
      return `将${usingDraft ? "候选区" : "目标集合"}中的 ${targetCount} 个消息加入已有分类`;
    }
    if (targetCount === 0) return "文本将作为分类名称，建立分类（无目标）";
    return `文本将作为分类名称，建立分类（${targetCount} 个${CLASSIFY_TARGET_HINT}目标）`;
  }
  if (isSummaryType) {
    const targetCount = getClassifyTargetRefs(usingDraft ? draftUnits : targetUnits).length;
    if (!hasTargetsAvailable) return "请在画布中选择要总结的目标消息";
    if (newMessageContent.trim().length === 0) return "请输入总结内容（不能为空）";
    return `文本将作为总结内容，建立总结关系（${targetCount} 个目标）`;
  }
  if (isMergeType) {
    if (sourceUnits.length > 0) return "归并关系不需要来源消息，请清空来源集合";
    if (!hasTargetsAvailable) return "请在画布中选择要归并的目标消息";
    if (newMessageContent.trim().length > 0) return "归并关系不需要输入文本消息";
    return `建立归并关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
  }
  if (relationType === 'correct') {
    if (!hasTargetsAvailable) return '请选择要更正的原始内容';
    if (hasCorrectionRelationTarget) return '关系消息不能作为更正目标，请选择普通文本消息';
    if (hasInvalidCorrectTarget) return '更正只能选择原始内容中的一个文本字段';
    return hasTextContent
      ? `将选中的原始内容修改为「${newMessageContent.trim()}」`
      : '删除选中的原始内容片段';
  }
  if (isNotifyType) {
    if (!hasAttentionNotifyTarget) return '请选择已有关注与会者的目标消息';
    if (sourceUnits.length === 0 && newMessageContent.trim().length === 0) return '请输入通知内容或选择来源消息';
    return `发送通知（通知目标消息的关注与会者）`;
  }
  if (isGovernanceOrOpsType) {
    const govTypeLabel = relationType === "proposal" ? "提案" : relationType === "code_change" ? "代码" : "运营";
    if (sourceUnits.length > 0)
      return `请清空来源集合（${govTypeLabel}消息不需要来源）`;
    // 分配收入
    if (relationType === 'proposal' && secondaryRelationType === '分配收入') {
      if (hasTargetsAvailable) return '分配收入提案不能选择目标，请清空目标集合';
      if (newMessageContent.trim().length > 0) return '分配收入提案不需要输入文本，请清空文本框';
      return '发送分配收入提案（将当前收入池余额按规则分配给社区成员）';
    }
    if (relationType === 'proposal' && secondaryRelationType === '充值分账') {
      return '发送充值分账提案（提交后验证指定与会者）';
    }
    // 终止结算
    if (relationType === 'proposal' && secondaryRelationType === '终止结算') {
      if (!hasTargetsAvailable) return '请选择目标提案消息';
      if (!targetUnits.some(t => msgMap.get(t.messageId)?.kind === 'governance'))
        return '终止结算的目标必须是提案消息';
      return '发送终止结算提案';
    }
    const usingDraft2 = draftUnits.length > 0;
    const targetCount = (usingDraft2 ? draftUnits : targetUnits).length;
    if (!hasTargetsAvailable && newMessageContent.trim().length === 0)
      return `请输入${govTypeLabel}内容或选择目标消息`;
    if (targetCount > 0 && newMessageContent.trim().length > 0)
      return `文本将作为${govTypeLabel}正文，发送${govTypeLabel}消息（引用 ${targetCount} 个目标）`;
    if (targetCount > 0)
      return `发送${govTypeLabel}消息（引用 ${targetCount} 个目标，无正文）`;
    return `文本将作为${govTypeLabel}正文，发送${govTypeLabel}消息`;
  }
  if (isAgreeDisagreeType) {
    if (!hasTargetsAvailable) return "请在画布中选择目标消息";
    return newMessageContent.trim().length > 0
      ? `发送消息并建立「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标）`
      : `建立纯站队「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
  }
  if (isArrangeType) {
    if (!hasTargetsAvailable) return "请在画布中选择目标消息";
    const layoutLabel = secondaryRelationType === 'horizontal' ? '横排' : '纵排';
    return newMessageContent.trim().length > 0
      ? `发送消息并建立「${typeName}」关系（${layoutLabel}，文本消息加入排列框架）`
      : `建立「${typeName}」关系（${layoutLabel}，用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
  }
  // TAG + secondary = recommend/archive: quick inline-badge shortcut
  if (isTagWithInlineBadge) {
    if (!hasTargetsAvailable) return "请在画布中选择目标消息";
    const secName = relationTypeName(secondaryRelationType as RelationType);
    if (subType === 'CUSTOM') {
      if (newMessageContent.trim().length === 0) return "请输入自定义理由";
      return `建立「${secName}」关系（自定义理由，用${usingDraft ? "候选" : "目标集合"}作目标）`;
    }
    return `建立「${secName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
  }
  // TAG + secondary = none: invalid state prompt
  if (relationType === "tag" && secondaryRelationType === "none") {
    return "请先选择推荐或冷藏";
  }
  // TAG + secondary = existing tag label: quick re-annotation shortcut
  if (isTagWithQuickAnnotate) {
    if (!hasTargetsAvailable) return "请在画布中选择目标消息";
    return `快速标注「${secondaryRelationType}」（用${usingDraft ? "候选" : "目标集合"}作目标）`;
  }
  if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) {
    return `建立「${typeName}」关系（来源集合 → 目标集合）`;
  }
  if (!hasTargetsAvailable) return "请在画布中选择目标消息";
  if (newMessageContent.trim().length === 0) return "请输入消息内容（将作为来源）";
  return `发送消息并建立「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标）`;
}
