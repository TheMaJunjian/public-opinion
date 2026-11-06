import { expect, it } from 'vitest';
import { projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import type { WorkbenchSnapshot } from '../data/workbench';
import type { Message, Relation } from '../types';

it('prunes unloaded edge targets without renumbering the remaining edge or changing relation evidence', () => {
  const createdBy = { id: 'author', username: '作者', createdAt: '' };
  const target: Message = { id: 'loaded', revision: 1, kind: 'TEXT', content: '正文', contentType: 'TEXT', createdAt: '', createdBy };
  const relation: Relation = { id: 'reference', relationType: 'REFERENCE', sourceMessageId: null, createdAt: '', createdBy,
    targetRefs: ['closed', 'loaded'].map(messageId => ({ kind: 'message', messageId })) };
  const snapshot: WorkbenchSnapshot = { scope: { messageId: null, title: '公论' }, sequence: 1, users: [createdBy],
    messages: [target, { ...target, id: relation.id, kind: 'RELATION', content: '', relationType: relation.relationType, targetRefs: relation.targetRefs }],
    relations: [relation], stakes: {}, tagCounts: {}, attentionUsers: {} };
  const all = projectWorkbenchSnapshot(snapshot), scoped = projectWorkbenchSnapshot(snapshot, { loadedOnly: true });
  expect(all.edges).toHaveLength(2);
  expect(scoped.edges).toEqual(all.edges.filter(edge => edge.to.messageId === 'loaded'));
  expect(scoped.relations[0].targetRefs).toBe(relation.targetRefs);
  expect(scoped.relations[0].targetRefs).toHaveLength(2);
});
