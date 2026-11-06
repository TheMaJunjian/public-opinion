import { expect, it } from 'vitest';
import { bodyVersion, messageReadingKey, type ReadingMark } from '@gonglun/core';
import { deriveReadingProgress, type ReadingInput } from '../pages/workbench/model/readingProgress';
import { deriveReadingPresentation, groupedReadingPresentation } from '../pages/workbench/model/readingPresentation';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const message = (id: string): DemoMessage => ({ id, kind: 'normal', content: id, author: 'other', createdAt: '' });
const read = (id: string): ReadingMark => ({ format: 3, messageId: id, scope: 'message', key: messageReadingKey(id),
  bodySignature: messageReadingKey(id), signature: 'display:test', version: bodyVersion(id), state: 'READ' });
function fixture() {
  const edges: DemoEdge[] = [['reply', 'pending', 'context'], ['earlier', 'context', 'unrelated']].map(([id, from, to]) => ({
    id, relationMessageId: id, relationType: 'reply', relationLabel: '回复', from: { messageId: from, selection: { kind: 'whole' } },
    to: { messageId: to, selection: { kind: 'whole' } },
  }));
  const input: ReadingInput = { messages: ['pending', 'context', 'unrelated', 'isolated'].map(message).concat(
    edges.map(edge => ({ ...message(edge.id), author: 'me', kind: 'relation', relationType: 'reply' }))),
  edges, relations: [], username: 'me', readStatus: new Map(), marks: ['context', 'unrelated', 'isolated'].map(read) };
  return input;
}

it.each([false, true])('dims directly related read context in both directions and hides unrelated read branches (reverse: %s)', reverse => {
  const input = fixture();
  if (reverse) input.edges = input.edges.map(edge => ({ ...edge, from: edge.to, to: edge.from }));
  const result = deriveReadingPresentation(input, deriveReadingProgress(input));
  expect(result.get('context')).toBe('dimmed');
  expect(result.get('reply')).toBe('dimmed');
  expect(result.get('isolated')).toBe('hidden');
  expect(result.get('unrelated')).toBe('hidden');
  expect(result.has('pending')).toBe(false);
  input.marks!.push(read('pending'));
  expect([...deriveReadingPresentation(input, deriveReadingProgress(input)).values()].every(value => value === 'hidden')).toBe(true);
});

it('keeps a read body normal while it has an unconfirmed influence', () => {
  const input = fixture();
  input.messages.find(message => message.id === 'reply')!.author = 'other';
  input.marks!.push(read('reply'));
  const progress = deriveReadingProgress(input);
  expect(progress.pendingBodies.has('context')).toBe(false);
  expect(progress.pendingInfluences.has('context')).toBe(true);
  expect(deriveReadingPresentation(input, progress).has('context')).toBe(false);
});

it('preserves unread container members and dims read members linked through their container', () => {
  const input = fixture();
  input.edges = [];
  input.memberships = [{ containerId: 'context', targetIds: ['pending', 'unrelated'] }];
  const result = deriveReadingPresentation(input, deriveReadingProgress(input));
  expect(result.has('context')).toBe(false);
  expect(result.has('pending')).toBe(false);
  expect(result.get('unrelated')).toBe('dimmed');
  expect(result.get('isolated')).toBe('hidden');
});

it('restores visibility when a message is marked unread again and never hides a mixed unread badge', () => {
  const input = fixture();
  input.marks!.push({ ...read('isolated'), state: 'UNREAD', position: 1 });
  const result = deriveReadingPresentation(input, deriveReadingProgress(input));
  expect(result.has('isolated')).toBe(false);
  expect(groupedReadingPresentation(['pending', 'context'], result)).toBeUndefined();
  expect(groupedReadingPresentation(['context', 'unrelated'], result)).toBe('dimmed');
  expect(groupedReadingPresentation(['unrelated', 'earlier'], result)).toBe('hidden');
});
