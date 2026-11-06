import { expect, it, vi } from 'vitest';
import { createSceneComputationKey, sceneComputationKey } from '../utils/sceneComputationKey';
import type { DemoMessage } from '../utils/modelBridge';

it('updates measurement keys without rereading every unchanged message and keeps restored-value equality', () => {
  const parts = vi.fn(() => [{ id: 'body', type: 'text' as const, text: '技术正文' }]);
  const messages: DemoMessage[] = Array.from({ length: 1000 }, (_, index) => ({ id: String(index),
    kind: 'normal', author: 'test', content: '技术正文', createdAt: '', get parts() { return parts(); } }));
  const input = { allMessages: messages, normals: messages, measuredHeights: { '0': 100 },
    correctedTargetIds: new Set(['1']), colOf: { '0': 0 }, maxCol: 0 };
  const key = createSceneComputationKey();
  const initial = key({ kind: 'layout', input } as { input: object });
  expect(parts).toHaveBeenCalled(); parts.mockClear();
  const resized = { kind: 'layout', input: { ...input, measuredHeights: { '0': 200 } } };
  const changed = key(resized);
  expect(changed).not.toBe(initial);
  expect(parts).not.toHaveBeenCalled();
  expect(changed).toBe(sceneComputationKey(structuredClone(resized)));
  expect(key(structuredClone(resized))).toBe(changed);
});

it('invalidates cached fields when chronology, message visibility or input fields change', () => {
  const messages: DemoMessage[] = ['a', 'b'].map(id => ({ id, kind: 'normal', author: 'test', createdAt: id === 'a' ? '2026-01-01' : '2026-01-02', content: '' }));
  const key = createSceneComputationKey();
  const input = { messages, edges: [], order: 'time' };
  const first = key({ input });
  const reordered = { ...input, messages: [messages[0], { ...messages[1], createdAt: '2025-01-01' }] };
  expect(key({ input: reordered })).not.toBe(first);
  expect(key({ input: reordered })).toBe(sceneComputationKey({ input: reordered }));
  const { order: _order, ...withoutOrder } = reordered;
  expect(key({ input: withoutOrder })).toBe(sceneComputationKey({ input: withoutOrder }));
  expect(key(null)).toBeNull();
});
