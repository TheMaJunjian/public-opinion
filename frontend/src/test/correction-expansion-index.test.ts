import { describe, expect, it } from 'vitest';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { expandTextIdsWithCorrections } from '../pages/workbench/model/correction';

const message = (id: string, extra: Partial<DemoMessage> = {}): DemoMessage => ({ id, kind: 'normal', author: 'structure-fixture', createdAt: '', content: '', ...extra });
const edge = (id: string, from: string, to: string, extra: Partial<DemoEdge> = {}): DemoEdge => ({ id, relationMessageId: id, relationType: 'correct', relationLabel: 'correct',
  from: { messageId: from, selection: { kind: 'whole' } }, to: { messageId: to, selection: { kind: 'whole' } }, ...extra });
const messages = (...values: DemoMessage[]) => new Map(values.map(value => [value.id, value]));

describe('indexed legacy correction expansion', () => {
  it('keeps an empty selection empty without scanning unrelated relations', () => {
    const unrelated = edge('unused', 'a', 'b');
    Object.defineProperty(unrelated, 'relationType', { get: () => { throw new Error('empty selections must not scan edges'); } });
    expect(expandTextIdsWithCorrections(new Set(), [unrelated], new Map())).toEqual(new Set());
  });

  it('retains bidirectional transitive closure and seed/edge order across cycles and duplicate edges', () => {
    const seeds = new Set(['a', 'd']), map = messages(...['a', 'b', 'c', 'd', 'e', 'unrelated'].map(id => message(id)));
    const edges = [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('de', 'd', 'e'), edge('cb', 'c', 'b'), edge('repeat-ab', 'a', 'b'), edge('aa', 'a', 'a')];
    expect([...expandTextIdsWithCorrections(seeds, edges, map)]).toEqual(['a', 'd', 'b', 'c', 'e']);
    expect([...expandTextIdsWithCorrections(new Set(['b']), edges, map)]).toEqual(['b', 'a', 'c']);
    expect([...seeds]).toEqual(['a', 'd']);
  });

  it('excludes canonical part records, width adjustments, proposals and non-normal endpoints', () => {
    const names = ['start', 'canonical-target', 'width-target', 'proposal-target', 'reply-target', 'code-target', 'relation-target'];
    const map = messages(...names.map(id => message(id)),
      message('canonical', { kind: 'relation', parts: [{ id: 'body', type: 'text', text: '' }] }),
      message('width', { kind: 'relation', relationPayload: { correctionKind: 'WIDTH', correctionWidth: 480 } }),
      message('code-target', { kind: 'code' }), message('relation-target', { kind: 'relation' }));
    const edges = [edge('canonical', 'start', 'canonical-target'), edge('width', 'start', 'width-target'),
      edge('proposal', 'start', 'proposal-target', { proposalOnly: true }), edge('reply', 'start', 'reply-target', { relationType: 'reply' }),
      edge('code', 'start', 'code-target'), edge('relation', 'start', 'relation-target'), edge('missing', 'start', 'missing-target')];
    expect([...expandTextIdsWithCorrections(new Set(['start']), edges, map)]).toEqual(['start']);
  });

  it('retains legacy records with absent or empty parts while leaving unrelated components outside the closure', () => {
    const map = messages(...['start', 'next', 'end', 'other', 'last'].map(id => message(id)), message('empty', { kind: 'relation', parts: [] }));
    const edges = [edge('missing-record', 'start', 'next'), edge('empty', 'next', 'end'), edge('separate', 'other', 'last')];
    expect([...expandTextIdsWithCorrections(new Set(['end']), edges, map)]).toEqual(['end', 'next', 'start']);
  });

  it('reads unrelated edges once even when every displayed record is already classified', () => {
    const count = 1500, records = Array.from({ length: count }, (_, index) => message(`node-${index}`));
    let typeReads = 0;
    const edges = records.map((record, index) => {
      const value = edge(`relation-${index}`, record.id, records[(index + 1) % count].id, { relationType: 'reply' });
      Object.defineProperty(value, 'relationType', { get: () => { typeReads++; return 'reply'; } });
      return value;
    });
    const seeds = new Set(records.map(record => record.id)), result = expandTextIdsWithCorrections(seeds, edges, messages(...records));
    expect(typeReads).toBe(count);
    expect(result).not.toBe(seeds);
    expect([...result]).toEqual([...seeds]);
  });
});
