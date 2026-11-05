import { describe, expect, it } from 'vitest';
import { getZhihuArchiveIdentity, prepareZhihuForViewing, serializeZhihuViewingData } from '../utils/zhihuArchive';

const archive = () => ({ format: 'gonglun-zhihu-archive', version: 1, platform: 'zhihu',
  owner: { id: 'budget-fixture-owner', name: '结构测试账号' },
  items: [{ id: '1', type: 'answer', text: '' }], comments: [],
});
const activity = (scope: 'collections' | 'activities') => ({ version: 1, scope, events: [], folders: [], unparsedRecords: [],
  coverage: { scope, status: 'complete', pagesComplete: true, allHistoryComplete: false, reason: '' } });

describe('bounded authoritative Zhihu document input', () => {
  it.each(['native', 'reviewed'] as const)('ignores over-budget derived rows in a %s envelope and rebuilds them from its bounded evidence', kind => {
    const data = prepareZhihuForViewing(archive());
    const source = kind === 'native' ? data : JSON.parse(serializeZhihuViewingData(data));
    // These represent redundant generated rows, never additional source evidence.
    const input = { ...source, relations: new Array(8_000_001).fill(null) };
    const result = prepareZhihuForViewing(input);
    expect(result.zhihu.archive).toEqual(data.zhihu.archive);
    expect(result.zhihu.overrides).toEqual(data.zhihu.overrides);
    expect(result.zhihu.localOperations).toEqual(data.zhihu.localOperations);
    expect(result.messages).toEqual(data.messages);
    expect(result.relations).toEqual(data.relations);
  });

  it('continues to reject excessive authoritative nodes without confusing them with deep nesting', () => {
    expect(() => prepareZhihuForViewing({ ...archive(), evidence: new Array(8_000_001).fill(null) })).toThrow('超过 8000000 个数据节点');
  });

  it('accepts bounded source metadata above the former node limit without projecting those numbers into messages', () => {
    const evidence = new Array(3_000_000).fill(7);
    const result = prepareZhihuForViewing({ ...archive(), evidence });
    const saved = result.zhihu.archive.evidence as number[];
    // Assert identity without asking the matcher to compare millions of values.
    expect(saved === evidence).toBe(false);
    expect(saved.length).toBe(3_000_000);
    expect(saved[0]).toBe(7);
    expect(saved.at(-1)).toBe(7);
    expect(result.messages.length).toBe(2);
  });

  it.each(['raw', 'native', 'reviewed'] as const)('rejects excessive top-level records before reading %s source payloads', kind => {
    const data = prepareZhihuForViewing(archive());
    const source = { ...archive(), comments: new Array(100_001).fill(null) };
    Object.defineProperty(source, 'evidence', { enumerable: true, get: () => { throw new Error('payload must not be read'); } });
    const input = kind === 'raw' ? source : kind === 'native' ? { ...data, zhihu: { ...data.zhihu, archive: source } }
      : { ...JSON.parse(serializeZhihuViewingData(data)), archive: source };
    expect(() => prepareZhihuForViewing(input)).toThrow('记录过多');
    const excessiveActivity = { ...archive(), activitySource: { ...activity('collections'), events: new Array(100_001).fill(null) } };
    Object.defineProperty(excessiveActivity, 'evidence', { enumerable: true, get: () => { throw new Error('payload must not be read'); } });
    const activityInput = kind === 'raw' ? excessiveActivity : kind === 'native' ? { ...data, zhihu: { ...data.zhihu, archive: excessiveActivity } }
      : { ...JSON.parse(serializeZhihuViewingData(data)), archive: excessiveActivity };
    expect(() => prepareZhihuForViewing(activityInput)).toThrow('来源记录数量无效');
  });

  it('keeps the original depth, character and record-count limits', () => {
    let nested: unknown = null;
    for (let depth = 0; depth < 51; depth++) nested = { next: nested };
    expect(() => prepareZhihuForViewing({ ...archive(), evidence: nested })).toThrow('嵌套过深');
    expect(() => prepareZhihuForViewing({ ...archive(), evidence: 'x'.repeat(100_000_001) })).toThrow('文字量过大');
    expect(() => prepareZhihuForViewing({ ...archive(), comments: new Array(100_001).fill(null) })).toThrow('记录过多');
  });

  it.each(['archive', 'overrides', 'localOperations', 'view'])('still validates unsafe fields inside authoritative %s', field => {
    const reviewed = JSON.parse(serializeZhihuViewingData(prepareZhihuForViewing(archive())));
    reviewed[field] = { ...reviewed[field], evidence: JSON.parse('{"__proto__":{"unsafe":true}}') };
    expect(() => prepareZhihuForViewing(reviewed)).toThrow('不安全字段');
  });

  it('retains source and manual history validation after discarding redundant reviewed relations', () => {
    const reviewed = JSON.parse(serializeZhihuViewingData(prepareZhihuForViewing(archive())));
    reviewed.relations = [{ invalid: true }];
    reviewed.localOperations.operations.push({ id: 'invalid-operation', type: 'FAKE' });
    expect(() => prepareZhihuForViewing(reviewed)).toThrow('本地关系操作类型或版本无效');
    delete reviewed.localOperations;
    expect(() => prepareZhihuForViewing(reviewed)).toThrow('缺少本地操作记录');
  });
});

