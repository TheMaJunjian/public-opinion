import { expect, it } from 'vitest';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { manualDiscussionTargets } from '../utils/graphProjection';
import { discussionBranchKey, projectDiscussionBranches } from '../pages/workbench/model/discussionBranches';

// Empty source bodies isolate frame membership and visual folding semantics.
const message = (id: string, extra: Partial<DemoMessage> = {}): DemoMessage => ({ id, kind: 'normal', content: '', author: '', createdAt: '', ...extra });
const frame = (id: string, layout: 'row' | 'flow' | 'columns' = 'row', extra: Partial<DemoMessage> = {}) => message(id, {
  kind: 'relation', relationType: 'arrange', parts: [{ id: 'display', type: 'display', layout, relationPartId: 'members' }], ...extra,
});
const member = (container: string, target: string, extra: Partial<DemoEdge> = {}): DemoEdge => ({
  id: `${container}:${target}`, relationMessageId: container, relationType: 'arrange', relationLabel: '',
  from: { messageId: `anon:${container}`, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } }, ...extra,
});
const reply = (id: string, from: string, to: string): DemoEdge => ({ id, relationMessageId: id, relationType: 'reply', relationLabel: '',
  from: { messageId: from, selection: { kind: 'whole' } }, to: { messageId: to, selection: { kind: 'whole' } } });
function visible(messages: DemoMessage[], edges: DemoEdge[], saved: readonly string[]) {
  const manual = manualDiscussionTargets({ messages, edges });
  return projectDiscussionBranches({ messages, edges, collapsed: saved.filter(key => !manual.has(JSON.parse(key)[0])) });
}

it.each(['row', 'flow'] as const)('temporarily ignores saved folds in an explicit %s frame and restores them outside it', layout => {
  const plain = [message('target'), message('child'), message('reply', { kind: 'relation', relationType: 'reply' })];
  const replies = [reply('reply', 'child', 'target')];
  const saved = Object.freeze([discussionBranchKey('target', 'reply')]);
  expect(visible(plain, replies, saved).messageIds.has('child')).toBe(false);
  const messages = [...plain, frame('ordered', layout)], edges = [...replies, member('ordered', 'target'), member('ordered', 'child')];
  const original = JSON.stringify({ messages, edges });
  expect(manualDiscussionTargets({ messages, edges })).toEqual(new Set(['target', 'child']));
  expect(visible(messages, edges, saved).messageIds.has('child')).toBe(true);
  expect(visible(messages, edges, saved).edgeIds.has('reply')).toBe(true);
  expect(JSON.stringify({ messages, edges })).toBe(original);
  expect(saved).toEqual([discussionBranchKey('target', 'reply')]);
  expect(visible(plain, replies, saved).messageIds.has('child')).toBe(false);
});

it('uses only direct targets and leaves nested automatic-frame branches foldable', () => {
  const messages = [frame('outer'), frame('automatic', 'columns'), message('direct'), message('child'), message('inner'), message('inner-child'),
    message('direct-reply', { kind: 'relation', relationType: 'reply' }), message('inner-reply', { kind: 'relation', relationType: 'reply' })];
  const edges = [member('outer', 'direct'), member('outer', 'child'), member('outer', 'automatic'),
    member('automatic', 'inner'), member('automatic', 'inner-child'), reply('direct-reply', 'child', 'direct'), reply('inner-reply', 'inner-child', 'inner')];
  const saved = [discussionBranchKey('direct', 'reply'), discussionBranchKey('inner', 'reply')];
  expect(manualDiscussionTargets({ messages, edges })).toEqual(new Set(['direct', 'child']));
  const result = visible(messages, edges, saved);
  expect(result.messageIds.has('child')).toBe(true);
  expect(result.messageIds.has('inner')).toBe(true);
  expect(result.messageIds.has('inner-child')).toBe(false);
  expect(result.groupsByTarget.get('inner')?.[0].collapsed).toBe(true);
});

it('does not exempt default, multi-column, proposed or suppressed organization memberships', () => {
  const messages = [message('default-target'), message('columns-target'), message('proposed-target'), message('suppressed-target'),
    frame('default', 'row', { parts: undefined, relationPayload: { targetLayout: 'single-row' } }), frame('columns', 'columns'),
    frame('proposed'), frame('suppressed', 'row', { state: { suppressed: true } as DemoMessage['state'] })];
  const edges = [member('default', 'default-target'), member('columns', 'columns-target'), member('proposed', 'proposed-target', { proposalOnly: true }), member('suppressed', 'suppressed-target')];
  expect(manualDiscussionTargets({ messages, edges }).size).toBe(0);
});

it('includes relation anchors that may become cards, but excludes settlement, join and addressed historical members', () => {
  const messages = [frame('ordered'), message('reply-anchor', { kind: 'relation', relationType: 'reply' }),
    message('settlement', { kind: 'round' }), message('join', { kind: 'join' }), message('fragment')];
  const edges = [member('ordered', 'reply-anchor'), member('ordered', 'settlement'), member('ordered', 'join'),
    member('ordered', 'fragment', { to: { messageId: 'fragment', selection: { kind: 'whole' }, reference: { messageId: 'fragment', revision: 1, partId: 'body' } } })];
  expect(manualDiscussionTargets({ messages, edges })).toEqual(new Set(['reply-anchor']));
});
