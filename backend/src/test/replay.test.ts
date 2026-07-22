/**
 * replay.test.ts — D5: replay/verify 集成测试
 */

import { prisma } from '../lib/prisma';
import { replay } from '../replay/replay';
import { verify } from '../replay/verify';
import { applyEvent } from '../lib/events';

const PREFIX = 'rply-';

describe('Replay/Verify', () => {
  beforeAll(async () => {
    const ids = [`${PREFIX}a`, `${PREFIX}b`];
    const ourMsgs = await prisma.message.findMany({ where: { createdById: { in: ids } }, select: { id: true } });
    const ourMsgIds = ourMsgs.map(m => m.id);
    const ourRounds = await prisma.settlementRound.findMany({ where: { messageId: { in: ourMsgIds } }, select: { id: true } });
    const ourRoundIds = ourRounds.map(r => r.id);

    if (ourRoundIds.length > 0) await prisma.voteStake.deleteMany({ where: { roundId: { in: ourRoundIds } } });
    if (ourRoundIds.length > 0) await prisma.settlementRound.deleteMany({ where: { id: { in: ourRoundIds } } });
    await prisma.stake.deleteMany({ where: { userId: { in: ids } } });
    await prisma.betPool.deleteMany({ where: { messageId: { in: ourMsgIds } } });
    await prisma.pointTransaction.deleteMany({ where: { userId: { in: ids } } });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: ids } } });
    await prisma.balance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.pointAccount.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.message.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.topic.deleteMany({ where: { createdById: { in: ids } } });
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

