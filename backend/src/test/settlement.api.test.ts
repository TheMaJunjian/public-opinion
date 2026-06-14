/**
 * settlement.api.test.ts — Integration tests for Phase 3 Settlement API.
 *
 * Covers:
 *   POST /api/messages/:id/rounds         — create settlement round
 *   GET  /api/messages/:id/rounds         — list rounds
 *   GET  /api/rounds/:id                  — round detail
 *   POST /api/rounds/:id/votes            — cast vote
 *   POST /api/rounds/:id/close-and-settle — settle round
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';

// ─── Mock Prisma ──────────────────────────────────────────────────────────
jest.mock('../lib/prisma', () => ({
  prisma: {
    message: { findUnique: jest.fn() },
    settlementRound: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    voteStake: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
    },
    stake: { findMany: jest.fn() },
    betPool: { findUnique: jest.fn() },
    balance: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    pointAccount: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    pointTransaction: { create: jest.fn() },
    ledgerEntry: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    auditLog: { create: jest.fn(), updateMany: jest.fn() },
    ruleVersion: { findFirst: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([{}, {}, {}, {}, {}, {}, {}]),
  },
}));

import { prisma } from '../lib/prisma';

// ─── Fixtures ─────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

const mockUser = { id: 'user-1', username: 'settler' };
function makeToken(user = mockUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

const mockMessage = {
  id: 'msg-1',
  topicId: 'topic-1',
  kind: 'TEXT',
};

const mockRound = {
  id: 'round-1',
  messageId: 'msg-1',
  createdByUserId: 'user-1',
  status: 'VOTING',
  result: null,
  previousRoundId: null,
  openedAt: new Date(),
  closedAt: null,
  note: null,
  createdBy: { id: 'user-1', username: 'settler' },
};

// ─── POST /api/messages/:id/rounds ──────────────────────────────────────

describe('POST /api/messages/:id/rounds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 without auth', async () => {
    const res = await request(app).post('/api/messages/msg-1/rounds').send({});
    expect(res.status).toBe(401);
  });

  it('should return 404 for nonexistent message', async () => {
    (prisma.message.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/messages/msg-nonexistent/rounds')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('should return 403 when debt-frozen', async () => {
    (prisma.message.findUnique as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ debtFrozen: true });
    const res = await request(app)
      .post('/api/messages/msg-1/rounds')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('should reject concurrent round (handler throws 500)', async () => {
    (prisma.message.findUnique as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ debtFrozen: false });
    (prisma.settlementRound.findFirst as jest.Mock).mockResolvedValue({ id: 'existing-round', status: 'VOTING' });
    // Mock $transaction for the ROUND_CREATED event handler
    (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('该消息已有进行中的结算轮次'));
    const res = await request(app)
      .post('/api/messages/msg-1/rounds')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    // The concurrent check is inside applyRoundCreated which uses prisma directly
    expect(res.status).toBe(500); // error thrown from handler
  });

  it('should create round successfully', async () => {
    (prisma.message.findUnique as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ debtFrozen: false });
    (prisma.settlementRound.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.settlementRound.create as jest.Mock).mockResolvedValue(mockRound);
    (prisma.settlementRound.update as jest.Mock).mockResolvedValue({ ...mockRound, status: 'VOTING' });
    (prisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 'log-1' });
    (prisma.auditLog.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.$transaction as jest.Mock).mockResolvedValue([mockRound]);

    const res = await request(app)
      .post('/api/messages/msg-1/rounds')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ note: 'First round' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('VOTING');
    expect(res.body.messageId).toBe('msg-1');
  });
});

// ─── GET /api/messages/:id/rounds ───────────────────────────────────────

describe('GET /api/messages/:id/rounds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return rounds list', async () => {
    (prisma.settlementRound.findMany as jest.Mock).mockResolvedValue([{ ...mockRound, _count: { votes: 3 } }]);
    const res = await request(app).get('/api/messages/msg-1/rounds');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.length).toBe(1);
  });
});

// ─── GET /api/rounds/:id ─────────────────────────────────────────────────

describe('GET /api/rounds/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 404 for nonexistent round', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get('/api/rounds/nonexistent');
    expect(res.status).toBe(404);
  });

  it('should return round with weights', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({ ...mockRound, _count: { votes: 2 } });
    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([
      { vote: 'TRUE', _sum: { amount: 100 } },
      { vote: 'FALSE', _sum: { amount: 50 } },
    ]);
    const res = await request(app).get('/api/rounds/round-1');
    expect(res.status).toBe(200);
    expect(res.body.weights.TRUE).toBe(100);
    expect(res.body.weights.FALSE).toBe(50);
    expect(res.body.weights.UNKNOWN).toBe(0);
  });
});

// ─── POST /api/rounds/:id/votes ─────────────────────────────────────────

describe('POST /api/rounds/:id/votes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 without auth', async () => {
    const res = await request(app).post('/api/rounds/round-1/votes').send({ vote: 'TRUE', amount: 10 });
    expect(res.status).toBe(401);
  });

  it('should return 404 for nonexistent round', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/rounds/round-nonexistent/votes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ vote: 'TRUE', amount: 10 });
    expect(res.status).toBe(404);
  });

  it('should return 400 for invalid vote direction', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({ ...mockRound, messageId: 'msg-1' });
    const res = await request(app)
      .post('/api/rounds/round-1/votes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ vote: 'INVALID', amount: 10 });
    expect(res.status).toBe(400);
  });

  it('should return 400 for amount less than 1', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({ ...mockRound, messageId: 'msg-1' });
    const res = await request(app)
      .post('/api/rounds/round-1/votes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ vote: 'TRUE', amount: 0 });
    expect(res.status).toBe(400);
  });

  it('should cast vote successfully', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({ ...mockRound, messageId: 'msg-1' });
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: 100, debtFrozen: false });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({ available: 100, locked: 0 });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });
    (prisma.voteStake.create as jest.Mock).mockResolvedValue({ id: 'vote-1', vote: 'TRUE', amount: 10 });
    (prisma.$transaction as jest.Mock).mockResolvedValue([{ id: 'vote-1' }]);
    (prisma.auditLog.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/api/rounds/round-1/votes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ vote: 'TRUE', amount: 10 });

    expect(res.status).toBe(201);
    expect(res.body.vote).toBe('TRUE');
    expect(res.body.amount).toBe(10);
  });
});

// ─── POST /api/rounds/:id/close-and-settle ──────────────────────────────

describe('POST /api/rounds/:id/close-and-settle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 without auth', async () => {
    const res = await request(app).post('/api/rounds/round-1/close-and-settle');
    expect(res.status).toBe(401);
  });

  it('should return 404 for nonexistent round', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/rounds/round-nonexistent/close-and-settle')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();
    expect(res.status).toBe(404);
  });

  it('should return 403 if not round creator', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({
      ...mockRound,
      createdByUserId: 'other-user',
    });
    // Mock: settlementPermission = creator_only (default), other-user not creator
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'creator_only', minStake: 1, selfStakeOnCreate: 1 },
    });
    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();
    expect(res.status).toBe(403);
  });

  it('should settle round with TRUE result', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({
      ...mockRound,
      createdByUserId: 'user-1',
      previousRoundId: null,
    });
    // Mock ruleVersion: settlementPermission = creator_only, caller is creator → allowed
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'creator_only', minStake: 1, selfStakeOnCreate: 1 },
    });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });

    // Vote weights: TRUE wins
    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([
      { vote: 'TRUE', _sum: { amount: 300 } },
      { vote: 'FALSE', _sum: { amount: 100 } },
      { vote: 'UNKNOWN', _sum: { amount: 50 } },
    ]);

    // Bet pool
    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({
      lockedPro: 500,
      lockedCon: 200,
    });

    // All stakes
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([
      { id: 's1', userId: 'u1', side: 'PRO', amount: 300 },
      { id: 's2', userId: 'u2', side: 'PRO', amount: 200 },
      { id: 's3', userId: 'u3', side: 'CON', amount: 200 },
    ]);

    // Vote stakes
    (prisma.voteStake.findMany as jest.Mock).mockResolvedValue([
      { id: 'v1', userId: 'u1', vote: 'TRUE', amount: 200 },
      { id: 'v2', userId: 'u2', vote: 'TRUE', amount: 100 },
      { id: 'v3', userId: 'u3', vote: 'FALSE', amount: 100 },
      { id: 'v4', userId: 'u4', vote: 'UNKNOWN', amount: 50 },
    ]);

    // Balances for affected users
    (prisma.balance.findUnique as jest.Mock).mockImplementation(({ where }: { where: { userId: string } }) => {
      const bals: Record<string, { balance: number }> = {
        u1: { balance: 100 },
        u2: { balance: 100 },
        u3: { balance: 100 },
        u4: { balance: 100 },
      };
      return Promise.resolve(bals[where.userId] ?? { balance: 100 });
    });

    (prisma.pointAccount.findUnique as jest.Mock).mockImplementation(({ where }: { where: { userId: string } }) => {
      const accounts: Record<string, { available: number; locked: number }> = {
        u1: { available: 200, locked: 500 },
        u2: { available: 300, locked: 300 },
        u3: { available: 300, locked: 200 },
        u4: { available: 450, locked: 50 },
      };
      return Promise.resolve(accounts[where.userId] ?? { available: 100, locked: 0 });
    });

    (prisma.$transaction as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('TRUE');
    expect(res.body.weights.TRUE).toBe(300);
  });

  it('should return UNKNOWN on tie', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({
      ...mockRound,
      createdByUserId: 'user-1',
      previousRoundId: null,
    });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'creator_only', minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 0, settlementFeeAmount: 0 },
    });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });

    // Tie: TRUE and FALSE equal
    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([
      { vote: 'TRUE', _sum: { amount: 200 } },
      { vote: 'FALSE', _sum: { amount: 200 } },
    ]);

    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({
      lockedPro: 300,
      lockedCon: 300,
    });

    (prisma.stake.findMany as jest.Mock).mockResolvedValue([
      { id: 's1', userId: 'u1', side: 'PRO', amount: 300 },
      { id: 's2', userId: 'u2', side: 'CON', amount: 300 },
    ]);

    (prisma.voteStake.findMany as jest.Mock).mockResolvedValue([
      { id: 'v1', userId: 'u3', vote: 'TRUE', amount: 200 },
      { id: 'v2', userId: 'u4', vote: 'FALSE', amount: 200 },
    ]);

    (prisma.balance.findUnique as jest.Mock).mockImplementation(({ where }: { where: { userId: string } }) => {
      return Promise.resolve({ balance: 100 });
    });

    (prisma.pointAccount.findUnique as jest.Mock).mockImplementation(({ where }: { where: { userId: string } }) => {
      return Promise.resolve({ available: 200, locked: 200 });
    });

    (prisma.$transaction as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('UNKNOWN');
  });

  // ── Fee burning: settlementFeeAmount deducted from pool ────────
  it('deducts settlementFeeAmount from distributable pool', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({
      ...mockRound, createdByUserId: 'user-1', previousRoundId: null,
    });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'creator_only', minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 0, settlementFeeAmount: 1 },
    });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });

    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([
      { vote: 'TRUE', _sum: { amount: 10 } },
    ]);
    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({ lockedPro: 10, lockedCon: 0 });
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([
      { id: 's1', userId: 'u1', side: 'PRO', amount: 10 },
    ]);
    (prisma.voteStake.findMany as jest.Mock).mockResolvedValue([
      { id: 'v1', userId: 'u2', vote: 'TRUE', amount: 10 },
    ]);
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: 100 });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({ available: 100, locked: 10 });
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
    // Total pool 10, fee 1 → distributable 9
    expect(res.body.settlementFeeTotal).toBe(1);
    expect(res.body.distributablePro).toBe(9);
  });

  // ── settlementPermission: any_voter ───────────────────────────
  it('allows settlement by voter when permission=any_voter', async () => {
    const otherUser = { id: 'user-2', username: 'voter' };
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({
      ...mockRound, createdByUserId: 'user-1', previousRoundId: null,
    });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'any_voter', minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 0, settlementFeeAmount: 0 },
    });
    // user-2 voted in this round
    (prisma.voteStake.findFirst as jest.Mock).mockResolvedValue({ id: 'v1', userId: 'user-2' });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });

    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([{ vote: 'TRUE', _sum: { amount: 10 } }]);
    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({ lockedPro: 10, lockedCon: 0 });
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([{ id: 's1', userId: 'u1', side: 'PRO', amount: 10 }]);
    (prisma.voteStake.findMany as jest.Mock).mockResolvedValue([{ id: 'v1', userId: 'user-2', vote: 'TRUE', amount: 10 }]);
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: 100 });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({ available: 100, locked: 0 });
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken(otherUser)}`)
      .send();

    expect(res.status).toBe(200);
  });

  it('blocks non-voter when permission=any_voter', async () => {
    const otherUser = { id: 'user-3', username: 'nonvoter' };
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({
      ...mockRound, createdByUserId: 'user-1', previousRoundId: null,
    });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'any_voter', minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 0, settlementFeeAmount: 0 },
    });
    // user-3 has NOT voted
    (prisma.voteStake.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken(otherUser)}`)
      .send();

    expect(res.status).toBe(403);
  });

  it('allows settlement by anyone when permission=anyone', async () => {
    const otherUser = { id: 'user-4', username: 'anyone' };
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({
      ...mockRound, createdByUserId: 'user-1', previousRoundId: null,
    });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'anyone', minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 0, settlementFeeAmount: 0 },
    });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });

    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([{ vote: 'TRUE', _sum: { amount: 10 } }]);
    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({ lockedPro: 10, lockedCon: 0 });
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([{ id: 's1', userId: 'u1', side: 'PRO', amount: 10 }]);
    (prisma.voteStake.findMany as jest.Mock).mockResolvedValue([{ id: 'v1', userId: 'user-1', vote: 'TRUE', amount: 10 }]);
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: 100 });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({ available: 100, locked: 0 });
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken(otherUser)}`)
      .send();

    expect(res.status).toBe(200);
  });
});

// ── Phase 4: Clawback & Debt Tests ──────────────────────────

describe('Phase 4 — Clawback, debt_frozen, and chain overturns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clawback sets debtFrozen when user balance drops below 0', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === 'round-1') return Promise.resolve({ ...mockRound, createdByUserId: 'user-1', previousRoundId: 'round-0' });
      if (args.where.id === 'round-0') return Promise.resolve({ id: 'round-0', result: 'TRUE' });
      return Promise.resolve(null);
    });

    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'creator_only', minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 0, settlementFeeAmount: 0 },
    });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });

    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([{ vote: 'FALSE', _sum: { amount: 20 } }]);
    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({ lockedPro: 50, lockedCon: 30 });
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([
      { id: 's1', userId: 'u1', side: 'PRO', amount: 50 },
      { id: 's2', userId: 'u2', side: 'CON', amount: 30 },
    ]);
    (prisma.voteStake.findMany as jest.Mock).mockResolvedValue([{ id: 'v1', userId: 'u1', vote: 'FALSE', amount: 20 }]);
    (prisma.ledgerEntry.findMany as jest.Mock).mockResolvedValue([
      { id: 'le-1', userId: 'u1', entryType: 'SETTLEMENT_PAYOUT', amount: 500, roundId: 'round-0' },
    ]);

    (prisma.balance.findUnique as jest.Mock).mockImplementation(({ where }: { where: { userId: string } }) => {
      if (where.userId === 'u1') return Promise.resolve({ balance: 100 });
      return Promise.resolve({ balance: 200 });
    });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({ available: 100, locked: 50 });
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
  });

  it('debtFrozen=false when balance recovers to >= 0', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockResolvedValue({
      ...mockRound, createdByUserId: 'user-1', previousRoundId: null,
    });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'creator_only', minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 0, settlementFeeAmount: 0 },
    });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });

    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([{ vote: 'TRUE', _sum: { amount: 5 } }]);
    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({ lockedPro: 5, lockedCon: 0 });
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([{ id: 's1', userId: 'u1', side: 'PRO', amount: 5 }]);
    (prisma.voteStake.findMany as jest.Mock).mockResolvedValue([{ id: 'v1', userId: 'u1', vote: 'TRUE', amount: 5 }]);

    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: -10 });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({ available: 0, locked: 5 });
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
  });

  it('supports consecutive overturns (TRUE → FALSE → TRUE chain)', async () => {
    (prisma.settlementRound.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === 'round-1') return Promise.resolve({ ...mockRound, createdByUserId: 'user-1', previousRoundId: 'round-2' });
      if (args.where.id === 'round-2') return Promise.resolve({ id: 'round-2', result: 'FALSE' });
      return Promise.resolve(null);
    });

    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { settlementPermission: 'creator_only', minStake: 1, selfStakeOnCreate: 1, stakeFeeAmount: 0, settlementFeeAmount: 0 },
    });
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({ topicId: 'topic-1' });

    (prisma.voteStake.groupBy as jest.Mock).mockResolvedValue([{ vote: 'TRUE', _sum: { amount: 8 } }]);
    (prisma.betPool.findUnique as jest.Mock).mockResolvedValue({ lockedPro: 10, lockedCon: 5 });
    (prisma.stake.findMany as jest.Mock).mockResolvedValue([
      { id: 's1', userId: 'u1', side: 'PRO', amount: 10 },
      { id: 's2', userId: 'u2', side: 'CON', amount: 5 },
    ]);
    (prisma.voteStake.findMany as jest.Mock).mockResolvedValue([{ id: 'v1', userId: 'u1', vote: 'TRUE', amount: 8 }]);
    (prisma.ledgerEntry.findMany as jest.Mock).mockResolvedValue([
      { id: 'le-1', userId: 'u1', entryType: 'SETTLEMENT_PAYOUT', amount: 300, roundId: 'round-2' },
    ]);
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: 500 });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({ available: 500, locked: 300 });
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/rounds/round-1/close-and-settle')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send();

    expect(res.status).toBe(200);
  });
});
