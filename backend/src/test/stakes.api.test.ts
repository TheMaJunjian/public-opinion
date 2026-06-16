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
    betPool: {
      findUnique: jest.fn(),
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
    pointTransaction: { create: jest.fn() },
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

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/messages/msg-1/stakes')
      .send({ side: 'PRO', amount: 5 });
    expect(res.status).toBe(401);
  });

  it('places a PRO stake', async () => {
    const res = await request(app)
      .post('/api/messages/msg-1/stakes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ side: 'PRO', amount: 5 });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('押注成功');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('rejects invalid side', async () => {
    const res = await request(app)
      .post('/api/messages/msg-1/stakes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ side: 'NEUTRAL', amount: 5 });

    expect(res.status).toBe(400);
  });

  it('rejects amount below minimum', async () => {
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { minStake: 10 },
    });

    const res = await request(app)
      .post('/api/messages/msg-1/stakes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ side: 'PRO', amount: 5 });

    expect(res.status).toBe(400);
  });

  it('rejects non-existent message', async () => {
    (prisma.message.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/messages/msg-999/stakes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ side: 'PRO', amount: 5 });

    expect(res.status).toBe(404);
  });

  it('rejects stake when debt-frozen (Phase 4)', async () => {
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      balance: -50,
      debtFrozen: true,
    });

    const res = await request(app)
      .post('/api/messages/msg-1/stakes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ side: 'PRO', amount: 5 });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('服务器内部错误');
  });
});

// ─── GET /api/messages/:id/stakes ─────────────────────────────────────────

describe('GET /api/messages/:id/stakes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({
      lockedPro: 10,
      lockedCon: 5,
    });
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.stake.aggregate as jest.Mock)
      .mockResolvedValueOnce({ _sum: { amount: 20 } })
      .mockResolvedValueOnce({ _sum: { amount: 15 } });
    (prisma.voteStake.aggregate as jest.Mock)
      .mockResolvedValueOnce({ _sum: { amount: 0 } })
      .mockResolvedValueOnce({ _sum: { amount: 0 } });
  });

  it('returns stake stats without auth', async () => {
    const res = await request(app).get('/api/messages/msg-1/stakes');

    expect(res.status).toBe(200);
    expect(res.body.pool).toEqual({ lockedPro: 10, lockedCon: 5 });
    expect(res.body.counts).toEqual({ pro: 20, con: 15 });
  });
});
