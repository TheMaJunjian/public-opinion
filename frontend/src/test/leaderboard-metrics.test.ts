import { describe, expect, it } from 'vitest';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { convertMessagesToDemoModel } from '../utils/modelBridge';
import { buildLeaderboardMetrics, isRelationMessage, isTextMessage } from '../utils/leaderboardMetrics';
import type { Message, Relation, User } from '../types';

const alice: User = { id: 'alice-id', username: 'alice', createdAt: '' };
const bob: User = { id: 'bob-id', username: 'bob', createdAt: '' };
const message = (id: string, kind: DemoMessage['kind'] = 'normal', extra: Partial<DemoMessage> = {}): DemoMessage => ({
  id, kind, author: 'alice', createdAt: '', content: '', ...extra,
});
const relation = (id: string, relationType: string, targetRefs: Relation['targetRefs'], extra: Partial<Relation> = {}): Relation => ({
  id, relationType, targetRefs, sourceMessageId: null, createdAt: '', createdBy: bob, ...extra,
});
const edge = (id: string, relationMessageId: string, fromId: string, toId: string): DemoEdge => ({
  id, relationMessageId, relationType: 'reference', relationLabel: '引用',
  from: { messageId: fromId, selection: { kind: 'whole' } }, to: { messageId: toId, selection: { kind: 'whole' } },
});

