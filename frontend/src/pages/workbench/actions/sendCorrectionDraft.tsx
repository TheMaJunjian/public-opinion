import type {
  UnitSelection
} from "../../../utils/modelBridge";
import { correctionSelectionIsStale, isContentKind, withCorrectionContent } from "../../../utils/modelBridge";
import { mapCorrectionSelection, preparePartCorrection } from "../../../utils/partCorrection";
import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import { generateCorrectionContent } from '../model/correction';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function prepareAddressedCorrection(dependencies: Pick<DraftSendDependencies, "msgMap" | "correctionVersions" | "newMessageContent" | "setComparisonPopup" | "setSendError" | "secondaryRelationType">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { msgMap, newMessageContent, setComparisonPopup, setSendError } = dependencies;
  try {
    let target = effectiveTargets[0];
    const message = msgMap.get(target.messageId)!;
    if (isWholeMessageSelection(target, message.id)) {
      const body = message.parts?.find(part => ['text', 'code', 'web'].includes(part.type));
      if (body) target = { ...target, reference: { messageId: message.id, revision: message.revision ?? 1, partId: body.id, path: [body.type === 'code' ? 'source' : body.type === 'web' ? 'excerpt' : 'text'] } };
    }
    let replacement = newMessageContent;
    const current = dependencies.correctionVersions.get(message.id)?.current;
    if (target.reference?.range) {
      const displayed = current ? withCorrectionContent(message, current.content, current.changes, current.snapshot) : message;
      let offset = 0;
      for (const part of message.parts ?? []) {
        if (part.type !== 'text' && part.type !== 'code' && part.type !== 'web') continue;
        const original = part.type === 'text' ? part.text : part.type === 'code' ? part.source : part.excerpt || part.url;
        if (part.id !== target.reference.partId) { offset += original.length + 1; continue; }
        const shown = displayed.parts?.find(candidate => candidate.id === part.id);
        const content = shown?.type === 'text' ? shown.text : shown?.type === 'code' ? shown.source : shown?.type === 'web' ? shown.excerpt || shown.url : original;
        if (target.selection.kind === 'text' && content.slice(target.reference.range.start, target.reference.range.end) !== target.selection.text)
          throw new Error('显示的正文已变化，请重新选字');
        // DOM ranges are local to a part; effective changes use full-body offsets.
        const changes = (current?.changes ?? []).filter(change => change.start >= offset && change.end <= offset + original.length)
          .map(change => ({ ...change, start: change.start - offset, end: change.end - offset }));
        if (changes.length) {
          const mapped = mapCorrectionSelection(original, content, changes, target.reference.range, replacement);
          target = { ...target, reference: { ...target.reference, range: mapped.range }, selection: {
            kind: 'text', start: mapped.range.start, len: mapped.range.end - mapped.range.start, text: original.slice(mapped.range.start, mapped.range.end),
          } };
          replacement = mapped.value;
        }
        break;
      }
    }
    const prepared = preparePartCorrection(message, target, replacement);
    setComparisonPopup({
      relMsgId: '__new-correction__', x: window.innerWidth / 2, y: window.innerHeight / 2,
      reversePreview: { ...prepared, mode: 'direct', correctionKind: 'TEXT' }
    });
  } catch (error) { setSendError(error instanceof Error ? error.message : '无法修改所选部件'); }
  return;
}

export async function prepareTextCorrection(dependencies: Pick<DraftSendDependencies, "setSendError" | "msgMap" | "correctionVersions" | "blockCorrectionForSecondBettor" | "setComparisonPopup" | "secondaryRelationType">, { effectiveTargets, text }: { effectiveTargets: UnitSelection[]; text: string; }): Promise<void> {
  const { setSendError, msgMap, setComparisonPopup } = dependencies;
  const correctionTarget = effectiveTargets[0];
  if (correctionTarget.selection.kind !== 'text') {
    setSendError('更正只能选择原始内容中的一个文本字段');
    return;
  }
  const originalContent = msgMap.get(correctionTarget.messageId)?.content ?? '';
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
  const beforeContent = originalContent;
  setComparisonPopup({
    relMsgId: '__new-correction__', x: window.innerWidth / 2, y: window.innerHeight / 2,
    reversePreview: { before: beforeContent, after: correctedContent, target: effectiveTargets[0], mode: 'direct', correctionKind: 'TEXT' },
  });
  return;
}

export async function prepareCorrectionChain(dependencies: Pick<DraftSendDependencies, "showAlert" | "edges" | "msgMap" | "correctionVersions" | "setSendError" | "setComparisonPopup" | "secondaryRelationType">, { effectiveTargets, text, label }: { effectiveTargets: UnitSelection[]; text: string; label: string; }): Promise<void> {
  const { showAlert, edges, msgMap, setSendError, setComparisonPopup } = dependencies;
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
    msgMap.get(ancestorTargetMid)?.content,
  );
  if (generated === null) {
    showAlert("更正关系目标必须是普通文本消息");
    return;
  }
  if (correctionSelectionIsStale(
    msgMap.get(ancestorTargetMid)?.content
    ?? '',
    resolvedTargets[0].selection,
  )) {
    setSendError('当前片段已被其他更正修改，请基于最新内容新建更正');
    return;
  }
  const beforeContent = msgMap.get(ancestorTargetMid)?.content ?? generated;
  setComparisonPopup({
    relMsgId: '__new-correction__', x: window.innerWidth / 2, y: window.innerHeight / 2,
    reversePreview: { before: beforeContent, after: generated, target: resolvedTargets[0], mode: 'direct', label, correctionKind: 'TEXT' },
  });
  return;
}
