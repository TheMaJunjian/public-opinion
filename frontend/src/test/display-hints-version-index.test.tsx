import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { bodyVersion, bodyVersionKey, type ReadingMark } from '@gonglun/core';
import { MessageDisplayHintsProvider, MessageDisplayMarker, useReadingDisplayContext } from '../components/MessageDisplayHints';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import type { DisplayHintsInput } from '../pages/workbench/model/displayHints';
import * as readingVersions from '../pages/workbench/model/readingVersions';
import type { DemoMessage } from '../utils/modelBridge';
import { api } from '../api';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';

// Empty protocol records isolate indexing and version addresses from message text.
function fixture(count: number): DisplayHintsInput {
  const messages: DemoMessage[] = Array.from({ length: count }, (_, index) => ({ id: `m-${index}`, kind: 'normal',
    author: 'fixture', content: '', createdAt: '', revision: 1, parts: [{ id: 'body', type: 'text', text: '' }] }));
  const personalEffect = deriveContainerEffect({ messages, relations: [], edges: [], username: null, stakeCounts: {} });
  return { messages, relations: [], edges: [], username: null, readStatus: new Map(), personalEffect,
    corrections: new Map(), recommendedCorrections: new Map() };
}
const mark = (revision: number): ReadingMark => {
  const version = bodyVersion('m-0', revision);
  return { format: 3, messageId: 'm-0', scope: 'message', key: bodyVersionKey(version), version };
};
afterEach(() => vi.restoreAllMocks());

it('preserves the latest scroll position when a historical body arrives and its layout finishes', async () => {
  let resolveBody!: (value: Awaited<ReturnType<typeof api.resolveBodyVersion>>) => void;
  const resolve = vi.spyOn(api, 'resolveBodyVersion').mockImplementation(() => new Promise(done => { resolveBody = done; }));
  const input = { ...fixture(1), readingMarks: [mark(2)] };
  const tasks = createWorkbenchDrawingTasks();
  const view = render(<WorkbenchDrawingContext.Provider value={tasks}>
    <MessageDisplayHintsProvider input={input} onView={vi.fn()}>
      <div data-workbench-left-panel style={{ overflow: 'auto' }}><MessageDisplayMarker messageId="m-0" /></div>
    </MessageDisplayHintsProvider>
  </WorkbenchDrawingContext.Provider>);
  const pane = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
  pane.scrollTop = 240;
  fireEvent.click(screen.getByRole('button', { name: '切换消息 m-0 的版本' }));
  fireEvent.click(screen.getByRole('radio', { name: /历史正文.*基础 2/ }));
  expect(resolve).toHaveBeenCalledExactlyOnceWith(bodyVersion('m-0', 2));
  // The reader may scroll while the old body is being fetched.
  pane.scrollTop = 360;
  const measurement = tasks.begin('measurement');
  await act(async () => resolveBody({ message: {
    id: 'm-0', revision: 2, authorId: 'fixture', createdAt: '', updatedAt: '', regionId: 'fixture', ledgerId: 'fixture',
    programVersion: '2.0.0', ruleVersion: 1, sequence: 2, spending: { protocol: 0, recommendation: 0, wager: 0 },
    parts: [{ id: 'body', type: 'text', text: '历史正文' }],
  } }));
  expect(screen.getByRole('button', { name: '切换消息 m-0 的版本' })).toHaveAccessibleDescription(/当前固定查看此正文/);
  pane.scrollTop = 900;
  act(() => measurement.release());
  await waitFor(() => expect(pane.scrollTop).toBe(360));
  await waitFor(() => expect(tasks.pending).toBe(0));
});

it('builds the historical-body index once across many markers, nested views and hint interactions', () => {
  const index = vi.spyOn(readingVersions, 'indexKnownReadingBodyVersions');
  const input = { ...fixture(64), readingMarks: [mark(2)] };
  const children = input.messages.map(message => <MessageDisplayMarker key={message.id} messageId={message.id} />);
  const element = (value: DisplayHintsInput) => <MessageDisplayHintsProvider input={value} onView={vi.fn()}>
    {children}
    <MessageDisplayHintsProvider input={{ ...value, displayEffect: value.personalEffect }} onView={vi.fn()}>
      <MessageDisplayMarker messageId="m-1" />
    </MessageDisplayHintsProvider>
  </MessageDisplayHintsProvider>;
  const view = render(element(input));
  expect(view.container.querySelectorAll('[data-display-hint]')).toHaveLength(65);
  expect(index).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /^显示提示 m-0：/ }));
  expect(screen.getByRole('tooltip')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭消息提示' }));
  fireEvent.click(screen.getByRole('button', { name: '切换消息 m-0 的版本' }));
  expect(screen.getByRole('radio', { name: /历史正文.*基础 2/ })).toBeInTheDocument();
  expect(index).toHaveBeenCalledTimes(1);
  // Display-status changes do not change the archive of addressed body versions.
  view.rerender(element({ ...input, readStatus: new Map([['m-1', 'READ']]) }));
  expect(index).toHaveBeenCalledTimes(1);
  view.rerender(element({ ...input, readingMarks: [mark(3)] }));
  expect(index).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('radio', { name: /历史正文.*基础 3/ })).toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: /历史正文.*基础 2/ })).toBeNull();
});

it('refreshes indexed reference versions when messages change and preserves per-message deduplication and meaning exclusion', () => {
  const index = vi.spyOn(readingVersions, 'indexKnownReadingBodyVersions');
  const input = { ...fixture(2), readingMarks: [mark(2), mark(2)] };
  let observed: ReturnType<typeof useReadingDisplayContext>;
  function Probe() { observed = useReadingDisplayContext(); return null; }
  const element = (value: DisplayHintsInput) => <MessageDisplayHintsProvider input={value} onView={vi.fn()}><Probe /></MessageDisplayHintsProvider>;
  const view = render(element(input));
  expect(observed!.knownBodyVersions.get('m-0')).toEqual([bodyVersion('m-0', 2)]);
  expect(observed!.knownBodyVersions.has('m-1')).toBe(false);
  const reference: DemoMessage = { id: 'reference', kind: 'relation', relationType: 'reply', content: '', author: 'fixture', createdAt: '',
    parts: [{ id: 'relation', type: 'relation', relation: 'reply', roles: { target: [
      { id: 'target-0', reference: { messageId: 'm-0', context: { kind: 'MESSAGE', version: bodyVersion('m-0', 2) } } },
      { id: 'target-1', reference: { messageId: 'm-1', context: { kind: 'MESSAGE', version: bodyVersion('m-1', 3) } } },
      { id: 'retired-meaning', reference: { messageId: 'm-1', context: { kind: 'MESSAGE', version: bodyVersion('m-1', 1, [{ messageId: 'meaning', revision: 1, kind: 'MEANING' }]) } } },
    ] } }] };
  const messages = [...input.messages, reference];
  const changed = { ...input, messages, personalEffect: deriveContainerEffect({ messages, relations: [], edges: [], username: null, stakeCounts: {} }) };
  view.rerender(element(changed));
  expect(index).toHaveBeenCalledTimes(2);
  expect(observed!.knownBodyVersions.get('m-0')).toEqual([bodyVersion('m-0', 2)]);
  expect(observed!.knownBodyVersions.get('m-1')).toEqual([bodyVersion('m-1', 3)]);
  view.rerender(element({ ...changed, messages: input.messages, personalEffect: input.personalEffect }));
  expect(index).toHaveBeenCalledTimes(3);
  expect(observed!.knownBodyVersions.has('m-1')).toBe(false);
});
