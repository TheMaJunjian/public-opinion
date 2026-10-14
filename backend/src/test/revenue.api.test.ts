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


