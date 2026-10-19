import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { WorkbenchSnapshot } from '@gonglun/core';
import { useWorkbenchRecords } from '../pages/workbench/useWorkbenchRecords';
import { projectWorkbenchSnapshot } from '../utils/workbenchProjection';

const snapshot = (sequence: number, content: string): WorkbenchSnapshot => ({
  scope: { messageId: null, title: '公论' }, sequence, users: [], relations: [], stakes: {}, tagCounts: {}, attentionUsers: {},
  messages: [{ id: 'a', kind: 'TEXT', contentType: 'TEXT', content, createdAt: '', createdBy: { id: 'u', username: '用户', createdAt: '' } }],
});
it('rolls back local edits while preserving a newer authoritative snapshot received during a failed send', () => {
  const { result } = renderHook(useWorkbenchRecords);
  const first = snapshot(1, '初始内容');
  act(() => result.current.replace(first, projectWorkbenchSnapshot(first)));
  const rollback = result.current.captureOptimisticRollback();
  act(() => result.current.setMessages([]));
  act(rollback);
  expect(result.current.messages[0].content).toBe('初始内容');
  const next = snapshot(2, '发送期间收到的新内容');
  act(() => result.current.replace(next, projectWorkbenchSnapshot(next)));
  act(rollback);
  expect(result.current.messages[0].content).toBe('发送期间收到的新内容');
});