describe('排行榜统计口径', () => {
  it('按消息类型区分文本和关系，带正文或呈现为业务卡片的关系仍归关系列表', () => {
    const records = [message('text'), message('reply', 'relation', { content: '带正文的回复', relationType: 'reply' }),
      message('classify', 'relation', { relationType: 'classify' }), message('proposal', 'governance', { relationType: 'proposal' }),
      message('code', 'code', { relationType: 'code_change' }), message('operations', 'operations', { relationType: 'operations' }),
      message('legacy-text-kind', 'normal', { relationType: 'summary' }), message('join', 'join'), message('round', 'round'), message('result', 'round_result')];
    expect(records.filter(isTextMessage).map(record => record.id)).toEqual(['text']);
    expect(records.filter(isRelationMessage).map(record => record.id)).toEqual(['reply', 'classify', 'proposal', 'code', 'operations', 'legacy-text-kind', 'join', 'round', 'result']);
    expect(records.filter(isTextMessage).length + records.filter(isRelationMessage).length).toBe(records.length);
    expect(buildLeaderboardMetrics([...records, records[0], ...records.slice(-3)], [], [], [alice, bob]).rankedMessages).toHaveLength(10);
  });

  it('系统结算按记录的发起人或触发人计数；延时完成回到发起人，缺少归属时保留实际作者', () => {
    const records = [message('subject', 'normal', { author: 'bob', authorId: bob.id }),
      message('request', 'relation', { authorId: alice.id }),
      message('terminate', 'relation', { author: 'bob', authorId: bob.id }),
      message('round', 'round', { author: '公论规则', authorId: 'system', roundPayload: { roundId: 'round', openedBy: alice.id },
        parts: [{ id: 'basis', type: 'data', value: { openedBy: alice.id, triggerId: 'request' } }] }),
      message('result', 'round_result', { author: '公论规则', authorId: 'system', settlementTargetId: 'subject',
        parts: [{ id: 'allocation', type: 'data', value: { source: 'wager', inputs: { roundId: 'round', triggerId: 'terminate' }, allocations: [] } }] }),
      message('delayed', 'round_result', { author: '公论规则', authorId: 'system', settlementTargetId: 'subject',
        parts: [{ id: 'allocation', type: 'data', value: { source: 'wager', inputs: { roundId: 'round', triggerId: 'subject' }, allocations: [] } }] }),
      message('unattributed', 'round', { author: '公论规则', authorId: 'system' })];
    const metrics = buildLeaderboardMetrics(records, [], [], [alice, bob]);
    expect(metrics.sendAuthors.get('round')).toBe('alice');
    expect(metrics.sendAuthors.get('result')).toBe('bob');
    expect(metrics.sendAuthors.get('delayed')).toBe('alice');
    expect(metrics.sendAuthors.get('unattributed')).toBe('公论规则');
    expect(records.slice(3).every(isRelationMessage)).toBe(true);
  });

  it('新版读取实际押注金额和执行目标，旧数据兼容 payload，重复片段不重复计点', () => {
    const records = [message('text'), message('reply', 'relation')];
    const relations = [
      relation('native', 'AGREE', [{ kind: 'relation', relationId: 'reply' }], { spending: { protocol: 1, recommendation: 0, wager: 7 } }),
      relation('legacy', 'DISAGREE', [{ kind: 'message', messageId: 'reply' }, { kind: 'text-fragment', messageId: 'reply', text: 'a', hash: 'a' }], { payload: { amount: 5 } }),
      relation('resolved', 'AGREE', [{ kind: 'relation', relationId: 'native' }], { spending: { protocol: 1, recommendation: 0, wager: 3 },
        executedStance: { partId: 'stance', sourceRevision: 1, side: 'pro', target: { messageId: 'text', revision: 1 } } }),
      relation('zero', 'AGREE', [{ kind: 'message', messageId: 'text' }], { spending: { protocol: 1, recommendation: 0, wager: 0 }, payload: { amount: 100 } }),
      relation('invalid', 'AGREE', [{ kind: 'message', messageId: 'text' }], { payload: { amount: Infinity } }),
    ];
    const metrics = buildLeaderboardMetrics(records, [], [...relations, relations[0]], [alice, bob]);
    expect([...metrics.stanceStakes]).toEqual([['reply', 12], ['text', 3]]);
  });

  it('引用关系消息也计热度，同一引用的多个片段仅计一次', () => {
    const metrics = buildLeaderboardMetrics([message('text'), message('reply', 'relation')], [
      edge('ref-1:0', 'ref-1', 'text', 'reply'), edge('ref-1:1', 'ref-1', 'text', 'reply'), edge('ref-2:0', 'ref-2', 'text', 'reply'),
    ], [], []);
    expect(metrics.incomingReferences.get('reply')?.size).toBe(2);
    expect(metrics.outgoingReferences.get('text')?.size).toBe(2);
  });

  it('只计实际充值分账，待授权申请、运营注入及其他分配不计充值收入', () => {
    const proposals = [relation('approved', 'PROPOSAL', [], { payload: { operationType: 'RECHARGE', amount: 100, revenuePoolShare: 20, recipientUserId: alice.id } }),
      relation('pending', 'PROPOSAL', [], { payload: { operationType: 'RECHARGE', amount: 500, recipientUserId: alice.id } }),
      relation('injection', 'PROPOSAL', [], { payload: { operationType: 'REVENUE_INJECTION', amount: 100 } })];
    const distribution = (id: string, proposalId: string, source = 'grant'): DemoMessage => message(id, 'round_result', {
      parts: [{ id: 'allocation', type: 'data', value: { source, inputs: { proposalId }, allocations: [{ userId: alice.id, amount: 80 }] } }],
    });
    const metrics = buildLeaderboardMetrics([distribution('paid', 'approved'), distribution('operating', 'injection'), distribution('wager', 'approved', 'wager')], [], proposals, [alice, bob]);
    expect([...metrics.rechargeIncome]).toEqual([['alice', 80]]);
    expect(buildLeaderboardMetrics([], [], proposals, [alice, bob]).rechargeIncome.size).toBe(0);
  });

  it('转换后保留关系结算目标，发起和完成同一轮只计一次，充值分配不算结算', () => {
    const target = relation('reply', 'REPLY', []);
    const records: Message[] = [
      { id: 'round', kind: 'ROUND', contentType: 'TEXT', content: '', createdAt: '', createdBy: alice,
        targetRefs: [{ kind: 'relation', relationId: 'reply' }], relationPayload: { roundId: 'round' } as Message['relationPayload'] },
      { id: 'result', kind: 'ROUND_RESULT', contentType: 'TEXT', content: '', createdAt: '', createdBy: alice,
        targetRefs: [{ kind: 'relation', relationId: 'reply' }], parts: [{ id: 'allocation', type: 'data', value: { source: 'wager', inputs: { roundId: 'round' }, allocations: [] } }] },
      { id: 'grant', kind: 'ROUND_RESULT', contentType: 'TEXT', content: '', createdAt: '', createdBy: alice,
        targetRefs: [{ kind: 'relation', relationId: 'reply' }], parts: [{ id: 'allocation', type: 'data', value: { source: 'grant', allocations: [] } }] },
    ];
    const converted = convertMessagesToDemoModel(records, [target]);
    expect(converted.messages.find(record => record.id === 'round')?.settlementTargetId).toBe('reply');
    const metrics = buildLeaderboardMetrics(converted.messages, converted.edges, [target], [alice]);
    expect(metrics.settlements.get('reply')?.size).toBe(1);
  });

  it('价值结算归属原消息，轮次结束记录沿用该轮归属', () => {
    const records: Message[] = [{ id: 'value-round', kind: 'ROUND', contentType: 'TEXT', content: '', createdAt: '', createdBy: alice,
      targetRefs: [{ kind: 'message', messageId: 'claim' }], relationPayload: { subjectId: 'text', roundId: 'value-round' } as Message['relationPayload'] }];
    const converted = convertMessagesToDemoModel(records, []);
    const metrics = buildLeaderboardMetrics([message('text'), message('claim', 'relation'), ...converted.messages, message('value-result', 'round_result', {
      settlementTargetId: 'claim', parts: [{ id: 'allocation', type: 'data', value: { source: 'wager', inputs: { roundId: 'value-round' }, allocations: [] } }],
    })], [], [], [alice]);
    expect([...metrics.settlements.get('text') ?? []]).toEqual(['value-round']);
    expect(metrics.settlements.has('claim')).toBe(false);
  });
});
