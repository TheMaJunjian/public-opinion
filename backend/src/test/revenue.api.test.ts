/**
 * revenue.api.test.ts — Integration tests for revenue distribution API.
 *
 * Covers:
 *   GET  /api/revenue/pool          — query revenue pool
 *   GET  /api/revenue/distributions — list distribution records
 *   POST /api/revenue/distribute    — trigger distribution
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';

// ─── Mock Prisma ──────────────────────────────────────────────────────────
jest.mock('../lib/prisma', () => ({
  prisma: {
    revenuePool: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    revenueDistribution: { count: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    ruleVersion: { findFirst: jest.fn() },
    balance: { findMany: jest.fn(), update: jest.fn() },
    pointAccount: { update: jest.fn() },
    ledgerEntry: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  },
}));

import { prisma } from '../lib/prisma';

// ─── Fixtures ─────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

const mockUser = { id: 'user-1', username: 'admin' };
function makeToken(user = mockUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

const mockPool = {
  id: 'pool-1',
  totalReceived: 100,
  totalDistributed: 0,
  balance: 100,
};

// ─── GET /api/revenue/pool ────────────────────────────────────────────────

describe('GET /api/revenue/pool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns existing pool', async () => {
    (prisma.revenuePool.findFirst as jest.Mock).mockResolvedValue(mockPool);
    const res = await request(app).get('/api/revenue/pool');
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(100);
  });

  it('creates pool if none exists', async () => {
    (prisma.revenuePool.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.revenuePool.create as jest.Mock).mockResolvedValue({ ...mockPool, balance: 0 });
    const res = await request(app).get('/api/revenue/pool');
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/revenue/distribute ─────────────────────────────────────────

describe('POST /api/revenue/distribute', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/revenue/distribute').send();
    expect(res.status).toBe(401);
  });

  it('returns 400 when pool balance is zero', async () => {
    (prisma.revenuePool.findFirst as jest.Mock).mockResolvedValue({ ...mockPool, balance: 0 });
    const res = await request(app)
      .post('/api/revenue/distribute')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();
    expect(res.status).toBe(400);
  });

  it('returns 400 when no users have positive balance', async () => {
    (prisma.revenuePool.findFirst as jest.Mock).mockResolvedValue(mockPool);
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { revenueDistribution: { contributorShare: 0.5 } },
    });
    (prisma.balance.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app)
      .post('/api/revenue/distribute')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();
    expect(res.status).toBe(400);
  });

  it('distributes revenue proportionally to balance holders', async () => {
    (prisma.revenuePool.findFirst as jest.Mock).mockResolvedValue(mockPool);
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { revenueDistribution: { contributorShare: 0.5 } },
    });
    (prisma.balance.findMany as jest.Mock).mockResolvedValue([
      { userId: 'u1', balance: 600 },
      { userId: 'u2', balance: 400 },
    ]);
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);
    (prisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 'log-1' });

    const res = await request(app)
      .post('/api/revenue/distribute')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.contributorAmount).toBe(50); // 100 * 0.5
    expect(res.body.retainedAmount).toBe(50);
    expect(res.body.recipientCount).toBe(2);

    // Verify Balance updates: u1 gets 60% of 50 = 30, u2 gets 40% of 50 = 20
    const balanceUpdates = (prisma.balance.update as jest.Mock).mock.calls;
    expect(balanceUpdates.length).toBe(2);

    // Verify RevenueDistribution records were created
    expect(prisma.revenueDistribution.create as jest.Mock).toHaveBeenCalledTimes(2);

    // Verify pool was updated
    expect(prisma.revenuePool.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pool-1' },
        data: expect.objectContaining({
          balance: 50,  // retainedAmount
          totalDistributed: expect.objectContaining({ increment: 50 }),
        }),
      }),
    );
  });

  it('handles dust distribution to first user', async () => {
    (prisma.revenuePool.findFirst as jest.Mock).mockResolvedValue(mockPool);
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { revenueDistribution: { contributorShare: 0.5 } },
    });
    // 3 users: 50 / 3 = 16.67 each → 16*3=48, dust=2 goes to first user
    (prisma.balance.findMany as jest.Mock).mockResolvedValue([
      { userId: 'u1', balance: 100 },
      { userId: 'u2', balance: 100 },
      { userId: 'u3', balance: 100 },
    ]);
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);
    (prisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 'log-1' });

    const res = await request(app)
      .post('/api/revenue/distribute')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.contributorAmount).toBe(50);

    // Check dust was distributed: total of balance updates = 50
    const balanceUpdates = (prisma.balance.update as jest.Mock).mock.calls;
    const totalInc = balanceUpdates.reduce((sum: number, call: any[]) => {
      return sum + (call[0]?.data?.balance?.increment ?? 0);
    }, 0);
    expect(totalInc).toBe(50);
  });

  it('respects custom contributorShare from rules', async () => {
    (prisma.revenuePool.findFirst as jest.Mock).mockResolvedValue({ ...mockPool, balance: 200 });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { revenueDistribution: { contributorShare: 0.8 } },
    });
    (prisma.balance.findMany as jest.Mock).mockResolvedValue([
      { userId: 'u1', balance: 100 },
    ]);
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);
    (prisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 'log-1' });

    const res = await request(app)
      .post('/api/revenue/distribute')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.contributorAmount).toBe(160); // 200 * 0.8
    expect(res.body.retainedAmount).toBe(40);
  });
});
