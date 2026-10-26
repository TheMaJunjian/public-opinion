import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { api } from '../api';
import { queueCommand, runCommandBatch } from '../api/commandBatch';
import { handleSendClick } from '../pages/workbench/actions/sendTransaction';
import { useWorkbenchComposer } from '../pages/workbench/useWorkbenchComposer';

type SendDependencies = Parameters<typeof handleSendClick>[0];
function setupComposer() {
  const hook = renderHook(useWorkbenchComposer);
  const initial = hook.result.current.capture();
  const before = { ...initial, state: { ...initial.state,
    draftUnits: [{ messageId: 'draft', selection: { kind: 'whole' as const } }],
    sourceUnits: [{ messageId: 'source', selection: { kind: 'whole' as const } }],
    targetUnits: [{ messageId: 'target', selection: { kind: 'whole' as const } }],
    activeTextSelectId: 'draft', newMessageContent: '保留输入', relationType: 'agree' as const,
    secondaryRelationType: 'reference', subType: 'custom', subTypeCustomLabel: '自定义', relationLabel: '理由',
    stakeAmount: 3, relStakeAmount: 2, recommendationAmount: 7 },
    textOnTypeSwitch: '切换前文本', customText: '自定义缓冲', textBeforeDelegation: '委托前文本',
    delegationContent: { create: '发布', fulfill: '履行' } };
  act(() => hook.result.current.restore(before));
  const rollback = vi.fn();
  const dependencies: SendDependencies = {
    composer: hook.result.current, captureOptimisticRollback: () => rollback,
    sendInFlightRef: { current: false }, setSendInFlight: vi.fn(), setSendError: vi.fn(),
    handleQuickSendAndRelateFromDraftTargets: vi.fn(async () => {}), onCommitted: vi.fn(),
  };
  return { hook, dependencies, before, rollback };
}

beforeEach(() => {
  vi.restoreAllMocks(); sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 'user', username: '用户' }));
});

describe('composer transaction completion', () => {
  it('guards duplicate clicks and waits for visible progress before capturing or submitting', async () => {
    const { dependencies } = setupComposer();
    let painted!: () => void;
    dependencies.prepare = vi.fn(() => new Promise<void>(resolve => { painted = resolve; }));
    dependencies.onSettled = vi.fn();
    const capture = vi.spyOn(dependencies.composer, 'capture');
    const batch = vi.spyOn(api, 'withCommandBatch').mockResolvedValue(undefined);
    const pending = handleSendClick(dependencies);
    expect(dependencies.sendInFlightRef.current).toBe(true);
    expect(dependencies.prepare).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    await handleSendClick(dependencies);
    expect(dependencies.prepare).toHaveBeenCalledOnce();
    await act(async () => { painted(); await pending; });
    expect(capture).toHaveBeenCalledOnce();
    expect(batch).toHaveBeenCalledOnce();
    expect(dependencies.onSettled).toHaveBeenCalledOnce();
    expect(dependencies.sendInFlightRef.current).toBe(false);
  });
  it('preserves every input and buffer when validation returns without sending a command', async () => {
    const { hook, dependencies, before, rollback } = setupComposer(), commit = vi.fn();
    vi.spyOn(api, 'withCommandBatch').mockImplementation((work, onCommitted) => runCommandBatch(work, commit, onCommitted));
    dependencies.handleQuickSendAndRelateFromDraftTargets = async () => {
      const composer = hook.result.current;
      composer.savedTextOnTypeSwitchRef.current = '';
      composer.subTypeCustomBufferRef.current = '';
      composer.savedTextBeforeDelegationRef.current = '';
      composer.delegationContentBufferRef.current = { create: '', fulfill: '' };
      composer.setNewMessageContent(''); composer.setDraftUnits([]);
      dependencies.setSendError('贡献点不足');
    };
    await act(() => handleSendClick(dependencies));
    expect(commit).not.toHaveBeenCalled();
    expect(hook.result.current.capture()).toEqual(before);
    expect(rollback).not.toHaveBeenCalled();
    expect(dependencies.setSendError).toHaveBeenCalledExactlyOnceWith('贡献点不足');
    expect(dependencies.onCommitted).not.toHaveBeenCalled();
    expect(dependencies.sendInFlightRef.current).toBe(false);
  });
  it('clears the consumed recommendation after a successful command commit', async () => {
    const { hook, dependencies } = setupComposer(), commit = vi.fn().mockResolvedValue({});
    vi.spyOn(api, 'withCommandBatch').mockImplementation((work, onCommitted) => runCommandBatch(work, commit, onCommitted));
    dependencies.handleQuickSendAndRelateFromDraftTargets = async () => {
      queueCommand('/messages', { method: 'POST', body: JSON.stringify({ content: '发送内容' }) });
    };
    await act(() => handleSendClick(dependencies));
    expect(commit).toHaveBeenCalledOnce();
    expect(hook.result.current.recommendationAmount).toBe(0);
    expect(hook.result.current.newMessageContent).toBe('保留输入');
    expect(dependencies.onCommitted).toHaveBeenCalledOnce();
  });
  it('restores the draft and rolls back optimistic data without navigating after rejection', async () => {
    const { hook, dependencies, before, rollback } = setupComposer();
    vi.spyOn(api, 'withCommandBatch').mockRejectedValue(new Error('提交失败'));
    await act(() => handleSendClick(dependencies));
    expect(hook.result.current.capture()).toEqual(before);
    expect(rollback).toHaveBeenCalledOnce();
    expect(dependencies.onCommitted).not.toHaveBeenCalled();
    expect(dependencies.setSendError).toHaveBeenCalledWith('提交失败');
    expect(dependencies.setSendInFlight).toHaveBeenLastCalledWith(false);
  });
});
