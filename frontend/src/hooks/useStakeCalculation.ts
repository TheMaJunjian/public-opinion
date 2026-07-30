import { useRef, useEffect } from 'react';

interface StakeCalculationDeps {
  relationType: string | null;
  subType: string;
  draftUnits: Array<{ messageId: string }>;
  targetUnits: Array<{ messageId: string }>;
  newMessageContent: string;
  stakeAmount: number | '';
  relStakeAmount: number | '';
  relationStakeMap: React.MutableRefObject<Record<string, number>>;
  subTypeStakeMap: React.MutableRefObject<Record<string, number>>;
  onRelStakeChange: (min: number) => void;
  stakeDefaultLoaded: React.MutableRefObject<boolean>;
}

const SUB_TYPE_MIN_STAKE_FALLBACK: Record<string, number> = { SPAM: 5, OFFTOPIC: 5, LOWVALUE: 5, IMPORTANT: 10, CUSTOM: 5 };

export default function useStakeCalculation(deps: StakeCalculationDeps) {
  const {
    relationType, subType, draftUnits, targetUnits, newMessageContent,
    stakeAmount, relStakeAmount, relationStakeMap, subTypeStakeMap,
    onRelStakeChange, stakeDefaultLoaded,
  } = deps;

  const stakeFeeAmountRef = useRef(1);

  const effectiveMinStake = (() => {
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
    return draftUnits.length > 0 ? draftUnits.length : targetUnits.length;
  })();

  const isTextInPayload = relationType === 'classify' || relationType === 'summary' || relationType === 'merge'
    || relationType === 'tag' || relationType === 'proposal' || relationType === 'code_change' || relationType === 'operations';
  const hasTextContentForTotal = !isTextInPayload && newMessageContent.trim().length > 0;

  const totalConsumption = (() => {
    const protocolFeePerOp = stakeFeeAmountRef.current;
    const textStake = hasTextContentForTotal && typeof stakeAmount === 'number' ? stakeAmount : 0;
    const textFee = textStake > 0 ? protocolFeePerOp : 0;
    if (!relationType) {
      if (textStake > 0) return { stakeTotal: textStake, protocolFeeTotal: textFee, total: textStake + textFee, perStake: textStake, textStake, relCount: 0, joinCount: 0, hasText: true, hasRel: false };
      return null;
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
    const totalStake = textStake + relStakeTotal + refStakeTotal + joinStakeTotal;
    const totalProtocolFee = textFee + relFeeTotal + refFeeTotal + joinFeeTotal;
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
      joinStakeTotal,
      joinFeeTotal,
      hasText: textStake > 0,
      hasRel: true,
    };
  })();

  useEffect(() => {
    if (!stakeDefaultLoaded.current) return;
    onRelStakeChange(effectiveMinStake);
  }, [relationType, subType, draftUnits.length, targetUnits.length]);

  return { effectiveMinStake, multiTargetCount, isTextInPayload, hasTextContentForTotal, totalConsumption, stakeFeeAmountRef };
}
