/**
 * replay.test.ts — D5: replay/verify 集成测试
 */

import { prisma } from '../lib/prisma';
import { replay, replayFromAuditExport, replayFromExport } from '../replay/replay';
import { verify } from '../replay/verify';
import { applyEvent } from '../lib/events';

const PREFIX = 'rply-';

describe('Replay/Verify', () => {
  it('rebuilds messages and relation history from export format v2', () => {
    const state = replayFromExport({
      formatVersion: 2,
      topicId: 'topic-1',
      messages: [{
        id: 'message-1', kind: 'TEXT', contentType: 'TEXT', content: '原始观点', authorId: 'user-a',
        targetRefs: null, relationPayload: null, relationType: null, sourceMessageId: null,
        supersededBy: null,
      }],
      relations: [{
        id: 'relation-1', relationType: 'DISAGREE', sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId: 'message-1' }], payload: { content: '反驳' },
        authorId: 'user-b', supersededBy: 'relation-2',
      }, {
        id: 'relation-2', relationType: 'DISAGREE', sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId: 'message-1' }], payload: { content: '更新后的反驳' },
        authorId: 'user-b', supersededBy: null,
      }],
    });

    expect(state.messages.get('message-1')?.content).toBe('原始观点');
    expect(state.messages.get('relation-1')?.supersededBy).toBe('relation-2');
    expect(state.messages.get('relation-2')?.relationPayload).toEqual({ content: '更新后的反驳' });
  });

  it('rejects unknown export versions', () => {
    expect(() => replayFromExport({ formatVersion: 1, topicId: 'topic-1', messages: [], relations: [] }))
      .toThrow('Unsupported export format version: 1');
  });

  it('replays topic-local stakes, relation votes and settlement from audit events', () => {
    const state = replayFromAuditExport({
      formatVersion: 1,
      exportKind: 'economic-audit',
      topicId: 'topic-1',
      auditEvents: [
        { id: '1', createdAt: '2026-08-01T00:00:00.000Z', actorId: 'user-a', action: 'USER_REGISTERED', entityId: 'user-a', data: { details: {} } },
        { id: '2', createdAt: '2026-08-01T00:00:01.000Z', actorId: 'user-a', action: 'MESSAGE_CREATED', entityId: 'round-message', data: { details: { kind: 'ROUND', targetMessageId: 'message-1', roundId: 'round-1', settlementType: 'TRUTH' } } },
        { id: '3', createdAt: '2026-08-01T00:00:02.000Z', actorId: 'user-a', action: 'STAKE_PLACED', entityId: 'stake-1', data: { details: { messageId: 'message-1', side: 'PRO', amount: 10, roundId: 'round-1', settlementType: 'TRUTH', feeAmount: 1 } } },
        { id: '4', createdAt: '2026-08-01T00:00:03.000Z', actorId: 'user-b', action: 'RELATION_CREATED', entityId: 'relation-1', data: { details: { relationType: 'DISAGREE', relationPayload: { vote: true, amount: 5, roundId: 'round-1' } } } },
        { id: '5', createdAt: '2026-08-01T00:00:04.000Z', actorId: 'user-a', action: 'ROUND_SETTLED', entityId: 'round-1', data: { details: { messageId: 'message-1', roundId: 'round-1', result: 'TRUE', weights: { TRUE: 10, FALSE: 5 }, totalPro: 10, totalCon: 5 } } },
      ],
    });

    expect(state.stakeTotals.get('message-1')).toEqual({ pro: 10, con: 0 });
    expect(state.votes.get('round-1')).toEqual([{ userId: 'user-b', vote: 'FALSE', amount: 5 }]);
    expect(state.rounds.get('round-1')?.result).toBe('TRUE');
  });

  beforeAll(async () => {
    const ids = [`${PREFIX}a`, `${PREFIX}b`];
    const ourTopics = await prisma.topic.findMany({ where: { createdById: { in: ids } }, select: { id: true } });
    const ourTopicIds = ourTopics.map(topic => topic.id);
    const ourMsgs = await prisma.message.findMany({ where: { topicId: { in: ourTopicIds } }, select: { id: true } });
    const ourMsgIds = ourMsgs.map(message => message.id);
    const ourRounds = await prisma.settlementRound.findMany({ where: { messageId: { in: ourMsgIds } }, select: { id: true } });
    const ourRoundIds = ourRounds.map(r => r.id);

    if (ourRoundIds.length > 0) await prisma.voteStake.deleteMany({ where: { roundId: { in: ourRoundIds } } });
    if (ourRoundIds.length > 0) await prisma.settlementRound.deleteMany({ where: { id: { in: ourRoundIds } } });
    if (ourTopicIds.length > 0) {
      await prisma.stake.deleteMany({ where: { topicId: { in: ourTopicIds } } });
    }
    await prisma.betPool.deleteMany({ where: { messageId: { in: ourMsgIds } } });
    await prisma.pointTransaction.deleteMany({ where: { userId: { in: ids } } });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: ids } } });
    await prisma.balance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.pointAccount.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    if (ourTopicIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { topicId: { in: ourTopicIds } } });
      await prisma.message.deleteMany({ where: { topicId: { in: ourTopicIds } } });
      await prisma.topic.deleteMany({ where: { id: { in: ourTopicIds } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it('stake totals and BetPool match after fresh events', async () => {
    // Register
    await applyEvent({ type: 'USER_REGISTERED', actorId: `${PREFIX}a`, payload: { username: 'ra', passwordHash: 'x' } });
    await applyEvent({ type: 'USER_REGISTERED', actorId: `${PREFIX}b`, payload: { username: 'rb', passwordHash: 'x' } });

    // Topic
    const t = await applyEvent({ type: 'TOPIC_CREATED', actorId: `${PREFIX}a`, payload: { title: 'Replay' } });
    const tid = (t as { id: string }).id;

    // Message + self-stake (10)
    const m = await applyEvent({ type: 'MESSAGE_CREATED', actorId: `${PREFIX}a`, topicId: tid, payload: { kind: 'TEXT', content: 'x', stakeAmount: 10 } });
    const mid = (m as { id: string }).id;

    // AGREE (20) + DISAGREE (5)
    await applyEvent({ type: 'RELATION_CREATED', actorId: `${PREFIX}b`, topicId: tid, payload: { relationType: 'AGREE', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: mid }], stakeAmount: 20 } });
    await applyEvent({ type: 'RELATION_CREATED', actorId: `${PREFIX}a`, topicId: tid, payload: { relationType: 'DISAGREE', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: mid }], stakeAmount: 5 } });

    const state = await replay();
    const report = await verify(state);

    const our = report.diffs.filter(d => d.id.startsWith(PREFIX) || d.id.startsWith(mid));
    expect(our.filter(d => d.type === 'Stake')).toHaveLength(0);
    expect(our.filter(d => d.type === 'BetPool')).toHaveLength(0);
  });
});

