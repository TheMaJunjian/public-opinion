import { sendErrorMessage } from './sendErrors';
import { clearBrowserSelection } from "../../../utils/graphTextSelection";
import type {
  UnitSelection
} from "../../../utils/modelBridge";
import { unitSelectionToTargetRef } from "../../../utils/modelBridge";
import { mergeUnits } from '../model/selection';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendStanceDraft(dependencies: Pick<DraftSendDependencies, "msgMap" | "createRel" | "scopeMessageId" | "relationType" | "registerCreatedRelationInCurrentClassify" | "edgesRef" | "showAlert" | "setEdges" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setRelationType" | "setSecondaryRelationType">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { msgMap, createRel, scopeMessageId, relationType, registerCreatedRelationInCurrentClassify, showAlert, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setRelationType, setSecondaryRelationType } = dependencies;
  if (!relationType) return;
  for (const target of mergeUnits([], effectiveTargets)) {
    const backendTargetRef = unitSelectionToTargetRef(target, msgMap);
    try {
      const backendRel = await createRel(scopeMessageId!, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [backendTargetRef] });
      await registerCreatedRelationInCurrentClassify(backendRel);
    } catch (e) { showAlert(`建立关系失败: ${sendErrorMessage(e)}`); }
  }
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setRelationType(null); setSecondaryRelationType("none");
  return;
}
