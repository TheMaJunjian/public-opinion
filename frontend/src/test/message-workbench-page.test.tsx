import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import MessageWorkbenchPage from '../pages/MessageWorkbenchPage';
import type { Message, Relation, ScopeView, User } from '../types';
import { PART_SELECTION_EVENT } from '../utils/messageElementSelection';

const { mockApi, mockNavigate, mockGraphView } = vi.hoisted(() => {
  const mockApi = {
    getScope: vi.fn(),
    getMessages: vi.fn(),
    getAllMessages: vi.fn(),
    getWorkbenchSnapshot: vi.fn(),
    subscribeChanges: vi.fn(() => ({ close: vi.fn(), onmessage: null, onopen: null, onerror: null })),
    withCommandBatch: vi.fn<(work: () => Promise<unknown>, onCommitted?: (count: number) => void) => Promise<unknown>>(),
    cancelCommandBatch: vi.fn(),
    getRelations: vi.fn(),
    createMessage: vi.fn(),
    createRelation: vi.fn(),
    getAttentionUsers: vi.fn().mockResolvedValue({ data: {} }),
    getPointsBalance: vi.fn().mockResolvedValue({ points: { available: 100, locked: 0 }, balance: { amount: 100, debtFrozen: false } }),
    getPointsTransactions: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
    getMessageStakes: vi.fn().mockResolvedValue({ messageId: '', pool: { lockedPro: 0, lockedCon: 0 }, stakes: [], counts: { pro: 0, con: 0 } }),
    getMessageRounds: vi.fn().mockResolvedValue({ data: [] }),
    getRoundDetail: vi.fn().mockResolvedValue(null),
    getCurrentRules: vi.fn().mockResolvedValue({ parameters: { selfStakeOnCreate: 10, minStake: 1, stakeFeeAmount: 1 } }),
    createRound: vi.fn(),
    castVote: vi.fn(),
    closeAndSettle: vi.fn(),
    getMessageTagCounts: vi.fn().mockResolvedValue({ counts: {} }),
  };
  mockApi.withCommandBatch.mockImplementation(async (work, onCommitted) => {
    const before = mockApi.createMessage.mock.calls.length + mockApi.createRelation.mock.calls.length;
    const result = await work();
    const count = mockApi.createMessage.mock.calls.length + mockApi.createRelation.mock.calls.length - before;
    if (count > 0) onCommitted?.(count);
    return result;
  });
  mockApi.getAllMessages.mockImplementation(async (...args: Parameters<typeof mockApi.getMessages>) => {
    const messages = await mockApi.getMessages(...args);
    const relations = await mockApi.getRelations();
    return {
      ...messages,
      data: [
        ...messages.data,
        ...relations.data.map((relation: Relation) => ({
          id: relation.id,
          kind: 'RELATION',
          contentType: 'TEXT',
          content: '',
          relationType: relation.relationType,
          relSourceId: relation.sourceMessageId,
          targetRefs: relation.targetRefs,
          relationPayload: relation.payload ?? null,
          createdAt: relation.createdAt,
          createdBy: relation.createdBy,
        })),
      ],
    };
  });
  mockApi.getWorkbenchSnapshot.mockImplementation(async ({ parent }: { parent: string }) => {
    const [scope, response, attention] = await Promise.all([mockApi.getScope(parent), mockApi.getAllMessages(parent), mockApi.getAttentionUsers(parent)]);
    const records = response.data as Message[];
    return {
      scope, messages: records,
      relations: records.filter(message => message.kind === 'RELATION').map(message => ({
        id: message.id, relationType: message.relationType,
        sourceMessageId: message.relSourceId ?? null, targetRefs: message.targetRefs ?? [],
        payload: message.relationPayload, createdAt: message.createdAt, createdBy: message.createdBy,
      })),
      users: [], stakes: {}, tagCounts: {}, attentionUsers: attention.data,
      sequence: 1, nextCursor: null, hasMore: false,
    };
  });
  return { mockApi, mockNavigate: vi.fn(), mockGraphView: vi.fn() };
});

vi.mock('../api', () => ({ api: mockApi }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
    logout: vi.fn(),
  }),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ messageId: 'classification-1' }),
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/messages/classification-1', state: null, key: '', search: '', hash: '' }),
    useSearchParams: () => [new URLSearchParams(), vi.fn()] as const,
  };
});
vi.mock('../components/GraphView', async () => {
  const actual = await vi.importActual<typeof import('../components/GraphView')>('../components/GraphView');
  return {
    ...actual,
    default: (props: any) => {
      mockGraphView(props);
      return <div data-testid="graph-view">{(props.comparisonPair||props.comparisonSingle)&&props.comparisonScopeHeader}</div>;
    },
  };
});

