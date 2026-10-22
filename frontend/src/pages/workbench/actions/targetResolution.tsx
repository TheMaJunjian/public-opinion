import React from "react";
import type { Relation, TargetRef } from "../../../types";
import { getPresentationSpec } from "../../../types";
import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import type {
  DemoEdge,
  DemoMessage,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { isContentKind, unitSelectionToTargetRef } from "../../../utils/modelBridge";
import { createContainerOwnership, getContainerAncestorChain } from '../model/ownership';
import type { ContainerEffect } from '../model/containerEffect';
import { mergeUnits } from '../model/selection';

interface ContainerTargetDependencies {
  containerEffect?: Pick<ContainerEffect, 'ownership' | 'rejectedContainerIds' | 'joinByTarget'>;
}

function wholeMessageUnits(units: UnitSelection[]): UnitSelection[] {
  return mergeUnits([], units.filter(unit => isWholeMessageSelection(unit, unit.messageId)));
}

interface CollectExclusiveRelationMsgIdsDependencies {
  edges: DemoEdge[];
  msgMap: Map<string, DemoMessage>;
}

export function collectExclusiveRelationMsgIds(context: CollectExclusiveRelationMsgIdsDependencies, hiddenTextIds: Set<string>, ownedRelationIds: Set<string>): Set<string> {
  const { edges, msgMap } = context;
  const ids = new Set<string>();
  const edgesByRel = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = edgesByRel.get(e.relationMessageId) ?? [];
    arr.push(e);
    edgesByRel.set(e.relationMessageId, arr);
  }
  for (const [relMsgId, relEdges] of edgesByRel) {
    const relType = String(relEdges[0]?.relationType ?? '').toLowerCase();
    if (relType === 'classify' || relType === 'summary' || relType === 'merge' || relType === 'join') continue;
    if (ownedRelationIds.has(relMsgId)) continue;
    const textEndpoints = relEdges
      .flatMap(e => [e.from.messageId, e.to.messageId])
      .filter(mid => { const m = msgMap.get(mid); return m && isContentKind(m.kind); });
    if (textEndpoints.length > 0) {
      if (relType === 'reference') {
        // Cross-scope REFERENCE: only hide the relation message when its source
        // (from) message is classified/hidden.  If the source is visible but the
        // target is in another classify scope, the reference should still appear
        // alongside the source in the linear and graph views.
        const sourceHidden = relEdges.some(e => {
          const fromM = msgMap.get(e.from.messageId);
          return fromM && isContentKind(fromM.kind) && (hiddenTextIds.has(e.from.messageId) || ownedRelationIds.has(e.from.messageId));
        });
        if (sourceHidden) {
          ids.add(relMsgId);
        }
      } else if (textEndpoints.some(mid => hiddenTextIds.has(mid))) {
        ids.add(relMsgId);
      }
      continue;
    }
    // No text endpoints — all targets are relation messages.
    // Hide if any target relation is owned by a CLASSIFY/SUMMARY.
    const relEndpoints = relEdges
      .flatMap(e => [e.from.messageId, e.to.messageId])
      .filter(mid => msgMap.get(mid)?.kind === 'relation');
    if (relEndpoints.some(mid => ownedRelationIds.has(mid))) {
      ids.add(relMsgId);
    }
  }
  return ids;
}

interface GetGroupedTargetTextMessageIdsDependencies extends ContainerTargetDependencies {
  msgMap: Map<string, DemoMessage>;
  relationTypeByRelMsgId: Map<string, RelationType>;
  relationById: Map<string, Relation>;
}

