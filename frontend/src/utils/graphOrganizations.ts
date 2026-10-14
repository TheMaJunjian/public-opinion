import type { DemoMessage, DemoEdge } from './modelBridge';
import { getPresentationSpec, PRESENTATION_SPECS } from '../types';
import { hasActiveDisplayEffect } from './messageDisplay';
import type { FrameBlock } from './frameLayout';

export function buildFrameBlocks(params: {
  edges: DemoEdge[];
  visibleCardIds: Set<string>;
  msgMap: Map<string, DemoMessage>;
  keepEmptyFrameIds?: Set<string>;
  traceMode?: boolean;
}): FrameBlock[] {
  const { edges, visibleCardIds, msgMap, keepEmptyFrameIds = new Set<string>(), traceMode = false } = params;
  const grouped = new Map<string, DemoEdge[]>();
  for (const edge of edges) {
    if (!traceMode && !hasActiveDisplayEffect(edge, msgMap)) continue;
    const list = grouped.get(edge.relationMessageId) ?? [];
    list.push(edge); grouped.set(edge.relationMessageId, list);
  }
  const isFrame = (type: string, messageId?: string) => {
    const parts = messageId ? msgMap.get(messageId)?.parts : undefined;
    if (parts) return ['classify', 'summary', 'merge', 'arrange'].includes(type.toLowerCase());
    const spec = getPresentationSpec(type);
    return ['arrange-frame', 'frame-group', 'replace-overlay'].includes(spec.kind)
      || !(type.toUpperCase() in PRESENTATION_SPECS);
  };
  const blocks = new Map<string, FrameBlock>();
  for (const [id, relations] of grouped) {
    const type = relations[0]?.relationType;
    if (!type || !isFrame(type, id)) continue;
    const cardIds = new Set<string>();
    const source = relations[0].from.messageId;
    if (source !== id && visibleCardIds.has(source)) cardIds.add(source);
    for (const relation of relations) {
      const target = relation.to.messageId;
      if (target !== id && (visibleCardIds.has(target) || isFrame(grouped.get(target)?.[0]?.relationType ?? 'REPLY', target))) cardIds.add(target);
    }
    if (!cardIds.size && !keepEmptyFrameIds.has(id)) continue;
    const message = msgMap.get(id);
    const display = message?.parts?.find(part => part.type === 'display');
    const targetLayout = display?.type === 'display'
      ? display.layout === 'row' ? 'single-row' : display.layout === 'columns' ? 'multi-column' : 'single-column'
      : message?.relationPayload?.targetLayout;
    blocks.set(id, { relMsgId: id, cardIds, directCardIds: new Set(), childRelMsgIds: [],
      isMerge: type === 'merge', hasGroupHeader: type === 'classify' || type === 'summary', targetLayout });
  }
  const parent = new Map<string, string>();
  const attach = (child: string, owner: string) => {
    if (child === owner || parent.has(child)) return false;
    let ancestor: string | undefined = owner;
    while (ancestor && ancestor !== child) ancestor = parent.get(ancestor);
    if (ancestor) return false;
    parent.set(child, owner); blocks.get(owner)!.childRelMsgIds.push(child);
    return true;
  };
  for (const block of blocks.values()) for (const relation of grouped.get(block.relMsgId) ?? []) {
    if (blocks.has(relation.to.messageId)) attach(relation.to.messageId, block.relMsgId);
  }
  // Exported snapshots predating membership parts represented nesting with shared
  // target sets. Keep their replay behavior; never infer ownership for new messages.
  if (!traceMode) {
    const legacy = [...blocks.values()].filter(block => !msgMap.get(block.relMsgId)?.parts);
    const sets = new Map(legacy.map(block => [block.relMsgId, new Set([...block.cardIds].filter(id => !blocks.has(id)))]));
    const candidates = [...legacy].sort((a, b) => sets.get(a.relMsgId)!.size - sets.get(b.relMsgId)!.size);
    for (const child of candidates) {
      if (parent.has(child.relMsgId)) continue;
      const childSet = sets.get(child.relMsgId)!;
      if (!childSet.size) continue;
      for (const owner of candidates) {
        const ownerSet = sets.get(owner.relMsgId)!;
        if (ownerSet.size <= childSet.size || ![...childSet].every(id => ownerSet.has(id))) continue;
        if (attach(child.relMsgId, owner.relMsgId)) break;
      }
    }
  }
  const descendants = new Map<string, Set<string>>();
  const collect = (id: string): Set<string> => {
    const known = descendants.get(id);
    if (known) return known;
    const block = blocks.get(id)!;
    const all = new Set(block.cardIds);
    descendants.set(id, all);
    const childCards = new Set<string>();
    for (const child of block.childRelMsgIds) {
      childCards.add(child); block.cardIds.add(child); all.add(child);
      for (const member of collect(child)) { all.add(member); childCards.add(member); }
    }
    block.directCardIds = new Set([...block.cardIds].filter(member => !childCards.has(member)));
    return all;
  };
  for (const id of blocks.keys()) collect(id);
  return [...blocks.values()];
}
