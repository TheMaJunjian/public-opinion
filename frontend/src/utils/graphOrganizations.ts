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
  opaqueFrameIds?:ReadonlySet<string>;
  cardFrameIds?:ReadonlySet<string>;
}): FrameBlock[] {
  const { edges, visibleCardIds, msgMap, keepEmptyFrameIds = new Set<string>(), traceMode = false,opaqueFrameIds } = params;
  const grouped = new Map<string, DemoEdge[]>();
  for (const edge of edges) {
    if (!traceMode && !hasActiveDisplayEffect(edge, msgMap)) continue;
    const list = grouped.get(edge.relationMessageId) ?? [];
    list.push(edge); grouped.set(edge.relationMessageId, list);
  }
  const isFrame = (type: string, messageId?: string) => {
    if(messageId&&opaqueFrameIds?.has(messageId))return false;
    const declaration=messageId?msgMap.get(messageId):undefined;
    const parts = declaration?.parts;
    if (parts) return ['classify', 'summary', 'merge', 'arrange'].includes(type.toLowerCase());
    const spec = getPresentationSpec(type);
    return ['arrange-frame', 'frame-group', 'replace-overlay'].includes(spec.kind)
      || !(type.toUpperCase() in PRESENTATION_SPECS)&&declaration?.kind==='relation';
  };
  const blocks = new Map<string, FrameBlock>();
  // A restored organization may have no effective membership edges left.
  for (const id of keepEmptyFrameIds) if (!grouped.has(id) && msgMap.get(id)?.relationType) grouped.set(id, []);
  for (const [id, relations] of grouped) {
    const type = relations[0]?.relationType ?? msgMap.get(id)?.relationType;
    if (!type || !isFrame(type, id)) continue;
    const cardIds = new Set<string>();
    const source = relations[0]?.from.messageId;
    if (source && source !== id && visibleCardIds.has(source)) cardIds.add(source);
    for (const relation of relations) {
      const target = relation.to.messageId;
      const targetType = grouped.get(target)?.[0]?.relationType
        ?? (keepEmptyFrameIds.has(target) ? msgMap.get(target)?.relationType : undefined);
      if (target !== id && (visibleCardIds.has(target) || isFrame(targetType ?? 'REPLY', target))) cardIds.add(target);
    }
    if (!cardIds.size && !keepEmptyFrameIds.has(id)) continue;
    const message = msgMap.get(id);
    const display = message?.parts?.find(part => part.type === 'display');
    const targetLayout = display?.type === 'display'
      ? display.layout === 'row' ? 'single-row' : display.layout === 'columns' ? 'multi-column' : 'single-column'
      : message?.relationPayload?.targetLayout;
    blocks.set(id, { relMsgId: id, cardIds, directCardIds: new Set(), childRelMsgIds: [],
      isMerge: type === 'merge', hasCardHeader: type === 'merge' || type === 'arrange' && !!params.cardFrameIds?.has(id),
      hasGroupHeader: type === 'classify' || type === 'summary', targetLayout });
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
  // References to hidden organizations can leave an empty wrapper behind.
  // Such a wrapper has no rendered cards, but still consumed a layout row.
  const kept=new Set([...blocks.keys()].filter(id=>keepEmptyFrameIds.has(id)||[...descendants.get(id)!].some(member=>visibleCardIds.has(member)||keepEmptyFrameIds.has(member))));
  return [...blocks.values()].filter(block=>kept.has(block.relMsgId)).map(block=>({...block,
    cardIds:new Set([...block.cardIds].filter(id=>visibleCardIds.has(id)||kept.has(id))),
    directCardIds:new Set([...block.directCardIds].filter(id=>visibleCardIds.has(id))),
    childRelMsgIds:block.childRelMsgIds.filter(id=>kept.has(id)),
  }));
}
