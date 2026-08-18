import { useRef, useEffect } from 'react';

interface StakeCalculationDeps {
  relationType: string | null;
  secondaryRelationType?: string;
  subType: string;
  draftUnits: Array<{ messageId: string }>;
  targetUnits: Array<{ messageId: string }>;
  newMessageContent: string;
  stakeAmount: number | '';
  relStakeAmount: number | '';
  relationStakeMap: React.MutableRefObject<Record<string, number>>;
  subTypeStakeMap: React.MutableRefObject<Record<string, number>>;
  existingJoinCount?: number;
  joinOnlyAction?: boolean;
  additionalAgreeTargetCount?: number;
  onRelStakeChange: (min: number) => void;
  stakeDefaultLoaded: React.MutableRefObject<boolean>;
}

const SUB_TYPE_MIN_STAKE_FALLBACK: Record<string, number> = { SPAM: 5, OFFTOPIC: 5, LOWVALUE: 5, IMPORTANT: 10, CUSTOM: 5 };

export default function useStakeCalculation(deps: StakeCalculationDeps) {
  const {
    relationType, secondaryRelationType = 'none', subType, draftUnits, targetUnits, newMessageContent,
    stakeAmount, relStakeAmount, relationStakeMap, subTypeStakeMap,
    existingJoinCount = 0, joinOnlyAction = false, additionalAgreeTargetCount = 0,
    onRelStakeChange, stakeDefaultLoaded,
  } = deps;

  const stakeFeeAmountRef = useRef(1);

  const effectiveMinStake = (() => {
    if (relationType === 'tag' && (secondaryRelationType === 'read' || secondaryRelationType === 'unread')) return 0;
    if (joinOnlyAction) return 1;
    const typeMinBase = relationType
      ? (relationStakeMap.current[relationType.toUpperCase()] ?? 10)
      : 10;
    let min = typeMinBase;
    if (subType) {
      const subMin = subTypeStakeMap.current[subType] ?? SUB_TYPE_MIN_STAKE_FALLBACK[subType];
      if (subMin) min = Math.max(min, subMin);
    }
    const isGovOps = relationType === "proposal" || relationType === "code_change" || relationType === "operations";
    const govTargetCount = isGovOps ? (draftUnits.length > 0 ? draftUnits.length : targetUnits.length) : 0;
    const refMin = relationStakeMap.current['REFERENCE'] ?? 10;
    if (isGovOps && govTargetCount > 0) min += govTargetCount * refMin;
    return min;
  })();

  const multiTargetCount = (() => {
    const multiTargetTypes = new Set(['annotation', 'reference', 'reply', 'agree', 'disagree', 'tag']);
    if (!relationType || !multiTargetTypes.has(relationType.toLowerCase())) return 0;
    const baseCount = draftUnits.length > 0 ? draftUnits.length : targetUnits.length;
    return baseCount + (relationType === 'agree' ? additionalAgreeTargetCount : 0);
  })();

  const isTextInPayload = relationType === 'classify' || relationType === 'summary' || relationType === 'merge'
    || relationType === 'tag' || relationType === 'proposal' || relationType === 'delegation' || relationType === 'code_change' || relationType === 'operations';
  const hasTextContentForTotal = !isTextInPayload && newMessageContent.trim().length > 0;

  const totalConsumption = (() => {
    const protocolFeePerOp = stakeFeeAmountRef.current;
    const textStake = hasTextContentForTotal && typeof stakeAmount === 'number' ? stakeAmount : 0;
    const textFee = textStake > 0 ? protocolFeePerOp : 0;
    if (!relationType) {
      if (textStake > 0) return { stakeTotal: textStake, protocolFeeTotal: textFee, total: textStake + textFee, perStake: textStake, textStake, relCount: 0, joinCount: 0, hasText: true, hasRel: false };
      return null;
    }
    if (relationType === 'tag' && (secondaryRelationType === 'read' || secondaryRelationType === 'unread')) {
      return { stakeTotal: 0, protocolFeeTotal: protocolFeePerOp, total: protocolFeePerOp, perStake: 0, textStake: 0, relCount: 0, joinCount: 0, hasText: false, hasRel: false };
    }
    if (joinOnlyAction) {
      const baseTargets = draftUnits.length > 0 ? draftUnits : targetUnits;
      const joinCount = new Set(baseTargets.map(unit => unit.messageId)).size;
      const joinStakeTotal = joinCount;
      const joinFeeTotal = joinCount * protocolFeePerOp;
      return {
        stakeTotal: joinStakeTotal,
        protocolFeeTotal: joinFeeTotal,
        total: joinStakeTotal + joinFeeTotal,
        perStake: 1,
        textStake: 0,
        refStakeTotal: 0,
        refCount: 0,
        relCount: 0,
        joinCount,
        newJoinCount: 0,
        existingJoinAgreeCount: joinCount,
        joinStakeTotal,
        joinFeeTotal,
        hasText: false,
        hasRel: false,
      };
    }
    if (typeof relStakeAmount !== 'number') {
      if (textStake > 0) return { stakeTotal: textStake, protocolFeeTotal: textFee, total: textStake + textFee, perStake: 0, textStake, relCount: 0, joinCount: 0, hasText: true, hasRel: false };
      return null;
    }
    const relCount = multiTargetCount > 0 ? multiTargetCount : 1;
    const relStakeTotal = relStakeAmount * relCount;
    const relFeeTotal = protocolFeePerOp * relCount;
    const isGovOps2 = relationType === 'proposal' || relationType === 'code_change' || relationType === 'operations';
    const govRefCount = isGovOps2 ? (draftUnits.length > 0 ? draftUnits.length : targetUnits.length) : 0;
    const refMin = relationStakeMap.current['REFERENCE'] ?? 10;
    const refStakeTotal = govRefCount > 0 ? govRefCount * refMin : 0;
    const refFeeTotal = govRefCount > 0 ? govRefCount * protocolFeePerOp : 0;
    const isContainerType = relationType === 'classify' || relationType === 'summary' || relationType === 'arrange' || relationType === 'merge';
    const JOIN_STAKE_PER_TARGET = 1;
    const containerJoinCount = isContainerType ? (() => {
      const baseTargets = draftUnits.length > 0 ? draftUnits : targetUnits;
      const uniqueCount = new Set(baseTargets.map(u => u.messageId)).size;
      if (relationType === 'arrange' && hasTextContentForTotal) return uniqueCount + 1;
      return uniqueCount;
    })() : 0;
    const joinStakeTotal = containerJoinCount * JOIN_STAKE_PER_TARGET;
    const joinFeeTotal = containerJoinCount * protocolFeePerOp;
    const delegationRewardMatch = relationType === 'delegation' && secondaryRelationType === 'create'
      ? newMessageContent.match(/(?:报酬数量|数量)\s*[=:：]\s*(\d+)/)
      : null;
    const delegationRewardStake = delegationRewardMatch ? Number(delegationRewardMatch[1]) : 0;
    const delegationReferenceStake = relationType === 'delegation' && secondaryRelationType === 'fulfill' && targetUnits.length + draftUnits.length > 0
      ? (relationStakeMap.current['REFERENCE'] ?? 10)
      : 0;
    const delegationReferenceFee = delegationReferenceStake > 0 ? protocolFeePerOp : 0;
    const totalStake = textStake + relStakeTotal + refStakeTotal + joinStakeTotal + delegationRewardStake + delegationReferenceStake;
    const totalProtocolFee = textFee + relFeeTotal + refFeeTotal + joinFeeTotal + delegationReferenceFee;
    return {
      stakeTotal: totalStake,
      protocolFeeTotal: totalProtocolFee,
      total: totalStake + totalProtocolFee,
      perStake: relStakeAmount,
      textStake,
      refStakeTotal,
      refCount: govRefCount,
      relCount,
      joinCount: containerJoinCount,
      newJoinCount: Math.max(0, containerJoinCount - existingJoinCount),
      existingJoinAgreeCount: Math.min(containerJoinCount, existingJoinCount),
      joinStakeTotal,
      joinFeeTotal,
      delegationRewardStake,
      delegationReferenceStake,
      delegationReferenceFee,
      hasText: textStake > 0,
      hasRel: true,
    };
  })();

  useEffect(() => {
    if (!stakeDefaultLoaded.current) return;
    onRelStakeChange(effectiveMinStake);
  }, [relationType, subType, draftUnits.length, targetUnits.length, joinOnlyAction, additionalAgreeTargetCount]);

  return { effectiveMinStake, multiTargetCount, isTextInPayload, hasTextContentForTotal, totalConsumption, stakeFeeAmountRef };
}
