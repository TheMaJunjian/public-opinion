import type { Json } from "@gonglun/core";
import React from "react";
import { api } from "../../../api";
import type { MessageStakes, Relation, TargetRef, User } from "../../../types";
import type {
  DemoEdge,
  DemoMessage,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import type { ClassifyStackEntry } from '../types';

export interface DraftSendDependencies {
  requireAuth: () => boolean;
  singleButtonEnabled: boolean;
  newMessageContent: string;
  savedTextOnTypeSwitchRef: React.MutableRefObject<string>;
  draftUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  sourceUnits: UnitSelection[];
  resolveEffectiveTargetUnits: (draft: UnitSelection[], targets: UnitSelection[], currentRelationType: string | null) => UnitSelection[];
  relationType: RelationType | null;
  hasTextContent: boolean;
  stakeAmount: number | "";
  containerRelationTypes: Set<string>;
  appendContainerType: string | null;
  relStakeAmount: number | "";
  effectiveMinStake: number;
  subType: string;
  subTypeStakeMap: React.MutableRefObject<Record<string, number>>;
  relationStakeMap: React.MutableRefObject<Record<string, number>>;
  totalConsumption: { stakeTotal: number; protocolFeeTotal: number; recommendationTotal: number; delegationRewardStake: number; total: number; perStake: number; textStake: number; relCount: number; joinCount: number; hasText: boolean; hasRel: boolean; joinStakeTotal: number; joinFeeTotal: number; refCount: number; refStakeTotal: number; newJoinCount: number; existingJoinAgreeCount: number; } | null;
  availablePoints: number;
  handleSendMessageOnly: (overrideContent?: string) => Promise<DemoMessage | null>;
  guideTargetIdRef: React.MutableRefObject<string | null>;
  setNewMessageContent: React.Dispatch<React.SetStateAction<string>>;
  getContainerMembershipTargetError: (units: UnitSelection[]) => string | null;
  joinOnlyAction: boolean;
  getContainerCycleError: (units: UnitSelection[]) => string | null;
  showAlert: (message: string) => void;
  relationsRef: React.MutableRefObject<Relation[]>;
  getJoinContainerCycleError: (sourceContainerId: string, targetIds: string[]) => string | null;
  createJoinRelationsForContainer: (containerId: string, _containerType: string, targetMids: Array<string | TargetRef>) => Promise<boolean>;
  setEdges: React.Dispatch<React.SetStateAction<DemoEdge[]>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setSourceUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setTargetUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  setSubType: React.Dispatch<React.SetStateAction<string>>;
  setRelationType: React.Dispatch<React.SetStateAction<RelationType | null>>;
  setSecondaryRelationType: React.Dispatch<React.SetStateAction<string>>;
  relationLabel: string;
  handleCreateRelationWithSourcesAndTargets: (params: { sources: UnitSelection[]; targets: UnitSelection[]; label: string; }) => Promise<void>;
  secondaryRelationType: string;
  msgMap: Map<string, DemoMessage>;
  createRel: (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => Promise<Relation>;
  scopeMessageId: string;
  registerCreatedRelationInCurrentClassify: (backendRel: Relation) => Promise<string | null>;
  edgesRef: React.MutableRefObject<DemoEdge[]>;
  sendTagRelation: (target: UnitSelection, tagLabel: string, subType?: string, customLabel?: string) => Promise<DemoEdge | null>;
  subTypeCustomBufferRef: React.MutableRefObject<string>;
  setSubTypeCustomLabel: React.Dispatch<React.SetStateAction<string>>;
  setComparisonPopup: React.Dispatch<React.SetStateAction<{ relMsgId: string; x: number; y: number; reversePreview?: { before: string; after: string; target: UnitSelection; mode?: "direct"; label?: string; value?: Json; }; } | null>>;
  correctionVersions: Map<string, { current?: import("../../../utils/modelBridge").CorrectionVersion; versions: import("../../../utils/modelBridge").CorrectionVersion[]; }>;
  blockCorrectionForSecondBettor: (messageId: string) => Promise<boolean>;
  edges: DemoEdge[];
  relationById: Map<string, Relation>;
  organizationTargetRef: (unit: UnitSelection) => TargetRef;
  getGroupedTargetTextMessageIds: (units: UnitSelection[]) => string[];
  relationTypeByRelMsgId: Map<string, RelationType>;
  hasCrossNonReferenceTextLinkForClassifyTargets: (targetTextIds: string[], selectionUnits?: UnitSelection[]) => string | null;
  getClassifyTargetRefs: (units: UnitSelection[]) => TargetRef[];
  isInsideClassify: boolean;
  currentClassifyRelMsgId: string | null;
  classifyStackRef: React.MutableRefObject<ClassifyStackEntry[]>;
  appendCreatedRelation: (backendRel: Relation) => Promise<null>;
  setTraceKey: React.Dispatch<React.SetStateAction<number>>;
  isGovernanceOrOpsType: boolean;
  relations: Relation[];
  setRelations: React.Dispatch<React.SetStateAction<Relation[]>>;
  hasTargetsAvailable: boolean;
  user: User | null;
  setMessages: React.Dispatch<React.SetStateAction<DemoMessage[]>>;
  relStakeRef: React.MutableRefObject<number>;
  setAuthorStakes: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  mergeStakeSnapshot: (messageId: string, stakes: MessageStakes) => void;
}
