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

it('isolates preparation edits, overlays preview results, restores the latest live data on cancel, and promotes confirmation atomically',async()=>{
  const {result}=renderHook(useWorkbenchRecords),first=snapshot(1,'实际内容');
  act(()=>result.current.replace(first,projectWorkbenchSnapshot(first)));
  await act(()=>result.current.captureTransient(async()=>{result.current.setMessages([]);}));
  expect(result.current.messages[0].content).toBe('实际内容');
  act(()=>result.current.showSendPreview([snapshot(3,'预览内容')]));
  expect(result.current.messages[0].content).toBe('预览内容');expect(result.current.liveSequence).toBe(1);
  const newer=snapshot(2,'并发更新');
  act(()=>result.current.replace(newer,projectWorkbenchSnapshot(newer)));
  expect(result.current.messages[0].content).toBe('预览内容');
  act(()=>result.current.clearSendPreview());expect(result.current.messages[0].content).toBe('并发更新');
  act(()=>result.current.showSendPreview([snapshot(4,'再次预览')]));
  act(()=>result.current.confirmSendPreview([snapshot(5,'正式内容')]));
  expect(result.current.messages[0].content).toBe('正式内容');expect(result.current.liveSequence).toBe(5);
});

it('keeps newer synchronized records when an older preview confirmation arrives',()=>{
  const {result}=renderHook(useWorkbenchRecords),first=snapshot(1,'实际内容');
  act(()=>result.current.replace(first,projectWorkbenchSnapshot(first)));
  act(()=>result.current.showSendPreview([snapshot(3,'预览内容')]));
  const newer=snapshot(5,'发送期间同步的新内容');
  act(()=>result.current.replace(newer,projectWorkbenchSnapshot(newer)));
  act(()=>result.current.confirmSendPreview([snapshot(4,'较早的发送结果')]));
  expect(result.current.messages[0].content).toBe('发送期间同步的新内容');
  expect(result.current.liveSequence).toBe(5);
});
