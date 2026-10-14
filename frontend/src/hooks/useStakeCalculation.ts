import { useRef } from 'react';

interface StakeCalculationDeps {
  relationType: string | null;
  secondaryRelationType?: string;
  subType: string;
  draftUnits: Array<{ messageId: string }>;
  targetUnits: Array<{ messageId: string }>;
  sourceUnits?: Array<{ messageId: string }>;
  newMessageContent: string;
  stakeAmount: number | '';
  relStakeAmount: number | '';
  recommendationAmount?: number | '';
  relationStakeMap: React.MutableRefObject<Record<string, number>>;
  subTypeStakeMap: React.MutableRefObject<Record<string, number>>;
  existingJoinCount?: number;
  joinOnlyAction?: boolean;
  reclassificationJoinCount?: number;
  additionalAgreeTargetCount?: number;
  onRelStakeChange: (min: number) => void;
  stakeDefaultLoaded: React.MutableRefObject<boolean>;
}

const amount = (value: number | '' | undefined) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
export function calculateSendCost(deps: Pick<StakeCalculationDeps, 'relationType' | 'secondaryRelationType' | 'draftUnits' | 'targetUnits' | 'sourceUnits' | 'newMessageContent' | 'stakeAmount' | 'relStakeAmount' | 'recommendationAmount' | 'joinOnlyAction' | 'additionalAgreeTargetCount'>, protocolFee: number) {
  const targets = deps.draftUnits.length ? deps.draftUnits : deps.targetUnits;
  const relation = deps.relationType;
  const content = deps.newMessageContent.trim().length > 0;
  const embedded = new Set(['classify', 'summary', 'tag', 'proposal', 'delegation', 'code_change', 'operations', 'correct']);
  const usesSelectedSources = !!deps.sourceUnits?.length && !deps.draftUnits.length && !!deps.targetUnits.length && !['classify', 'merge', 'arrange'].includes(relation ?? '');
  const hasText = content && !usesSelectedSources && (!relation || !embedded.has(relation));
  const multi = new Set(['annotation', 'reference', 'reply', 'notify', 'agree', 'disagree', 'tag', 'authorize']);
  const sourceCount = usesSelectedSources
    ? ['agree', 'disagree'].includes(relation ?? '') ? new Set(deps.sourceUnits!.map(source => source.messageId)).size : deps.sourceUnits!.length : 1;
  const sourceMultiplier = ['annotation', 'reference', 'reply', 'notify', 'agree', 'disagree'].includes(relation ?? '') ? sourceCount : 1;
  const relCount = relation ? (multi.has(relation) ? Math.max(1, targets.length + (deps.additionalAgreeTargetCount ?? 0)) * sourceMultiplier : 1) : 0;
  const joinCount = deps.joinOnlyAction ? new Set(targets.map(target => target.messageId)).size : 0;
  const refCount = !usesSelectedSources && ['proposal', 'code_change', 'operations'].includes(relation ?? '') ? targets.length : 0;
  const operations = deps.joinOnlyAction ? joinCount : Number(hasText) + relCount + refCount;
  if (!operations) return null;
  const textStake = hasText ? amount(deps.stakeAmount) : 0;
  const perStake = deps.joinOnlyAction ? 0 : amount(deps.relStakeAmount);
  const stakeTotal = textStake + perStake * relCount;
  const recommendationTotal = deps.joinOnlyAction ? 0 : amount(deps.recommendationAmount) * (relCount || 1);
  const rewardMatch = relation === 'delegation' && deps.secondaryRelationType === 'create'
    ? deps.newMessageContent.match(/(?:报酬数量|数量)\s*[=:：]\s*(\d+)/) : null;
  const delegationRewardStake = rewardMatch ? Number(rewardMatch[1]) : 0;
  const protocolFeeTotal = operations * protocolFee;
  return {
    stakeTotal, protocolFeeTotal, recommendationTotal, delegationRewardStake,
    total: stakeTotal + protocolFeeTotal + recommendationTotal + delegationRewardStake,
    perStake, textStake, relCount, joinCount, hasText, hasRel: relCount > 0,
    joinStakeTotal: 0, joinFeeTotal: joinCount * protocolFee, refCount, refStakeTotal: 0,
    newJoinCount: joinCount, existingJoinAgreeCount: 0,
  };
}

export default function useStakeCalculation(deps: StakeCalculationDeps) {
  const stakeFeeAmountRef = useRef(1);
  const totalConsumption = calculateSendCost(deps, stakeFeeAmountRef.current);
  return {
    effectiveMinStake: 0,
    totalConsumption,
    stakeFeeAmountRef,
    multiTargetCount: totalConsumption?.relCount ?? 0,
    isTextInPayload: !totalConsumption?.hasText,
    hasTextContentForTotal: totalConsumption?.hasText ?? false,
  };
}
