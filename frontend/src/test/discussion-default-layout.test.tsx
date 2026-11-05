import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { useDiscussionView } from '../pages/workbench/useDiscussionView';
import type { DiscussionView } from '../utils/discussionView';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';

const storage = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('../utils/exportViewerCache', () => ({ loadExportDiscussionView: storage.load, saveExportDiscussionView: storage.save }));
const defaults = { mode: 'discussion', collapsed: [] };
const native = (): ExportData => ({ format: 'gonglun-view-3', formatVersion: 5, exportedAt: '',
  scope: { messageId: null, title: '' }, messages: [], relations: [], view: {
    username: null, mode: 'graph', messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null,
    cleanFilters: [], classificationId: null,
  } });
const zhihu = () => prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [], comments: [] });
const savedGraph: DiscussionView = { mode: 'graph', collapsed: [JSON.stringify(['saved-target', 'agree'])] };
const newChoice: DiscussionView = { mode: 'discussion', collapsed: [JSON.stringify(['new-target', 'reply'])] };
beforeEach(() => { storage.load.mockReset().mockResolvedValue(null); storage.save.mockReset().mockResolvedValue(undefined); });

describe('application discussion-layout defaults', () => {
  it('defaults null, native live, ordinary native documents and Zhihu to discussion without saving on mount', async () => {
    const first = native(), second = zhihu();
    const hook = renderHook(({ data }: { data: ExportData | null | undefined }) => useDiscussionView(data), { initialProps: { data: null as ExportData | null | undefined } });
    expect(hook.result.current.value).toEqual(defaults);
    hook.rerender({ data: undefined });
    expect(hook.result.current.value).toEqual(defaults);
    hook.rerender({ data: first });
    expect(hook.result.current.value).toEqual(defaults);
    hook.rerender({ data: second });
    expect(hook.result.current.value).toEqual(defaults);
    await act(async () => {});
    expect(storage.load.mock.calls.map(([data]) => data)).toEqual([first, second]);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('respects an explicit graph layout in a file and retains its folds when switching back', async () => {
    const data = native(); data.view!.discussion = { ...savedGraph, collapsed: [...savedGraph.collapsed] };
    const before = structuredClone(data), hook = renderHook(() => useDiscussionView(data));
    expect(hook.result.current.value).toEqual(savedGraph);
    await act(async () => {});
    expect(hook.result.current.value).toEqual(savedGraph);
    const switched = { ...hook.result.current.value, mode: 'discussion' as const };
    act(() => hook.result.current.onChange(switched));
    expect(hook.result.current.value).toEqual(switched);
    expect(storage.save).toHaveBeenCalledWith(data, switched);
    expect(data).toEqual(before);
  });

  it.each([['native', native], ['Zhihu', zhihu]] as const)('restores the %s document cache choice and folds over the default', async (_kind, create) => {
    const data = create();
    storage.load.mockResolvedValueOnce(savedGraph);
    const hook = renderHook(() => useDiscussionView(data));
    expect(hook.result.current.value).toEqual(defaults);
    await waitFor(() => expect(hook.result.current.value).toEqual(savedGraph));
    expect(storage.load).toHaveBeenCalledWith(data);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('does not let a delayed cache choice override a newer user choice in the same document', async () => {
    let complete!: (value: DiscussionView) => void;
    storage.load.mockReturnValueOnce(new Promise<DiscussionView>(resolve => { complete = resolve; }));
    const data = native(), hook = renderHook(() => useDiscussionView(data));
    expect(hook.result.current.value).toEqual(defaults);
    act(() => hook.result.current.onChange(newChoice));
    await act(async () => { complete(savedGraph); });
    expect(hook.result.current.value).toEqual(newChoice);
    expect(storage.save).toHaveBeenCalledWith(data, newChoice);
  });

  it('does not apply a previous file cache response after switching documents', async () => {
    let complete!: (value: DiscussionView) => void;
    storage.load.mockReturnValueOnce(new Promise<DiscussionView>(resolve => { complete = resolve; }));
    const first = native(), second = zhihu();
    const hook = renderHook(({ data }: { data: ExportData | null }) => useDiscussionView(data), { initialProps: { data: first as ExportData | null } });
    hook.rerender({ data: second });
    await act(async () => { complete(savedGraph); });
    expect(hook.result.current.value).toEqual(defaults);
    hook.rerender({ data: null });
    act(() => hook.result.current.onChange(savedGraph));
    expect(hook.result.current.value).toEqual(savedGraph);
    expect(storage.save).not.toHaveBeenCalled();
  });
});