function makeUser(): User {
  return { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' };
}

function makeMessage(id: string, content: string): Message {
  return {
    id,
    kind: 'TEXT',
    contentType: 'TEXT',
    content,
    createdAt: '2024-01-01T00:00:00.000Z',
    createdBy: makeUser(),
  };
}

function makeRelation(): Relation {
  return {
    id: 'rel-1',
    relationType: 'REPLY',
    sourceMessageId: 'msg-2',
    targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
    createdAt: '2024-01-01T00:01:00.000Z',
    createdBy: makeUser(),
  };
}

describe('rejected child container boundaries and single-side comparison',()=>{
  const latest=()=>mockGraphView.mock.lastCall![0];
  const event=()=>({button:0,stopPropagation:vi.fn()});
  function fixture(type='CLASSIFY',joinOnly=false){
    const relation=(id:string,relationType:string,ids:string[]=[],sourceMessageId:string|null=null):Relation=>({id,relationType,sourceMessageId,targetRefs:ids.map(messageId=>({kind:'message',messageId})),payload:{title:id,targetLayout:'single-row'},createdAt:'2024-01-01T00:00:00Z',createdBy:makeUser()});
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'测试分类'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('B','A 内的 B')]});
    mockApi.getRelations.mockResolvedValue({data:[relation('A','CLASSIFY',['C']),relation('C',type,joinOnly?[]:['B']),...(joinOnly?[relation('join-B','JOIN',['B'],'C')]:[]),relation('against-C','DISAGREE',['C'])]});
  }
  beforeEach(()=>{vi.clearAllMocks();HTMLElement.prototype.scrollIntoView=vi.fn();});

  it('shows an exit for a classification opened directly from its URL', async () => {
    fixture();
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '退出分类' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('测试分类');
    fireEvent.click(screen.getByRole('button', { name: '退出分类' }));
    expect(mockNavigate).toHaveBeenCalledWith('/messages');
  });

  it('confirms a standalone text send when a message is selected', async () => {
    localStorage.setItem('token', 'test-token');
    fixture();
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(latest()?.messages.some((message: Message) => message.id === 'A')).toBe(true));
    await act(async () => latest().onMessageClick(event(), 'A'));
    fireEvent.change(screen.getByPlaceholderText('输入一条新普通消息（支持自由换行）'), { target: { value: '独立发言' } });
    fireEvent.click(document.querySelector('[data-guide-send="true"]')!);
    expect(screen.getByRole('dialog', { name: '确认发送文本消息' })).toBeInTheDocument();
    expect(mockApi.createMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mockApi.createMessage).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-guide-send="true"]')!);
    mockApi.createMessage.mockResolvedValueOnce(makeMessage('sent-confirmed', '独立发言'));
    fireEvent.click(screen.getByRole('button', { name: '仍然发送' }));
    await waitFor(() => expect(mockApi.createMessage).toHaveBeenCalledTimes(1));
  });

  it('keeps cross-classification references on a JOIN member and a member expanded inside an arrangement',async()=>{
    const relation=(id:string,relationType:string,targets:string[]=[],sourceMessageId:string|null=null):Relation=>({id,relationType,sourceMessageId,targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdAt:'2026-01-01',createdBy:makeUser()});
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'测试分类'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('source','引用来源'),makeMessage('target','引用目标') ]});
    mockApi.getRelations.mockResolvedValue({data:[relation('A','CLASSIFY'),relation('B','CLASSIFY',['frame']),relation('frame','ARRANGE'),relation('join-source','JOIN',['source'],'A'),relation('join-target','JOIN',['target'],'frame'),relation('reference','REFERENCE',['target'],'source')]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    expect(latest().crossClassifyRefs.get('source')?.outgoing['引用']).toEqual(['reference']);
    expect(latest().messages.some((message:Message)=>message.id==='target')).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    await act(async()=>latest().onMessageDoubleClick(event(),'B'));
    expect(latest().crossClassifyRefs.get('target')?.incoming['引用']).toEqual(['reference']);
  });

  it('shows one specific change for imported corrections instead of the legacy description or duplicate before/after panels',async()=>{
    const target=makeMessage('original','好玩吗？');
    const correction:Relation={id:'correct',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'text-fragment',messageId:'original',text:'吗？',hash:'fragment'}],payload:{correctionContent:'好玩1111'},parts:[{id:'body',type:'text',text:'建立关系：CORRECT；目标：original'}],createdAt:'2026-01-02',createdBy:makeUser()};
    const correctionMessage:Message={...makeMessage(correction.id,'建立关系：CORRECT；目标：original'),kind:'RELATION',relationType:'CORRECT',relationPayload:correction.payload,parts:correction.parts};
    mockApi.getWorkbenchSnapshot.mockResolvedValueOnce({scope:{messageId:'classification-1',title:'测试分类'},messages:[target,correctionMessage],relations:[correction],users:[],stakes:{},tagCounts:{},attentionUsers:{},personalStates:[],sequence:1,hasMore:false,nextCursor:null,removedMemberships:[],removedMessageIds:[]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='original')).toBe(true));
    fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
    const card=document.querySelector('[data-msgid="correct"]')!;
    expect(card).toHaveTextContent('具体更改');
    expect(card).toHaveTextContent('修改为「1111」');
    expect(card).not.toHaveTextContent('更正前');expect(card).not.toHaveTextContent('更正后');
    expect(card).not.toHaveTextContent('建立关系：CORRECT');
  });

  it('opens complete member JOIN history from the list, including inactive records outside the current container',async()=>{
    fixture('CLASSIFY',true);
    const original=await mockApi.getRelations();
    const older:Relation={id:'older-B',relationType:'JOIN',sourceMessageId:'elsewhere',targetRefs:[{kind:'message',messageId:'B'}],createdAt:'2023-01-01',createdBy:makeUser()};
    mockApi.getRelations.mockResolvedValue({data:[...original.data.filter((relation:Relation)=>relation.id!=='against-C'),older]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await act(async()=>latest().onMessageDoubleClick(event(),'C'));
    fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
    fireEvent.click(screen.getByRole('button',{name:'查看加入消息（2条）'}));
    expect(screen.getByText('加入记录临时分类（2）')).toBeInTheDocument();
    expect(document.querySelector('[data-msgid="join-B"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="older-B"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="B"]')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));
    expect(screen.getByText('A 内的 B')).toBeInTheDocument();
  });

  it('temporarily opens a preview container JOIN history and restores its preview on exit',async()=>{
    fixture('CLASSIFY',true);render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await act(async()=>latest().onRelatedMessageNavigate('C'));
    expect(latest().comparisonSingle).toBe(true);
    await act(async()=>latest().onJoinFilterClick('C','outgoing'));
    expect(screen.getByText('被加入记录临时分类（1）')).toBeInTheDocument();
    expect(latest().messages.map((message:Message)=>message.id)).toEqual(['join-B']);
    expect(latest().comparisonSingle).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));
    expect(latest().comparisonSingle).toBe(true);
    expect(latest().messages.map((message:Message)=>message.id)).toContain('C');
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
    expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('stages removal against the effective JOIN rather than against the member content',async()=>{
    localStorage.setItem('token','test-token');
    fixture('CLASSIFY',true);
    const response=await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({data:response.data.filter((relation:Relation)=>relation.id!=='against-C')});
    mockApi.createRelation.mockResolvedValue({id:'remove-B',relationType:'DISAGREE',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'join-B'}],createdAt:'2026-01-01',createdBy:makeUser()});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await act(async()=>latest().onMessageDoubleClick(event(),'C'));
    fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
    fireEvent.click(screen.getByRole('button',{name:'移出容器'}));
    expect(screen.getByRole('button',{name:/^目标消息 /})).toHaveTextContent('join-B');
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledWith('C',expect.objectContaining({relationType:'DISAGREE',targetRefs:[expect.objectContaining({reference:{messageId:'join-B'}})]})));
  });

  it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'])('keeps released B within A when its child %s C is rejected',async type=>{
    fixture(type);render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    expect(latest().messages.map((m:Message)=>m.id)).not.toContain('B');
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await waitFor(()=>expect(latest().messages.filter((m:Message)=>m.id==='B')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    await waitFor(()=>expect(latest().messages.map((m:Message)=>m.id)).not.toContain('B'));
  });

  it('shows the staged message ID instead of repeating its body in the staging area',async()=>{
    fixture();render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await act(async()=>latest().onMessageClick(event(),'B'));
    const staging=document.querySelector('[data-guide-selection-staging]')!;
    expect(staging).toHaveTextContent('B · 已选择整条');
    expect(staging).not.toHaveTextContent('A 内的 B');
    expect(latest().messages.find((message:Message)=>message.id==='B').content).toBe('A 内的 B');
    const selection=latest().draftUnits;
    const entry=screen.getByRole('button',{name:'暂存消息 B'});
    expect(entry).toHaveAttribute('aria-pressed','false');
    fireEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed','true');
    expect(entry).toHaveTextContent('A 内的 B');
    expect(latest().draftUnits).toEqual(selection);
    fireEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed','false');
    expect(entry).toHaveTextContent('B · 已选择整条');
    expect(entry).not.toHaveTextContent('A 内的 B');
    expect(latest().draftUnits).toEqual(selection);
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('toggles card text in staging, source and target without modifying collection membership',async()=>{
    fixture();
    const response=await mockApi.getRelations();response.data[0].payload.title='A 的分类正文';
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageClick(event(),'A'));
    const staged=screen.getByRole('button',{name:'暂存消息 A'});
    fireEvent.click(staged);expect(staged).toHaveTextContent('【分类】 A 的分类正文');expect(staged).not.toHaveTextContent('目标：');
    fireEvent.click(screen.getByRole('button',{name:'加入来源集合'}));
    const source=screen.getByRole('button',{name:/^来源消息 /});
    expect(source.textContent).toBe('【分类】 A');expect(source).toHaveAttribute('aria-pressed','false');
    fireEvent.click(source);expect(source.textContent).toBe('【分类】 A 的分类正文');
    fireEvent.click(source);expect(source.textContent).toBe('【分类】 A');
    expect(latest().draftUnits).toHaveLength(0);
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await act(async()=>latest().onMessageClick(event(),'B'));
    fireEvent.click(screen.getByRole('button',{name:'加入目标集合'}));
    const target=screen.getByRole('button',{name:/^目标消息 /});
    expect(target.textContent).toBe('【文本】 B');expect(target).toHaveAttribute('aria-pressed','false');
    fireEvent.click(target);expect(target.textContent).toBe('【文本】 A 内的 B');
    fireEvent.click(source);expect(source.textContent).toBe('【分类】 A 的分类正文');expect(target.textContent).toBe('【文本】 A 内的 B');
    fireEvent.click(target);expect(target.textContent).toBe('【文本】 B');expect(source).toHaveAttribute('aria-pressed','true');
    expect(latest().draftUnits).toHaveLength(0);
    expect(source.closest('li')!.parentElement!.parentElement).toHaveTextContent('1 项');
    expect(target.closest('li')!.parentElement!.parentElement).toHaveTextContent('1 项');
    fireEvent.click(target.closest('li')!.querySelector('button:last-child')!);
    expect(screen.queryByRole('button',{name:/^目标消息 /})).toBeNull();
    expect(source.textContent).toBe('【分类】 A 的分类正文');
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('previews JOIN-only contents as approved, then restores A, filters and selection without writes',async()=>{
    fixture('CLASSIFY',true);render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await waitFor(()=>expect(latest().messages.map((m:Message)=>m.id)).toContain('B'));
    await act(async()=>latest().onMessageClick(event(),'B'));
    const originalIds=latest().messages.map((m:Message)=>m.id),selection=latest().draftUnits;
    await act(async()=>latest().onRelatedMessageNavigate('C'));
    expect(screen.getByRole('region',{name:'单侧对比'})).toHaveTextContent('当前目标：C');
    expect(screen.getByRole('button',{name:'退出查看'}).closest('.workbench-right-panel')).not.toBeNull();
    expect(document.querySelector('.workbench-left-panel')?.textContent).not.toContain('退出查看');
    expect(document.querySelector('.workbench-left-panel')).not.toHaveClass('preview-mode');
    expect(latest().comparisonSingle).toBe(true);
    expect(screen.queryByRole('button',{name:'切换为消息表'})).toBeNull();
    expect(latest().comparisonDisplay).toBe('agree');expect(latest().comparisonPair).toBe(false);
    expect(latest().comparisonTargetId).toBe('C');
    expect(latest().rejectedContainerIds.has('C')).toBe(false);
    expect(latest().relatedMessages.find((m:Message)=>m.id==='C').state.suppressed).toBe(false);
    expect(latest().messages.map((m:Message)=>m.id)).toContain('C');
    expect(latest().messages.map((m:Message)=>m.id)).not.toContain('B');
    expect(latest().joinStatusByMessage.get('join-B')).toBe('valid');
    await act(async()=>latest().onDecorationIconClick('C','agree'));
    expect(mockApi.createRelation).not.toHaveBeenCalled();
    await act(async()=>latest().onMessageDoubleClick(event(),'C'));
    expect(latest().messages.map((m:Message)=>m.id)).toContain('B');
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    expect(latest().messages.map((m:Message)=>m.id)).toContain('C');
    fireEvent.click(screen.getByRole('button',{name:/清爽/}));
    fireEvent.click(screen.getByRole('checkbox',{name:'屏蔽加入消息'}));
    await act(async()=>latest().onCanvasBlankClick(event()));
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    await waitFor(()=>expect(screen.queryByRole('region',{name:'单侧对比'})).toBeNull());
    expect(latest().messages.map((m:Message)=>m.id)).toEqual(originalIds);
    expect(latest().draftUnits).toEqual(selection);
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
    expect(screen.getByRole('checkbox',{name:'屏蔽加入消息'})).toBeChecked();
    expect(screen.getByRole('button',{name:'退出分类'})).toBeInTheDocument();
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
  });

  it('returns to the message table after viewing its related container',async()=>{
    fixture();render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
    fireEvent.click(screen.getByRole('button',{name:/被反对的容器：1/}));
    fireEvent.click(screen.getByRole('button',{name:'查看'}));
    expect(screen.getByTestId('graph-view')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(screen.getByRole('button',{name:'切换为消息图'})).toBeInTheDocument();
    expect(screen.getByText('A 内的 B')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-view')).toBeNull();
  });

  it('can select a rejected container in the original comparison list and review both sides',async()=>{
    fixture();render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    const entry=await screen.findAllByText('C');
    fireEvent.click(entry[0]);
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    expect(latest().comparisonAgreeMessages.map((message:Message)=>message.id)).toContain('C');
    expect(latest().comparisonAgreeMessages.map((message:Message)=>message.id)).not.toContain('B');
    expect(latest().comparisonDisagreeMessages.map((message:Message)=>message.id)).toContain('B');
    expect(latest().comparisonAgreeContext.rejectedContainerIds.has('C')).toBe(false);
    expect(latest().comparisonDisagreeContext.rejectedContainerIds.has('C')).toBe(true);
    expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('preserves voted relation eligibility while finding nested targets hidden from the root canvas',async()=>{
    fixture('CLASSIFY',true);
    const original=await mockApi.getRelations();
    const extra=(id:string,relationType:string,target:string):Relation=>({id,relationType,sourceMessageId:null,targetRefs:[{kind:'message',messageId:target}],createdAt:'2024-01-01T00:00:00Z',createdBy:makeUser()});
    mockApi.getRelations.mockResolvedValue({data:[...original.data,
      extra('voted-reference','REFERENCE','B'),extra('agree-reference','AGREE','voted-reference'),
      extra('unvoted-reference','REFERENCE','B'),extra('agree-join','AGREE','join-B'),
    ]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('C');
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    expect(screen.getByText('选择对比消息（2）')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'退出临时分类'})).toBeNull();
    expect(document.querySelector('[data-msgid="A"]')).toBeNull();
    expect(document.querySelector('[data-msgid="C"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="join-B"]')).toBeNull();
    expect(document.querySelector('[data-msgid="voted-reference"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="unvoted-reference"]')).toBeNull();
    expect(document.querySelector('[data-msgid="B"]')).toBeNull();
    fireEvent.click(screen.getAllByText('C')[0]);
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    expect(latest().comparisonTargetId).toBe('C');
    expect(latest().comparisonAgreeMessages.map((message:Message)=>message.id)).toContain('C');
    expect(latest().comparisonDisagreeMessages.map((message:Message)=>message.id)).toContain('B');
    fireEvent.click(screen.getByRole('button',{name:'返回对比消息'}));
    expect(screen.getByText('选择对比消息（2）')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button',{name:'退出对比'})[0]);
    await waitFor(()=>expect(latest().comparisonPair).toBe(false));
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('B');
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('测试分类');
    expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('explains an empty chooser when no relation has a vote',async()=>{
    fixture();
    const original=await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({data:original.data.filter((relation:Relation)=>relation.relationType!=='DISAGREE')});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    expect(screen.getByText('选择对比消息（0）')).toBeInTheDocument();
    expect(screen.getByText('没有可对比的消息')).toBeInTheDocument();
    expect(screen.getByText('仅列出已有赞同或反对记录的关系消息，不含加入、结算等消息。')).toBeInTheDocument();
    expect(document.querySelector('[data-msgid="A"]')).toBeNull();
  });

  it('opens the comparison chooser from a single-side review, then restores that review and its selection',async()=>{
    fixture();render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await act(async()=>latest().onMessageClick(event(),'B'));
    const selection=latest().draftUnits;
    await act(async()=>latest().onRelatedMessageNavigate('C'));
    expect(screen.getByRole('region',{name:'单侧对比'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'退出临时分类'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    expect(screen.queryByRole('region',{name:'单侧对比'})).toBeNull();
    fireEvent.click(screen.getAllByText('C')[0]);
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    fireEvent.click(screen.getByRole('button',{name:'退出对比'}));
    expect(screen.getByRole('region',{name:'单侧对比'})).toBeInTheDocument();
    expect(latest().comparisonPair).toBe(false);
    expect(latest().comparisonDisplay).toBe('agree');
    expect(latest().comparisonTargetId).toBe('C');
    expect(latest().draftUnits).toEqual(selection);
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
    expect(latest().draftUnits).toEqual(selection);
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('uses the full comparison agree side and ordinary classification navigation without a separate viewer hierarchy',async()=>{
    fixture();
    const original=await mockApi.getRelations();
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('B','A 内的 B'),makeMessage('neighbor','同层邻居'),makeMessage('outside','外层消息')]});
    mockApi.getRelations.mockResolvedValue({data:[...original.data.map((relation:Relation)=>relation.id==='A'?{
      ...relation,targetRefs:[...relation.targetRefs,{kind:'message',messageId:'neighbor'}],
    }:relation),{
      ...original.data.find((relation:Relation)=>relation.id==='A'),id:'P',
      targetRefs:[{kind:'message',messageId:'A'}],payload:{title:'P'},
    }]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'P'));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await act(async()=>latest().onMessageClick(event(),'B'));
    const selection=latest().draftUnits;
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    fireEvent.click(screen.getAllByText('C')[0]);
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    const agreeInA={messages:latest().comparisonAgreeMessages,edges:latest().comparisonAgreeEdges,context:latest().comparisonAgreeContext};
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    const agreeInP={messages:latest().comparisonAgreeMessages,edges:latest().comparisonAgreeEdges,context:latest().comparisonAgreeContext};
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    const agreeAtRoot={messages:latest().comparisonAgreeMessages,edges:latest().comparisonAgreeEdges,context:latest().comparisonAgreeContext};
    fireEvent.click(screen.getByRole('button',{name:'退出对比'}));
    await act(async()=>latest().onRelatedMessageNavigate('C'));
    const single=()=>({messages:latest().messages,edges:latest().edges,context:{relatedMessages:latest().relatedMessages,rejectedContainerIds:latest().rejectedContainerIds,joinStatusByMessage:latest().joinStatusByMessage,crossClassifyRefs:latest().crossClassifyRefs}});
    expect(single()).toEqual(agreeInA);
    expect(latest().messages.map((message:Message)=>message.id)).toContain('neighbor');
    expect(screen.queryByRole('button',{name:'返回上层查看'})).toBeNull();
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('A');
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    expect(single()).toEqual(agreeInP);
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('C');
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('B');
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('P');
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    expect(single()).toEqual(agreeAtRoot);
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('C');
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('B');
    expect(latest().messages.map((message:Message)=>message.id)).toContain('outside');
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('测试分类');
    // Normal navigation and a comparison round-trip retain the root scope.
    await act(async()=>latest().onMessageDoubleClick(event(),'P'));
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    fireEvent.click(screen.getAllByRole('button',{name:'退出对比'})[0]);
    expect(single()).toEqual(agreeAtRoot);
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('C');
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('B');
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(screen.queryByRole('region',{name:'单侧对比'})).toBeNull();
    expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
    expect(latest().draftUnits).toEqual(selection);
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('A');
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('unwinds nested container previews before restoring the original scope',async()=>{
    fixture();
    const original=await mockApi.getRelations();
    const child={...original.data.find((r:Relation)=>r.id==='C'),id:'D',relationType:'CLASSIFY',targetRefs:[],payload:{title:'D'}};
    mockApi.getRelations.mockResolvedValue({data:[...original.data.map((relation:Relation)=>relation.id==='C'?{...relation,targetRefs:[...relation.targetRefs,{kind:'relation',relationId:'D'}]}:relation),child]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    const originalIds=latest().messages.map((m:Message)=>m.id);
    await act(async()=>latest().onRelatedMessageNavigate('C'));
    expect(latest().messages.map((m:Message)=>m.id)).toContain('C');
    expect(latest().messages.map((m:Message)=>m.id)).not.toContain('B');
    await act(async()=>latest().onMessageDoubleClick(event(),'C'));
    await act(async()=>latest().onMessageDoubleClick(event(),'D'));
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('D');
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('C');
    expect(latest().messages.map((m:Message)=>m.id)).toContain('B');
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    expect(latest().messages.map((m:Message)=>m.id)).toContain('C');
    expect(latest().messages.map((m:Message)=>m.id)).not.toContain('B');
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(screen.queryByRole('region',{name:'单侧对比'})).toBeNull();
    expect(latest().messages.map((m:Message)=>m.id)).toEqual(originalIds);
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
  });
});

describe('MessageWorkbenchPage home filter container projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue({ messageId: 'classification-1', title: '测试分类' });
    mockApi.getMessages.mockResolvedValue({ data: [makeMessage('hit', '命中消息')] });
    mockApi.getRelations.mockResolvedValue({ data: [
      {
        id: 'inner-arrange', relationType: 'ARRANGE', sourceMessageId: null,
        targetRefs: [],
        createdAt: '2024-01-01T00:01:00.000Z', createdBy: makeUser(),
      },
      {
        id: 'outer-classify', relationType: 'CLASSIFY', sourceMessageId: null,
        targetRefs: [],
        payload: { title: '外层容器' },
        createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
      },
      {
        id: 'join-hit', relationType: 'JOIN', sourceMessageId: 'inner-arrange',
        targetRefs: [{ kind: 'message', messageId: 'hit' }],
        createdAt: '2024-01-01T00:03:00.000Z', createdBy: makeUser(),
      },
      {
        id: 'join-inner', relationType: 'JOIN', sourceMessageId: 'outer-classify',
        targetRefs: [{ kind: 'relation', relationId: 'inner-arrange' }],
        createdAt: '2024-01-01T00:04:00.000Z', createdBy: makeUser(),
      },
    ] as Relation[] });
  });

  it('passes JOIN-only nested membership to the rendered graph and keeps its text behind the category in clean view',async()=>{
    const relation=(id:string,type:string,ids:string[]=[],source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,targetRefs:ids.map(messageId=>({kind:'message',messageId})),payload:{title:id},createdAt:'2024-01-01T00:00:00Z',createdBy:makeUser()});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('leaf','只在内层显示'),makeMessage('note','外层注释')]});
    mockApi.getRelations.mockResolvedValue({data:[relation('topic','CLASSIFY',['frame','annotation']),relation('frame','ARRANGE'),relation('category','CLASSIFY'),relation('join-category','JOIN',['category'],'frame'),relation('join-leaf','JOIN',['leaf'],'category'),relation('annotation','ANNOTATION',['leaf'],'note')]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(mockGraphView).toHaveBeenCalled());
    const latest=()=>mockGraphView.mock.lastCall![0];
    await act(async()=>latest().onMessageDoubleClick({stopPropagation:vi.fn()},'topic'));
    fireEvent.click(screen.getByRole('button',{name:/清爽/}));
    await waitFor(()=>{
      const props=latest();
      expect(props.messages.map((m:Message)=>m.id)).toContain('category');
      expect(props.messages.map((m:Message)=>m.id)).not.toContain('leaf');
      expect(props.edges.some((edge:any)=>edge.relationMessageId==='category'&&edge.to.messageId==='leaf')).toBe(true);
    });
    await act(async()=>latest().onMessageDoubleClick({stopPropagation:vi.fn()},'category'));
    await waitFor(()=>expect(latest().messages.map((m:Message)=>m.id)).toContain('leaf'));
  });

  it('shows the outer container entry without leaking its matched member', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '主页' }));
    fireEvent.click(screen.getByRole('radio', { name: /已读 · 自发/ }));

    await waitFor(() => {
      const graphProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const messageIds = new Set(graphProps.messages.map((message: { id: string }) => message.id));
      expect(messageIds).toEqual(new Set(['outer-classify']));
    });
  });

  it('restores join filtering on ordinary temporary-category exit but not on tag navigation', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /清爽/ }));

    const getLatestGraphProps = () => mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    await act(async () => {
      getLatestGraphProps().onJoinFilterClick('inner-arrange', 'outgoing');
    });
    expect(screen.getByRole('checkbox', { name: '屏蔽加入消息' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
    expect(screen.getByRole('checkbox', { name: '屏蔽加入消息' })).toBeChecked();

    await act(async () => {
      getLatestGraphProps().onJoinFilterClick('inner-arrange', 'outgoing');
    });
    await act(async () => {
      getLatestGraphProps().onNavigateToMessage('join-hit');
    });
    expect(screen.getByRole('checkbox', { name: '屏蔽加入消息' })).not.toBeChecked();
  });
});

describe('MessageWorkbenchPage composer refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({ data: [makeMessage('msg-1', '第一条'), makeMessage('msg-2', '第二条')] });
    mockApi.getRelations.mockResolvedValue({ data: [makeRelation()] });
  });

  it('keeps the left view free of height caps after sending', async () => {
    localStorage.setItem('token', 'test-token');
    mockApi.createMessage.mockResolvedValueOnce(makeMessage('sent-height-check', '新增消息'));
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 200, 500, 500));
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
      const left = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      expect(left.style.height).toBe('');
      expect(left.style.minHeight).toBe('');
      expect(left.style.maxHeight).toBe('');
      expect(left.style.flexGrow).toBe('1');
      expect(left.style.flexShrink).toBe('0');
      fireEvent.change(screen.getByPlaceholderText('输入一条新普通消息（支持自由换行）'), { target: { value: '新增消息' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => {
        expect(mockApi.createMessage).toHaveBeenCalled();
        expect(document.querySelector('[data-workbench-scroll-panel]')?.textContent).toContain('新增消息');
      });
      expect(document.querySelector<HTMLElement>('[data-workbench-left-panel]')).toBe(left);
      expect(left.style.height).toBe('');
      expect(left.style.minHeight).toBe('');
      expect(left.style.maxHeight).toBe('');
      expect(left.style.flexGrow).toBe('1');
    } finally {
      geometry.mockRestore();
    }
  });

  it.each([
    ['CLASSIFY', 'text'], ['SUMMARY', 'text'], ['CLASSIFY', 'relation'], ['SUMMARY', 'relation'],
  ])('keeps the nested %s and its parent history after sending and locating a %s', async (relationType, sentKind) => {
    localStorage.setItem('token', 'test-token');
    const inner: Relation = { ...makeRelation(), id: 'inner', relationType, sourceMessageId: null,
      targetRefs: ['msg-1', 'msg-2'].map(messageId => ({ kind: 'message', messageId })), payload: { title: '内层容器' } };
    const outer: Relation = { ...inner, id: 'outer', relationType: 'CLASSIFY',
      targetRefs: [{ kind: 'relation', relationId: inner.id }], payload: { title: '外层容器' } };
    const createdRelation: Relation = { ...inner, id: 'sent-inside', relationType: 'CLASSIFY',
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }], payload: { title: '在内层发送', independentMemberships: true } };
    const sent: Message = sentKind === 'text' ? makeMessage('sent-inside', '在内层发送') : {
      ...makeMessage(createdRelation.id, ''), kind: 'RELATION', relationType: createdRelation.relationType,
      relSourceId: null, targetRefs: createdRelation.targetRefs, relationPayload: createdRelation.payload,
    };
    const join: Relation = { ...makeRelation(), id: 'join-sent', relationType: 'JOIN', sourceMessageId: inner.id,
      targetRefs: [{ kind: 'message', messageId: sent.id }] };
    const memberJoin: Relation = { ...join, id: 'join-member', sourceMessageId: createdRelation.id,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }], createdAt: '2026-01-01' };
    mockApi.getRelations.mockResolvedValue({ data: [outer, inner] });
    if (sentKind === 'text') mockApi.createMessage.mockResolvedValueOnce(sent);
    else mockApi.createRelation.mockResolvedValueOnce(createdRelation);
    mockApi.withCommandBatch.mockImplementationOnce(async (work, onCommitted) => {
      await work();
      window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: [{
        scope: { messageId: 'classification-1', title: '测试分类' }, sequence: 2,
        messages: [sent, ...(sentKind === 'text' ? [join] : [join, memberJoin]).map(relation => ({
          ...makeMessage(relation.id, ''), kind: 'RELATION', relationType: relation.relationType,
          relSourceId: relation.sourceMessageId, targetRefs: relation.targetRefs,
        }))],
        relations: sentKind === 'text' ? [join] : [createdRelation, join, memberJoin],
        users: [], stakes: {}, tagCounts: {}, attentionUsers: {},
      }] }));
      onCommitted?.(1);
    });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
      const latest = () => mockGraphView.mock.lastCall![0];
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, outer.id));
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, inner.id));
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      if (sentKind === 'relation') {
        await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
        fireEvent.click(screen.getByRole('button', { name: '分类' }));
      }
      fireEvent.change(screen.getByPlaceholderText(sentKind === 'text' ? '输入一条新普通消息（支持自由换行）' : '输入分类名称（不能为空）'),
        { target: { value: '在内层发送' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(screen.getByText('已定位目标消息')).toBeInTheDocument());
      const exitInner = screen.getByRole('button', { name: relationType === 'SUMMARY' ? '退出总结' : '退出分类' });
      expect(exitInner.parentElement).toHaveTextContent('内层容器');
      expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${sent.id}"]`)).not.toBeNull();
      if (sentKind === 'text') expect(mockApi.createMessage).toHaveBeenCalledWith(inner.id, expect.objectContaining({ content: sent.content }));
      else {
        expect(mockApi.createRelation).toHaveBeenCalledWith(inner.id, expect.objectContaining({ relationType: 'CLASSIFY',
          targetRefs: [expect.objectContaining({ messageId: 'msg-1' })] }));
        expect(document.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')).toBeNull();
      }
      fireEvent.click(exitInner);
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('外层容器');
      fireEvent.click(screen.getByRole('button', { name: '退出分类' }));
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('测试分类');
    } finally {
      geometry.mockRestore();
    }
  });

  it('does not locate an appended JOIN or replace the current classification and active message', async () => {
    localStorage.setItem('token', 'test-token');
    const destination: Relation = { ...makeRelation(), id: 'destination', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [], payload: { title: '目标分类' } };
    const current: Relation = { ...destination, id: 'current', payload: { title: '当前分类' },
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'relation', relationId: destination.id }] };
    const join: Relation = { ...makeRelation(), id: 'appended-join', relationType: 'JOIN', sourceMessageId: destination.id,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }] };
    mockApi.getRelations.mockResolvedValue({ data: [current, destination] });
    mockApi.createRelation.mockResolvedValueOnce(join);
    render(<MessageWorkbenchPage />);
    await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
    const latest = () => mockGraphView.mock.lastCall![0];
    await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
    await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, destination.id));
    fireEvent.click(screen.getByRole('button', { name: '加入来源集合' }));
    await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
    fireEvent.click(screen.getByRole('button', { name: '分类' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })));
    expect(mockApi.createRelation).toHaveBeenCalledWith(current.id, expect.objectContaining({ relationType: 'JOIN', sourceMessageId: destination.id }));
    expect(latest().lastClickedMessageId).toBe('msg-1');
    expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
    expect(screen.queryByText('已定位目标消息')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('locates text and every relation in send order within the current classification, skipping generated JOINs', async () => {
    const displayedTargets: string[] = [];
    const transitions = new MutationObserver(() => {
      const active = document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid][style*="visibility: hidden"]');
      const id = active?.getAttribute('data-msgid');
      if (id && displayedTargets[displayedTargets.length - 1] !== id) displayedTargets.push(id);
    });
    localStorage.setItem('token', 'test-token');
    const current: Relation = { ...makeRelation(), id: 'current', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: ['msg-1', 'msg-2'].map(messageId => ({ kind: 'message', messageId })), payload: { title: '当前分类' } };
    const sent = makeMessage('sent-text', '同时发送文本和两条回复');
    const replies: Relation[] = ['msg-1', 'msg-2'].map((messageId, index) => ({ ...makeRelation(),
      id: `sent-reply-${index}`, sourceMessageId: sent.id, targetRefs: [{ kind: 'message', messageId }] }));
    const generatedJoin: Relation = { ...makeRelation(), id: 'generated-join', relationType: 'JOIN', sourceMessageId: current.id,
      targetRefs: [{ kind: 'message', messageId: sent.id }] };
    mockApi.getRelations.mockResolvedValue({ data: [current] });
    mockApi.createMessage.mockResolvedValueOnce(sent);
    replies.forEach(reply => mockApi.createRelation.mockResolvedValueOnce(reply));
    let finishCommit!: () => void;
    mockApi.withCommandBatch.mockImplementationOnce(async (work, onCommitted) => {
      await work();
      await new Promise<void>(resolve => { finishCommit = resolve; });
      const relations = [...replies, generatedJoin];
      window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: [{
        scope: { messageId: 'classification-1', title: '测试分类' }, sequence: 2,
        messages: [sent, ...relations.map(relation => ({ ...makeMessage(relation.id, ''), kind: 'RELATION',
          relationType: relation.relationType, relSourceId: relation.sourceMessageId, targetRefs: relation.targetRefs }))],
        relations, users: [], stakes: {}, tagCounts: {}, attentionUsers: {},
      }] }));
      onCommitted?.(3);
    });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
      const latest = () => mockGraphView.mock.lastCall![0];
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
      await act(async () => {
        latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1');
        latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-2');
      });
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      fireEvent.click(screen.getByRole('button', { name: '回复' }));
      fireEvent.change(screen.getByPlaceholderText('输入一条新普通消息（支持自由换行）'), { target: { value: sent.content } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(finishCommit).toBeDefined());
      expect(screen.queryByText('已定位目标消息')).toBeNull();
      transitions.observe(document.body, { subtree: true, childList: true, attributes: true });
      await act(async () => finishCommit());
      // Each next overlay replaces the current one as soon as it is ready.
      await waitFor(() => expect(displayedTargets).toEqual([sent.id, ...replies.map(reply => reply.id)]), { timeout: 1000 });
      expect(screen.getByText('已定位目标消息')).toBeInTheDocument();
      expect(document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="sent-text"]')?.style.visibility).toBe('');
      expect(document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="sent-reply-0"]')?.style.visibility).toBe('');
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
      await waitFor(() => expect(screen.queryByText('已定位目标消息')).toBeNull(), { timeout: 2500 });
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
      expect(mockApi.createMessage).toHaveBeenCalledOnce();
      expect(mockApi.createRelation).toHaveBeenCalledTimes(2);
      expect(mockNavigate).not.toHaveBeenCalled();
    } finally {
      transitions.disconnect();
      geometry.mockRestore();
    }
  });

  it('waits for delayed placement JOINs before locating a text sent inside a classification', async () => {
    localStorage.setItem('token', 'test-token');
    const current: Relation = { ...makeRelation(), id: 'current', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }], payload: { title: '当前分类' } };
    const sent = makeMessage('delayed-text', '等待归属更新后的文本');
    const join: Relation = { ...makeRelation(), id: 'delayed-join', relationType: 'JOIN', sourceMessageId: current.id,
      targetRefs: [{ kind: 'message', messageId: sent.id }] };
    mockApi.getRelations.mockResolvedValue({ data: [current] });
    mockApi.createMessage.mockResolvedValueOnce(sent);
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
      await act(async () => mockGraphView.mock.lastCall![0].onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      fireEvent.change(screen.getByPlaceholderText('输入一条新普通消息（支持自由换行）'), { target: { value: sent.content } });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })));
      // The optimistic text is present in data, but its membership has not arrived.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });
      expect(screen.queryByText('已定位目标消息')).toBeNull();
      expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
      await act(async () => window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: [{
        scope: { messageId: 'classification-1', title: '测试分类' }, sequence: 2,
        messages: [sent, { ...makeMessage(join.id, ''), kind: 'RELATION', relationType: join.relationType,
          relSourceId: join.sourceMessageId, targetRefs: join.targetRefs }],
        relations: [join], users: [], stakes: {}, tagCounts: {}, attentionUsers: {},
      }] })));
      await waitFor(() => expect(document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="delayed-text"]')?.style.visibility).toBe('hidden'));
      expect(screen.getByText('已定位目标消息')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: '正在发送' })).toBeNull();
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
    } finally {
      geometry.mockRestore();
    }
  });

  it('keeps the trace view after sending a message outside the trace', async () => {
    localStorage.setItem('token', 'test-token');
    mockApi.createMessage.mockResolvedValueOnce(makeMessage('sent-outside-trace', '追溯中发送'));
    render(<MessageWorkbenchPage />);
    await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
    await act(async () => mockGraphView.mock.lastCall![0].onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    expect(screen.getByRole('button', { name: '退出追溯' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    fireEvent.change(screen.getByPlaceholderText('输入一条新普通消息（支持自由换行）'), { target: { value: '追溯中发送' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })));
    expect(mockApi.createMessage).toHaveBeenCalledWith('classification-1', expect.objectContaining({ content: '追溯中发送' }));
    await waitFor(() => expect(screen.queryByText('正在发送消息并更新关联结构，请稍候…')).toBeNull(), { timeout: 2000 });
    expect(screen.getByRole('button', { name: '退出追溯' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出追溯' }));
    expect(screen.queryByRole('button', { name: '退出追溯' })).toBeNull();
  });

  it('locates a sent message with its overlay only after a slow commit finishes', async () => {
    let waitingForOverlay = false;
    let uncoveredTransition = false;
    const transitions = new MutationObserver(() => {
      const sending = screen.queryByRole('dialog', { name: '正在发送' });
      const located = screen.queryByText('已定位目标消息');
      if (sending) waitingForOverlay = true;
      if (waitingForOverlay && !sending && !located) uncoveredTransition = true;
      if (located) waitingForOverlay = false;
    });
    let finishCommit!: () => void;
    mockApi.createMessage.mockResolvedValueOnce(makeMessage('sent-message', '发送后定位'));
    mockApi.withCommandBatch.mockImplementationOnce(async (work, onCommitted) => {
      await work();
      await new Promise<void>(resolve => { finishCommit = resolve; });
      onCommitted?.(1);
    });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-workbench-left-panel')) return new DOMRect(0, 120, 600, 500);
      if (this.getAttribute('data-msgid') === 'sent-message') {
        const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]');
        return new DOMRect(20, 1000 - (panel?.scrollTop ?? 0), 300, 100);
      }
      return new DOMRect(0, 0, 100, 30);
    });
    try {
      render(<MessageWorkbenchPage />);
      const textarea = await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      Object.defineProperties(panel, { clientHeight: { value: 500 }, scrollHeight: { value: 2000 } });
      fireEvent.change(textarea, { target: { value: '发送后定位' } });
      transitions.observe(document.body, { subtree: true, childList: true, attributes: true });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(finishCommit).toBeDefined());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
      expect(screen.getByText('正在发送消息并更新关联结构，请稍候…')).toBeInTheDocument();
      expect(screen.queryByText('已定位目标消息')).toBeNull();
      expect(panel.scrollTop).toBe(0);
      await act(async () => finishCommit());
      await waitFor(() => expect(screen.getByText('已定位目标消息')).toBeInTheDocument());
      expect(screen.queryByText('正在发送消息并更新关联结构，请稍候…')).toBeNull();
      expect(uncoveredTransition).toBe(false);
      expect(panel.scrollTop).toBeGreaterThan(0);
    } finally {
      transitions.disconnect();
      geometry.mockRestore();
    }
  });

  it('locates a newly sent relation even when no text message was created', async () => {
    mockApi.createRelation.mockResolvedValueOnce({
      ...makeRelation(), id: 'sent-classification', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [], payload: { title: '发送分类后定位' },
    });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      fireEvent.click(screen.getByRole('button', { name: '分类' }));
      fireEvent.change(screen.getByPlaceholderText('输入分类名称（不能为空）'), { target: { value: '发送分类后定位' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(screen.getByText('已定位目标消息')).toBeInTheDocument());
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="sent-classification"]')).not.toBeNull();
      expect(mockApi.createMessage).not.toHaveBeenCalled();
    } finally {
      geometry.mockRestore();
    }
  });

  it('uses the global page for the natural right panel, preserving nested lists and boundary handoff', async () => {
    render(<MessageWorkbenchPage />);
    await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
    const left = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    const right = document.querySelector<HTMLElement>('[data-workbench-scroll-panel]')!;
    const page = document.documentElement;
    const pageHeight = vi.spyOn(page, 'clientHeight', 'get').mockReturnValue(200);
    const pageContentHeight = vi.spyOn(page, 'scrollHeight', 'get').mockReturnValue(1000);
    Object.defineProperties(left, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    Object.defineProperties(right, { clientHeight: { value: 1000 }, scrollHeight: { value: 1000 } });
    left.scrollTop = 200;
    page.scrollTop = 200;
    const wheel = (target: HTMLElement, deltaY: number, canceled: boolean) => {
      const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
      act(() => { target.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(canceled);
    };
    try {
      expect(right.style.maxHeight).toBe('');
      wheel(right, 120, true);
      expect(page.scrollTop).toBe(320);
      expect(right.scrollTop).toBe(0);
      expect(left.scrollTop).toBe(200);
      wheel(left, -120, true);
      expect(left.scrollTop).toBe(80);
      expect(page.scrollTop).toBe(320);
      page.scrollTop = 800;
      wheel(right, 120, true);
      expect(left.scrollTop).toBe(200);
      left.scrollTop = 0;
      wheel(left, -120, true);
      expect(page.scrollTop).toBe(680);

      const recent = screen.getByText('最近关系消息').nextElementSibling as HTMLElement;
      Object.defineProperties(recent, { clientHeight: { value: 100 }, scrollHeight: { value: 400 } });
      page.scrollTop = 800;
      wheel(recent.firstElementChild as HTMLElement, 120, true);
      expect(recent.scrollTop).toBe(120);
      expect(page.scrollTop).toBe(800);
      expect(left.scrollTop).toBe(0);

      // The list hands off to the page before it can move the opposite canvas.
      recent.scrollTop = 280;
      page.scrollTop = 740;
      wheel(recent.firstElementChild as HTMLElement, 60, true);
      expect(recent.scrollTop).toBe(300);
      expect(page.scrollTop).toBe(780);
      expect(left.scrollTop).toBe(0);
      wheel(recent.firstElementChild as HTMLElement, 60, true);
      expect(page.scrollTop).toBe(800);
      expect(left.scrollTop).toBe(40);
      wheel(recent.firstElementChild as HTMLElement, 60, true);
      expect(left.scrollTop).toBe(100);
      wheel(recent.firstElementChild as HTMLElement, -60, true);
      expect(recent.scrollTop).toBe(240);
      expect(page.scrollTop).toBe(800);
      expect(left.scrollTop).toBe(100);

      // The same ancestry order applies to nested content in the left canvas.
      const leftList = document.createElement('div');
      leftList.style.overflowY = 'auto';
      Object.defineProperties(leftList, { clientHeight: { value: 100 }, scrollHeight: { value: 400 } });
      left.append(leftList);
      left.scrollTop = 20;
      page.scrollTop = 20;
      leftList.scrollTop = 20;
      wheel(leftList, -100, true);
      expect([leftList.scrollTop, left.scrollTop, page.scrollTop]).toEqual([0, 0, 0]);
      wheel(leftList, 40, true);
      expect([leftList.scrollTop, left.scrollTop, page.scrollTop]).toEqual([40, 0, 0]);
    } finally {
      page.scrollTop = 0;
      pageHeight.mockRestore();
      pageContentHeight.mockRestore();
    }
  });

  it('keeps the selected classification itself as the new classification member', async () => {
    localStorage.setItem('token', 'test-token');
    const inner: Relation = { ...makeRelation(), id: 'inner-classify', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [], payload: { title: '内层分类' } };
    const outer: Relation = { ...inner, id: 'outer-classify', payload: { title: '外层分类', independentMemberships: true },
      targetRefs: [{ kind: 'relation', relationId: inner.id }] };
    const join: Relation = { ...makeRelation(), id: 'join-inner', relationType: 'JOIN', sourceMessageId: outer.id,
      targetRefs: [{ kind: 'relation', relationId: inner.id }] };
    mockApi.getRelations.mockResolvedValue({ data: [inner] });
    mockApi.createRelation.mockResolvedValue(outer);
    mockApi.withCommandBatch.mockImplementationOnce(async (work, onCommitted) => {
      const result = await work();
      onCommitted?.(1);
      const relations = [outer, join];
      window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: [{
        scope: { messageId: 'classification-1', title: '测试分类' }, sequence: 2,
        messages: relations.map(relation => ({ ...makeMessage(relation.id, ''), kind: 'RELATION', relationType: relation.relationType,
          relSourceId: relation.sourceMessageId, targetRefs: relation.targetRefs, relationPayload: relation.payload })),
        relations, users: [], stakes: {}, tagCounts: {}, attentionUsers: {},
      }] }));
      return result;
    });
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    await act(async () => mockGraphView.mock.lastCall![0].onMessageClick({ button: 0, stopPropagation: vi.fn() }, inner.id));
    fireEvent.click(screen.getByRole('button', { name: '分类' }));
    const textarea = screen.getByPlaceholderText('输入分类名称（不能为空）');
    fireEvent.change(textarea, { target: { value: '外层分类' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1', expect.objectContaining({
      relationType: 'CLASSIFY', targetRefs: [expect.objectContaining({ kind: 'relation', relationId: inner.id, reference: { messageId: inner.id } })],
    })));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    fireEvent.click(screen.getByRole('button', { name: '查看被加入消息（1条）' }));
    expect(screen.getByText('被加入记录临时分类（1）')).toBeInTheDocument();
    expect(document.querySelector('[data-msgid="join-inner"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
    fireEvent.doubleClick(screen.getByText(outer.id));
    fireEvent.click(screen.getByRole('button', { name: '查看加入消息（1条）' }));
    expect(screen.getByText('加入记录临时分类（1）')).toBeInTheDocument();
    expect(document.querySelector('[data-msgid="join-inner"]')).not.toBeNull();
  });

  it('opens the new classification’s generated JOINs immediately from its received send result', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    const classification: Relation = { ...makeRelation(), id: 'new-classify', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: ['msg-1', 'msg-2'].map(messageId => ({ kind: 'message', messageId })), payload: { title: '新分类', independentMemberships: true } };
    const joins: Relation[] = ['msg-1', 'msg-2'].map((messageId, index) => ({ ...makeRelation(), id: `generated-join-${index}`,
      relationType: 'JOIN', sourceMessageId: classification.id, targetRefs: [{ kind: 'message', messageId }] }));
    const relations = [classification, ...joins];
    const messages = relations.map(relation => ({ ...makeMessage(relation.id, ''), kind: 'RELATION', relationType: relation.relationType,
      relSourceId: relation.sourceMessageId, targetRefs: relation.targetRefs, relationPayload: relation.payload }));
    act(() => {
      window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: [{
        scope: { messageId: 'classification-1', title: '测试分类' }, sequence: 2, messages, relations,
        users: [], stakes: {}, tagCounts: {}, attentionUsers: {},
      }] }));
    });
    const latest = () => mockGraphView.mock.lastCall![0];
    await act(async () => latest().onJoinFilterClick(classification.id, 'outgoing'));
    expect(screen.getByText('被加入记录临时分类（2）')).toBeInTheDocument();
    expect(latest().messages.map((message: Message) => message.id).sort()).toEqual(joins.map(join => join.id).sort());
  });

  it('disables the send button while a message request is pending', async () => {
    localStorage.setItem('token', 'test-token');
    let resolveMessage!: (message: Message) => void;
    mockApi.createMessage
      .mockImplementationOnce(() => new Promise<Message>(resolve => { resolveMessage = resolve; }))
      .mockResolvedValue({
        id: 'round-pending', kind: 'ROUND', contentType: 'TEXT',
        content: '', createdAt: '2024-01-01T00:03:00.000Z', createdBy: makeUser(),
      });
    render(<MessageWorkbenchPage />);

    const textarea = await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
    fireEvent.change(textarea, { target: { value: '待发送消息' } });
    const sendButton = screen.getByRole('button', { name: '发送' });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sendButton).toBeDisabled());
    expect(mockApi.createMessage).toHaveBeenCalledTimes(1);

    resolveMessage({
      id: 'msg-pending', kind: 'TEXT', contentType: 'TEXT',
      content: '待发送消息', createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
    });
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(sendButton).toBeDisabled();
    expect(mockApi.createMessage).toHaveBeenCalledTimes(1);
    expect(mockApi.createMessage).toHaveBeenCalledWith('classification-1', expect.objectContaining({ wager: 0, recommendation: 0, selfAgree: false }));
  });

  it('preserves a pinned body range through the original stance and send controls', async () => {
    const target = { ...makeMessage('msg-1', '重复 / 重复'), revision: 3, parts: [{ id: 'body', type: 'text' as const, text: '重复 / 重复' }] };
    mockApi.getMessages.mockResolvedValue({ data: [target] });
    mockApi.createRelation.mockImplementation(async (_parent, data) => ({ ...makeRelation(), ...data, id: 'new-stance' }));
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    const reference = { messageId: 'msg-1', revision: 3, partId: 'body', range: { start: 5, end: 7 } };
    act(() => { window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT, { detail: { reference, label: '正文选区' } })); });
    fireEvent.click(screen.getByRole('button', { name: '反对' }));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1', expect.objectContaining({
      relationType: 'DISAGREE', targetRefs: [expect.objectContaining({ reference })], wager: 0, recommendation: 0,
    })));
  });

  it('restores the composer and optimistic cards when the atomic submission fails', async () => {
    mockApi.createMessage.mockResolvedValue({ ...makeMessage('uncommitted', '尚未提交'), revision: 1 });
    mockApi.withCommandBatch.mockImplementationOnce(async work => { await work(); throw new Error('整批提交失败'); });
    render(<MessageWorkbenchPage />);
    const textarea = await screen.findByPlaceholderText('输入一条新普通消息（支持自由换行）');
    fireEvent.change(textarea, { target: { value: '尚未提交' } });
    fireEvent.change(screen.getByLabelText('推荐投入'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('整批提交失败');
    expect(textarea).toHaveValue('尚未提交');
    expect(screen.getByLabelText('推荐投入')).toHaveValue(4);
    expect(mockGraphView.mock.calls.at(-1)![0].messages.some((message: { id: string }) => message.id === 'uncommitted')).toBe(false);
  });

  it('re-enables the textarea after clearing draft targets and switching relation types', async () => {
    render(<MessageWorkbenchPage />);

    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    // TAG auto-selects "推荐" as secondary — don't click it again or it toggles off
    fireEvent.click(screen.getByRole('button', { name: '标注' }));
    fireEvent.click(screen.getByText('rel-1'));

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('已选择附加关系，此处不可输入');
      expect(textarea).toHaveAttribute('readonly');
    });

    fireEvent.click(screen.getByRole('button', { name: '清空' }));

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('输入一条新普通消息（支持自由换行）');
      expect(textarea).not.toHaveAttribute('readonly');
    });

    fireEvent.click(screen.getByRole('button', { name: '引用' }));
    expect(screen.getByText('请在画布中选择目标消息')).toBeInTheDocument();
  });

  it('keeps a visible reference when a later delta does not mention it', async () => {
    vi.useFakeTimers();
    const source = makeMessage('source-1', '来源消息');
    const reference = {
      id: 'ref-1', kind: 'REFERENCE' as const, contentType: 'TEXT' as const,
      content: '引用消息', createdAt: '2024-01-01T00:02:00.000Z',
      createdBy: makeUser(),
    };
    const referenceRelation: Relation = {
      id: 'ref-1', relationType: 'REFERENCE', sourceMessageId: 'source-1',
      targetRefs: [{ kind: 'message', messageId: 'source-1' }],
      createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
    };
    mockApi.getMessages
      .mockResolvedValueOnce({ data: [source, reference] })
      .mockResolvedValue({ data: [source] });
    mockApi.getRelations
      .mockResolvedValueOnce({ data: [referenceRelation] })
      .mockResolvedValue({ data: [] });

    render(<MessageWorkbenchPage />);
    await act(async () => {});
    const initialGraphProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1]?.[0];
    expect(initialGraphProps.messages.some((m: { id: string }) => m.id === 'ref-1')).toBe(true);

    const sourceStream = mockApi.subscribeChanges.mock.results.at(-1)?.value as unknown as EventSource;
    const requestsBeforeEvent = mockApi.getWorkbenchSnapshot.mock.calls.length;
    await act(async () => { sourceStream.onmessage?.(new MessageEvent('message')); vi.advanceTimersByTime(30); });
    await act(async () => {});
    expect(mockApi.getWorkbenchSnapshot.mock.calls.length).toBeGreaterThan(requestsBeforeEvent);
    const refreshedGraphProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1]?.[0];
    expect(refreshedGraphProps.messages.some((m: { id: string }) => m.id === 'ref-1')).toBe(true);
    vi.useRealTimers();
  });
});

