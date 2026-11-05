import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MessageTextPart from '../components/MessageTextPart';
import MessageCard from '../components/MessageCard';
import JoinRecordBadges from '../components/JoinRecordBadges';
import { clearDraftAll, commitDraftTo, handleMessageClick, handleTextMouseUp } from '../pages/workbench/actions/cardSelection';
import { capturePartSelection } from '../utils/partSelection';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';

const message: DemoMessage = { id: 'message', kind: 'normal', author: 'writer', createdAt: '', revision: 3,
  content: '原文🙂\n保留换行与空格 ', parts: [{ id: 'body', type: 'text', text: '原文🙂\n保留换行与空格 ' }] };
const whole: UnitSelection = { messageId: message.id, selection: { kind: 'whole' } };

function Selection({ source = [], onCardClick = vi.fn(), onFragmentClick = vi.fn() }: {
  source?: UnitSelection[]; onCardClick?: () => void; onFragmentClick?: () => void;
}) {
  const [draftUnits, setDraftUnits] = useState<UnitSelection[]>([]), [activeTextSelectId, setActiveTextSelectId] = useState<string | null>(message.id);
  const [sourceUnits, setSourceUnits] = useState(source), [targetUnits, setTargetUnits] = useState<UnitSelection[]>([]);
  const [error, setSendError] = useState<string | null>(null);
  const lastAddedFragmentRef = useRef(null), lastDragOrSelectTimeRef = useRef(0);
  const selection = { draftUnits, setDraftUnits, sourceUnits, setSourceUnits, targetUnits, setTargetUnits, setActiveTextSelectId, setSendError };
  return <>
    <div onClick={onCardClick}><MessageTextPart message={message} activeText={activeTextSelectId === message.id}
      onMouseUp={(event, id) => handleTextMouseUp({ ...selection, activeTextSelectId, msgMap: new Map([[message.id, message]]),
        lastAddedFragmentRef, lastDragOrSelectTimeRef, undoRecentClickActionsForMessage: vi.fn() }, event, id)}>
      <span data-testid="highlighted-text" onClick={onFragmentClick}>{message.content}</span>
    </MessageTextPart></div>
    <output data-testid="draft">{JSON.stringify(draftUnits)}</output>
    <output data-testid="source">{JSON.stringify(sourceUnits)}</output>
    <output data-testid="target">{JSON.stringify(targetUnits)}</output>
    <output>{error}</output>
    <button onClick={() => clearDraftAll(selection)}>清空</button>
    <button onClick={() => commitDraftTo(selection, 'source')}>加入来源集合</button>
    <button onClick={() => commitDraftTo(selection, 'target')}>加入目标集合</button>
  </>;
}

function selectText() {
  const target = screen.getByTestId('highlighted-text');
  const range = document.createRange(); range.selectNodeContents(target.firstChild!);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  fireEvent.mouseUp(target, { button: 0, detail: 1 });
  return { target, selection };
}

function copy(target: Element) {
  const setData = vi.fn(), event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData } });
  fireEvent(target, event);
  expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', message.content);
  expect(event.defaultPrevented).toBe(true);
}

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

it('stages an exact versioned fragment, retains its range through rendering, and copies without toggling the card or annotation', () => {
  const onCardClick = vi.fn(), onFragmentClick = vi.fn();
  render(<Selection onCardClick={onCardClick} onFragmentClick={onFragmentClick} />);
  const { target, selection } = selectText();
  const draft = JSON.parse(screen.getByTestId('draft').textContent!);
  expect(draft).toEqual([{ messageId: message.id, reference: { messageId: message.id, revision: 3, partId: 'body', range: { start: 0, end: message.content.length } },
    selection: { kind: 'text', start: 0, len: message.content.length, text: message.content } }]);
  fireEvent.click(target, { button: 0, detail: 1 });
  expect(onCardClick).not.toHaveBeenCalled(); expect(onFragmentClick).not.toHaveBeenCalled();
  expect(selection.toString()).toBe(message.content);
  copy(target); copy(target);
  expect(selection.toString()).toBe(message.content);
  expect(JSON.parse(screen.getByTestId('draft').textContent!)).toEqual(draft);
  selection.removeAllRanges();
  fireEvent.click(target);
  expect(onFragmentClick).toHaveBeenCalledOnce(); expect(onCardClick).toHaveBeenCalledOnce();
});

it('right click retains the fragment and selection for the native Copy menu', () => {
  render(<Selection />);
  const { target, selection } = selectText(), before = screen.getByTestId('draft').textContent;
  fireEvent.mouseUp(target, { button: 2, detail: 1 });
  fireEvent.contextMenu(target);
  expect(screen.getByTestId('draft').textContent).toBe(before);
  expect(selection.toString()).toBe(message.content);
  copy(target);
});

it('keeps source exclusion while allowing the selected source text to be copied', () => {
  render(<Selection source={[whole]} />);
  const { target, selection } = selectText();
  expect(screen.getByTestId('draft')).toHaveTextContent('[]');
  expect(screen.getByText('消息已在来源集合中，不能同时加入候选暂存区')).toBeInTheDocument();
  expect(selection.toString()).toBe(message.content);
  copy(target);
});