export function getGroupedTargetTextMessageIds(context: GetGroupedTargetTextMessageIdsDependencies, units: UnitSelection[]): string[] {
  const { msgMap, relationTypeByRelMsgId, relationById } = context;
  const ownership = context.containerEffect?.ownership ?? createContainerOwnership([...relationById.values()]);
  const ids = new Set<string>();
  for (const unit of wholeMessageUnits(units)) {
    if (msgMap.get(unit.messageId)?.kind && isContentKind(msgMap.get(unit.messageId)!.kind)) {
      ids.add(unit.messageId);
      continue;
    }
    const relType = relationTypeByRelMsgId.get(unit.messageId);
    if (relType !== "classify" && relType !== "merge" && relType !== "arrange" && relType !== "summary") continue;
    const owned = ownership.owned(unit.messageId);
    owned.textIds.forEach(id => ids.add(id));
  }
  return [...ids];
}

interface PromoteCompleteContainerSelectionsDependencies extends ContainerTargetDependencies {
  relations: Relation[];
}

export function promoteCompleteContainerSelections(context: PromoteCompleteContainerSelectionsDependencies, units: UnitSelection[]): UnitSelection[] {
  const { relations } = context;
  let selected = mergeUnits([], units);
  const containerRelations = relations.filter(relation =>
    ['ARRANGE', 'MERGE', 'SUMMARY'].includes(relation.relationType?.toUpperCase() ?? '')
    && !context.containerEffect?.rejectedContainerIds.has(relation.id)
  );
  const ownership = context.containerEffect?.ownership ?? createContainerOwnership(relations);

  const selectedContainerIds = new Set(
    selected
      .filter(unit => isWholeMessageSelection(unit, unit.messageId) && unit.reference?.revision === undefined && containerRelations.some(container => container.id === unit.messageId))
      .map(unit => unit.messageId)
  );
  if (selectedContainerIds.size > 0) {
    const nestedSelectedIds = new Set<string>();
    for (const containerId of selectedContainerIds) {
      const owned = ownership.owned(containerId);
      owned.textIds.forEach(id => nestedSelectedIds.add(id));
      owned.relationIds.forEach(id => nestedSelectedIds.add(id));
    }
    selected = selected.filter(unit =>
      !isWholeMessageSelection(unit, unit.messageId) || unit.reference?.revision !== undefined || !nestedSelectedIds.has(unit.messageId) || selectedContainerIds.has(unit.messageId)
    );
  }

  // Repeatedly promote inner containers first, then their complete parents.
  let changed = true;
  while (changed) {
    changed = false;
    const selectedIds = new Set(wholeMessageUnits(selected).filter(unit => unit.reference?.revision === undefined).map(unit => unit.messageId));
    for (const container of containerRelations) {
      if (selectedIds.has(container.id)) continue;
      const owned = ownership.owned(container.id);
      if (owned.textIds.size === 0 || ![...owned.textIds].every(id => selectedIds.has(id))) continue;
      selected = [
        ...selected.filter(unit => !isWholeMessageSelection(unit, unit.messageId) || unit.reference?.revision !== undefined || !owned.textIds.has(unit.messageId)),
        { messageId: container.id, selection: { kind: 'whole' } },
      ];
      changed = true;
      break;
    }
  }
  return selected;
}

interface ResolveEffectiveTargetUnitsDependencies {
  msgMap: Map<string, DemoMessage>;
  promoteCompleteContainerSelections: (units: UnitSelection[]) => UnitSelection[];
}

export function resolveEffectiveTargetUnits(context: ResolveEffectiveTargetUnitsDependencies, draft: UnitSelection[], targets: UnitSelection[], currentRelationType: string | null): UnitSelection[] {
  const { msgMap, promoteCompleteContainerSelections } = context;
  const rawTargets = draft.length > 0 ? draft : targets;
  if (currentRelationType === 'correct') {
    const textTargets = rawTargets.filter(unit => unit.selection.kind === 'text');
    if (textTargets.length === 1 && rawTargets.every(unit => unit === textTargets[0] || isWholeMessageSelection(unit, textTargets[0].messageId))) {
      return textTargets;
    }
    return rawTargets;
  }
  if (rawTargets.some(unit => unit.reference || msgMap.get(unit.messageId)?.parts)) return rawTargets;
  return ['classify', 'summary', 'merge', 'arrange'].includes(currentRelationType ?? '')
    ? promoteCompleteContainerSelections(rawTargets) : rawTargets;
}

