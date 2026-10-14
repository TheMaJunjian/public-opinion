/**
 * tags.api.test.ts — Integration tests for tag statistics API.
 *
 * Covers:
 *   GET /api/topics/:topicId/tag-counts — per-message tag counts
 */

import request from 'supertest';
import app from '../app';

// ─── Mock Prisma ──────────────────────────────────────────────────────────
jest.mock('../lib/prisma', () => ({
  prisma: {
    topic: { findUnique: jest.fn() },
    message: { findMany: jest.fn() },
  },
}));

import { prisma } from '../lib/prisma';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const mockTopic = { id: 'topic-1' };

function makeTagRel(overrides: {
  relationType: string;
  subType?: string | null;
  targetMessageId: string;
}) {
  return {
    id: `rel-${Math.random().toString(36).slice(2, 8)}`,
    relationType: overrides.relationType,
    relationPayload: overrides.subType ? { subType: overrides.subType } : null,
    targetRefs: [{ messageId: overrides.targetMessageId }],
  };
}

describe('GET /api/topics/:topicId/tag-counts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 for nonexistent topic', async () => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get('/api/topics/nonexistent/tag-counts');
    expect(res.status).toBe(404);
  });

  it('returns empty counts when no tags exist', async () => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app).get('/api/topics/topic-1/tag-counts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ topicId: 'topic-1', counts: {} });
  });

  it('returns per-message tag counts grouped by subType', async () => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([
      makeTagRel({ relationType: 'RECOMMEND', subType: 'SPAM', targetMessageId: 'msg-1' }),
      makeTagRel({ relationType: 'RECOMMEND', subType: 'SPAM', targetMessageId: 'msg-1' }),
      makeTagRel({ relationType: 'RECOMMEND', subType: 'SPAM', targetMessageId: 'msg-1' }),
      makeTagRel({ relationType: 'RECOMMEND', subType: 'OFFTOPIC', targetMessageId: 'msg-1' }),
      makeTagRel({ relationType: 'RECOMMEND', subType: 'IMPORTANT', targetMessageId: 'msg-1' }),
      makeTagRel({ relationType: 'ARCHIVE', subType: 'SPAM', targetMessageId: 'msg-1' }),
      makeTagRel({ relationType: 'RECOMMEND', subType: 'SPAM', targetMessageId: 'msg-2' }),
      makeTagRel({ relationType: 'RECOMMEND', subType: 'SPAM', targetMessageId: 'msg-2' }),
      makeTagRel({ relationType: 'TAG', subType: null, targetMessageId: 'msg-2' }),
    ]);

    const res = await request(app).get('/api/topics/topic-1/tag-counts');
    expect(res.status).toBe(200);

    const { counts } = res.body as { topicId: string; counts: Record<string, Record<string, number>> };

    // msg-1: 3 SPAM + 1 OFFTOPIC + 1 IMPORTANT (+ 1 ARCHIVE SPAM)
    expect(counts['msg-1']).toBeDefined();
    expect(counts['msg-1'].SPAM).toBe(4);    // 3 RECOMMEND SPAM + 1 ARCHIVE SPAM
    expect(counts['msg-1'].OFFTOPIC).toBe(1);
    expect(counts['msg-1'].IMPORTANT).toBe(1);
    expect(counts['msg-1'].recommend).toBe(5); // total RECOMMEND
    expect(counts['msg-1'].archive).toBe(1);   // total ARCHIVE

    // msg-2: 2 RECOMMEND SPAM + 1 TAG (no subType)
    expect(counts['msg-2']).toBeDefined();
    expect(counts['msg-2'].SPAM).toBe(2);
    expect(counts['msg-2'].recommend).toBe(2);
    expect(counts['msg-2'].tag).toBe(1);
  });

  it('skips superseded relations', async () => {
    // This test verifies the query filters out superseded relations.
    // The mock just returns empty — the real filter is in the Prisma query.
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/topics/topic-1/tag-counts');
    expect(res.status).toBe(200);
    // Verify the query filter includes supersededBy: null
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          supersededBy: null,
        }),
      }),
    );
  });
});
