import { describe, expect, it } from 'vitest';
import { applyGroupingColumnOverride, applyMergeCanvasReservations, buildMergeCanvasReservations } from '../components/GraphView';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

function makeNormal(id: string): DemoMessage {
  return { id, author: 'tester', createdAt: '2024-01-01T00:00:00.000Z', content: id, kind: 'normal' };
}

function buildEdgesByRelMsg(edges: DemoEdge[]): Map<string, DemoEdge[]> {
  const map = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = map.get(e.relationMessageId) ?? [];
    arr.push(e);
    map.set(e.relationMessageId, arr);
  }
  return map;
}

describe('merge canvas helpers', () => {
  it('builds a merge overlay from both text and relation targets', () => {
    const messages: DemoMessage[] = [
      makeNormal('msg-1'),
      makeNormal('msg-2'),
      makeNormal('msg-3'),
      { id: 'rel-1', author: 'tester', createdAt: '2024-01-01T00:01:00.000Z', content: 'reply', kind: 'relation', relationType: 'reply' },
      // Long Chinese title to verify merge header width expands adaptively.
      { id: 'merge-1', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'merge', kind: 'relation', relationType: 'merge', relationPayload: { title: '归并分类标签很长用于测试宽度自适应' } },
    ];
    const edges: DemoEdge[] = [
      { id: 'rel-1::0', relationMessageId: 'rel-1', relationType: 'reply', from: { messageId: 'msg-2', selection: { kind: 'whole' } }, to: { messageId: 'msg-1', selection: { kind: 'whole' } }, relationLabel: 'reply' },
      { id: 'merge-1::0', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'rel-1', selection: { kind: 'whole' } }, relationLabel: 'merge' },
      { id: 'merge-1::1', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-3', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const layout = {
      'msg-1': { x: 18, y: 18, width: 320, height: 96 },
      'msg-2': { x: 418, y: 18, width: 320, height: 96 },
      'msg-3': { x: 18, y: 210, width: 320, height: 96 },
    };

    const reservations = buildMergeCanvasReservations({
      edges,
      layout,
      msgMap: new Map(messages.map(message => [message.id, message])),
      relationCardMsgIds: new Set<string>(),
    });

    expect(reservations).toHaveLength(1);
    expect(Array.from(reservations[0].cardIds)).toEqual(expect.arrayContaining(['msg-1', 'msg-2', 'msg-3']));
    expect(reservations[0].headerRect.y).toBeLessThan(reservations[0].contentRect.y);
    expect(reservations[0].headerRect.height).toBeLessThan(30);
    expect(reservations[0].headerRect.width).toBeGreaterThan(120);
    expect(reservations[0].rect.width).toBeGreaterThanOrEqual(reservations[0].contentRect.width);
    expect(reservations[0].contentRect.height).toBeGreaterThan(250);
  });

  it('nests arrange frames when arrange relations are merge targets', () => {
    const messages: DemoMessage[] = [
      makeNormal('msg-1'),
      makeNormal('msg-2'),
      makeNormal('msg-3'),
      { id: 'supp-1', author: 'tester', createdAt: '2024-01-01T00:01:00.000Z', content: 'supp', kind: 'relation', relationType: 'arrange' },
      { id: 'merge-1', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'merge', kind: 'relation', relationType: 'merge', relationPayload: { title: '归并' } },
    ];
    const edges: DemoEdge[] = [
      { id: 'supp-1::0', relationMessageId: 'supp-1', relationType: 'arrange', from: { messageId: 'msg-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-2', selection: { kind: 'whole' } }, relationLabel: 'arrange' },
      { id: 'merge-1::0', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'supp-1', selection: { kind: 'whole' } }, relationLabel: 'merge' },
      { id: 'merge-1::1', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-3', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const layout = {
      'msg-1': { x: 18, y: 18, width: 320, height: 96 },
      'msg-2': { x: 18, y: 146, width: 320, height: 96 },
      'msg-3': { x: 418, y: 18, width: 320, height: 96 },
    };

    const reservations = buildMergeCanvasReservations({
      edges,
      layout,
      msgMap: new Map(messages.map(message => [message.id, message])),
      relationCardMsgIds: new Set<string>(),
    });

    expect(reservations).toHaveLength(1);
    expect(Array.from(reservations[0].cardIds)).toEqual(expect.arrayContaining(['msg-1', 'msg-2', 'msg-3']));
    expect(reservations[0].contentRect.x).toBeLessThanOrEqual(6);
    expect(reservations[0].contentRect.y).toBeLessThanOrEqual(6);
    expect(reservations[0].contentRect.height).toBeGreaterThan(240);
  });

  it('pushes unrelated cards below the merge overlay canvas', () => {
    const normals: DemoMessage[] = [
      makeNormal('msg-1'),
      makeNormal('msg-2'),
      makeNormal('msg-3'),
      makeNormal('msg-4'),
    ];
    const baseLayout = {
      'msg-1': { x: 18, y: 18, width: 320, height: 96 },
      'msg-2': { x: 418, y: 18, width: 320, height: 96 },
      'msg-3': { x: 18, y: 80, width: 320, height: 96 },
      'msg-4': { x: 18, y: 170, width: 320, height: 96 },
    };

    const { layout } = applyMergeCanvasReservations({
      layout: baseLayout,
      normals,
      colOf: { 'msg-1': 0, 'msg-2': 1, 'msg-3': 0, 'msg-4': 0 },
      reservations: [{
        relMsgId: 'merge-1',
        contentRect: { x: 6, y: 6, width: 744, height: 120 },
        headerRect: { x: 16, y: -2, width: 56, height: 24 },
        rect: { x: 6, y: -2, width: 744, height: 128 },
        cardIds: new Set(['msg-1', 'msg-2']),
      }],
      edgesByRelMsg: new Map(),
      msgMap: new Map(),
      relationCardMsgIds: new Set(),
    });

    expect(layout['msg-3'].y).toBeGreaterThanOrEqual(158);
    expect(layout['msg-4'].y).toBeGreaterThan(layout['msg-3'].y + layout['msg-3'].height);
  });
});

