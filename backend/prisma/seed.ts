/**
 * prisma/seed.ts — Seed initial data (default admin user + rule).
 *
 * Usage: npx prisma db seed
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createId } from '@paralleldrive/cuid2';

const prisma = new PrismaClient();

const DEFAULT_USERNAME = 'MaJunJian';
const DEFAULT_PASSWORD = 'test123456';
const REGISTRATION_BONUS = 2000;

async function main() {
  // ── 1. Default user ────────────────────────────────────────
  const existingUser = await prisma.user.findUnique({ where: { username: DEFAULT_USERNAME } });

  if (existingUser) {
    console.log(`User "${DEFAULT_USERNAME}" already exists, skipping.`);
  } else {
    const defaultUserId = createId();
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    await prisma.$transaction([
      prisma.user.create({
        data: { id: defaultUserId, username: DEFAULT_USERNAME, password: hashedPassword },
      }),
      prisma.balance.create({ data: { userId: defaultUserId, balance: REGISTRATION_BONUS, debtFrozen: false } }),
      prisma.pointAccount.create({ data: { userId: defaultUserId, available: REGISTRATION_BONUS, locked: 0 } }),
      prisma.pointTransaction.create({
        data: { userId: defaultUserId, type: 'MINT', amount: REGISTRATION_BONUS, balanceAfter: REGISTRATION_BONUS, data: { reason: 'REGISTRATION_BONUS' } },
      }),
      prisma.ledgerEntry.create({
        data: { userId: defaultUserId, entryType: 'MINT_INITIAL', amount: REGISTRATION_BONUS, balanceAfter: REGISTRATION_BONUS, data: { reason: 'REGISTRATION_BONUS' } },
      }),
      prisma.auditLog.create({
        data: { actorId: defaultUserId, action: 'USER_REGISTERED', entityType: 'User', entityId: defaultUserId, data: { summary: `用户 ${DEFAULT_USERNAME} 注册`, details: { username: DEFAULT_USERNAME }, version: 1 } },
      }),
      prisma.auditLog.create({
        data: { actorId: defaultUserId, action: 'POINT_MINTED', entityType: 'PointTransaction', entityId: defaultUserId, data: { summary: `注册奖励 ${REGISTRATION_BONUS} 点`, details: { amount: REGISTRATION_BONUS, reason: 'REGISTRATION_BONUS' }, version: 1 } },
      }),
    ]);

    console.log(`Seed: created user "${DEFAULT_USERNAME}" (password: ${DEFAULT_PASSWORD}).`);
  }

  // ── 2. RuleVersion v1 ──────────────────────────────────────
  const existingRule = await prisma.ruleVersion.findFirst({ where: { version: 1 } });
  if (existingRule) {
    console.log('RuleVersion v1 already exists, skipping.');
    return;
  }

  await prisma.ruleVersion.create({
    data: {
      version: 1,
      status: 'ACTIVE',
      description: '初始默认规则 — 关系分级 1~50、自押 10、手续费 1 入收入池、创建者奖励 20%',
      parameters: {
        minStake: 1,
        maxSingleStake: null,       // 无单注保护上限
        weightFunction: 'linear',   // 线性权重
        concurrentRoundLimit: 1,    // 同一消息最多 1 个进行中轮次
        selfStakeOnCreate: 10,      // 创建消息时自动自押 PRO 点数（0=关闭）
        settlementPermission: 'anyone', // 结算权限：creator_only | any_voter | anyone
        stakeFeeAmount: 1,          // 每次押注/投票手续费点数（进入收入池，0=关闭）
        settlementFeeAmount: 0,     // 结算不收费
        creatorRewardRatio: 0.2,    // 结算 TRUE 时创建者优先获得 CON 池的 20%
        revenueDistribution: {       // 收入池分配规则
          trigger: 'manual',         // 触发方式: manual | per_settlement | threshold
          thresholdAmount: 1000,     // threshold 模式：池余额 ≥ 此值时自动分配
          contributorShare: 0.5,     // 按贡献点持有比例分配给用户
          auditorShare: 0.2,         // 审计节点份额（暂留池中）
          publicPoolShare: 0.3,      // 公共池份额（暂留池中）
        },
        relationTypeMinStake: {     // 不同关系类型的最低自押点数
          REFERENCE:   1,  AGREE:       1,  DISAGREE:    1,
          TAG:         3,  RECOMMEND:   3,
          ANNOTATION:  5,  REPLY:       5,
          ARCHIVE:     7,
          ARRANGE:    10,  CORRECT:    10,
          CLASSIFY:   20,  MERGE:      30,  SUMMARY:     50,
        },
        subTypeMinStake: {          // 不同标注理由（subType）的最低自押点数
          SPAM:        5,  // 垃圾：需要较多押注以表明诚意
          OFFTOPIC:    5,  // 跑题
          LOWVALUE:    5,  // 低质
          IMPORTANT:  10,  // 重要：更高押注门槛
          CUSTOM:      5,  // 自定义
        },
      },
    },
  });

  console.log('Seed complete: RuleVersion v1 created.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
