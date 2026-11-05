import { expect, it, vi } from 'vitest';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';
import { getZhihuCorrectableFields, getZhihuDisplayFields, getZhihuMissingContent } from '../utils/zhihuCorrections';

// Empty protocol fixtures measure lookup work, not invented discussion content.
function fixture(count: number) {
  return prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '', completeness: { body: 'complete' } }],
    comments: Array.from({ length: count }, (_, index) => ({ id: String(index + 1), sourceId: String(index + 1),
      threadId: 'answer:10', text: '', rootCommentId: String(index + 1), parentCommentId: null })),
  });
}
const commentId = (number: string) => `zhihu:comment:answer%3A10:${number}`;

it('checks missing fields with bounded linear record access and no full-array find for each row', () => {
  const measure = (count: number) => {
    const data = fixture(count);
    let reads = 0;
    for (const message of data.messages) {
      const id = message.id;
      Object.defineProperty(message, 'id', { configurable: true, get: () => { reads++; return id; } });
    }
    for (const comment of data.zhihu.archive.comments) {
      const sourceId = comment.sourceId;
      Object.defineProperty(comment, 'sourceId', { configurable: true, get: () => { reads++; return sourceId; } });
    }
    const findSpies = [data.messages, data.zhihu.archive.comments, data.zhihu.archive.items, data.zhihu.localOperations.messages]
      .map(array => vi.spyOn(array, 'find'));
    const missing = getZhihuMissingContent(data);
    expect(missing).toHaveLength(count);
    expect(missing.every(field => field.originalStatus === 'unknown')).toBe(true);
    const firstReads = reads;
    expect(firstReads).toBeLessThanOrEqual(data.messages.length * 4 + count * 2);
    // A subsequent display or correction lookup must not scan either large array.
    reads = 0;
    for (let index = 1; index <= count; index++) {
      expect(getZhihuCorrectableFields(data, commentId(String(index)))[0]?.originalStatus).toBe('unknown');
    }
    expect(reads).toBeLessThanOrEqual(count);
    for (const spy of findSpies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
    return firstReads;
  };
  const small = measure(80), large = measure(160);
  expect(large).toBeLessThanOrEqual(small * 2 + 10);
});

it('does not inspect source fields of non-correctable reply and navigation records', () => {
  const data = fixture(3);
  const excluded = data.messages.filter(message => !['item', 'comment', 'question', 'local-text', 'local-organization'].includes(data.zhihu.byMessageId[message.id]?.kind));
  expect(excluded.length).toBeGreaterThan(0);
  for (const message of excluded) {
    Object.defineProperty(message, 'content', { configurable: true, get: () => { throw new Error('non-correctable body read'); } });
    expect(getZhihuCorrectableFields(data, message.id)).toEqual([]);
  }
  expect(getZhihuMissingContent(data)).toHaveLength(3);
});

it('keeps same-number comments and works from different threads separate', () => {
  const data = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '', completeness: { body: 'complete' } },
      { id: '10', type: 'article', text: '', completeness: { body: 'partial' } }],
    comments: [{ id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null, completeness: { body: 'complete' } },
      { id: '1', sourceId: '1', threadId: 'article:10', text: '', rootCommentId: '1', parentCommentId: null, completeness: { body: 'partial' } }],
  });
  expect(getZhihuMissingContent(data).map(entry => entry.messageId)).toEqual(['zhihu:item:article:10', 'zhihu:comment:article%3A10:1']);
  expect(getZhihuCorrectableFields(data, 'zhihu:item:answer:10')[0].originalStatus).toBe('complete');
  // Older callers may address an item by raw thread ID, retaining the old source-ID fallback.
  data.zhihu.byMessageId['zhihu:item:answer:10'].threadId = '10';
  expect(getZhihuCorrectableFields(data, 'zhihu:item:answer:10')[0].originalStatus).toBe('complete');
});

it('refreshes indexes during append, source-array replacement and suppression replay without caching local text', () => {
  const data = fixture(1), first = commentId('1'), second = commentId('2');
  expect(getZhihuMissingContent(data)).toHaveLength(1);
  const message = data.messages.find(candidate => candidate.id === first)!;
  data.messages.push({ ...message, id: second });
  data.zhihu.archive.comments.push({ ...data.zhihu.archive.comments[0], id: '2', sourceId: '2' });
  data.zhihu.byMessageId[second] = { ...data.zhihu.byMessageId[first], sourceId: '2' };
  expect(getZhihuMissingContent(data)).toHaveLength(2);
  data.zhihu.archive.comments = data.zhihu.archive.comments.map(comment => ({ ...comment, completeness: { body: 'complete' } }));
  expect(getZhihuMissingContent(data)).toEqual([]);
  data.zhihu.byMessageId[first].localCorrections = { body: { id: 'local-correction', content: 'X' } };
  expect(getZhihuDisplayFields(data, first)).toMatchObject({ body: 'X', bodyCorrectionId: 'local-correction' });
  data.zhihu.inactiveRelationIds.push(first);
  expect(getZhihuCorrectableFields(data, first)).toEqual([]);
  data.zhihu.inactiveRelationIds = [];
  expect(getZhihuCorrectableFields(data, first)[0].value).toBe('X');
  const replacement = { ...message, content: 'Y' };
  delete data.zhihu.byMessageId[first].localCorrections;
  data.messages = data.messages.map(candidate => candidate.id === first ? replacement : candidate);
  expect(getZhihuDisplayFields(data, first).body).toBe('Y');
});
