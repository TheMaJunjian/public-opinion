import { sendErrorMessage } from './sendErrors';
import React from "react";
import { api } from "../../../api";
import type { Relation, TargetRef } from "../../../types";
import { operationLog } from "../../../utils/debugLog";
import type {
  DemoEdge,
  DemoMessage,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { unitSelectionToReference, unitSelectionToTargetRef } from "../../../utils/modelBridge";
import { buildRelationPayload, secondaryRelationLabel } from '../model/relationComposition';
import { mergeUnits, nextId,relationTargetUnits } from '../model/selection';

interface SendTagRelationDependencies {
  scopeMessageId: string;
  msgMap: Map<string, DemoMessage>;
  secondaryRelationType: string;
  newMessageContent: string;
  createRel: (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => Promise<Relation>;
  registerCreatedRelationInCurrentClassify: (backendRel: Relation) => Promise<string | null>;
  showAlert: (message: string) => void;
}

export async function sendTagRelation(dependencies: SendTagRelationDependencies, target: UnitSelection, tagLabel: string, subType?: string, customLabel?: string,sources:UnitSelection[]=[]): Promise<DemoEdge | null> {
  const { scopeMessageId, msgMap, secondaryRelationType, createRel, registerCreatedRelationInCurrentClassify, showAlert } = dependencies;
  if (!scopeMessageId) return null;
  const backendTargetRef = unitSelectionToTargetRef(target, msgMap);
  try {
    const isReadStatus = secondaryRelationType === 'read' || secondaryRelationType === 'unread';
    const statusType = secondaryRelationType.toUpperCase();
    const payload: Record<string, unknown> = { relationType: isReadStatus ? statusType : 'TAG', ...(isReadStatus ? {} : { label: tagLabel }) };
    if (subType) { payload.subType = subType; if (subType === 'CUSTOM') { const ct = (customLabel??'').trim(); if (ct) payload.customLabel = ct.slice(0, 20); } }
    const backendRel = await createRel(scopeMessageId, {
      relationType: isReadStatus ? statusType : 'TAG',
      sourceMessageId: sources[0]?.messageId??null,
      ...(sources.length?{sourceRefs:mergeUnits([],sources).map(unit=>unitSelectionToReference(unit,msgMap))}:{}),
      targetRefs: [backendTargetRef],
      payload: buildRelationPayload(payload as unknown as Parameters<typeof buildRelationPayload>[0]),
    });
    const relId = backendRel.id;
    await registerCreatedRelationInCurrentClassify(backendRel);
    const anonSrcId = sources[0]?.messageId??`anon:${relId}`;
    return { id: nextId("edge"), relationMessageId: relId, relationType: isReadStatus ? secondaryRelationType : "tag", from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: target, relationLabel: isReadStatus ? secondaryRelationType : tagLabel } as DemoEdge;
  } catch (e) {
    showAlert(`建立标注关系失败: ${sendErrorMessage(e)}`);
    return null;
  }
}

interface HandleCreateRelationWithSourcesAndTargetsDependencies {
  requireAuth: () => boolean;
  scopeMessageId: string;
  relationType: RelationType | null;
  msgMap: Map<string, DemoMessage>;
  newMessageContent: string;
  createRel: (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => Promise<Relation>;
  registerCreatedRelationInCurrentClassify: (backendRel: Relation) => Promise<string | null>;
  showAlert: (message: string) => void;
  secondaryRelationType: string;
  subType: string;
  sendTagRelation: (target: UnitSelection, tagLabel: string, subType?: string, customLabel?: string) => Promise<DemoEdge | null>;
  subTypeCustomLabel: string;
  setEdges: React.Dispatch<React.SetStateAction<DemoEdge[]>>;
}

export async function handleCreateRelationWithSourcesAndTargets(dependencies: HandleCreateRelationWithSourcesAndTargetsDependencies, params: {
  sources: UnitSelection[]; targets: UnitSelection[]; label: string;
}): Promise<void> {
  const { requireAuth, scopeMessageId, relationType, msgMap, newMessageContent, createRel, registerCreatedRelationInCurrentClassify, showAlert, secondaryRelationType, subType, sendTagRelation, subTypeCustomLabel, setEdges } = dependencies;
  if (!requireAuth()) return;
  if (!scopeMessageId) return;
  if (!relationType) return;
  const { sources, label } = params;
  // Deduplicate relation-message targets: when both a whole and edge selection exist for the same
  // relation message, keep only the whole (it covers all edges, preventing duplicate
  // targetRefs that the backend would reject and that GraphView would render as extra arrows).
  const targets = relationTargetUnits(params.targets,msgMap);
  const newEdgesList: DemoEdge[] = [];

  const buildEdges = (src: UnitSelection, tgt: UnitSelection, type: RelationType, lbl: string, relId: string) => {
    return {
      id: nextId("edge"),
      relationMessageId: relId,
      relationType: type,
      from: src,
      to: tgt,
      relationLabel: lbl,
    } as DemoEdge;
  };

  if (relationType === "notify") {
    const notifyPayload = buildRelationPayload({
      relationType: "NOTIFY",
      content: newMessageContent.trim() || "回复通知",
    });
    for (const src of sources) {
      for (const t of targets) {
        try {
          const backendRel = await createRel(scopeMessageId, {
            relationType: "NOTIFY",
            sourceMessageId: src.messageId,
            sourceRefs: [unitSelectionToReference(src, msgMap)],
            targetRefs: [unitSelectionToTargetRef(t, msgMap)],
            payload: notifyPayload,
          });
          await registerCreatedRelationInCurrentClassify(backendRel);
          newEdgesList.push(buildEdges({ ...src }, { ...t }, "notify", "notify", backendRel.id));
        } catch (e) { showAlert(`建立通知关系失败: ${sendErrorMessage(e)}`); }
      }
    }
  } else if (relationType === "reply") {
    // REPLY: 每条边一个关系消息（source→target 一一对应）
    const replyAdditional = secondaryRelationType === "question" || secondaryRelationType === "answer"
      ? secondaryRelationType
      : "none";
    const replyEdgeLabel = replyAdditional === "none" ? "reply" : replyAdditional;
    const replyPayload = buildRelationPayload({
      relationType: "REPLY",
      label: replyAdditional === "none" ? undefined : replyAdditional,
    });
    const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
    for (const srcId of uniqueSources) {
      const srcs = sources.filter(s => s.messageId === srcId);
      for (const srcUnit of srcs) {
        for (const t of targets) {
          try {
            const backendRel = await createRel(scopeMessageId, {
              relationType: "REPLY",
              sourceMessageId: srcId,
              sourceRefs: [unitSelectionToReference(srcUnit, msgMap)],
              targetRefs: [unitSelectionToTargetRef(t, msgMap)],
              payload: replyPayload,
            });
            const relId = backendRel.id;
            await registerCreatedRelationInCurrentClassify(backendRel);
            newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, "reply", replyEdgeLabel, relId));
          } catch (e) { showAlert(`建立回复关系失败: ${sendErrorMessage(e)}`); }
        }
      }
    }
  } else if (relationType === "agree" || relationType === "disagree") {
    // Relation messages are also messages — include relation-message sources
    const uniqueSources = Array.from(new Set(sources.map(source => source.messageId)));
    if (uniqueSources.length > 0) {
      for (const sourceId of uniqueSources) {
        for (const t of targets) {
          try {
            const backendRel = await createRel(scopeMessageId, { relationType: relationType.toUpperCase(), sourceMessageId: sourceId, sourceRefs: mergeUnits([], sources.filter(source => source.messageId === sourceId)).map(source => unitSelectionToReference(source, msgMap)), targetRefs: [unitSelectionToTargetRef(t, msgMap)] });
            await registerCreatedRelationInCurrentClassify(backendRel);
          } catch (e) { showAlert(`建立关系失败: ${sendErrorMessage(e)}`); }
        }
      }
    } else {
      // Pure-stance: no source — persist to backend (relation messages are first-class messages)
      for (const target of mergeUnits([], targets)) {
        try {
          const backendRel = await createRel(scopeMessageId, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [unitSelectionToTargetRef(target, msgMap)] });
          await registerCreatedRelationInCurrentClassify(backendRel);
        } catch (e) { showAlert(`建立关系失败: ${sendErrorMessage(e)}`); }
      }
    }
  } else if (relationType === "recommend" || relationType === "archive" || relationType === "attention" || relationType === "block") {
    // Annotation relations: user-to-message relations with no source message, one per target.
    // Source units are intentionally ignored — these relations never carry a source message.
    for (const target of mergeUnits([], targets)) {
      try {
        const payload: Record<string, unknown> = {};
        if (subType) { payload.subType = subType; if (subType === 'CUSTOM') { const ct = subTypeCustomLabel.trim(); if (ct) payload.customLabel = ct.slice(0, 20); } }
        const backendRel = await createRel(scopeMessageId, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [unitSelectionToTargetRef(target, msgMap)], payload: Object.keys(payload).length > 0 ? payload : undefined });
        const relId = backendRel.id;
        await registerCreatedRelationInCurrentClassify(backendRel);
        const anonSrcId = `anon:${backendRel.id}`;
        newEdgesList.push(buildEdges({ messageId: anonSrcId, selection: { kind: "whole" } }, target, relationType, label, relId));
      } catch (e) { showAlert(`建立关系失败: ${sendErrorMessage(e)}`); }
    }
  } else if (relationType === "tag") {
    // TAG: user-to-message relation with no source message; label stored as tagLabel.
    // Source units are intentionally ignored — TAG never uses a source text message.
    const tagLabel = label;
    for (const target of mergeUnits([], targets)) {
      const edge = await sendTagRelation(target, tagLabel, subType, subTypeCustomLabel);
      if (edge) newEdgesList.push(edge);
    }
  } else if (relationType === "reference") {
    // REFERENCE: 每条边一个关系消息（source→target 一一对应）
    const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
    const uniqueTargets = targets; // 不去重——每条边独立
    const refPayload = secondaryRelationType !== "none"
      ? buildRelationPayload({
        relationType: "reference",
        label: secondaryRelationType === "custom"
          ? (label || "自定义")
          : secondaryRelationType === "delegation" ? "完成委托" : secondaryRelationType,
      })
      : undefined;
    const refEdgeLabel = secondaryRelationType !== "none"
      ? (secondaryRelationType === "custom" ? (label || "自定义") : secondaryRelationLabel(secondaryRelationType))
      : "ref"; // none → default type label
    for (const srcId of uniqueSources) {
      const srcs = sources.filter(s => s.messageId === srcId);
      for (const srcUnit of srcs) {
        for (const t of uniqueTargets) {
          try {
            const backendRel = await createRel(scopeMessageId, {
              relationType: "REFERENCE",
              sourceMessageId: srcId,
              sourceRefs: [unitSelectionToReference(srcUnit, msgMap)],
              targetRefs: [unitSelectionToTargetRef(t, msgMap)],
              payload: refPayload,
            });
            const relId = backendRel.id;
            const newEdge = buildEdges({ ...srcUnit }, { ...t }, "reference", refEdgeLabel, relId);
            await registerCreatedRelationInCurrentClassify(backendRel);
            setEdges(prev => [...prev, newEdge]);
          } catch (e) { showAlert(`建立引用关系失败: ${sendErrorMessage(e)}`); }
        }
      }
    }
  } else if (relationType === "annotation") {
    // ANNOTATION: 每条边一个关系消息（source→target 一一对应）
    const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
    for (const srcId of uniqueSources) {
      const srcs = sources.filter(s => s.messageId === srcId);
      for (const srcUnit of srcs) {
        for (const t of targets) {
          try {
            const backendRel = await createRel(scopeMessageId, {
              relationType: "ANNOTATION",
              sourceMessageId: srcId,
              sourceRefs: [unitSelectionToReference(srcUnit, msgMap)],
              targetRefs: [unitSelectionToTargetRef(t, msgMap)],
            });
            const relId = backendRel.id;
            await registerCreatedRelationInCurrentClassify(backendRel);
            newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, "annotation", label, relId));
          } catch (e) { showAlert(`建立注释关系失败: ${sendErrorMessage(e)}`); }
        }
      }
    }
  } else {
    // Generic types (ARRANGE/CLASSIFY/MERGE/SUMMARY/PROPOSAL/CODE_CHANGE/OPERATIONS etc.) with source message.
    // CORRECT: single target only.
    if (relationType === "correct" && targets.length > 1) {
      showAlert("更正关系只能有一个目标");
      return;
    }
    const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
    for (const srcId of uniqueSources) {
      const srcs = sources.filter(s => s.messageId === srcId);
      for (const srcUnit of srcs) {
        const targetRefs = targets.map(t => unitSelectionToTargetRef(t, msgMap));
        try {
          const backendRel = await createRel(scopeMessageId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, sourceRefs: [unitSelectionToReference(srcUnit, msgMap)], targetRefs, payload: undefined });
          const relId = backendRel.id;
          await registerCreatedRelationInCurrentClassify(backendRel);
          for (const t of targets) {
            newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, relationType, label, relId));
          }
          if (secondaryRelationType !== "none" && relationType === "correct") {
            const secType = secondaryRelationType as RelationType;
            for (const t of targets) {
              newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, secType, label, relId));
            }
          }
        } catch (e) { showAlert(`建立关系失败: ${sendErrorMessage(e)}`); }
      }
    }
  }
  operationLog('创建关系', `type=${relationType} sources=${sources.length} targets=${targets.length} created=${newEdgesList.length} label=${label.slice(0, 80)}`);
  setEdges(prev => [...prev, ...newEdgesList]);
}

