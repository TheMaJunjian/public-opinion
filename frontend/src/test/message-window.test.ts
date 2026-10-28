import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useMessageWindow } from '../hooks/useMessageWindow';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import { createElement, type ReactNode } from 'react';

const messages: DemoMessage[] = Array.from({ length: 150 }, (_, index) => ({ id: `m-${index}`, author: '用户', kind: 'normal', content: '', createdAt: new Date(index * 1000).toISOString() }));
it('pages a mixed message list chronologically while keeping the graph placement available for discussion reading',()=>{
  const texts=messages.slice(0,52).map((message,index)=>({...message,createdAt:new Date(index*60000).toISOString()}));
  const record:DemoMessage={...messages[0],id:'early-record',kind:'relation',relationType:'agree',createdAt:new Date(30000).toISOString()};
  const {result}=renderHook(()=>useMessageWindow([...texts,record],[],true,'list',[],true,'time'));
  expect(result.current.messages.slice(0,3).map(message=>message.id)).toEqual(['m-0','early-record','m-1']);
  expect(result.current.messages).toHaveLength(50);expect(result.current.hasMore).toBe(true);
  expect(result.current.structureOrder?.at(-1)).toBe('early-record');
});
it('keeps independent page ranges for each scope and restores the parent range on return', async () => {
  const { result, rerender } = renderHook(({ scope, pinned }) => useMessageWindow(messages, [], true, scope, pinned),
    { initialProps: { scope: 'root', pinned: [] as string[] } });
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.messages).toHaveLength(100);
  rerender({ scope: 'child', pinned: ['m-149'] });
  expect(result.current.messages).toHaveLength(150);
  expect(result.current.messages.at(-1)?.id).toBe('m-149');
  await act(() => result.current.more());
  expect(result.current.messages).toHaveLength(150);
  rerender({ scope: 'root', pinned: [] });
  expect(result.current.messages).toHaveLength(100);
});

const edge = (relationMessageId: string, relationType: DemoEdge['relationType'], from: string, to: string): DemoEdge => ({
  id: `${relationMessageId}-${to}`, relationMessageId, relationType, relationLabel: '',
  from: { messageId: from, selection: { kind: 'whole' } }, to: { messageId: to, selection: { kind: 'whole' } },
});

it('keeps an inline organization and every visible member together across the old 50-message boundary', () => {
  const frame: DemoMessage = { ...messages[0], id: 'frame', kind: 'relation', relationType: 'arrange' };
  const records = [...messages, frame];
  const edges = [edge('frame', 'arrange', 'anon:frame', 'm-0'), edge('frame', 'arrange', 'anon:frame', 'm-149')];
  const { result } = renderHook(() => useMessageWindow(records, edges, true, 'root', []));
  const visible = new Set(result.current.messages.map(message => message.id));
  expect(visible.has('m-0')).toBe(true);
  expect(visible.has('m-149')).toBe(true);
  expect(visible.has('frame')).toBe(true);
  expect(result.current.edges).toEqual(edges);
  expect(result.current.hasMore).toBe(true);
});

it('pins the entire relation structure rather than showing an isolated target or a dangling edge', () => {
  const relation: DemoMessage = { ...messages[0], id: 'reply', kind: 'relation', relationType: 'reply' };
  const edges = [edge('reply', 'reply', 'm-148', 'm-149')];
  const { result } = renderHook(() => useMessageWindow([...messages, relation], edges, true, 'root', ['m-149']));
  expect(result.current.messages.map(message => message.id)).toEqual(expect.arrayContaining(['m-148', 'm-149', 'reply']));
  expect(result.current.edges).toEqual(edges);
});

it('counts a large connected structure as one unit and never truncates its body to a raw row limit', () => {
  const frame: DemoMessage = { ...messages[0], id: 'large-frame', kind: 'relation', relationType: 'merge' };
  const edges = messages.map(message => edge(frame.id, 'merge', `anon:${frame.id}`, message.id));
  const { result } = renderHook(() => useMessageWindow([...messages, frame], edges, true, 'root', []));
  expect(result.current.messages).toHaveLength(151);
  expect(result.current.hasMore).toBe(false);
});

it('can navigate to a relation drawn only as an edge and brings its full component into the page', () => {
  const edges = [edge('edge-only', 'reference', 'm-148', 'm-149')];
  const { result } = renderHook(() => useMessageWindow(messages, edges, true, 'root', ['edge-only']));
  expect(result.current.messages.map(message => message.id)).toEqual(expect.arrayContaining(['m-148', 'm-149']));
  expect(result.current.edges).toEqual(edges);
});

it('keeps a closed classification opaque and preserves its member references without mounting another scope', () => {
  const classification: DemoMessage = { ...messages[0], id: 'closed', kind: 'relation', relationType: 'classify' };
  const edges = [edge('closed', 'classify', 'anon:closed', 'hidden-child')];
  const { result } = renderHook(() => useMessageWindow([classification, ...messages], edges, true, 'root', []));
  expect(result.current.messages).toContain(classification);
  expect(result.current.messages.some(message => message.id === 'hidden-child')).toBe(false);
  expect(result.current.edges).toEqual(edges);
});

it('coalesces repeated expansion until all measurements finish and becomes a no-op at the end', async () => {
  const tasks = createWorkbenchDrawingTasks(); tasks.setBlocking(false);
  const edges: DemoEdge[] = [];
  const { result } = renderHook(() => useMessageWindow(messages, edges, true, 'root', []), {
    wrapper: ({ children }: { children: ReactNode }) => createElement(WorkbenchDrawingContext.Provider, { value: tasks }, children),
  });
  const measurement = tasks.begin('measurement');
  let first!: Promise<void>, repeated!: Promise<void>;
  act(() => { first = result.current.more(); repeated = result.current.more(); });
  expect(first).toBe(repeated);
  expect(result.current.messages).toHaveLength(100);
  expect(result.current.loading).toBe(true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
  expect(result.current.loading).toBe(true);
  act(() => measurement.release());
  await waitFor(() => expect(result.current.loading).toBe(false));
  await first;
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.messages).toHaveLength(150);
  expect(result.current.hasMore).toBe(false);
  await act(() => Promise.all(Array.from({ length: 20 }, () => result.current.more())));
  expect(result.current.messages).toHaveLength(150);
  expect(tasks.pending).toBe(0);
});

it('keeps navigation ranges after deselection, and leaves trace/preview projections complete', () => {
  const edges: DemoEdge[] = [];
  const { result, rerender } = renderHook(({ pinned, enabled }) => useMessageWindow(messages, edges, enabled, 'root', pinned),
    { initialProps: { pinned: ['m-149'], enabled: true } });
  expect(result.current.messages).toHaveLength(150);
  rerender({ pinned: [], enabled: true });
  expect(result.current.messages).toHaveLength(150);
  rerender({ pinned: [], enabled: false });
  expect(result.current.messages).toBe(messages);
  expect(result.current.edges).toBe(edges);
  expect(result.current.hasMore).toBe(false);
});

it('does not start automatic DOM work while another workbench operation is blocking interaction', async () => {
  const tasks = createWorkbenchDrawingTasks();
  const edges: DemoEdge[] = [];
  const { result } = renderHook(() => useMessageWindow(messages, edges, true, 'root', []), {
    wrapper: ({ children }: { children: ReactNode }) => createElement(WorkbenchDrawingContext.Provider, { value: tasks }, children),
  });
  await act(() => result.current.more());
  expect(result.current.messages).toHaveLength(50);
  expect(tasks.pending).toBe(0);
  tasks.setBlocking(false);
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.messages).toHaveLength(100);
});
