import { sendErrorMessage } from './sendErrors';
import { clearBrowserSelection } from "../../../utils/graphTextSelection";
import type { TargetRef } from "../../../types";
import type {
  DemoEdge,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { targetRefToUnit } from "../../../utils/modelBridge";
import { buildRelationPayload } from '../model/relationComposition';
import { nextId } from '../model/selection';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendArrangeDraft(dependencies: Pick<DraftSendDependencies, "sourceUnits" | "relationById" | "targetUnits" | "organizationTargetRef" | "createJoinRelationsForContainer" | "setEdges" | "showAlert" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setNewMessageContent" | "setRelationType" | "setSecondaryRelationType" | "handleSendMessageOnly" | "secondaryRelationType" | "createRel" | "scopeMessageId" | "registerCreatedRelationInCurrentClassify">, { text, effectiveTargets }: { text: string; effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { sourceUnits, relationById, targetUnits, organizationTargetRef, createJoinRelationsForContainer, setEdges, showAlert, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType, handleSendMessageOnly, secondaryRelationType, createRel, scopeMessageId, registerCreatedRelationInCurrentClassify } = dependencies;
  // Check if sourceUnits has an existing ARRANGE relation (append mode)
  const existingArrangeSource = sourceUnits.find(u => {
    const rel = relationById.get(u.messageId);
    return rel && rel.relationType === 'ARRANGE';
  });
  if (existingArrangeSource && targetUnits.length > 0) {
    // Append targets to existing ARRANGE
    const existingRel = relationById.get(existingArrangeSource.messageId)!;
    const existingTargetRefs = (existingRel.targetRefs ?? []) as TargetRef[];
    const existingTargetKeys = new Set(existingTargetRefs.map(r => `${r.kind}:${r.kind === 'relation' ? r.relationId : r.messageId}`));
    const newTargetRefs: TargetRef[] = [];
    const newTargetMids: string[] = [];
    for (const u of targetUnits) {
      const tr = organizationTargetRef(u);
      const key = `${tr.kind}:${tr.kind === 'relation' ? tr.relationId : tr.messageId}`;
      if (!existingTargetKeys.has(key)) {
        newTargetRefs.push(tr);
        // For edges: use the message/relation ID for the to endpoint
        const mid = tr.kind === 'relation' ? tr.relationId : tr.messageId;
        newTargetMids.push(mid);
        existingTargetKeys.add(key);
      }
    }
    if (newTargetRefs.length > 0) {
      try {
        await createJoinRelationsForContainer(existingRel.id, 'ARRANGE', newTargetRefs);
        // Add edges from the existing ARRANGE to new targets
        const layout = existingRel.payload?.targetLayout;
        const edgeLabel = layout === 'single-row' ? 'arrange-h' : 'arrange-v';
        const anonSrcId = `anon:${existingRel.id}`;
        const newEdges: DemoEdge[] = newTargetMids.map(tgtMid => ({
          id: nextId("edge"),
          relationMessageId: existingRel.id,
          relationType: "arrange" as RelationType,
          from: { messageId: anonSrcId, selection: { kind: "whole" as const } },
          to: { messageId: tgtMid, selection: { kind: "whole" as const } },
          relationLabel: edgeLabel,
        }));
        setEdges(prev => {
          const existingKeys = new Set(prev.map(e => `${e.relationMessageId}::${e.to.messageId}`));
          const filtered = newEdges.filter(e => !existingKeys.has(`${e.relationMessageId}::${e.to.messageId}`));
          return [...prev, ...filtered];
        });
      } catch (e) {
        showAlert(`追加到排列框架失败: ${sendErrorMessage(e)}`);
      }
    }
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
    setNewMessageContent("");
    setRelationType(null); setSecondaryRelationType("none");
    return;
  }

  // Create new ARRANGE (no existing arrange source)
  const newEdgesList: DemoEdge[] = [];
  let extraTargetMid: string | null = null;
  if (text.length > 0) {
    const msg = await handleSendMessageOnly(text);
    if (!msg) return;
    extraTargetMid = msg.id;
  }
  const allTargets: UnitSelection[] = extraTargetMid ? [...effectiveTargets, { messageId: extraTargetMid, selection: { kind: 'whole' } }] : effectiveTargets;
  const targetRefs = allTargets.map(organizationTargetRef);
  // Determine targetLayout from secondaryRelationType: 'single-column' (纵) or 'single-row' (横)
  const targetLayout = secondaryRelationType === 'horizontal' ? 'single-row' as const : 'single-column' as const;
  try {
    const backendRel = await createRel(scopeMessageId!, {
      relationType: 'ARRANGE',
      sourceMessageId: null,
      targetRefs,
      payload: buildRelationPayload({ relationType: 'ARRANGE', targetLayout }),
    });
    const relId = backendRel.id;
    // Encode layout direction in relationLabel so layout engine can read it directly
    const edgeLabel = secondaryRelationType === 'horizontal' ? 'arrange-h' : 'arrange-v';
    await registerCreatedRelationInCurrentClassify(backendRel);
    const anonSrcId = `anon:${backendRel.id}`;
    for (const target of allTargets) {
      newEdgesList.push({
        id: nextId("edge"), relationMessageId: relId, relationType: "arrange",
        from: { messageId: anonSrcId, selection: { kind: "whole" } },
        to: targetRefToUnit(organizationTargetRef(target)),
        relationLabel: edgeLabel,
      } as DemoEdge);
    }
  } catch (e) { showAlert(`建立排列关系失败: ${sendErrorMessage(e)}`); }
  setEdges(prev => [...prev, ...newEdgesList]);
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent("");
  setRelationType(null); setSecondaryRelationType("none");
  return;
}
