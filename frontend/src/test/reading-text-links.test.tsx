import { Fragment } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReadingTextLinks, { renderReadingTextLinks, type ReadingTextLinkHint } from '../components/ReadingTextLinks';
import { buildAnnoTree, getRangeStartOffsetUTF16, renderAnnoNodes } from '../utils/graphTextSelection';
import { capturePartSelection } from '../utils/partSelection';
import type { DemoMessage } from '../utils/modelBridge';

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

function view(text: string, hints?: readonly ReadingTextLinkHint[]) {
  return render(<div data-testid="body"><ReadingTextLinks text={text} hints={hints} /></div>);
}

function rangeFor(container: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0, startSet = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (!startSet && start >= offset && start <= offset + length) {
      range.setStart(node, start - offset); startSet = true;
    }
    if (startSet && end >= offset && end <= offset + length) { range.setEnd(node, end - offset); return range; }
    offset += length;
  }
  throw new Error('Structural test range outside text');
}

describe('reading-only text link layout', () => {
  it('keeps a labelled exported link, its brackets, spaces and complete query unchanged', () => {
    const url = 'HTTPS://example.test/a%2Fb?x=1&x=2&q=%E4%B8%AD+%20&empty=#Frag';
    const text = `正文 标题  (${url}) 后文`;
    const { getByTestId } = view(text, [{ label: '标题', url }]);
    const body = getByTestId('body'), block = body.querySelector<HTMLElement>('[data-reading-link]')!;
    expect(body.textContent).toBe(text);
    expect(block.textContent).toBe(`标题  (${url})`);
    expect(block.dataset.readingLinkKind).toBe('labelled');
    expect(block.hasAttribute('data-reading-link-label')).toBe(false);
    expect(block.style.display).toBe('');
    expect(block.querySelector('[data-reading-link-url]')?.textContent).toBe(url);
    expect(body.querySelector('a, button, input')).toBeNull();
  });

  it('does not infer an in-paragraph title without matching original link evidence', () => {
    const url = 'https://example.test/?x=1&x=2', text = `普通前文 标题 (${url}) 普通后文`;
    const { getByTestId } = view(text);
    const body = getByTestId('body'), block = body.querySelector<HTMLElement>('[data-reading-link]')!;
    expect(body.textContent).toBe(text);
    expect(block.dataset.readingLinkKind).toBe('bare');
    expect(block.textContent).toBe(`(${url})`);
  });

  it('groups only an unambiguous standalone legacy title and URL line', () => {
    const url = 'https://example.test/?q=1';
    const text = `普通前文\n  独占一行标题 \t(${url})  \n这句说明：标题 (${url})\n甲 (${url}) 乙 (${url})\n后文`;
    const { getByTestId } = view(text);
    const body = getByTestId('body'), blocks = body.querySelectorAll<HTMLElement>('[data-reading-link]');
    expect(body.textContent).toBe(text);
    expect(Array.from(blocks, block => block.dataset.readingLinkKind)).toEqual(['labelled', 'bare', 'bare', 'bare']);
    expect(blocks[0].textContent).toBe(`独占一行标题 \t(${url})`);
    expect(blocks[1].textContent).toBe(`(${url})`);
  });

  it('uses exact label and URL hints, preserving different labels and query strings', () => {
    const url = 'https://example.test/?x=1&x=2#Frag!';
    const text = `前 甲标题 (${url}) 中 乙标题 （ ${url} ） 后 未匹配标题 (https://example.test/?x=10)`;
    const { getByTestId } = view(text, [
      { label: '甲标题', url }, { label: '乙标题', url }, { label: '未匹配标题', url: 'https://example.test/?x=1' },
    ]);
    const body = getByTestId('body'), blocks = body.querySelectorAll<HTMLElement>('[data-reading-link]');
    expect(body.textContent).toBe(text);
    expect(Array.from(blocks, block => block.textContent)).toEqual([`甲标题 (${url})`, `乙标题 （ ${url} ）`, '(https://example.test/?x=10)']);
    expect(Array.from(blocks, block => block.dataset.readingLinkKind)).toEqual(['labelled', 'labelled', 'bare']);
  });

  it('keeps the complete evidenced title when duplicate or suffix hints also match', () => {
    const url = 'https://example.test/', text = `前 较长标题 (${url}) 后`;
    const { getByTestId } = view(text, [{ label: '标题', url }, { label: '较长标题', url }, { label: '较长标题', url }]);
    const body = getByTestId('body');
    expect(body.textContent).toBe(text);
    expect(body.querySelectorAll('[data-reading-link]')).toHaveLength(1);
    expect(body.querySelector('[data-reading-link]')?.textContent).toBe(`较长标题 (${url})`);
  });

  it('keeps Chinese delimiters and whitespace inside one display block', () => {
    const text = '标题（ \thttps://example.test/path?q=一二&x=2 \t）后文';
    const { getByTestId } = view(text);
    expect(getByTestId('body').textContent).toBe(text);
    expect(getByTestId('body').querySelector('[data-reading-link]')?.textContent).toBe('（ \thttps://example.test/path?q=一二&x=2 \t）');
  });

  it('separates multiple bare URLs from Chinese sentence punctuation without adding characters', () => {
    const text = 'https://example.test/a，后文 https://example.test/b。\n再看：https://example.test/c?q=3&y=4；结束';
    const { getByTestId } = view(text);
    expect(getByTestId('body').textContent).toBe(text);
    expect(Array.from(getByTestId('body').querySelectorAll('[data-reading-link-url]'), node => node.textContent)).toEqual([
      'https://example.test/a', 'https://example.test/b', 'https://example.test/c?q=3&y=4',
    ]);
  });

  it('does not discard query punctuation or balance parentheses by changing the URL', () => {
    const urls = ['https://example.test/?q=a,b;:', 'https://example.test/path(a)?q=(b)', 'https://[::1]/?x=%2f&x=%2F#t!'];
    const text = urls.map(url => `(${url})`).join(' ');
    const { getByTestId } = view(text);
    expect(getByTestId('body').textContent).toBe(text);
    expect(Array.from(getByTestId('body').querySelectorAll('[data-reading-link-url]'), node => node.textContent)).toEqual(urls);
    expect(Array.from(getByTestId('body').querySelectorAll('[data-reading-link]'), node => node.textContent)).toEqual(urls.map(url => `(${url})`));
  });

  it('renders untrusted HTML-looking source only as literal text', () => {
    const text = '<img src=x onerror="alert(1)"><script>alert(2)</script> (https://example.test/?q=%3Csvg%3E&x=1)';
    const { getByTestId } = view(text);
    const body = getByTestId('body');
    expect(body.textContent).toBe(text);
    expect(body.querySelector('script, img, svg, a')).toBeNull();
    expect(body.querySelector('[onerror], [onclick], [href]')).toBeNull();
  });

  it('leaves unsupported schemes, prefixes and ordinary text alone', () => {
    const text = 'javascript:alert(1) www.example.test ftp://example.test https:// xhttps://example.test';
    expect(renderReadingTextLinks(text)).toBe(text);
    expect(view(text).getByTestId('body').querySelector('[data-reading-link]')).toBeNull();
  });

  it('preserves annotation anchors and full-fragment callbacks even when the URL crosses their boundaries', () => {
    const text = '前 https://example.test/path?x=1&y=2 后';
    const start = text.indexOf('https:'), query = text.indexOf('?');
    const onFragmentClick = vi.fn();
    const nodes = renderAnnoNodes(text, buildAnnoTree([
      { start: 0, end: text.length, relationType: 'annotation', edgeId: 'outer' },
      { start: query, end: text.length, relationType: 'reference', edgeId: 'inner' },
    ]), 0, text.length, 0, 'synthetic', () => false, onFragmentClick);
    const { getByTestId } = render(<pre data-testid="body"><ReadingTextLinks text={text}>{nodes}</ReadingTextLinks></pre>);
    const body = getByTestId('body'), links = body.querySelectorAll('[data-reading-link]');
    expect(body.textContent).toBe(text);
    expect(links).toHaveLength(1);
    expect(links[0].querySelector('[data-reading-link-url]')?.textContent).toBe(text.slice(start, text.length - 2));
    const innerAnchor = links[0].querySelector<HTMLElement>(`[data-rel-anchor="reference::${query}:${text.length}"]`)!;
    expect(innerAnchor).not.toBeNull();
    fireEvent.click(innerAnchor);
    expect(onFragmentClick).toHaveBeenCalledExactlyOnceWith('synthetic', query, text.length - query, text.slice(query));
    expect(links[0].querySelector(`[data-rel-anchor="annotation::0:${text.length}"]`)).not.toBeNull();
  });

  it('preserves annotated title callbacks when evidence groups title and URL together', () => {
    const url = 'https://example.test/?q=😀&x=1', label = '😀标题', text = `前 ${label} (${url}) 后`;
    const start = text.indexOf(label), end = start + label.length;
    const onFragmentClick = vi.fn();
    const nodes = renderAnnoNodes(text, buildAnnoTree([{ start, end, relationType: 'annotation', edgeId: 'label' }]),
      0, text.length, 0, 'synthetic', () => false, onFragmentClick);
    const { getByTestId } = render(<pre data-testid="body"><ReadingTextLinks text={text} hints={[{ label, url }]}>{nodes}</ReadingTextLinks></pre>);
    const body = getByTestId('body'), block = body.querySelector<HTMLElement>('[data-reading-link]')!;
    expect(body.textContent).toBe(text);
    expect(block.textContent).toBe(`${label} (${url})`);
    fireEvent.click(block.querySelector(`[data-rel-anchor="annotation::${start}:${end}"]`)!);
    expect(onFragmentClick).toHaveBeenCalledExactlyOnceWith('synthetic', start, label.length, label);
    const range = rangeFor(body, start, text.length - 2);
    expect(range.toString()).toBe(`${label} (${url})`);
    expect(range.cloneContents().textContent).toBe(`${label} (${url})`);
    expect(getRangeStartOffsetUTF16(body, range)).toBe(start);
  });

  it('retains nested presentation props and tolerates fragments, numbers and empty children', () => {
    const text = '1 https://example.test/a?q=2';
    const { getByTestId } = render(<div data-testid="body"><ReadingTextLinks text={text}>
      <Fragment>{1}{null}{false}<em data-annotation="saved" style={{ background: 'yellow' }}> https://example.test/<strong>a?q=2</strong></em></Fragment>
    </ReadingTextLinks></div>);
    const body = getByTestId('body');
    expect(body.textContent).toBe(text);
    expect(body.querySelector('[data-reading-link-url] strong')?.textContent).toBe('a?q=2');
    expect(body.querySelector('[data-reading-link-url] [data-annotation]')).toHaveStyle({ background: 'yellow' });
  });

  it('does not infer opaque component output, rewrite mismatching children or format twice', () => {
    const text = 'https://example.test/';
    const Opaque = () => <span>{text}</span>;
    const opaque = <Opaque />;
    expect(renderReadingTextLinks(opaque, text)).toBe(opaque);
    const mismatching = <span>other</span>;
    expect(renderReadingTextLinks(mismatching, text)).toBe(mismatching);
    const once = renderReadingTextLinks(text);
    expect(renderReadingTextLinks(once, text)).toBe(once);
    const { container } = render(<div>{renderReadingTextLinks(once, text)}</div>);
    expect(container.querySelectorAll('[data-reading-link]')).toHaveLength(1);
  });

  it('keeps DOM range copy and UTF-16 fragment offsets identical across links and emoji', () => {
    const text = '😀前 标题 (https://example.test/?emoji=😀&x=1) 后😀文';
    const { getByTestId } = render(<div data-testid="body" data-message-part-id="body" data-message-revision="3"><ReadingTextLinks text={text} /></div>);
    const body = getByTestId('body');
    const all = document.createRange(); all.selectNodeContents(body);
    expect(all.toString()).toBe(text);
    expect(all.cloneContents().textContent).toBe(text);
    const start = text.indexOf('标题'), end = text.indexOf('文');
    const range = rangeFor(body, start, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    expect(getRangeStartOffsetUTF16(body, range)).toBe(start);
    expect(range.toString()).toBe(text.slice(start, end));
    const message: DemoMessage = { id: 'zhihu:item:article:1', kind: 'normal', author: '', content: text, createdAt: '', revision: 3, parts: [{ id: 'body', type: 'text', text }] };
    expect(capturePartSelection(body, message, selection)?.reference).toEqual({ messageId: message.id, revision: 3, partId: 'body', range: { start, end } });
  });
});
