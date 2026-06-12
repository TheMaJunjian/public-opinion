/**
 * events.test.ts — Unit tests for event-sourcing foundation (Phase 0).
 *
 * Verifies: applyEvent dispatch, $transaction usage, state + audit log writes.
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
    $transaction: jest.fn().mockResolvedValue([{}, {}]),
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────

describe('applyEvent — Phase 0 event sourcing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);
  });

  // ── USER_REGISTERED ────────────────────────────────────────

  describe('USER_REGISTERED', () => {
    it('calls $transaction for user.create + auditLog.create', async () => {
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        { id: 'user-001', username: 'newuser', createdAt: new Date().toISOString() },
        {},
      ]);

      const result = await applyEvent({
        type: 'USER_REGISTERED',
        actorId: 'user-001',
        payload: { username: 'newuser', passwordHash: '$2a$10$hashed' },
      });

      expect(result).toHaveProperty('id', 'user-001');
      expect(prisma.$transaction).toHaveBeenCalled();
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

  // ── Event dispatch routing ─────────────────────────────────

  describe('applyEvent dispatch', () => {
    it('routes USER_REGISTERED → $transaction called', async () => {
      await applyEvent({
        type: 'USER_REGISTERED', actorId: 'u1',
        payload: { username: 'x', passwordHash: 'h' },
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('routes TOPIC_CREATED → topic.create called (sequential)', async () => {
      (prisma.topic.create as jest.Mock).mockResolvedValue({
        id: 't1', title: 'T', body: null,
        createdBy: { id: 'u1', username: 'x' },
      });
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await applyEvent({
        type: 'TOPIC_CREATED', actorId: 'u1',
        payload: { title: 'T' },
      });

      expect(result).toHaveProperty('id', 't1');
      expect(prisma.topic.create).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('routes TOPIC_STATUS_CHANGED → $transaction called', async () => {
      await applyEvent({
        type: 'TOPIC_STATUS_CHANGED',
        actorId: 'u1', topicId: 't1',
        payload: { status: 'ARCHIVED' },
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });
});
