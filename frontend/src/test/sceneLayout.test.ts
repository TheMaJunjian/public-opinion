import { describe, expect, it } from 'vitest';
import { computeSceneLayout, type FrameBlock } from '../utils/frameLayout';
import { projectStanceLayoutEdges } from '../utils/stanceLayout';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import { buildFrameBlocks } from '../utils/graphOrganizations';
import { extractTextTargetsForMessage } from '../utils/graphTextSelection';
import { CARD_W, COL_GAP, GRID_LEFT, GRID_TOP, ROW_GAP } from '../utils/layout';

const message = (id: string): DemoMessage => ({ id, author: 'a', kind: 'normal', content: id, createdAt: '2026-01-01T00:00:00Z' });
const edge = (id: string, source: string, target: string): DemoEdge => ({ id, relationMessageId: id, relationType: 'disagree', relationLabel: '反对', from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } } });
const frame = (id: string, members: string[], children: string[] = []): FrameBlock => ({ relMsgId: id, cardIds: new Set([...members, ...children]), directCardIds: new Set(members), childRelMsgIds: children, isMerge: false, hasGroupHeader: true });

describe('scene layout', () => {
  it('removes covered cards before packing instead of reserving one empty row per hidden message', () => {
    const normals = ['a', 'b', 'c', 'summary'].map(message);
    const result = computeSceneLayout({ normals, allMessages: normals, edges: [], colOf: {}, maxCol: 0,
      measuredHeights: {}, measuredWidths: {}, correctedTargetIds: new Set(['a', 'b', 'c']) });
    expect(Object.keys(result.layout)).toEqual(['summary']);
    expect(result.layout.summary.y).toBe(GRID_TOP);
  });

  it('does not reserve absent columns between visible members of one discussion', () => {
    const normals = ['claim', 'reason'].map(message);
    const result = computeSceneLayout({ normals, allMessages: normals, edges: [edge('stance', 'reason', 'claim')],
      colOf: { claim: 4, reason: 9 }, maxCol: 9, measuredHeights: {}, measuredWidths: {} });
    expect(result.layout.claim.x).toBe(GRID_LEFT);
    expect(result.layout.reason.x).toBe(GRID_LEFT + CARD_W + COL_GAP);
  });

  it('packs an unrelated card into available space instead of waiting for a tall card in another column', () => {
    const normals = ['a-claim', 'b-tall-objection', 'c-independent'].map(message);
    const result = computeSceneLayout({ normals, allMessages: normals, edges: [edge('stance', 'b-tall-objection', 'a-claim')],
      colOf: { 'a-claim': 0, 'b-tall-objection': 1, 'c-independent': 0 }, maxCol: 1,
      measuredHeights: { 'a-claim': 90, 'b-tall-objection': 600 }, measuredWidths: {} });
    expect(result.layout['c-independent'].y).toBe(GRID_TOP + 90 + ROW_GAP);
    expect(result.layout['c-independent'].y).toBeLessThan(result.layout['b-tall-objection'].y + 600);
  });
  it('measures a deeply nested organization once per frame and keeps one member identity', () => {
    const frames = Array.from({ length: 160 }, (_, i) => frame(`f${i}`, i === 159 ? ['content'] : [], i < 159 ? [`f${i + 1}`] : []));
    const normals = [message('content')];
    const result = computeSceneLayout({ normals, allMessages: normals, colOf: { content: 2 }, maxCol: 2, measuredHeights: { content: 180 }, measuredWidths: {}, frameBlocks: frames });
    expect(result.measuredFrames).toBe(160);
    expect(Object.keys(result.layout)).toEqual(['content']);
    expect(Object.keys(result.frameRects)).toHaveLength(160);
    const inner = result.frameRects.f159;
    expect(result.layout.content.y).toBeGreaterThan(inner.y);
    expect(result.layout.content.y + 180).toBeLessThanOrEqual(inner.y + inner.height);
    expect(frames[0].directCardIds.size).toBe(0);
  });

  it('measures a wide nested row before positioning external annotations', () => {
    const normals = ['a', 'b', 'note'].map(message);
    const row = { ...frame('row', ['a', 'b']), targetLayout: 'single-row' as const };
    const note = { ...edge('annotation', 'note', 'row'), relationType: 'annotation' as const };
    const result = computeSceneLayout({ normals, allMessages: normals, colOf: { a: 0, b: 0, note: 1 }, maxCol: 1, measuredHeights: {}, measuredWidths: {}, frameBlocks: [row], edges: [note] });
    expect(result.measuredFrames).toBe(1);
    expect(result.layout.note.x).toBeGreaterThan(result.frameRects.row.x + result.frameRects.row.width);
    expect(result.layout.a.y).toBe(result.layout.b.y);
  });

  it('does not recursively duplicate nodes when malformed organizations contain a cycle', () => {
    const normals = [message('a'), message('b')];
    const result = computeSceneLayout({ normals, allMessages: normals, colOf: {}, maxCol: 0, measuredHeights: {}, measuredWidths: {}, frameBlocks: [frame('one', ['a'], ['two']), frame('two', ['b'], ['one'])] });
    expect(result.measuredFrames).toBe(2);
    expect(Object.keys(result.layout).sort()).toEqual(['a', 'b']);
    expect(Number.isFinite(result.canvasHeight)).toBe(true);
  });

  it('keeps unrelated questions in separate discussion bands while aligning each stance to its own target', () => {
    const normals = ['question-a', 'question-b', 'support-a', 'support-b'].map(message);
    const links = [edge('stance-a', 'support-a', 'question-a'), edge('stance-b', 'support-b', 'question-b')];
    const result = computeSceneLayout({ normals, allMessages: normals, edges: links,
      colOf: { 'question-a': 1, 'question-b': 1, 'support-a': 0, 'support-b': 0 }, maxCol: 1,
      measuredHeights: { 'support-a': 300 }, measuredWidths: {},
    });
    expect(result.layout['support-a'].y).toBe(result.layout['question-a'].y);
    expect(result.layout['support-b'].y).toBe(result.layout['question-b'].y);
    expect(result.layout['question-b'].y).toBeGreaterThan(result.layout['support-a'].y + 300);
  });

  it('does not infer organization nesting from overlapping target sets for part-based messages', () => {
    const nodes = ['a', 'b', 'c', 'small', 'large'].map(id => ({ ...message(id), parts: [{ id: 'content', type: 'text' as const, text: id }] }));
    const links = [edge('small', 'anon:small', 'a'), edge('small', 'anon:small', 'b'), edge('large', 'anon:large', 'a'), edge('large', 'anon:large', 'b'), edge('large', 'anon:large', 'c')].map(link => ({ ...link, relationType: 'arrange' as const }));
    const result = buildFrameBlocks({ edges: links, visibleCardIds: new Set(nodes.map(node => node.id)), msgMap: new Map(nodes.map(node => [node.id, node])) });
    expect(result.every(block => block.childRelMsgIds.length === 0)).toBe(true);
  });

  it('does not turn a newly added relation type into an organization', () => {
    const nodes: DemoMessage[] = [message('claim'), { ...message('proof'), parts: [{ id: 'evidence', type: 'relation', relation: 'evidence', roles: { target: [{ id: 'claim', reference: { messageId: 'claim' } }] } }] }];
    const links = [{ ...edge('proof', 'anon:proof', 'claim'), relationType: 'evidence' as DemoEdge['relationType'] }];
    expect(buildFrameBlocks({ edges: links, visibleCardIds: new Set(nodes.map(node => node.id)), msgMap: new Map(nodes.map(node => [node.id, node])) })).toEqual([]);
  });
});

