import { clearBrowserSelection, relationTypeName } from "../../../utils/graphTextSelection";
import type { Relation } from "../../../types";
import type {
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { nextId } from '../model/selection';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendOrganizationJoin(dependencies: Pick<DraftSendDependencies, "sourceUnits" | "relationsRef" | "appendContainerType" | "setSendError" | "getJoinContainerCycleError" | "showAlert" | "createJoinRelationsForContainer" | "setEdges" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "newMessageContent" | "savedTextOnTypeSwitchRef" | "setNewMessageContent" | "setSubType" | "setRelationType" | "setSecondaryRelationType">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { sourceUnits, relationsRef, appendContainerType, setSendError, getJoinContainerCycleError, showAlert, createJoinRelationsForContainer, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, newMessageContent, savedTextOnTypeSwitchRef, setNewMessageContent, setSubType, setRelationType, setSecondaryRelationType } = dependencies;
  const containerSource = sourceUnits
    .map(unit => relationsRef.current.find(relation => relation.id === unit.messageId))
    .find((relation): relation is Relation => relation?.relationType?.toUpperCase() === appendContainerType);
  if (!containerSource) {
    setSendError('追加容器内容时只能选择一个同类型容器作为来源');
    return;
  }
  const targetIds = Array.from(new Set(effectiveTargets.map(unit => unit.messageId)));
  const joinCycleError = getJoinContainerCycleError(containerSource.id, targetIds);
  if (joinCycleError) {
    showAlert(joinCycleError);
    return;
  }
  const joinCreated = await createJoinRelationsForContainer(containerSource.id, appendContainerType!, targetIds);
  if (!joinCreated) return;
  if (appendContainerType === 'ARRANGE' || appendContainerType === 'MERGE' || appendContainerType === 'SUMMARY') {
    const isArrangeAppend = appendContainerType === 'ARRANGE';
    const isMergeAppend = appendContainerType === 'MERGE';
    const layout = containerSource.payload?.targetLayout;
    const edgeLabel = isArrangeAppend
      ? layout === 'single-row' ? 'arrange-h' : 'arrange-v'
      : relationTypeName(isMergeAppend ? 'merge' : 'summary');
    const newEdges = targetIds.map(targetId => ({
      id: nextId('edge'),
      relationMessageId: containerSource.id,
      relationType: (isArrangeAppend ? 'arrange' : isMergeAppend ? 'merge' : 'summary') as RelationType,
      from: { messageId: `anon:${containerSource.id}`, selection: { kind: 'whole' as const } },
      to: { messageId: targetId, selection: { kind: 'whole' as const } },
      relationLabel: edgeLabel,
    }));
    setEdges(prev => {
      const existingKeys = new Set(prev.map(edge => `${edge.relationMessageId}::${edge.to.messageId}`));
      return [...prev, ...newEdges.filter(edge => !existingKeys.has(`${edge.relationMessageId}::${edge.to.messageId}`))];
    });
  }
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  if (!newMessageContent && savedTextOnTypeSwitchRef.current) setNewMessageContent(savedTextOnTypeSwitchRef.current);
  savedTextOnTypeSwitchRef.current = '';
  setSubType("");
  setRelationType(null); setSecondaryRelationType("none");
  return;
}