describe('lightweight archive identity lookup', () => {
  it('derives the same stable identity from each supported envelope and never trusts the supplied archiveId', () => {
    const raw = archive(), data = prepareZhihuForViewing(raw);
    const reviewed = JSON.parse(serializeZhihuViewingData(data));
    expect(getZhihuArchiveIdentity(raw)).toBe(data.zhihu.archiveId);
    expect(getZhihuArchiveIdentity(reviewed)).toBe(data.zhihu.archiveId);
    expect(getZhihuArchiveIdentity({ ...data, zhihu: { ...data.zhihu, archiveId: 'forged-cache-key' } })).toBe(data.zhihu.archiveId);
    const differentOwner = { ...data, zhihu: { ...data.zhihu, archive: { ...raw, owner: { id: 'another-owner' } } } };
    expect(getZhihuArchiveIdentity(differentOwner)).not.toBe(data.zhihu.archiveId);
  });

  it('does not read body text, original observations, local logs, derived rows or view settings to compute identity', () => {
    const data = prepareZhihuForViewing(archive()), source = { ...archive(), items: [{ ...archive().items[0] }] };
    const unexpected = () => { throw new Error('identity must not inspect payload'); };
    Object.defineProperty(source.items[0], 'text', { enumerable: true, get: unexpected });
    Object.defineProperty(source.items[0], 'versions', { enumerable: true, get: unexpected });
    const input = { format: 'gonglun-view-3', zhihu: { archive: source } };
    for (const key of ['messages', 'relations', 'view']) Object.defineProperty(input, key, { enumerable: true, get: unexpected });
    for (const key of ['overrides', 'localOperations', 'byMessageId']) Object.defineProperty(input.zhihu, key, { enumerable: true, get: unexpected });
    expect(getZhihuArchiveIdentity(input)).toBe(data.zhihu.archiveId);
  });

  it('separates owners and collection/activity scopes while remaining stable across observed events', () => {
    const raw = archive(), collections = { ...raw, activitySource: activity('collections') };
    const activities = { ...raw, activitySource: activity('activities') };
    expect(getZhihuArchiveIdentity(collections)).toBe(prepareZhihuForViewing(collections).zhihu.archiveId);
    expect(getZhihuArchiveIdentity(activities)).toBe(prepareZhihuForViewing(activities).zhihu.archiveId);
    expect(new Set([getZhihuArchiveIdentity(raw), getZhihuArchiveIdentity(collections), getZhihuArchiveIdentity(activities)]).size).toBe(3);
    const updated = { ...collections, activitySource: { ...collections.activitySource, events: [{ id: 'new-event' }] } };
    expect(getZhihuArchiveIdentity(updated)).toBe(getZhihuArchiveIdentity(collections));
    expect(getZhihuArchiveIdentity({ ...collections, owner: { id: 'another-owner' } })).not.toBe(getZhihuArchiveIdentity(collections));
  });

  it('preserves the original ownerless and orphan-thread identity rules without examining bodies', () => {
    const raw = { ...archive(), owner: null, items: [...archive().items, { id: '2', type: 'article', text: '' }],
      comments: [{ id: '3', threadId: 'unresolved:thread', text: '' }] };
    const identity = prepareZhihuForViewing(raw).zhihu.archiveId;
    expect(getZhihuArchiveIdentity(raw)).toBe(identity);
    expect(getZhihuArchiveIdentity({ ...raw, items: [...raw.items].reverse() })).toBe(identity);
    expect(getZhihuArchiveIdentity({ ...raw, comments: [] })).not.toBe(identity);
  });

  it.each(['url-only-fixture', 'a'.repeat(8200)])('keeps URL-only owner identity consistent with accepted source files: %#', token => {
    const raw = { ...archive(), owner: { url: `https://www.zhihu.com/people/${token}` } };
    expect(getZhihuArchiveIdentity(raw)).toBe(prepareZhihuForViewing(raw).zhihu.archiveId);
  });

  it.each([
    null,
    { format: 'gonglun-view-3', zhihu: { archiveId: 'forged-cache-key' } },
    { format: 'gonglun-zhihu-reviewed', version: 99, archive: archive() },
    { ...archive(), platform: 'another-platform' },
    { ...archive(), owner: { id: 123 } },
    { ...archive(), items: [{ id: '1', type: 'unsupported' }] },
    { ...archive(), comments: [{ threadId: 123 }] },
    { ...archive(), activitySource: { ...activity('collections'), scope: 'unsupported' } },
    { ...archive(), comments: new Array(100_001).fill(null) },
  ])('rejects invalid identity formats or unbounded record collections: %#', input => {
    expect(() => getZhihuArchiveIdentity(input)).toThrow();
  });
});
