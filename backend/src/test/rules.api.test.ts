/**
 * rules.api.test.ts — Integration tests for /api/rules endpoint (Phase 1).
 *
 * Covers:
 *   GET /api/rules/current — query currently active rule version
 */

import request from 'supertest';
import app from '../app';

// ─── Mock Prisma ──────────────────────────────────────────────────────────
jest.mock('../lib/prisma', () => ({
  prisma: {
    ruleVersion: {
      findFirst: jest.fn(),
    },
  },
}));

import { prisma } from '../lib/prisma';

// ─── GET /api/rules/current ───────────────────────────────────────────────

describe('GET /api/rules/current', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the active rule version', async () => {
    const mockRule = {
      id: 'rule-v1',
      version: 1,
      status: 'ACTIVE',
      description: '初始默认规则 — 线性权重、最小押注 1、无单注上限、创建消息自押 1 点、仅发起者可结算、每次押注/投票燃烧 1 点、结算燃烧 1 点',
      parameters: {
        minStake: 1,
        maxSingleStake: null,
        weightFunction: 'linear',
        concurrentRoundLimit: 1,
        selfStakeOnCreate: 1,
        settlementPermission: 'creator_only',
        stakeFeeAmount: 1,
        settlementFeeAmount: 1,
      },
      createdAt: new Date().toISOString(),
    };

    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue(mockRule);

    const res = await request(app).get('/api/rules/current');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version', 1);
    expect(res.body).toHaveProperty('status', 'ACTIVE');
    expect(res.body.parameters).toHaveProperty('minStake', 1);
    expect(res.body.parameters).toHaveProperty('weightFunction', 'linear');
  });

  it('returns 404 when no active rule exists', async () => {
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get('/api/rules/current');

    expect(res.status).toBe(404);
  });

  it('does not require authentication', async () => {
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      id: 'rule-v1',
      version: 1,
      status: 'ACTIVE',
      description: null,
      parameters: {},
      createdAt: new Date().toISOString(),
    });

    const res = await request(app).get('/api/rules/current');

    // No auth header sent — should still succeed
    expect(res.status).toBe(200);
  });
});
