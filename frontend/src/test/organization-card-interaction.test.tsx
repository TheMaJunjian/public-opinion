import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import ClassificationCard from '../components/graph/ClassificationCard';
import OrganizationFrameHeader from '../components/graph/OrganizationFrameHeader';
import MessageCard from '../components/MessageCard';
import { capturePartSelection } from '../utils/partSelection';
import { PART_SELECTION_EVENT, type PartSelectionDetail } from '../utils/messageElementSelection';
import type { DemoMessage } from '../utils/modelBridge';

const category: DemoMessage = {
  id: 'classification', revision: 2, kind: 'relation', relationType: 'classify', author: '甲', createdAt: '2026-01-01T00:00:00Z', content: '图书馆开放时间',
  parts: [{ id: 'body', type: 'text', text: '图书馆开放时间' }, { id: 'group', type: 'relation', relation: 'classify', roles: { members: [{ id: 'member-a', reference: { messageId: 'a' } }] } }],
};

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

describe('visible organization card elements', () => {
  it('navigates consistently when double-clicking classification title, visible labels or card padding', () => {
    const navigate = vi.fn();
    const { getByText, getByRole, container } = render(<ClassificationCard msg={category} selectedUnits={[]} box={{ x: 0, y: 0, width: 340 }}
      targetCount={1} title={category.content} activeText={false} isWhole={false} isActive={false} isStanceTarget={false}
      homeLabel={null} relatedJoinRelations={[]} outgoingJoinRelations={[]} validJoinCount={0} invalidJoinCount={0}
      cardRef={null} headerRef={null} contentRef={null} onMessageClick={vi.fn()} onMessageDoubleClick={navigate} onTextMouseUp={vi.fn()} />);
    fireEvent.doubleClick(getByText(category.content));
    fireEvent.doubleClick(container.querySelector('[data-msgid]')!);
    fireEvent.doubleClick(getByRole('button', { name: '选择分类' }));
    fireEvent.doubleClick(getByRole('button', { name: '选择所含消息' }));
    expect(navigate).toHaveBeenCalledTimes(4);
    expect(navigate.mock.calls.every(call => call[1] === category.id)).toBe(true);
  });

  it('selects summary text from the rendered title while leaving native double-click to frame navigation', () => {
    const summary = { ...category, relationType: 'summary' as const };
    const navigate = vi.fn(), selections: unknown[] = [];
    const { container, getByText } = render(<div onDoubleClick={navigate}>
      <OrganizationFrameHeader message={summary} messageId={summary.id} kind="summary" memberCount={1} selectedUnits={[]} activeText={false}
        onTextMouseUp={event => selections.push(capturePartSelection(event.currentTarget, summary))} />
    </div>);
    const title = getByText(summary.content), text = title.firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 3);
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(title, { detail: 1 });
    expect(selections).toMatchObject([{ reference: { messageId: summary.id, revision: 2, partId: 'body', range: { start: 0, end: 3 } } }]);
    fireEvent.mouseUp(title, { detail: 2 });
    fireEvent.doubleClick(title);
    expect(selections).toHaveLength(1); expect(navigate).toHaveBeenCalledOnce();
    expect(container.querySelector('details')).toBeNull();
  });

  it('addresses the visible text badge rather than the automatic membership relationship', () => {
    const message: DemoMessage = { ...category, kind: 'normal', relationType: undefined, parts: [category.parts![0], { id: 'membership', type: 'relation', relation: 'member-of', roles: { parent: [{ id: 'p', reference: { messageId: 'parent' } }] } }] };
    const receive = vi.fn((event: Event) => (event as CustomEvent<PartSelectionDetail>).detail);
    window.addEventListener(PART_SELECTION_EVENT, receive);
    const { getByRole } = render(<MessageCard msg={message} ctx={{}} />);
    fireEvent.click(getByRole('button', { name: '选择文本' }));
    expect(receive.mock.results[0].value.reference).toEqual({ messageId: message.id, revision: 2, partId: 'body' });
    window.removeEventListener(PART_SELECTION_EVENT, receive);
  });
});