describe('MessageWorkbenchPage nested-classify merge expansion', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    // Normal text messages
    mockApi.getMessages.mockResolvedValue({
      data: [
        { id: 'msg-a', contentType: 'TEXT', content: '消息A', createdAt: '2024-01-01T00:00:00.000Z', createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' } },
        { id: 'msg-b', contentType: 'TEXT', content: '消息B', createdAt: '2024-01-01T00:01:00.000Z', createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' } },
      ],
    });
    // Relations:
    //   rel-merge  (MERGE)    → targets msg-a, msg-b
    //   rel-inner  (CLASSIFY) → targets rel-merge (nested classify owning the merge)
    //   rel-outer  (CLASSIFY) → targets rel-inner (outer classify containing the inner classification)
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-merge', relationType: 'MERGE', sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-a' }, { kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-inner', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }],
          payload: { title: '内层分类' },
          createdAt: '2024-01-01T00:03:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-outer', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-inner' }],
          payload: { title: '外层分类' },
          createdAt: '2024-01-01T00:04:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      ],
    });
  });

  it('shows only outer classify targets and their related messages after entering classification', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    // Switch to list view
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));

    // On the main canvas only the outer classify classification card should be visible;
    // msg-a, msg-b, rel-merge, and rel-inner are hidden (classified away).
    await waitFor(() => {
      expect(screen.getByText('rel-outer')).toBeInTheDocument();
    });
    expect(screen.queryByText('msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类 rel-inner')).not.toBeInTheDocument();

    // Enter the outer classification by double-clicking its card
    fireEvent.doubleClick(screen.getByText('rel-outer'));

    // After entering outer-classification focus, only the direct CLASSIFY target (rel-inner)
    // should be shown as a classification card. Nested CLASSIFY/SUMMARY are opaque — their
    // internal content (rel-merge, msg-a, msg-b) should NOT be expanded into this view.
    await waitFor(() => {
      expect(screen.getByText('rel-inner')).toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
  });
});

