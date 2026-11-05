import { describe, expect, it } from 'vitest';
import { computeDiscussionRegionTextStats } from '../utils/discussionRegionStats';
import type { DemoMessage } from '../utils/modelBridge';

const body = (id: string, changes: Partial<DemoMessage> = {}): DemoMessage => ({
  id, kind: 'normal', content: '', author: '', createdAt: '', parts: [{ id: 'body', type: 'text', text: 'x' }], ...changes,
});
const regions = [{ key: 'support', type: 'agree' }, { key: 'opposition', type: 'disagree' }, { key: 'replies', type: 'reply' }] as const;

describe('discussion region body statistics', () => {
  it('counts one support body and its nested opposition body without counting pure stance records', () => {
    const input = { messages: [body('support-body'), body('opposition-body'),
      body('vote-1', { kind: 'relation', relationType: 'agree', parts: [], content: '目标：support-body' }),
      body('vote-2', { kind: 'relation', relationType: 'disagree', parts: [], content: '目标：opposition-body' })],
      parents: { 'opposition-body': 'support-body', 'vote-1': 'support-body', 'vote-2': 'opposition-body' },
      ownerRegions: { 'support-body': 'support', 'opposition-body': 'opposition' }, regions };
    const before = JSON.stringify(input), counts = computeDiscussionRegionTextStats(input);
    expect(counts.get('support')).toEqual({ total: 2, agree: 1, disagree: 1, reply: 0 });
    expect(counts.get('opposition')).toEqual({ total: 1, agree: 0, disagree: 1, reply: 0 });
    expect(counts.get('replies')).toEqual({ total: 0, agree: 0, disagree: 0, reply: 0 });
    expect(computeDiscussionRegionTextStats({ ...input, regions: regions.map(region => ({ ...region, collapsed: true })) })).toEqual(counts);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('uses nonempty text parts, permits only real legacy body kinds, and counts multiple parts once', () => {
    const messages = [body('parts'), body('multiple', { parts: [{ id: 'a', type: 'text', text: 'x' }, { id: 'b', type: 'text', text: 'y' }] }),
      body('empty-parts', { parts: [], content: 'x' }), body('blank', { parts: [{ id: 'body', type: 'text', text: ' \n\t' }] }),
      body('code-part', { parts: [{ id: 'code', type: 'code', language: 'text', source: 'x' }] }),
      body('legacy-normal', { parts: undefined, content: 'x' }), body('legacy-code', { kind: 'code', parts: undefined, content: 'x' }),
      body('legacy-relation', { kind: 'relation', relationType: 'reply', parts: undefined, content: '目标：x' }),
      body('legacy-join', { kind: 'join', parts: undefined, content: 'x' }), body('legacy-round', { kind: 'round', parts: undefined, content: 'x' })];
    const counts = computeDiscussionRegionTextStats({ messages, parents: {}, ownerRegions: Object.fromEntries(messages.map(message => [message.id, 'support'])), regions });
    expect(counts.get('support')).toEqual({ total: 4, agree: 4, reply: 0, disagree: 0 });
  });

  it('does not count frame headers but lets their members inherit the outer type until overridden', () => {
    const counts = computeDiscussionRegionTextStats({ messages: [body('frame', { kind: 'relation', relationType: 'arrange' }), body('member'), body('reply')],
      parents: { member: 'frame', reply: 'member' }, ownerRegions: { frame: 'opposition', reply: 'replies' }, regions, frameIds: new Set(['frame']) });
    expect(counts.get('opposition')).toEqual({ total: 2, agree: 0, reply: 1, disagree: 1 });
    expect(counts.get('replies')).toEqual({ total: 1, agree: 0, reply: 1, disagree: 0 });
  });

  it('counts a shared message once in its primary owner and does not double count repeated ancestor membership', () => {
    const child = body('shared');
    const counts = computeDiscussionRegionTextStats({ messages: [body('parent'), child, child, body('grandchild')],
      parents: { shared: 'parent', grandchild: 'shared' }, ownerRegions: { parent: 'support', shared: 'opposition', grandchild: 'support' }, regions });
    expect(counts.get('support')).toEqual({ total: 3, agree: 2, reply: 0, disagree: 1 });
    expect(counts.get('opposition')).toEqual({ total: 2, agree: 1, reply: 0, disagree: 1 });
  });

  it('traverses missing wrapper nodes and breaks parent cycles without duplicating source bodies', () => {
    const counts = computeDiscussionRegionTextStats({ messages: [body('a'), body('b'), body('c')],
      parents: { a: 'b', b: 'a', c: 'wrapper' }, ownerRegions: { a: 'support', wrapper: 'replies' }, regions });
    expect(counts.get('support')).toEqual({ total: 2, agree: 2, reply: 0, disagree: 0 });
    expect(counts.get('replies')).toEqual({ total: 1, agree: 0, reply: 1, disagree: 0 });
  });

  it('reads body parts once per unique message in a deep forest with a region at every level', () => {
    const length = 5000, messages: DemoMessage[] = [], parents: Record<string, string> = {}, ownerRegions: Record<string, string> = {};
    const nestedRegions: { key: string; type: 'reply' }[] = [];
    let reads = 0;
    for (let index = 0; index < length; index++) {
      const id = String(index), part = { id: 'body', type: 'text' as const, get text() { reads++; return 'x'; } };
      messages.push(body(id, { parts: [part] }));
      if (index) parents[id] = String(index - 1);
      ownerRegions[id] = id; nestedRegions.push({ key: id, type: 'reply' });
    }
    const counts = computeDiscussionRegionTextStats({ messages, parents, ownerRegions, regions: nestedRegions });
    expect(reads).toBe(length);
    expect(counts.get('0')).toEqual({ total: length, agree: 0, reply: length, disagree: 0 });
    expect(counts.get(String(length - 1))).toEqual({ total: 1, agree: 0, reply: 1, disagree: 0 });
  });
});
