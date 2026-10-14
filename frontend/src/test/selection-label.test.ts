import { describe, expect, it } from 'vitest';
import { describeUnit } from '../utils/selectionLabel';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';

const message: DemoMessage = { id: 'private-message-id', revision: 3, author: '甲', createdAt: '', content: '图书馆开放时间', kind: 'normal', parts: [{ id: 'body-uuid', type: 'text', text: '图书馆开放时间' }] };

describe('human-readable selection labels', () => {
  it('shows the selected words and keeps the exact reference unchanged', () => {
    const unit: UnitSelection = { messageId: message.id, selection: { kind: 'text', start: 0, len: 3, text: '图书馆' }, reference: { messageId: message.id, revision: 3, partId: 'body-uuid', range: { start: 0, end: 3 } } };
    const before = structuredClone(unit);
    expect(describeUnit(unit, message)).toBe('正文片段「图书馆」');
    expect(unit).toEqual(before);
  });

  it('names a visible relationship selection without exposing technical IDs or paths', () => {
    expect(describeUnit({ messageId: message.id, label: '赞同', selection: { kind: 'whole' }, reference: { messageId: message.id, partId: 'relation-uuid' } }, message)).toBe('赞同');
    expect(describeUnit({ messageId: message.id, selection: { kind: 'whole' }, reference: { messageId: message.id, partId: 'relation-uuid', path: ['roles', 'members'] } }, message)).toBe('所含消息');
  });

  it('does not present current text as the content of a historical selection', () => {
    expect(describeUnit({ messageId: message.id, selection: { kind: 'whole' }, reference: { messageId: message.id, revision: 1, partId: 'body-uuid' } }, message)).toBe('历史正文');
  });
});