describe('MessageWorkbenchPage deeply nested classify → classify → merge', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    // Normal text messages
    mockApi.getMessages.mockResolvedValue({
      data: [
        { id: 'msg-a', contentType: 'TEXT', content: '消息A', createdAt: '2024-01-01T00:00:00.000Z', createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' } },
        { id: 'msg-b', contentType: 'TEXT', content: '消息B', createdAt: '2024-01-01T00:01:00.000Z', createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' } },
      ],
    });
    // Relations:
    //   rel-merge   (MERGE)    → targets msg-a, msg-b
    //   rel-inner   (CLASSIFY) → targets rel-merge
    //   rel-middle  (CLASSIFY) → targets rel-inner  (nested classify inside outer)
    //   rel-outer   (CLASSIFY) → targets rel-middle (outermost classification)
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-merge', relationType: 'MERGE', sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-a' }, { kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-inner', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }],
          payload: { title: '内层分类' },
          createdAt: '2024-01-01T00:03:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-middle', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-inner' }],
          payload: { title: '中层分类' },
          createdAt: '2024-01-01T00:04:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-outer', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-middle' }],
          payload: { title: '外层分类' },
          createdAt: '2024-01-01T00:05:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      ],
    });
  });

  it('shows only outer classify targets and their related messages in deeply nested case', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    // Switch to list view
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));

    // On the main canvas only the outer classify classification card should be visible.
    await waitFor(() => {
      expect(screen.getByText('rel-outer')).toBeInTheDocument();
    });
    expect(screen.queryByText('msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类 rel-inner')).not.toBeInTheDocument();
    expect(screen.queryByText('分类 rel-middle')).not.toBeInTheDocument();

    // Enter the outer classification by double-clicking its card.
    fireEvent.doubleClick(screen.getByText('rel-outer'));

    // After entering outer-classification focus, only the direct CLASSIFY target (rel-middle)
    // should be shown as a classification card. Nested CLASSIFY/SUMMARY are opaque — their
    // internal content (rel-inner, rel-merge, msg-a, msg-b) should NOT be expanded.
    await waitFor(() => {
      expect(screen.getByText('rel-middle')).toBeInTheDocument();
    });
    expect(screen.queryByText('msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类 rel-inner')).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('rel-middle'));

    const exitButton = await screen.findByRole('button', { name: '退出分类' });
    fireEvent.click(exitButton);
    await waitFor(() => {
      expect(screen.getByText('rel-middle')).toBeInTheDocument();
    });

  });

});

