import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import ClassificationCard from '../components/graph/ClassificationCard';
import OrganizationFrameHeader from '../components/graph/OrganizationFrameHeader';
import MessageCard from '../components/MessageCard';
import MessageSettlementActions from '../components/MessageSettlementActions';
import { capturePartSelection } from '../utils/partSelection';
import { PART_SELECTION_EVENT, type PartSelectionDetail } from '../utils/messageElementSelection';
import type { DemoMessage } from '../utils/modelBridge';

const category: DemoMessage = {
  id: 'classification', revision: 2, kind: 'relation', relationType: 'classify', author: '甲', createdAt: '2026-01-01T00:00:00Z', content: '图书馆开放时间',
  parts: [{ id: 'body', type: 'text', text: '图书馆开放时间' }, { id: 'group', type: 'relation', relation: 'classify', roles: { members: [{ id: 'member-a', reference: { messageId: 'a' } }] } }],
};

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

describe('visible organization card elements', () => {
  it.each(['normal', 'summary', 'classify'] as const)('keeps sender investments distinct from community statistics on the %s card', type => {
    const message: DemoMessage = { ...category, kind: type === 'normal' ? 'normal' : 'relation', relationType: type === 'normal' ? undefined : type,
      spending: { protocol: 1, wager: 1, recommendation: 1 }, authorInvestment: { total: { truth: 2, value: 3 } } };
    const counts = { truth: { pro: 99, con: 0 }, value: { pro: 88, con: 0 } };
    const truth = vi.fn(), value = vi.fn();
    const view = render(<MessageCard msg={message} stakeCounts={counts}
      ctx={{ isOrganizationMessage: type !== 'normal', isSummary: type === 'summary', isClassification: type === 'classify', organizationTitle: message.content }}
      headerExtra={<MessageSettlementActions messageId={message.id} counts={counts} onTruth={truth} onValue={value} />} />);
    const sender = view.container.querySelector('.message-card-type-group .message-card-self-stake')!;
    expect(sender).toHaveTextContent('自押 2/3');
    expect(sender).toHaveStyle({ display: 'none' });
    expect(sender.querySelector('[data-message-self-stake]')).toHaveAccessibleName(/发送者 甲.*真假 2 点／价值 3 点/);
    expect(view.container.querySelector('[data-settlement-statistics="TRUTH"]')).toHaveTextContent('99');
    expect(view.container.querySelector('[data-settlement-statistics="VALUE"]')).toHaveTextContent('88');
    fireEvent.click(view.getByTitle('真假仲裁')); fireEvent.click(view.getByTitle('价值仲裁'));
    expect(truth).toHaveBeenCalledWith(message.id); expect(value).toHaveBeenCalledWith(message.id);
  });
  it('does not manufacture zero sender investments while the data is unknown', () => {
    const view = render(<MessageCard msg={category} ctx={{ isClassification: true }} />);
    expect(view.container.querySelector('.message-card-self-stake')).toBeNull();
    view.rerender(<MessageCard msg={{ ...category, spending: { protocol: 1, wager: 0, recommendation: 0 } }} ctx={{ isClassification: true }} />);
    expect(view.container.querySelector('.message-card-self-stake')).toHaveTextContent('自押 0/0');
  });
  it('places the classification sender investment beside its type without replacing settlement statistics', () => {
    const message = { ...category, spending: { protocol: 1, wager: 2, recommendation: 3 } };
    const view = render(<ClassificationCard msg={message} selectedUnits={[]} box={{ x: 0, y: 0, width: 340 }}
      targetCount={1} title={message.content} activeText={false} isWhole={false} isActive={false} isStanceTarget={false}
      homeLabel={null} stakes={{ truth: { pro: 99, con: 0 }, value: { pro: 88, con: 0 } }}
      relatedJoinRelations={[]} outgoingJoinRelations={[]} isJoinEffective={() => false}
      cardRef={null} headerRef={null} contentRef={null} onMessageClick={vi.fn()} onMessageDoubleClick={vi.fn()} onTextMouseUp={vi.fn()}
      onSettlementToggleTruth={vi.fn()} onSettlementToggleValue={vi.fn()} />);
    expect(view.container.querySelector('.message-card-type-group .message-card-self-stake')).toHaveTextContent('自押 2/3');
    expect(view.container.querySelector('[data-settlement-statistics="TRUTH"]')).toHaveTextContent('99');
    expect(view.container.querySelector('[data-settlement-statistics="VALUE"]')).toHaveTextContent('88');
    expect(view.getByTitle('真假仲裁')).toBeInTheDocument(); expect(view.getByTitle('价值仲裁')).toBeInTheDocument();
  });
  it('keeps the operations message ID in its header alongside its type',()=>{
    const message:DemoMessage={...category,id:'operation-record',kind:'operations',backendKind:'OPERATIONS',relationType:'operations'};
    const view=render(<MessageCard msg={message} ctx={{isGovernanceMsg:true}}/>);
    expect(view.getByText('operation-record')).toBeInTheDocument();
    expect(view.getByText('运营')).not.toHaveAttribute('role');
  });
  it.each(['governance', 'code', 'operations', 'round', 'round_result'] as const)('shows the complete %s ID instead of repeating its type in the identifier', kind => {
    const message: DemoMessage = { ...category, id: `完整-${kind}-message-id-1234567890`, kind, relationType: undefined, backendKind: kind.toUpperCase() };
    const view = render(<MessageCard msg={message} ctx={{}} />);
    const identifier = view.container.querySelector('.message-card-id')!;
    expect(identifier).toHaveTextContent(message.id);
    expect(identifier).toHaveAttribute('title', message.id);
  });
  it('preserves context relation types and record labels without swallowing the secondary content', () => {
    const message: DemoMessage = { ...category, relationType: 'reply' };
    const view = render(<MessageCard msg={message} ctx={{ relType: 'notify' }} />);
    expect(view.container.querySelector('[data-skin-type-label]')).toHaveTextContent(/^通知$/);
    const question: DemoMessage = { ...message, relationPayload: { label: 'question' } };
    view.rerender(<MessageCard msg={question} ctx={{ relType: 'notify' }} />);
    expect(view.container.querySelector('[data-skin-type-label]')).toHaveTextContent(/^疑问$/);
    view.rerender(<MessageCard msg={question} ctx={{ isRelationRecord: true, relType: 'notify' }}><span>疑问：是否延长开放时间</span></MessageCard>);
    expect(view.container.querySelector('[data-skin-type-label]')).toHaveTextContent(/^通知$/);
    expect(view.getByText('疑问：是否延长开放时间')).toBeInTheDocument();
  });
  it.each(['merge','arrange'] as const)('places the %s ID above its arbitration entries', kind => {
    const message={...category,id:'frame',relationType:kind};
    const view=render(<OrganizationFrameHeader message={message} messageId="frame" kind={kind} memberCount={1} selectedUnits={[]} activeText={false} onTruth={vi.fn()} onValue={vi.fn()}/>);
    const identity=view.getByText('frame'),actions=view.container.querySelector<HTMLElement>('[data-message-settlement-actions]')!;
    expect(identity.compareDocumentPosition(actions)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(identity.closest('[data-card-header]')!.parentElement).toBe(actions.parentElement);
    const header=view.container.querySelector('[data-organization-card-header]')!;
    const type=view.getByText(kind==='merge'?'归并':'排列');
    expect(header.firstElementChild?.contains(type)).toBe(true);
    expect(type.compareDocumentPosition(identity)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('puts an expanded summary ID before its text, level with the external arbitration row',()=>{
    const view=render(<OrganizationFrameHeader message={{...category,id:'summary',content:'总结正文',relationType:'summary'}} messageId="summary" kind="summary" memberCount={1} selectedUnits={[]} activeText={false}/>);
    expect(view.getByText('summary').compareDocumentPosition(view.getByText('总结正文'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it.each(['classify','summary','merge','arrange'] as const)('keeps the expanded %s type and member count descriptive', kind => {
    const message = { ...category, relationType: kind };
    const select = vi.fn(), navigate = vi.fn(), selectPart = vi.fn((event: Event) => (event as CustomEvent<PartSelectionDetail>).detail);
    window.addEventListener(PART_SELECTION_EVENT, selectPart);
    const view = render(<div onClick={select} onDoubleClick={navigate}><OrganizationFrameHeader message={message} messageId={message.id}
      kind={kind} memberCount={1} selectedUnits={[]} activeText={false}/></div>);
    const typeLabel = view.container.querySelector('[data-skin-type-label]')!;
    expect(typeLabel).not.toHaveAttribute('role');
    expect(typeLabel).not.toHaveAttribute('data-message-reference');
    expect(typeLabel).not.toHaveAttribute('tabindex');
    fireEvent.click(typeLabel); fireEvent.doubleClick(typeLabel);
    expect(select).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledOnce();
    expect(selectPart).not.toHaveBeenCalled();
    {
      select.mockClear();
      const memberCount = view.container.querySelector('[data-message-member-count]')!;
      for (const attribute of ['role', 'tabindex', 'data-message-reference', 'aria-pressed']) expect(memberCount).not.toHaveAttribute(attribute);
      fireEvent.click(memberCount);
      expect(selectPart).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalledOnce();
    }
    window.removeEventListener(PART_SELECTION_EVENT, selectPart);
  });
  it.each(['classify','summary'] as const)('retains the full expanded %s ID, sender stake and one arbitration row', kind => {
    const message = { ...category, id: '完整-frame-message-id-1234567890', relationType: kind, spending: { protocol: 1, wager: 2, recommendation: 3 } };
    const truth = vi.fn(), value = vi.fn();
    const view = render(<OrganizationFrameHeader message={message} messageId={message.id} kind={kind} memberCount={1} selectedUnits={[]} activeText={false}
      counts={{ truth: { pro: 99, con: 0 }, value: { pro: 88, con: 0 } }} onTruth={truth} onValue={value}/>);
    expect(view.container.querySelector('.organization-frame-id')).toHaveTextContent(message.id);
    expect(view.container.querySelector('.organization-frame-id')).toHaveAttribute('title', message.id);
    expect(view.container.querySelector('.organization-frame-type-group [data-message-self-stake]')).toHaveTextContent('自押 2/3');
    expect(view.container.querySelectorAll('[data-message-settlement-actions]')).toHaveLength(1);
    expect(view.container.querySelector('[data-settlement-statistics="TRUTH"]')).toHaveTextContent('99');
    expect(view.container.querySelector('[data-settlement-statistics="VALUE"]')).toHaveTextContent('88');
    fireEvent.click(view.getByTitle('真假仲裁')); fireEvent.click(view.getByTitle('价值仲裁'));
    expect(truth).toHaveBeenCalledExactlyOnceWith(message.id); expect(value).toHaveBeenCalledExactlyOnceWith(message.id);
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
    const navigate = vi.fn(), select = vi.fn(), selectPart = vi.fn();
    window.addEventListener(PART_SELECTION_EVENT, selectPart);
    const { getByText, queryByRole, container } = render(<ClassificationCard msg={category} selectedUnits={[]} box={{ x: 0, y: 0, width: 340 }}
      targetCount={1} title={category.content} activeText={false} isWhole={false} isActive={false} isStanceTarget={false}
      homeLabel={null} relatedJoinRelations={[]} outgoingJoinRelations={[]} isJoinEffective={()=>false}
      cardRef={null} headerRef={null} contentRef={null} onMessageClick={select} onMessageDoubleClick={navigate} onTextMouseUp={vi.fn()} />);
    const typeLabel = getByText('分类');
    expect(typeLabel).not.toHaveAttribute('role');
    expect(typeLabel).not.toHaveAttribute('data-message-reference');
    fireEvent.click(typeLabel);
    expect(select).toHaveBeenCalledWith(expect.anything(), category.id);
    expect(selectPart).not.toHaveBeenCalled();
    fireEvent.doubleClick(getByText(category.content));
    fireEvent.doubleClick(container.querySelector('[data-msgid]')!);
    fireEvent.doubleClick(typeLabel);
    const memberCount = container.querySelector('[data-message-member-count]')!;
    expect(queryByRole('button', { name: '选择所含消息' })).toBeNull();
    for (const attribute of ['role', 'tabindex', 'data-message-reference', 'aria-pressed']) expect(memberCount).not.toHaveAttribute(attribute);
    fireEvent.click(memberCount);
    expect(selectPart).not.toHaveBeenCalled();
    fireEvent.doubleClick(memberCount);
    expect(navigate).toHaveBeenCalledTimes(4);
    expect(navigate.mock.calls.every(call => call[1] === category.id)).toBe(true);
    window.removeEventListener(PART_SELECTION_EVENT, selectPart);
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

  it.each(['normal','summary','classify','merge','arrange','annotation','reference','reply','notify','agree','disagree','tag','correct','delegation',
    'governance','code','operations','join','round','round_result'] as const)('keeps the %s type label descriptive and selects its whole card', type => {
    const contentKind = type === 'normal' || type === 'governance' || type === 'code' || type === 'operations' || type === 'join' || type === 'round' || type === 'round_result';
    const message: DemoMessage = { ...category, kind: contentKind ? type : 'relation', relationType: contentKind ? undefined : type,
      parts: type === 'normal' ? [category.parts![0], { id: 'membership', type: 'relation', relation: 'member-of', roles: { parent: [{ id: 'p', reference: { messageId: 'parent' } }] } }] : category.parts };
    const receive = vi.fn((event: Event) => (event as CustomEvent<PartSelectionDetail>).detail);
    const select = vi.fn();
    window.addEventListener(PART_SELECTION_EVENT, receive);
    const { container } = render(<MessageCard msg={message} ctx={{ isOrganizationMessage: ['summary','classify','merge'].includes(type), isSummary: type === 'summary', isClassification: type === 'classify', isMerge: type === 'merge', organizationTitle: message.content }} onClick={select} />);
    const typeLabel = container.querySelector('[data-skin-type-label]')!;
    expect(typeLabel).not.toHaveAttribute('role');
    expect(typeLabel).not.toHaveAttribute('data-message-reference');
    expect(typeLabel).not.toHaveAttribute('aria-pressed');
    expect(typeLabel).not.toHaveAttribute('tabindex');
    expect(typeLabel).not.toHaveAttribute('data-gesture-disabled');
    fireEvent.click(typeLabel);
    expect(select).toHaveBeenCalledWith(expect.anything(), message.id);
    expect(receive).not.toHaveBeenCalled();
    window.removeEventListener(PART_SELECTION_EVENT, receive);
  });
});
