import { useState } from 'react';
import { act, fireEvent, render, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReadingMark } from '@gonglun/core';
import type { Message, Relation } from '../types';
import { MessageDisplayHintsProvider } from '../components/MessageDisplayHints';
import TraceReadingController from '../components/TraceReadingController';
import { convertMessagesToDemoModel, computeCorrectionVersions } from '../utils/modelBridge';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import type { ReadingNavigationMarkers } from '../hooks/useViewedMessageHighlight';

const writer = { id: 'writer', username: 'writer', createdAt: '' };
const records: Message[] = ['parent', 'current', 'peer', 'child', 'unrelated'].map(id => ({
  id, kind: 'TEXT', content: `${id} 正文`, contentType: 'TEXT', createdAt: '2026-01-01', createdBy: writer,
}));
const relations: Relation[] = [['current', 'parent', 'REPLY'], ['peer', 'parent', 'REFERENCE'], ['child', 'current', 'REPLY']].map(([from, to, relationType]) => ({
  id: `${from}:${to}`, relationType, sourceMessageId: from, targetRefs: [{ kind: 'message', messageId: to }], createdAt: '2026-01-02', createdBy: writer, payload: {},
}));
const model = convertMessagesToDemoModel(records, relations);
const personalEffect = deriveContainerEffect({ ...model, relations, username: 'viewer', stakeCounts: {} });
const input = { ...model, relations, personalEffect, username: 'viewer', readStatus: new Map<string, 'READ' | 'UNREAD'>(),
  corrections: computeCorrectionVersions(model.messages, model.edges) };
const allIds = new Set(model.messages.map(message => message.id));
function Harness({ save = vi.fn<(marks: ReadingMark[]) => Promise<void>>(async () => {}), navigate = vi.fn(), markers = vi.fn(), scope = allIds, allowed = allIds }: {
  save?: (marks: ReadingMark[]) => Promise<void>; navigate?: (id: string, force: boolean) => void;
  markers?: (value: ReadingNavigationMarkers) => void; scope?: ReadonlySet<string>; allowed?: ReadonlySet<string>;
}) {
  const [focus, setFocus] = useState('current'), [marks, setMarks] = useState<ReadingMark[]>([]);
  return <MessageDisplayHintsProvider input={{ ...input, readingMarks: marks }} onView={vi.fn()} onMarkRead={async batch => {
    await save(batch); setMarks(previous => [...previous, ...batch]);
  }}><TraceReadingController scopeKey={focus} scopeIds={scope} allowedIds={allowed} direction="both" order="discussion" onOrder={vi.fn()}
    path={[[focus]]} focusId={focus} focusLocated incoming={[]} ready onBack={vi.fn()} onNavigationChange={markers}
    onNavigate={async (id, _tasks, force = false) => { navigate(id, force); setFocus(id); }} /></MessageDisplayHintsProvider>;
}

it('switches directions without reading or navigating, then previews and follows the chosen peer', async () => {
  const save = vi.fn<(marks: ReadingMark[]) => Promise<void>>(async () => {}), navigate = vi.fn(), markers = vi.fn();
  const view = render(<Harness save={save} navigate={navigate} markers={markers} />);
  const controls = within(view.getByRole('group', { name: '讨论关系导航' }));
  fireEvent.click(controls.getByRole('button', { name: '同层 · 同一分支（1）' }));
  expect(controls.getByRole('button', { name: '同层 · 同一分支（1）' })).toHaveAttribute('aria-pressed', 'true');
  expect(view.container.querySelector('[data-reading-continue-target]')).toHaveTextContent('同层 · 同一分支');
  expect(view.container.querySelector('[data-reading-neighbor="peer"]')).toHaveTextContent('引用 · 待阅');
  expect(markers.mock.lastCall?.[0].continue).toBe('peer');
  expect(save).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(view.getByRole('button', { name: '已读并继续' })));
  expect(navigate).toHaveBeenLastCalledWith('peer', false);
  expect(save.mock.calls[0][0].filter(mark => mark.scope === 'message').map(mark => mark.messageId)).toEqual(['current']);
  expect(view.container.querySelector('[data-reading-current-id]')).toHaveAttribute('data-reading-current-id', 'peer');
  expect(controls.getByRole('button', { name: /^同层 · 同一分支/ })).toHaveAttribute('aria-pressed', 'true');
});

it.each(['up', 'down'] as const)('opens a chosen %s neighbor without marking anything read', async direction => {
  const save = vi.fn<(marks: ReadingMark[]) => Promise<void>>(async () => {}), navigate = vi.fn();
  const view = render(<Harness save={save} navigate={navigate} />), label = direction === 'up' ? '上层 · 前因／依据' : '下层 · 回复／后续';
  const id = direction === 'up' ? 'parent' : 'child';
  fireEvent.click(view.getByRole('button', { name: `${label}（1）` }));
  await act(async () => fireEvent.click(view.getByRole('button', { name: `阅读${label} ${id}` })));
  expect(navigate).toHaveBeenCalledWith(id, false); expect(save).not.toHaveBeenCalled();
});

it('uses the chosen direction for next and keeps skipped messages unread', async () => {
  const save = vi.fn<(marks: ReadingMark[]) => Promise<void>>(async () => {}), navigate = vi.fn();
  const view = render(<Harness save={save} navigate={navigate} />);
  fireEvent.click(view.getByRole('button', { name: '同层 · 同一分支（1）' }));
  expect(view.container.querySelector('[data-reading-continue-target]')).toHaveTextContent('下一条 → 同层 · 同一分支：');
  await act(async () => fireEvent.click(view.getByRole('button', { name: '下一条' })));
  expect(navigate).toHaveBeenLastCalledWith('peer', false);
  expect(view.container.querySelector('[data-reading-neighbor="current"]')).toHaveTextContent('待阅');
  await act(async () => fireEvent.click(view.getByRole('button', { name: '下一条' })));
  expect(navigate).toHaveBeenLastCalledWith('current', false);
  expect(save).not.toHaveBeenCalled();
});

it.each(['outside', 'filtered'] as const)('keeps an unavailable peer explicit and never changes direction after confirming (%s)', async location => {
  const save = vi.fn<(marks: ReadingMark[]) => Promise<void>>(async () => {}), navigate = vi.fn(), markers = vi.fn();
  const limited = new Set([...allIds].filter(id => id !== 'peer'));
  const view = render(<Harness save={save} navigate={navigate} markers={markers}
    scope={location === 'outside' ? limited : allIds} allowed={location === 'filtered' ? limited : allIds} />);
  fireEvent.click(view.getByRole('button', { name: '同层 · 同一分支（1）' }));
  expect(view.container.querySelector('[data-reading-neighbor="peer"]')).toHaveTextContent(location === 'outside' ? '范围外，点击继续追溯' : '筛选隐藏，点击临时显示');
  expect(markers.mock.lastCall?.[0].continue).toBeNull();
  expect(view.getByRole('button', { name: '下一条' })).toBeDisabled();
  expect(view.queryByRole('button', { name: '已读并继续' })).toBeNull();
  await act(async () => fireEvent.click(view.getByRole('button', { name: '已读' })));
  expect(save).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(view.getByRole('button', { name: '阅读同层 · 同一分支 peer' })));
  expect(navigate).toHaveBeenLastCalledWith('peer', location === 'outside');
  expect(save).toHaveBeenCalledOnce();
});
