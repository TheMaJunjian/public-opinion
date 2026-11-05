import { expect, it } from 'vitest';
import type { Message, Relation } from '../types';
import { convertMessagesToDemoModel } from '../utils/modelBridge';
import { comparisonViewMessageIds, hasComparisonDisplayEffect } from '../pages/workbench/projections/comparisonViewScope';

const user = { id: 'reader', username: 'reader', createdAt: '' };
const text = (id: string): Message => ({ id, kind: 'TEXT', contentType: 'TEXT', content: id, createdAt: '', createdBy: user });
const relation = (id: string, type: string, targets: string[], sourceMessageId: string | null = null): Relation => ({
  id, relationType: type, sourceMessageId, targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
  createdAt: '', createdBy: user, payload: { targetLayout: 'single-row' },
});

function fixture() {
  const catalog = convertMessagesToDemoModel(['one', 'two', 'hidden'].map(text), [
    relation('frame', 'MERGE', ['one', 'two']),
    relation('visible-reference', 'REFERENCE', ['two'], 'one'),
    relation('hidden-reference', 'REFERENCE', ['hidden'], 'hidden'),
  ]);
  return { ...catalog, messages: catalog.messages.filter(message => message.id !== 'hidden'),
    catalogMessages: catalog.messages, catalogEdges: catalog.edges,
    isTraceWindow: false, traceExpandedFrameIds: new Set<string>() };
}

it.each(['graph', 'list'] as const)('captures %s labels and frames without records anchored outside the view', viewMode => {
  const ids = comparisonViewMessageIds({ ...fixture(), viewMode });
  expect(ids).toEqual(new Set(['one', 'two', 'frame', 'visible-reference']));
});

it('keeps the graph trace boundary instead of adding loaded messages outside it', () => {
  const input = fixture();
  const ids = comparisonViewMessageIds({ ...input, viewMode: 'graph', isTraceWindow: true,
    messages: input.messages.filter(message => message.id === 'two'), edges: [] });
  expect(ids).toEqual(new Set(['two']));
});

it('does not capture a connection after a filtered graph anchor is hidden', () => {
  const ids = comparisonViewMessageIds({ ...fixture(), viewMode: 'graph', hiddenMessageIds: new Set(['one']) });
  expect(ids.has('visible-reference')).toBe(false);
  expect(ids.has('two')).toBe(true);
});

it.each(['graph', 'list'] as const)('includes JOIN records for the %s view and its header without entering hidden categories', viewMode => {
  const catalog = convertMessagesToDemoModel(['one', 'hidden'].map(text), [
    relation('category', 'CLASSIFY', []), relation('nested', 'CLASSIFY', []), relation('elsewhere', 'CLASSIFY', []),
    relation('in-header', 'JOIN', ['one'], 'category'), relation('in-card', 'JOIN', ['hidden'], 'nested'),
    relation('former', 'JOIN', ['one'], 'elsewhere'), relation('outside', 'JOIN', ['hidden'], 'elsewhere'),
  ]);
  const ids = comparisonViewMessageIds({ ...catalog, catalogMessages: catalog.messages, catalogEdges: catalog.edges,
    messages: catalog.messages.filter(message => ['one', 'nested'].includes(message.id)),
    scopeId: 'category', viewMode, isTraceWindow: false, traceExpandedFrameIds: new Set() });
  expect(ids).toEqual(new Set(['one', 'nested', 'category', 'in-header', 'former']));
});

it.each(['JOIN', 'CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE', 'CORRECT', 'ANNOTATION', 'REFERENCE', 'REPLY', 'NOTIFY',
  'TAG', 'RECOMMEND', 'ARCHIVE', 'ATTENTION', 'BLOCK'])('allows the stance-controlled display of %s to be compared', type => {
  const records = convertMessagesToDemoModel([text('target')], [relation('candidate', type, ['target'])]);
  expect(hasComparisonDisplayEffect(records.messages.find(message => message.id === 'candidate')!)).toBe(true);
});

it.each(['DELEGATION', 'PROPOSAL', 'CODE_CHANGE', 'OPERATIONS', 'AUTHORIZE', 'AGREE', 'DISAGREE', 'READ', 'UNREAD'])(
  'excludes %s whose voting does not change its display effect', type => {
  const records = convertMessagesToDemoModel([text('target')], [relation('candidate', type, ['target'])]);
  expect(hasComparisonDisplayEffect(records.messages.find(message => message.id === 'candidate')!)).toBe(false);
});

it('excludes text bodies and amendments that need authorization instead of stance adoption', () => {
  const records = convertMessagesToDemoModel([text('text')], [{ ...relation('amendment', 'CORRECT', ['text']),
    parts: [{ id: 'proposal', type: 'relation', relation: 'amend', roles: { target: [{ id: 't', reference: { messageId: 'text' } }] } }] }]);
  expect(hasComparisonDisplayEffect(records.messages.find(message => message.id === 'text')!)).toBe(false);
  expect(hasComparisonDisplayEffect(records.messages.find(message => message.id === 'amendment')!)).toBe(false);
});
