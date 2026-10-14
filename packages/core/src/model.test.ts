import { describe, expect, it } from 'vitest';
import { bindRoles, projectMessages, replaceReference, resolveReference, resolveStance } from './model.js';
import type { Message, Part } from './types.js';
const message = (id: string, parts: Part[], sequence = 1): Message => ({ id, parts, revision: 1, authorId: 'a', sequence, createdAt: '', updatedAt: '', regionId: 'local', ledgerId: 'local', programVersion: '2.0.0', ruleVersion: 1, spending: { protocol: 1, recommendation: 0, wager: 0 } });
describe('addressable message components', () => {
  const a = message('claim', [{ id: 'body', type: 'text', text: '城市应该种树' }]);
  const b = message('objection', [{ id: 'stance', type: 'relation', relation: 'disagree', roles: bindRoles({ target: [{ messageId: a.id }] }) }, { id: 'reason', type: 'text', text: '种树成本过高' }]);
  const resolver = (id: string) => [a, b].find(m => m.id === id);
  it('distinguishes membership slot, reference value, and referenced content', () => {
    expect(resolveReference({ messageId: b.id, partId: 'stance', memberId: 'target-0' }, resolver)).toEqual({ id: 'target-0', reference: { messageId: 'claim' } });
    expect(resolveReference({ messageId: b.id, partId: 'stance', memberId: 'target-0', path: ['reference'] }, resolver)).toEqual({ messageId: 'claim' });
    expect(resolveReference({ messageId: b.id, partId: 'stance', memberId: 'target-0', path: ['reference', 'messageId'] }, resolver)).toBe('claim');
    expect(resolveReference({ messageId: a.id, partId: 'body', range: { start: 4, end: 6 } }, resolver)).toBe('种树');
  });
  it('opposing a stance reverses it but opposing its reason does not', () => {
    expect(resolveStance({ messageId: b.id, partId: 'stance' }, 'con', resolver)).toMatchObject({ target: { messageId: a.id }, side: 'pro' });
    expect(resolveStance({ messageId: b.id, partId: 'reason' }, 'con', resolver)).toMatchObject({ target: { messageId: b.id, partId: 'reason' }, side: 'con' });
    expect(resolveStance({ messageId: b.id }, 'con', resolver).target.messageId).toBe(b.id);
  });
  it('resolves pinned versions and refuses stale resolver results', () => {
    expect(resolveReference({ messageId: a.id, revision: 2 }, resolver)).toBeUndefined();
    expect(resolveReference({ messageId: a.id, revision: 1, partId: 'body' }, resolver)).toEqual(a.parts[0]);
  });
  it('edits only the selected component and preserves historical input', () => {
    const parts = replaceReference(a, { messageId: a.id, partId: 'body', range: { start: 4, end: 6 } }, '植树');
    expect(parts[0]).toMatchObject({ text: '城市应该植树' });
    expect(a.parts[0]).toMatchObject({ text: '城市应该种树' });
    expect(() => replaceReference(a, { messageId: a.id, partId: 'body', path: ['__proto__'] }, {})).toThrow();
  });
  it('cancels summary effects immediately while preserving summary identity and members', () => {
    const summary = message('summary', [{ id: 'group', type: 'relation', relation: 'summary', roles: bindRoles({ members: [{ messageId: a.id }] }) }]);
    const con = message('con', [{ id: 'stance', type: 'relation', relation: 'disagree', roles: bindRoles({ target: [{ messageId: summary.id, partId: 'group' }] }) }], 2);
    const projection = projectMessages([a, summary, con], [{ memberId: a.id, parentId: summary.id, sourceId: summary.id }]);
    expect(projection.suppressed.has(summary.id)).toBe(true);
    expect(projection.byId.get(summary.id)).toBe(summary);
    expect(projection.children.get(summary.id)).toEqual([a]);
    expect(projection.roots).toContain(summary);
  });
  it('keeps a member address stable after reordering', () => {
    const grouping = message('group', [{ id: 'members', type: 'relation', relation: 'arrange', roles: { members: [
      { id: 'first', reference: { messageId: a.id } }, { id: 'second', reference: { messageId: b.id } },
    ] } }]);
    const ref = { messageId: grouping.id, partId: 'members', memberId: 'first', path: ['reference'] };
    const before = resolveReference(ref, () => grouping);
    if (grouping.parts[0].type === 'relation') grouping.parts[0].roles.members.reverse();
    expect(resolveReference(ref, () => grouping)).toEqual(before);
  });
});