describe('MessageWorkbenchPage summary relation visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-1', '第一条'),
        makeMessage('msg-2', '第二条'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-summary',
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
          payload: { title: '总结观点', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('hides summary targets only in graph view and shows only summary targets in summary focus', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    // Graph view receives summary relation message for rendering.
    await waitFor(() => {
      expect(mockGraphView).toHaveBeenCalled();
    });
    const latestGraphProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1]?.[0];
    expect(latestGraphProps?.messages?.some((m: { id: string }) => m.id === 'rel-summary')).toBe(true);
    expect(latestGraphProps?.messages?.some((m: { id: string }) => m.id === 'msg-1')).toBe(false);

    // In list view, summary target text should remain visible.
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-summary')).toBeInTheDocument();
    });
    expect(screen.getByText('msg-1')).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('rel-summary'));
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出总结' }).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('msg-1')).toBeInTheDocument();
    expect(screen.queryByText('总结 rel-summary')).not.toBeInTheDocument();
  });

  it('keeps a reference whose target is a summary message in the graph', async () => {
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-summary',
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
          payload: { title: '总结观点', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-reference',
          relationType: 'REFERENCE',
          sourceMessageId: 'msg-2',
          targetRefs: [{ kind: 'relation', relationId: 'rel-summary' }],
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });

    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const latestGraphProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1]?.[0];
    expect(latestGraphProps?.messages?.some((m: { id: string }) => m.id === 'rel-reference')).toBe(true);
    expect(latestGraphProps?.edges?.some((e: { relationMessageId: string }) => e.relationMessageId === 'rel-reference')).toBe(true);
  });
});

