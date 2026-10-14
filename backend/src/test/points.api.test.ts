/**
 * points.api.test.ts — Integration tests for /api/points endpoints (Phase 1).
 *
 * Covers:
 *   GET /api/points/balance      — query points balance
 *   GET /api/points/transactions  — query points transaction history
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';

// ─── Mock Prisma ──────────────────────────────────────────────────────────
jest.mock('../lib/prisma', () => ({
  prisma: {
    pointAccount: {
      findUnique: jest.fn(),
    },
    balance: {
      findUnique: jest.fn(),
    },
    pointTransaction: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    ledgerEntry: {
      aggregate: jest.fn(),
      findMany: jest.fn(),
    },
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

// ─── GET /api/points/balance ──────────────────────────────────────────────

describe('GET /api/points/balance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.ledgerEntry.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: 0 } });
    (prisma.ledgerEntry.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/points/balance');
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid token', async () => {
    const res = await request(app)
      .get('/api/points/balance')
      .set('Authorization', 'Bearer invalid-token');
    expect(res.status).toBe(401);
  });

  it('returns balance for authenticated user', async () => {
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({
      available: 100,
      locked: 0,
    });
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
      balance: 100,
      debtFrozen: false,
    });

    const res = await request(app)
      .get('/api/points/balance')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('points');
    expect(res.body.points).toEqual({ available: 100, locked: 0 });
    expect(res.body.balance).toEqual({ amount: 100, debtFrozen: false });
    expect(res.body).toHaveProperty('breakdown');
  });

  it('returns debtFrozen=true when user has negative balance', async () => {
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({
      available: 0,
      locked: 50,
    });
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
      balance: -30,
      debtFrozen: true,
    });

    const res = await request(app)
      .get('/api/points/balance')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.balance.debtFrozen).toBe(true);
    expect(res.body.balance.amount).toBe(-30);
  });

  it('returns 404 when account not found', async () => {
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/points/balance')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/points/transactions ─────────────────────────────────────────

describe('GET /api/points/transactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/points/transactions');
    expect(res.status).toBe(401);
  });

  it('returns paginated transactions', async () => {
    const mockTx = [
      {
        id: 'pt-1',
        type: 'MINT',
        amount: 100,
        balanceAfter: 100,
        createdAt: new Date().toISOString(),
        data: { reason: 'REGISTRATION_BONUS' },
      },
    ];
    (prisma.pointTransaction.findMany as jest.Mock).mockResolvedValue(mockTx);
    (prisma.pointTransaction.count as jest.Mock).mockResolvedValue(1);

    const res = await request(app)
      .get('/api/points/transactions')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toHaveProperty('type', 'MINT');
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('respects pagination params', async () => {
    (prisma.pointTransaction.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.pointTransaction.count as jest.Mock).mockResolvedValue(10);

    const res = await request(app)
      .get('/api/points/transactions?page=2&limit=5')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 2, limit: 5, total: 10, totalPages: 2 });
  });

  it('clamps limit to 100 max', async () => {
    (prisma.pointTransaction.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.pointTransaction.count as jest.Mock).mockResolvedValue(0);

    const res = await request(app)
      .get('/api/points/transactions?limit=999')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });
});
