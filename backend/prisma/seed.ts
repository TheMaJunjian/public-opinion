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
      description: '初始默认规则 — 线性权重、最小押注 1、无单注上限',
      parameters: {
        minStake: 1,
        maxSingleStake: null,       // 无单注保护上限
        weightFunction: 'linear',   // 线性权重
        concurrentRoundLimit: 1,    // 同一消息最多 1 个进行中轮次
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
