/**
 * e2e-flow.test.ts — 端到端集成测试：模拟前端所有操作
 *
 * 运行方式：npm test -- -t "E2E"
 * 需要：运行中的 PostgreSQL + 已执行 prisma migrate
 *
 * 覆盖场景：
 *   注册 → 登录 → 创建议题 → 发文本消息 → 发关系消息（赞同/反对/引用/注释/回复/冷藏）
 *   → 发起结算 → 投票 → 关闭结算 → 推翻重结算
 *   → 治理提案 → 代码变更消息 → 清爽视图折叠
 *   → 验证：所有操作都产生 Message 记录
 */

import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { replayFromAuditExport } from '../replay/replay';

const BASE = '/api';

// ─── Helpers ──────────────────────────────────────────────────

function genUser(name: string) {
  return { username: name, password: 'test123456' };
}

async function registerAndLogin(name: string) {
  // Register
  const regRes = await request(app)
    .post(`${BASE}/auth/register`)
    .send(genUser(name));
  // If already registered, login instead
  const token =
    regRes.status === 201
      ? (await request(app).post(`${BASE}/auth/login`).send(genUser(name))).body.token
      : (await request(app).post(`${BASE}/auth/login`).send(genUser(name))).body.token;
  return { token, userId: regRes.body?.user?.id ?? '' };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Tests ────────────────────────────────────────────────────

describe('E2E — 完整用户流程（模拟所有前端操作）', () => {
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };
  let topicId: string;
  let msgId1: string;
  let msgId2: string;

  // 清理：删除之前的测试数据
  beforeAll(async () => {
    // 删除旧 topic（级联会删关联数据，但先手动删子表避免外键问题）
    const oldTopic = await prisma.topic.findFirst({ where: { title: 'E2E 测试议题' } });
    if (oldTopic) {
      const msgs = await prisma.message.findMany({ where: { topicId: oldTopic.id }, select: { id: true } });
      const msgIds = msgs.map(m => m.id);
      if (msgIds.length > 0) {
        await prisma.stake.deleteMany({ where: { messageId: { in: msgIds } } }).catch(() => {});
        await prisma.betPool.deleteMany({ where: { messageId: { in: msgIds } } }).catch(() => {});
        await prisma.settlementRound.deleteMany({ where: { messageId: { in: msgIds } } }).catch(() => {});
        await prisma.ledgerEntry.deleteMany({ where: { messageId: { in: msgIds } } }).catch(() => {});
        await prisma.auditLog.deleteMany({ where: { topicId: oldTopic.id } }).catch(() => {});
        await prisma.message.deleteMany({ where: { topicId: oldTopic.id } }).catch(() => {});
      }
      await prisma.topic.deleteMany({ where: { id: oldTopic.id } }).catch(() => {});
    }
    // 删除测试用户
    const oldUsers = await prisma.user.findMany({
      where: { username: { in: ['e2e_alice', 'e2e_bob'] } },
      select: { id: true },
    });
    for (const u of oldUsers) {
      await prisma.pointTransaction.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.pointAccount.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.balance.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.ledgerEntry.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.stake.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.voteStake.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.settlementRound.deleteMany({ where: { createdByUserId: u.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: u.id } }).catch(() => {});
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Step 1: Auth
  // ═══════════════════════════════════════════════════════════
  it('1. 注册 + 登录', async () => {
    alice = await registerAndLogin('e2e_alice');
    bob = await registerAndLogin('e2e_bob');

    expect(alice.token).toBeTruthy();
    expect(bob.token).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════
  // Step 2: Topic
  // ═══════════════════════════════════════════════════════════
  it('2. 创建议题', async () => {
    const res = await request(app)
      .post(`${BASE}/topics`)
      .set(auth(alice.token))
      .send({ title: 'E2E 测试议题', body: '端到端测试' });

    expect(res.status).toBe(201);
    topicId = res.body.id;
  });

  // ═══════════════════════════════════════════════════════════
  // Step 3: 文本消息
  // ═══════════════════════════════════════════════════════════
  it('3. 发送文本消息（含自押）', async () => {
    // Alice 发消息（自押 3 点）
    const res1 = await request(app)
      .post(`${BASE}/topics/${topicId}/messages`)
      .set(auth(alice.token))
      .send({ content: 'Alice 的观点：应该涨工资', stakeAmount: 3 });

    expect(res1.status).toBe(201);
    expect(res1.body.kind).toBe('TEXT');
    msgId1 = res1.body.id;

    const res2 = await request(app)
      .post(`${BASE}/topics/${topicId}/messages`)
      .set(auth(bob.token))
      .send({ content: 'Bob 的观点：不应该涨工资' });

    expect(res2.status).toBe(201);
    msgId2 = res2.body.id;
  });

  // ═══════════════════════════════════════════════════════════
  // Step 4: 关系消息（赞同/反对/引用/注释/回复/冷藏）
  // ═══════════════════════════════════════════════════════════
  it('4. 创建各类关系消息', async () => {
    // Bob 赞同 Alice 的消息
    const agree = await request(app)
      .post(`${BASE}/topics/${topicId}/relations`)
      .set(auth(bob.token))
      .send({
        relationType: 'AGREE',
        sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId: msgId1 }],
        stakeAmount: 5,
      });
    expect(agree.status).toBe(201);

    // Alice 反对 Bob 的消息
    const disagree = await request(app)
      .post(`${BASE}/topics/${topicId}/relations`)
      .set(auth(alice.token))
      .send({
        relationType: 'DISAGREE',
        sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId: msgId2 }],
        stakeAmount: 2,
      });
    expect(disagree.status).toBe(201);

    // Alice 引用 Bob 的消息（证据）
    const ref = await request(app)
      .post(`${BASE}/topics/${topicId}/relations`)
      .set(auth(alice.token))
      .send({
        relationType: 'REFERENCE',
        sourceMessageId: msgId1,
        targetRefs: [{ kind: 'message', messageId: msgId2 }],
        payload: { label: '证据' },
      });
    expect(ref.status).toBe(201);

    // Bob 注释 Alice 的消息
    const anno = await request(app)
      .post(`${BASE}/topics/${topicId}/relations`)
      .set(auth(bob.token))
      .send({
        relationType: 'ANNOTATION',
        sourceMessageId: msgId2,
        targetRefs: [{ kind: 'message', messageId: msgId1 }],
      });
    expect(anno.status).toBe(201);

    // 冷藏 Alice 的消息（清爽视图用，使用 Alice 自己的 token 避免余额不足）
    for (let i = 0; i < 5; i++) {
      const archive = await request(app)
        .post(`${BASE}/topics/${topicId}/relations`)
        .set(auth(alice.token))
        .send({
          relationType: 'ARCHIVE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: msgId1 }],
        });
      if (archive.status !== 201) {
        console.log(`  ⚠ ARCHIVE #${i + 1}: ${archive.status} ${archive.body?.error ?? ''}`);
      }
      expect(archive.status).toBe(201);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Step 5: 结算流程
  // ═══════════════════════════════════════════════════════════
  it('5. 发起结算 → 投票 → 关闭结算', async () => {
    // 查询已有的自动投票轮（ensureVotingRound 在 TEXT 消息创建时自动生成）
    const roundsRes = await request(app)
      .get(`${BASE}/messages/${msgId1}/rounds`);
    expect(roundsRes.status).toBe(200);
    const autoRound = roundsRes.body.data.find((r: { status: string }) => r.status === 'VOTING');
    expect(autoRound).toBeDefined();
    const roundId = autoRound.id;

    // Bob 投票 TRUE
    const voteRes = await request(app)
      .post(`${BASE}/rounds/${roundId}/votes`)
      .set(auth(bob.token))
      .send({ vote: 'TRUE', amount: 10 });
    expect(voteRes.status).toBe(201);

    // Alice 关闭并结算
    const settleRes = await request(app)
      .post(`${BASE}/rounds/${roundId}/close-and-settle`)
      .set(auth(alice.token))
      .send();

    expect(settleRes.status).toBe(200);
    expect(settleRes.body.result).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════
  // Step 6: 推翻结算
  // ═══════════════════════════════════════════════════════════
  it('6. 发起新一轮结算推翻上一轮', async () => {
    const roundRes = await request(app)
      .post(`${BASE}/messages/${msgId1}/rounds`)
      .set(auth(alice.token))
      .send({ note: '第二轮结算——推翻' });

    console.log('  Round2 status:', roundRes.status, roundRes.body?.error ?? '');
    expect(roundRes.status).toBe(201);
    const roundId2 = roundRes.body.id;

    // Bob 投票 FALSE
    await request(app)
      .post(`${BASE}/rounds/${roundId2}/votes`)
      .set(auth(bob.token))
      .send({ vote: 'FALSE', amount: 20 });

    const settleRes = await request(app)
      .post(`${BASE}/rounds/${roundId2}/close-and-settle`)
      .set(auth(alice.token))
      .send();

    console.log('  Settle2 status:', settleRes.status, settleRes.body?.error ?? '');
    expect(settleRes.status).toBe(200);
  });

  // ═══════════════════════════════════════════════════════════
  // Step 7: 治理提案 + CODE 消息
  // ═══════════════════════════════════════════════════════════
  it('7. 治理提案 + CODE 消息', async () => {
    const govRes = await request(app)
      .post(`${BASE}/topics/${topicId}/messages`)
      .set(auth(alice.token))
      .send({ kind: 'GOVERNANCE', content: '提案：注册奖励从 200 改为 300' });

    expect(govRes.status).toBe(201);
    expect(govRes.body.kind).toBe('GOVERNANCE');

    const codeRes = await request(app)
      .post(`${BASE}/topics/${topicId}/messages`)
      .set(auth(alice.token))
      .send({ kind: 'CODE', content: '// 修改 registrationBonus = 300' });

    expect(codeRes.status).toBe(201);
    expect(codeRes.body.kind).toBe('CODE');
  });

  // ═══════════════════════════════════════════════════════════
  // Step 8: 验证一切皆消息
  // ═══════════════════════════════════════════════════════════
  it('8. 验证：所有操作都产生了 Message 记录', async () => {
    // 直接从数据库查询所有消息（包括 GOVERNANCE/CODE，GET API 只返回 TEXT）
    const allMsgs = await prisma.message.findMany({
      where: { topicId },
      orderBy: { createdAt: 'asc' },
    });

    const kinds = allMsgs.map(m => m.kind);
    const textMsgs = kinds.filter(k => k === 'TEXT');
    const govMsgs = kinds.filter(k => k === 'GOVERNANCE');
    const codeMsgs = kinds.filter(k => k === 'CODE');
    const roundMsgs = kinds.filter(k => k === 'ROUND' || k === 'ROUND_RESULT');
    const relMsgs = kinds.filter(k => k === 'RELATION');

    console.log(`  📊 总消息: ${allMsgs.length} | kind分布: ${JSON.stringify([...new Set(kinds)])}`);

    expect(textMsgs.length).toBeGreaterThanOrEqual(2);
    expect(govMsgs.length).toBe(1);
    expect(codeMsgs.length).toBe(1);
    expect(roundMsgs.length).toBeGreaterThanOrEqual(1);
    expect(relMsgs.length).toBeGreaterThanOrEqual(6);  // AGREE+DISAGREE+REF+ANNO + some ARCHIVE
  });

  // ═══════════════════════════════════════════════════════════
  // Step 9: 验证 ROUND 消息
  // ═══════════════════════════════════════════════════════════
  it('9. 验证：结算产生了 ROUND 和 ROUND_RESULT 消息', async () => {
    // 直接从数据库查询
    const roundMsgs = await prisma.message.findMany({
      where: { topicId, kind: { in: ['ROUND', 'ROUND_RESULT'] } },
    });

    expect(roundMsgs.length).toBeGreaterThanOrEqual(1);  // 至少有一个ROUND/RESULT消息

    const rounds = await prisma.settlementRound.findMany({
      where: { messageId: msgId1 },
      orderBy: { openedAt: 'desc' },
    });

    expect(rounds.length).toBeGreaterThanOrEqual(2);    // 两轮结算
    expect(rounds[0].status).toBe('SETTLED');

    console.log(`  ✅ ROUND消息: ${roundMsgs.filter(m => m.kind === 'ROUND').length}, ROUND_RESULT: ${roundMsgs.filter(m => m.kind === 'ROUND_RESULT').length}`);
    console.log(`  ✅ 结算轮次: ${rounds.length}`);
  });

  // ═══════════════════════════════════════════════════════════
  // Step 10: 审计导出
  // ═══════════════════════════════════════════════════════════
  it('10. 导出可供独立 replay 的经济审计快照', async () => {
    const exportRes = await request(app)
      .get(`${BASE}/topics/${topicId}/export/audit-export`);

    expect(exportRes.status).toBe(200);
    expect(exportRes.body.formatVersion).toBe(1);
    expect(exportRes.body.exportKind).toBe('economic-audit');
    expect(exportRes.body.topicId).toBe(topicId);
    expect(exportRes.body.messages.length).toBeGreaterThanOrEqual(2);
    expect(exportRes.body.auditEvents.length).toBeGreaterThan(0);
    expect(exportRes.body.stakes.length).toBeGreaterThan(0);
    expect(exportRes.body.rounds.length).toBeGreaterThanOrEqual(2);
    expect(exportRes.body.votes.length).toBeGreaterThan(0);
    expect(exportRes.body.votes.some((vote: { roundId: string }) => vote.roundId)).toBe(true);
    expect(exportRes.body.rules.length).toBeGreaterThan(0);

    const replayed = replayFromAuditExport(exportRes.body);
    expect(replayed.stakes.length).toBe(exportRes.body.stakes.length);
    expect(replayed.rounds.size).toBeGreaterThanOrEqual(2);
    expect(replayed.votes.size).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════
  // Step 11: 验证数据一致性
  // ═══════════════════════════════════════════════════════════
  it('10. 验证数据一致性（Balance = PointAccount 总和）', async () => {
    const balRes = await request(app)
      .get(`${BASE}/points/balance`)
      .set(auth(alice.token));

    expect(balRes.status).toBe(200);
    const { available, locked } = balRes.body.points;
    const { amount } = balRes.body.balance;

    expect(amount).toBe(available); // Balance.balance = available（locked from balance deducted）

    console.log(`  ✅ Alice: available=${available}, locked=${locked}, balance=${amount}`);
  });
});
