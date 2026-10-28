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
  it('keeps the operations message ID in its header alongside its type',()=>{
    const message:DemoMessage={...category,id:'operation-record',kind:'operations',backendKind:'OPERATIONS',relationType:'operations'};
    const view=render(<MessageCard msg={message} ctx={{isGovernanceMsg:true}}/>);
    expect(view.getByText('operation-record')).toBeInTheDocument();
    expect(view.getByRole('button',{name:'选择运营'})).toBeInTheDocument();
  });
  it.each(['merge','arrange'] as const)('places the %s ID above its arbitration entries', kind => {
    const message={...category,id:'frame',relationType:kind};
    const view=render(<OrganizationFrameHeader message={message} messageId="frame" kind={kind} memberCount={1} selectedUnits={[]} activeText={false} onTruth={vi.fn()} onValue={vi.fn()}/>);
    const identity=view.getByText('frame'),actions=view.container.querySelector('[data-message-settlement-actions]')!;
    expect(identity.compareDocumentPosition(actions)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(identity.closest('[data-card-header]')!.parentElement).toBe(actions.parentElement);
    const header=view.container.querySelector('[data-organization-card-header]')!;
    const type=view.getByRole('button',{name:`选择${kind==='merge'?'归并':'排列'}`});
    expect(header.firstElementChild?.contains(type)).toBe(true);
    expect(type.compareDocumentPosition(identity)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('puts an expanded summary ID before its text, level with the external arbitration row',()=>{
    const view=render(<OrganizationFrameHeader message={{...category,id:'summary',content:'总结正文',relationType:'summary'}} messageId="summary" kind="summary" memberCount={1} selectedUnits={[]} activeText={false}/>);
    expect(view.getByText('summary').compareDocumentPosition(view.getByText('总结正文'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('shows the text selection hint when a classification enters correction selection', () => {
    const view = render(<ClassificationCard msg={category} selectedUnits={[]} box={{x:0,y:0,width:340}}
      targetCount={1} title={category.content} activeText isWhole={false} isActive isStanceTarget={false}
      homeLabel={null} relatedJoinRelations={[]} outgoingJoinRelations={[]} isJoinEffective={()=>false}
      cardRef={null} headerRef={null} contentRef={null} onMessageClick={vi.fn()} onMessageDoubleClick={vi.fn()} onTextMouseUp={vi.fn()}/>);
    expect(view.getByText('拖选文字即可选择片段，或点击已有高亮片段')).toBeInTheDocument();
    expect(view.container.querySelector('[data-message-part-id="body"]')).toHaveStyle({cursor:'text'});
  });
  it('keeps whitespace beside JOIN badges navigable after leaving and returning to a classification card',()=>{
    const navigate=vi.fn(),select=vi.fn(),openRecords=vi.fn();
    const join={id:'join-leaf',relationType:'JOIN',sourceMessageId:category.id,targetRefs:[{kind:'message' as const,messageId:'leaf'}],createdAt:'2026-01-01',createdBy:{id:'u',username:'甲',createdAt:''}};
    const card=(isWhole:boolean)=><ClassificationCard msg={category} selectedUnits={[]} box={{x:0,y:0,width:340}}
      targetCount={1} title={category.content} activeText={false} isWhole={isWhole} isActive={false} isStanceTarget={false}
      homeLabel={null} relatedJoinRelations={[]} outgoingJoinRelations={[join]} isJoinEffective={()=>true}
      cardRef={null} headerRef={null} contentRef={null} onMessageClick={select} onMessageDoubleClick={navigate}
      onMessageMouseDown={select} onMessageMouseUp={select} onTextMouseUp={vi.fn()} onJoinFilterClick={openRecords}/>;
    const view=render(card(false));
    const blankRow=()=>view.getByRole('button',{name:'查看被加入消息（1条）'}).parentElement!;
    fireEvent.click(blankRow());view.rerender(card(true));fireEvent.click(blankRow());
    fireEvent.doubleClick(blankRow());
    expect(navigate).toHaveBeenCalledOnce();expect(navigate.mock.calls[0][1]).toBe(category.id);
    expect(openRecords).not.toHaveBeenCalled();
    view.rerender(<div>分类内容</div>);view.rerender(card(false));
    navigate.mockClear();select.mockClear();
    fireEvent.mouseDown(blankRow());fireEvent.mouseUp(blankRow());fireEvent.doubleClick(blankRow());
    expect(navigate).toHaveBeenCalledOnce();expect(select).toHaveBeenCalledTimes(2);
    navigate.mockClear();select.mockClear();
    const badge=view.getByRole('button',{name:'查看被加入消息（1条）'});
    fireEvent.mouseDown(badge);fireEvent.mouseUp(badge);fireEvent.click(badge);fireEvent.doubleClick(badge);
    expect(openRecords).toHaveBeenCalledWith(category.id,'outgoing');
    expect(navigate).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();
  });
  it('navigates consistently when double-clicking classification title, visible labels or card padding', () => {
    const navigate = vi.fn();
    const { getByText, getByRole, container } = render(<ClassificationCard msg={category} selectedUnits={[]} box={{ x: 0, y: 0, width: 340 }}
      targetCount={1} title={category.content} activeText={false} isWhole={false} isActive={false} isStanceTarget={false}
      homeLabel={null} relatedJoinRelations={[]} outgoingJoinRelations={[]} isJoinEffective={()=>false}
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
