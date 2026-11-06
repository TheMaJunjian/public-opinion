import { expect, it } from 'vitest';
import { structureSnapshot } from './structure-snapshot.js';
import type { NativeMessageView, WorkbenchSnapshot, RelationView } from './workbench.js';

it('retains membership, reference identities and statistics without transporting original or replacement bodies', () => {
  const record = { id: 'r', revision: 1, sequence: 3, kind: 'RELATION', relationType: 'CORRECT', contentType: 'TEXT',
    content: 'original body', relationPayload: { correctionAfterContent: 'replacement body', correctionKind: 'TEXT' },
    payload: { correctionAfterContent: 'replacement body', correctionKind: 'TEXT' },
    createdAt: '', createdBy: { id: 'u', username: '甲', createdAt: '' }, sourceMessageId: null,
    parts: [{ id: 'text', type: 'text', text: 'original body' }, { id: 'data', type: 'data', value: { source: 'original body' } },
      { id: 'rel', type: 'relation', relation: 'correct', roles: { target: [{ id: 'b', reference: { messageId: 'm', revision: 1 } }] } }],
    targetRefs: [{ kind: 'text-fragment', messageId: 'm', text: 'quoted body', hash: 'hash', reference: { messageId: 'm', revision: 1 } }],
  } as unknown as NativeMessageView & RelationView;
  const snapshot: WorkbenchSnapshot = { scope: { messageId: null, title: '讨论' }, sequence: 3, regionId: 'region',
    messages: [record], relations: [record], users: [], stakes: {}, tagCounts: { m: { RECOMMEND: 5 } }, attentionUsers: {} };
  const result = structureSnapshot(snapshot), json = JSON.stringify(result);
  for (const body of ['original body', 'replacement body', 'quoted body']) expect(json).not.toContain(body);
  expect(result.messages[0]).toBe(result.relations[0]);
  expect(result.messages[0].parts![2]).toEqual(record.parts[2]);
  expect(result.messages[0].targetRefs![0]).toMatchObject({ reference: { messageId: 'm', revision: 1 } });
  expect(result.messages[0].relationPayload).toMatchObject({ correctionAfterContent: '', correctionKind: 'TEXT' });
  expect(result.tagCounts).toEqual(snapshot.tagCounts);
  expect(record.content).toBe('original body');
  expect(result.structureOnly).toBe(true);
});
