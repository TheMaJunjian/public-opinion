import { afterEach, describe, expect, it, vi } from 'vitest';
import { createZhihuReadingLinks } from '../utils/zhihuReadingLinks';
import { prepareZhihuForViewing, sendZhihuLocalRelation, type ZhihuViewingData } from '../utils/zhihuArchive';

// Structural fixtures only: empty bodies and synthetic link labels, no real data.
const itemId = 'zhihu:item:answer:1';
const commentId = 'zhihu:comment:answer%3A1:9';
const questionId = 'zhihu:question:2';
const source = (html: { item?: string; comment?: string; question?: string } = {}) => ({
  format: 'gonglun-zhihu-archive', version: 1,
  items: [{ id: '1', type: 'answer', text: '', html: html.item, completeness: { body: 'complete' },
    question: { id: '2', title: '', text: '', html: html.question, completeness: { title: 'complete', body: 'complete' } } }],
  comments: [{ id: 'local-9', sourceId: '9', threadId: 'answer:1', text: '', html: html.comment,
    rootCommentId: '9', parentCommentId: null, completeness: { body: 'complete' } }],
});
const fixture = (html?: Parameters<typeof source>[0]) => prepareZhihuForViewing(source(html));
const href = (url: string) => url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Zhihu source HTML reading link hints', () => {
  it('recovers exact saved item, comment and embedded question labels without rewriting URL queries', () => {
    const itemUrl = 'HTTPS://EXAMPLE.test:443/a%2Fb?x=1&x=2&empty=&q=A+%20#Ab';
    const commentUrl = 'https://example.test/comment?q=%E4%B8%AD&x=%2f&x=%2F#中文';
    const questionUrl = 'https://example.test/question?flag&zero=0&v=%2520';
    const data = fixture({
      item: `<p><a href="${href(itemUrl)}"><strong>技术</strong>标签A</a></p>`,
      comment: `<a href="${href(commentUrl)}">技术标签B</a>`,
      question: `<p><a href="${href(questionUrl)}">技术标签C</a></p>`,
    });
    const before = structuredClone(data), links = createZhihuReadingLinks(data);
    expect(links(itemId)).toEqual([{ label: '技术标签A', url: itemUrl }]);
    expect(links(commentId)).toEqual([{ label: '技术标签B', url: commentUrl }]);
    expect(links(questionId)).toEqual([{ label: '技术标签C', url: questionUrl }]);
    expect(data).toEqual(before);
  });

  it('uses independently saved question HTML when it supersedes embedded question context', () => {
    const raw = { ...source({ question: '<a href="https://example.test/embedded">旧技术标签</a>' }),
      questions: [{ id: '2', title: '', text: '', html: '<a href="https://example.test/question?x=1&amp;x=2">新技术标签</a>',
        completeness: { title: 'complete', body: 'complete' } }] };
    const links = createZhihuReadingLinks(prepareZhihuForViewing(raw));
    expect(links(questionId)).toEqual([{ label: '新技术标签', url: 'https://example.test/question?x=1&x=2' }]);
  });

  it('takes question hints from the same complete embedded version as the displayed body', () => {
    const url = 'https://example.test/question?x=1&x=2';
    const completeText = `技术完整标签 (${url})`;
    const raw = source();
    const data = prepareZhihuForViewing({ ...raw, items: [
      { ...raw.items[0], question: { id: '2', title: '', text: completeText,
        html: `<a href="${href(url)}">技术完整标签</a>`, completeness: { title: 'complete', body: 'complete' } } },
      { ...raw.items[0], id: '3', question: { id: '2', title: '', text: '技术部分标签',
        html: '<a href="https://example.test/partial">技术部分标签</a>', completeness: { title: 'complete', body: 'partial' } } },
    ] });
    expect(data.messages.find(message => message.id === questionId)?.content).toBe(completeText);
    expect(createZhihuReadingLinks(data)(questionId)).toEqual([{ label: '技术完整标签', url }]);
  });

  it('retains distinct anchor titles pointing to the same URL and decodes literal HTML entities only', () => {
    const url = 'https://example.test/a?a=1&b=2';
    const links = createZhihuReadingLinks(fixture({ item: `<a href="${href(url)}">技术标签A</a><a href="${href(url)}"> 技术&nbsp;<em>标签B</em> </a>` }));
    expect(links(itemId)).toEqual([{ label: '技术标签A', url }, { label: '技术 标签B', url }]);
  });

  it('ignores unknown metadata, generated directories and local operations', () => {
    const original = fixture({ item: '<a href="https://example.test/a">技术标签</a>' });
    const replied = sendZhihuLocalRelation(original, { relationType: 'REPLY', sourceMessageIds: [commentId], targetMessageIds: [itemId] });
    const replyId = replied.zhihu.localOperations.messages.at(-1)!.id;
    const data = sendZhihuLocalRelation(replied, { relationType: 'DISAGREE', targetMessageIds: [replyId] });
    const localIds = Object.entries(data.zhihu.byMessageId).filter(([, meta]) => meta.kind === 'local-operation').map(([id]) => id);
    expect(localIds.length).toBeGreaterThan(0);
    const links = createZhihuReadingLinks(data);
    for (const id of ['unknown', 'zhihu:type:answer', replyId, ...localIds]) expect(links(id)).toEqual([]);
    expect(links(itemId)).toEqual([{ label: '技术标签', url: 'https://example.test/a' }]);
  });

  it('does not infer hints from old plain text, malformed HTML fields or unsupported anchor schemes', () => {
    const data = fixture();
    data.zhihu.archive.items[0].text = '技术标签 (https://example.test/a)';
    data.messages.find(message => message.id === itemId)!.content = data.zhihu.archive.items[0].text;
    expect(createZhihuReadingLinks(data)(itemId)).toEqual([]);
    data.zhihu.archive.items[0].html = 42;
    expect(createZhihuReadingLinks(data)(itemId)).toEqual([]);
    const html = '<a href="javascript:alert(1)">技术A</a><a href="data:text/plain,x">技术B</a>'
      + '<a href="/relative">技术C</a><a href="//example.test/a">技术D</a><a>技术E</a>'
      + '<a href="https://example.test/a">  </a><a href="https://example.test/a">https://example.test/a</a>';
    expect(createZhihuReadingLinks(fixture({ item: html }))(itemId)).toEqual([]);
  });

  it('parses malicious saved HTML only in a disconnected inert template without requests or document mutations', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('__zhihuLinkScriptExecuted', false);
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const xhrSend = vi.spyOn(XMLHttpRequest.prototype, 'send');
    const bodyBefore = document.documentElement.outerHTML;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const html = '<script data-synthetic-malicious>globalThis.__zhihuLinkScriptExecuted=true;fetch("https://example.test/script")</script>'
      + '<img data-synthetic-malicious src="https://example.test/image" onerror="globalThis.__zhihuLinkScriptExecuted=true">'
      + '<iframe data-synthetic-malicious src="https://example.test/frame"></iframe>'
      + '<link data-synthetic-malicious rel="stylesheet" href="https://example.test/style">'
      + '<a data-synthetic-malicious href="https://example.test/a?x=1&amp;x=2" onclick="globalThis.__zhihuLinkScriptExecuted=true"><b>技术</b>标签</a>';
    try {
      expect(createZhihuReadingLinks(fixture({ item: html }))(itemId)).toEqual([{ label: '技术标签', url: 'https://example.test/a?x=1&x=2' }]);
      await Promise.resolve();
      expect(mutations).toEqual([]);
      expect(observer.takeRecords()).toEqual([]);
      expect(document.documentElement.outerHTML).toBe(bodyBefore);
      expect(document.querySelector('[data-synthetic-malicious]')).toBeNull();
      expect((globalThis as unknown as { __zhihuLinkScriptExecuted: boolean }).__zhihuLinkScriptExecuted).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(xhrOpen).not.toHaveBeenCalled();
      expect(xhrSend).not.toHaveBeenCalled();
    } finally { observer.disconnect(); }
  });

  it('caches extraction within one document without sharing stale labels with a newly opened document', () => {
    const original = fixture({ item: '<a href="https://example.test/a?x=1&amp;x=2">技术A</a>' });
    const links = createZhihuReadingLinks(original), first = links(itemId);
    const createElement = vi.spyOn(document, 'createElement');
    expect(links(itemId)).toBe(first);
    expect(createElement).not.toHaveBeenCalled();
    const reopened: ZhihuViewingData = fixture({ item: '<a href="https://example.test/a?x=1&amp;x=2">技术B</a>' });
    expect(createZhihuReadingLinks(reopened)(itemId)).toEqual([{ label: '技术B', url: 'https://example.test/a?x=1&x=2' }]);
    expect(first).toEqual([{ label: '技术A', url: 'https://example.test/a?x=1&x=2' }]);
  });
});
