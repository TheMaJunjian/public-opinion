import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { calculateSendCost } from '../hooks/useStakeCalculation';
import { createJoinRelationsForContainer, handleCreateRelationWithSourcesAndTargets } from '../pages/workbench/actions/sendRelation';
import { handleSendMessageOnly } from '../pages/workbench/actions/sendText';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';
import type { Relation } from '../types';

vi.mock('../api', () => ({ api: {
  createMessage: vi.fn(), getMessageStakes: vi.fn(async () => ({ stakes: [] })), cancelCommandBatch: vi.fn(),
} }));

const author = { id: 'u', username: '甲', createdAt: '' };
const message = (id: string): DemoMessage => ({ id, kind: 'normal', revision: 3, author: author.username, createdAt: '', content: '理由', parts: [{ id: 'body', type: 'text', text: '理由' }] });
const relationResult: Relation = { id: 'relation-result', relationType: 'AGREE', sourceMessageId: null, createdAt: '', createdBy: author, targetRefs: [] };

beforeEach(() => vi.clearAllMocks());

describe('addressed send commands', () => {
  it('retains selected reason parts and does not discard an edge merely because another part uses whole visual selection', async () => {
    const source = message('source'), target = { ...message('target'), kind: 'relation' as const, relationType: 'disagree' as const };
    const reasonParts: UnitSelection[] = [
      { messageId: source.id, selection: { kind: 'whole' }, reference: { messageId: source.id, revision: 3, partId: 'body' } },
      { messageId: source.id, selection: { kind: 'whole' }, reference: { messageId: source.id, revision: 3, partId: 'evidence' } },
    ];
    const targets: UnitSelection[] = [
      { messageId: target.id, selection: { kind: 'whole' }, reference: { messageId: target.id, revision: 3, partId: 'body' } },
      { messageId: target.id, selection: { kind: 'edge', edgeId: 'edge' }, reference: { messageId: target.id, revision: 3, partId: 'stance' } },
    ];
    const createRel = vi.fn(async (_scope: string, _data: Parameters<typeof api.createRelation>[1]) => relationResult);
    await handleCreateRelationWithSourcesAndTargets({
      requireAuth: () => true, scopeMessageId: 'root', relationType: 'agree', msgMap: new Map([[source.id, source], [target.id, target]]),
      newMessageContent: '', createRel, registerCreatedRelationInCurrentClassify: vi.fn(async () => null), showAlert: vi.fn(),
      secondaryRelationType: 'none', additionalAgreeTargetIds: [], subType: '', sendTagRelation: vi.fn(async () => null), subTypeCustomLabel: '', setEdges: vi.fn(),
    }, { sources: reasonParts, targets, label: '赞同' });
    expect(createRel).toHaveBeenCalledTimes(2);
    expect(createRel.mock.calls.map(call => call[1])).toMatchObject(targets.map(targetUnit => ({
      sourceRefs: reasonParts.map(part => part.reference), targetRefs: [{ reference: targetUnit.reference }],
    })));
  });

  it('refuses a member join addressed to a part before issuing any command', async () => {
    const createRel = vi.fn(async () => relationResult), setSendError = vi.fn();
    const result = await createJoinRelationsForContainer({
      getDependentDisplayTarget: () => null, setSendError, msgMap: new Map([['a', message('a')]]), containerRelationTypes: new Set(['CLASSIFY']),
      relationsRef: { current: [] }, createRel, scopeMessageId: 'root', appendCreatedRelation: vi.fn(async () => null),
    }, 'classification', 'CLASSIFY', [{ kind: 'message', messageId: 'a', reference: { messageId: 'a', partId: 'body' } }]);
    expect(result).toBe(false); expect(createRel).not.toHaveBeenCalled();
    expect(setSendError).toHaveBeenCalledWith(expect.stringContaining('当前完整消息'));
  });
});

describe('send money and completion', () => {
  it('sends within a classification with only the displayed protocol fee and recommendation', async () => {
    vi.mocked(api.createMessage).mockResolvedValue({ id: 'sent', kind: 'TEXT', contentType: 'TEXT', content: '新消息', createdAt: '', createdBy: author });
    const scroll = vi.fn(), refresh = vi.fn(); window.addEventListener('points-refresh', refresh);
    await handleSendMessageOnly({
      requireAuth: () => true, newMessageContent: '新消息', scopeMessageId: 'root', stakeAmount: 0, setSendError: vi.fn(),
      selectedRelationRef: { current: null }, recommendationRef: { current: 2 }, stakeFeeAmountRef: { current: 1 },
      isInsideClassify: true, availablePoints: 3, currentClassifyRelMsgId: 'classification', setMessages: vi.fn(), mergeStakeSnapshot: vi.fn(),
      setAuthorStakes: vi.fn(), setStakeAmount: vi.fn(), minSelfStake: 0, setNewMessageContent: vi.fn(), scrollMsgToCenter: scroll,
      setClassifyKey: vi.fn(), handleAuthError: vi.fn(async () => false),
    });
    expect(api.createMessage).toHaveBeenCalledWith('classification', expect.objectContaining({ wager: 0, selfAgree: false, recommendation: 2 }));
    expect(scroll).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce();
    window.removeEventListener('points-refresh', refresh);
  });

  it('includes protocol fees for generated governance references without buying extra wagers or recommendations', () => {
    expect(calculateSendCost({ relationType: 'proposal', draftUnits: [{ messageId: 'a' }, { messageId: 'b' }], targetUnits: [], newMessageContent: '提案', stakeAmount: 0, relStakeAmount: 0, recommendationAmount: 2 }, 1)).toMatchObject({
      refCount: 2, refStakeTotal: 0, protocolFeeTotal: 3, stakeTotal: 0, recommendationTotal: 2, total: 5,
    });
  });
});
