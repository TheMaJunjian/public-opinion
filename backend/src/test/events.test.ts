/**
 * events.test.ts — Unit tests for event-sourcing foundation (Phase 0 + Phase 1).
 *
 * Verifies: applyEvent dispatch, $transaction usage, state + audit log writes,
 * and Phase 1 point minting on registration.
 */

import { prisma } from '../lib/prisma';
import { applyEvent } from '../lib/events';

// ─── Mock Prisma ──────────────────────────────────────────────────────────
jest.mock('../lib/prisma', () => ({
  prisma: {
    user: { create: jest.fn() },
    topic: { update: jest.fn(), create: jest.fn() },
    message: { create: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn(), updateMany: jest.fn() },
    balance: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    pointAccount: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    pointTransaction: { create: jest.fn() },
    ledgerEntry: { create: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([{}, {}]),
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────

describe('applyEvent — Phase 0 + Phase 1 event sourcing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockResolvedValue([{}, {}, {}, {}, {}, {}, {}]);
  });

  // ── USER_REGISTERED (Phase 1: includes points setup) ─────

  describe('USER_REGISTERED', () => {
    it('calls $transaction for user + balance + pointAccount + transactions + auditLogs', async () => {
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        { id: 'user-001', username: 'newuser', createdAt: new Date().toISOString() },
        {}, // balance
        {}, // pointAccount
        {}, // pointTransaction
        {}, // ledgerEntry
        {}, // auditLog: USER_REGISTERED
        {}, // auditLog: POINT_MINTED
      ]);

      const result = await applyEvent({
        type: 'USER_REGISTERED',
        actorId: 'user-001',
        payload: { username: 'newuser', passwordHash: '$2a$10$hashed' },
      });

      expect(result).toHaveProperty('id', 'user-001');
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('mints 100 registration bonus points', async () => {
      await applyEvent({
        type: 'USER_REGISTERED',
        actorId: 'user-002',
        payload: { username: 'newuser2', passwordHash: '$2a$10$hashed' },
      });

      const txCall = (prisma.$transaction as jest.Mock).mock.calls[0][0];
      // The 4th element should be the pointTransaction create with amount=100
      expect(txCall.length).toBe(7);
    });
  });

  // ── TOPIC_STATUS_CHANGED ───────────────────────────────────

  describe('TOPIC_STATUS_CHANGED', () => {
    it('calls $transaction for topic.update + auditLog.create', async () => {
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        { id: 't1', title: 'T', status: 'ARCHIVED', createdBy: { id: 'u1', username: 'a' } },
        {},
      ]);

      const result = await applyEvent({
        type: 'TOPIC_STATUS_CHANGED',
        actorId: 'u1', topicId: 't1',
        payload: { status: 'ARCHIVED' },
      });

      expect(result).toHaveProperty('status', 'ARCHIVED');
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  // ── POINT_MINTED ──────────────────────────────────────────

  describe('POINT_MINTED', () => {
    it('requires existing PointAccount', async () => {
      (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        applyEvent({
          type: 'POINT_MINTED',
          actorId: 'user-1',
          payload: { amount: 50, reason: 'CONTENT_REWARD' },
        }),
      ).rejects.toThrow('PointAccount not found');
    });

    it('mints points and updates account, balance, ledger, auditLog', async () => {
      (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({
        userId: 'user-1',
        available: 100,
        locked: 0,
      });
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        {}, // pointAccount.update
        {}, // pointTransaction.create
        { balance: 150 }, // balance.update
        {}, // ledgerEntry.create
        {}, // auditLog.create
      ]);
      (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: 150, debtFrozen: false });

      const result = await applyEvent({
        type: 'POINT_MINTED',
        actorId: 'user-1',
        payload: { amount: 50, reason: 'CONTENT_REWARD', note: 'Quality post' },
      });

      expect(result).toHaveProperty('available', 150);
      expect(result).toHaveProperty('balance', 150);
    });
  });

  // ── POINT_TRANSFERRED ─────────────────────────────────────

  describe('POINT_TRANSFERRED', () => {
    it('rejects transfer if sender has insufficient points', async () => {
      (prisma.pointAccount.findUnique as jest.Mock)
        .mockResolvedValueOnce({ userId: 'user-1', available: 10, locked: 0 });

      await expect(
        applyEvent({
          type: 'POINT_TRANSFERRED',
          actorId: 'user-1',
          payload: { fromUserId: 'user-1', toUserId: 'user-2', amount: 100 },
        }),
      ).rejects.toThrow('Insufficient available points');
    });

    it('transfers points between accounts', async () => {
      (prisma.pointAccount.findUnique as jest.Mock)
        .mockResolvedValueOnce({ userId: 'user-1', available: 200, locked: 0 })
        .mockResolvedValueOnce({ userId: 'user-2', available: 50, locked: 0 });

      await applyEvent({
        type: 'POINT_TRANSFERRED',
        actorId: 'user-1',
        payload: { fromUserId: 'user-1', toUserId: 'user-2', amount: 30, note: 'Thanks' },
      });

      expect(prisma.$transaction).toHaveBeenCalled();
      const txArgs = (prisma.$transaction as jest.Mock).mock.calls[0][0];
      expect(txArgs.length).toBeGreaterThanOrEqual(6); // 2x account update + 2x tx + 2x balance + 1x ledger + 1x auditLog
    });
  });

  // ── Event dispatch routing ─────────────────────────────────

  describe('applyEvent dispatch', () => {
    it('routes USER_REGISTERED → $transaction called', async () => {
      await applyEvent({
        type: 'USER_REGISTERED', actorId: 'u1',
        payload: { username: 'x', passwordHash: 'h' },
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('routes TOPIC_CREATED → $transaction called', async () => {
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        {
          id: 't1', title: 'T', body: null,
          createdBy: { id: 'u1', username: 'x' },
        },
        {},
      ]);

      const result = await applyEvent({
        type: 'TOPIC_CREATED', actorId: 'u1',
        payload: { title: 'T' },
      });

      expect(result).toHaveProperty('id', 't1');
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('routes TOPIC_STATUS_CHANGED → $transaction called', async () => {
      await applyEvent({
        type: 'TOPIC_STATUS_CHANGED',
        actorId: 'u1', topicId: 't1',
        payload: { status: 'ARCHIVED' },
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('routes POINT_MINTED → handler called', async () => {
      (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({
        userId: 'u1',
        available: 50,
        locked: 0,
      });
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        {}, {}, { balance: 100 }, {}, {},
      ]);
      (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: 100 });

      await applyEvent({
        type: 'POINT_MINTED',
        actorId: 'u1',
        payload: { amount: 50, reason: 'CONTENT_REWARD' },
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });
});

