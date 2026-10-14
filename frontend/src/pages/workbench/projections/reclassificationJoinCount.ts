import type { Relation, TargetRef } from "../../../types";
import type {
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";

interface DeriveReclassificationJoinCountInput {
  relationType: RelationType | null;
  draftUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  relations: Relation[];
  rejectedJoinRelationIds: Set<string>;
}

export function deriveReclassificationJoinCount(input: DeriveReclassificationJoinCountInput): number {
  const { relationType, draftUnits, targetUnits, relations, rejectedJoinRelationIds } = input;
  if (relationType !== 'classify') return 0;
  const selectedIds = new Set((draftUnits.length > 0 ? draftUnits : targetUnits).map(unit => unit.messageId));
  if (selectedIds.size === 0) return 0;
  return relations.filter(relation =>
    (relation.relationType?.toUpperCase() === 'CLASSIFY' || relation.relationType?.toUpperCase() === 'SUMMARY') &&
    relations.some(join =>
      join.relationType?.toUpperCase() === 'JOIN' &&
      join.sourceMessageId === relation.id &&
      !rejectedJoinRelationIds.has(join.id) &&
      (join.targetRefs as TargetRef[]).some(ref =>
        selectedIds.has(ref.kind === 'relation' ? ref.relationId : ref.messageId)
      )
    )
  ).reduce((count, relation) => count + relations.filter(join =>
    join.relationType?.toUpperCase() === 'JOIN' &&
    join.sourceMessageId === relation.id &&
    !rejectedJoinRelationIds.has(join.id) &&
    (join.targetRefs as TargetRef[]).some(ref =>
      selectedIds.has(ref.kind === 'relation' ? ref.relationId : ref.messageId)
    )
  ).length, 0);
}
