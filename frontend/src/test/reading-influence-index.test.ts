import { describe, expect, it } from 'vitest';
import { bodyVersion, bodyVersionKey, messageReadingKey, type ReadingMark, type ReferenceContext } from '@gonglun/core';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { deriveReadingProgress, readingInfluences, readingSelection, type ReadingInput } from '../pages/workbench/model/readingProgress';

const message = (id: string): DemoMessage => ({ id, kind: 'normal', author: 'structure-fixture', createdAt: '', content: '', revision: 1 });
const context = (id: string, revision: number): ReferenceContext => ({ kind: 'BODY', version: bodyVersion(id, revision) });
const endpoint = (id: string, value?: ReferenceContext): DemoEdge['from'] => ({ messageId: id, selection: { kind: 'whole' },
  ...(value ? { reference: { messageId: id, context: value } } : {}) });
const edge = (id: string, event: string, from: DemoEdge['from'], to: DemoEdge['to'], type: DemoEdge['relationType'] = 'reference'): DemoEdge => ({
  id, relationMessageId: event, relationType: type, from, to, relationLabel: type,
});
const input = (messages: DemoMessage[], edges: DemoEdge[]): ReadingInput => ({ messages, edges, relations: [],
  corrections: new Map(), username: 'reader-fixture', readStatus: new Map(), memberships: [], effectiveJoinIds: new Set(), suppressedIds: new Set() });

describe('indexed native reading influence endpoints', () => {
  it('preserves the first source or target context when a multi-target event addresses the same message again', () => {
    const firstA = context('a', 1), firstB = context('b', 1);
    const source = input([message('a'), message('b'), { ...message('reference'), kind: 'relation', relationType: 'reference', sequence: 12 }], [
      edge('one', 'reference', endpoint('a', firstA), endpoint('b', firstB)),
      edge('two', 'reference', endpoint('b', context('b', 2)), endpoint('a', context('a', 2))),
    ]);
    const influences = readingInfluences(source);
    for (const [id, expected] of [['a', firstA], ['b', firstB]] as const) {
      expect(influences.get(id)?.length).toBeGreaterThan(0);
      for (const item of influences.get(id)!) {
        expect(item.context).toEqual(expected);
        expect(JSON.parse(item.eventId!)).toEqual(['reference', 1, 12]);
      }
    }
  });

  it('does not replace an earlier endpoint without context with a later contextual endpoint', () => {
    const source = input([message('a'), message('b'), { ...message('reference'), kind: 'relation', relationType: 'reference' }], [
      edge('one', 'reference', endpoint('a'), endpoint('b')),
      edge('two', 'reference', endpoint('a', context('a', 2)), endpoint('b', context('b', 2))),
    ]);
    const influences = readingInfluences(source);
    for (const id of ['a', 'b']) for (const item of influences.get(id)!) expect(item.context).toBeUndefined();
  });

  it('reads large classification endpoints a bounded number of times per edge', () => {
    const count = 1200, members = Array.from({ length: count }, (_, index) => message(`member-${index}`));
    let endpointReads = 0;
    const edges = members.map((member, index) => {
      const from = endpoint('anon:classification'), to = endpoint(member.id);
      const result = edge(`edge-${index}`, 'classification', from, to, 'classify');
      Object.defineProperties(result, { from: { get: () => { endpointReads++; return from; } }, to: { get: () => { endpointReads++; return to; } } });
      return result;
    });
    const source = input([...members, { ...message('classification'), kind: 'relation', relationType: 'classify' }], edges);
    const influences = readingInfluences(source);
    expect(endpointReads).toBeLessThanOrEqual(count * 20);
    expect(influences.size).toBe(count);
    for (const member of members) expect(influences.get(member.id)).toEqual([expect.objectContaining({
      messageId: 'classification', type: 'classify', resultKey: 'effective', acknowledgementMessageId: 'classification',
    })]);
  });

  it('reuses each message in a full saved-reading pass instead of searching the complete list again', () => {
    const count = 1200;
    let idReads = 0;
    const messages = Array.from({ length: count }, (_, index) => {
      const id = `member-${index}`, value = message(id);
      Object.defineProperty(value, 'id', { get: () => { idReads++; return id; } });
      return value;
    });
    const source = input(messages, []);
    source.marks = messages.map((item): ReadingMark => ({ format: 3, messageId: item.id, scope: 'message',
      key: messageReadingKey(item.id), state: 'READ', version: bodyVersion(item.id, 1), selection: readingSelection(source, item.id) }));
    idReads = 0;
    const progress = deriveReadingProgress(source);
    expect(idReads).toBeLessThanOrEqual(count * 40);
    expect(progress.pendingBodies.size).toBe(0);
    expect(progress.selectionChanges.size).toBe(0);
    expect(source.marks[0].selection?.versionKey).toBe(bodyVersionKey(bodyVersion('member-0', 1)));
  });
});