interface GetClassifyTargetRefsDependencies {
  msgMap: Map<string, DemoMessage>;
  organizationTargetRef: (unit: UnitSelection) => TargetRef;
  relationTypeByRelMsgId: Map<string, RelationType>;
}

export function getClassifyTargetRefs(context: GetClassifyTargetRefsDependencies, units: UnitSelection[]): TargetRef[] {
  const { msgMap, organizationTargetRef, relationTypeByRelMsgId } = context;
  if (units.some(unit => unit.reference || msgMap.get(unit.messageId)?.parts)) {
    return mergeUnits([], units).map(unit => organizationTargetRef(unit));
  }
  const res: TargetRef[] = [];
  const seen = new Set<string>();
  for (const u of wholeMessageUnits(units)) {
    const mid = u.messageId;
    const m = msgMap.get(mid);
    if (!m) continue;
    if (m.kind && isContentKind(m.kind)) {
      const key = `message:${mid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      res.push({ kind: "message", messageId: mid });
      continue;
    }
    const relType = relationTypeByRelMsgId.get(mid);
    if (relType !== "classify" && relType !== "merge" && relType !== "arrange" && relType !== "summary") {
      // Non-container relation types (proposal, code_change, operations etc.)
      // are treated as relation-kind targets — they become opaque cards when classified.
      if (relType !== undefined) {
        const key = "relation:" + mid;
        if (!seen.has(key)) {
          seen.add(key);
          res.push({ kind: "relation", relationId: mid });
        }
      }
      continue;
    }
    // All container types (classify/summary/arrange/merge): add as a single
    // relation-kind target.  The container itself joins the parent — its
    // children do NOT get individual join relations to the parent.
    const key = `relation:${mid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    res.push({ kind: "relation", relationId: mid });
  }
  return res;
}

interface OrganizationTargetRefDependencies {
  msgMap: Map<string, DemoMessage>;
}

export function organizationTargetRef(context: OrganizationTargetRefDependencies, unit: UnitSelection): TargetRef {
  const { msgMap } = context;
  const ref = unitSelectionToTargetRef(unit, msgMap);
  return !unit.reference && isWholeMessageSelection(unit, unit.messageId)
    ? { ...ref, reference: { messageId: unit.messageId } } : ref;
}

interface GetContainerMembershipTargetErrorDependencies extends ContainerTargetDependencies {
  relations: Relation[];
}

export function getContainerMembershipTargetError(context: GetContainerMembershipTargetErrorDependencies, units: UnitSelection[]): string | null {
  const { relations } = context;
  if (units.some(unit => !isWholeMessageSelection(unit, unit.messageId) || unit.reference?.revision !== undefined)) {
    return '组织成员需选择当前完整消息；已选元素、文本片段和历史版本可用于引用或讨论。';
  }
  const selectedIds = new Set(wholeMessageUnits(units).map(unit => unit.messageId));
  const blockedContainerIds = new Set(
    relations
      .filter(relation => ['ARRANGE', 'MERGE', 'SUMMARY'].includes(relation.relationType?.toUpperCase() ?? ''))
      .filter(relation => !context.containerEffect?.rejectedContainerIds.has(relation.id))
      .map(relation => relation.id)
  );
  const isSelectedMember = (ref: TargetRef, joinId: string): boolean => {
    const targetId = ref.kind === 'relation' ? ref.relationId : ref.messageId;
    return selectedIds.has(targetId)
      && (!context.containerEffect || context.containerEffect.joinByTarget.get(targetId) === joinId);
  };
  const memberships = relations.filter(relation => {
    if (relation.relationType?.toUpperCase() !== 'JOIN'
      || !relation.sourceMessageId
      || !blockedContainerIds.has(relation.sourceMessageId)) return false;
    return relation.targetRefs.some(ref => isSelectedMember(ref, relation.id));
  });
  const errors = memberships.flatMap(membership => {
    if (!membership.sourceMessageId) return [];
    const containerType = relations.find(relation => relation.id === membership.sourceMessageId)?.relationType?.toUpperCase();
    const containerTypeLabel = containerType === 'ARRANGE' ? '排列'
      : containerType === 'MERGE' ? '归并'
        : containerType === 'SUMMARY' ? '总结'
          : containerType ?? '未知';
    return membership.targetRefs
      .filter(ref => isSelectedMember(ref, membership.id))
      .map(ref => {
        const targetId = ref.kind === 'relation' ? ref.relationId : ref.messageId;
        return `消息(${targetId})已加入${containerTypeLabel}关系消息(${membership.sourceMessageId})，不能作为独立目标。`;
      });
  });
  return errors.length > 0
    ? `以下消息不能作为具体容器的独立目标：\n${[...new Set(errors)].join('\n')}`
    : null;
}

interface GetContainerCycleErrorDependencies {
  currentClassifyRelMsgId: string | null;
  latestClassifyRelMsgIdRef: React.MutableRefObject<string | null>;
  relationById: Map<string, Relation>;
  relations: Relation[];
}

export function getContainerCycleError(context: GetContainerCycleErrorDependencies, units: UnitSelection[]): string | null {
  const { currentClassifyRelMsgId, latestClassifyRelMsgIdRef, relationById, relations } = context;
  const currentContainerId = currentClassifyRelMsgId ?? latestClassifyRelMsgIdRef.current;
  if (!currentContainerId) return null;
  const current = relationById.get(currentContainerId);
  if (!current || !['CLASSIFY', 'MERGE', 'ARRANGE', 'SUMMARY'].includes(current.relationType.toUpperCase())) return null;
  const forbiddenIds = new Set([
    currentContainerId,
    ...getContainerAncestorChain(currentContainerId, relations),
  ]);
  const target = wholeMessageUnits(units).find(unit => forbiddenIds.has(unit.messageId));
  if (!target) return null;
  const targetType = relationById.get(target.messageId)?.relationType?.toUpperCase();
  const targetLabel = targetType === 'ARRANGE' ? '排列'
    : targetType === 'MERGE' ? '归并'
      : targetType === 'SUMMARY' ? '总结'
        : targetType === 'CLASSIFY' ? '分类'
          : '容器';
  return `不能将${targetLabel}消息(${target.messageId})作为目标，否则会形成容器循环。`;
}

interface GetJoinContainerCycleErrorDependencies {
  relationById: Map<string, Relation>;
  relations: Relation[];
}

export function getJoinContainerCycleError(context: GetJoinContainerCycleErrorDependencies, sourceContainerId: string, targetIds: string[]): string | null {
  const { relationById, relations } = context;
  const source = relationById.get(sourceContainerId);
  if (!source || !['CLASSIFY', 'MERGE', 'ARRANGE', 'SUMMARY'].includes(source.relationType.toUpperCase())) return null;
  for (const targetId of targetIds) {
    const target = relationById.get(targetId);
    if (!target || !['CLASSIFY', 'MERGE', 'ARRANGE', 'SUMMARY'].includes(target.relationType.toUpperCase())) continue;
    if (sourceContainerId !== targetId && !getContainerAncestorChain(sourceContainerId, relations).includes(targetId)) continue;
    const targetLabel = target.relationType.toUpperCase() === 'ARRANGE' ? '排列'
      : target.relationType.toUpperCase() === 'MERGE' ? '归并'
        : target.relationType.toUpperCase() === 'SUMMARY' ? '总结'
          : '分类';
    const sourceLabel = source.relationType.toUpperCase() === 'ARRANGE' ? '排列'
      : source.relationType.toUpperCase() === 'MERGE' ? '归并'
        : source.relationType.toUpperCase() === 'SUMMARY' ? '总结'
          : '分类';
    return `已有${targetLabel}消息(${targetId})不能加入${sourceLabel}消息(${sourceContainerId})，因为两者已存在包含关系，会形成容器循环。`;
  }
  return null;
}

interface GetDependentDisplayTargetsDependencies {
  relationById: Map<string, Relation>;
}

export function getDependentDisplayTargets(input: GetDependentDisplayTargetsDependencies, units: UnitSelection[]): { messageId: string; dependencyId: string; }[] {
  const { relationById } = input;
  const dependencies: Array<{ messageId: string; dependencyId: string }> = [];
  const dependentTypes = new Set(['ANNOTATION', 'REFERENCE', 'REPLY', 'CORRECT', 'AGREE', 'DISAGREE', 'TAG', 'JOIN']);
  const getFirstTargetId = (targetRefs: TargetRef[]): string | undefined => {
    const target = targetRefs.find(ref => ref.kind === 'relation' || ref.kind === 'message' || ref.kind === 'text-fragment');
    return target?.kind === 'relation' ? target.relationId : target?.messageId;
  };
  for (const unit of wholeMessageUnits(units)) {
    const relation = relationById.get(unit.messageId);
    if (!relation) continue;
    const relationType = relation.relationType.toUpperCase();
    if (!dependentTypes.has(relationType)) continue;
    const dependencyId = relationType === 'ANNOTATION'
      || relationType === 'REFERENCE'
      || relationType === 'REPLY'
      || relationType === 'CORRECT'
      ? relation.sourceMessageId
      : relationType === 'JOIN'
        ? relation.sourceMessageId
        : getFirstTargetId(relation.targetRefs);
    if (dependencyId && dependencyId !== unit.messageId) {
      dependencies.push({ messageId: unit.messageId, dependencyId });
    }
  }
  return dependencies;
}

interface GetDependentDisplayTargetDependencies {
  getDependentDisplayTargets: (units: UnitSelection[]) => Array<{ messageId: string; dependencyId: string; }>;
}

export function getDependentDisplayTarget(context: GetDependentDisplayTargetDependencies, messageId: string): { messageId: string; dependencyId: string; } | null {
  const { getDependentDisplayTargets } = context;
  return getDependentDisplayTargets([{ messageId, selection: { kind: 'whole' } }])[0] ?? null;
}

interface HasCrossNonReferenceTextLinkForClassifyTargetsDependencies extends ContainerTargetDependencies {
  effectiveTargetUnits: UnitSelection[];
  msgMap: Map<string, DemoMessage>;
  relationTypeByRelMsgId: Map<string, RelationType>;
  relationById: Map<string, Relation>;
  relations: Relation[];
  edges: DemoEdge[];
}

export function hasCrossNonReferenceTextLinkForClassifyTargets(context: HasCrossNonReferenceTextLinkForClassifyTargetsDependencies, targetTextIds: string[], selectionUnits: UnitSelection[] = context.effectiveTargetUnits): string | null {
  const { msgMap, relationTypeByRelMsgId, relationById, relations, edges } = context;
  const ownership = context.containerEffect?.ownership ?? createContainerOwnership([...relationById.values()]);
  const selected = new Set(targetTextIds);
  const selectedRelationIds = new Set<string>();
  const selectedContainerOwnedIds: Set<string>[] = [];
  for (const unit of selectionUnits) {
    if (!isWholeMessageSelection(unit, unit.messageId)) continue;
    if (msgMap.get(unit.messageId)?.kind !== 'relation') continue;
    selectedRelationIds.add(unit.messageId);
    const relationType = relationTypeByRelMsgId.get(unit.messageId);
    if (relationType === 'classify' || relationType === 'summary'
      || relationType === 'arrange' || relationType === 'merge') {
      // A selected container is an opaque target. Its nested messages are
      // not individually selected, but relations entirely inside it do not
      // cross the classification boundary.
      const owned = ownership.owned(unit.messageId);
      selectedContainerOwnedIds.push(new Set([
        unit.messageId,
        ...owned.textIds,
        ...owned.relationIds,
      ]));
    }
  }
  if (selected.size === 0 && selectedRelationIds.size === 0) return null;
  const selectedIds = new Set([...selected, ...selectedRelationIds]);
  const describe = (id: string): string => `(${id})`;
  const describeViolation = (fromId: string, toId: string, type: string): string =>
    `消息${describe(fromId)}与消息${describe(toId)}存在「${getPresentationSpec(type.toLowerCase()).label}」关系，不能只将其中一方加入分类；`;
  const crossesBoundary = (fromId: string, toId: string): boolean => {
    if (fromId === toId) return false;
    const fromMessage = msgMap.get(fromId);
    const toMessage = msgMap.get(toId);
    if (!fromMessage || !toMessage) return false;
    if (selectedContainerOwnedIds.some(owned => owned.has(fromId) && owned.has(toId))) return false;
    return selectedIds.has(fromId) !== selectedIds.has(toId);
  };

  // A directly selected text message inside an active, unselected MERGE container
  // cannot be classified independently. Do not expand selected containers
  // here, because their members are opaque targets.
  const directlySelectedTextIds = new Set(
    selectionUnits
      .filter(unit => isWholeMessageSelection(unit, unit.messageId) && isContentKind(msgMap.get(unit.messageId)?.kind ?? 'normal'))
      .map(unit => unit.messageId)
  );
  for (const merge of relations.filter(relation =>
    relation.relationType.toUpperCase() === 'MERGE' && !selectedRelationIds.has(relation.id)
    && !context.containerEffect?.rejectedContainerIds.has(relation.id)
  )) {
    const owned = ownership.owned(merge.id);
    const selectedId = [...directlySelectedTextIds].find(id => owned.textIds.has(id));
    if (selectedId) {
      return `消息(${selectedId})已在归并消息(${merge.id})中，不能建立分类关系。`;
    }
  }

  for (const e of edges) {
    if (context.containerEffect?.rejectedContainerIds.has(e.relationMessageId)) continue;
    // Citations and stances can cross scopes; they do not require shared membership.
    if (['reference', 'agree', 'disagree'].includes(e.relationType.toLowerCase())) continue;
    if (crossesBoundary(e.from.messageId, e.to.messageId)) {
      return describeViolation(e.from.messageId, e.to.messageId, e.relationType);
    }
  }

  // Re-check persisted relations because some relation endpoints (for
  // example content-kind messages or relation sources) may not have a
  // normal-to-normal DemoEdge after the graph is rebuilt.
  for (const relation of relations) {
    const relationType = relation.relationType.toUpperCase();
    // Container relations describe membership, not a semantic cross-link
    // between the selected messages and their surrounding messages.
    if (relationType === 'REFERENCE' || relationType === 'AGREE' || relationType === 'DISAGREE' || relationType === 'JOIN'
      || relationType === 'CLASSIFY' || relationType === 'SUMMARY'
      || relationType === 'ARRANGE' || relationType === 'MERGE') continue;
    const sourceId = relation.sourceMessageId;
    const endpointIds = [
      ...(sourceId ? [sourceId] : []),
      ...(relation.targetRefs ?? []).map(target => target.kind === 'relation' ? target.relationId : target.messageId),
    ].filter((id): id is string => Boolean(id));
    const selectedId = endpointIds.find(id => selectedIds.has(id));
    const outsideId = endpointIds.find(id => !selectedIds.has(id));
    if (selectedId && outsideId && crossesBoundary(selectedId, outsideId)) {
      return describeViolation(selectedId, outsideId, relationType);
    }
  }
  return null;
}

interface GetSelectedWholeMessageIdsDependencies {
  draftUnits: UnitSelection[];
}

export function getSelectedWholeMessageIds(context: GetSelectedWholeMessageIdsDependencies): string[] {
  const { draftUnits } = context;
  const ids = draftUnits.filter(u => isWholeMessageSelection(u, u.messageId)).map(u => u.messageId);
  return Array.from(new Set(ids));
}
