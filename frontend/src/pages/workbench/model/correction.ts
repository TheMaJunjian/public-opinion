import { computeCharDiff } from '../../../components/CharDiffText';
import type { DemoEdge, DemoMessage, UnitSelection } from '../../../utils/modelBridge';
import { isContentKind } from '../../../utils/modelBridge';
import { selKey } from './selection';

export const CORRECTABLE_RELATION_TYPES = new Set([
  'classify', 'summary', 'proposal', 'delegation', 'code_change', 'operations',
]);

export function isCorrectableCorrectionTarget(message: DemoMessage | undefined): boolean {
  return message?.kind === 'normal'
    || (message?.kind === 'relation' && CORRECTABLE_RELATION_TYPES.has(message.relationType ?? ''));
}

export function expandTextIdsWithCorrections(
  textIds: Set<string>,
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): Set<string> {
  const expanded = new Set(textIds);
  const queue = Array.from(textIds);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const tid = queue.shift()!;
    if (visited.has(tid)) continue;
    visited.add(tid);
    for (const e of edges) {
      if (e.relationType !== 'correct' || e.proposalOnly) continue;
      if (msgMap.get(e.from.messageId)?.kind !== 'normal' || msgMap.get(e.to.messageId)?.kind !== 'normal') continue;
      if (e.from.messageId === tid && !expanded.has(e.to.messageId)) {
        expanded.add(e.to.messageId);
        queue.push(e.to.messageId);
      } else if (e.to.messageId === tid && !expanded.has(e.from.messageId)) {
        expanded.add(e.from.messageId);
        queue.push(e.from.messageId);
      }
    }
  }
  return expanded;
}

export function generateCorrectionContent(
  targetUnits: UnitSelection[],
  replacementText: string,
  msgMap: Map<string, DemoMessage>,
  baseContent?: string,
): string | null {
  const uniqueTargetMids = Array.from(new Set(targetUnits.map(u => u.messageId)));
  if (uniqueTargetMids.length !== 1) return null;
  const targetMid = uniqueTargetMids[0];
  const targetMsg = msgMap.get(targetMid);
  if (!targetMsg || !isCorrectableCorrectionTarget(targetMsg)) return null;

  const textFragments = targetUnits
    .filter(u => u.selection.kind === 'text')
    .map(u => u.selection as { kind: 'text'; start: number; len: number; text: string });

  if (textFragments.length > 0) {
    const sorted = [...textFragments].sort((a, b) => b.start - a.start);
    let content = baseContent ?? targetMsg.content;
    for (const frag of sorted) {
      content = content.slice(0, frag.start) + replacementText + content.slice(frag.start + frag.len);
    }
    return content;
  }

  return replacementText;
}

export function formatCorrectionRange(start: number, len: number, text: string): string {
  return `start=${start} len=${len} "${text}"`;
}

export function getCorrectionChangeSummary(original: string, corrected: string): {
  removed: string;
  added: string;
} {
  const { origParts, nextParts } = computeCharDiff(original, corrected);
  return {
    removed: origParts.filter(part => part.type === 'del').map(part => part.text).join(''),
    added: nextParts.filter(part => part.type === 'ins').map(part => part.text).join(''),
  };
}

function buildTextCorrectionReplacementMap(
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): Map<string, string> {
  const raw = new Map<string, string>();
  for (const e of edges) {
    if (e.relationType !== 'correct' || e.proposalOnly) continue;
    if (e.from.messageId.startsWith('anon:')) continue;
    const fromMsg = msgMap.get(e.from.messageId);
    const toMsg = msgMap.get(e.to.messageId);
    if (fromMsg?.kind !== 'normal' || toMsg?.kind !== 'normal') continue;
    raw.set(e.to.messageId, e.from.messageId);
  }
  const resolved = new Map<string, string>();
  function resolve(id: string, seen = new Set<string>()): string {
    const next = raw.get(id);
    if (!next) return id;
    if (seen.has(id)) return id;
    seen.add(id);
    const finalId = resolve(next, seen);
    resolved.set(id, finalId);
    return finalId;
  }
  for (const oldId of raw.keys()) resolve(oldId);
  return resolved;
}

export function applyTextCorrectionInheritance(
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): DemoEdge[] {
  const replaceMap = buildTextCorrectionReplacementMap(edges, msgMap);
  if (replaceMap.size === 0) return edges;
  const next: DemoEdge[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const e of edges) {
    if (e.relationType === 'correct') {
      next.push(e);
      continue;
    }
    const fromIsNormal = (() => { const m = msgMap.get(e.from.messageId); return m && isContentKind(m.kind); })();
    const toIsNormal = (() => { const m = msgMap.get(e.to.messageId); return m && isContentKind(m.kind); })();
    const mappedFrom = fromIsNormal ? (replaceMap.get(e.from.messageId) ?? e.from.messageId) : e.from.messageId;
    const mappedTo = toIsNormal ? (replaceMap.get(e.to.messageId) ?? e.to.messageId) : e.to.messageId;
    const updated: DemoEdge = (mappedFrom === e.from.messageId && mappedTo === e.to.messageId)
      ? e
      : {
        ...e,
        from: { ...e.from, messageId: mappedFrom },
        to: { ...e.to, messageId: mappedTo },
      };
    const edgeKey = `${updated.relationMessageId}::${updated.relationType}::${selKey(updated.from)}::${selKey(updated.to)}::${updated.relationLabel}`;
    if (seen.has(edgeKey)) {
      changed = true;
      continue;
    }
    seen.add(edgeKey);
    if (updated !== e) changed = true;
    next.push(updated);
  }
  if (!changed && next.length === edges.length) return edges;
  return next;
}