describe('merge canvas pipeline integration', () => {
  it('compacts merge targets upward within their columns (end-to-end)', () => {
    // Simulates the full pipeline: buildMergeCanvasReservations → applyMergeCanvasReservations.
    // msg-1 and msg-2 are merge targets in col 0 with a large gap between them;
    // they should be compacted upward so that msg-2 sits right below msg-1.
    const messages: DemoMessage[] = [
      makeNormal('msg-1'),
      makeNormal('msg-2'),
      makeNormal('msg-3'),
      { id: 'merge-1', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'merge', kind: 'relation', relationType: 'merge', relationPayload: { title: '归并' } },
    ];
    const edges: DemoEdge[] = [
      { id: 'merge-1::0', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-1', selection: { kind: 'whole' } }, relationLabel: 'merge' },
      { id: 'merge-1::1', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-2', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const msgMap = new Map(messages.map(m => [m.id, m]));
    const baseLayout = {
      'msg-1': { x: 18, y: 48, width: 320, height: 96 },
      'msg-2': { x: 18, y: 400, width: 320, height: 96 },  // far below msg-1
      'msg-3': { x: 418, y: 48, width: 320, height: 96 },
    };
    const normals: DemoMessage[] = [messages[0], messages[1], messages[2]];

    const reservations = buildMergeCanvasReservations({
      edges,
      layout: baseLayout,
      msgMap,
      relationCardMsgIds: new Set(),
    });
    expect(reservations).toHaveLength(1);

    const { layout } = applyMergeCanvasReservations({
      layout: baseLayout,
      normals,
      colOf: { 'msg-1': 0, 'msg-2': 0, 'msg-3': 1 },
      reservations,
      edgesByRelMsg: buildEdgesByRelMsg(edges),
      msgMap,
      relationCardMsgIds: new Set(),
    });

    // msg-2 should be compacted up, sitting right after msg-1 with ROW_GAP spacing
    const expectedMsg2Y = baseLayout['msg-1'].y + baseLayout['msg-1'].height + 32; // ROW_GAP = 32
    expect(layout['msg-2'].y).toBe(expectedMsg2Y);
    // msg-1 should not move
    expect(layout['msg-1'].y).toBe(baseLayout['msg-1'].y);
    // msg-3 is in a different column, should stay put (not affected by col-0 merge)
    expect(layout['msg-3'].y).toBe(baseLayout['msg-3'].y);
  });

  it('pushes non-merge cards below the merge reservation rect', () => {
    // msg-1 is a merge target in col 0, msg-2 is non-merge in col 0 and overlaps
    // the merge reservation horizontally. msg-2 should be pushed below the frame.
    const messages: DemoMessage[] = [
      makeNormal('msg-1'),
      makeNormal('msg-2'),
      { id: 'merge-1', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'merge', kind: 'relation', relationType: 'merge', relationPayload: { title: '归并' } },
    ];
    const edges: DemoEdge[] = [
      { id: 'merge-1::0', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-1', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const msgMap = new Map(messages.map(m => [m.id, m]));
    const baseLayout = {
      'msg-1': { x: 18, y: 48, width: 320, height: 96 },
      'msg-2': { x: 18, y: 80, width: 320, height: 96 },  // overlaps with merge reservation
    };
    const normals: DemoMessage[] = [messages[0], messages[1]];

    const reservations = buildMergeCanvasReservations({
      edges,
      layout: baseLayout,
      msgMap,
      relationCardMsgIds: new Set(),
    });

    const { layout } = applyMergeCanvasReservations({
      layout: baseLayout,
      normals,
      colOf: { 'msg-1': 0, 'msg-2': 0 },
      reservations,
      edgesByRelMsg: buildEdgesByRelMsg(edges),
      msgMap,
      relationCardMsgIds: new Set(),
    });

    // msg-2 should be pushed below the merge reservation rect
    expect(layout['msg-2'].y).toBeGreaterThan(baseLayout['msg-2'].y);
    expect(layout['msg-2'].y).toBeGreaterThanOrEqual(layout['msg-1'].y + layout['msg-1'].height + 32);
  });

  it('no-op when there are no merge edges (empty reservations)', () => {
    const messages: DemoMessage[] = [
      makeNormal('msg-1'),
      makeNormal('msg-2'),
      { id: 'reply-1', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'reply', kind: 'relation', relationType: 'reply' },
    ];
    const edges: DemoEdge[] = [
      { id: 'reply-1::0', relationMessageId: 'reply-1', relationType: 'reply', from: { messageId: 'msg-2', selection: { kind: 'whole' } }, to: { messageId: 'msg-1', selection: { kind: 'whole' } }, relationLabel: 'reply' },
    ];
    const msgMap = new Map(messages.map(m => [m.id, m]));
    const baseLayout = {
      'msg-1': { x: 18, y: 48, width: 320, height: 96 },
      'msg-2': { x: 418, y: 48, width: 320, height: 96 },
    };
    const normals: DemoMessage[] = [messages[0], messages[1]];

    const reservations = buildMergeCanvasReservations({
      edges,
      layout: baseLayout,
      msgMap,
      relationCardMsgIds: new Set(),
    });
    expect(reservations).toHaveLength(0);

    const { layout, canvasHeight } = applyMergeCanvasReservations({
      layout: baseLayout,
      normals,
      colOf: { 'msg-1': 0, 'msg-2': 1 },
      reservations,
      edgesByRelMsg: buildEdgesByRelMsg(edges),
      msgMap,
      relationCardMsgIds: new Set(),
    });

    // Layout should be unchanged
    expect(layout['msg-1']).toEqual(baseLayout['msg-1']);
    expect(layout['msg-2']).toEqual(baseLayout['msg-2']);
    // Canvas height should account for tallest card + bottom padding
    const maxBottom = Math.max(
      baseLayout['msg-1'].y + baseLayout['msg-1'].height,
      baseLayout['msg-2'].y + baseLayout['msg-2'].height,
    );
    expect(canvasHeight).toBe(maxBottom + 120); // CANVAS_BOTTOM_PAD = 120
  });

  it('preserves multi-column layout while compacting per-column merge targets', () => {
    // msg-1 (col 0) and msg-3 (col 1) are merge targets; msg-2 (col 0) and msg-4 (col 1) are not.
    // msg-1 and msg-3 should each be compacted in their own column without crossing columns.
    const messages: DemoMessage[] = [
      makeNormal('msg-1'),
      makeNormal('msg-2'),
      makeNormal('msg-3'),
      makeNormal('msg-4'),
      { id: 'merge-1', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'merge', kind: 'relation', relationType: 'merge', relationPayload: { title: '归并' } },
    ];
    const edges: DemoEdge[] = [
      { id: 'merge-1::0', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-1', selection: { kind: 'whole' } }, relationLabel: 'merge' },
      { id: 'merge-1::1', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-3', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const msgMap = new Map(messages.map(m => [m.id, m]));
    const baseLayout = {
      'msg-1': { x: 18, y: 48, width: 320, height: 96 },
      'msg-2': { x: 18, y: 400, width: 320, height: 96 },
      'msg-3': { x: 418, y: 48, width: 320, height: 96 },
      'msg-4': { x: 418, y: 400, width: 320, height: 96 },
    };
    const normals: DemoMessage[] = [messages[0], messages[1], messages[2], messages[3]];

    const reservations = buildMergeCanvasReservations({
      edges,
      layout: baseLayout,
      msgMap,
      relationCardMsgIds: new Set(),
    });

    const { layout } = applyMergeCanvasReservations({
      layout: baseLayout,
      normals,
      colOf: { 'msg-1': 0, 'msg-2': 0, 'msg-3': 1, 'msg-4': 1 },
      reservations,
      edgesByRelMsg: buildEdgesByRelMsg(edges),
      msgMap,
      relationCardMsgIds: new Set(),
    });

    // msg-1 is a merge target in col 0 — stays where it is (top of column)
    expect(layout['msg-1'].y).toBe(baseLayout['msg-1'].y);
    // msg-3 is a merge target in col 1 — stays where it is
    expect(layout['msg-3'].y).toBe(baseLayout['msg-3'].y);
    // msg-2 is non-merge in col 0, should be pushed below merge rect if overlapping
    // (it overlaps since it shares the same x column as the merge frame)
    expect(layout['msg-2'].y).toBeGreaterThan(baseLayout['msg-1'].y + baseLayout['msg-1'].height);
    // msg-4 is non-merge in col 1, should be pushed below merge rect
    expect(layout['msg-4'].y).toBeGreaterThan(baseLayout['msg-3'].y + baseLayout['msg-3'].height);
  });

  it('does not move cards inside inner arrange frames (including custom types like supp)', () => {
    // Regression test: a merge that includes an inner arrange frame.
    // applyMergeCanvasReservations must NOT alter cards inside inner frames —
    // their layout is determined by computeNoOverlapLayout.
    // Uses 'supp' (a custom type not in PRESENTATION_SPECS) to verify that
    // the identification works without relying on presentation kind.
    const messages: DemoMessage[] = [
      makeNormal('m1'),
      makeNormal('m2'),
      makeNormal('m5'),
      makeNormal('m6'),
      { id: 'r10', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'arrange', kind: 'relation', relationType: 'tag' },
      { id: 'merge-1', author: 'tester', createdAt: '2024-01-01T00:03:00.000Z', content: 'merge', kind: 'relation', relationType: 'merge', relationPayload: { title: '归并' } },
    ];
    const edges: DemoEdge[] = [
      { id: 'r10::0', relationMessageId: 'r10', relationType: 'tag', from: { messageId: 'anon:r10', selection: { kind: 'whole' } }, to: { messageId: 'm5', selection: { kind: 'whole' } }, relationLabel: 'tag' },
      { id: 'r10::1', relationMessageId: 'r10', relationType: 'tag', from: { messageId: 'anon:r10', selection: { kind: 'whole' } }, to: { messageId: 'm6', selection: { kind: 'whole' } }, relationLabel: 'tag' },
      { id: 'merge-1::0', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'm1', selection: { kind: 'whole' } }, relationLabel: 'merge' },
      { id: 'merge-1::1', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'm2', selection: { kind: 'whole' } }, relationLabel: 'merge' },
      { id: 'merge-1::2', relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } }, to: { messageId: 'r10', selection: { kind: 'whole' } }, relationLabel: 'merge' },
    ];
    const msgMap = new Map(messages.map(m => [m.id, m]));
    const baseLayout = {
      'm1': { x: 18, y: 48, width: 320, height: 96 },
      'm2': { x: 418, y: 48, width: 320, height: 96 },
      'm5': { x: 36, y: 400, width: 320, height: 96 },  // inside r10 arrange, stacked
      'm6': { x: 36, y: 528, width: 320, height: 96 },  // m5.y + m5.h + ROW_GAP
    };
    const normals: DemoMessage[] = [messages[0], messages[1], messages[2], messages[3]];
    const edgesByRelMsg = buildEdgesByRelMsg(edges);

    const reservations = buildMergeCanvasReservations({
      edges,
      layout: baseLayout,
      msgMap,
      relationCardMsgIds: new Set(),
    });
    expect(reservations).toHaveLength(1);

    const { layout } = applyMergeCanvasReservations({
      layout: baseLayout,
      normals,
      colOf: { 'm1': 0, 'm2': 1, 'm5': 0, 'm6': 0 },
      reservations,
      edgesByRelMsg,
      msgMap,
      relationCardMsgIds: new Set(),
    });

    // Inner frame cards must NOT be moved by merge compaction
    expect(layout['m5'].y).toBe(baseLayout['m5'].y);
    expect(layout['m6'].y).toBe(baseLayout['m6'].y);

    // m5 and m6 must maintain their relative stacking (m6 is below m5 by ROW_GAP)
    const m5m6Gap = layout['m6'].y - (layout['m5'].y + layout['m5'].height);
    expect(m5m6Gap).toBe(32); // ROW_GAP = 32

    // Direct merge targets (not in inner frames) may still be compacted
    expect(layout['m1'].y).toBe(baseLayout['m1'].y); // already at top, no change
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
