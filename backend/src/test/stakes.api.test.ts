/**
 * stakes.api.test.ts — Integration tests for /api/messages/:id/stakes (Phase 2).
 *
 * Covers:
 *   POST /api/messages/:id/stakes  — place stake (PRO/CON)
 *   GET  /api/messages/:id/stakes  — query stake stats
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';

// ─── Mock Prisma ──────────────────────────────────────────────────────────
jest.mock('../lib/prisma', () => ({
  prisma: {
    message: { findUnique: jest.fn() },
    stake: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    settlementRound: { findFirst: jest.fn() },
    betPool: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
    },
    balance: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    pointAccount: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    pointTransaction: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    ledgerEntry: { create: jest.fn() },
    auditLog: { create: jest.fn(), updateMany: jest.fn() },
    ruleVersion: { findFirst: jest.fn() },
    voteStake: { aggregate: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([{}, {}, {}, {}, {}, {}, {}]),
  },
}));

import { prisma } from '../lib/prisma';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

const mockUser = { id: 'user-1', username: 'tester' };
function makeToken(): string {
  return jwt.sign(mockUser, JWT_SECRET, { expiresIn: '1h' });
}

// ─── POST /api/messages/:id/stakes ────────────────────────────────────────

describe('POST /api/messages/:id/stakes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockResolvedValue([
      { id: 'stake-1', side: 'PRO', amount: 5 },
      {}, {}, {}, {}, {}, {},
    ]);
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({
      id: 'msg-1',
      topicId: 'topic-1',
      kind: 'TEXT',
    });
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      balance: 100,
      debtFrozen: false,
    });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      available: 100,
      locked: 0,
    });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 1 },
    });
  });

  it('POST has been removed (Phase 6 —押注仅通过消息创建)', async () => {
    const res = await request(app)
      .post('/api/messages/msg-1/stakes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ side: 'PRO', amount: 5 });
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/messages/:id/stakes ─────────────────────────────────────────

describe('GET /api/messages/:id/stakes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.stake.aggregate as jest.Mock)
      .mockResolvedValueOnce({ _sum: { amount: 20 } })  // PRO all
      .mockResolvedValueOnce({ _sum: { amount: 15 } })  // CON all
      .mockResolvedValueOnce({ _sum: { amount: 20 } })  // TRUTH PRO
      .mockResolvedValueOnce({ _sum: { amount: 15 } })  // TRUTH CON
      .mockResolvedValueOnce({ _sum: { amount: 0 } })   // VALUE PRO
      .mockResolvedValueOnce({ _sum: { amount: 0 } });  // VALUE CON
    (prisma.betPool.findMany as jest.Mock).mockResolvedValue([
      { settlementType: 'TRUTH', lockedPro: 10, lockedCon: 5 },
    ]);
  });

  it('returns stake stats without auth', async () => {
    const res = await request(app).get('/api/messages/msg-1/stakes');

    expect(res.status).toBe(200);
    expect(res.body.pool).toEqual({ lockedPro: 20, lockedCon: 15 });
    expect(res.body.counts).toEqual({ pro: 20, con: 15 });
    expect(res.body.countsByType).toEqual({
      TRUTH: { pro: 20, con: 15 },
      VALUE: { pro: 0, con: 0 },
    });
  });
});
