import type {
  UnitSelection
} from "../../../utils/modelBridge";
import { correctionSelectionIsStale, hasActiveCorrectionForSelection, isContentKind } from "../../../utils/modelBridge";
import { preparePartCorrection } from "../../../utils/partCorrection";
import { generateCorrectionContent } from '../model/correction';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function prepareAddressedCorrection(dependencies: Pick<DraftSendDependencies, "msgMap" | "newMessageContent" | "setComparisonPopup" | "setSendError">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { msgMap, newMessageContent, setComparisonPopup, setSendError } = dependencies;
  try {
    const prepared = preparePartCorrection(msgMap.get(effectiveTargets[0].messageId)!, effectiveTargets[0], newMessageContent);
    setComparisonPopup({
      relMsgId: '__new-correction__', x: window.innerWidth / 2, y: window.innerHeight / 2,
      reversePreview: { ...prepared, mode: 'direct' }
    });
  } catch (error) { setSendError(error instanceof Error ? error.message : '无法修改所选部件'); }
  return;
}

export async function prepareTextCorrection(dependencies: Pick<DraftSendDependencies, "setSendError" | "msgMap" | "correctionVersions" | "blockCorrectionForSecondBettor" | "setComparisonPopup">, { effectiveTargets, text }: { effectiveTargets: UnitSelection[]; text: string; }): Promise<void> {
  const { setSendError, msgMap, correctionVersions, blockCorrectionForSecondBettor, setComparisonPopup } = dependencies;
  const correctionTarget = effectiveTargets[0];
  if (correctionTarget.selection.kind !== 'text') {
    setSendError('更正只能选择原始内容中的一个文本字段');
    return;
  }
  const originalContent = msgMap.get(correctionTarget.messageId)?.content ?? '';
  if (hasActiveCorrectionForSelection(correctionTarget.messageId, correctionTarget.selection, correctionVersions)) {
    setSendError('该字段已有未被反对的更正，不能重复发送');
    return;
  }
  const correctedContent = generateCorrectionContent(
    effectiveTargets,
    text,
    msgMap,
    originalContent,
  );
  if (correctedContent == null) {
    setSendError('更正只能针对一条文本消息或其片段');
    return;
  }
  if (correctionSelectionIsStale(
    originalContent,
    correctionTarget.selection,
  )) {
    setSendError('当前选择已不再匹配原始内容');
    return;
  }
  if (await blockCorrectionForSecondBettor(correctionTarget.messageId)) return;
  const beforeContent = originalContent;
  setComparisonPopup({
    relMsgId: '__new-correction__', x: window.innerWidth / 2, y: window.innerHeight / 2,
    reversePreview: { before: beforeContent, after: correctedContent, target: effectiveTargets[0], mode: 'direct' },
  });
  return;
}

export async function prepareCorrectionChain(dependencies: Pick<DraftSendDependencies, "showAlert" | "edges" | "msgMap" | "correctionVersions" | "setSendError" | "setComparisonPopup">, { effectiveTargets, text, label }: { effectiveTargets: UnitSelection[]; text: string; label: string; }): Promise<void> {
  const { showAlert, edges, msgMap, correctionVersions, setSendError, setComparisonPopup } = dependencies;
  const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
  if (uniqueTargetMids.length !== 1) {
    showAlert("更正关系目前仅支持单个目标消息");
    return;
  }
  const rawTargetMid = uniqueTargetMids[0];

  // Resolve correction chain: if the target is itself a correction source
  // (i.e., it corrects another message), find the ultimate ancestor so the
  // new CORRECT points directly to the origin, avoiding orphaned intermediate
  // correction messages (Bug 4 fix: chain corrections).
  let ancestorTargetMid = rawTargetMid;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(ancestorTargetMid)) break; // cycle guard
    visited.add(ancestorTargetMid);
    const parentEdge = edges.find(e =>
      e.relationType === 'correct' &&
      e.from.messageId === ancestorTargetMid &&
      !e.from.messageId.startsWith('anon:') &&
      (() => { const m = msgMap.get(e.to.messageId); return m && isContentKind(m.kind); })()
    );
    if (!parentEdge) break;
    ancestorTargetMid = parentEdge.to.messageId;
  }

  // Build effective targets pointing to the ancestor
  const resolvedTargets: UnitSelection[] = ancestorTargetMid === rawTargetMid
    ? effectiveTargets
    : effectiveTargets.map(u => ({ ...u, messageId: ancestorTargetMid }));

  const generated = generateCorrectionContent(
    resolvedTargets,
    text,
    msgMap,
    correctionVersions.get(ancestorTargetMid)?.current?.content,
  );
  if (generated === null) {
    showAlert("更正关系目标必须是普通文本消息");
    return;
  }
  if (correctionSelectionIsStale(
    correctionVersions.get(ancestorTargetMid)?.current?.content
    ?? msgMap.get(ancestorTargetMid)?.content
    ?? '',
    resolvedTargets[0].selection,
  )) {
    setSendError('当前片段已被其他更正修改，请基于最新内容新建更正');
    return;
  }
  const beforeContent = msgMap.get(ancestorTargetMid)?.content ?? generated;
  setComparisonPopup({
    relMsgId: '__new-correction__', x: window.innerWidth / 2, y: window.innerHeight / 2,
    reversePreview: { before: beforeContent, after: generated, target: resolvedTargets[0], mode: 'direct', label },
  });
  return;
}
