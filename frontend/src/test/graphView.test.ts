import { describe, expect, it } from 'vitest';
import { applyGroupingColumnOverride } from '../utils/graphColumnRules';
import { buildFrameBlocks } from '../utils/graphOrganizations';
import { computeSceneLayout as computeNoOverlapLayout } from '../utils/frameLayout';
import { unionLayoutRects } from '../utils/graphPresentationGeometry';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { applyTraceFrameVisibility, buildTraceProjection } from '../utils/traceProjection';

function makeNormal(id: string): DemoMessage {
  return { id, author: 'tester', createdAt: '2024-01-01T00:00:00.000Z', content: id, kind: 'normal' };
}

describe('merge canvas helpers', () => {
  it('unions a merge header card with its complete frame for the actual selection rect', () => {
    expect(unionLayoutRects(
      { x: 28, y: 20, width: 180, height: 56 },
      { x: 18, y: 68, width: 320, height: 220 },
    )).toEqual({ x: 18, y: 20, width: 320, height: 268 });
  });

  it('uses direct container relations for trace frame hierarchy', () => {
    const messages: DemoMessage[] = [
      makeNormal('message-c'),
      { id: 'frame-a', author: 'tester', createdAt: '2024-01-01T00:01:00.000Z', content: 'A', kind: 'relation', relationType: 'summary' },
      { id: 'frame-b', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'B', kind: 'relation', relationType: 'classify' },
    ];
    const edges: DemoEdge[] = [
      { id: 'frame-a::0', relationMessageId: 'frame-a', relationType: 'summary', from: { messageId: 'anon:frame-a', selection: { kind: 'whole' } }, to: { messageId: 'frame-b', selection: { kind: 'whole' } }, relationLabel: 'summary' },
      { id: 'frame-b::0', relationMessageId: 'frame-b', relationType: 'classify', from: { messageId: 'anon:frame-b', selection: { kind: 'whole' } }, to: { messageId: 'message-c', selection: { kind: 'whole' } }, relationLabel: 'classify' },
    ];

    const blocks = buildFrameBlocks({
      edges,
      visibleCardIds: new Set(['frame-a', 'frame-b', 'message-c']),
      msgMap: new Map(messages.map(message => [message.id, message])),
      traceMode: true,
    });
    const frameA = blocks.find(block => block.relMsgId === 'frame-a');
    const frameB = blocks.find(block => block.relMsgId === 'frame-b');

    expect(frameA?.childRelMsgIds).toEqual(['frame-b']);
    expect(frameA?.directCardIds.has('message-c')).toBe(false);
    expect(frameB?.directCardIds.has('message-c')).toBe(true);
  });

  it('keeps collapsed cards and expanded frames in their unique trace parent', () => {
    const relation = (id: string, relationType: DemoMessage['relationType']): DemoMessage => ({
      id, author: 'tester', createdAt: `2024-01-01T00:0${id.charCodeAt(0)}:00.000Z`, content: id, kind: 'relation', relationType,
    });
    const edge = (id: string, owner: string, relationType: DemoEdge['relationType'], target: string): DemoEdge => ({
      id,
      relationMessageId: owner,
      relationType,
      from: { messageId: `anon:${owner}`, selection: { kind: 'whole' } },
      to: { messageId: target, selection: { kind: 'whole' } },
      relationLabel: relationType,
    });
    const messages = [
      relation('C', 'summary'), makeNormal('D'), relation('E', 'classify'),
      makeNormal('F'), relation('G', 'merge'), makeNormal('H'),
    ];
    const edges = [
      edge('C-D', 'C', 'summary', 'D'), edge('C-E', 'C', 'summary', 'E'),
      edge('E-F', 'E', 'classify', 'F'), edge('E-G', 'E', 'classify', 'G'),
      edge('G-H', 'G', 'merge', 'H'),
    ];
    const messageMap = new Map(messages.map(message => [message.id, message]));

    const traceProjection = buildTraceProjection({ messages, edges, startIds: ['E'], distance: 1 });
    const collapsedProjection = applyTraceFrameVisibility(traceProjection, new Set(['C']));
    const collapsedBlocks = buildFrameBlocks({
      edges: collapsedProjection.edges,
      visibleCardIds: new Set(collapsedProjection.messages.map(message => message.id)),
      msgMap: messageMap,
      traceMode: true,
    });
    expect(collapsedBlocks.map(block => block.relMsgId)).toEqual(['C']);
    expect(collapsedBlocks[0].directCardIds).toEqual(new Set(['E']));

    const expandedProjection = applyTraceFrameVisibility(traceProjection, new Set(['C', 'E']));
    const expandedBlocks = buildFrameBlocks({
      edges: expandedProjection.edges,
      visibleCardIds: new Set(expandedProjection.messages.map(message => message.id)),
      msgMap: messageMap,
      traceMode: true,
    });
    const frameC = expandedBlocks.find(block => block.relMsgId === 'C');
    const frameE = expandedBlocks.find(block => block.relMsgId === 'E');
    const frameG = expandedBlocks.find(block => block.relMsgId === 'G');
    expect(frameC?.childRelMsgIds).toEqual(['E']);
    expect(frameC?.directCardIds).toEqual(new Set());
    expect(frameE?.childRelMsgIds).toEqual(['G']);
    expect(frameE?.directCardIds).toEqual(new Set(['F']));
    expect(frameG?.directCardIds).toEqual(new Set(['H']));
  });

  it('does not repeat the global column offset inside a nested classify frame', () => {
    const messages: DemoMessage[] = [
      makeNormal('member'),
      { id: 'summary', author: 'tester', createdAt: '2024-01-01T00:01:00.000Z', content: 'summary', kind: 'relation', relationType: 'summary' },
      { id: 'classify', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'classify', kind: 'relation', relationType: 'classify' },
    ];
    const edges: DemoEdge[] = [
      { id: 'summary-classify', relationMessageId: 'summary', relationType: 'summary', from: { messageId: 'anon:summary', selection: { kind: 'whole' } }, to: { messageId: 'classify', selection: { kind: 'whole' } }, relationLabel: 'summary' },
      { id: 'classify-member', relationMessageId: 'classify', relationType: 'classify', from: { messageId: 'anon:classify', selection: { kind: 'whole' } }, to: { messageId: 'member', selection: { kind: 'whole' } }, relationLabel: 'classify' },
    ];
    const frameBlocks = buildFrameBlocks({
      edges,
      visibleCardIds: new Set(messages.map(message => message.id)),
      msgMap: new Map(messages.map(message => [message.id, message])),
      traceMode: true,
    });

    const result = computeNoOverlapLayout({
      normals: [messages[0]],
      colOf: { member: 5, summary: 5, classify: 5 },
      measuredHeights: { member: 96, summary: 56, classify: 56 },
      measuredWidths: {},
      maxCol: 5,
      frameBlocks,
      allMessages: messages,
      traceMode: true,
    });

    expect(result.frameRects.classify.x - result.frameRects.summary.x).toBeLessThan(100);
  });

  it('computes each nested frame once from its own direct contents', () => {
    const relation = (id: string, relationType: DemoMessage['relationType']): DemoMessage => ({
      id, author: 'tester', createdAt: '2024-01-01T00:01:00.000Z', content: id, kind: 'relation', relationType,
    });
    const messages = [makeNormal('member'), relation('summary', 'summary'), relation('classify', 'classify'), relation('merge', 'merge')];
    const edges: DemoEdge[] = [
      { id: 'summary-classify', relationMessageId: 'summary', relationType: 'summary', from: { messageId: 'anon:summary', selection: { kind: 'whole' } }, to: { messageId: 'classify', selection: { kind: 'whole' } }, relationLabel: 'summary' },
      { id: 'classify-merge', relationMessageId: 'classify', relationType: 'classify', from: { messageId: 'anon:classify', selection: { kind: 'whole' } }, to: { messageId: 'merge', selection: { kind: 'whole' } }, relationLabel: 'classify' },
      { id: 'merge-member', relationMessageId: 'merge', relationType: 'merge', from: { messageId: 'anon:merge', selection: { kind: 'whole' } }, to: { messageId: 'member', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const frameBlocks = buildFrameBlocks({ edges, visibleCardIds: new Set(messages.map(message => message.id)), msgMap: new Map(messages.map(message => [message.id, message])), traceMode: true });
    const measuredHeights = { member: 96, summary: 56, classify: 56, merge: 56 };
    const result = computeNoOverlapLayout({ normals: [messages[0]], colOf: { member: 0, summary: 0, classify: 0, merge: 0 }, measuredHeights, measuredWidths: {}, maxCol: 0, frameBlocks, allMessages: messages, traceMode: true });

    expect(result.frameRects.merge.width).toBe(356);
    expect(result.frameRects.classify.width).toBe(392);
    expect(result.frameRects.summary.width).toBe(428);
  });

  it('packs sparse global columns into adjacent occupied columns inside a frame', () => {
    const relation = (id: string, relationType: DemoMessage['relationType']): DemoMessage => ({
      id, author: 'tester', createdAt: '2024-01-01T00:01:00.000Z', content: id, kind: 'relation', relationType,
    });
    const messages = [makeNormal('direct'), makeNormal('nested'), relation('summary', 'summary'), relation('merge', 'merge')];
    const edges: DemoEdge[] = [
      { id: 'summary-direct', relationMessageId: 'summary', relationType: 'summary', from: { messageId: 'anon:summary', selection: { kind: 'whole' } }, to: { messageId: 'direct', selection: { kind: 'whole' } }, relationLabel: 'summary' },
      { id: 'summary-merge', relationMessageId: 'summary', relationType: 'summary', from: { messageId: 'anon:summary', selection: { kind: 'whole' } }, to: { messageId: 'merge', selection: { kind: 'whole' } }, relationLabel: 'summary' },
      { id: 'merge-nested', relationMessageId: 'merge', relationType: 'merge', from: { messageId: 'anon:merge', selection: { kind: 'whole' } }, to: { messageId: 'nested', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const frameBlocks = buildFrameBlocks({ edges, visibleCardIds: new Set(messages.map(message => message.id)), msgMap: new Map(messages.map(message => [message.id, message])), traceMode: true });
    const result = computeNoOverlapLayout({
      normals: messages.slice(0, 2),
      colOf: { direct: 0, summary: 0, merge: 5, nested: 5 },
      measuredHeights: { direct: 96, nested: 96, summary: 56, merge: 56 },
      measuredWidths: {},
      maxCol: 5,
      frameBlocks,
      allMessages: messages,
      traceMode: true,
    });

    const horizontalGap = result.frameRects.merge.x - (result.layout.direct.x + result.layout.direct.width);
    expect(horizontalGap).toBeLessThan(200);
  });

  it('places later classify messages below an earlier merge nested in two classify frames', () => {
    const relation = (id: string, relationType: DemoMessage['relationType'], createdAt: string): DemoMessage => ({
      id, author: 'tester', createdAt, content: id, kind: 'relation', relationType,
    });
    const laterMessage: DemoMessage = {
      ...makeNormal('later-message'),
      createdAt: '2024-01-01T00:04:00.000Z',
    };
    const outerMessage: DemoMessage = {
      ...makeNormal('outer-message'),
      createdAt: '2024-01-01T00:05:00.000Z',
    };
    const mergeMember: DemoMessage = {
      ...makeNormal('merge-member'),
      createdAt: '2024-01-01T00:01:00.000Z',
    };
    const messages = [
      mergeMember,
      laterMessage,
      outerMessage,
      relation('outer-classify', 'classify', '2024-01-01T00:00:00.000Z'),
      relation('inner-classify', 'classify', '2024-01-01T00:00:30.000Z'),
      relation('merge', 'merge', '2024-01-01T00:02:00.000Z'),
    ];
    const edges: DemoEdge[] = [
      { id: 'outer-inner', relationMessageId: 'outer-classify', relationType: 'classify', from: { messageId: 'anon:outer-classify', selection: { kind: 'whole' } }, to: { messageId: 'inner-classify', selection: { kind: 'whole' } }, relationLabel: 'classify' },
      { id: 'outer-message', relationMessageId: 'outer-classify', relationType: 'classify', from: { messageId: 'anon:outer-classify', selection: { kind: 'whole' } }, to: { messageId: 'outer-message', selection: { kind: 'whole' } }, relationLabel: 'classify' },
      { id: 'inner-merge', relationMessageId: 'inner-classify', relationType: 'classify', from: { messageId: 'anon:inner-classify', selection: { kind: 'whole' } }, to: { messageId: 'merge', selection: { kind: 'whole' } }, relationLabel: 'classify' },
      { id: 'inner-later', relationMessageId: 'inner-classify', relationType: 'classify', from: { messageId: 'anon:inner-classify', selection: { kind: 'whole' } }, to: { messageId: 'later-message', selection: { kind: 'whole' } }, relationLabel: 'classify' },
      { id: 'merge-member', relationMessageId: 'merge', relationType: 'merge', from: { messageId: 'anon:merge', selection: { kind: 'whole' } }, to: { messageId: 'merge-member', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const frameBlocks = buildFrameBlocks({ edges, visibleCardIds: new Set(messages.map(message => message.id)), msgMap: new Map(messages.map(message => [message.id, message])), traceMode: true });
    const result = computeNoOverlapLayout({
      normals: [mergeMember, laterMessage, outerMessage],
      colOf: { 'merge-member': 0, 'later-message': 0, 'outer-message': 0, merge: 0, 'inner-classify': 0, 'outer-classify': 0 },
      measuredHeights: { 'merge-member': 96, 'later-message': 96, 'outer-message': 96, merge: 56, 'inner-classify': 56, 'outer-classify': 56 },
      measuredWidths: {},
      maxCol: 0,
      frameBlocks,
      allMessages: messages,
      traceMode: true,
    });

    const mergeRect = result.frameRects.merge;
    const laterRect = result.layout['later-message'];
    expect(laterRect.y).toBeGreaterThanOrEqual(mergeRect.y + mergeRect.height);
    const innerRect = result.frameRects['inner-classify'];
    const outerMessageRect = result.layout['outer-message'];
    expect(outerMessageRect.y).toBeGreaterThanOrEqual(innerRect.y + innerRect.height);
  });
});

describe('grouping column override', () => {
  it('keeps arrange targets in their original columns (arrange is frame but no column compaction)', () => {
    const normals: DemoMessage[] = [
      { ...makeNormal('msg-1'), createdAt: '2024-01-01T00:00:00.000Z' },
      { ...makeNormal('msg-2'), createdAt: '2024-01-01T00:01:00.000Z' },
      { ...makeNormal('msg-3'), createdAt: '2024-01-01T00:02:00.000Z' },
      { ...makeNormal('msg-4'), createdAt: '2024-01-01T00:03:00.000Z' },
    ];
    const edges: DemoEdge[] = [
      { id: 'supp-1::0', relationMessageId: 'supp-1', relationType: 'arrange', from: { messageId: 'anon:supp-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-1', selection: { kind: 'whole' } }, relationLabel: 'arrange' },
      { id: 'supp-1::1', relationMessageId: 'supp-1', relationType: 'arrange', from: { messageId: 'anon:supp-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-2', selection: { kind: 'whole' } }, relationLabel: 'arrange' },
      { id: 'supp-1::2', relationMessageId: 'supp-1', relationType: 'arrange', from: { messageId: 'anon:supp-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-3', selection: { kind: 'whole' } }, relationLabel: 'arrange' },
    ];
    const { col, maxCol, groupSourceToTarget } = applyGroupingColumnOverride({
      normals,
      edges,
      col: { 'msg-1': 0, 'msg-2': 3, 'msg-3': 3, 'msg-4': 5 },
      maxCol: 5,
    });

    // ARRANGE has groupsTargets=true: targets chain by time, column propagates to first target.
    // msg-2→msg-1 (col 0), msg-3→msg-2 (col 0). All end up in column 0.
    expect(col['msg-1']).toBe(0);
    expect(col['msg-2']).toBe(0);
    expect(col['msg-3']).toBe(0);
    expect(col['msg-4']).toBe(5);
    expect(maxCol).toBe(5);
    expect(groupSourceToTarget.get('msg-2')).toBe('msg-1');
    expect(groupSourceToTarget.get('msg-3')).toBe('msg-2');
  });
});
