/**
 * relations.api.test.ts — Integration tests for the /api/topics/:topicId/relations endpoint.
 *
 * Uses supertest to fire requests against the Express app.
 * Prisma client is mocked via jest.mock so no real database is needed.
 *
 * Covers:
 *   GET  /api/topics/:topicId/relations  — list relations
 *   POST /api/topics/:topicId/relations  — create relation (auth required)
 *
 * TargetRef constraint validation:
 *   - 'message' target
 *   - 'text-fragment' target
 *   - 'relation' target (targeting a relation message)
 *   - invalid payload rejection
 *
 * Relation messages are stored in the unified Message table with kind=RELATION.
 * The relations router queries/creates Message rows with kind=RELATION instead of
 * a separate Relation table, making relation messages first-class messages.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';

// ─── Mock Prisma ──────────────────────────────────────────────────────────
jest.mock('../lib/prisma', () => ({
  prisma: {
    topic: {
      findUnique: jest.fn(),
    },
    message: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    balance: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    ruleVersion: {
      findFirst: jest.fn(),
    },
    pointAccount: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    pointTransaction: { create: jest.fn() },
    stake: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    betPool: { findUnique: jest.fn(), upsert: jest.fn() },
    ledgerEntry: { create: jest.fn(), updateMany: jest.fn() },
    settlementRound: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([{}, {}]),
  },
}));

import { prisma } from '../lib/prisma';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

const mockUser = { id: 'user-1', username: 'tester' };
const mockTopic = { id: 'topic-1', status: 'OPEN', title: 'Test Topic' };

// A TEXT kind message (source / target)
const mockMessage = { id: 'msg-1', topicId: 'topic-1', kind: 'TEXT', content: 'Hello', createdBy: mockUser };
const mockMessage2 = { id: 'msg-2', topicId: 'topic-1', kind: 'TEXT', content: 'World', createdBy: mockUser };

// A RELATION kind message (for use as a target relation or as a source relation message)
const mockRelationMsg = {
  id: 'rel-1',
  topicId: 'topic-1',
  kind: 'RELATION',
  relationType: 'REPLY',
  relSourceId: 'msg-1',
  targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
  createdAt: new Date().toISOString(),
  createdBy: mockUser,
};

function makeToken(user = mockUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

// ─── GET /api/topics/:topicId/relations ───────────────────────────────────

describe('GET /api/topics/:topicId/relations', () => {
  beforeEach(() => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.count as jest.Mock).mockResolvedValue(1);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockRelationMsg]);
  });

  it('returns 200 with paginated relations', async () => {
    const res = await request(app).get('/api/topics/topic-1/relations');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('rel-1');
    expect(res.body.pagination.total).toBe(1);
  });

  it('returns 404 when topic does not exist', async () => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get('/api/topics/nonexistent/relations');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('分类不存在');
  });

  it('returns empty data array when no relations exist', async () => {
    (prisma.message.count as jest.Mock).mockResolvedValue(0);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app).get('/api/topics/topic-1/relations');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ─── POST /api/topics/:topicId/relations ──────────────────────────────────

describe('POST /api/topics/:topicId/relations — auth', () => {
  it('returns 401 when no auth token is provided', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .send({ relationType: 'REPLY', sourceMessageId: 'msg-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/topics/:topicId/relations — validation', () => {
  beforeEach(() => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    // Single-table source lookup: any message (TEXT or RELATION kind)
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(mockMessage);
    // Target TEXT message lookup
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockMessage2]);
    // create returns the new RELATION-kind message
    (prisma.message.create as jest.Mock).mockResolvedValue({
      ...mockRelationMsg,
      id: 'rel-new',
    });
    // Event sourcing: audit log write is now outside transaction
    (prisma.auditLog.create as jest.Mock).mockResolvedValue({});
    const mockCreatedMsg = {
      id: 'rel-new',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'REPLY',
      relSourceId: 'msg-1',
      targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      relationPayload: null,
      createdAt: new Date().toISOString(),
      createdBy: mockUser,
    };
    (prisma.$transaction as jest.Mock).mockResolvedValue([mockCreatedMsg]);
  });

  it('returns 400 for an invalid relationType', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'INVALID', sourceMessageId: 'msg-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty targetRefs', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'REPLY', sourceMessageId: 'msg-1', targetRefs: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when required sourceMessageId is missing', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'ANNOTATION', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(400);
  });

  it('returns 404 when topic does not exist', async () => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'REPLY', sourceMessageId: 'msg-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(404);
  });

  it('returns 403 when topic is archived', async () => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue({ ...mockTopic, status: 'ARCHIVED' });
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'REPLY', sourceMessageId: 'msg-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(403);
  });

  it('returns 404 when sourceMessageId does not exist in this topic', async () => {
    // Unified table: single findFirst returns null → source not found
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'REPLY', sourceMessageId: 'nonexistent', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('来源消息');
  });

  it('allows CLASSIFY without sourceMessageId', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('allows CLASSIFY with empty targetRefs', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '空分类' }, targetRefs: [] });
    expect(res.status).toBe(201);
  });

  it('allows CLASSIFY with sourceMessageId (join relations use it)', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, sourceMessageId: 'msg-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('allows JOIN with sourceMessageId and applies normal staking rules', async () => {
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({ balance: 100, debtFrozen: false });
    (prisma.pointAccount.findUnique as jest.Mock).mockResolvedValue({ available: 100, locked: 0 });
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({ parameters: { relationTypeMinStake: { JOIN: 3 }, selfStakeOnCreate: 1 } });
    (prisma.message.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 'rel-container', topicId: 'topic-1', kind: 'RELATION', relationType: 'CLASSIFY',
    });
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'JOIN', sourceMessageId: 'rel-container', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('rejects JOIN targeting a decoration relation message', async () => {
    (prisma.message.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 'rel-container', topicId: 'topic-1', kind: 'RELATION', relationType: 'CLASSIFY',
    });
    (prisma.message.findMany as jest.Mock).mockResolvedValueOnce([{
      id: 'rel-decoration', topicId: 'topic-1', kind: 'RELATION', relationType: 'CORRECT',
    }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'JOIN', sourceMessageId: 'rel-container', targetRefs: [{ kind: 'message', messageId: 'rel-decoration' }] });
    expect(res.status).toBe(400);
  });

  it('allows CLASSIFY with relation message targets', async () => {
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockRelationMsg]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, targetRefs: [{ kind: 'relation', relationId: 'rel-1' }] });
    expect(res.status).toBe(201);
  });

  it('allows MERGE without sourceMessageId', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('allows ARRANGE without sourceMessageId', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'ARRANGE', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('allows ARRANGE with sourceMessageId (join relations use it)', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'ARRANGE', sourceMessageId: 'msg-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('allows MERGE with sourceMessageId (join relations use it)', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', sourceMessageId: 'msg-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('allows MERGE with relation targets', async () => {
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockRelationMsg]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', targetRefs: [{ kind: 'relation', relationId: 'rel-1' }] });
    expect(res.status).toBe(201);
  });

  it('rejects MERGE when selected text targets have non-reference cross links to already-classified messages', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage2])
      .mockResolvedValueOnce([{
        id: 'rel-classify-existing',
        relationType: 'CLASSIFY',
        relSourceId: null,
        targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
      }, {
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('非引用关联');
  });

  it('rejects MERGE when selected classify targets contain non-reference cross links to already-classified messages', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([{
        id: 'rel-classify',
        relationType: 'CLASSIFY',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{
        id: 'rel-classify-existing',
        relationType: 'CLASSIFY',
        relSourceId: null,
        targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
      }, {
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', targetRefs: [{ kind: 'relation', relationId: 'rel-classify' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('非引用关联');
  });

  it('allows MERGE when text targets have non-reference cross links to unclassified messages', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage2])
      .mockResolvedValueOnce([{
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('allows MERGE with classify relation targets when links stay within the selected topic', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([{
        id: 'rel-classify',
        relationType: 'CLASSIFY',
        targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', targetRefs: [{ kind: 'relation', relationId: 'rel-classify' }] });
    expect(res.status).toBe(201);
  });

  it('rejects CLASSIFY when selected text targets have non-reference cross links to already-classified messages', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage2])
      .mockResolvedValueOnce([{
        id: 'rel-classify-existing',
        relationType: 'CLASSIFY',
        relSourceId: null,
        targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
      }, {
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('非引用关联');
  });

  it('allows CLASSIFY when text targets have non-reference cross links to unclassified messages', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage2])
      .mockResolvedValueOnce([{
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(201);
  });

  it('allows CLASSIFY when non-reference links stay within selected targets', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage, mockMessage2])
      .mockResolvedValueOnce([{
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'CLASSIFY',
        payload: { title: '测试分类' },
        targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'message', messageId: 'msg-2' }],
      });
    expect(res.status).toBe(201);
  });

  it('allows CLASSIFY with MERGE relation message target', async () => {
    const mockMergeRel = {
      id: 'rel-merge',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'MERGE',
      relSourceId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'message', messageId: 'msg-2' }],
    };
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMergeRel])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }] });
    expect(res.status).toBe(201);
  });

  it('allows CLASSIFY with ARRANGE relation target', async () => {
    const mockARRANGERel = {
      id: 'rel-supp',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'ARRANGE',
      relSourceId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'message', messageId: 'msg-2' }],
    };
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockARRANGERel])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }] });
    expect(res.status).toBe(201);
  });

  it('rejects CLASSIFY when MERGE relation target text messages have cross links to already-classified messages', async () => {
    const mockMergeRel = {
      id: 'rel-merge',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'MERGE',
      relSourceId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
    };
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMergeRel])
      .mockResolvedValueOnce([{
        id: 'rel-classify-existing',
        relationType: 'CLASSIFY',
        relSourceId: null,
        targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
      }, {
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('非引用关联');
  });

  it('allows CLASSIFY when MERGE relation target text messages cross-link only to unclassified messages', async () => {
    const mockMergeRel = {
      id: 'rel-merge',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'MERGE',
      relSourceId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
    };
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMergeRel])
      .mockResolvedValueOnce([{
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'CLASSIFY', payload: { title: '测试分类' }, targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }] });
    expect(res.status).toBe(201);
  });

  it('rejects MERGE when ARRANGE relation target text messages have cross links to already-classified messages', async () => {
    const mockARRANGERel = {
      id: 'rel-supp',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'ARRANGE',
      relSourceId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
    };
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockARRANGERel])
      .mockResolvedValueOnce([{
        id: 'rel-classify-existing',
        relationType: 'CLASSIFY',
        relSourceId: null,
        targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
      }, {
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('非引用关联');
  });

  it('allows MERGE when ARRANGE relation target text messages cross-link only to unclassified messages', async () => {
    const mockARRANGERel = {
      id: 'rel-supp',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'ARRANGE',
      relSourceId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
    };
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockARRANGERel])
      .mockResolvedValueOnce([{
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'MERGE', targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }] });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/topics/:topicId/relations — successful creation', () => {
  beforeEach(() => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockMessage2]);
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { minStake: 1, selfStakeOnCreate: 1 },
    });
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
      userId: 'user-1', balance: 100, debtFrozen: false,
    });
    (prisma.message.create as jest.Mock).mockResolvedValue({
      ...mockRelationMsg,
      id: 'rel-new',
      createdBy: mockUser,
    });
    (prisma.$transaction as jest.Mock).mockResolvedValue([
      {
        id: 'rel-new',
        topicId: 'topic-1',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
        relationPayload: undefined,
        createdAt: new Date().toISOString(),
        createdBy: mockUser,
      },
      {},
    ]);
  });

  it('creates a relation with a message target and returns 201', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'REPLY',
        sourceMessageId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('rel-new');
  });

  it('turns a duplicate JOIN into AGREE on the existing JOIN', async () => {
    (prisma.message.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 'rel-container', topicId: 'topic-1', kind: 'RELATION', relationType: 'CLASSIFY',
    });
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage2])
      .mockResolvedValueOnce([{
        id: 'join-existing',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }]);
    (prisma.$transaction as jest.Mock).mockResolvedValueOnce([{
      id: 'agree-new',
      topicId: 'topic-1',
      relationType: 'AGREE',
      relSourceId: null,
      targetRefs: [{ kind: 'relation', relationId: 'join-existing' }],
      relationPayload: undefined,
      createdAt: new Date().toISOString(),
      createdBy: mockUser,
    }]);

    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'JOIN',
        sourceMessageId: 'rel-container',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.relationType).toBe('AGREE');
    expect(res.body.targetRefs).toEqual([{ kind: 'relation', relationId: 'join-existing' }]);
  });

  it('creates a relation with a text-fragment target', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'ANNOTATION',
        sourceMessageId: 'msg-1',
        targetRefs: [{
          kind: 'text-fragment',
          messageId: 'msg-2',
          text: 'hello',
          hash: 'abc123',
        }],
      });
    expect(res.status).toBe(201);
  });

  it('creates a relation targeting a relation message (recursive), returns 201', async () => {
    // Target is a RELATION-kind message in the unified table
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockRelationMsg]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'ANNOTATION',
        sourceMessageId: 'msg-1',
        targetRefs: [{ kind: 'relation', relationId: 'rel-1', part: 'label' }],
      });
    expect(res.status).toBe(201);
  });

  it('creates a relation with a relation message as source (relation messages are also messages), returns 201', async () => {
    // sourceMessageId is a RELATION-kind message — unified table lookup finds it in one query
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(mockRelationMsg);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'ANNOTATION',
        sourceMessageId: 'rel-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      });
    expect(res.status).toBe(201);
  });

  it('returns 404 when target relation does not exist', async () => {
    // findMany for RELATION-kind target returns empty (target not found)
    (prisma.message.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'ANNOTATION',
        sourceMessageId: 'msg-1',
        targetRefs: [{ kind: 'relation', relationId: 'nonexistent-rel' }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('目标关系消息');
  });
});

describe('POST /api/topics/:topicId/relations — SUMMARY validation', () => {
  beforeEach(() => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { minStake: 1, selfStakeOnCreate: 1 },
    });
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
      userId: 'user-1', balance: 100, debtFrozen: false,
    });
    (prisma.message.create as jest.Mock).mockResolvedValue({
      ...mockRelationMsg,
      id: 'rel-new',
      relationType: 'SUMMARY',
      createdBy: mockUser,
    });
    (prisma.$transaction as jest.Mock).mockResolvedValue([{
      ...mockRelationMsg,
      id: 'rel-new',
      relationType: 'SUMMARY',
      topicId: 'topic-1',
      kind: 'RELATION',
      relSourceId: 'msg-1',
      targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      createdAt: new Date().toISOString(),
      createdBy: mockUser,
    }]);
  });

  it('allows SUMMARY with sourceMessageId (join relations use it)', async () => {
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockMessage2]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'SUMMARY', sourceMessageId: 'msg-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }], payload: { title: '总结' } });
    expect(res.status).toBe(201);
  });

  it('rejects SUMMARY without payload.title', async () => {
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockMessage2]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'SUMMARY', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(400);
  });

  it('rejects SUMMARY without targetRefs', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'SUMMARY', targetRefs: [], payload: { title: '总结' } });
    expect(res.status).toBe(400);
  });

  it('creates SUMMARY with text targets and title, returns 201', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage2])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'SUMMARY', targetRefs: [{ kind: 'message', messageId: 'msg-2' }], payload: { title: '总结标题' } });
    expect(res.status).toBe(201);
  });

  it('creates SUMMARY with CLASSIFY relation target, returns 201', async () => {
    const mockClassifyRel = {
      id: 'rel-classify',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'CLASSIFY',
      relSourceId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
    };
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockClassifyRel])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'SUMMARY', targetRefs: [{ kind: 'relation', relationId: 'rel-classify' }], payload: { title: '总结标题' } });
    expect(res.status).toBe(201);
  });

  it('rejects SUMMARY when target relation is an invalid type (e.g. REPLY)', async () => {
    const mockReplyRel = {
      id: 'rel-reply',
      topicId: 'topic-1',
      kind: 'RELATION',
      relationType: 'REPLY',
      relSourceId: 'msg-1',
      targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
    };
    (prisma.message.findMany as jest.Mock).mockResolvedValueOnce([mockReplyRel]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'SUMMARY', targetRefs: [{ kind: 'relation', relationId: 'rel-reply' }], payload: { title: '总结标题' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('总结关系的目标关系消息');
  });

  it('rejects SUMMARY when target text messages have cross links to already-classified messages', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage2])
      .mockResolvedValueOnce([{
        id: 'rel-classify-existing',
        relationType: 'CLASSIFY',
        relSourceId: null,
        targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
      }, {
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'SUMMARY', targetRefs: [{ kind: 'message', messageId: 'msg-2' }], payload: { title: '总结标题' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('非引用关联');
  });

  it('allows SUMMARY when target text messages cross-link only to unclassified messages', async () => {
    (prisma.message.findMany as jest.Mock)
      .mockResolvedValueOnce([mockMessage2])
      .mockResolvedValueOnce([{
        id: 'rel-existing',
        relationType: 'REPLY',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
      }])
      .mockResolvedValueOnce([{ id: 'msg-1' }]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'SUMMARY', targetRefs: [{ kind: 'message', messageId: 'msg-2' }], payload: { title: '总结标题' } });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/topics/:topicId/relations — CORRECT single-target validation', () => {
  beforeEach(() => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockMessage2]);
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { minStake: 1, selfStakeOnCreate: 1 },
    });
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
      userId: 'user-1', balance: 100, debtFrozen: false,
    });
    (prisma.message.create as jest.Mock).mockResolvedValue({
      ...mockRelationMsg,
      id: 'rel-correct',
      createdBy: mockUser,
    });
    (prisma.settlementRound.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.settlementRound.create as jest.Mock).mockResolvedValue({ id: 'round-1' });
    (prisma.$transaction as jest.Mock).mockResolvedValue([
      {
        id: 'rel-correct',
        topicId: 'topic-1',
        relationType: 'CORRECT',
        relSourceId: 'msg-1',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
        createdAt: new Date().toISOString(),
        createdBy: mockUser,
      },
      {},
    ]);
  });

  it('allows CORRECT with a selected text fragment', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'CORRECT',
        sourceMessageId: null,
        targetRefs: [{ kind: 'text-fragment', messageId: 'msg-2', text: 'World', hash: 'hash-world' }],
        payload: { correctionContent: 'Corrected world' },
      });
    expect(res.status).toBe(201);
  });

  it('allows an empty replacement to delete the selected fragment', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'CORRECT',
        sourceMessageId: null,
        targetRefs: [{ kind: 'text-fragment', messageId: 'msg-2', text: 'World', hash: 'hash-world' }],
        payload: { correctionContent: '' },
      });
    expect(res.status).toBe(201);
  });

  it('rejects CORRECT targeting the whole message', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'CORRECT',
        sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
        payload: { correctionContent: 'Corrected world' },
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: any) => d.message.includes('消息片段'))).toBe(true);
  });

  it('rejects CORRECT with multiple targets', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'CORRECT',
        sourceMessageId: null,
        targetRefs: [
          { kind: 'text-fragment', messageId: 'msg-2', text: 'World', hash: 'hash-world' },
          { kind: 'text-fragment', messageId: 'msg-1', text: 'Hello', hash: 'hash-hello' },
        ],
        payload: { correctionContent: 'Corrected content' },
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: any) => d.message.includes('更正'))).toBe(true);
  });

  it('rejects CORRECT targeting a non-correctable relation message', async () => {
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockRelationMsg]);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'CORRECT',
        sourceMessageId: null,
        targetRefs: [{ kind: 'relation', relationId: 'rel-1' }],
        payload: { correctionContent: 'Corrected relation content' },
      });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/topics/:topicId/relations — TAG / RECOMMEND / ARCHIVE', () => {
  beforeEach(() => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockMessage2]);
    (prisma.ruleVersion.findFirst as jest.Mock).mockResolvedValue({
      parameters: { minStake: 1, selfStakeOnCreate: 1 },
    });
    (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
      userId: 'user-1', balance: 100, debtFrozen: false,
    });
    (prisma.message.create as jest.Mock).mockResolvedValue({
      ...mockRelationMsg,
      id: 'tag-new',
      createdBy: mockUser,
    });
    (prisma.settlementRound.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.settlementRound.create as jest.Mock).mockResolvedValue({ id: 'round-1' });
    (prisma.$transaction as jest.Mock).mockResolvedValue([
      {
        id: 'tag-new',
        topicId: 'topic-1',
        relationType: 'TAG',
        relSourceId: null,
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
        relationPayload: { label: '垃圾' },
        createdAt: new Date().toISOString(),
        createdBy: mockUser,
      },
      {},
    ]);
  });

  it('creates TAG with label', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'TAG',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
        payload: { label: '垃圾' },
      });
    expect(res.status).toBe(201);
  });

  it('rejects TAG without label', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'TAG',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
        payload: {},
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: any) => d.message.includes('标签'))).toBe(true);
  });

  it('creates RECOMMEND with subType', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'RECOMMEND',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
        payload: { subType: 'SPAM' },
      });
    expect(res.status).toBe(201);
  });

  it('creates ARCHIVE with subType', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        relationType: 'ARCHIVE',
        targetRefs: [{ kind: 'message', messageId: 'msg-2' }],
        payload: { subType: 'OFFTOPIC' },
      });
    expect(res.status).toBe(201);
  });
});