describe('MessageWorkbenchPage merge frame double-click popup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [makeMessage('msg-1', '第一条')],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-merge',
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
          payload: { title: '归并标签', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows creator and send time popup when merge frame label is double-clicked', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    act(() => {
      latestProps.onGroupFrameDoubleClick(
        { stopPropagation: vi.fn(), clientX: 120, clientY: 140 } as unknown as React.MouseEvent,
        'rel-merge'
      );
    });

    await waitFor(() => {
      expect(screen.getByText('归并关系信息')).toBeInTheDocument();
      expect(screen.getByText(/创建者：/)).toBeInTheDocument();
      expect(screen.getByText(/发送时间：/)).toBeInTheDocument();
    });
  });
});

describe('MessageWorkbenchPage classify containing merge with nested classify target', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-a', '消息A'),
        makeMessage('msg-b', '消息B'),
        makeMessage('msg-c', '消息C'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-inner',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-c' }],
          payload: { title: '内层分类' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-merge',
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-a' }, { kind: 'relation', relationId: 'rel-inner' }],
          createdAt: '2024-01-01T00:03:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-outer',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }, { kind: 'message', messageId: 'msg-b' }],
          payload: { title: '外层分类' },
          createdAt: '2024-01-01T00:04:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows outer classify targets and related nested messages when entering outer classify', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-outer')).toBeInTheDocument();
    });
    fireEvent.doubleClick(screen.getByText('rel-outer'));

    // After entering outer-classification focus:
    // - msg-b is a direct text target, should be visible
    // - rel-merge (MERGE) is a direct relation target, should be expanded as a frame
    // - msg-a is inside rel-merge, should be visible (MERGE frames expand)
    // - rel-inner (CLASSIFY) is inside rel-merge, shown as classification card only
    // - msg-c is inside rel-inner, should NOT be visible (CLASSIFY is opaque)
    await waitFor(() => {
      expect(screen.getByText('rel-inner')).toBeInTheDocument();
    });
    expect(screen.getByText('msg-a')).toBeInTheDocument();
    expect(screen.getAllByText('msg-b').length).toBeGreaterThan(0);
    expect(screen.queryByText('msg-c')).not.toBeInTheDocument();
  });
});

describe('MessageWorkbenchPage MERGE graph frame visibility', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [makeMessage('msg-1', '第一条'), makeMessage('msg-2', '第二条')],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-merge',
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'message', messageId: 'msg-2' }],
          payload: { title: '归并标签', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('includes MERGE text targets in graphMessages so the frame can be rendered', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    // MERGE text targets must be in graphMessages for frame bounds computation.
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-1')).toBe(true);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-2')).toBe(true);
    // MERGE relation message itself must also be present.
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-merge')).toBe(true);
  });
});

describe('MessageWorkbenchPage CLASSIFY classification with arrange source visibility', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    // msg-a is the source of rel-supp; msg-b is the target
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-a', '排列来源'),
        makeMessage('msg-b', '被排列消息'),
      ],
    });
    // rel-supp: arrange (source=msg-a, target=msg-b)
    // rel-classify: CLASSIFY (targets=[rel-supp])
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-supp',
          relationType: 'arrange',
          sourceMessageId: 'msg-a',
          targetRefs: [{ kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-classify',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }],
          payload: { title: '分类' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows arrange relation and its source text when entering classify classification', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-classify')).toBeInTheDocument();
    });

    // Enter the classify classification
    fireEvent.doubleClick(screen.getByText('rel-classify'));

    await waitFor(() => {
      // The arrange relation message must be visible in the classification view
      expect(screen.getByText('rel-supp')).toBeInTheDocument();
    });
    // The arrange's source text (msg-a) must also be visible so its frame can render
    expect(screen.getByText('msg-a')).toBeInTheDocument();
    // The arrange's target text (msg-b) must be visible
    expect(screen.getAllByText('msg-b').length).toBeGreaterThan(0);
  });
});

describe('MessageWorkbenchPage SUMMARY classification with arrange source visibility', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-a', '排列来源'),
        makeMessage('msg-b', '被排列消息'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-supp',
          relationType: 'arrange',
          sourceMessageId: 'msg-a',
          targetRefs: [{ kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-summary',
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }],
          payload: { title: '总结观点', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows arrange relation and its source text when entering summary classification', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-summary')).toBeInTheDocument();
    });

    // Enter the summary classification
    fireEvent.doubleClick(screen.getByText('rel-summary'));

    await waitFor(() => {
      expect(screen.getByText('rel-supp')).toBeInTheDocument();
    });
    expect(screen.getByText('msg-a')).toBeInTheDocument();
    expect(screen.getAllByText('msg-b').length).toBeGreaterThan(0);
  });
});

describe('MessageWorkbenchPage MERGE with nested relation target graph visibility', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [makeMessage('msg-a', '消息A'), makeMessage('msg-b', '消息B')],
    });
    // rel-supp: arrange (source=msg-a, target=msg-b)
    // rel-merge: MERGE targeting [rel-supp]
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-supp',
          relationType: 'arrange',
          sourceMessageId: 'msg-a',
          targetRefs: [{ kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-merge',
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }],
          payload: { title: '归并标签' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('includes MERGE-owned relation messages in graphMessages for nested frame rendering', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    // The MERGE relation message must be visible
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-merge')).toBe(true);
    // The MERGE-owned arrange and its text targets must also be in graphMessages
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-supp')).toBe(true);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-a')).toBe(true);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-b')).toBe(true);
  });
});

describe('MessageWorkbenchPage CLASSIFY classification with CORRECT-related message', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    // msg-orig: original message classified by rel-classify
    // msg-corr: correcting message (source of rel-correct targeting msg-orig)
    // msg-other: unrelated message that should not appear in the classification view
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-orig', '原始消息'),
        makeMessage('msg-corr', '更正消息'),
        makeMessage('msg-other', '无关消息'),
      ],
    });
    // rel-correct: CORRECT (source=msg-corr, target=msg-orig)
    // rel-classify: CLASSIFY (targets=[msg-orig])
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-correct',
          relationType: 'CORRECT',
          sourceMessageId: 'msg-corr',
          targetRefs: [{ kind: 'message', messageId: 'msg-orig' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-classify',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-orig' }],
          payload: { title: '分类' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('hides both the classified message and its CORRECT-related message from list view', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-classify')).toBeInTheDocument();
    });

    // msg-orig is classified, so it should be hidden
    expect(screen.queryByText('msg-orig')).not.toBeInTheDocument();
    // msg-corr is CORRECT-related to msg-orig, so it should also be hidden
    expect(screen.queryByText('msg-corr')).not.toBeInTheDocument();
    // msg-other is unrelated and should still be visible
    expect(screen.getByText('msg-other')).toBeInTheDocument();
  });

  it('shows classified message and its CORRECT-related message when entering classify classification', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-classify')).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText('rel-classify'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    });
    // msg-orig (direct target) must be visible
    expect(screen.getByText('msg-orig')).toBeInTheDocument();
    // msg-corr (CORRECT-related to msg-orig) must be automatically included
    expect(screen.getByText('msg-corr')).toBeInTheDocument();
    // rel-correct (CORRECT relation message) must also be visible
    expect(screen.getByText('rel-correct')).toBeInTheDocument();
    // msg-other (unrelated) must NOT appear
    expect(screen.queryByText('msg-other')).not.toBeInTheDocument();
  });
});

describe('MessageWorkbenchPage SUMMARY classification with CORRECT-related message', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-orig', '原始消息'),
        makeMessage('msg-corr', '更正消息'),
      ],
    });
    // rel-correct: CORRECT (source=msg-corr, target=msg-orig)
    // rel-summary: SUMMARY (targets=[msg-orig])
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-correct',
          relationType: 'CORRECT',
          sourceMessageId: 'msg-corr',
          targetRefs: [{ kind: 'message', messageId: 'msg-orig' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-summary',
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-orig' }],
          payload: { title: '总结观点', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows summarized message and its CORRECT-related message when entering summary classification', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-summary')).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText('rel-summary'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出总结' }).length).toBeGreaterThan(0);
    });
    // msg-orig (direct target) must be visible
    expect(screen.getByText('msg-orig')).toBeInTheDocument();
    // msg-corr (CORRECT-related to msg-orig) must be automatically included
    expect(screen.getByText('msg-corr')).toBeInTheDocument();
    // rel-correct (CORRECT relation message) must also be visible
    expect(screen.getByText('rel-correct')).toBeInTheDocument();
  });

  it('hides CORRECT-related message from graph view when its counterpart is summarized', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    await waitFor(() => {
      expect(mockGraphView).toHaveBeenCalled();
    });
    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    // msg-orig is summarized → hidden from graph view
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-orig')).toBe(false);
    // msg-corr is CORRECT-related to msg-orig → also hidden from graph view
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-corr')).toBe(false);
    // rel-summary itself is visible (it's the classification card)
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-summary')).toBe(true);
  });

  it('keeps summary targets in the linear trace view without expanding the frame', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const initialProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    initialProps.onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'rel-summary');
    const traceButton = screen.getByRole('button', { name: '设为追溯消息' });
    await waitFor(() => expect(traceButton).not.toBeDisabled());
    fireEvent.click(traceButton);

    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('rel-summary')).toBe(true);
      expect(ids.has('msg-orig')).toBe(false);
      expect(ids.has('msg-corr')).toBe(false);
      expect(props.traceExpandedFrameIds.has('rel-summary')).toBe(false);
      expect(props.hideMessageIds?.has('rel-summary') ?? false).toBe(false);
    });

    const collapsedProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    collapsedProps.onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-summary');
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('msg-orig')).toBe(true);
      expect(ids.has('msg-corr')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-summary')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('msg-orig')).toBeInTheDocument();
      expect(screen.getByText('msg-corr')).toBeInTheDocument();
    });
  });
});

