import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import MessageCard from '../components/MessageCard';
import MessageTextPart from '../components/MessageTextPart';
import { ReadingTextLinksContext } from '../components/ReadingTextLinksContext';
import { PART_SELECTION_EVENT, type PartSelectionDetail } from '../utils/messageElementSelection';
import { capturePartSelection } from '../utils/partSelection';
import { referenceToUnit, type DemoEdge, type DemoMessage } from '../utils/modelBridge';

const url = 'https://www.zhihu.com/question/123?utm_source=a%20b&x=1#answer-456';
const original = `前文😀 ${url} 后文🌱\n第二行`;
const message = (code = false): DemoMessage => ({
  id: 'reading-target', revision: 7, author: 'test-author', createdAt: '', kind: 'normal', content: original,
  parts: code ? [{ id: 'body', type: 'code', language: 'text', source: original }] : [{ id: 'body', type: 'text', text: original }],
});

function Content({ enabled, surface, value }: { enabled: boolean; surface: 'part' | 'card'; value: DemoMessage }) {
  return <ReadingTextLinksContext.Provider value={enabled}>
    {surface === 'part' ? <MessageTextPart message={value} activeText /> : <MessageCard msg={value} ctx={{ isActiveText: true }} />}
  </ReadingTextLinksContext.Provider>;
}

function graphProps(value: DemoMessage, edges: DemoEdge[] = []): GraphViewProps {
  return {
    messages: [value, { id: 'source', author: 'test-author', createdAt: '', content: 'source', kind: 'normal' }],
    edges, draftUnits: [], activeTextSelectId: value.id, lastClickedMessageId: null,
    onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
    onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(),
    isFragmentSelected: () => false,
  };
}

function textPoint(element: HTMLElement, offset: number): [Text, number] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (offset <= length) return [node as Text, offset];
    offset -= length;
  }
  throw new Error('Selection offset is outside the original text');
}

