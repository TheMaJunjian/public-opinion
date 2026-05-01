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
      findMany: jest.fn(),
      count: jest.fn(),
    },
    relation: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../lib/prisma';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

const mockUser = { id: 'user-1', username: 'tester' };
const mockTopic = { id: 'topic-1', status: 'OPEN', title: 'Test Topic' };
const mockMessage = { id: 'msg-1', topicId: 'topic-1', content: 'Hello', createdBy: mockUser };
const mockMessage2 = { id: 'msg-2', topicId: 'topic-1', content: 'World', createdBy: mockUser };
const mockRelation = {
  id: 'rel-1',
  topicId: 'topic-1',
  relationType: 'REPLY',
  sourceMessageId: 'msg-1',
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
    (prisma.relation.count as jest.Mock).mockResolvedValue(1);
    (prisma.relation.findMany as jest.Mock).mockResolvedValue([mockRelation]);
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
    expect(res.body.error).toBe('话题不存在');
  });

  it('returns empty data array when no relations exist', async () => {
    (prisma.relation.count as jest.Mock).mockResolvedValue(0);
    (prisma.relation.findMany as jest.Mock).mockResolvedValue([]);
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
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockMessage2]);
    (prisma.relation.findMany as jest.Mock).mockResolvedValue([mockRelation]);
    (prisma.relation.create as jest.Mock).mockResolvedValue({
      ...mockRelation,
      id: 'rel-new',
    });
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

  it('returns 400 when sourceMessageId is missing', async () => {
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'REPLY', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
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

  it('returns 404 when source message does not exist', async () => {
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/topics/topic-1/relations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ relationType: 'REPLY', sourceMessageId: 'nonexistent', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('来源消息');
  });
});

describe('POST /api/topics/:topicId/relations — successful creation', () => {
  beforeEach(() => {
    (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
    (prisma.message.findFirst as jest.Mock).mockResolvedValue(mockMessage);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([mockMessage2]);
    (prisma.relation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.relation.create as jest.Mock).mockResolvedValue({
      ...mockRelation,
      id: 'rel-new',
      createdBy: mockUser,
    });
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
    // Mock that the target relation exists
    (prisma.relation.findMany as jest.Mock).mockResolvedValue([mockRelation]);
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

  it('returns 404 when target relation does not exist', async () => {
    // findMany for relations returns empty (target relation not found)
    (prisma.relation.findMany as jest.Mock).mockResolvedValue([]);
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