it.each(['清空', '加入来源集合', '加入目标集合'])('%s still exits text selection and clears its native range', action => {
  render(<Selection />);
  const { selection } = selectText(), draft = screen.getByTestId('draft').textContent;
  fireEvent.click(screen.getByRole('button', { name: action }));
  expect(screen.getByTestId('draft')).toHaveTextContent('[]');
  expect(selection.isCollapsed).toBe(true);
  if (action !== '清空') expect(screen.getByTestId(action === '加入来源集合' ? 'source' : 'target').textContent).toBe(draft);
});

function CardSelection({ legacy }: { legacy: boolean }) {
  const record = legacy ? { ...message, parts: undefined } : message;
  const [draftUnits, setDraftUnits] = useState<UnitSelection[]>([]);
  const lastAddedFragmentRef = useRef(null), lastDragOrSelectTimeRef = useRef(0), lastClickActionsRef = useRef([]);
  const selection = { setDraftUnits, sourceUnits: [], setSendError: vi.fn() };
  return <>
    <MessageCard msg={record} ctx={{ isActiveText: true }}
      onContentMouseUp={(event, id) => handleTextMouseUp({ ...selection, activeTextSelectId: message.id,
        setActiveTextSelectId: vi.fn(), msgMap: new Map([[message.id, record]]), lastAddedFragmentRef,
        lastDragOrSelectTimeRef, undoRecentClickActionsForMessage: vi.fn() }, event, id)}
      onClick={(event, id) => handleMessageClick({ ...selection, lastDragOrSelectTimeRef, lastClickActionsRef,
        comparisonMode: false, setComparisonTargetId: vi.fn(), setComparisonReviewed: vi.fn(),
        setComparisonReviewBaseMessages: vi.fn(), setComparisonReviewBaseEdges: vi.fn(),
        setComparisonSide: vi.fn(), setLastClickedMessageId: vi.fn() }, event, id)}
      relatedMessages={<JoinRecordBadges messageId={message.id} isContainer isEffective={() => true} onOpen={vi.fn()} />}>
      <span data-testid="body-text">{message.content}</span>
    </MessageCard>
    <output data-testid="draft">{JSON.stringify(draftUnits)}</output>
  </>;
}

it.each([false, true].flatMap(legacy => ['hint', 'body-to-hint', 'hint-to-body'].map(direction => ({ legacy, direction }))))(
  'leaves $direction selectable without staging a fragment or whole card (legacy: $legacy)', ({ legacy, direction }) => {
    render(<CardSelection legacy={legacy} />);
    const card = screen.getByRole('group'), body = screen.getByTestId('body-text');
    const hint = screen.getByRole('button', { name: '查看被加入消息（0条）' });
    const range = document.createRange();
    if (direction === 'hint') range.selectNodeContents(hint);
    else { range.setStart(body.firstChild!, 1); range.setEnd(hint.firstChild!, 2); }
    const selection = window.getSelection()!;
    selection.addRange(range);
    const text = selection.toString();
    const target = direction === 'hint-to-body' ? body : hint;
    fireEvent.mouseUp(target, { button: 0, detail: 1 });
    fireEvent.click(card, { button: 0, detail: 1 });
    expect(capturePartSelection(card, legacy ? { ...message, parts: undefined } : message)).toBeNull();
    expect(screen.getByTestId('draft')).toHaveTextContent('[]');
    expect(selection.toString()).toBe(text);
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    fireEvent(target, copyEvent);
    expect(copyEvent.defaultPrevented).toBe(false);
    expect(selection.toString()).toBe(text);

    // Clearing the native selection restores ordinary whole-message clicks.
    selection.removeAllRanges();
    fireEvent.click(card, { button: 0, detail: 1 });
    expect(JSON.parse(screen.getByTestId('draft').textContent!)).toEqual([whole]);
  },
);

it.each([false, true])('still stages only the body with its exact offset (legacy: %s)', legacy => {
  render(<CardSelection legacy={legacy} />);
  const body = screen.getByTestId('body-text'), range = document.createRange();
  range.setStart(body.firstChild!, 2); range.setEnd(body.firstChild!, 4);
  const selection = window.getSelection()!; selection.addRange(range);
  fireEvent.mouseUp(body, { button: 0, detail: 1 });
  expect(JSON.parse(screen.getByTestId('draft').textContent!)).toEqual([{
    messageId: message.id, reference: { messageId: message.id, revision: 3, partId: legacy ? 'content' : 'body', range: { start: 2, end: 4 } },
    selection: { kind: 'text', start: 2, len: 2, text: '🙂' },
  }]);
  expect(selection.toString()).toBe('🙂');
});

it('keeps explicit keyboard card selection available while hint text is selected', () => {
  render(<CardSelection legacy={false} />);
  const hint = screen.getByRole('button', { name: '查看被加入消息（0条）' }), range = document.createRange();
  range.selectNodeContents(hint);
  window.getSelection()!.addRange(range);
  fireEvent.keyDown(screen.getByRole('group'), { key: 'Enter' });
  expect(JSON.parse(screen.getByTestId('draft').textContent!)).toEqual([whole]);
});