interface CreateJoinRelationsForContainerDependencies {
  effectiveJoinRelationIds?: ReadonlySet<string>;
  getDependentDisplayTarget: (messageId: string) => { messageId: string; dependencyId: string; } | null;
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  msgMap: Map<string, DemoMessage>;
  containerRelationTypes: Set<string>;
  relationsRef: React.MutableRefObject<Relation[]>;
  createRel: (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => Promise<Relation>;
  scopeMessageId: string;
  appendCreatedRelation: (backendRel: Relation) => Promise<null>;
}

export async function createJoinRelationsForContainer(dependencies: CreateJoinRelationsForContainerDependencies, containerId: string, _containerType: string, targetMids: Array<string | TargetRef>): Promise<boolean> {
  const { getDependentDisplayTarget, setSendError, msgMap, containerRelationTypes, relationsRef, createRel, scopeMessageId, appendCreatedRelation, effectiveJoinRelationIds } = dependencies;
  const invalidTarget = targetMids
    .map(target => typeof target === 'string' ? target : target.kind === 'relation' ? target.relationId : target.messageId)
    .map(messageId => getDependentDisplayTarget(messageId))
    .find(Boolean);
  if (invalidTarget) {
    setSendError(`消息 ${invalidTarget.messageId} 依赖消息 ${invalidTarget.dependencyId} 显示，不能创建加入消息`);
    return false;
  }
  if (targetMids.some(target => typeof target !== 'string' && (target.kind === 'text-fragment' || target.kind === 'relation' && target.part && target.part !== 'whole' || target.reference?.revision !== undefined || target.reference?.partId || target.reference?.memberId || target.reference?.path?.length || target.reference?.range))) {
    setSendError('加入消息必须选择当前完整消息，不能选择部件、文本片段或历史版本');
    return false;
  }
  const joinStake = 1;
  const uniqueTargets=[...new Map(targetMids.map(target=>[typeof target==='string'?target:target.kind==='relation'?target.relationId:target.messageId,target])).values()];
  for (const target of uniqueTargets) {
    try {
      const tgtMid = typeof target === 'string' ? target : target.kind === 'relation' ? target.relationId : target.messageId;
      const targetMessage = msgMap.get(tgtMid);
      const targetRelationType = targetMessage?.kind === 'relation'
        ? targetMessage.relationType?.toUpperCase()
        : undefined;
      const targetRef: TargetRef = typeof target === 'string'
        ? targetRelationType && containerRelationTypes.has(targetRelationType)
          ? { kind: 'relation', relationId: tgtMid }
          : { kind: 'message', messageId: tgtMid }
        : target;
      const existingJoin = relationsRef.current.find(relation =>
        relation.relationType?.toUpperCase() === 'JOIN' &&
        (effectiveJoinRelationIds ? effectiveJoinRelationIds.has(relation.id) : relation.state?.membershipActive === true) &&
        relation.sourceMessageId === containerId &&
        relation.targetRefs.some(ref => (ref.kind==='relation'?ref.relationId:ref.messageId)===tgtMid)
      );
      // Reusing a historical, inactive JOIN would leave the member outside the
      // requested container. Only an already effective placement is a no-op.
      if (existingJoin) continue;
      const relation = await createRel(scopeMessageId!, {
        relationType: 'JOIN',
        sourceMessageId: containerId,
        targetRefs: [targetRef],
        payload: {},
        stakeAmount: joinStake,
      });
      await appendCreatedRelation(relation);
    } catch (e) {
      operationLog('加入分类失败', `containerId=${containerId.slice(-6)} target=${typeof target === 'string' ? target.slice(-6) : (target.kind === 'relation' ? target.relationId : target.messageId).slice(-6)} error=${String(e)}`);
      throw e;
    }
  }
  return true;
}
