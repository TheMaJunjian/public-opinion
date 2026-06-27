/**
 * prisma/seed.ts — Seed initial data (RuleVersion v1).
 *
 * Usage: npx prisma db seed
 * Requires "prisma": { "seed": "ts-node prisma/seed.ts" } in package.json
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // ── RuleVersion v1: 初始经济规则 ──────────────────────────
  const existing = await prisma.ruleVersion.findFirst({
    where: { version: 1 },
  });

  if (existing) {
    console.log('RuleVersion v1 already exists, skipping seed.');
    return;
  }

  await prisma.ruleVersion.create({
    data: {
      version: 1,
      status: 'ACTIVE',
      description: '初始默认规则 — 关系分级 1~50、自押 10、燃烧 1、创建者奖励 20%',
      parameters: {
        minStake: 1,
        maxSingleStake: null,       // 无单注保护上限
        weightFunction: 'linear',   // 线性权重
        concurrentRoundLimit: 1,    // 同一消息最多 1 个进行中轮次
        selfStakeOnCreate: 10,      // 创建消息时自动自押 PRO 点数（0=关闭）
        settlementPermission: 'anyone', // 结算权限：creator_only | any_voter | anyone
        stakeFeeAmount: 1,          // 每次押注/投票固定燃烧点数（0=关闭）
        settlementFeeAmount: 0,     // 结算不燃烧
        creatorRewardRatio: 0.2,    // 结算 TRUE 时创建者优先获得 CON 池的 20%
        relationTypeMinStake: {     // 不同关系类型的最低自押点数
          REFERENCE:   1,  AGREE:       1,  DISAGREE:    1,
          TAG:         3,  RECOMMEND:   3,
          ANNOTATION:  5,  REPLY:       5,
          ARCHIVE:     7,
          ARRANGE:    10,  CORRECT:    10,
          CLASSIFY:   20,  MERGE:      30,  SUMMARY:     50,
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
