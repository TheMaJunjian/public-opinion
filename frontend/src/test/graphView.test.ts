import { describe, expect, it } from 'vitest';
import { applyMergeCanvasReservations, buildMergeCanvasReservations } from '../components/GraphView';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

function makeNormal(id: string): DemoMessage {
  return { id, author: 'tester', createdAt: '2024-01-01T00:00:00.000Z', content: id, kind: 'normal' };
}

describe('merge canvas helpers', () => {
  it('builds a merge overlay from both text and relation targets', () => {
    const messages: DemoMessage[] = [
      makeNormal('msg-1'),
      makeNormal('msg-2'),
      makeNormal('msg-3'),
      { id: 'rel-1', author: 'tester', createdAt: '2024-01-01T00:01:00.000Z', content: 'reply', kind: 'relation', relationType: 'reply' },
      { id: 'merge-1', author: 'tester', createdAt: '2024-01-01T00:02:00.000Z', content: 'merge', kind: 'relation', relationType: 'merge' },
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
    expect(reservations[0].headerRect.width).toBeLessThan(80);
    expect(reservations[0].contentRect.height).toBeGreaterThan(250);
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
    });

    expect(layout['msg-3'].y).toBeGreaterThanOrEqual(158);
    expect(layout['msg-4'].y).toBeGreaterThan(layout['msg-3'].y + layout['msg-3'].height);
  });
});
