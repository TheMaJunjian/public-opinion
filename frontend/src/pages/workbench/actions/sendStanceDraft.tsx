import { sendErrorMessage } from './sendErrors';
import { clearBrowserSelection, relationTypeName } from "../../../utils/graphTextSelection";
import type {
  DemoEdge,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { unitSelectionToTargetRef } from "../../../utils/modelBridge";
import { mergeUnits, nextId } from '../model/selection';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendStanceDraft(dependencies: Pick<DraftSendDependencies, "msgMap" | "createRel" | "scopeMessageId" | "relationType" | "registerCreatedRelationInCurrentClassify" | "edgesRef" | "showAlert" | "setEdges" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setRelationType" | "setSecondaryRelationType">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { msgMap, createRel, scopeMessageId, relationType, registerCreatedRelationInCurrentClassify, edgesRef, showAlert, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setRelationType, setSecondaryRelationType } = dependencies;
  if (!relationType) return;
  // Agree/disagree: one relation per target. Edge created inside appendCreatedRelation
  // for AGREE/DISAGREE; for transformed RECOMMEND/ARCHIVE, create edge here.
  const newEdgesList2: DemoEdge[] = [];
  for (const target of mergeUnits([], effectiveTargets)) {
    const backendTargetRef = unitSelectionToTargetRef(target, msgMap);
    try {
      const backendRel = await createRel(scopeMessageId!, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [backendTargetRef] });
      await registerCreatedRelationInCurrentClassify(backendRel);
      // If backend transformed to RECOMMEND/ARCHIVE, create inline-badge edge
      const effectiveRelType = backendRel.relationType?.toUpperCase();
      if (effectiveRelType === 'RECOMMEND' || effectiveRelType === 'ARCHIVE') {
        const textTargets = (backendRel.targetRefs as Array<{ messageId?: string; }>)
          .filter(ref => ref.messageId).map(ref => ref.messageId!);
        for (const textMid of textTargets) {
          const already = edgesRef.current.some(ee => ee.relationMessageId === backendRel.id && ee.to.messageId === textMid)
            || newEdgesList2.some(ee => ee.relationMessageId === backendRel.id && ee.to.messageId === textMid);
          if (!already) {
            newEdgesList2.push({
              id: nextId("edge"),
              relationMessageId: backendRel.id,
              relationType: effectiveRelType.toLowerCase() as RelationType,
              from: { messageId: `anon:${backendRel.id}`, selection: { kind: "whole" } },
              to: { messageId: textMid, selection: { kind: "whole" } },
              relationLabel: relationTypeName(effectiveRelType.toLowerCase()),
            } as DemoEdge);
          }
        }
      }
    } catch (e) { showAlert(`建立关系失败: ${sendErrorMessage(e)}`); }
  }
  if (newEdgesList2.length > 0) setEdges(prev => [...prev, ...newEdgesList2]);
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setRelationType(null); setSecondaryRelationType("none");
  return;
}
