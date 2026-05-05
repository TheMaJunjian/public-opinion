/**
 * validation.test.ts — Unit tests for request validation schemas used in routes.
 *
 * These tests validate the Zod schemas directly (without hitting the database),
 * ensuring the discriminated-union TargetRef schema correctly accepts/rejects
 * all valid and invalid target ref shapes.
 */

import { z } from 'zod';
import { RELATION_TYPES } from '../lib/relationTypes';

// ─── Replicate the validation schemas from routes/relations.ts ─────────────
// (We re-declare them here so we can test them in isolation)

const targetRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    messageId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('text-fragment'),
    messageId: z.string().min(1),
    text: z.string().min(1).max(2000),
    hash: z.string().min(1),
    contextBefore: z.string().max(200).optional(),
    contextAfter: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('relation'),
    relationId: z.string().min(1),
    part: z.enum(['label', 'decoration', 'frame', 'whole']).optional(),
  }),
]);

const createRelationSchema = z.object({
  relationType: z.enum(RELATION_TYPES, {
    errorMap: () => ({ message: `关系类型必须是以下之一: ${RELATION_TYPES.join(', ')}` }),
  }),
  sourceMessageId: z.string().min(1),
  targetRefs: z.array(targetRefSchema).min(1).max(20),
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('TargetRef — message kind', () => {
  it('accepts a valid message ref', () => {
    const result = targetRefSchema.safeParse({ kind: 'message', messageId: 'msg-1' });
    expect(result.success).toBe(true);
  });

  it('rejects a message ref with empty messageId', () => {
    const result = targetRefSchema.safeParse({ kind: 'message', messageId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a message ref missing messageId', () => {
    const result = targetRefSchema.safeParse({ kind: 'message' });
    expect(result.success).toBe(false);
  });
});

describe('TargetRef — text-fragment kind', () => {
  it('accepts a valid text-fragment ref', () => {
    const result = targetRefSchema.safeParse({
      kind: 'text-fragment',
      messageId: 'msg-1',
      text: 'hello world',
      hash: 'abc123',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a text-fragment with optional context fields', () => {
    const result = targetRefSchema.safeParse({
      kind: 'text-fragment',
      messageId: 'msg-1',
      text: 'hello',
      hash: 'abc123',
      contextBefore: 'before text',
      contextAfter: 'after text',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a text-fragment with missing hash', () => {
    const result = targetRefSchema.safeParse({
      kind: 'text-fragment',
      messageId: 'msg-1',
      text: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a text-fragment with text exceeding 2000 chars', () => {
    const result = targetRefSchema.safeParse({
      kind: 'text-fragment',
      messageId: 'msg-1',
      text: 'x'.repeat(2001),
      hash: 'abc123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a text-fragment with contextBefore exceeding 200 chars', () => {
    const result = targetRefSchema.safeParse({
      kind: 'text-fragment',
      messageId: 'msg-1',
      text: 'hello',
      hash: 'abc',
      contextBefore: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });
});

describe('TargetRef — relation kind', () => {
  it('accepts a valid relation ref without part', () => {
    const result = targetRefSchema.safeParse({
      kind: 'relation',
      relationId: 'rel-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a relation ref with valid part values', () => {
    for (const part of ['label', 'decoration', 'frame', 'whole'] as const) {
      const result = targetRefSchema.safeParse({ kind: 'relation', relationId: 'rel-1', part });
      expect(result.success).toBe(true);
    }
  });

  it('rejects a relation ref with an invalid part value', () => {
    const result = targetRefSchema.safeParse({
      kind: 'relation',
      relationId: 'rel-1',
      part: 'invalid-part',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a relation ref with empty relationId', () => {
    const result = targetRefSchema.safeParse({ kind: 'relation', relationId: '' });
    expect(result.success).toBe(false);
  });
});

describe('TargetRef — invalid kind', () => {
  it('rejects an object with an unknown kind', () => {
    const result = targetRefSchema.safeParse({ kind: 'unknown', messageId: 'msg-1' });
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = targetRefSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

describe('createRelationSchema', () => {
  const validPayload = {
    relationType: 'REPLY',
    sourceMessageId: 'src-msg-1',
    targetRefs: [{ kind: 'message', messageId: 'tgt-msg-1' }],
  };

  it('accepts a valid relation creation payload', () => {
    const result = createRelationSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('rejects an unknown relationType', () => {
    const result = createRelationSchema.safeParse({
      ...validPayload,
      relationType: 'INVALID_TYPE',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all defined relation types', () => {
    for (const type of RELATION_TYPES) {
      const result = createRelationSchema.safeParse({
        ...validPayload,
        relationType: type,
      });
      if (!result.success) {
        throw new Error(`Type ${type} should be valid but got: ${JSON.stringify(result.error.issues)}`);
      }
      expect(result.success).toBe(true);
    }
  });

  it('rejects empty targetRefs array', () => {
    const result = createRelationSchema.safeParse({ ...validPayload, targetRefs: [] });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 targetRefs', () => {
    const refs = Array.from({ length: 21 }, (_, i) => ({
      kind: 'message' as const,
      messageId: `msg-${i}`,
    }));
    const result = createRelationSchema.safeParse({ ...validPayload, targetRefs: refs });
    expect(result.success).toBe(false);
  });

  it('accepts a relation targeting another relation — schema allows it (DB validates existence)', () => {
    // The schema ALLOWS relation-kind targets; DB validation ensures the relation exists
    const result = createRelationSchema.safeParse({
      ...validPayload,
      targetRefs: [{ kind: 'relation', relationId: 'rel-1', part: 'label' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts mixed message + relation targets', () => {
    const result = createRelationSchema.safeParse({
      ...validPayload,
      targetRefs: [
        { kind: 'message', messageId: 'msg-1' },
        { kind: 'relation', relationId: 'rel-1' },
      ],
    });
    expect(result.success).toBe(true);
  });
});
