import { describe, expect, it } from 'vitest';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { discussionBranchKey, projectDiscussionBranches, projectDiscussionLayoutEdges, revealDiscussionBranches } from '../pages/workbench/model/discussionBranches';

const message = (id: string, changes: Partial<DemoMessage> = {}): DemoMessage => ({ id, kind: 'normal', author: '结构测试', createdAt: '', content: '', ...changes });
const relation = (id: string, type: NonNullable<DemoMessage['relationType']> = 'reply', changes: Partial<DemoMessage> = {}) => message(id, { kind: 'relation', relationType: type, ...changes });
const edge = (id: string, from: string, to: string, record: string, type: DemoEdge['relationType'] = 'reply'): DemoEdge => ({ id, relationMessageId: record, relationType: type,
  from: { messageId: from, selection: { kind: 'whole' } }, to: { messageId: to, selection: { kind: 'whole' } }, relationLabel: type });
const project = (messages: DemoMessage[], edges: DemoEdge[], collapsed: string[] = []) => projectDiscussionBranches({ messages, edges, collapsed });

describe('discussion branch visibility', () => {
  it('keeps all messages and native edges by default, including isolated records and pure cycles', () => {
    const messages = [message('a'), message('b'), message('isolated'), relation('r1'), relation('r2'), relation('orphan')];
    const edges = [edge('e1', 'a', 'b', 'r1'), edge('e2', 'b', 'a', 'r2')];
    const result = project(messages, edges);
    expect([...result.messageIds]).toEqual(messages.map(value => value.id)); expect([...result.edgeIds]).toEqual(['e1', 'e2']);
    expect(result.groups.every(group => !group.collapsed && group.hiddenCount === 0)).toBe(true);
    const collapsed = project(messages, edges, [discussionBranchKey('a', 'reply')]);
    expect(collapsed.messageIds.has('a')).toBe(true); expect(collapsed.messageIds.has('b')).toBe(true);
    expect(collapsed.edgeIds.has('e2')).toBe(false);
  });

  it('folds a reply and its downstream discussion while preserving the target and unrelated messages', () => {
    const messages = [message('root'), message('child'), message('grandchild'), message('other'), relation('r1'), relation('r2')];
    const edges = [edge('e1', 'child', 'root', 'r1'), edge('e2', 'grandchild', 'child', 'r2')];
    const snapshot = JSON.stringify({ messages, edges });
    const result = project(messages, edges, [discussionBranchKey('root', 'reply')]);
    expect([...result.messageIds].sort()).toEqual(['other', 'root']); expect(result.edgeIds.size).toBe(0);
    expect(result.groupsByTarget.get('root')).toEqual([{ key: '["root","reply"]', targetId: 'root', type: 'reply', directCount: 1, hiddenCount: 1, collapsed: true }]);
    expect(JSON.stringify({ messages, edges })).toBe(snapshot);
    expect(project(messages, edges).messageIds.size).toBe(messages.length);
  });

  it('retains a shared source and descendants through another open target, including a multi-target relation', () => {
    const messages = ['left', 'right', 'shared', 'child'].map(id => message(id)).concat([relation('same-record'), relation('downstream')]);
    const edges = [edge('left-edge', 'shared', 'left', 'same-record'), edge('right-edge', 'shared', 'right', 'same-record'), edge('child-edge', 'child', 'shared', 'downstream')];
    const result = project(messages, edges, [discussionBranchKey('left', 'reply')]);
    expect(result.messageIds.size).toBe(messages.length); expect([...result.edgeIds]).toEqual(['right-edge', 'child-edge']);
    expect(result.groupsByTarget.get('left')![0].hiddenCount).toBe(1);
    const both = project(messages, edges, [discussionBranchKey('left', 'reply'), discussionBranchKey('right', 'reply')]);
    expect([...both.messageIds].sort()).toEqual(['left', 'right']);
  });

  it('groups executed stances by actual side and target, with native edge IDs and real evidence sources', () => {
    const vote = relation('vote', 'agree', { executedStance: { partId: 'stance', sourceRevision: 1, side: 'con', target: { messageId: 'reply-record' } } });
    const messages = [message('claim'), message('reason'), message('declaration-target'), relation('reply-record'), vote];
    const original = edge('native-stance-edge', 'reason', 'declaration-target', 'vote', 'agree');
    const edges = [edge('original-reply', 'reason', 'claim', 'reply-record'), original];
    const result = project(messages, edges, [discussionBranchKey('reply-record', 'disagree')]);
    expect(result.groupsByTarget.get('reply-record')![0].type).toBe('disagree');
    expect(result.edgeIds.has('native-stance-edge')).toBe(false); expect(result.edgeIds.has('original-reply')).toBe(true);
    expect(result.messageIds.has('reason')).toBe(true); expect(result.messageIds.has('vote')).toBe(false);
    expect(original.to.messageId).toBe('declaration-target'); expect(original.relationType).toBe('agree');
  });

  it('folds bodyless stance records without fabricating supporting text and can fold replies to those records', () => {
    const vote = relation('vote', 'agree', { parts: [], executedStance: { partId: 'stance', sourceRevision: 1, side: 'pro', target: { messageId: 'claim' } } });
    const messages = [message('claim'), vote, message('reply-body'), relation('reply-vote')];
    const edges = [edge('vote-edge', 'anon:vote', 'claim', 'vote', 'agree'), edge('reply-edge', 'reply-body', 'vote', 'reply-vote')];
    const result = project(messages, edges, [discussionBranchKey('claim', 'agree')]);
    expect([...result.messageIds]).toEqual(['claim']); expect(result.edgeIds.size).toBe(0);
    expect(result.groupsByTarget.get('claim')![0].directCount).toBe(1);
    const replyOnly = project(messages, edges, [discussionBranchKey('vote', 'reply')]);
    expect([...replyOnly.messageIds].sort()).toEqual(['claim', 'vote']); expect([...replyOnly.edgeIds]).toEqual(['vote-edge']);
  });

  it('counts each record once per group, preserves opaque containers and does not invent missing endpoints', () => {
    const messages = [message('target'), message('source'), relation('r'), relation('unknown'), relation('category', 'classify')];
    const edges = [edge('one', 'source', 'target', 'r'), edge('two', 'source', 'target', 'r'),
      edge('unknown-target', 'source', 'missing', 'unknown'), edge('category-reply', 'category', 'target', 'r'),
      edge('membership', 'anon:category', 'source', 'category', 'classify')];
    const result = project(messages, edges, [discussionBranchKey('target', 'reply')]);
    expect(result.groupsByTarget.get('target')![0].directCount).toBe(1);
    expect(result.messageIds.has('source')).toBe(true); expect(result.messageIds.has('category')).toBe(true);
    expect(result.edgeIds.has('unknown-target')).toBe(true); expect(result.edgeIds.has('membership')).toBe(true);
    expect(result.groupsByTarget.has('missing')).toBe(false);
  });

  it('does not let membership edges keep an otherwise folded discussion body visible', () => {
    const messages = [message('root'), message('child'), relation('reply'), relation('category', 'classify')];
    const edges = [edge('reply-edge', 'child', 'root', 'reply'), edge('member-root', 'anon:category', 'root', 'category', 'classify'), edge('member-child', 'anon:category', 'child', 'category', 'classify')];
    const result = project(messages, edges, [discussionBranchKey('root', 'reply')]);
    expect([...result.messageIds].sort()).toEqual(['category', 'root']); expect([...result.edgeIds]).toEqual(['member-root']);
  });

  it('handles a long branch iteratively rather than recursing through the discussion', () => {
    const count = 4000, messages = [message('root')], edges: DemoEdge[] = [];
    for (let index = 0; index < count; index++) {
      messages.push(message(`body-${index}`), relation(`reply-${index}`));
      edges.push(edge(`edge-${index}`, `body-${index}`, index ? `body-${index - 1}` : 'root', `reply-${index}`));
    }
    const result = project(messages, edges, [discussionBranchKey('root', 'reply')]);
    expect([...result.messageIds]).toEqual(['root']); expect(result.edgeIds.size).toBe(0);
  });
});

