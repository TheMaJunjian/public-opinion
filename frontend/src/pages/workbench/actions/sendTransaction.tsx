import React from "react";
import { api } from "../../../api";
import type { Relation } from "../../../types";
import type {
DemoEdge,
DemoMessage,
RelationType,
UnitSelection
} from "../../../utils/modelBridge";

interface HandleSendClickDependencies {
  sendInFlightRef: React.MutableRefObject<boolean>;
  draftUnits: UnitSelection[];
  sourceUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  activeTextSelectId: string | null;
  newMessageContent: string;
  relationType: RelationType | null;
  secondaryRelationType: string;
  subType: string;
  subTypeCustomLabel: string;
  relationLabel: string;
  stakeAmount: number | "";
  relStakeAmount: number | "";
  recommendationAmount: number | "";
  messages: DemoMessage[];
  edges: DemoEdge[];
  relations: Relation[];
  authorStakes: Record<string, number>;
  stakeCounts: Record<string, { truth: { pro: number; con: number; }; value: { pro: number; con: number; }; }>;
  savedTextOnTypeSwitchRef: React.MutableRefObject<string>;
  subTypeCustomBufferRef: React.MutableRefObject<string>;
  savedTextBeforeDelegationRef: React.MutableRefObject<string>;
  delegationContentBufferRef: React.MutableRefObject<Record<"create" | "fulfill", string>>;
  setSendInFlight: React.Dispatch<React.SetStateAction<boolean>>;
  handleQuickSendAndRelateFromDraftTargets: () => Promise<void>;
  setRecommendationAmount: React.Dispatch<React.SetStateAction<number | "">>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setSourceUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setTargetUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  setNewMessageContent: React.Dispatch<React.SetStateAction<string>>;
  setRelationType: React.Dispatch<React.SetStateAction<RelationType | null>>;
  setSecondaryRelationType: React.Dispatch<React.SetStateAction<string>>;
  setSubType: React.Dispatch<React.SetStateAction<string>>;
  setRelationLabel: React.Dispatch<React.SetStateAction<string>>;
  setSubTypeCustomLabel: React.Dispatch<React.SetStateAction<string>>;
  setStakeAmount: React.Dispatch<React.SetStateAction<number | "">>;
  setRelStakeAmount: React.Dispatch<React.SetStateAction<number | "">>;
  setMessages: React.Dispatch<React.SetStateAction<DemoMessage[]>>;
  setEdges: React.Dispatch<React.SetStateAction<DemoEdge[]>>;
  setRelations: React.Dispatch<React.SetStateAction<Relation[]>>;
  messagesRef: React.MutableRefObject<DemoMessage[]>;
  edgesRef: React.MutableRefObject<DemoEdge[]>;
  relationsRef: React.MutableRefObject<Relation[]>;
  setAuthorStakes: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setStakeCounts: React.Dispatch<React.SetStateAction<Record<string, { truth: { pro: number; con: number; }; value: { pro: number; con: number; }; }>>>;
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  onCommitted?: () => void;
}

export async function handleSendClick(dependencies: HandleSendClickDependencies): Promise<void> {
  const { sendInFlightRef, draftUnits, sourceUnits, targetUnits, activeTextSelectId, newMessageContent, relationType, secondaryRelationType, subType, subTypeCustomLabel, relationLabel, stakeAmount, relStakeAmount, recommendationAmount, messages, edges, relations, authorStakes, stakeCounts, savedTextOnTypeSwitchRef, subTypeCustomBufferRef, savedTextBeforeDelegationRef, delegationContentBufferRef, setSendInFlight, handleQuickSendAndRelateFromDraftTargets, setRecommendationAmount, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType, setSubType, setRelationLabel, setSubTypeCustomLabel, setStakeAmount, setRelStakeAmount, setMessages, setEdges, setRelations, messagesRef, edgesRef, relationsRef, setAuthorStakes, setStakeCounts, setSendError } = dependencies;
  if (sendInFlightRef.current) return;
  const previous = { draftUnits, sourceUnits, targetUnits, activeTextSelectId, newMessageContent, relationType, secondaryRelationType, subType, subTypeCustomLabel, relationLabel, stakeAmount, relStakeAmount, recommendationAmount, messages, edges, relations, authorStakes, stakeCounts,
    textOnTypeSwitch: savedTextOnTypeSwitchRef.current, customText: subTypeCustomBufferRef.current,
    textBeforeDelegation: savedTextBeforeDelegationRef.current, delegationContent: { ...delegationContentBufferRef.current } };
  const restoreComposer = () => {
    setDraftUnits(previous.draftUnits); setSourceUnits(previous.sourceUnits); setTargetUnits(previous.targetUnits);
    setActiveTextSelectId(previous.activeTextSelectId); setNewMessageContent(previous.newMessageContent);
    setRelationType(previous.relationType); setSecondaryRelationType(previous.secondaryRelationType);
    setSubType(previous.subType); setRelationLabel(previous.relationLabel);
    setSubTypeCustomLabel(previous.subTypeCustomLabel);
    savedTextOnTypeSwitchRef.current = previous.textOnTypeSwitch; subTypeCustomBufferRef.current = previous.customText;
    savedTextBeforeDelegationRef.current = previous.textBeforeDelegation; delegationContentBufferRef.current = previous.delegationContent;
    setStakeAmount(previous.stakeAmount); setRelStakeAmount(previous.relStakeAmount); setRecommendationAmount(previous.recommendationAmount);
  };
  sendInFlightRef.current = true;
  setSendInFlight(true);
  try {
    let committedCount = 0;
    await api.withCommandBatch(async () => handleQuickSendAndRelateFromDraftTargets(), count => { committedCount = count; });
    if (committedCount === 0) restoreComposer();
    else {
      if (relationType !== 'correct') setRecommendationAmount(0);
      dependencies.onCommitted?.();
    }
  } catch (error) {
    restoreComposer();
    setMessages(previous.messages); setEdges(previous.edges); setRelations(previous.relations);
    messagesRef.current = previous.messages; edgesRef.current = previous.edges; relationsRef.current = previous.relations;
    setAuthorStakes(previous.authorStakes); setStakeCounts(previous.stakeCounts);
    setSendError(error instanceof Error ? error.message : '发送失败，输入与选择已保留');
    window.dispatchEvent(new Event('gonglun:reload'));
  } finally {
    sendInFlightRef.current = false;
    setSendInFlight(false);
  }
}