function selectText(element: HTMLElement, start: number, end: number) {
  const range = document.createRange();
  range.setStart(...textPoint(element, start));
  range.setEnd(...textPoint(element, end));
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return { range, selection };
}

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe('reading link presentation through message surfaces', () => {
  it.each(['part', 'card'] as const)('preserves the complete URL and original text in %s without creating a clickable link', surface => {
    const value = message();
    const { container } = render(<Content enabled surface={surface} value={value} />);
    const body = container.querySelector<HTMLElement>('[data-message-part-id="body"]')!;
    expect(body.textContent).toBe(original);
    expect(body.querySelectorAll('[data-reading-link]')).toHaveLength(1);
    expect(body.querySelector('[data-reading-link]')).not.toHaveAttribute('data-reading-link-label');
    expect(body.querySelector('[data-reading-link-url]')?.textContent).toBe(url);
    expect(body.querySelector('a')).toBeNull();
    expect(value.parts).toEqual([{ id: 'body', type: 'text', text: original }]);
  });

  it.each(['part', 'card'] as const)('keeps normal reading and code parts unchanged in %s', surface => {
    const { container, rerender } = render(<Content enabled={false} surface={surface} value={message()} />);
    const body = () => container.querySelector<HTMLElement>('[data-message-part-id="body"]')!;
    expect(body().textContent).toBe(original);
    expect(body().querySelector('[data-reading-link]')).toBeNull();
    rerender(<Content enabled surface={surface} value={message(true)} />);
    expect(body().textContent).toBe(original);
    expect(body().querySelector('[data-reading-link]')).toBeNull();
  });

  it.each(['reference', 'annotation'] as const)('retains the exact %s fragment action when its highlight crosses into a URL in the graph', relationType => {
    const value = message();
    const start = original.indexOf('😀');
    const end = original.indexOf('&x=1');
    const fragment = original.slice(start, end);
    const reference = { messageId: value.id, revision: 7, partId: 'body', range: { start, end } };
    const edge: DemoEdge = {
      id: `reading-${relationType}`, relationMessageId: `reading-${relationType}`, relationType, relationLabel: relationType,
      from: { messageId: 'source', selection: { kind: 'whole' } }, to: referenceToUnit(reference, fragment),
    };
    const received: PartSelectionDetail[] = [];
    const onSelection = (event: Event) => received.push((event as CustomEvent<PartSelectionDetail>).detail);
    window.addEventListener(PART_SELECTION_EVENT, onSelection);
    try {
      const props = graphProps(value, [edge]);
      const { container, rerender } = render(<ReadingTextLinksContext.Provider value><GraphView {...props} /></ReadingTextLinksContext.Provider>);
      const body = () => container.querySelector<HTMLElement>(`[data-msgid="${value.id}"] [data-message-part-id="body"]`)!;
      expect(body().textContent).toBe(original);
      expect(body().querySelectorAll('[data-reading-link]')).toHaveLength(1);
      expect(body().querySelector('[data-reading-link-url]')?.textContent).toBe(url);
      expect(body().querySelector('a')).toBeNull();
      const highlightedUrl = body().querySelector<HTMLElement>('[data-reading-link-url] [data-rel-anchor]')!;
      expect(highlightedUrl).not.toBeNull();
      fireEvent.click(highlightedUrl);
      expect(received).toEqual([{ reference, label: fragment }]);
      expect(props.onFragmentAnchorClick).not.toHaveBeenCalled();

      rerender(<ReadingTextLinksContext.Provider value={false}><GraphView {...props} /></ReadingTextLinksContext.Provider>);
      expect(body().textContent).toBe(original);
      expect(body().querySelector('[data-reading-link]')).toBeNull();
      fireEvent.click(body().querySelector('[data-rel-anchor]')!);
      expect(received).toEqual([{ reference, label: fragment }, { reference, label: fragment }]);
    } finally {
      window.removeEventListener(PART_SELECTION_EVENT, onSelection);
    }
  });

  it('keeps code URLs unformatted in the graph', () => {
    const value = message(true);
    const { container } = render(<ReadingTextLinksContext.Provider value><GraphView {...graphProps(value)} /></ReadingTextLinksContext.Provider>);
    const body = container.querySelector<HTMLElement>(`[data-msgid="${value.id}"] [data-message-part-id="body"]`)!;
    expect(body.textContent).toBe(original);
    expect(body.querySelector('[data-reading-link]')).toBeNull();
  });

  it('captures the source UTF-16 range across visually separated links, including emoji, without visual newlines', () => {
    const value = message();
    const { container } = render(<Content enabled surface="card" value={value} />);
    const body = container.querySelector<HTMLElement>('[data-message-part-id="body"]')!;
    const start = original.indexOf('😀');
    const end = original.indexOf('\n');
    const selectedText = original.slice(start, end);
    const { range, selection } = selectText(body, start, end);
    vi.spyOn(selection, 'toString').mockReturnValue(selectedText.replace(url, `\n${url}\n`));
    expect(range.toString()).toBe(selectedText);
    expect(selection.toString()).not.toBe(selectedText);
    expect(capturePartSelection(container, value, selection)).toEqual({
      messageId: value.id,
      reference: { messageId: value.id, revision: 7, partId: 'body', range: { start, end } },
      selection: { kind: 'text', start, len: end - start, text: selectedText },
    });
  });

  it.each(['card', 'graph'] as const)('copies the exact original text from %s instead of visual line breaks', surface => {
    const value = message();
    const { container } = surface === 'card'
      ? render(<Content enabled surface="card" value={value} />)
      : render(<ReadingTextLinksContext.Provider value><GraphView {...graphProps(value)} /></ReadingTextLinksContext.Provider>);
    const body = container.querySelector<HTMLElement>(`[data-msgid="${value.id}"] [data-message-part-id="body"]`)!;
    const { selection } = selectText(body, 0, original.length);
    vi.spyOn(selection, 'toString').mockReturnValue(original.replace(url, `\n${url}\n`));
    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData } });
    fireEvent(body, event);
    expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', original);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['card', 'graph'] as const)('allows ordinary reading selection and copying in %s without activating fragment selection or selecting the card', surface => {
    const value = message();
    const clearSelection = () => window.getSelection()?.removeAllRanges();
    const onFragmentMouseUp = vi.fn(clearSelection);
    const onCardClick = vi.fn(clearSelection);
    const onCardMouseUp = vi.fn(clearSelection);
    const { container } = render(<ReadingTextLinksContext.Provider value>
      {surface === 'card'
        ? <MessageCard msg={value} ctx={{}} onClick={onCardClick} onMouseUp={onCardMouseUp} onContentMouseUp={onFragmentMouseUp} />
        : <GraphView {...graphProps(value)} activeTextSelectId={null} onTextMouseUp={onFragmentMouseUp} onMessageClick={onCardClick} />}
    </ReadingTextLinksContext.Provider>);
    const body = container.querySelector<HTMLElement>(`[data-msgid="${value.id}"] [data-message-part-id="body"]`)!;
    expect(body).toHaveStyle({ userSelect: 'text' });
    fireEvent.mouseDown(body, { button: 0 });
    const { selection } = selectText(body, 0, original.length);
    fireEvent.mouseUp(body, { button: 0, detail: 1 });
    fireEvent.click(body, { button: 0, detail: 1 });
    expect(onFragmentMouseUp).not.toHaveBeenCalled();
    expect(onCardMouseUp).not.toHaveBeenCalled();
    expect(onCardClick).not.toHaveBeenCalled();
    expect(selection.rangeCount).toBe(1);
    expect(selection.getRangeAt(0).toString()).toBe(original);

    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData } });
    fireEvent(body, event);
    expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', original);
    expect(event.defaultPrevented).toBe(true);
    expect(selection.getRangeAt(0).toString()).toBe(original);

    selection.removeAllRanges();
    fireEvent.click(body, { button: 0, detail: 1 });
    expect(onCardClick).toHaveBeenCalledExactlyOnceWith(expect.anything(), value.id);
  });

  it('keeps an evidenced title and its complete parenthesized URL in one reading block', () => {
    const label = '原始文章标题😀';
    const labelledLink = `${label} (${url})`;
    const text = `说明\n${labelledLink}\n结尾`;
    const value: DemoMessage = { ...message(), content: text, parts: [{ id: 'body', type: 'text', text }] };
    const linksForMessage = (messageId: string) => messageId === value.id ? [{ label, url }] : [];
    const { container } = render(<ReadingTextLinksContext.Provider value={{ linksForMessage }}>
      <MessageCard msg={value} ctx={{}} />
    </ReadingTextLinksContext.Provider>);
    const body = container.querySelector<HTMLElement>('[data-message-part-id="body"]')!;
    const blocks = body.querySelectorAll('[data-reading-link]');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe(labelledLink);
    expect(blocks[0]).toHaveAttribute('data-reading-link-kind', 'labelled');
    expect(blocks[0]).not.toHaveAttribute('data-reading-link-label');
    expect(blocks[0].querySelector('[data-reading-link-url]')?.textContent).toBe(url);
    expect(body.textContent).toBe(text);
    expect(body.querySelector('a')).toBeNull();
    expect(value.parts).toEqual([{ id: 'body', type: 'text', text }]);
  });
});