describe('relationship cards in discussion layout', () => {
  it('anchors an addressed reply record to its declared target without replacing the original evidence edge', () => {
    const messages = [message('claim'), message('reason'), relation('reply'), message('followup'), relation('nested')];
    const edges = [edge('reply-edge', 'reason', 'claim', 'reply'), edge('nested-edge', 'followup', 'reply', 'nested')];
    const snapshot = JSON.stringify({ messages, edges });
    const layout = projectDiscussionLayoutEdges(messages, edges, new Set(['reply']));
    expect(layout.find(value => value.id === 'reply-edge')).toBe(edges[0]);
    expect(layout.find(value => value.id === 'nested-edge')).toBe(edges[1]);
    const anchor = layout.find(value => value.id !== 'reply-edge' && value.id !== 'nested-edge')!;
    expect(anchor).toMatchObject({ relationMessageId: 'reply', from: { messageId: 'reply' }, to: { messageId: 'claim' } });
    expect(JSON.stringify({ messages, edges })).toBe(snapshot);
  });

  it('uses a forced bodyless stance card as a layout source without inventing another message or native edge ID', () => {
    const vote = relation('vote', 'agree', { parts: [], executedStance: { partId: 'stance', sourceRevision: 1, side: 'pro', target: { messageId: 'claim' } } });
    const messages = [message('claim'), vote], edges = [edge('native-vote', 'anon:vote', 'claim', 'vote', 'agree')];
    const layout = projectDiscussionLayoutEdges(messages, edges, new Set(['vote']));
    expect(layout).toHaveLength(1); expect(layout[0]).toMatchObject({ id: 'native-vote', from: { messageId: 'vote' }, to: { messageId: 'claim' } });
    expect(edges[0].from.messageId).toBe('anon:vote'); expect(messages).toHaveLength(2);
  });

  it('keeps the executed stance location while separately anchoring its card to the original addressed record', () => {
    const vote = relation('vote', 'disagree', { parts: [], executedStance: { partId: 'stance', sourceRevision: 1, side: 'con', target: { messageId: 'claim' } } });
    const messages = [message('claim'), relation('earlier-vote', 'agree'), vote];
    const edges = [edge('vote-edge', 'anon:vote', 'earlier-vote', 'vote', 'disagree')];
    const layout = projectDiscussionLayoutEdges(messages, edges, new Set(['vote']));
    expect(layout[0]).toMatchObject({ id: 'vote-edge', from: { messageId: 'vote' }, to: { messageId: 'claim' } });
    expect(layout[1]).toMatchObject({ from: { messageId: 'vote' }, to: { messageId: 'earlier-vote' } });
    expect(layout[1].id).not.toBe('vote-edge'); expect(edges[0].to.messageId).toBe('earlier-vote');
  });

  it('does not force organization cards, invent unknown targets, or duplicate the same anchor for repeated addresses', () => {
    const messages = [message('claim'), message('reason'), relation('record'), relation('category', 'classify')];
    const edges = [edge('one', 'reason', 'claim', 'record'), edge('two', 'reason', 'claim', 'record'),
      edge('unknown', 'reason', 'missing', 'record'), edge('membership', 'anon:category', 'claim', 'category', 'classify')];
    const layout = projectDiscussionLayoutEdges(messages, edges, new Set(['record', 'category']));
    expect(layout).toHaveLength(edges.length + 1);
    expect(layout.filter(value => value.from.messageId === 'record')).toHaveLength(1);
    expect(layout.find(value => value.id === 'membership')).toBe(edges[3]);
  });
});

