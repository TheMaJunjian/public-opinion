import { expect, it } from 'vitest';
import { focusComparisonDifference } from '../pages/workbench/projections/comparisonFocus';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const message = (id: string, relationType?: DemoEdge['relationType']): DemoMessage => ({ id, author: 'tester', createdAt: '',
  content: id, kind: relationType ? 'relation' : 'normal', relationType });
const edge = (id: string, type: DemoEdge['relationType'], from: string, to: string): DemoEdge => ({ id: `${id}:${from}:${to}`,
  relationMessageId: id, relationType: type, relationLabel: type, from: { messageId: from, selection: { kind: 'whole' } }, to: { messageId: to, selection: { kind: 'whole' } } });
const member = (owner: string, id: string) => edge(owner, 'classify', `anon:${owner}`, id);
const ids = (side: { messages: DemoMessage[] }) => side.messages.map(message => message.id);

it('keeps both membership paths and one shared ancestor without unrelated siblings', () => {
  const messages = [message('root', 'classify'), message('old', 'classify'), message('new', 'classify'), message('other', 'classify'),
    message('focused'), message('sibling'), message('unrelated')];
  const common = [member('root', 'old'), member('root', 'new'), member('old', 'sibling'), member('other', 'unrelated')];
  const pair = { agree: { messages, edges: [...common, member('new', 'focused')] }, disagree: { messages, edges: [...common, member('old', 'focused')] } };
  const before = JSON.stringify(pair), focused = focusComparisonDifference(pair, 'focused');
  for (const side of [focused.agree, focused.disagree]) {
    expect(ids(side)).toEqual(['root', 'old', 'new', 'focused']);
    expect(side.edges.map(edge => edge.to.messageId)).toEqual(['old', 'new', 'focused']);
    for (const item of side.messages) expect(item).toBe(messages.find(message => message.id === item.id));
  }
  expect(focused.agree.edges.at(-1)?.relationMessageId).toBe('new');
  expect(focused.disagree.edges.at(-1)?.relationMessageId).toBe('old');
  expect(JSON.stringify(pair)).toBe(before);
});

it('keeps a selected relationship and its anchors on both sides without restoring its inactive edge', () => {
  const connection = { ...message('connection', 'annotation'), sourceMessageId: 'source', targetRefs: [{ kind: 'message' as const, messageId: 'target' }] };
  const messages = [message('frame', 'classify'), message('source'), message('target'), message('unrelated'), connection];
  const common = [member('frame', 'source')];
  const focused = focusComparisonDifference({ agree: { messages, edges: [...common, edge('connection', 'annotation', 'source', 'target')] },
    disagree: { messages: messages.filter(message => message.id !== 'connection'), edges: common } }, 'connection', ['source']);
  expect(ids(focused.agree)).toEqual(['frame', 'source', 'target', 'connection']);
  expect(ids(focused.disagree)).toEqual(['frame', 'source', 'target']);
  expect(focused.disagree.edges.some(edge => edge.relationMessageId === 'connection')).toBe(false);
});

it('retains attached decorations but does not pull unrelated reply source messages into view', () => {
  const messages = [message('target'), message('unrelated'), message('vote', 'agree'), message('reply', 'reply')];
  const side = { messages, edges: [edge('vote', 'agree', 'anon:vote', 'target'), edge('reply', 'reply', 'unrelated', 'target')] };
  const result = focusComparisonDifference({ agree: side, disagree: side }, 'target');
  expect(ids(result.agree)).toEqual(['target', 'vote']);
  expect(result.agree.edges.map(edge => edge.relationMessageId)).toEqual(['vote']);
});

it('keeps changed members of a disappearing category without inventing its missing counterpart', () => {
  const category = message('category', 'classify'), first = message('first'), second = message('second');
  const result = focusComparisonDifference({ agree: { messages: [category, first, second], edges: [member('category', 'first'), member('category', 'second')] },
    disagree: { messages: [first, second], edges: [] } }, 'category', ['first']);
  expect(ids(result.agree)).toEqual(['category', 'first', 'second']);
  expect(ids(result.disagree)).toEqual(['first', 'second']);
});

it('shows a changed child in its old and new frames while hiding unchanged children', () => {
  const messages=[message('reviewed','classify'),message('old','classify'),message('moved','classify'),message('unchanged'),message('unrelated')];
  const common=[member('old','unchanged')];
  const pair={agree:{messages,edges:[...common,member('reviewed','moved')]},disagree:{messages,edges:[...common,member('old','moved')]}};
  const result=focusComparisonDifference(pair,'old');
  for(const side of [result.agree,result.disagree])expect(ids(side)).toEqual(['reviewed','old','moved']);
  expect(result.agree.edges).toEqual([member('reviewed','moved')]);
  expect(result.disagree.edges).toEqual([member('old','moved')]);
});

it('terminates on cyclic ancestry and does not repeat frames', () => {
  const side = { messages: [message('a', 'classify'), message('b', 'classify'), message('target')],
    edges: [member('a', 'b'), member('b', 'a'), member('b', 'target')] };
  expect(ids(focusComparisonDifference({ agree: side, disagree: side }, 'target').agree)).toEqual(['a', 'b', 'target']);
});
