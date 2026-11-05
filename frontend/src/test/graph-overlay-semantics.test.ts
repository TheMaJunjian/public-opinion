import { describe, expect, it } from 'vitest';
import type { ExportData } from '../api/client';
import { measureGraphOverlays, type GraphOverlayInput } from '../utils/graphOverlays';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import type { DemoEdge } from '../utils/modelBridge';

function fixture(executed: boolean): GraphOverlayInput {
  const execution = (id: string) => executed ? { executedStance: {
    partId: 'stance', sourceRevision: 1, side: id === 'R' ? 'pro' as const : 'con' as const, target: { messageId: 'A' },
  } } : {};
  const data: ExportData = {
    formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '' },
    messages: [
      ...['A', 'B', 'C'].map(id => ({ id, kind: 'TEXT', contentType: 'TEXT', content: '', createdAt: '', authorId: 'fixture', author: '结构测试' })),
      ...['R', 'D'].map(id => ({ id, kind: 'RELATION', contentType: null, content: null, createdAt: '', authorId: 'fixture', author: '结构测试', ...execution(id) })),
    ],
    relations: [
      { id: 'R', relationType: 'AGREE', sourceMessageId: 'B', targetRefs: [{ kind: 'message', messageId: 'A' }], payload: null, createdAt: '', authorId: 'fixture', author: '结构测试', supersededBy: null, ...execution('R') },
      { id: 'D', relationType: 'DISAGREE', sourceMessageId: 'C', targetRefs: [{ kind: 'relation', relationId: 'R' }], payload: null, createdAt: '', authorId: 'fixture', author: '结构测试', supersededBy: null, ...execution('D') },
    ],
  };
  const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
  const messages = projected.messages, edges = projected.edges, normals = messages.filter(message => message.kind === 'normal');
  const edgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const edge of edges) { const own = edgesByRelMsg.get(edge.relationMessageId) ?? []; own.push(edge); edgesByRelMsg.set(edge.relationMessageId, own); }
  return { canvasRef: { current: document.createElement('div') }, normalIds: normals.map(message => message.id), normals, messages,
    msgMap: new Map(messages.map(message => [message.id, message])), relationCardMsgIds: new Set(), edges,
    colOf: { A: 0, B: 1, C: 1 }, layout: { A: { x: 0, y: 0, width: 300, height: 100 },
      B: { x: 600, y: 0, width: 300, height: 100 }, C: { x: 600, y: 300, width: 300, height: 100 } },
    cardRefs: { current: {} }, headerRefs: { current: {} }, contentRefs: { current: {} }, isTraceWindow: false,
    anonCorrectedRelMsgIds: new Set(), finalFrameRects: {}, traceExpandedFrameIds: new Set(), edgesByRelMsg,
    labelBboxes: {}, comparisonSuppressedRelIds: new Set(), correctedEdgeIdsByRelMsg: new Map() };
}

describe('complete semantic scope for visually folded overlays', () => {
  it.each([false, true])('preserves legacy/executed vote targets and totals while drawing fewer edges (executed=%s)', executed => {
    const input = fixture(executed), before = structuredClone({ messages: input.messages, edges: input.edges });
    expect(input.edges).toHaveLength(2);
    expect(!!input.msgMap.get('D')?.executedStance).toBe(executed);
    const full = measureGraphOverlays(input)!;
    expect(full.decorationsByMsgState?.A).toMatchObject({ agreeCount: 1, disagreeCount: 1 });
    expect(full.relDecByRelMsgState.get('A')).toMatchObject({ agreeCount: 0, disagreeCount: 1, disagreeRelMsgIds: ['D'] });
    const folded = measureGraphOverlays({ ...input, semanticEdges: input.edges,
      edges: input.edges.filter(edge => edge.relationMessageId === 'D'), hiddenMessageIds: new Set(['B']) })!;
    expect(folded.decorationsByMsgState).toEqual(full.decorationsByMsgState);
    expect(folded.relDecByRelMsgState).toEqual(full.relDecByRelMsgState);
    expect(folded.decorationsByMsgState?.R).toBeUndefined();
    expect(folded.relDecByRelMsgState.has('R')).toBe(false);
    expect(folded.positionedEdges).toEqual([]);
    expect({ messages: input.messages, edges: input.edges }).toEqual(before);
  });

  it('continues to honor explicit semantic exclusions without losing the catalog needed to resolve a chain', () => {
    const input = fixture(false), support = input.edges.find(edge => edge.relationMessageId === 'R')!;
    const result = measureGraphOverlays({ ...input, edges: input.edges.filter(edge => edge.id !== support.id),
      semanticEdges: input.edges, excludedStanceEdges: new Set([support.id]) })!;
    expect(result.decorationsByMsgState?.A).toMatchObject({ agreeCount: 0, disagreeCount: 1 });
    expect(result.decorationsByMsgState?.R).toBeUndefined();
    expect(result.relDecByRelMsgState.get('A')?.disagreeRelMsgIds).toEqual(['D']);
  });
});
