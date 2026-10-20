import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useMessageWindow } from '../hooks/useMessageWindow';
import type { DemoMessage } from '../utils/modelBridge';

const messages: DemoMessage[] = Array.from({ length: 150 }, (_, index) => ({ id: `m-${index}`, author: '用户', kind: 'normal', content: '', createdAt: '' }));
it('retains pages already viewed before the global catalog arrives, pages new scopes, and pins navigation targets', async () => {
  const { result, rerender } = renderHook(({ ready, count, scope, pinned }) => useMessageWindow(messages.slice(0, count), [], ready, scope, pinned, !ready),
    { initialProps: { ready: false, count: 50, scope: 'root', pinned: [] as string[] } });
  rerender({ ready: false, count: 100, scope: 'root', pinned: [] });
  rerender({ ready: true, count: 150, scope: 'root', pinned: [] });
  expect(result.current.messages).toHaveLength(100);
  rerender({ ready: true, count: 150, scope: 'child', pinned: ['m-149'] });
  expect(result.current.messages).toHaveLength(51);
  expect(result.current.messages.at(-1)?.id).toBe('m-149');
  await act(() => result.current.more());
  expect(result.current.messages).toHaveLength(101);
});
