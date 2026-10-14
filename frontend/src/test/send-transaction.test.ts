import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { queueCommand, runCommandBatch } from '../api/commandBatch';
import { handleSendClick } from '../pages/workbench/actions/sendTransaction';

type SendDependencies = Parameters<typeof handleSendClick>[0];

function composer(): SendDependencies {
  return {
    sendInFlightRef: { current: false },
    draftUnits: [{ messageId: 'draft', selection: { kind: 'whole' } }],
    sourceUnits: [{ messageId: 'source', selection: { kind: 'whole' } }],
    targetUnits: [{ messageId: 'target', selection: { kind: 'whole' } }],
    activeTextSelectId: 'draft', newMessageContent: '保留输入', relationType: 'agree',
    secondaryRelationType: 'reference', subType: 'custom', subTypeCustomLabel: '自定义', relationLabel: '理由',
    stakeAmount: 3, relStakeAmount: 2, recommendationAmount: 7,
    messages: [], edges: [], relations: [], authorStakes: {}, stakeCounts: {},
    savedTextOnTypeSwitchRef: { current: '切换前文本' }, subTypeCustomBufferRef: { current: '自定义缓冲' },
    savedTextBeforeDelegationRef: { current: '委托前文本' }, delegationContentBufferRef: { current: { create: '发布', fulfill: '履行' } },
    messagesRef: { current: [] }, edgesRef: { current: [] }, relationsRef: { current: [] },
    handleQuickSendAndRelateFromDraftTargets: vi.fn(async () => {}),
    setSendInFlight: vi.fn(), setRecommendationAmount: vi.fn(), setDraftUnits: vi.fn(),
    setSourceUnits: vi.fn(), setTargetUnits: vi.fn(), setActiveTextSelectId: vi.fn(),
    setNewMessageContent: vi.fn(), setRelationType: vi.fn(), setSecondaryRelationType: vi.fn(),
    setSubType: vi.fn(), setRelationLabel: vi.fn(), setSubTypeCustomLabel: vi.fn(), setStakeAmount: vi.fn(),
    setRelStakeAmount: vi.fn(), setMessages: vi.fn(), setEdges: vi.fn(), setRelations: vi.fn(),
    setAuthorStakes: vi.fn(), setStakeCounts: vi.fn(), setSendError: vi.fn(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 'user', username: '用户' }));
});

describe('composer transaction completion', () => {
  it('preserves every input and buffer when validation returns without sending a command', async () => {
    const dependencies = composer(), commit = vi.fn();
    vi.spyOn(api, 'withCommandBatch').mockImplementation((work, onCommitted) => runCommandBatch(work, commit, onCommitted));
    dependencies.handleQuickSendAndRelateFromDraftTargets = async () => {
      dependencies.savedTextOnTypeSwitchRef.current = '';
      dependencies.subTypeCustomBufferRef.current = '';
      dependencies.savedTextBeforeDelegationRef.current = '';
      dependencies.delegationContentBufferRef.current = { create: '', fulfill: '' };
      dependencies.setSendError('贡献点不足');
    };
    await handleSendClick(dependencies);
    expect(commit).not.toHaveBeenCalled();
    for (const [setter, value] of [
      [dependencies.setDraftUnits, dependencies.draftUnits], [dependencies.setSourceUnits, dependencies.sourceUnits],
      [dependencies.setTargetUnits, dependencies.targetUnits], [dependencies.setActiveTextSelectId, 'draft'],
      [dependencies.setNewMessageContent, '保留输入'], [dependencies.setRelationType, 'agree'],
      [dependencies.setSecondaryRelationType, 'reference'], [dependencies.setSubType, 'custom'],
      [dependencies.setSubTypeCustomLabel, '自定义'], [dependencies.setRelationLabel, '理由'],
      [dependencies.setStakeAmount, 3], [dependencies.setRelStakeAmount, 2], [dependencies.setRecommendationAmount, 7],
    ] as const) expect(setter).toHaveBeenLastCalledWith(value);
    expect(dependencies.setRecommendationAmount).not.toHaveBeenCalledWith(0);
    expect(dependencies.savedTextOnTypeSwitchRef.current).toBe('切换前文本');
    expect(dependencies.subTypeCustomBufferRef.current).toBe('自定义缓冲');
    expect(dependencies.savedTextBeforeDelegationRef.current).toBe('委托前文本');
    expect(dependencies.delegationContentBufferRef.current).toEqual({ create: '发布', fulfill: '履行' });
    expect(dependencies.setMessages).not.toHaveBeenCalled();
    expect(dependencies.setSendError).toHaveBeenCalledExactlyOnceWith('贡献点不足');
    expect(dependencies.setSendInFlight).toHaveBeenLastCalledWith(false);
    expect(dependencies.sendInFlightRef.current).toBe(false);
  });

  it('clears the consumed recommendation after a successful command commit', async () => {
    const dependencies = composer(), commit = vi.fn().mockResolvedValue({});
    vi.spyOn(api, 'withCommandBatch').mockImplementation((work, onCommitted) => runCommandBatch(work, commit, onCommitted));
    dependencies.handleQuickSendAndRelateFromDraftTargets = async () => {
      queueCommand('/messages', { method: 'POST', body: JSON.stringify({ content: '发送内容' }) });
    };
    await handleSendClick(dependencies);
    expect(commit).toHaveBeenCalledOnce();
    expect(dependencies.setRecommendationAmount).toHaveBeenCalledExactlyOnceWith(0);
    expect(dependencies.setNewMessageContent).not.toHaveBeenCalled();
  });
});