describe('MessageWorkbenchPage trace container frame projection', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('frame-member-a', '框架内部消息 A'),
        makeMessage('frame-member-b', '框架内部消息 B'),
        makeMessage('external-text', '引用分类的外部消息'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-classify', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [
            { kind: 'message', messageId: 'frame-member-a' },
            { kind: 'message', messageId: 'frame-member-b' },
          ],
          payload: { title: '分类框架' },
          createdAt: '2024-01-01T00:01:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'rel-reference', relationType: 'REFERENCE', sourceMessageId: 'external-text',
          targetRefs: [{ kind: 'relation', relationId: 'rel-classify' }],
          createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('traces the classify relation as a classification card with direct reference text', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const initialProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    initialProps.onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'rel-classify');
    const traceButton = screen.getByRole('button', { name: '设为追溯消息' });
    await waitFor(() => expect(traceButton).not.toBeDisabled());
    fireEvent.click(traceButton);

    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('rel-classify')).toBe(true);
      expect(ids.has('frame-member-a')).toBe(false);
      expect(ids.has('frame-member-b')).toBe(false);
      expect(ids.has('external-text')).toBe(true);
      expect(props.traceFrameIds.has('rel-classify')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-classify')).toBe(false);
      expect(props.edges.map((edge: { relationMessageId: string }) => edge.relationMessageId)).toContain('rel-classify');
    });
  });

  it('traces current membership without leaking a moved member outside its old frame', async () => {
    mockApi.getMessages.mockResolvedValue({ data: [makeMessage('moved', '已迁走'), makeMessage('stayed', '仍在原分类')] });
    const relation = (id: string, type: string, targets: string[], source: string | null = null, at = '2024-01-01'): Relation => ({
      id, relationType: type, sourceMessageId: source,
      targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
      payload: { title: id }, createdAt: at, createdBy: makeUser(),
    });
    mockApi.getRelations.mockResolvedValue({ data: [
      relation('old-frame', 'CLASSIFY', ['moved', 'stayed']), relation('new-frame', 'CLASSIFY', []),
      relation('old-join', 'JOIN', ['moved', 'stayed'], 'old-frame'),
      relation('new-join', 'JOIN', ['moved'], 'new-frame', '2024-01-02'),
    ] });
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    const latest = () => mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    act(() => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'old-frame'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    await waitFor(() => expect(latest().messages.map((item: { id: string }) => item.id)).toEqual(['old-frame']));
    act(() => latest().onMessageDoubleClick({ stopPropagation: vi.fn() }, 'old-frame'));
    await waitFor(() => {
      expect(latest().messages.map((item: { id: string }) => item.id).sort()).toEqual(['old-frame', 'stayed']);
      expect(latest().edges.filter((item: { relationMessageId: string }) => item.relationMessageId === 'old-frame')
        .map((item: { to: { messageId: string } }) => item.to.messageId)).toEqual(['stayed']);
    });
  });

  it.each([false, true])('keeps F at distance two when E references D inside a nested arrangement (JOINs: %s)', async withJoins => {
    mockApi.getMessages.mockResolvedValue({ data: ['D', 'E', 'F'].map(id => makeMessage(id, `正文 ${id}`)) });
    const relation = (id: string, type: string, targets: string[], source: string | null = null): Relation => ({
      id, relationType: type, sourceMessageId: source, targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
      payload: { title: id }, createdAt: '2024-01-01', createdBy: makeUser(),
    });
    mockApi.getRelations.mockResolvedValue({ data: [
      relation('A', 'CLASSIFY', ['B']), relation('B', 'CLASSIFY', ['E', 'C']), relation('C', 'ARRANGE', ['D', 'F']),
      relation('ref', 'REFERENCE', ['D'], 'E'),
      ...(withJoins ? [relation('join-a', 'JOIN', ['B'], 'A'), relation('join-b', 'JOIN', ['E', 'C'], 'B'),
        relation('join-c', 'JOIN', ['D', 'F'], 'C')] : []),
    ] });
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    const latest = () => mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    const ids = () => latest().messages.map((item: { id: string }) => item.id);
    // Enter B first, just as selecting E from its containing classification.
    act(() => latest().onMessageDoubleClick({ stopPropagation: vi.fn() }, 'A'));
    await waitFor(() => expect(ids()).toContain('B'));
    act(() => latest().onMessageDoubleClick({ stopPropagation: vi.fn() }, 'B'));
    await waitFor(() => expect(ids()).toContain('E'));
    act(() => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'E'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    await waitFor(() => expect(ids()).toEqual(['B']));
    act(() => latest().onMessageDoubleClick({ stopPropagation: vi.fn() }, 'B'));
    await waitFor(() => {
      expect(ids()).toEqual(expect.arrayContaining(['B', 'C', 'D', 'E', 'ref']));
      expect(ids()).not.toContain('F');
    });
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    expect(screen.queryByText('正文 F')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息图' }));
    await waitFor(() => expect(ids()).toContain('A'));
    act(() => latest().onMessageDoubleClick({ stopPropagation: vi.fn() }, 'A'));
    await waitFor(() => expect(ids()).toContain('B'));
    act(() => latest().onMessageDoubleClick({ stopPropagation: vi.fn() }, 'B'));
    await waitFor(() => expect(ids()).toContain('F'));
  });

  it.each(['MERGE', 'ARRANGE'])('respects distance changes around a %s in graph and list views', async type => {
    mockApi.getMessages.mockResolvedValue({ data: ['anchor', 'near', 'far'].map(id => makeMessage(id, `正文 ${id}`)) });
    mockApi.getRelations.mockResolvedValue({ data: [
      { id: 'ref', relationType: 'REFERENCE', sourceMessageId: 'anchor', targetRefs: [{ kind: 'message', messageId: 'near' }], createdAt: '2024-01-01', createdBy: makeUser() },
      { id: 'group', relationType: type, sourceMessageId: null, targetRefs: ['near', 'far'].map(messageId => ({ kind: 'message', messageId })), createdAt: '2024-01-02', createdBy: makeUser() },
    ] });
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    const latest = () => mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    const ids = () => latest().messages.map((item: { id: string }) => item.id);
    act(() => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'anchor'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    await waitFor(() => { expect(screen.getByText('追溯距离：1')).toBeInTheDocument(); expect(ids()).not.toContain('far'); });
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    await waitFor(() => { expect(screen.getByText('追溯距离：2')).toBeInTheDocument(); expect(ids()).toContain('far'); });
    fireEvent.click(screen.getByRole('button', { name: '-' }));
    await waitFor(() => expect(ids()).not.toContain('far'));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    expect(screen.queryByText('正文 far')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    await waitFor(() => expect(screen.getByText('正文 far')).toBeInTheDocument());
  });

  it('expands a summary frame that is nested inside the current classify classification', async () => {
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('summary-member-a', '总结内部消息 A'),
        makeMessage('summary-member-b', '总结内部消息 B'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-classify', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-summary' }],
          payload: { title: '外层分类' },
          createdAt: '2024-01-01T00:01:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'rel-summary', relationType: 'SUMMARY', sourceMessageId: null,
          targetRefs: [
            { kind: 'message', messageId: 'summary-member-a' },
            { kind: 'message', messageId: 'summary-member-b' },
          ],
          payload: { title: '内层总结' },
          createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
        },
      ] as Relation[],
    });

    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => expect(screen.getByText('rel-classify')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText('rel-classify'));
    await waitFor(() => expect(screen.getByText('rel-summary')).toBeInTheDocument());
    expect(screen.getByText('summary-member-a')).toBeInTheDocument();
    expect(screen.getByText('summary-member-b')).toBeInTheDocument();

    fireEvent.click(screen.getByText('rel-summary'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息图' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '退出追溯' })).toBeInTheDocument();
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      expect(props.traceFrameIds.has('rel-summary')).toBe(true);
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('rel-classify')).toBe(true);
      expect(ids.has('rel-summary')).toBe(false);
      expect(ids.has('summary-member-a')).toBe(false);
      expect(ids.has('summary-member-b')).toBe(false);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-classify')).toBe(true);
    });

    const traceProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    traceProps.onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-classify');
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      expect(props.messages.some((message: { id: string }) => message.id === 'rel-summary')).toBe(true);
    });
    const expandedParentProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    expandedParentProps.onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-summary');
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('summary-member-a')).toBe(true);
      expect(ids.has('summary-member-b')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-summary')).toBe(true);
    });
  });

  it('keeps a traced nested classify inside its parent frame', async () => {
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-d', '文本 D'),
        makeMessage('msg-f', '文本 F'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-a', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-b' }], payload: { title: '分类 A' },
          createdAt: '2024-01-01T00:01:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'rel-b', relationType: 'SUMMARY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-c' }], payload: { title: '总结 B' },
          createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'rel-c', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-d' }, { kind: 'relation', relationId: 'rel-e' }],
          payload: { title: '分类 C' }, createdAt: '2024-01-01T00:03:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'rel-e', relationType: 'MERGE', sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-f' }], payload: { title: '归并 E' },
          createdAt: '2024-01-01T00:04:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'join-a-b', relationType: 'JOIN', sourceMessageId: 'rel-a',
          targetRefs: [{ kind: 'relation', relationId: 'rel-b' }],
          createdAt: '2024-01-01T00:05:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'join-b-c', relationType: 'JOIN', sourceMessageId: 'rel-b',
          targetRefs: [{ kind: 'relation', relationId: 'rel-c' }],
          createdAt: '2024-01-01T00:06:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'join-c-members', relationType: 'JOIN', sourceMessageId: 'rel-c',
          targetRefs: [{ kind: 'message', messageId: 'msg-d' }, { kind: 'relation', relationId: 'rel-e' }],
          createdAt: '2024-01-01T00:07:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'join-e-f', relationType: 'JOIN', sourceMessageId: 'rel-e',
          targetRefs: [{ kind: 'message', messageId: 'msg-f' }],
          createdAt: '2024-01-01T00:08:00.000Z', createdBy: makeUser(),
        },
      ] as Relation[],
    });

    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => expect(screen.getByText('rel-a')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText('rel-a'));
    await waitFor(() => expect(screen.getByText('rel-b')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText('rel-b'));
    await waitFor(() => expect(screen.getByText('rel-c')).toBeInTheDocument());

    fireEvent.click(screen.getByText('rel-c'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息图' }));
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('rel-b')).toBe(true);
      expect(ids.has('rel-a')).toBe(false);
      expect(ids.has('rel-c')).toBe(false);
    });

    const traceProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    traceProps.onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-b');
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('rel-c')).toBe(true);
      expect(ids.has('rel-b')).toBe(true);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-b')).toBe(true);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-c')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-b')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-c')).toBe(false);
      expect(props.traceExpandedFrameIds.has('rel-e')).toBe(false);
    });
    const expandedParentProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    expandedParentProps.onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-c');
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('msg-d')).toBe(true);
      expect(ids.has('rel-e')).toBe(true);
      expect(ids.has('msg-f')).toBe(true);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-e')).toBe(true);
    });
  });

  it('keeps a nested classify as a card when its summary parent expands', async () => {
    mockApi.getMessages.mockResolvedValue({
      data: [makeMessage('classify-member', '分类内部消息')],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-summary', relationType: 'SUMMARY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-classify' }],
          payload: { title: '总结 A' }, createdAt: '2024-01-01T00:01:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'rel-classify', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'classify-member' }],
          payload: { title: '分类 B' }, createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
        },
      ] as Relation[],
    });

    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => expect(screen.getByText('rel-summary')).toBeInTheDocument());
    fireEvent.click(screen.getByText('rel-summary'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息图' }));

    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      expect(props.traceFrameIds.has('rel-summary')).toBe(true);
      expect(props.messages.some((message: { id: string }) => message.id === 'rel-classify')).toBe(false);
    });
    const traceProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    traceProps.onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-summary');
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('rel-classify')).toBe(true);
      expect(ids.has('classify-member')).toBe(false);
    });
  });

});

describe('MessageWorkbenchPage exit classify classification restores base view', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    // msg-a, msg-b: classified under rel-classify
    // msg-c: unclassified (should stay visible in base view)
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-a', '分类消息A'),
        makeMessage('msg-b', '分类消息B'),
        makeMessage('msg-c', '未分类消息C'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-classify',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-a' }, { kind: 'message', messageId: 'msg-b' }],
          payload: { title: '测试分类' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('restores base view correctly after entering and exiting a classify classification', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    // Switch to list view for easier assertions
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));

    // Base view: classification card visible, classified messages hidden, unclassified visible
    await waitFor(() => {
      expect(screen.getByText('rel-classify')).toBeInTheDocument();
    });
    expect(screen.queryByText('msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('msg-b')).not.toBeInTheDocument();
    expect(screen.getByText('msg-c')).toBeInTheDocument();

    // Enter the classify classification
    fireEvent.doubleClick(screen.getByText('rel-classify'));

    // Classification view: classified messages visible, classification card hidden, unclassified hidden
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('msg-a')).toBeInTheDocument();
    expect(screen.getByText('msg-b')).toBeInTheDocument();
    expect(screen.queryByText('msg-c')).not.toBeInTheDocument();

    // Exit the classify classification
    fireEvent.click(screen.getAllByRole('button', { name: '退出分类' })[0]);

    // After exit: base view should be restored exactly as before
    await waitFor(() => {
      expect(screen.getByText('rel-classify')).toBeInTheDocument();
    });
    expect(screen.queryByText('msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('msg-b')).not.toBeInTheDocument();
    expect(screen.getByText('msg-c')).toBeInTheDocument();
  });

  it('returns to the main view during trace and restores the classify position after exit', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => expect(screen.getByText('rel-classify')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText('rel-classify'));
    await waitFor(() => expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0));

    const classifyProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    classifyProps.onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-a');
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));

    await waitFor(() => {
      expect(screen.queryAllByRole('button', { name: '退出分类' })).toHaveLength(0);
      expect(screen.getByRole('button', { name: '退出追溯' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '退出追溯' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0));
    expect(screen.getByText('msg-a')).toBeInTheDocument();
    expect(screen.queryByText('msg-c')).not.toBeInTheDocument();
  });
});

