import { describe, expect, it } from 'vitest';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { discussionBranchKey, projectDiscussionBranches, revealDiscussionBranches } from '../pages/workbench/model/discussionBranches';

const message = (id: string, changes: Partial<DemoMessage> = {}): DemoMessage => ({ id, kind: 'normal', author: '结构测试', createdAt: '', content: '', ...changes });
const record = (id: string, type: NonNullable<DemoMessage['relationType']> = 'reply') => message(id, { kind: 'relation', relationType: type });
const edge = (id: string, recordId: string, source: string, target: string, type: DemoEdge['relationType'] = 'reply'): DemoEdge => ({
  id, relationMessageId: recordId, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
const project = (messages: DemoMessage[], edges: DemoEdge[], collapsed: string[] = []) => projectDiscussionBranches({ messages, edges, collapsed });

describe('automatic discussion-region branch descriptors', () => {
  it('keeps a folded region descriptor and independent sibling regions without fabricating native organization records', () => {
    const messages = [message('target'), message('reply-body'), message('support-body'), message('opposition-body'),
      record('reply'), record('support', 'agree'), record('opposition', 'disagree')];
    const edges = [edge('reply-edge', 'reply', 'reply-body', 'target'), edge('support-edge', 'support', 'support-body', 'target', 'agree'),
      edge('opposition-edge', 'opposition', 'opposition-body', 'target', 'disagree')];
    const before = JSON.stringify({ messages, edges }), key = discussionBranchKey('target', 'reply');
    const result = project(messages, edges, [key]);
    expect(result.groupsByTarget.get('target')).toEqual([
      { key, targetId: 'target', type: 'reply', directCount: 1, hiddenCount: 1, collapsed: true },
      { key: discussionBranchKey('target', 'agree'), targetId: 'target', type: 'agree', directCount: 1, hiddenCount: 0, collapsed: false },
      { key: discussionBranchKey('target', 'disagree'), targetId: 'target', type: 'disagree', directCount: 1, hiddenCount: 0, collapsed: false },
    ]);
    expect([...result.edgeIds]).toEqual(['support-edge', 'opposition-edge']);
    expect(result.messageIds.has('target')).toBe(true); expect(result.messageIds.has('reply-body')).toBe(false);
    expect(result.messageIds.has('support-body')).toBe(true); expect(result.messageIds.has('opposition-body')).toBe(true);
    expect([...result.messageIds].every(id => messages.some(value => value.id === id))).toBe(true);
    expect(JSON.stringify({ messages, edges })).toBe(before);
  });

  it('counts independent relationship records rather than source cards or addressed parts', () => {
    const messages = [message('target'), message('shared-body'), record('one'), record('two')];
    const edges = [edge('one-first-address', 'one', 'shared-body', 'target'), edge('one-second-address', 'one', 'shared-body', 'target'),
      edge('second-record', 'two', 'shared-body', 'target')];
    const key = discussionBranchKey('target', 'reply');
    expect(project(messages, edges).groupsByTarget.get('target')![0]).toMatchObject({ directCount: 2, hiddenCount: 0 });
    expect(project(messages, edges, [key]).groupsByTarget.get('target')![0]).toMatchObject({ directCount: 2, hiddenCount: 2, collapsed: true });
  });

  it('retains a shared source and its child region through another open target while hiding only the folded native edge', () => {
    const messages = ['left', 'right', 'shared-body', 'child-body'].map(id => message(id)).concat([record('shared-record'), record('child-record')]);
    const edges = [edge('left-edge', 'shared-record', 'shared-body', 'left'), edge('right-edge', 'shared-record', 'shared-body', 'right'),
      edge('child-edge', 'child-record', 'child-body', 'shared-body')];
    const result = project(messages, edges, [discussionBranchKey('left', 'reply')]);
    expect(result.messageIds.size).toBe(messages.length);
    expect([...result.edgeIds]).toEqual(['right-edge', 'child-edge']);
    expect(result.groupsByTarget.get('left')![0]).toMatchObject({ directCount: 1, hiddenCount: 1, collapsed: true });
    expect(result.groupsByTarget.get('right')![0]).toMatchObject({ directCount: 1, hiddenCount: 0 });
    expect(result.groupsByTarget.get('shared-body')![0]).toMatchObject({ directCount: 1, hiddenCount: 0 });
  });

  it('keeps parent and nested region entrances when a relationship record is itself the target of a folded discussion', () => {
    const messages = [message('root'), message('reply-body'), record('parent-reply'), record('nested-vote', 'agree')];
    const edges = [edge('parent-edge', 'parent-reply', 'reply-body', 'root'), edge('nested-edge', 'nested-vote', 'anon:nested-vote', 'parent-reply', 'agree')];
    const parentKey = discussionBranchKey('root', 'reply'), nestedKey = discussionBranchKey('parent-reply', 'agree');
    const nested = project(messages, edges, [nestedKey]);
    expect(nested.messageIds.has('parent-reply')).toBe(true); expect(nested.messageIds.has('nested-vote')).toBe(false);
    expect(nested.groupsByTarget.get('root')![0]).toMatchObject({ directCount: 1, hiddenCount: 0, collapsed: false });
    expect(nested.groupsByTarget.get('parent-reply')![0]).toMatchObject({ directCount: 1, hiddenCount: 1, collapsed: true });
    const parent = project(messages, edges, [parentKey, nestedKey]);
    expect([...parent.messageIds]).toEqual(['root']);
    // Headers are built from full descriptors, then scoped by visible targets;
    // an inner folded header returns when its parent path is expanded again.
    expect(parent.groups.filter(group => parent.messageIds.has(group.targetId)).map(group => group.key)).toEqual([parentKey]);
    expect(parent.groupsByTarget.has('parent-reply')).toBe(true);
    const revealed = revealDiscussionBranches({ messages, edges, collapsed: [parentKey, nestedKey], messageIds: ['parent-reply'] });
    expect(revealed).toEqual([nestedKey]);
    expect(project(messages, edges, revealed).groupsByTarget.get('parent-reply')![0].collapsed).toBe(true);
  });

  it('retains a bodyless stance region entrance when it has no source text or visible child card', () => {
    const vote = record('vote', 'agree');
    vote.parts = [];
    vote.executedStance = { partId: 'stance', sourceRevision: 1, side: 'pro', target: { messageId: 'target' } };
    const messages = [message('target'), vote], edges = [edge('vote-edge', 'vote', 'anon:vote', 'target', 'agree')];
    const key = discussionBranchKey('target', 'agree'), folded = project(messages, edges, [key]);
    expect([...folded.messageIds]).toEqual(['target']); expect(folded.edgeIds.size).toBe(0);
    expect(folded.groupsByTarget.get('target')).toEqual([{ key, targetId: 'target', type: 'agree', directCount: 1, hiddenCount: 1, collapsed: true }]);
    const reopened = project(messages, edges);
    expect(reopened.groupsByTarget.get('target')![0].directCount).toBe(1);
    expect(reopened.edgeIds.has('vote-edge')).toBe(true); expect(reopened.messageIds.has('vote')).toBe(true);
    expect(reopened.messageIds.size).toBe(2);
  });

  it('keeps a source reached through another discussion type and folds each region independently', () => {
    const messages = [message('target'), message('shared-body'), record('reply'), record('support', 'agree')];
    const edges = [edge('reply-edge', 'reply', 'shared-body', 'target'), edge('support-edge', 'support', 'shared-body', 'target', 'agree')];
    const replyKey = discussionBranchKey('target', 'reply'), agreeKey = discussionBranchKey('target', 'agree');
    const replyFolded = project(messages, edges, [replyKey]);
    expect(replyFolded.messageIds.has('shared-body')).toBe(true); expect(replyFolded.messageIds.has('reply')).toBe(false);
    expect(replyFolded.messageIds.has('support')).toBe(true);
    const both = project(messages, edges, [replyKey, agreeKey]);
    expect([...both.messageIds]).toEqual(['target']); expect(both.groups).toHaveLength(2);
    expect(both.groups.every(group => group.directCount === 1 && group.hiddenCount === 1 && group.collapsed)).toBe(true);
  });
});
