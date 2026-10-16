import { expect, it } from 'vitest';
import { decodeWorkbenchSnapshot, encodeWorkbenchSnapshot } from './snapshot-transport.js';

it('round-trips complete records and only removes duplicate transport copies', () => {
  const relation = {
    id: 'old-join', content: '旧正文',
    targetRefs: [{ kind: 'relation', relationId: 'frame', reference: { messageId: 'frame', revision: 2, partId: 'body', range: { start: 1, end: 3 } } }],
    declaredTargetRefs: [{ kind: 'message', messageId: 'original-member' }],
    parts: [{ type: 'data', value: { legacyStatus: 'VOTING', legacyTitle: '原标题', arbitraryHistory: [null, false, 0, ''] } }],
    payload: { membershipHistory: { previous: ['older-join'] } },
  };
  const extra = { ...relation, id: 'standalone', additionalField: '保留' };
  const original = {
    messages: [{ id: 'plain', content: '正文' }, relation], relations: [relation, extra],
    users: [{ id: 'old-user', username: '旧用户' }],
    stakes: { plain: { pools: { TRUTH: { lockedPro: 10, lockedCon: 2 } }, stakes: [{ id: 'old-stake', amount: 10 }] } },
    personalStates: [{ action: 'read' }], sequence: 19, nextCursor: 'older', hasMore: false,
    removedMemberships: ['disabled-join'], removedMessageIds: [],
  };
  const encoded = encodeWorkbenchSnapshot(original);
  expect(encoded.relationRecords).toEqual([1, extra]);
  const decoded = decodeWorkbenchSnapshot<typeof original>(JSON.parse(JSON.stringify(encoded)));
  expect(decoded).toEqual(original);
  expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(original).length);
  expect(decodeWorkbenchSnapshot(original)).toBe(original);
});

it('keeps differing relation copies rather than deduplicating by ID', () => {
  const original = { messages: [{ id: 'same', content: 'current' }], relations: [{ id: 'same', content: 'historic', revision: 1 }] };
  expect(decodeWorkbenchSnapshot<typeof original>(JSON.parse(JSON.stringify(encodeWorkbenchSnapshot(original))))).toEqual(original);
});

it('rejects broken compact references rather than silently dropping historical relations', () => {
  for (const reference of [-1, 1, 0.5]) {
    expect(() => decodeWorkbenchSnapshot({ messages: [{}], snapshotEncoding: 'relations-v1', relationRecords: [reference] })).toThrow('关系引用无效');
  }
});