describe('execution-based stance placement', () => {
  it('does not paint a fragment annotation onto another part or a changed historical revision', () => {
    const links: DemoEdge[] = ['title', 'reason'].map(partId => ({
      ...edge(partId, 'citation', 'claim'), relationType: 'reference',
      to: { messageId: 'claim', reference: { messageId: 'claim', revision: 2, partId, range: { start: 0, end: 3 } }, selection: { kind: 'text', start: 0, len: 3, text: '相同字' } },
    }));
    expect(extractTextTargetsForMessage('claim', links, 'reason', 2).map(target => target.edgeId)).toEqual(['reason']);
    expect(extractTextTargetsForMessage('claim', links, 'reason', 3)).toEqual([]);
  });

  it('puts opposition to a stance on the original support side while preserving the selected reference chain', () => {
    const original = edge('double', 'reason', 'objection');
    const nodes: DemoMessage[] = [{ ...message('double'), kind: 'relation', executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: 'claim', revision: 1 }, side: 'pro' } }];
    const result = projectStanceLayoutEdges(nodes, [original]);
    expect(result[0].relationType).toBe('agree');
    expect(result[0].to.reference).toEqual({ messageId: 'claim', revision: 1 });
    expect(original.to.messageId).toBe('objection');
  });

  it('keeps an objection to the reason on its exact content part despite newer message edits', () => {
    const original = edge('reason-objection', 'evidence', 'objection');
    const target = { messageId: 'objection', revision: 1, partId: 'reason', range: { start: 0, end: 5 } };
    const nodes: DemoMessage[] = [{ ...message('reason-objection'), revision: 3, executedStance: { partId: 'stance', sourceRevision: 1, target, side: 'con' } }];
    const result = projectStanceLayoutEdges(nodes, [original]);
    expect(result[0].relationType).toBe('disagree');
    expect(result[0].to.reference).toEqual(target);
  });

  it('gives a relation with its own content a real layout source without inventing a text message', () => {
    const original = edge('stance', 'anon:stance', 'claim');
    const nodes: DemoMessage[] = [{ ...message('stance'), parts: [{ id: 'reason', type: 'text', text: '依据' }], executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: 'claim' }, side: 'pro' } }];
    expect(projectStanceLayoutEdges(nodes, [original])[0].from.messageId).toBe('stance');
    expect(original.from.messageId).toBe('anon:stance');
  });
});
