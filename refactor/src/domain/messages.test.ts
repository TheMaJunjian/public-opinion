import { describe, expect, it } from 'vitest';
import { fixtureMessages } from './fixtures';
import { createTopicIndex, relationTargetId } from './messages';

describe('unified message model', () => {
  it('keeps every relation as an independently addressable message', () => {
    const relation = fixtureMessages.find((message) => message.id === 'rel-reply');

    expect(relation).toMatchObject({
      id: 'rel-reply',
      kind: 'RELATION',
      relationType: 'REPLY',
      sourceMessageId: 'msg-evidence',
    });
    expect(fixtureMessages.every((message) => !message.id.startsWith('anon:'))).toBe(true);
  });

  it('indexes relations by actual source and target message IDs', () => {
    const index = createTopicIndex(fixtureMessages);

    expect(index.relationById.get('rel-reply')?.id).toBe('rel-reply');
    expect(index.relationsBySourceId.get('msg-evidence')?.map((relation) => relation.id))
      .toEqual(expect.arrayContaining(['rel-reply', 'rel-reference']));
    expect(index.relationsByTargetId.get('rel-reply')?.map((relation) => relation.id))
      .toContain('rel-agree');
  });

  it('preserves whether a relation targets a message, fragment, or another relation', () => {
    const reference = fixtureMessages.find((message) => message.id === 'rel-reference');
    const stance = fixtureMessages.find((message) => message.id === 'rel-agree');

    if (!reference || reference.kind !== 'RELATION' || !stance || stance.kind !== 'RELATION') throw new Error('fixture is invalid');
    expect(reference.targetRefs[0]).toMatchObject({ kind: 'text-fragment', messageId: 'msg-claim' });
    expect(stance.targetRefs[0]).toMatchObject({ kind: 'relation', relationId: 'rel-reply' });
    expect(relationTargetId(stance.targetRefs[0])).toBe('rel-reply');
  });
});