describe('MessageWorkbenchPage CLASSIFY targeting arrange with nested CORRECT', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    // Simulating user's scenario: select m2, m1, m4, r10 (arrange), m7 → classify
    // r10 = arrange(source=m5, target=m6) — this is the key case
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('m1', '消息1'),
        makeMessage('m2', '消息2'),
        makeMessage('m3', '消息3'),
        makeMessage('m4', '消息4'),
        makeMessage('m5', '消息5（排列源）'),
        makeMessage('m6', '消息6（排列目标）'),
        makeMessage('m7', '消息7'),
        makeMessage('m8', '无关消息'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        // r3: REBUT (m3 → m2)
        {
          id: 'r3', relationType: 'REBUT',
          sourceMessageId: 'm3', targetRefs: [{ kind: 'message', messageId: 'm2' }],
          createdAt: '2024-01-01T00:01:00.000Z', createdBy: makeUser(),
        },
        // r4: CORRECT (m5 → m3)
        {
          id: 'r4', relationType: 'CORRECT',
          sourceMessageId: 'm5', targetRefs: [{ kind: 'message', messageId: 'm3' }],
          createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
        },
        // r8: DISAGREE (m3 → m1)
        {
          id: 'r8', relationType: 'DISAGREE',
          sourceMessageId: 'm3', targetRefs: [{ kind: 'message', messageId: 'm1' }],
          createdAt: '2024-01-01T00:03:00.000Z', createdBy: makeUser(),
        },
        // r10: arrange (source=m5, target=m6) — wraps m5→m6
        {
          id: 'r10', relationType: 'arrange',
          sourceMessageId: 'm5',
          targetRefs: [{ kind: 'message', messageId: 'm6' }],
          createdAt: '2024-01-01T00:04:00.000Z', createdBy: makeUser(),
        },
        // r11: REFERENCE (m7 → m5)
        {
          id: 'r11', relationType: 'REFERENCE',
          sourceMessageId: 'm7', targetRefs: [{ kind: 'message', messageId: 'm5' }],
          createdAt: '2024-01-01T00:05:00.000Z', createdBy: makeUser(),
        },
        // CLASSIFY targeting: m2, m1, m4, r10 (arrange), m7
        {
          id: 'rel-classify', relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [
            { kind: 'message', messageId: 'm2' },
            { kind: 'message', messageId: 'm1' },
            { kind: 'message', messageId: 'm4' },
            { kind: 'relation', relationId: 'r10' },
            { kind: 'message', messageId: 'm7' },
          ],
          payload: { title: '分类' },
          createdAt: '2024-01-01T00:06:00.000Z', createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('hides arrange source message (m5) and cascaded CORRECT targets from graph view', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    await waitFor(() => {
      expect(mockGraphView).toHaveBeenCalled();
    });
    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];

    // Directly classified text messages → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm1')).toBe(false);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm2')).toBe(false);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm4')).toBe(false);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm7')).toBe(false);
    // m6 (arrange target) → hidden via collectOwnedByRelation
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm6')).toBe(false);
    // m5 (arrange sourceMessageId) → MUST be hidden (was the bug!)
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm5')).toBe(false);
    // m3 (CORRECT target of m5) → hidden via expandTextIdsWithCorrections
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm3')).toBe(false);
    // r10 (arrange owned by CLASSIFY) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r10')).toBe(false);
    // r4 (CORRECT m5→m3, both endpoints hidden) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r4')).toBe(false);
    // r11 (REFERENCE m7→m5, both endpoints hidden) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r11')).toBe(false);
    // r3 (REBUT m3→m2, both endpoints hidden) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r3')).toBe(false);
    // r8 (DISAGREE m3→m1, both endpoints hidden) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r8')).toBe(false);
    // rel-classify → visible (classification card)
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-classify')).toBe(true);
    // m8 (unrelated) → visible
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm8')).toBe(true);
  });

  it('hides arrange source and cascaded messages from list view', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-classify')).toBeInTheDocument();
    });

    // Directly classified → hidden
    expect(screen.queryByText('m1')).not.toBeInTheDocument();
    expect(screen.queryByText('m2')).not.toBeInTheDocument();
    expect(screen.queryByText('m4')).not.toBeInTheDocument();
    expect(screen.queryByText('m7')).not.toBeInTheDocument();
    // m6 (arrange target) → hidden
    expect(screen.queryByText('m6')).not.toBeInTheDocument();
    // m5 (arrange sourceMessageId) → MUST be hidden (was the bug!)
    expect(screen.queryByText('m5')).not.toBeInTheDocument();
    // m3 (CORRECT cascade) → hidden
    expect(screen.queryByText('m3')).not.toBeInTheDocument();
    // Relation messages with all endpoints hidden → hidden
    expect(screen.queryByText('r10')).not.toBeInTheDocument();
    expect(screen.queryByText('r4')).not.toBeInTheDocument();
    expect(screen.queryByText('r11')).not.toBeInTheDocument();
    expect(screen.queryByText('r3')).not.toBeInTheDocument();
    expect(screen.queryByText('r8')).not.toBeInTheDocument();
    // Classification card → visible
    expect(screen.getByText('rel-classify')).toBeInTheDocument();
    // Unrelated → visible
    expect(screen.getByText('m8')).toBeInTheDocument();
  });

  it('shows all owned messages when entering classify classification', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-classify')).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText('rel-classify'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    });

    // Inside classification: all owned messages visible
    expect(screen.getAllByText('m1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('m2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('m4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('m7').length).toBeGreaterThan(0);
    // arrange source + target
    expect(screen.getAllByText('m5').length).toBeGreaterThan(0);
    expect(screen.getAllByText('m6').length).toBeGreaterThan(0);
    // CORRECT cascade
    expect(screen.getByText('m3')).toBeInTheDocument();
    // Relation messages
    expect(screen.getByText('r4')).toBeInTheDocument();
    expect(screen.getByText('r11')).toBeInTheDocument();
    // Unrelated → NOT in classification
    expect(screen.queryByText('m8')).not.toBeInTheDocument();
  });
});

describe('MessageWorkbenchPage opposed annotation visibility in classify graph', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('annotation-source', '注释信息'),
        makeMessage('annotation-target', '被注释正文'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-annotation', relationType: 'ANNOTATION',
          sourceMessageId: 'annotation-source',
          targetRefs: [{ kind: 'message', messageId: 'annotation-target' }],
          createdAt: '2024-01-01T00:01:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'rel-disagree', relationType: 'DISAGREE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-annotation' }],
          createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
        },
        {
          id: 'rel-classify', relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [
            { kind: 'relation', relationId: 'rel-annotation' },
          ],
          payload: { title: '分类' },
          createdAt: '2024-01-01T00:03:00.000Z', createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('keeps an opposed annotation declaration available while stopping its graph effect', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => expect(screen.getByText('rel-classify')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText('rel-classify'));
    await waitFor(() => expect(screen.getAllByText('rel-annotation').length).toBeGreaterThan(0));
    expect(screen.getByText('你已反对 · 点赞同恢复')).toBeInTheDocument();
    expect(screen.queryByText('你已反对此注释')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '切换为消息图' }));

    await waitFor(() => {
      expect(mockGraphView).toHaveBeenCalled();
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      expect(props.messages.some((message: { id: string }) => message.id === 'rel-annotation')).toBe(true);
      expect(props.messages.some((message: { id: string }) => message.id === 'annotation-source')).toBe(true);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-annotation')).toBe(false);
    });
  });
});

describe('MessageWorkbenchPage comparison classify projection', () => {
  const scope: ScopeView = { messageId: 'classification-1', title: '对比分类' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({ data: [
      makeMessage('inside-a', '分类内部消息 A'),
      makeMessage('inside-b', '分类内部消息 B'),
      { ...makeMessage('round-preview', '结算消息'), kind: 'ROUND' },
    ] });
    mockApi.getRelations.mockResolvedValue({ data: [
      {
        id: 'rel-classify-preview', relationType: 'CLASSIFY', sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId: 'inside-a' }, { kind: 'message', messageId: 'inside-b' }],
        createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
      },
      {
        id: 'rel-agree-preview', relationType: 'AGREE', sourceMessageId: null,
        targetRefs: [{ kind: 'relation', relationId: 'rel-classify-preview' }],
        createdAt: '2024-01-01T00:03:00.000Z', createdBy: makeUser(),
      },
      {
        id: 'rel-disagree-annotation-preview', relationType: 'DISAGREE', sourceMessageId: null,
        targetRefs: [{ kind: 'relation', relationId: 'rel-annotation-preview' }],
        createdAt: '2024-01-01T00:03:30.000Z', createdBy: makeUser(),
      },
      {
        id: 'rel-annotation-preview', relationType: 'ANNOTATION', sourceMessageId: 'inside-a',
        targetRefs: [{ kind: 'relation', relationId: 'rel-classify-preview' }],
        createdAt: '2024-01-01T00:04:00.000Z', createdBy: makeUser(),
      },
      {
        id: 'rel-join-preview', relationType: 'JOIN', sourceMessageId: 'rel-classify-preview',
        targetRefs: [{ kind: 'message', messageId: 'inside-b' }],
        createdAt: '2024-01-01T00:05:00.000Z', createdBy: makeUser(),
      },
    ] });
  });

  it('keeps classify contents hidden on agree and releases them on disagree', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '对比' }));
    await waitFor(() => expect(screen.getAllByText('rel-classify-preview').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('rel-classify-preview')[0]);
    fireEvent.click(screen.getByRole('button', { name: '审阅' }));

    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const agreeIds = new Set((props.comparisonAgreeMessages ?? []).map((message: { id: string }) => message.id));
      const disagreeIds = new Set((props.comparisonDisagreeMessages ?? []).map((message: { id: string }) => message.id));
      expect(props.autoCenterMessageId).toBe('rel-classify-preview');
      expect(agreeIds.has('rel-classify-preview')).toBe(true);
      expect(agreeIds.has('inside-a')).toBe(false);
      expect(agreeIds.has('rel-join-preview')).toBe(false);
      expect(agreeIds.has('round-preview')).toBe(false);
      expect(props.comparisonDisagreeSuppressedRelIds.has('rel-classify-preview')).toBe(true);
      expect(props.comparisonDisagreeSuppressedRelIds.has('rel-annotation-preview')).toBe(true);
      expect(disagreeIds.has('rel-classify-preview')).toBe(false);
      expect(disagreeIds.has('rel-annotation-preview')).toBe(false);
      expect((props.comparisonDisagreeEdges ?? []).some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-classify-preview')).toBe(false);
      expect((props.comparisonDisagreeEdges ?? []).some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-annotation-preview')).toBe(false);
      expect(disagreeIds.has('inside-a')).toBe(true);
      expect(disagreeIds.has('inside-b')).toBe(true);
      expect(disagreeIds.has('rel-join-preview')).toBe(false);
      expect(disagreeIds.has('round-preview')).toBe(false);
    });
  });

  it('enters the containing classify when reviewing an owned relation message', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '对比' }));
    await waitFor(() => expect(screen.getByText('rel-annotation-preview')).toBeInTheDocument());
    fireEvent.click(screen.getByText('rel-annotation-preview'));
    fireEvent.click(screen.getByRole('button', { name: '审阅' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '退出分类' })).toBeInTheDocument();
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const agreeIds = new Set((props.comparisonAgreeMessages ?? []).map((message: { id: string }) => message.id));
      const disagreeIds = new Set((props.comparisonDisagreeMessages ?? []).map((message: { id: string }) => message.id));
      expect(props.autoCenterMessageId).toBe('rel-annotation-preview');
      expect(agreeIds.has('inside-a')).toBe(true);
      expect(agreeIds.has('inside-b')).toBe(true);
      expect(disagreeIds.has('inside-a')).toBe(true);
      expect(disagreeIds.has('inside-b')).toBe(true);
    });
  });

  it('uses a suppressed reference relation as a trace anchor on the disagree side', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    mockApi.getMessages.mockResolvedValue({ data: [
      makeMessage('reference-source', '引用来源'),
      makeMessage('reference-target', '引用目标'),
      makeMessage('reference-neighbor', '关联消息'),
    ] });
    mockApi.getRelations.mockResolvedValue({ data: [
      {
        id: 'rel-reference', relationType: 'REFERENCE', sourceMessageId: 'reference-source',
        targetRefs: [{ kind: 'message', messageId: 'reference-target' }],
        createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
      },
      {
        id: 'rel-reference-neighbor', relationType: 'REFERENCE', sourceMessageId: 'reference-target',
        targetRefs: [{ kind: 'message', messageId: 'reference-neighbor' }],
        createdAt: '2024-01-01T00:03:00.000Z', createdBy: makeUser(),
      },
      {
        id: 'rel-disagree-reference', relationType: 'DISAGREE', sourceMessageId: null,
        targetRefs: [{ kind: 'relation', relationId: 'rel-reference' }],
        createdAt: '2024-01-01T00:04:00.000Z', createdBy: makeUser(),
      },
    ] });
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));

    fireEvent.click(screen.getByRole('button', { name: '对比' }));
    await waitFor(() => expect(screen.getByText('rel-reference')).toBeInTheDocument());
    fireEvent.click(screen.getByText('rel-reference'));
    fireEvent.click(screen.getByRole('button', { name: '审阅' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '设为追溯消息' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));

    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const disagreeIds = new Set((props.comparisonDisagreeMessages ?? []).map((message: { id: string }) => message.id));
      expect(screen.getByText('追溯距离：1')).toBeInTheDocument();
      expect(disagreeIds.has('rel-reference')).toBe(false);
      expect(disagreeIds.has('reference-source')).toBe(true);
      expect(disagreeIds.has('reference-target')).toBe(true);
    });
  });
});