describe('revealing folded discussion navigation targets', () => {
  it('opens the nested path to a requested body while preserving an independent folded branch', () => {
    const messages = ['root', 'child', 'grandchild', 'other', 'other-child'].map(id => message(id)).concat([relation('r1'), relation('r2'), relation('other-reply')]);
    const edges = [edge('one', 'child', 'root', 'r1'), edge('two', 'grandchild', 'child', 'r2'), edge('other-edge', 'other-child', 'other', 'other-reply')];
    const collapsed = ['root', 'child', 'other'].map(id => discussionBranchKey(id, 'reply'));
    const next = revealDiscussionBranches({ messages, edges, collapsed, messageIds: ['grandchild'] });
    expect(next).toEqual([discussionBranchKey('other', 'reply')]);
    expect(project(messages, edges, next).messageIds.has('grandchild')).toBe(true);
    expect(project(messages, edges, next).messageIds.has('other-child')).toBe(false);
    expect(collapsed).toHaveLength(3);
  });

  it('opens only one route to a shared source and reuses it for other requested descendants', () => {
    const messages = ['left', 'right', 'shared', 'child'].map(id => message(id)).concat([relation('shared-reply'), relation('child-reply')]);
    const edges = [edge('left-edge', 'shared', 'left', 'shared-reply'), edge('right-edge', 'shared', 'right', 'shared-reply'), edge('child-edge', 'child', 'shared', 'child-reply')];
    const collapsed = [discussionBranchKey('left', 'reply'), discussionBranchKey('right', 'reply')];
    const next = revealDiscussionBranches({ messages, edges, collapsed, messageIds: ['shared', 'child'] });
    expect(next).toHaveLength(1); expect(next[0]).toBe(discussionBranchKey('right', 'reply'));
    const visible = project(messages, edges, next).messageIds;
    expect(visible.has('shared')).toBe(true); expect(visible.has('child')).toBe(true);
  });

  it('reveals an executed bodyless stance record by its actual group while leaving old declaration groups folded', () => {
    const vote = relation('vote', 'agree', { parts: [], executedStance: { partId: 'stance', sourceRevision: 1, side: 'con', target: { messageId: 'claim' } } });
    const messages = [message('claim'), relation('old-vote', 'agree'), vote];
    const edges = [edge('vote-edge', 'anon:vote', 'old-vote', 'vote', 'agree')];
    const collapsed = [discussionBranchKey('claim', 'disagree'), discussionBranchKey('old-vote', 'agree')];
    const next = revealDiscussionBranches({ messages, edges, collapsed, messageIds: ['vote'] });
    expect(next).toEqual([discussionBranchKey('old-vote', 'agree')]);
    expect(project(messages, edges, next).edgeIds.has('vote-edge')).toBe(true);
  });

  it('does not unfold visible targets, unknown IDs, or pure cycles unnecessarily', () => {
    const messages = [message('a'), message('b'), relation('ab'), relation('ba')];
    const edges = [edge('ab-edge', 'a', 'b', 'ab'), edge('ba-edge', 'b', 'a', 'ba')];
    const collapsed = [discussionBranchKey('a', 'reply'), 'unrecognized-saved-key'];
    expect(revealDiscussionBranches({ messages, edges, collapsed, messageIds: ['a', 'b', 'missing'] })).toEqual(collapsed);
  });
});
