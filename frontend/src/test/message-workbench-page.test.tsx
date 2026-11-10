import { act, configure, fireEvent, getConfig, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { afterAll, describe, beforeEach, expect, it, vi } from 'vitest';
import MessageWorkbenchPage from '../pages/MessageWorkbenchPage';
import { prepareCommandBatch, queueCommand } from '../api/commandBatch';
import type { ExportData } from '../api/client';
import * as notificationApi from '../api/client';
import NotificationPanel from '../components/NotificationPanel';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';
import type { Message, Relation, ScopeView, User } from '../types';
import { PART_SELECTION_EVENT } from '../utils/messageElementSelection';
import * as leaderboardMetrics from '../utils/leaderboardMetrics';
import { LEADERBOARD_PREFERENCES_KEY } from '../utils/leaderboardPreferences';
import GestureShortcutManager from '../components/GestureShortcutManager';
import { WORKBENCH_DRAWING_TIMEOUT_MS } from '../context/WorkbenchDrawingContext';
import {bodyVersion,messageReadingKey,structureSnapshot,DEFAULT_MODERATION_POLICY,reviewContextPart,type NativeMessageView} from '@gonglun/core';
import {discussionMessages,discussionEdges} from './discussion-fixture';
import {convertMessagesToDemoModel, type DemoEdge} from '../utils/modelBridge';
import {deriveReadingProgress,influenceReadingMarks} from '../pages/workbench/model/readingProgress';
import { getZhihuDisplayFields, getZhihuInactiveRelationIds, getZhihuLocalRelations, getZhihuReplyRelations, prepareZhihuForViewing, serializeZhihuViewingData } from '../utils/zhihuArchive';
import { serializeGonglunZhihuViewingData } from '../utils/zhihuGonglunExport';
import { validateExportForViewing } from '../utils/exportArchive';
import { largeStructuralFixture } from './zhihu-structural-fixture';
import { nativeZhihuDocument, sendNativeZhihuRelation } from '../utils/nativeZhihuEditor';
import * as exportViewerCache from '../utils/exportViewerCache';
import { getTheme, setTheme, THEMES } from '../theme/theme';
import { BrowserRouter, HashRouter, Route, Routes } from 'react-router-dom';
const { readFileSync } = await vi.importActual<{ readFileSync(path: URL, encoding: 'utf8'): string }>('node:fs');
const testFileUrl = import.meta.url;
const readingPresentationCss = readFileSync(new URL('../theme/reading-presentation.css', testFileUrl), 'utf8');

// These full-workbench scenarios include real layout frames and native history traversal.
// Allow the UI to settle under parallel test load without weakening its behavior checks.
const previousAsyncTimeout = getConfig().asyncUtilTimeout;
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });
afterAll(() => { configure({ asyncUtilTimeout: previousAsyncTimeout }); vi.resetConfig(); });

const { mockApi, mockNavigate, mockGraphView, graphRendering, viewerRoute } = vi.hoisted(() => {
  const mockApi = {
    getReadingState:vi.fn().mockResolvedValue({marks:[]}),
    markReading:vi.fn().mockImplementation(async(marks)=>({marks:marks.map((mark:object)=>({...mark,updatedAt:'2026-10-24T10:00:00Z'}))})),
    getScope: vi.fn(),
    getMessages: vi.fn(),
    getAllMessages: vi.fn(),
    getWorkbenchSnapshot: vi.fn(),
    getMessageContext: vi.fn(),
    subscribeChanges: vi.fn(() => ({ close: vi.fn(), onmessage: null, onopen: null, onerror: null })),
    withCommandBatch: vi.fn<(work: () => Promise<unknown>, onCommitted?: (count: number) => void) => Promise<unknown>>(),
    cancelCommandBatch: vi.fn(),
    prepareCommandBatch: vi.fn(),
    previewCommandBatch: vi.fn(),
    confirmCommandPreview: vi.fn(),
    getRelations: vi.fn(),
    createMessage: vi.fn(),
    createRelation: vi.fn(),
    getAttentionUsers: vi.fn().mockResolvedValue({ data: {} }),
    getPointsBalance: vi.fn().mockResolvedValue({ points: { available: 100, locked: 0 }, balance: { amount: 100, debtFrozen: false } }),
    getPointsTransactions: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
    getMessageStakes: vi.fn().mockResolvedValue({ messageId: '', pool: { lockedPro: 0, lockedCon: 0 }, stakes: [], counts: { pro: 0, con: 0 } }),
    getMessageRounds: vi.fn().mockResolvedValue({ data: [] }),
    getRoundDetail: vi.fn().mockResolvedValue(null),
    // These established composer scenarios isolate truth/value costs; moderation has its own cases.
    getCurrentRules: vi.fn().mockResolvedValue({ parameters: { selfStakeOnCreate: 10, minStake: 1, stakeFeeAmount: 1,moderation:{enabled:false,fee:3,deposit:10,minReviewers:2,appealDelayMs:86400000} } }),
    createRound: vi.fn(),
    castVote: vi.fn(),
    closeAndSettle: vi.fn(),
    getMessageTagCounts: vi.fn().mockResolvedValue({ counts: {} }),
    getReview:vi.fn(),
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
          revision:relation.revision,parts:relation.parts,state:relation.state,executedStance:relation.executedStance,sequence:relation.sequence,
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
        revision:message.revision,parts:message.parts,state:message.state,executedStance:message.executedStance,sequence:message.sequence,
        sourceMessageId: message.relSourceId ?? null, targetRefs: message.targetRefs ?? [],
        payload: message.relationPayload, createdAt: message.createdAt, createdBy: message.createdBy,
      })),
      users: [], stakes: {}, tagCounts: {}, attentionUsers: attention.data,
      sequence: 1, nextCursor: null, hasMore: false,
    };
  });
  return { mockApi, mockNavigate: vi.fn(), mockGraphView: vi.fn(), graphRendering: { actual: false,
    tasks: null as ReturnType<typeof import('../context/WorkbenchDrawingContext')['createWorkbenchDrawingTasks']> | null,
  }, viewerRoute: { archive: null as ExportData | null, key: '', query: '', nativeRouter: false,
    navigation: null as import('../utils/exportViewerCache').ExportNavigation | null } };
});

const defaultCommandBatch = mockApi.withCommandBatch.getMockImplementation()!;
const catalogHarness = vi.hoisted(() => ({ callbacks: null as any, data: null as any,
  progress: { ready: false, count: 0, syncing: true }, prioritize: vi.fn(), filters: vi.fn(), leaderboard: vi.fn() }));
vi.mock('../data/catalogClient', async () => {
  const { deriveCleanVisibleIds } = await import('../utils/cleanProjection');
  const { deriveHomeFilterResult } = await import('../pages/workbench/projections/homeFilterResult');
  const { deriveContainerEffect } = await import('../pages/workbench/model/containerEffect');
  const { getLatestUserReadStatusByMessageId } = await import('../pages/workbench/model/filters');
  catalogHarness.filters.mockImplementation(async (query: any) => ({
    clean: deriveCleanVisibleIds({ ...catalogHarness.data.projected, stakeCounts: catalogHarness.data.projected.counts,
      tagCounts: catalogHarness.data.snapshot.tagCounts }, query.rules),
    home: query.home ? deriveHomeFilterResult({ ...catalogHarness.data.projected, displayUser: query.user, homeFilterMode: query.home,
      msgMap: new Map(catalogHarness.data.projected.messages.map((message: Message) => [message.id, message])),
      traceContainerMemberships: deriveContainerEffect({ ...catalogHarness.data.projected, username: query.user?.username ?? null }).memberships,
      readingMarks:query.readingMarks,readStatusByMessageId: getLatestUserReadStatusByMessageId(catalogHarness.data.projected.relations, relation => relation.createdBy.id === query.user?.id) }) : null,
  }));
  return { createCatalogClient: (_user: string, _scope: string, callbacks: any) => {
    catalogHarness.callbacks = callbacks;
    return { prioritize: catalogHarness.prioritize, filters: catalogHarness.filters, leaderboard: catalogHarness.leaderboard, catchUp: vi.fn(), applyCommitted: vi.fn(),
      refresh: vi.fn().mockResolvedValue(false), stop: vi.fn(), getProgress: () => catalogHarness.progress, subscribe: () => () => {} };
  } };
});

vi.mock('../api', () => ({ api: mockApi }));
vi.mock('../context/AuthContext', () => ({
  useOptionalAuth:()=>({user:{id:'user-1',username:'tester',createdAt:'2024-01-01T00:00:00.000Z'}}),
  useAuth: () => ({
    user: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
    logout: vi.fn(),
  }),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => viewerRoute.nativeRouter ? actual.useParams() : viewerRoute.archive ? {} : ({ messageId: 'classification-1' }),
    useNavigate: () => viewerRoute.nativeRouter ? actual.useNavigate() : mockNavigate,
    useLocation: () => viewerRoute.nativeRouter ? actual.useLocation() : ({ pathname: viewerRoute.archive ? '/viewer' : '/messages/classification-1', state: viewerRoute.archive ? { exportData: viewerRoute.archive, viewerNavigation: viewerRoute.navigation ?? undefined } : null, key: viewerRoute.key, search: '', hash: '' }),
    useSearchParams: () => viewerRoute.nativeRouter ? actual.useSearchParams() : [new URLSearchParams(viewerRoute.query), (next: URLSearchParams) => { viewerRoute.query = next.toString(); }] as const,
  };
});
vi.mock('../components/GraphView', async () => {
  const actual = await vi.importActual<typeof import('../components/GraphView')>('../components/GraphView');
  const { useContext } = await import('react');
  const { WorkbenchDrawingContext } = await import('../context/WorkbenchDrawingContext');
  return {
    ...actual,
    default: function GraphViewMock(props: any) {
      graphRendering.tasks = useContext(WorkbenchDrawingContext);
      mockGraphView(props);
      if (graphRendering.actual) return <actual.default {...props} />;
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

const participant={id:'participant',username:'participant',createdAt:''};
const receivedMessage=(id:string,content:string):Message=>({...makeMessage(id,content),createdBy:participant});
const receivedRelation=():Relation=>({...makeRelation(),createdBy:participant});

function setTraceDirectionForTest(direction:'up'|'down'|'both'){
  const up=screen.getByRole('spinbutton',{name:'向上追溯距离'}),down=screen.getByRole('spinbutton',{name:'向下追溯距离'});
  const distance=Math.max(Number((up as HTMLInputElement).value),Number((down as HTMLInputElement).value))||1;
  fireEvent.change(up,{target:{value:direction==='down'?0:distance}});
  fireEvent.change(down,{target:{value:direction==='up'?0:distance}});
}
function stepTraceDistanceForTest(step:number){
  for(const name of ['向上追溯距离','向下追溯距离']){
    const field=screen.getByRole('spinbutton',{name}) as HTMLInputElement,value=Number(field.value);
    if(value)fireEvent.change(field,{target:{value:Math.max(0,Math.min(8,value+step))}});
  }
}

function expandReadingEffects(){
  for(const button of screen.queryAllByRole('button',{name:/^展开(?:未阅|已阅)影响/}))fireEvent.click(button);
  const effects=screen.queryByRole('region',{name:'相关影响'});
  for(const category of effects?.querySelectorAll<HTMLElement>('[data-influence-category]')??[]){
    const button=within(category).queryByRole('button',{name:/^展开/});if(button)fireEvent.click(button);
  }
}
function readingEffects(){expandReadingEffects();return screen.getByRole('region',{name:'相关影响'});}
function readingCurrentMessage(id:string){
  const element=Array.from(document.querySelectorAll<HTMLElement>('[data-reading-current-id]')).find(element=>element.dataset.readingCurrentId===id);
  if(!element)throw new Error(`当前阅读消息不是 ${id}`);
  return element;
}
function readingPath(){return document.querySelector<HTMLElement>('[data-reading-path]')!;}
function expectReadingPath(ids:string[]){
  expect(Array.from(readingPath().querySelectorAll('[data-reading-message-id]')).map(element=>element.getAttribute('data-reading-message-id'))).toEqual(ids);
}
function expectTraceOrigin(id:string,present=true){
  const origin=screen.queryByRole('button',{name:`跳转到追溯起点 ${id}`});
  if(present)expect(origin).toBeInTheDocument();else expect(origin).toBeNull();
}

async function waitForWorkbenchIdle() {
  const assertIdle = () => {
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(graphRendering.tasks).not.toBeNull();
    expect(graphRendering.tasks!.failure).toBeNull();
    expect(graphRendering.tasks!.pending).toBe(0);
  };
  if (vi.isFakeTimers()) {
    for (let frame = 0; frame < 300; frame++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(16); });
      if (!document.querySelector('[aria-busy="true"]') && graphRendering.tasks?.pending === 0) { assertIdle(); return; }
    }
    assertIdle();
  } else await waitFor(assertIdle, { timeout: 5000 });
}

function messageCanvas() {
  return within(document.querySelector<HTMLElement>('[data-workbench-left-panel]')!);
}

async function moveBrowserHistory(delta: number, toolbar?: '返回' | '前进') {
  await act(async () => {
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    if (toolbar) fireEvent.click(screen.getByRole('button', { name: toolbar }));
    else window.history.go(delta);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await popped;
  });
}

async function jumpToMessageId(id:string) {
  let input=screen.queryByRole('textbox',{name:'消息 ID'});
  if(!input){fireEvent.click(await screen.findByRole('button',{name:'跳转'}));input=screen.getByRole('textbox',{name:'消息 ID'});}
  fireEvent.change(input,{target:{value:id}});
  const dialog=screen.queryByRole('dialog',{name:'跳转消息'});
  fireEvent.click(dialog?within(dialog).getByRole('button',{name:'跳转'}):screen.getByRole('button',{name:'确认'}));
}

describe('rejected child container boundaries and single-side comparison',()=>{
  const latest=()=>mockGraphView.mock.lastCall![0];
  const selectComparisonTarget = async (id: string) => {
    await waitForWorkbenchIdle();
    const card = document.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${id}"]:not([data-rel-overlay])`);
    expect(card).not.toBeNull();
    fireEvent.click(card!);
    await waitFor(() => expect(screen.getByRole('button', { name: '审阅' })).toBeEnabled());
  };
  const visibleGraphMessages = () => latest().messages.filter((message: Message) => !latest().visibleMessageIds || latest().visibleMessageIds.has(message.id));
  const scrollToNextStructure = async () => {
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    const count = () => Number(screen.getByText(/^当前已显示/).textContent?.match(/\d+/)?.[0]);
    const before = count();
    const boundary = document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-message-window-boundary]')
      ?? screen.getByText(/^当前已显示/);
    const geometry = vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValueOnce(new DOMRect(0, 100, 1, 1));
    fireEvent.scroll(document);
    await waitFor(() => expect(count()).toBeGreaterThan(before));
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    geometry.mockRestore();
  };
  const event=()=>({button:0,stopPropagation:vi.fn()});
  function fixture(type='CLASSIFY',joinOnly=false){
    const relation=(id:string,relationType:string,ids:string[]=[],sourceMessageId:string|null=null):Relation=>({id,relationType,sourceMessageId,targetRefs:ids.map(messageId=>({kind:'message',messageId})),payload:{title:id,targetLayout:'single-row'},createdAt:'2024-01-01T00:00:00Z',createdBy:makeUser()});
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'测试分类'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('B','A 内的 B')]});
    mockApi.getRelations.mockResolvedValue({data:[relation('A','CLASSIFY',['C']),relation('C',type,joinOnly?[]:['B']),...(joinOnly?[relation('join-B','JOIN',['B'],'C')]:[]),relation('against-C','DISAGREE',['C'])]});
  }
  beforeEach(()=>{vi.clearAllMocks();HTMLElement.prototype.scrollIntoView=vi.fn();});
  it.each(['graph', 'list'])('updates card selection immediately during online hydration in %s', async mode => {
    const original = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const category: Relation = { ...makeRelation(), id: 'category', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [], payload: { title: '测试分类' }, revision: 1 };
    const full = { regionId: 'selection-region', scope: { messageId: 'classification-1', title: '选择测试' }, sequence: 10,
      messages: [{ ...makeMessage('text', '测试正文'), revision: 1 }, { ...makeMessage(category.id, '测试分类'), revision: 1,
        kind: 'RELATION', relationType: category.relationType, targetRefs: category.targetRefs, relationPayload: category.payload }],
      relations: [category], users: [makeUser()], stakes: {}, tagCounts: {}, attentionUsers: {} };
    let hold = false;
    const releases: Array<() => void> = [];
    mockApi.getWorkbenchSnapshot.mockImplementation(async ({ ids }: { ids?: string[] }) => {
      if (hold && ids) await new Promise<void>(resolve => releases.push(resolve));
      return { ...full, windowed: true, messages: full.messages.filter(row => ids?.includes(row.id)),
        relations: full.relations.filter(row => ids?.includes(row.id)) };
    });
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />), pointer = userEvent.setup();
    try {
      await waitFor(() => expect(catalogHarness.callbacks).not.toBeNull());
      const index = structureSnapshot(full);
      const { projectWorkbenchSnapshot } = await import('../utils/workbenchProjection');
      act(() => catalogHarness.callbacks.onReady({ snapshot: index, index,
        projected: projectWorkbenchSnapshot({ ...index, messages: [], relations: [] }) }));
      await waitForWorkbenchIdle();
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      const card = (id: string) => view.container.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${id}"]:not([data-rel-overlay])`)!;
      const staging = document.querySelector('[data-guide-selection-staging]')!;
      hold = true;
      for (const [id, content] of [['text', '测试正文'], ['category', '测试分类']]) {
        const originalCard = card(id);
        const requestsBefore = releases.length;
        await pointer.click(within(originalCard).getByText(content));
        expect(staging).toHaveTextContent(id);
        expect(card(id)).toBe(originalCard);
        expect(originalCard).toHaveAttribute('data-whole-selected', 'true');
        await waitFor(() => expect(releases.length).toBeGreaterThan(requestsBefore));
        await pointer.click(within(originalCard).getByText(content));
        expect(staging).toHaveTextContent('当前未选择任何候选。');
        expect(originalCard).not.toHaveAttribute('data-whole-selected');
      }
      await pointer.click(within(card('text')).getByText('测试正文'));
      expect(card('text')).toHaveAttribute('data-whole-selected', 'true');
      fireEvent.click(screen.getByRole('button', { name: '清空' }));
      expect(card('text')).not.toHaveAttribute('data-whole-selected');
      hold = false;
      await act(async () => { releases.splice(0).forEach(release => release()); });
      await waitForWorkbenchIdle();
      expect(staging).toHaveTextContent('当前未选择任何候选。');
      expect(card('text')).not.toHaveAttribute('data-whole-selected');
      expect(card('category')).not.toHaveAttribute('data-whole-selected');
    } finally {
      view.unmount(); hold = false; releases.splice(0).forEach(release => release());
      graphRendering.actual = false; mockApi.getWorkbenchSnapshot.mockImplementation(original); catalogHarness.callbacks = null;
    }
  });
  it('opens a review target outside the loaded scope through the queue event even without audit records',async()=>{
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'审核测试'});
    const target=makeMessage('review-target','待审正文');
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('unrelated','其他消息')]});mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.getReview.mockResolvedValue({summary:{caseId:'case',messageId:'review-target',revision:1,status:'pending',fee:3,deposit:10,pass:10,reject:0,selfPass:10,selfReject:0,reviewerCount:0,releaseAt:null,finalized:false},target,records:[],canReview:true,reviewEligibility:'eligible',canAppeal:true,canSettle:false,policy:{enabled:true,fee:3,deposit:10,minReviewers:2,appealDelayMs:86400000}});
    render(<MessageWorkbenchPage/>);await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    act(()=>window.dispatchEvent(new CustomEvent('gonglun:open-review',{detail:{messageId:'review-target'}})));
    expect(await screen.findByText('审核临时分类（1 条被审核消息 · 0 条记录）')).toBeInTheDocument();
    expect(screen.queryByRole('region',{name:'审核理由汇总'})).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'切换为消息表'})).toBeVisible();
    await waitFor(()=>expect(latest().messages).toEqual([expect.objectContaining({id:target.id,content:target.content})]));
    fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
    expect(screen.getByText(target.content)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:/审核仲裁：/}));
    await waitFor(()=>expect(screen.getByRole('region',{name:'审核仲裁'})).toHaveTextContent('资金与奖励：审核费 3'));
    expect(mockApi.getReview).toHaveBeenCalled();
  });
  it('opens the covered review target from a restricted ledger source',async()=>{
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'审核测试'});
    const summary={caseId:'case',messageId:'review-target',revision:1,status:'rejected' as const,fee:6,deposit:10,pass:10,reject:11,reviewerCount:1,releaseAt:'2026-11-09T00:00:00Z',finalized:true};
    const target={...makeMessage('review-target',''),revision:1,restricted:true,moderation:summary};
    const record={...makeMessage('review-payout',''),kind:'RELATION',restricted:true,relationType:'REVIEW_RECORD',payload:{},sourceMessageId:null,
      targetRefs:[{kind:'message' as const,messageId:target.id,reference:{messageId:target.id,revision:1}}],
      parts:[{id:'review-attachment',type:'relation' as const,relation:'review-record',roles:{target:[{id:'target',reference:{messageId:target.id,revision:1}}]}}]};
    mockApi.getMessages.mockResolvedValue({data:[target,record]});mockApi.getRelations.mockResolvedValue({data:[record]});
    mockApi.getReview.mockResolvedValue({summary,target,records:[record],stakes:[],canReview:false,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY});
    render(<MessageWorkbenchPage/>);await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    act(()=>window.dispatchEvent(new CustomEvent('points-navigate',{detail:{messageId:record.id,scopeMessageId:'root',txType:'TRANSFER',roundId:null}})));
    expect(await screen.findByText('审核临时分类（1 条被审核消息 · 0 条记录）')).toBeInTheDocument();
    await waitFor(()=>expect(latest().messages).toContainEqual(expect.objectContaining({id:target.id,restricted:true,content:''})));
  });
  it.each(['graph','list'])('keeps the review target mounted as delayed records arrive in a windowed %s view',async mode=>{
    const original=mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const summary={caseId:'delayed-case',messageId:'review-target',revision:1,status:'pending' as const,fee:6,deposit:10,pass:10,reject:0,reviewerCount:0,releaseAt:null,finalized:false};
    const target={...receivedMessage(summary.messageId,'审核期间始终显示的原消息'),revision:1,moderation:summary};
    const record:NativeMessageView={...target,moderation:undefined,id:'delayed-record',sequence:11,kind:'RELATION',content:'延迟到达的审核记录',relationType:'REVIEW',sourceMessageId:null,
      sourceRefs:[],targetRefs:[{kind:'message',messageId:target.id}],payload:{caseId:summary.caseId,verdict:'pass'},
      updatedAt:target.createdAt,spending:{protocol:1,wager:0,recommendation:0,reviewWager:2},
      state:{messageId:'delayed-record',revision:1,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0},
      parts:[{id:'body',type:'text',text:'延迟到达的审核记录'},
        {id:'review',type:'relation',relation:'review',roles:{target:[{id:'target',reference:{messageId:target.id,revision:1}}]}},
        {id:'data',type:'data',value:{caseId:summary.caseId,verdict:'pass'}}]};
    const value={summary,target,records:[record],canReview:true,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY};
    let finish!:(result:typeof value)=>void;
    mockApi.getReview.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const full={regionId:'region',scope:{messageId:'classification-1',title:'按需审核'},sequence:10,messages:[target],relations:[],users:[participant],stakes:{},tagCounts:{},attentionUsers:{}};
    mockApi.getWorkbenchSnapshot.mockImplementation(async({ids}:{ids?:string[]})=>({...full,windowed:true,messages:full.messages.filter(row=>ids?.includes(row.id))}));
    const {projectWorkbenchSnapshot}=await import('../utils/workbenchProjection');
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await waitFor(()=>expect(catalogHarness.callbacks).not.toBeNull());
      const index=structureSnapshot(full);
      act(()=>catalogHarness.callbacks.onReady({snapshot:index,index,projected:projectWorkbenchSnapshot({...index,messages:[],relations:[]})}));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'审核通过 10 点，查看记录'}));
      await waitForWorkbenchIdle();
      if(mode==='list'){fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();}
      const canvas=view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const card=canvas.querySelector<HTMLElement>('[data-msgid="review-target"]')!;
      expect(card).toHaveTextContent(target.content);
      const host=canvas.querySelector('[data-workbench-view-cache]')!.firstElementChild;
      expect(mockApi.getReview).toHaveBeenCalledTimes(1);
      await act(async()=>{finish(value);});
      mockApi.getReview.mockResolvedValue(value);
      await waitFor(()=>expect(canvas.querySelector('[data-msgid="delayed-record"]')).not.toBeNull());
      await waitForWorkbenchIdle();
      expect(canvas.querySelector('[data-msgid="review-target"]')).toBe(card);
      expect(canvas.querySelector('[data-workbench-view-cache]')!.firstElementChild).toBe(host);
      const windowRequests=mockApi.getWorkbenchSnapshot.mock.calls.length;
      expect(canvas.querySelector('[data-msgid="delayed-record"]')).toHaveTextContent(record.content);
      if(mode==='graph'){
        fireEvent.click(await screen.findByRole('button',{name:'收起审核通过分支 review-target'}));await waitForWorkbenchIdle();
        expect(canvas.querySelector('[data-msgid="delayed-record"]')).toBeNull();
        fireEvent.click(screen.getByRole('button',{name:'展开审核通过分支 review-target'}));await waitForWorkbenchIdle();
        expect(canvas.querySelector('[data-msgid="delayed-record"]')).toHaveTextContent(record.content);
      }
      expect(canvas.querySelector('[data-msgid="review-target"]')).toBe(card);
      expect(canvas.querySelector('[data-workbench-view-cache]')!.firstElementChild).toBe(host);
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(windowRequests);
      expect(mockApi.getReview).toHaveBeenCalledTimes(1);
      expect(mockApi.getWorkbenchSnapshot.mock.calls.some(([query])=>query.ids?.includes(record.id))).toBe(false);
      fireEvent.click(screen.getByRole('button',{name:/审核仲裁：/}));
      const arbitration=await screen.findByRole('region',{name:'审核仲裁'});
      expect(arbitration.closest('[data-settlement-panel]')).not.toBeNull();
      expect(arbitration.closest('[aria-label="审核理由汇总"]')).toBeNull();
      expect(mockApi.getReview).toHaveBeenCalledTimes(1);
      fireEvent.click(within(card).getByTitle('真假仲裁'));
      await screen.findByRole('heading',{name:/真假仲裁/});
      expect(screen.queryByRole('region',{name:'审核仲裁'})).toBeNull();
      expect(canvas.querySelectorAll('[data-settlement-panel]')).toHaveLength(1);
      fireEvent.click(within(card).getByTitle('价值仲裁'));
      await screen.findByRole('heading',{name:/价值仲裁/});
      expect(canvas.querySelectorAll('[data-settlement-panel]')).toHaveLength(1);
      expect(canvas.querySelector('[data-msgid="review-target"]')).toBe(card);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getWorkbenchSnapshot.mockImplementation(original);catalogHarness.callbacks=null;}
  });
  it.each((['pass','reject'] as const).flatMap(verdict=>['graph','list'].map(mode=>({verdict,mode}))))('sends an operations review $verdict as one dependent relation with an optional reason in $mode',async({verdict,mode})=>{
    const rules=mockApi.getCurrentRules.getMockImplementation()!,createRelation=mockApi.createRelation.getMockImplementation(),token=localStorage.getItem('token');localStorage.setItem('token','test-token');
    mockApi.getCurrentRules.mockResolvedValue({parameters:{minStake:1,stakeFeeAmount:1,moderation:DEFAULT_MODERATION_POLICY}});
    const target={...receivedMessage('review-target','可供审核的正文'),revision:1};
    const summary={caseId:'case',messageId:target.id,revision:1,round:1,status:'pending',fee:6,deposit:10,pass:0,reject:0,reviewerCount:0,releaseAt:null,finalized:false};
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'审核测试'});
    mockApi.getMessages.mockResolvedValue({data:[target]});mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.getReview.mockResolvedValue({summary,records:[],canReview:true,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY});
    const reason=verdict==='pass'?'事实可核实':'';
    mockApi.createRelation.mockResolvedValueOnce({...makeRelation(),id:'new-review',relationType:'REVIEW',sourceMessageId:null,targetRefs:[{kind:'message',messageId:target.id}],payload:{caseId:'case',reviewRound:1,verdict},revision:1,
      spending:{protocol:1,wager:0,recommendation:0,reviewWager:2},parts:[
        {id:'body',type:'text',text:reason},{id:'relation',type:'relation',relation:'review',roles:{target:[{id:'target',reference:{messageId:target.id,revision:1}}]}},
        {id:'data',type:'data',value:{caseId:'case',reviewRound:1,verdict}},
      ]});
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));graphRendering.actual=true;
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),target.id));
      if(mode==='list'){fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();}
      fireEvent.click(screen.getByRole('button',{name:/运营$/}));
      expect(screen.getByRole('button',{name:'公告'})).toHaveAttribute('aria-pressed','true');
      fireEvent.click(screen.getByRole('button',{name:'审核'}));
      fireEvent.click(screen.getByRole('button',{name:verdict==='pass'?'审核通过':'审核不通过'}));
      fireEvent.change(screen.getByPlaceholderText('填写审核理由（可选，保存在审核关系消息中）'),{target:{value:reason}});
      expect(screen.getByLabelText('审核押注投入')).toHaveValue(2);
      expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledExactlyOnceWith('classification-1',expect.objectContaining({
        relationType:'REVIEW',sourceMessageId:null,wager:0,reviewWager:2,recommendation:0,selfAgree:false,
        targetRefs:[expect.objectContaining({messageId:target.id,reference:expect.objectContaining({messageId:target.id,revision:1})})],
        payload:{caseId:'case',reviewRound:1,verdict,content:reason},
      })));
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      expect(await screen.findByText(/审核临时分类（1 条被审核消息/)).toBeVisible();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="new-review"]')).not.toBeNull();
      expect(screen.queryByRole('region',{name:'审核理由汇总'})).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
      if(mode==='graph'){
        expect(latest().messages.some((message:Message)=>message.id==='new-review')).toBe(false);
        expect(latest().edges.some((edge:DemoEdge)=>edge.relationMessageId==='new-review')).toBe(false);
      }else expect(screen.getByRole('button',{name:'切换为消息图'})).toBeVisible();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="new-review"]')).toBeNull();
      expect(screen.queryByRole('region',{name:'审核理由汇总'})).not.toBeInTheDocument();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getCurrentRules.mockImplementation(rules);mockApi.createRelation.mockReset();if(createRelation)mockApi.createRelation.mockImplementation(createRelation);if(token===null)localStorage.removeItem('token');else localStorage.setItem('token',token);}
  });
  it.each([
    {name:'回复',text:'回复审核正文'}, {name:'引用',text:'引用审核正文'}, {name:'注释',text:'注释审核正文'},
    {name:'更正',text:'更正审核正文'}, {name:'分类',text:'审核分类'}, {name:'总结',text:'审核总结'},
    {name:'归并',text:''}, {name:'排列',text:''}, {name:'赞同',text:''}, {name:'反对',text:''},
  ])('offers the ordinary text $name operation for a review message in its temporary category',async({name,text})=>{
    const summary={caseId:'operation-case',messageId:'operation-target',revision:1,status:'pending' as const,fee:6,deposit:10,pass:12,reject:0,reviewerCount:1,releaseAt:null,finalized:false};
    const target={...receivedMessage(summary.messageId,'被审核正文'),revision:1,moderation:summary};
    const vote:NativeMessageView={...target,id:'operation-review',kind:'RELATION',content:'完整审核正文',contentType:'TEXT',sequence:2,
      relationType:'REVIEW',sourceMessageId:null,sourceRefs:[],targetRefs:[{kind:'message',messageId:target.id}],payload:{caseId:summary.caseId,verdict:'pass'},
      updatedAt:'2026-11-08T00:00:00Z',spending:{protocol:1,recommendation:0,wager:0,reviewWager:2},
      state:{messageId:'operation-review',revision:1,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0},moderation:undefined,
      parts:[{id:'body',type:'text',text:'完整审核正文'},{id:'relation',type:'relation',relation:'review',roles:{target:[{id:'t',reference:{messageId:target.id,revision:1}}]}},
        {id:'data',type:'data',value:{caseId:summary.caseId,verdict:'pass'}}]};
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'审核消息操作'});
    mockApi.getMessages.mockResolvedValue({data:[target]});mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.getReview.mockResolvedValue({summary,target,records:[vote],canReview:true,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY});
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await waitForWorkbenchIdle();
      fireEvent.click(await screen.findByRole('button',{name:'审核通过 12 点，查看记录'}));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),vote.id));
      fireEvent.click(screen.getByRole('button',{name}));
      if(text){
        const placeholder=name==='分类'?'输入分类名称（不能为空）':name==='总结'?'输入总结内容（不能为空）':'输入一条新文本消息（支持自由换行）';
        const input=screen.getByPlaceholderText(placeholder);expect(input).not.toHaveAttribute('readonly');
        fireEvent.change(input,{target:{value:text}});
      }
      expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
      if(name==='赞同'||name==='反对')expect(screen.getByLabelText('审核押注投入')).toHaveValue(2);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });
  it('loads review reason discussions and organization frames, refreshes new replies, and hides the discussion after exit',async()=>{
    const summary={caseId:'discussion-case',messageId:'review-discussion-target',revision:1,status:'pending' as const,fee:6,deposit:10,pass:12,reject:0,reviewerCount:1,releaseAt:null,finalized:false};
    const target={...receivedMessage(summary.messageId,'被审核的原文'),revision:1,moderation:summary};
    const scope={messageId:target.id,revision:1};
    const vote:NativeMessageView={...target,id:'reason-vote',kind:'RELATION',content:'审核理由原文',contentType:'TEXT',sequence:2,revision:1,
      relationType:'REVIEW',sourceMessageId:null,sourceRefs:[],targetRefs:[{kind:'message',messageId:target.id}],payload:{caseId:summary.caseId,verdict:'pass'},
      updatedAt:'2026-11-08T00:00:00Z',spending:{protocol:1,recommendation:0,wager:0,reviewWager:2},
      state:{messageId:'reason-vote',revision:1,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0},moderation:undefined,
      parts:[{id:'body',type:'text',text:'审核理由原文'},{id:'relation',type:'relation',relation:'review',roles:{target:[{id:'t',reference:scope}]}},
        {id:'data',type:'data',value:{caseId:summary.caseId,verdict:'pass'}}]};
    const reply:NativeMessageView={...vote,id:'reason-reply',kind:'TEXT',relationType:null,content:'回复审核理由',targetRefs:[],payload:{},
      parts:[{id:'body',type:'text',text:'回复审核理由'},reviewContextPart(scope)],spending:{protocol:1,recommendation:1,wager:0}};
    const group:NativeMessageView={...vote,id:'reason-group',relationType:'CLASSIFY',content:'审核理由分类',payload:{title:'审核理由分类'},
      targetRefs:[{kind:'message',messageId:vote.id},{kind:'message',messageId:reply.id}],
      parts:[{id:'body',type:'text',text:'审核理由分类'},{id:'relation',type:'relation',relation:'classify',roles:{members:[vote,reply].map((record,index)=>({id:`m${index}`,reference:{messageId:record.id}}))}},reviewContextPart(scope)]};
    let records=[vote,reply,group];
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'审核讨论操作'});
    mockApi.getMessages.mockResolvedValue({data:[target]});mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.getReview.mockImplementation(async()=>({summary,target,records,canReview:true,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY}));
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'审核通过 12 点，查看记录'}));await waitForWorkbenchIdle();
      await waitFor(()=>expect(latest().messages.map((message:Message)=>message.id)).toEqual(expect.arrayContaining([target.id,vote.id,reply.id,group.id])));
      expect(latest().messages.find((message:Message)=>message.id===vote.id)).toMatchObject({kind:'normal',content:'审核理由原文'});
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="reason-reply"]')).not.toBeNull();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="reason-vote"]')).not.toBeNull();
      const more={...reply,id:'new-reason-reply',content:'后来追加的回复',parts:[{id:'body',type:'text' as const,text:'后来追加的回复'},reviewContextPart(scope)]};
      records=[...records,more];
      act(()=>window.dispatchEvent(new CustomEvent('gonglun:committed',{detail:[]})));
      await waitFor(()=>expect(latest().messages.some((message:Message)=>message.id===more.id)).toBe(true));
      await waitForWorkbenchIdle();
      act(()=>latest().onGroupFrameDoubleClick({stopPropagation:()=>undefined},group.id));await waitForWorkbenchIdle();
      expect(await screen.findByRole('button',{name:'返回审核临时分类'})).toBeVisible();
      expect(latest().messages.some((message:Message)=>message.id===target.id)).toBe(true);
      expect(latest().messages.some((message:Message)=>message.id===more.id)).toBe(false);
      fireEvent.click(screen.getByRole('button',{name:'返回审核临时分类'}));await waitForWorkbenchIdle();
      expect(latest().messages.some((message:Message)=>message.id===more.id)).toBe(true);
      fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
      for(const record of records)expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${record.id}"]`)).toBeNull();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });
  it.each(['graph','list'])('keeps review records attached in the main %s view and opens them only in the review category',async mode=>{
    const summary={caseId:'case',messageId:'review-target',revision:1,round:1,status:'pending' as const,fee:6,deposit:10,pass:2,reject:2,passReviewers:1,rejectReviewers:1,reviewerCount:2,releaseAt:null,finalized:false};
    const target={...receivedMessage('review-target','被审核消息正文'),revision:1,moderation:summary};
    const record=(id:string,verdict:'pass'|'reject',reason:string):NativeMessageView=>({
      id,revision:1,sequence:2,kind:'RELATION',contentType:'TEXT',content:reason,relationType:'REVIEW',sourceMessageId:null,
      sourceRefs:[],updatedAt:'2026-11-08T00:00:00Z',spending:{protocol:1,wager:0,recommendation:0,reviewWager:2},
      state:{messageId:id,revision:1,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0},
      targetRefs:[{kind:'message',messageId:target.id}],payload:{caseId:'case',reviewRound:1,verdict},createdBy:participant,createdAt:'2026-11-08T00:00:00Z',
      parts:[{id:'body',type:'text',text:reason},{id:'relation',type:'relation',relation:'review',roles:{target:[{id:'target',reference:{messageId:target.id,revision:1}}]}},
        {id:'data',type:'data',value:{caseId:'case',reviewRound:1,verdict}}],
    });
    const pass=record('review-pass','pass',''),reject=record('review-reject','reject','不通过理由');
    reject.createdBy={...participant,id:'second-reviewer'};
    const enrollment:NativeMessageView={...record('review-enrollment','pass','历史内容纳入审核'),relationType:'REVIEW-ENROLLMENT',payload:{},parts:[
      {id:'body',type:'text',text:'历史内容纳入审核'},
      {id:'record',type:'relation',relation:'review-enrollment',roles:{target:[{id:'target',reference:{messageId:target.id,revision:1}}]}},
    ]};
    const records=[pass,reject,enrollment];
    const stakes=[pass,reject].map(record=>({id:`review-wager:${record.id}`,sourceMessageId:record.id,revision:1,round:1,kind:'wager',
      side:record.id===pass.id?'PRO':'CON',amount:2,createdAt:record.createdAt,user:record.createdBy}));
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'审核测试'});
    mockApi.getMessages.mockResolvedValue({data:[target]});mockApi.getRelations.mockResolvedValue({data:[pass,reject,enrollment]});
    mockApi.getReview.mockResolvedValue({summary,records,target,stakes,canReview:true,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY});
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(mode==='list'){fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();}
      for(const record of records)expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${record.id}"]`)).toBeNull();
      expect(screen.queryByText('不通过理由')).not.toBeInTheDocument();
      const arbitration=screen.getByRole('button',{name:/审核仲裁：/});
      fireEvent.click(arbitration);
      expect(await screen.findByRole('region',{name:'审核仲裁'})).toHaveClass('settlement-panel');
      const stakeList=await screen.findByRole('list',{name:'审核押注记录'});
      expect(within(stakeList).getAllByRole('listitem')).toHaveLength(2);
      expect(within(stakeList).getByText('PRO 2点')).toBeVisible();expect(within(stakeList).getByText('CON 2点')).toBeVisible();
      expect(screen.queryByRole('button',{name:'查看审核记录'})).not.toBeInTheDocument();
      expect(screen.queryByRole('region',{name:'审核理由汇总'})).not.toBeInTheDocument();
      fireEvent.mouseDown(arbitration);fireEvent.click(arbitration);
      expect(screen.queryByRole('region',{name:'审核仲裁'})).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'审核不通过 2 点，查看记录'}));
      expect(await screen.findByText('审核临时分类（1 条被审核消息 · 2 条记录）')).toBeVisible();await waitForWorkbenchIdle();
      expect(screen.queryByRole('region',{name:'审核理由汇总'})).not.toBeInTheDocument();
      for(const label of ['审核通过','审核不通过'])expect(await screen.findByRole('button',{name:`汇总${label}：1`})).toBeVisible();
      expect(latest().messages.map((message:Message)=>message.id)).toEqual(['review-target',pass.id,reject.id]);
      expect(latest().standaloneMessageIds).toEqual(new Set(['review-target']));
      expect(screen.queryByRole('button',{name:/汇总支持|汇总反驳/})).not.toBeInTheDocument();
      for(const record of [pass,reject])expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${record.id}"]`)).not.toBeNull();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="review-enrollment"]')).toBeNull();
      expect(screen.getAllByText(target.content)).toHaveLength(1);
      fireEvent.click(screen.getByRole('button',{name:'收起审核不通过分支 review-target'}));await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="review-reject"]')).toBeNull();
      expect(screen.getByText(target.content)).toBeVisible();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="review-pass"]')).not.toBeNull();
      fireEvent.click(screen.getByRole('button',{name:'展开审核不通过分支 review-target'}));await waitForWorkbenchIdle();
      expect(within(view.container.querySelector('[data-workbench-left-panel] [data-msgid="review-reject"]') as HTMLElement).getByText('不通过理由')).toBeVisible();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
      for(const record of [pass,reject])expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${record.id}"]`)).not.toBeNull();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="review-enrollment"]')).toBeNull();
      expect(screen.getAllByText(target.content)).toHaveLength(1);
      fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
      expect(screen.getByRole('button',{name:mode==='graph'?'切换为消息表':'切换为消息图'})).toBeVisible();
      expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${target.id}"]`)).not.toBeNull();
      for(const record of records)expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${record.id}"]`)).toBeNull();
      await jumpToMessageId('review-reject');await waitForWorkbenchIdle();
      expect(await screen.findByRole('button',{name:'汇总审核不通过：1'})).toBeVisible();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="review-reject"]')).not.toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });
  it.each([false,true])('pins the reviewed version and respects its restricted=%s placeholder instead of cached current content',async restricted=>{
    const current={...receivedMessage('review-target','更新后的公开正文'),revision:2};
    const content=restricted?'相关内容暂未公开':'被审核的第一版正文';
    const summary={caseId:'old-case',messageId:current.id,revision:1,status:restricted?'rejected':'pending',fee:6,deposit:10,pass:10,reject:0,selfPass:10,selfReject:0,reviewerCount:0,releaseAt:null,finalized:false};
    const target={...receivedMessage(current.id,content),revision:1,restricted,moderation:summary};
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'审核测试'});
    mockApi.getMessages.mockResolvedValue({data:[current]});mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.getReview.mockResolvedValue({summary,target,records:[],canReview:false,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY});
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      act(()=>window.dispatchEvent(new CustomEvent('gonglun:open-review',{detail:{messageId:current.id,revision:1}})));
      await waitFor(()=>expect(latest().messages).toEqual([expect.objectContaining({id:current.id,revision:1,content,restricted})]));
      expect(screen.queryByText(current.content)).not.toBeInTheDocument();
      const expectReviewedBody=()=>{
        if(restricted){
          expect(screen.getByRole('button',{name:'正文已遮挡，查看审核记录'})).toBeVisible();
          expect(screen.queryByText(content)).not.toBeInTheDocument();
        }else expect(screen.getByText(content)).toBeVisible();
      };
      expectReviewedBody();
      fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
      expectReviewedBody();expect(screen.queryByText(current.content)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
      expect(screen.getByText(current.content)).toBeVisible();
      expect(mockApi.getReview).toHaveBeenCalledWith(current.id,expect.any(AbortSignal),1);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });
  it('keeps a reviewed custom label as its own message card in graph and list views',async()=>{
    const target={...makeRelation(),id:'review-label',relationType:'TAG',content:'被审核的自定义标签',payload:{label:'被审核的自定义标签'},
      parts:[{id:'tag',type:'relation',relation:'tag',roles:{target:[{id:'target',reference:{messageId:'claim'}}]}},{id:'data',type:'data',value:{label:'被审核的自定义标签'}}]};
    const summary={caseId:'label-case',messageId:target.id,revision:1,status:'pending',fee:6,deposit:10,pass:10,reject:0,reviewerCount:0,releaseAt:null,finalized:false};
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'审核测试'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('claim','已有正文')]});mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.getReview.mockResolvedValue({summary,target,records:[],canReview:true,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY});
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      act(()=>window.dispatchEvent(new CustomEvent('gonglun:open-review',{detail:{messageId:target.id,revision:1}})));
      await waitFor(()=>expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${target.id}"]`)).not.toBeNull());
      expect(screen.getByText(/被审核的自定义标签/)).toBeVisible();
      fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
      expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${target.id}"]`)).not.toBeNull();
      expect(screen.getByText(/被审核的自定义标签/)).toBeVisible();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });
  it('does not draw an incomplete raw window before its organization model is complete', async () => {
    const original = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const snapshot = (records: Message[], nextCursor: string | null = null) => ({ windowed: true, regionId: 'region',
      scope: { messageId: 'classification-1', title: '按需讨论' }, sequence: 10, messages: records,
      relations: [], users: [makeUser()], stakes: {}, tagCounts: {}, attentionUsers: {}, nextCursor });
    mockApi.getWorkbenchSnapshot.mockImplementation(async ({ after, cursor, ids }: { after?: number; cursor?: string; ids?: string[] }) =>
      after !== undefined ? snapshot([]) : ids ? snapshot(ids.map(id => makeMessage(id, `定向 ${id}`)))
        : cursor ? snapshot([makeMessage('older', '下一页消息')]) : snapshot([makeMessage('first', '首屏消息')], 'older-cursor'));
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitFor(() => expect(catalogHarness.callbacks).not.toBeNull());
      expect(screen.queryByTestId('graph-view')).toBeNull();
      expect(mockGraphView).not.toHaveBeenCalled();
      expect(mockApi.getWorkbenchSnapshot.mock.calls.some(([query]) => query.cursor)).toBe(false);
      expect(catalogHarness.prioritize).toHaveBeenCalled();
      act(() => catalogHarness.callbacks.onProgress({ ready: false, count: 1, syncing: false, error: '完整结构同步失败' }));
      expect(await screen.findByText('完整结构同步失败')).toBeInTheDocument();
      expect(mockGraphView).not.toHaveBeenCalled();
      const { projectWorkbenchSnapshot } = await import('../utils/workbenchProjection');
      const full = { ...snapshot([makeMessage('first', '首屏消息'), makeMessage('older', '下一页消息')]), windowed: false };
      act(() => catalogHarness.callbacks.onReady({ snapshot: full, projected: projectWorkbenchSnapshot(full), rows: { userRows: [], messageRows: [] } }));
      await waitForWorkbenchIdle();
      expect(latest().messages).toHaveLength(2);
      expect(screen.queryByRole('button', { name: '加载更多消息' })).toBeNull();
    } finally { view.unmount(); mockApi.getWorkbenchSnapshot.mockImplementation(original); catalogHarness.callbacks = null; }
  });

  it('waits for a complete model, keeps leaderboard statistics global and pins a later structure on navigation', async () => {
    const original = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const first = makeMessage('first-global', '首屏');
    const remoteUser = { id: 'remote-user', username: '远端用户', createdAt: '' };
    const remote = Array.from({ length: 52 }, (_, index) => ({ ...makeMessage(`remote-${index}`, `后续消息${index}`), createdBy: remoteUser,
      createdAt: new Date(Date.parse(first.createdAt) + (index + 1) * 1000).toISOString() }));
    const snapshot = { windowed: true, regionId: 'region', scope: { messageId: 'classification-1', title: '全局讨论' },
      sequence: 10, messages: [first], relations: [], users: [makeUser(), remoteUser], stakes: {}, tagCounts: {}, attentionUsers: {}, nextCursor: null };
    mockApi.getWorkbenchSnapshot.mockImplementation(async ({ after }: { after?: number }) => ({ ...snapshot, messages: after === undefined ? [first] : [] }));
    const { projectWorkbenchSnapshot } = await import('../utils/workbenchProjection');
    const { buildLeaderboardRows } = await import('../utils/leaderboardRows');
    const full = { ...snapshot, windowed: false, messages: [first, ...remote] };
    const projected = projectWorkbenchSnapshot(full);
    const rows = buildLeaderboardRows(leaderboardMetrics.buildLeaderboardMetrics(projected.messages, projected.edges, projected.relations, full.users), full.users, projected.counts, projected.bettors);
    catalogHarness.leaderboard.mockResolvedValue(rows);
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitFor(() => expect(catalogHarness.callbacks).not.toBeNull());
      expect(screen.queryByTestId('graph-view')).toBeNull();
      expect(screen.queryByRole('dialog', { name: '排行榜' })).toBeNull();
      act(() => catalogHarness.callbacks.onReady({ snapshot: { ...full, sequence: 9 }, projected, rows }));
      expect(screen.queryByTestId('graph-view')).toBeNull();
      expect(screen.queryByRole('dialog', { name: '排行榜' })).toBeNull();
      act(() => {
        catalogHarness.data = { snapshot: full, projected };
        catalogHarness.progress = { ready: true, count: 53, syncing: false };
        catalogHarness.callbacks.onReady(catalogHarness.data);
      });
      // A complete model still needs its lazy view modules and drawing tasks.
      // Wait until the browser would allow interaction before opening the board.
      await waitForWorkbenchIdle();
      expect(catalogHarness.leaderboard).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole('button', { name: '排行榜' }));
      const dialog = await screen.findByRole('dialog', { name: '排行榜' });
      expect(catalogHarness.leaderboard).toHaveBeenCalledOnce();
      const row = within(dialog).getByText(remoteUser.username).closest('tr')!;
      expect(row.children[4]).toHaveTextContent('52');
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      expect(latest().messages).toHaveLength(53);
      expect(visibleGraphMessages()).toHaveLength(50);
      expect(screen.queryByRole('status', { name: '消息加载进度' })).toBeNull();
      act(() => catalogHarness.callbacks.onProgress({ ready: false, count: 0, syncing: true }));
      expect(visibleGraphMessages()).toHaveLength(50);
      act(() => catalogHarness.callbacks.onReady(catalogHarness.data));
      await jumpToMessageId('remote-51');
      await waitFor(() => expect(visibleGraphMessages().some((message: Message) => message.id === 'remote-51')).toBe(true));
      expect(mockApi.getWorkbenchSnapshot.mock.calls.some(([query]) => query.ids?.includes('remote-51'))).toBe(false);
      expect(visibleGraphMessages()).toHaveLength(53);
      expect(screen.queryByRole('status', { name: '消息加载进度' })).toBeNull();
      expect(screen.queryByRole('button', { name: '加载更多消息' })).toBeNull();
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '过滤' }));
      fireEvent.click(screen.getByRole('button', { name: '按发送者' }));
      const input = screen.getByPlaceholderText('例如: 张三');
      fireEvent.change(input, { target: { value: remoteUser.username } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await screen.findByText('匹配 52 条 / 共 53 条内容消息');
      expect(catalogHarness.filters).toHaveBeenCalledWith(expect.objectContaining({ rules: [expect.objectContaining({ kind: 'sender', username: remoteUser.username })] }));
      expect(latest().messages.some((message: Message) => message.id === first.id)).toBe(false);
      expect(catalogHarness.prioritize).toHaveBeenCalled();
    } finally { view.unmount(); mockApi.getWorkbenchSnapshot.mockImplementation(original); catalogHarness.callbacks = null; }
  });

  it('pages organizations chronologically in both presentations and restores the table page after entering a classification', async () => {
    const original = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const peers = Array.from({ length: 150 }, (_, index) => makeMessage(`peer-${index}`, `同层 ${index}`));
    const children = Array.from({ length: 65 }, (_, index) => makeMessage(`child-${index}`, `分类内部 ${index}`));
    const organization = (id: string, type: string, ids: string[]): Relation => ({
      id, relationType: type, sourceMessageId: null, targetRefs: ids.map(messageId => ({ kind: 'message', messageId })),
      payload: { title: id, targetLayout: 'single-row' }, createdAt: peers[0].createdAt, createdBy: makeUser(),
    });
    const organizations = [organization('A', 'CLASSIFY', children.map(message => message.id)), organization('frame', 'ARRANGE', ['peer-0', 'peer-149'])];
    const relationMessages: Message[] = organizations.map(relation => ({
      id: relation.id, kind: 'RELATION', contentType: 'TEXT', content: relation.id, relationType: relation.relationType,
      targetRefs: relation.targetRefs, relationPayload: relation.payload, createdAt: relation.createdAt, createdBy: relation.createdBy,
    }));
    const full = { regionId: 'region', scope: { messageId: 'classification-1', title: '结构分页' }, sequence: 10,
      messages: [...peers, ...children, ...relationMessages], relations: organizations, users: [makeUser()],
      stakes: {}, tagCounts: {}, attentionUsers: {} };
    mockApi.getWorkbenchSnapshot.mockImplementation(async () => ({ ...full, windowed: true, messages: [], relations: [] }));
    const { projectWorkbenchSnapshot } = await import('../utils/workbenchProjection');
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitFor(() => expect(catalogHarness.callbacks).not.toBeNull());
      act(() => catalogHarness.callbacks.onReady({ snapshot: full, projected: projectWorkbenchSnapshot(full), rows: { userRows: [], messageRows: [] } }));
      await waitFor(() => expect(latest()?.messages.some((message: Message) => message.id === 'frame')).toBe(true));
      const graphIds = visibleGraphMessages().map((message: Message) => message.id);
      expect(graphIds).toEqual(expect.arrayContaining(['frame', 'peer-0', 'A']));
      expect(graphIds).toHaveLength(50);
      expect(graphIds).not.toContain('peer-149');
      expect(graphIds.some((id: string) => id.startsWith('child-'))).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      const row = (id: string) => document.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${id}"]`);
      await waitFor(() => expect(row('frame')).not.toBeNull());
      expect(row('peer-0')).not.toBeNull(); expect(row('peer-149')).toBeNull();
      expect(row('child-0')).toBeNull();
      await scrollToNextStructure();
      const visibleIds = () => [...document.querySelectorAll('[data-workbench-left-panel] [data-msgid]')].map(element => element.getAttribute('data-msgid'));
      const parentIds = visibleIds();
      expect(parentIds.length).toBeGreaterThan(graphIds.length);
      fireEvent.doubleClick(row('A')!);
      await waitFor(() => expect(row('child-0')).not.toBeNull());
      expect(visibleIds().filter(id => id?.startsWith('child-'))).toHaveLength(50);
      expect(row('peer-0')).toBeNull();
      await scrollToNextStructure();
      await waitFor(() => expect(visibleIds().filter(id => id?.startsWith('child-'))).toHaveLength(65));
      fireEvent.click(screen.getByRole('button', { name: '退出分类' }));
      await waitFor(() => expect(visibleIds()).toEqual(parentIds));
    } finally { view.unmount(); mockApi.getWorkbenchSnapshot.mockImplementation(original); catalogHarness.callbacks = null; }
  },15000);

  it('finds unread messages outside the mounted prefix and opens their cross-classification context without truncating the trace', async () => {
    const original = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const other = { ...makeUser(), id: 'other', username: '其他议事人' };
    const peers = Array.from({ length: 75 }, (_, index) => ({ ...makeMessage(`unread-${index}`, `消息 ${index}`), createdBy: other,
      createdAt: new Date(Date.parse('2024-01-01') + index * 1000).toISOString() }));
    const hidden = { ...makeMessage('hidden-related', '另一分类中的相关正文'), createdBy: other };
    const relation = (id: string, type: string, ids: string[], source: string | null = null): Relation => ({ id, relationType: type,
      sourceMessageId: source, targetRefs: ids.map(messageId => ({ kind: 'message', messageId })), payload: { title: id },
      createdAt: '2024-01-02', createdBy: makeUser() });
    const relations = [relation('other-category', 'CLASSIFY', [hidden.id]), { ...relation('cross-unread', 'REFERENCE', ['unread-74'], hidden.id), createdBy: other }];
    mockApi.getReadingState.mockResolvedValue({marks:peers.slice(0,74).map(message=>{
      const version=bodyVersion(message.id),key=messageReadingKey(version.messageId);return {format:3,version,messageId:message.id,scope:'message',key,bodySignature:key,signature:'display:test',state:'READ'};
    })});
    const relationMessages: Message[] = relations.map(item => ({ ...makeMessage(item.id, ''), kind: 'RELATION', relationType: item.relationType,
      relSourceId: item.sourceMessageId, targetRefs: item.targetRefs, relationPayload: item.payload, createdAt: item.createdAt, createdBy: item.createdBy }));
    const full = { regionId: 'region', scope: { messageId: 'classification-1', title: '未读与相关分页' }, sequence: 10,
      messages: [...peers, hidden, ...relationMessages], relations, users: [makeUser(), other], stakes: {}, tagCounts: {}, attentionUsers: {} };
    mockApi.getWorkbenchSnapshot.mockImplementation(async () => ({ ...full, windowed: true, messages: [], relations: [] }));
    const { projectWorkbenchSnapshot } = await import('../utils/workbenchProjection');
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitFor(() => expect(catalogHarness.callbacks).not.toBeNull());
      act(() => {
        catalogHarness.data = { snapshot: full, projected: projectWorkbenchSnapshot(full), rows: { userRows: [], messageRows: [] } };
        catalogHarness.callbacks.onReady(catalogHarness.data);
      });
      const card = (id: string) => document.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${id}"]`);
      await waitFor(() => expect(card('unread-0')).not.toBeNull());
      expect(card('unread-74')).toBeNull(); expect(card(hidden.id)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '主页' }));
      fireEvent.click(screen.getByRole('radio', { name: /^待阅或有新提醒$/ }));
      await waitFor(() => expect(catalogHarness.filters).toHaveBeenCalledWith(expect.objectContaining({ home: {scope:'all',status:'pending'} })));
      const filtered = await catalogHarness.filters.mock.results.at(-1)!.value;
      expect([...filtered.home.matchIds]).toContain('unread-74');
      await waitFor(() => expect(card('unread-74')).not.toBeNull());
      expect(card('unread-0')).toBeNull(); expect(card(hidden.id)).toBeNull();
      const target = within(card('unread-74')!);
      fireEvent.click(target.getByRole('button', { name: /其他相关消息：1/ }));
      await act(async () => fireEvent.click(within(screen.getByRole('dialog',{name:'其他相关消息：1'})).getByRole('button', { name: '查看' })));
      await waitFor(() => expect(card(hidden.id)).not.toBeNull());
      expect(card('unread-74')).not.toBeNull();
      expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(1);
      expect(latest().visibleMessageIds).toBeUndefined();
      fireEvent.click(screen.getByRole('button', { name: '退出查看' }));
      await waitFor(() => expect(card(hidden.id)).toBeNull());
      expect(card('unread-74')).not.toBeNull();
    } finally { view.unmount(); graphRendering.actual = false; mockApi.getWorkbenchSnapshot.mockImplementation(original); catalogHarness.callbacks = null; }
  });

  it.each(['graph', 'list'].flatMap(mode => [false, true].flatMap(worker => [{ home: true, trace: false }, { home: true, trace: true }, { home: false, trace: true }].map(selection => ({ mode, worker, ...selection })))))(
  'keeps reading positions while dimming related and hiding unrelated read messages ($mode, worker: $worker, home: $home, trace: $trace)', async ({ mode, worker, home, trace }) => {
    const original = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const records = ['read-context', 'pending-reply', 'isolated-read', 'remaining-unread'].map(id => receivedMessage(id, id));
    const relation = { ...makeRelation(), id: 'reading-reply', sourceMessageId: 'pending-reply', targetRefs: [{ kind: 'message' as const, messageId: 'read-context' }] };
    mockApi.getScope.mockResolvedValue({ messageId: 'classification-1', title: '稳定阅读位置' });
    mockApi.getMessages.mockResolvedValue({ data: records }); mockApi.getRelations.mockResolvedValue({ data: [relation] });
    mockApi.getReadingState.mockResolvedValue({ marks: [] });
    const full = await original({ parent: 'classification-1' });
    mockApi.getWorkbenchSnapshot.mockImplementation(async () => worker ? { ...full, windowed: true, messages: [], relations: [] } : full);
    graphRendering.actual = true;
    const geometry = trace ? vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400)) : undefined;
    const view = render(<><style>{readingPresentationCss}</style><MessageWorkbenchPage /></>);
    try {
      if (worker) {
        const { projectWorkbenchSnapshot } = await import('../utils/workbenchProjection');
        await waitFor(() => expect(catalogHarness.callbacks).not.toBeNull());
        act(() => {
          catalogHarness.data = { snapshot: full, projected: projectWorkbenchSnapshot(full), rows: { userRows: [], messageRows: [] } };
          catalogHarness.callbacks.onReady(catalogHarness.data);
        });
      }
      await waitForWorkbenchIdle();
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      const panel = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const card = (id: string) => panel.querySelector<HTMLElement>(`[data-msgid="${id}"]:not([data-rel-overlay])`)!;
      if (home) {
        fireEvent.click(screen.getByRole('button', { name: '主页' }));
        fireEvent.click(screen.getByRole('radio', { name: '待阅或有新提醒' }));
      }
      await waitForWorkbenchIdle();
      if (trace) {
        for (const id of ['read-context', 'isolated-read', 'remaining-unread']) fireEvent.click(card(id));
        fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
        await waitForWorkbenchIdle();
      }
      const remaining = card('remaining-unread'), context = card('read-context'), isolated = card('isolated-read');
      const host = panel.querySelector('[data-workbench-view-cache]')!.firstElementChild;
      const position = [remaining.style.left, remaining.style.top, remaining.style.width];
      panel.scrollTop = 80;
      const filterCalls = catalogHarness.filters.mock.calls.length;
      if (!trace && !worker && mode === 'graph') {
        mockApi.markReading.mockRejectedValueOnce(new Error('阅读状态保存失败'));
        fireEvent.click(within(context).getByRole('button', { name: /^显示提示 / }));
        await act(async () => fireEvent.click(within(screen.getByRole('tooltip')).getByRole('button', { name: '标记当前消息已阅' })));
        expect(within(screen.getByRole('tooltip')).getByRole('alert')).toHaveTextContent('阅读状态保存失败');
        expect(context).not.toHaveAttribute('data-reading-presentation');
        expect(context).toBeVisible();
        expect(catalogHarness.filters.mock.calls.length).toBe(filterCalls);
        fireEvent.pointerDown(document.body);
      }
      const confirm = async (id: string) => {
        fireEvent.click(within(card(id)).getByRole('button', { name: /^显示提示 / }));
        const popup = screen.getByRole('tooltip');
        await act(async () => fireEvent.click(within(popup).getByRole('button', { name: '标记当前消息已阅' })));
        await waitFor(() => expect(within(popup).getByRole('button', { name: '当前消息已阅' })).toBeDisabled());
        fireEvent.pointerDown(document.body);
      };
      await confirm('read-context');
      expect(card('read-context')).toBe(context);
      expect(context).toHaveAttribute('data-reading-presentation', 'dimmed');
      expect(context).toBeVisible();
      await confirm('isolated-read');
      expect(card('isolated-read')).toBe(isolated);
      expect(isolated).toHaveAttribute('data-reading-presentation', 'hidden');
      expect(isolated).not.toBeVisible();
      expect(card('remaining-unread')).toBe(remaining);
      expect(remaining).toBeVisible();
      expect([remaining.style.left, remaining.style.top, remaining.style.width]).toEqual(position);
      expect(panel.scrollTop).toBe(80);
      expect(panel.querySelector('[data-workbench-view-cache]')!.firstElementChild).toBe(host);
      expect(catalogHarness.filters.mock.calls.length).toBe(filterCalls);
      expect(screen.queryByText('正在准备全局筛选结果…')).toBeNull();
      expect(screen.queryByRole('dialog', { name: '正在绘制' })).toBeNull();
      if (trace) {
        const next = within(screen.getByRole('region', { name: '追溯阅读' })).getByRole('button', { name: '本组已读并继续' });
        expect(next).toBeEnabled();
        fireEvent.click(next);
        await waitForWorkbenchIdle();
        expect(view.container.querySelector('[data-reading-current-id]')).toHaveAttribute('data-reading-current-id', 'pending-reply');
      } else {
        // Explicit revisits reveal an otherwise hidden read card, and unread restores it normally.
        act(() => panel.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: ['isolated-read'] } })));
        expect(isolated).toBeVisible();
        fireEvent.click(within(isolated).getByRole('button', { name: /^显示提示 / }));
        await act(async () => fireEvent.click(within(screen.getByRole('tooltip')).getByRole('button', { name: '将此消息标为未阅' })));
        expect(isolated).not.toHaveAttribute('data-reading-presentation');
        expect(isolated).toBeVisible();
        fireEvent.pointerDown(document.body);
        await confirm('isolated-read');
        await confirm('pending-reply');
        expect(context).toHaveAttribute('data-reading-presentation', 'hidden');
        expect(context).not.toBeVisible();
        if (!screen.queryByRole('radio', { name: '已阅且无新提醒' })) fireEvent.click(screen.getByRole('button', { name: '主页' }));
        fireEvent.click(screen.getByRole('radio', { name: '已阅且无新提醒' }));
        await waitForWorkbenchIdle();
        fireEvent.click(screen.getByRole('radio', { name: '待阅或有新提醒' }));
        await waitForWorkbenchIdle();
        expect(card('isolated-read')).toBeNull();
        expect(card('read-context')).toBeNull();
        expect(card('remaining-unread')).toBeVisible();
      }
    } finally { view.unmount(); geometry?.mockRestore(); graphRendering.actual = false; mockApi.getWorkbenchSnapshot.mockImplementation(original); catalogHarness.callbacks = null; }
  });

  it('排行榜关闭重开复用统计与显示状态，不重新请求数据或读写设置，主动刷新仍可用', async () => {
    fixture();
    const metrics = vi.spyOn(leaderboardMetrics, 'buildLeaderboardMetrics');
    const reads = vi.spyOn(Storage.prototype, 'getItem');
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    try {
      render(<MessageWorkbenchPage />);
      await waitFor(() => expect(latest()?.messages.some((message: Message) => message.id === 'A')).toBe(true));
      // fireEvent bypasses the browser's inert guard. Opening before the initial
      // draw finishes can leave its unrelated progress dialog behind the board.
      await waitForWorkbenchIdle();
      expect(metrics).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '排行榜' }));
      expect(screen.getByRole('dialog', { name: '正在打开排行榜' })).toBeInTheDocument();
      expect(metrics).not.toHaveBeenCalled();
      await screen.findByRole('dialog', { name: '排行榜' });
      fireEvent.click(screen.getByRole('button', { name: '消息榜' }));
      const initialCalculations = metrics.mock.calls.length;
      const initialReads = reads.mock.calls.filter(([key]) => key === LEADERBOARD_PREFERENCES_KEY).length;
      const initialRequests = mockApi.getWorkbenchSnapshot.mock.calls.length;
      const initialDraws = mockGraphView.mock.calls.length;
      for (let index = 0; index < 3; index++) {
        fireEvent.click(within(screen.getByRole('dialog', { name: '排行榜' })).getByRole('button', { name: '关闭' }));
        expect(document.querySelector('[data-popup-overlay]')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '排行榜' }));
        expect(screen.getByRole('dialog', { name: '正在打开排行榜' })).toBeInTheDocument();
        await screen.findByRole('dialog', { name: '排行榜' });
        expect(screen.getByPlaceholderText('搜索消息ID/议事人ID/议事人')).toBeInTheDocument();
      }
      expect(metrics).toHaveBeenCalledTimes(initialCalculations);
      expect(reads.mock.calls.filter(([key]) => key === LEADERBOARD_PREFERENCES_KEY)).toHaveLength(initialReads);
      expect(writes.mock.calls.filter(([key]) => key === LEADERBOARD_PREFERENCES_KEY)).toHaveLength(0);
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(initialRequests);
      expect(mockGraphView).toHaveBeenCalledTimes(initialDraws);
      const initialSnapshot = await mockApi.getWorkbenchSnapshot.mock.results[0].value;
      const emptyDelta = { ...initialSnapshot, messages: [], relations: [], users: [], stakes: {}, tagCounts: {}, attentionUsers: {} };
      mockApi.getWorkbenchSnapshot.mockResolvedValueOnce(emptyDelta);
      fireEvent.click(within(screen.getByRole('dialog', { name: '排行榜' })).getByRole('button', { name: '刷新' }));
      await waitFor(() => expect(mockApi.getWorkbenchSnapshot.mock.calls.length).toBeGreaterThan(initialRequests));
      await screen.findByText('刷新完成，暂无新变化');
      expect(mockApi.getWorkbenchSnapshot.mock.lastCall?.[0].after).toBe(initialSnapshot.sequence);
      expect(mockApi.subscribeChanges).toHaveBeenCalledOnce();
      expect(metrics).toHaveBeenCalledTimes(initialCalculations);
      expect(mockGraphView).toHaveBeenCalledTimes(initialDraws);
      mockApi.getWorkbenchSnapshot.mockResolvedValueOnce({ ...emptyDelta, sequence: initialSnapshot.sequence + 1,
        messages: [makeMessage('refresh-added', '增量更新消息')], users: [makeUser()] });
      fireEvent.click(within(screen.getByRole('dialog', { name: '排行榜' })).getByRole('button', { name: '刷新' }));
      await screen.findByText('刷新完成，已更新最新数据');
      expect(within(screen.getByRole('dialog', { name: '排行榜' })).getByText('增量更新消息')).toBeInTheDocument();
      expect(mockApi.getWorkbenchSnapshot.mock.lastCall?.[0].after).toBe(initialSnapshot.sequence);
      expect(mockApi.subscribeChanges).toHaveBeenCalledOnce();
      expect(metrics).toHaveBeenCalledTimes(initialCalculations + 1);
    } finally {
      metrics.mockRestore();
      reads.mockRestore();
      writes.mockRestore();
    }
  });

  it('排行榜拖动后自适应并关闭，真实消息图连续切换选择及延时操作仍正常', async () => {
    mockApi.getScope.mockResolvedValue({ messageId: 'classification-1', title: '排行榜交互回归' });
    mockApi.getMessages.mockResolvedValue({ data: [makeMessage('click-a', '第一条消息'), makeMessage('click-b', '第二条消息')] });
    mockApi.getRelations.mockResolvedValue({ data: [] });
    graphRendering.actual = true;
    const metrics = vi.spyOn(leaderboardMetrics, 'buildLeaderboardMetrics');
    const view = render(<><GestureShortcutManager onConfirm={vi.fn()} /><MessageWorkbenchPage /></>);
    try {
      await waitFor(() => expect(document.querySelector('[data-msgid="click-a"]')).not.toBeNull());
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: '排行榜' }));
      const dialog = await screen.findByRole('dialog', { name: '排行榜' });
      vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 100, 640, 400));
      const handle = screen.getByRole('separator', { name: '调整排行榜宽高' });
      const pointer = (type: string, x: number, y: number) => Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 1 });
      fireEvent(handle, pointer('pointerdown', 840, 500));
      fireEvent(handle, pointer('pointermove', 880, 600));
      fireEvent(handle, pointer('pointermove', 940, 560));
      fireEvent(handle, pointer('pointerup', 940, 560));
      fireEvent.lostPointerCapture(handle);
      expect(dialog).toHaveStyle({ width: '740px', height: '460px' });
      expect(screen.queryByRole('dialog', { name: '快捷符输入蒙版' })).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: '自适应窗口' }));
      expect(dialog).toHaveStyle({ height: 'auto', margin: 'auto' });
      expect(dialog.style.getPropertyValue('--leaderboard-body-flex')).toBe('');
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
      const calculations = metrics.mock.calls.length;
      const clickAndCheck = (id: string, selected: boolean) => {
        fireEvent.click(document.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${id}"]`)!);
        expect(latest().draftUnits.some((unit: { messageId: string }) => unit.messageId === id)).toBe(selected);
        expect(document.querySelector('[aria-busy="true"]')).toBeNull();
        expect(document.querySelector('[data-popup-overlay]')).toBeNull();
      };
      for (let index = 0; index < 20; index++) {
        clickAndCheck('click-a', index % 2 === 0);
        clickAndCheck('click-b', index % 2 === 0);
      }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      act(() => { vi.advanceTimersByTime(10000); });
      clickAndCheck('click-a', true);
      clickAndCheck('click-b', true);
      expect(metrics).toHaveBeenCalledTimes(calculations);
      expect(screen.getByRole('button', { name: '清空' })).toBeEnabled();
    } finally {
      view.unmount();
      vi.useRealTimers();
      metrics.mockRestore();
      graphRendering.actual = false;
    }
  });

  it('keeps redundant trace summaries, structure views and recent record lists out of the composer', async () => {
    mockApi.getScope.mockResolvedValue({ messageId: 'classification-1', title: '测试分类' });
    mockApi.getMessages.mockResolvedValue({ data: [
      makeMessage('text-older', '较早文本'),
      { ...makeMessage('text-newer', '较新文本'), createdAt: '2024-01-01T00:05:00Z' },
      { ...makeMessage('proposal', '提案正文'), kind: 'GOVERNANCE', relationType: 'PROPOSAL' },
      { ...makeMessage('round', '结算记录'), kind: 'ROUND' },
      { ...makeMessage('result', '结算完成'), kind: 'ROUND_RESULT' },
    ] });
    mockApi.getRelations.mockResolvedValue({ data: [makeRelation(), {
      id: 'join', relationType: 'JOIN', sourceMessageId: 'classification-1', targetRefs: [{ kind: 'message', messageId: 'text-older' }],
      createdAt: '2024-01-01T00:01:00Z', createdBy: makeUser(),
    }] });
    render(<MessageWorkbenchPage />);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    expect(screen.queryByText('最近文本消息')).toBeNull();expect(screen.queryByText('最近关系消息')).toBeNull();
    expect(screen.queryByText(/结构视图/)).toBeNull();expect(screen.queryByText('当前模式：追溯')).toBeNull();
    expect(screen.queryByRole('group',{name:'追溯起点'})).toBeNull();
    expect(screen.getByRole('button',{name:'设为追溯消息'})).toBeInTheDocument();
    expect(mockGraphView).toHaveBeenCalled();
  });

  it('shows clicked message connections in graph and list views before starting a reading trace',async()=>{
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'引用的引用'});
    mockApi.getMessages.mockResolvedValue({data:['A','C','D'].map(id=>makeMessage(id,`${id} 的正文`))});
    const reference=(id:string,source:string,target:string):Relation=>({id,relationType:'REFERENCE',sourceMessageId:source,
      targetRefs:[{kind:'message',messageId:target}],createdAt:'2024-01-02',createdBy:makeUser(),payload:{}});
    mockApi.getRelations.mockResolvedValue({data:[reference('B','C','A'),reference('E','D','B')]});
    const view=render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    expect(screen.queryByRole('region',{name:'消息关联'})).toBeNull();
    await act(async()=>latest().onEdgeLabelSingleClick(event(),'E'));
    let connections=screen.getByRole('region',{name:'消息关联'});
    expect(connections).toHaveAttribute('data-selected-message-connections','E');
    expect(connections).toHaveTextContent('当前消息：');
    expect(within(connections).getByRole('region',{name:'本消息指向'})).toHaveTextContent('本消息指向 · 0 条关联');
    await act(async()=>latest().onMessageClick(event(),'D'));
    connections=screen.getByRole('region',{name:'消息关联'});
    expect(connections).toHaveAttribute('data-selected-message-connections','D');
    expect(within(connections).getByRole('region',{name:'本消息指向'})).toContainElement(within(connections).getByRole('button',{name:'阅读关联消息 B'}));
    expect(within(connections).getByRole('button',{name:'阅读关联消息 B'})).toHaveTextContent('B');
    expect(within(connections).queryByRole('button',{name:'阅读关联消息 A'})).toBeNull();
    expect(within(connections).queryByRole('button',{name:'阅读关联消息 C'})).toBeNull();
    expect(screen.queryByRole('region',{name:'追溯阅读'})).toBeNull();
    expect(screen.queryByRole('group',{name:'追溯起点'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="C"]')!);
    connections=screen.getByRole('region',{name:'消息关联'});
    expect(connections).toHaveAttribute('data-selected-message-connections','C');
    expect(within(connections).getByRole('region',{name:'本消息指向'})).toHaveTextContent('A 的正文');
    expect(screen.queryByRole('region',{name:'追溯阅读'})).toBeNull();
    expect(mockApi.markReading).not.toHaveBeenCalled();
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it.each(['callback','url','points'].flatMap(navigation=>['result','close'].map(recordKind=>({navigation,recordKind}))))('opens the existing settlement entry for an old $recordKind record through $navigation without rendering or attaching settlement messages',async({navigation,recordKind})=>{
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'结算入口'});
    const record:Message={...makeMessage('value-record','价值仲裁记录'),kind:'ROUND_RESULT',targetRefs:[{kind:'message',messageId:'internal-value-pool'}],relationPayload:{subjectId:'target',settlementType:'VALUE',roundId:'settled-round'} as unknown as Message['relationPayload']};
    if(recordKind==='close')Object.assign(record,{kind:'OPERATIONS',relationType:'OPERATIONS',parts:[{id:'relation',type:'relation',relation:'terminate',roles:{target:[{id:'target',reference:{messageId:'internal-value-pool'}}]}}]});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('target','目标正文'),record]});
    mockApi.getRelations.mockResolvedValue({data:[]});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    if(navigation==='url')viewerRoute.query='msg=value-record';
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="value-record"]')).toBeNull();
      if(navigation==='callback')await act(async()=>latest().onNavigateToMessage(record.id));
      if(navigation==='points')await act(async()=>window.dispatchEvent(new CustomEvent('points-navigate',{detail:{messageId:record.id,scopeMessageId:'root',roundId:'settled-round',txType:'TRANSFER'}})));
      await waitForWorkbenchIdle();
      expect(latest().settlementOpenMsgId).toBe('target');expect(latest().settlementOpenType).toBe('VALUE');
      expect(sessionStorage.getItem('settlementHighlightRound')).toBe('settled-round');
      expect(await screen.findByRole('heading',{name:/价值仲裁/})).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="value-record"]')).toBeNull();
      expect(await screen.findByRole('heading',{name:/价值仲裁/})).toBeInTheDocument();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
      expect((window as any).__addSettlementMessage).toBeUndefined();
    }finally{view.unmount();viewerRoute.query='';graphRendering.actual=false;geometry.mockRestore();}
  });

  it.each(['url','points'])('opens the usage contribution record through %s without a settlement alert',async navigation=>{
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'使用贡献'});
    const record:Message={...makeMessage('usage-record','2026-11-09 使用贡献：累计 282 贡献点。'),kind:'ROUND_RESULT',relationType:'ROUND_RESULT',
      relationPayload:{source:'grant',inputs:{reason:'usage-daily-summary'}} as Message['relationPayload']};
    mockApi.getMessages.mockResolvedValue({data:[record]});mockApi.getRelations.mockResolvedValue({data:[]});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    if(navigation==='url')viewerRoute.query='msg=usage-record';
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(navigation==='points')await act(async()=>window.dispatchEvent(new CustomEvent('points-navigate',{detail:{messageId:record.id,scopeMessageId:'root',roundId:null,txType:'USAGE_REWARD'}})));
      await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="usage-record"]')).toHaveTextContent(record.content);
      expect(latest().settlementOpenMsgId).toBeNull();
      expect(screen.queryByText(/这条结算记录没有保存目标消息/)).toBeNull();
    }finally{view.unmount();viewerRoute.query='';graphRendering.actual=false;geometry.mockRestore();}
  });

  it('finishes a failed settlement navigation and keeps its dismissed alert closed',async()=>{
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'历史结算'});
    const record:Message={...makeMessage('unlinked-result','历史结算'),kind:'ROUND_RESULT'};
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('other','其他消息'),record]});mockApi.getRelations.mockResolvedValue({data:[]});
    const view=render(<MessageWorkbenchPage/>),onComplete=vi.fn();
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      await act(async()=>latest().onNavigateToMessage(record.id,{onComplete}));
      expect(onComplete).toHaveBeenCalledExactlyOnceWith(false);
      expect(screen.getByText(/这条结算记录没有保存目标消息/)).toBeVisible();
      fireEvent.click(screen.getByRole('button',{name:'已阅'}));
      view.rerender(<MessageWorkbenchPage/>);await waitForWorkbenchIdle();
      expect(screen.queryByText(/这条结算记录没有保存目标消息/)).toBeNull();
      expect(onComplete).toHaveBeenCalledTimes(1);
    }finally{view.unmount();}
  });

  it('opens the join history when an initial URL targets a hidden join record',async()=>{
    fixture('CLASSIFY',true);
    viewerRoute.query='msg=join-B';
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      expect(screen.getByText('加入记录临时分类（1）')).toBeInTheDocument();
      expect(latest().showJoinRecords).toBe(true);
      expect(latest().messages.map((message:Message)=>message.id)).toContain('join-B');
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{view.unmount();viewerRoute.query='';}
  });

  it('keeps the classification header and navigation after a tab resumes, with only incremental reads',async()=>{
    fixture();
    const original=mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const initial=await original({parent:'classification-1'});
    initial.sequence=10;
    const member=initial.messages.find((message:Message)=>message.id==='B')!;
    let hidden=false,resumed=false;
    const visibility=vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
    mockApi.getWorkbenchSnapshot.mockImplementation(async({after}:{after?:number})=>after===undefined?initial:{
      ...initial,sequence:resumed?11:10,
      messages:resumed&&after===10?[{...member,content:'后台同步后的分类观点'}]:[],relations:[],
    });
    try{
      render(<MessageWorkbenchPage/>);
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      await act(async()=>latest().onMessageDoubleClick(event(),'A'));
      const header=()=>screen.getByRole('button',{name:'退出分类'}).parentElement!;
      expect(header()).toHaveTextContent('A');
      expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
      act(()=>{hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
      const beforeResume=mockApi.getWorkbenchSnapshot.mock.calls.length;
      act(()=>{
        hidden=false;resumed=true;
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
      });
      await waitFor(()=>expect(latest().messages.find((message:Message)=>message.id==='B')?.content).toBe('后台同步后的分类观点'));
      expect(header()).toHaveTextContent('A');
      expect(header()).not.toHaveTextContent('建立分类');
      expect(mockApi.getWorkbenchSnapshot.mock.calls.slice(beforeResume).every(([query])=>query.after===10)).toBe(true);
      expect(mockApi.getWorkbenchSnapshot.mock.calls.filter(([query])=>query.after===undefined)).toHaveLength(1);
      expect(mockApi.subscribeChanges).toHaveBeenCalledOnce();
      const beforeExit=mockApi.getWorkbenchSnapshot.mock.calls.length;
      fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
      expect(header()).toHaveTextContent('测试分类');
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(beforeExit);
      expect(mockNavigate).not.toHaveBeenCalled();
    }finally{
      visibility.mockRestore();
      mockApi.getWorkbenchSnapshot.mockImplementation(original);
    }
  });

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
    fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '独立发言' } });
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
    expect(latest().crossCanvasRelations.get('source')?.outgoing['引用']).toEqual(['reference']);
    expect(latest().messages.some((message:Message)=>message.id==='target')).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    await act(async()=>latest().onMessageDoubleClick(event(),'B'));
    expect(latest().crossCanvasRelations.get('target')?.incoming['引用']).toEqual(['reference']);
  });

  it.each(['REFERENCE','REPLY','ANNOTATION','AGREE','DISAGREE'].flatMap(type=>[
    {type,side:'source',scope:'A',viewMode:'graph'}, {type,side:'target',scope:'B',viewMode:'list'},
  ]))('views cross-canvas $type from its $side in $viewMode with distance one and a single full-exit button',async({type,side,scope,viewMode})=>{
    const relation=(id:string,relationType:string,targets:string[],sourceMessageId:string|null=null):Relation=>({id,relationType,sourceMessageId,targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdAt:'2026-01-01',createdBy:makeUser()});
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'测试分类'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('source','来源正文'),makeMessage('target','目标正文')]});
    mockApi.getRelations.mockResolvedValue({data:[relation('A','CLASSIFY',['source']),relation('B','CLASSIFY',['target']),relation('cross',type,['target'],'source')]});
    graphRendering.actual=true;
    try{
      render(<MessageWorkbenchPage/>);
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
      await act(async()=>latest().onMessageDoubleClick(event(),scope));
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      if(viewMode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      const {toggle}=await waitFor(()=>{
        expect(document.querySelector('[aria-busy="true"]')).toBeNull();
        const card=within(document.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${side}"]`)!);
        return {card,toggle:card.getByRole('button',{name:/其他相关消息：1/})};
      });
      expect(toggle).toHaveAttribute('aria-expanded','false');
      fireEvent.click(toggle);
      const group=within(within(screen.getByRole('dialog',{name:'其他相关消息：1'})).getByRole('group',{name:side==='source'?'发出的关联':'指向本消息的关联'}));
      expect(group.getByRole('button',{name:/选择相关.*消息/})).toHaveTextContent('cross');
      fireEvent.click(group.getByRole('button',{name:/选择相关.*消息/}));
      await act(async()=>fireEvent.click(group.getByRole('button',{name:'查看'})));
      await waitForWorkbenchIdle();
      expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(1);
      expectTraceOrigin('cross');
      for(const id of ['source','target'])expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${id}"]`)).not.toBeNull();
      expect(document.querySelector('[data-workbench-left-panel] [data-cross-canvas-related-messages]')).toBeNull();
      expect(screen.queryByRole('button',{name:'退出全部'})).toBeNull();
      expect(screen.queryByRole('button',{name:'退出追溯'})).toBeNull();
      let exit=screen.getByRole('button',{name:'退出查看'});
      const staging=document.querySelector('[data-guide-selection-staging]')!;
      expect(exit.compareDocumentPosition(staging)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // A nested manual trace still shares the same full-exit action.
      await act(async()=>latest().onMessageClick(event(),side));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));
      expectTraceOrigin(side);
      exit=screen.getByRole('button',{name:'退出查看'});
      fireEvent.click(exit);
      expect(screen.queryByRole('spinbutton',{name:'向上追溯距离'})).toBeNull();
      expect(screen.queryByRole('button',{name:'退出查看'})).toBeNull();
      expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${side}"]`)).not.toBeNull();
      expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${side==='source'?'target':'source'}"]`)).toBeNull();
      expect(document.querySelector('[data-guide-selection-staging]')).toHaveTextContent('cross');
      expect(screen.getByRole('button',{name:viewMode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{graphRendering.actual=false;}
  });

  it.each([['REPLY','回复'],['AGREE','支持'],['DISAGREE','反驳'],['RECOMMEND','推荐'],['ARCHIVE','冷藏']])(
    'views the original %s edge from its summary without leaving discussion layout',async(type,label)=>{
    const relation=(id:string,relationType:string,sourceMessageId:string,target:string):Relation=>({id,relationType,sourceMessageId,
      targetRefs:[{kind:'message',messageId:target}],createdAt:'2026-01-01',createdBy:makeUser()});
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'测试分类'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('source','关系来源正文'),makeMessage('target','目标正文'),makeMessage('detail','对关系的回复正文') ]});
    mockApi.getRelations.mockResolvedValue({data:[relation('original',type,'source','target'),
      ...(['RECOMMEND','ARCHIVE'].includes(type)?[]:[relation('detail-reply','REPLY','detail','original')])]});
    graphRendering.actual=true;
    const view=render(<MessageWorkbenchPage/>);
    try{
      const summary=(await screen.findAllByRole('button',{name:`汇总${label}：1`})).find(button=>button.dataset.jumpMsgids==='original')!;
      await waitForWorkbenchIdle();
      expect(latest().discussionView.mode).toBe('discussion');
      fireEvent.click(summary);
      const row=screen.getByRole('dialog').querySelector<HTMLElement>('[data-related-relation-id="original"]')!;
      await act(async()=>fireEvent.click(within(row).getByRole('button',{name:'查看'})));
      await waitForWorkbenchIdle();
      expectTraceOrigin('original');
      expect(latest().discussionView.mode).toBe('discussion');
      const panel=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      expect(panel.querySelector('[data-discussion-region]')).not.toBeNull();
      expect(panel.querySelector('[data-directed-edge-label="original"]')).not.toBeNull();
      for(const id of ['source','target'])expect(panel.querySelector(`[data-msgid="${id}"]`)).not.toBeNull();
      if(type==='ARCHIVE'||type==='RECOMMEND'){
        expect(panel.querySelector('.themed-message[data-msgid="original"]')).toBeNull();
        expect(panel.querySelector('[data-msgid="original"]')).not.toBeNull();
      }
      fireEvent.click(screen.getAllByRole('button',{name:`汇总${label}：1`}).find(button=>button.dataset.jumpMsgids==='original')!);
      const viewedRow=screen.getByRole('dialog').querySelector<HTMLElement>('[data-related-relation-id="original"]')!;
      expect(viewedRow).toHaveAttribute('data-view-target','true');
      expect(within(viewedRow).getByRole('button',{name:/^消息状态与影响 original：/})).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'关闭其他相关消息'}));
      fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
      await waitForWorkbenchIdle();
      expect(latest().discussionView.mode).toBe('discussion');
      expect(screen.getAllByRole('button',{name:`汇总${label}：1`}).some(button=>button.dataset.jumpMsgids==='original')).toBe(true);
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;}
  });

  it.each([['REPLY','回复'],['AGREE','支持'],['DISAGREE','反驳'],['RECOMMEND','推荐']])('locates a visible %s summary in its popup without moving or expanding the canvas',async(type,label)=>{
    const relation:Relation={id:'summary-target',relationType:type,sourceMessageId:'source',targetRefs:[{kind:'message',messageId:'target'}],createdAt:'2026-01-01',createdBy:makeUser()};
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'汇总通知'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('source','回复正文'),makeMessage('target','原消息')]});
    mockApi.getRelations.mockResolvedValue({data:[relation]});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
      if(this.hasAttribute('data-workbench-left-panel'))return new DOMRect(0,100,600,500);
      return new DOMRect(100,200,300,80);
    });
    const view=render(<MessageWorkbenchPage/>);
    try{
      const summary=await screen.findByRole('button',{name:`汇总${label}：1`});await waitForWorkbenchIdle();
      const panel=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      panel.scrollTop=730;panel.scrollLeft=90;
      const complete=vi.fn(),reveal=vi.fn();panel.addEventListener(REVEAL_VIRTUAL_MESSAGE,reveal);
      await act(async()=>latest().onNavigateToMessage('summary-target',{select:false,onComplete:complete}));
      await waitFor(()=>expect(complete).toHaveBeenCalledExactlyOnceWith(true));
      await waitForWorkbenchIdle();
      const row=screen.getByRole('dialog',{name:'其他相关消息：1'}).querySelector('[data-related-relation-id="summary-target"]');
      expect(row).toHaveAttribute('data-view-target','true');
      expect([panel.scrollTop,panel.scrollLeft]).toEqual([730,90]);
      expect(screen.getByRole('button',{name:`汇总${label}：1`})).toBe(summary);
      expect(panel.querySelector('[data-directed-edge-label="summary-target"]')).toBeNull();
      expect(reveal).not.toHaveBeenCalled();
      expect(latest().draftUnits).toEqual([]);expect(latest().discussionView.mode).toBe('discussion');
      fireEvent.click(screen.getByRole('button',{name:'关闭其他相关消息'}));
      await waitForWorkbenchIdle();expect([panel.scrollTop,panel.scrollLeft]).toEqual([730,90]);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['loaded', 'failed', 'timed out'])('keeps related-view progress visible while an endpoint request is %s',async outcome=>{
    const user=makeUser();
    const relation:Relation={id:'cross',relationType:'REFERENCE',sourceMessageId:'source',targetRefs:[{kind:'message',messageId:'remote'}],createdAt:'2026-01-01',createdBy:user};
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'直接打开的分类'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('source','本地消息')]});
    mockApi.getRelations.mockResolvedValue({data:[relation]});
    let complete!: (value: { messages: Message[]; relations: Relation[] }) => void, fail!: (error: Error) => void;
    mockApi.getMessageContext.mockImplementationOnce(() => new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='source')).toBe(true));
      await waitForWorkbenchIdle();
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button',{name:/其他相关消息：1/}));
      await act(async()=>fireEvent.click(screen.getByRole('button',{name:'查看'})));
      expect(screen.getByRole('dialog',{name:'正在加载消息'})).toBeInTheDocument();
      expect(mockApi.getMessageContext).not.toHaveBeenCalled();
      await act(async()=>{await vi.advanceTimersByTimeAsync(64);});
      expect(mockApi.getMessageContext).toHaveBeenCalledWith(['remote'],expect.any(AbortSignal));
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(screen.getByRole('dialog',{name:'正在加载消息'})).toBeInTheDocument();
      if(outcome==='timed out'){
        await act(async()=>{await vi.advanceTimersByTimeAsync(WORKBENCH_DRAWING_TIMEOUT_MS);});
        expect(mockApi.getMessageContext.mock.lastCall![1].aborted).toBe(true);
        expect(screen.getByRole('alert')).toHaveTextContent('超过 30 秒');
        await act(async()=>complete({messages:[makeMessage('remote','迟到的消息')],relations:[]}));
      }else if(outcome==='failed'){
        await act(async()=>fail(new Error('关联端点读取失败')));
        await waitForWorkbenchIdle();
        expect(screen.getByText('关联端点读取失败')).toBeInTheDocument();
      }else{
        await act(async()=>complete({messages:[makeMessage('remote','另一画布的消息')],relations:[]}));
        await waitForWorkbenchIdle();
      }
      expect(document.querySelector('[data-workbench-progress-active]')).toBeNull();
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
      if(outcome!=='loaded'){
        expect(document.querySelector('[data-workbench-left-panel] [data-msgid="remote"]')).toBeNull();
        expect(screen.queryByRole('button',{name:'退出查看'})).toBeNull();
        return;
      }
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="remote"]')).not.toBeNull();
      expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(1);
      fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="remote"]')).toBeNull();
      expect(latest().relatedMessages.some((message:Message)=>message.id==='remote')).toBe(false);
      expect(screen.queryByRole('spinbutton',{name:'向上追溯距离'})).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;vi.useRealTimers();}
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
    expect(card).toHaveTextContent('start=2 len=2');
    expect(card).not.toHaveTextContent('具体更改');
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
    fireEvent.click(await screen.findByRole('button',{name:'查看加入消息（2条）'}));
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
    await waitFor(()=>expect(document.querySelector('[data-container-join-records="C"] [data-msgid="join-B"]')).not.toBeNull());
    expect(screen.getByRole('button',{name:'切换为消息图'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));
    expect(latest().comparisonSingle).toBe(true);
    expect(latest().messages.map((message:Message)=>message.id)).toContain('C');
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
    expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it.each(['graph','list'])('locates the container after clicking a member JOIN badge and its container label in %s',async mode=>{
    fixture('CLASSIFY',true);
    const response=await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({data:response.data.filter((relation:Relation)=>relation.id!=='against-C')});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
      if(this.hasAttribute('data-workbench-left-panel'))return new DOMRect(0,120,600,500);
      if(this.dataset.msgid==='C'&&!this.hasAttribute('data-rel-overlay')){
        const panel=this.closest<HTMLElement>('[data-workbench-left-panel]');
        return new DOMRect(20,1120+(parseFloat(this.style.top)||0)-(panel?.scrollTop??0),300,140);
      }
      return new DOMRect(0,120,300,140);
    });
    try{
      render(<MessageWorkbenchPage/>);
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
      await act(async()=>latest().onMessageDoubleClick(event(),'A'));
      await act(async()=>latest().onMessageDoubleClick(event(),'C'));
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      const left=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      Object.defineProperties(left,{clientHeight:{configurable:true,value:500},clientWidth:{configurable:true,value:600},
        scrollHeight:{configurable:true,value:3000},scrollWidth:{configurable:true,value:600}});
      fireEvent.click(within(left).getByRole('button',{name:'查看加入消息（1条）'}));
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      const join=left.querySelector<HTMLElement>('[data-msgid="join-B"]')!;
      fireEvent.click(within(join).getByTitle(/跳转到.*消息 C/));
      await waitFor(()=>expect(left.querySelector('[data-msgid="C"]:not([data-rel-overlay])')).not.toBeNull());
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      await waitFor(()=>{
        const target=left.querySelector<HTMLElement>('[data-msgid="C"]:not([data-rel-overlay])')!;
        const rect=target.getBoundingClientRect(),viewport=left.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
        expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom);
      });
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      expect(screen.queryByText('加入记录临时分类（1）')).toBeNull();
      expect(latest().messages.some((message:Message)=>String(message.kind).toLowerCase()==='join')).toBe(false);
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['graph', 'list'])('keeps the current %s scene and scroll position when a notification targets a visible member', async mode => {
    fixture('CLASSIFY', true);
    const response = await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({ data: response.data.filter((relation: Relation) => relation.id !== 'against-C') });
    const notifications = vi.spyOn(notificationApi, 'getNotifications').mockResolvedValue({
      through: 10, unseenCount: 1, sequence: 1, nextCursor: null,
      items: [{ id: 10, sourceId: 'join-B', navigationId: 'B', targetId: 'C', actorId: 'other', actorName: '其他成员',
        action: '加入已生效', excerpt: '通知里的可见成员', targetExcerpt: 'C', sourceRevision: 1, references: [],
        reasons: ['你创建了分类'], watchedIds: [], category: 'direct', kind: 'member-of', groupKey: 'join-B',
        createdAt: '2026-11-05T08:00:00Z', seenAt: null, muted: false }],
    });
    const seen = vi.spyOn(notificationApi, 'markNotificationsSeen').mockResolvedValue({ ok: true });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-workbench-left-panel') ? new DOMRect(0, 120, 600, 500) : new DOMRect(20, 160, 300, 100);
    });
    const previousUrl = window.location.href;
    window.history.replaceState(null, '', '/messages/classification-1');
    viewerRoute.nativeRouter = true; graphRendering.actual = true;
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><MessageWorkbenchPage /><button onClick={() => setOpen(true)}>打开测试通知</button>
        {open && <NotificationPanel revision={0} onClose={() => setOpen(false)} />}</>;
    }
    const view = render(<BrowserRouter><Routes><Route path="/messages/:messageId" element={<Harness />} /></Routes></BrowserRouter>);
    try {
      await waitForWorkbenchIdle();
      await act(async () => latest().onMessageDoubleClick(event(), 'A'));
      await act(async () => latest().onMessageDoubleClick(event(), 'C'));
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const card = panel.querySelector<HTMLElement>('[data-msgid="B"]:not([data-rel-overlay])')!;
      expect(card).not.toBeNull();
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '保留草稿' } });
      const selection = latest().draftUnits;
      panel.scrollTop = 340; panel.scrollLeft = 75;
      const snapshots = mockApi.getWorkbenchSnapshot.mock.calls.length;
      const reveal = vi.fn(); panel.addEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
      fireEvent.click(screen.getByRole('button', { name: '打开测试通知' }));
      fireEvent.click(await screen.findByText('通知里的可见成员'));
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="B"]')).not.toBeNull());
      expect(panel.querySelector('[data-msgid="B"]:not([data-rel-overlay])')).toBe(card);
      expect([panel.scrollTop, panel.scrollLeft]).toEqual([340, 75]);
      expect(reveal.mock.calls.filter(([event]) => event.detail.ids.length)).toHaveLength(0);
      await waitFor(() => expect(seen).toHaveBeenCalledExactlyOnceWith({ through: 10, ids: [10] }));
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="B"]')).toBeNull());
      expect(panel.querySelector('[data-msgid="B"]:not([data-rel-overlay])')).toBe(card);
      expect([panel.scrollTop, panel.scrollLeft]).toEqual([340, 75]);
      expect(latest().draftUnits).toEqual(selection);
      expect(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）')).toHaveValue('保留草稿');
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(snapshots);
      expect(window.location.pathname).toBe('/messages/classification-1');
      expect(window.location.search).toBe('');
    } finally {
      view.unmount(); notifications.mockRestore(); seen.mockRestore(); geometry.mockRestore();
      viewerRoute.nativeRouter = false; graphRendering.actual = false;
      window.history.replaceState(null, '', previousUrl);
    }
  });

  it.each([0.7, 1, 1.5])('locates the JOIN record itself after clicking its temporary-category header at scale %s', async scale => {
    fixture('CLASSIFY', true);
    const response = await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({ data: response.data.filter((relation: Relation) => relation.id !== 'against-C') });
    graphRendering.actual = true;
    let navigating = false;
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-workbench-left-panel')) return new DOMRect(0, 120, 600 * scale, 400 * scale);
      if (navigating && this.dataset.msgid === 'join-B' && !this.hasAttribute('data-rel-overlay')) {
        const panel = this.closest<HTMLElement>('[data-workbench-left-panel]');
        return new DOMRect((100 - (panel?.scrollLeft ?? 0)) * scale, 120 + (2600 - (panel?.scrollTop ?? 0)) * scale, 300 * scale, 120 * scale);
      }
      return new DOMRect(0, 120, 300 * scale, 120 * scale);
    });
    try {
      render(<MessageWorkbenchPage />);
      await waitFor(() => expect(latest()?.messages.some((message: Message) => message.id === 'A')).toBe(true));
      await act(async () => latest().onMessageDoubleClick(event(), 'A'));
      await act(async () => latest().onMessageDoubleClick(event(), 'C'));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      Object.defineProperties(panel, {
        clientHeight: { configurable: true, value: 400 }, offsetHeight: { configurable: true, value: 400 },
        clientWidth: { configurable: true, value: 600 }, offsetWidth: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 5000 }, scrollWidth: { configurable: true, value: 600 },
      });
      fireEvent.click(within(panel).getByRole('button', { name: '查看加入消息（1条）' }));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      navigating = true;
      fireEvent.click(within(panel).getByTitle('跳转到加入消息 join-B 的当前实际位置'));
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="join-B"]')).not.toBeNull());
      expect(screen.getByText('加入记录临时分类（1）')).toBeInTheDocument();
      const card = panel.querySelector<HTMLElement>('[data-msgid="join-B"]:not([data-rel-overlay])')!;
      const rect = card.getBoundingClientRect(), viewport = panel.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
      expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom);
      // Reveal the card's bottom with the smallest scroll; leave already-visible space intact.
      expect(panel.scrollTop).toBeCloseTo(2600 + 120 - panel.clientHeight);
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="join-B"]')).toBeNull());
      const retained = panel.querySelector<HTMLElement>('[data-msgid="join-B"]:not([data-rel-overlay])')!;
      expect(retained).toBeVisible();
      expect(retained.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewport.top);
      expect(retained.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.bottom);
      expect(panel.scrollTop).toBeCloseTo(2600 + 120 - panel.clientHeight);
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { geometry.mockRestore(); graphRendering.actual = false; }
  });

  it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'].flatMap(type=>['graph','list'].map(mode=>({type,mode}))))('restores browsing history between $type and JOIN records from $mode',async({type,mode})=>{
    fixture(type,true);
    const response=await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({data:response.data.filter((relation:Relation)=>relation.id!=='against-C')});
    const scrollingElement=Object.getOwnPropertyDescriptor(document,'scrollingElement');
    Object.defineProperty(document,'scrollingElement',{configurable:true,value:document.documentElement});
    const dimensions=[
      vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockReturnValue(3000),
      vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400)),
    ];
    graphRendering.actual=true;
    try{
      render(<MessageWorkbenchPage/>);
      const ready=waitForWorkbenchIdle;
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
      await ready();
      expect(screen.getByRole('button',{name:'返回'})).toBeDisabled();
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      await act(async()=>latest().onMessageDoubleClick(event(),'A'));
      if(type==='CLASSIFY'||type==='SUMMARY')await act(async()=>latest().onMessageDoubleClick(event(),'C'));
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      await ready();
      const left=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const right=document.querySelector<HTMLElement>('.workbench-right-panel')!,page=document.documentElement;
      const read=()=>[left.scrollTop,left.scrollLeft,right.scrollTop,right.scrollLeft,page.scrollTop,page.scrollLeft];
      const write=(offset:number)=>{
        left.scrollTop=450+offset;left.scrollLeft=70+offset;right.scrollTop=110+offset;right.scrollLeft=50+offset;
        page.scrollTop=800+offset;page.scrollLeft=30+offset;return read();
      };
      const filterState=()=>[!left.querySelector('[data-msgid="join-B"]')];
      expect(filterState()).toEqual([true]);
      const originScroll=write(0),requests=mockApi.getWorkbenchSnapshot.mock.calls.length;
      fireEvent.click(within(left).getByRole('button',{name:'查看加入消息（1条）'}));
      await ready();
      fireEvent.click(screen.getByRole('button',{name:mode==='graph'?'切换为消息表':'切换为消息图'}));
      await ready();
      const joinMode=mode==='graph'?'list':'graph',joinScroll=write(100);
      expect(filterState()).toEqual([false]);
      const join=await waitFor(()=>{const card=left.querySelector<HTMLElement>('[data-msgid="join-B"]');expect(card).not.toBeNull();return card!;});
      fireEvent.click(within(join).getByTitle(/跳转到.*消息 C/));
      await ready();
      expect(screen.queryByText('加入记录临时分类（1）')).toBeNull();
      const destinationMode=screen.queryByRole('button',{name:'切换为消息表'})?'graph':'list';
      const destinationFilters=filterState(),destinationScroll=write(200);
      const back=()=>moveBrowserHistory(-1,'返回');
      const forward=()=>moveBrowserHistory(1,'前进');
      const assertRecords=async()=>{
        expect(screen.getByText('加入记录临时分类（1）')).toBeInTheDocument();
        expect(screen.getByRole('button',{name:joinMode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
        expect(filterState()).toEqual([false]);
        await ready();await waitFor(()=>expect(read()).toEqual(joinScroll));
      };
      await back();await assertRecords();
      await back();
      expect(screen.queryByText('加入记录临时分类（1）')).toBeNull();
      expect(screen.getByRole('button',{name:mode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
      expect(filterState()).toEqual([true]);
      await ready();await waitFor(()=>expect(read()).toEqual(originScroll));
      await forward();await assertRecords();
      await forward();await ready();await waitFor(()=>expect(read()).toEqual(destinationScroll));
      expect(filterState()).toEqual(destinationFilters);
      expect(screen.getByRole('button',{name:destinationMode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      // Reverse before the viewport restore paints: preserve its intended scroll.
      await back();await forward();await ready();await waitFor(()=>expect(read()).toEqual(destinationScroll));
      await back();await assertRecords();
      fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));
      await ready();await waitFor(()=>expect(read()).toEqual(originScroll));
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      await back();await assertRecords();
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(requests);
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{
      graphRendering.actual=false;dimensions.forEach(spy=>spy.mockRestore());
      if(scrollingElement)Object.defineProperty(document,'scrollingElement',scrollingElement);
      else Reflect.deleteProperty(document,'scrollingElement');
    }
  });

  it.each(['graph','list'] as const)('shares native browser and toolbar history across category entry and exit from %s without losing the draft', async mode => {
    fixture('CLASSIFY', true);
    const response = await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({ data: response.data.filter((relation: Relation) => relation.id !== 'against-C') });
    const dimensions = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(3000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400)),
    ];
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitFor(() => expect(latest()?.messages.some((message: Message) => message.id === 'A')).toBe(true));
      await waitForWorkbenchIdle();
      if (mode === 'list') { fireEvent.click(screen.getByRole('button', { name: '切换为消息表' })); await waitForWorkbenchIdle(); }
      const draft = screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）');
      fireEvent.change(draft, { target: { value: '进入和退出分类后继续编辑' } });
      const address = window.location.href;
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const position = () => [panel.scrollTop, panel.scrollLeft];
      const setPosition = (top: number, left: number) => { panel.scrollTop = top; panel.scrollLeft = left; return position(); };
      const enter = async (id: string) => {
        fireEvent.doubleClick(panel.querySelector(`[data-msgid="${id}"]:not([data-rel-overlay])`)!);
        await waitForWorkbenchIdle();
      };
      const rootPosition = setPosition(730, 90);
      await enter('A');
      const categoryPosition = setPosition(300, 60);
      await enter('C');
      const childPosition = setPosition(950, 110);
      await moveBrowserHistory(-1);
      await waitForWorkbenchIdle();
      expect(position()).toEqual(categoryPosition);
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('A');
      await moveBrowserHistory(1, '前进');
      await waitForWorkbenchIdle();
      expect(position()).toEqual(childPosition);
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('C');
      await moveBrowserHistory(-1);
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '退出分类' }));
      await waitForWorkbenchIdle();
      expect(position()).toEqual(rootPosition);
      await moveBrowserHistory(-1);
      await waitForWorkbenchIdle();
      expect(position()).toEqual(categoryPosition);
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('A');
      expect(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）')).toBe(draft);
      expect(draft).toHaveValue('进入和退出分类后继续编辑');
      expect(window.location.href).toBe(address);
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { view.unmount(); graphRendering.actual = false; dimensions.forEach(spy => spy.mockRestore()); }
  });

  it.each([false, true])('keeps the same offline archive when browser state is cloned during traversal (hash router=%s)', async hash => {
    const member = { ...makeMessage('offline-member', '文件中的正文'), authorId: 'user-1', author: 'tester' };
    const category = { ...makeMessage('offline-category', ''), kind: 'RELATION' as const, relationType: 'CLASSIFY',
      targetRefs: [{ kind: 'message' as const, messageId: member.id }], relationPayload: { title: '本地分类' }, authorId: 'user-1', author: 'tester' };
    const archive: ExportData = { formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '本机文件' },
      view: { username: 'tester', mode: 'graph', classificationId: null, messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] },
      messages: [member, category], relations: [{ id: category.id, relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: category.targetRefs,
        payload: category.relationPayload, createdAt: category.createdAt, authorId: 'user-1', author: 'tester', supersededBy: null }] };
    window.history.replaceState({ usr: { exportData: archive, viewerInstanceKey: 'local-file' }, key: 'local-file', idx: 1 }, '', hash ? '/#/viewer' : '/viewer');
    // Native browsers structured-clone history state; jsdom otherwise reuses the same object.
    const push = window.history.pushState.bind(window.history), replace = window.history.replaceState.bind(window.history);
    const pushSpy = vi.spyOn(window.history, 'pushState').mockImplementation((state, title, url) => push(structuredClone(state), title, url));
    const replaceSpy = vi.spyOn(window.history, 'replaceState').mockImplementation((state, title, url) => replace(structuredClone(state), title, url));
    viewerRoute.nativeRouter = true;
    graphRendering.actual = true;
    const Router = hash ? HashRouter : BrowserRouter;
    const view = render(<Router><Routes><Route path="/viewer" element={<MessageWorkbenchPage />} /></Routes></Router>);
    try {
      await waitFor(() => expect(latest()?.messages.some((message: Message) => message.id === category.id)).toBe(true));
      await waitForWorkbenchIdle();
      const workbench = view.container.querySelector('.workbench-shell');
      await act(async () => latest().onMessageDoubleClick(event(), category.id));
      await waitForWorkbenchIdle();
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('本地分类');
      await moveBrowserHistory(-1);
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('button', { name: '退出分类' })).toBeNull();
      await moveBrowserHistory(1);
      await waitForWorkbenchIdle();
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('本地分类');
      expect(view.container.querySelector('.workbench-shell')).toBe(workbench);
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled();
    } finally {
      view.unmount(); viewerRoute.nativeRouter = false; graphRendering.actual = false;
      pushSpy.mockRestore(); replaceSpy.mockRestore();
      window.history.replaceState(null, '', '/');
    }
  });

  it('keeps an already visible target in place while mode-switch positioning owns the progress dialog', async () => {
    mockApi.getScope.mockResolvedValue({ messageId: 'classification-1', title: '后台定位' });
    mockApi.getMessages.mockResolvedValue({ data: [makeMessage('background-location', '定位消息')] });
    mockApi.getRelations.mockResolvedValue({ data: [] });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitFor(() => expect(latest()?.messages.some((message: Message) => message.id === 'background-location')).toBe(true));
      await waitForWorkbenchIdle();
      await act(async () => latest().onMessageClick(event(), 'background-location'));
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      // Switching views stays in the same progress dialog until positioning finishes.
      expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(graphRendering.tasks!.pending).toBeGreaterThan(0);
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      // The restored viewport can already expose the destination before its locator runs.
      panel.scrollTop = 730; panel.scrollLeft = 90;
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect([panel.scrollTop, panel.scrollLeft]).toEqual([730, 90]);
      expect(document.querySelector('[data-message-jump-target="background-location"]')).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect([panel.scrollTop, panel.scrollLeft]).toEqual([730, 90]);
      expect(graphRendering.tasks!.pending).toBe(0);
    } finally { view.unmount(); vi.useRealTimers(); geometry.mockRestore(); }
  });

  it.each(['graph','list'] as const)('restores A/B/C and JOIN-record history after taking a new branch from %s',async initialMode=>{
    const containers=['A','B','C'] as const;
    const relation=(id:string,type:string,targets:string[],source:string|null=null,order=0):Relation=>({
      id,relationType:type,sourceMessageId:source,targetRefs:targets.map(messageId=>({kind:'message',messageId})),
      payload:type==='CLASSIFY'?{title:`${id}标题`,independentMemberships:true}:undefined,
      createdAt:new Date(Date.parse('2026-10-21T00:00:00Z')+order*1000).toISOString(),createdBy:makeUser(),
    });
    const relations=containers.map(id=>relation(id,'CLASSIFY',[`member-${id}`]));
    for(const [index,id] of containers.entries()){
      const targets=[...containers.filter(other=>other!==id),id];
      targets.forEach((parent,order)=>relations.push(relation(`join-${id}-${parent}`,'JOIN',[`member-${id}`],parent,index*3+order+1)));
    }
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'三容器讨论'});
    mockApi.getMessages.mockResolvedValue({data:containers.map(id=>makeMessage(`member-${id}`,`${id}的成员`))});
    mockApi.getRelations.mockResolvedValue({data:relations});
    const scrollingElement=Object.getOwnPropertyDescriptor(document,'scrollingElement');
    Object.defineProperty(document,'scrollingElement',{configurable:true,value:document.documentElement});
    const dimensions=[
      vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockReturnValue(3000),
      vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400)),
    ];
    graphRendering.actual=true;
    let view: ReturnType<typeof render> | undefined;
    try{
      view = render(<MessageWorkbenchPage/>);
      // Save the user's scroll only after the restored view finishes positioning.
      const ready=waitForWorkbenchIdle;
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
      await ready();
      vi.useFakeTimers();
      const left=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const right=document.querySelector<HTMLElement>('.workbench-right-panel')!,page=document.documentElement;
      const row=(id:string)=>left.querySelector<HTMLElement>(`[data-msgid="${id}"]:not([data-rel-overlay])`)!;
      const readScroll=()=>[left.scrollTop,left.scrollLeft,right.scrollTop,right.scrollLeft,page.scrollTop,page.scrollLeft];
      const mode=()=>screen.queryByRole('button',{name:'切换为消息表'})?'graph':'list';
      const historyButtons=screen.getByRole('group',{name:'浏览历史'});
      expect(historyButtons.closest('.workbench-view-actions')).not.toBeNull();
      expect(historyButtons.nextElementSibling).toHaveAttribute('data-shortcut-view-toggle','true');
      const enter=async(id:string)=>{fireEvent.doubleClick(row(id));await ready();};
      const records=async(id:string)=>{
        fireEvent.click(within(row(`member-${id}`)).getByRole('button',{name:'查看加入消息（3条）'}));await ready();
      };
      const follow=async(member:string,parent:string)=>{
        fireEvent.click(within(row(`join-${member}-${parent}`)).getByTitle(new RegExp(`跳转到.*消息 ${parent}$`)));await ready();
      };
      type Saved={kind:'container'|'records'|'root';id:string;mode:'graph'|'list';scroll:number[]};
      let position=0;
      const save=async(kind:Saved['kind'],id:string,view:Saved['mode']):Promise<Saved>=>{
        if(mode()!==view){fireEvent.click(screen.getByRole('button',{name:view==='graph'?'切换为消息图':'切换为消息表'}));await ready();}
        await ready();position++;
        const scroll=[300+position*110,20+position*13,80+position*37,10+position*11,650+position*130,15+position*17];
        [left.scrollTop,left.scrollLeft,right.scrollTop,right.scrollLeft,page.scrollTop,page.scrollLeft]=scroll;
        return {kind,id,mode:view,scroll};
      };
      const assertSaved=async(saved:Saved)=>{
        await ready();
        expect(mode()).toBe(saved.mode);
        if(saved.kind==='records'){
          expect(screen.getByText('加入记录临时分类（3）')).toBeInTheDocument();
          expect(screen.getByText(new RegExp(`消息 member-${saved.id} 加入容器`))).toBeInTheDocument();
          for(const parent of containers)expect(row(`join-${saved.id}-${parent}`)).not.toBeNull();
          expect(row(`member-${saved.id}`)).toBeNull();
        }else{
          expect(screen.queryByText('加入记录临时分类（3）')).toBeNull();
          if(saved.kind==='container'){
            expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent(`${saved.id}标题`);
            expect(row(`member-${saved.id}`)).not.toBeNull();
            for(const id of containers.filter(id=>id!==saved.id))expect(row(`member-${id}`)).toBeNull();
          }else{
            for(const id of containers){expect(row(id)).not.toBeNull();expect(row(`member-${id}`)).toBeNull();}
            // History restores the viewport; the last explicitly selected C
            // remains in the one shared staging area on every history step.
            expect(screen.getByRole('button',{name:'暂存消息 C'})).toBeInTheDocument();
          }
        }
        expect(readScroll()).toEqual(saved.scroll);
      };
      const back=()=>fireEvent.click(screen.getByRole('button',{name:'返回'}));
      const forward=()=>fireEvent.click(screen.getByRole('button',{name:'前进'}));
      const opposite=initialMode==='graph'?'list':'graph';
      const states:Saved[]=[];
      await enter('A');states.push(await save('container','A',initialMode));
      await records('A');states.push(await save('records','A',opposite));
      await follow('A','B');states.push(await save('root','B',initialMode));
      await enter('B');states.push(await save('container','B',opposite));
      await records('B');states.push(await save('records','B',initialMode));
      await follow('B','C');states.push(await save('root','C',opposite));
      await enter('C');states.push(await save('container','C',initialMode));
      await records('C');states.push(await save('records','C',opposite));
      await assertSaved(states.at(-1)!);
      for(let index=states.length-2;index>=0;index--){back();await assertSaved(states[index]);}
      for(const state of states.slice(1)){forward();await assertSaved(state);}
      // Return to B's records, then replace the old C route with A -> records -> C.
      for(const index of [6,5,4]){back();await assertSaved(states[index]);}
      expect(screen.getByRole('button',{name:'前进'})).toBeEnabled();
      await follow('B','A');
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      const branch=states.slice(0,5);
      branch.push(await save('root','A',opposite));
      await enter('A');branch.push(await save('container','A',initialMode));
      await records('A');branch.push(await save('records','A',opposite));
      await follow('A','C');branch.push(await save('root','C',initialMode));
      for(let index=branch.length-2;index>=0;index--){back();await assertSaved(branch[index]);}
      for(const state of branch.slice(1)){forward();await assertSaved(state);}
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{
      // Navigation frames use controlled time rather than racing real timers.
      view?.unmount();
      vi.useRealTimers();
      graphRendering.actual=false;dimensions.forEach(spy=>spy.mockRestore());
      if(scrollingElement)Object.defineProperty(document,'scrollingElement',scrollingElement);
      else Reflect.deleteProperty(document,'scrollingElement');
    }
  },15000);

  it('waits for restored global filters before applying the browsing viewport',async()=>{
    const originalSnapshot=mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const category:Relation={id:'A',relationType:'CLASSIFY',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'B'}],
      createdAt:'2024-01-01',createdBy:makeUser(),payload:{title:'A'}};
    const full={scope:{messageId:'classification-1',title:'讨论'},regionId:'history-region',sequence:10,
      messages:[makeMessage('B','成员'),{...makeMessage('A',''),kind:'RELATION' as const,relationType:'CLASSIFY',targetRefs:category.targetRefs,relationPayload:category.payload}],
      relations:[category],users:[makeUser()],stakes:{},tagCounts:{},attentionUsers:{}};
    mockApi.getWorkbenchSnapshot.mockResolvedValue({...full,windowed:true,messages:[],relations:[]});
    const dimensions=[
      vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockImplementation(()=>document.body.textContent?.includes('正在准备全局筛选结果')?0:5000),
      vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600),
    ];
    const {projectWorkbenchSnapshot}=await import('../utils/workbenchProjection');
    const view=render(<MessageWorkbenchPage/>);
    try{
      await waitFor(()=>expect(catalogHarness.callbacks).not.toBeNull());
      act(()=>{
        catalogHarness.data={snapshot:full,projected:projectWorkbenchSnapshot(full),rows:{userRows:[],messageRows:[]}};
        catalogHarness.callbacks.onReady(catalogHarness.data);
      });
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
      const ready=()=>waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      const addSender=async(username:string)=>{
        fireEvent.click(screen.getByRole('button',{name:'按发送者'}));
        const input=screen.getByPlaceholderText('例如: 张三');
        fireEvent.change(input,{target:{value:username}});fireEvent.keyDown(input,{key:'Enter'});
        expect(await screen.findByText(`发送者: ${username}`)).toBeInTheDocument();
        await ready();
      };
      await ready();
      fireEvent.click(screen.getByRole('button',{name:'过滤'}));
      await addSender('tester');
      const left=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      left.scrollTop=700;
      await act(async()=>latest().onMessageDoubleClick(event(),'A'));
      await ready();
      fireEvent.click(await screen.findByTitle('移除此规则'));
      await addSender('another-user');
      const originalFilters=catalogHarness.filters.getMockImplementation()!;
      let finish!:()=>Promise<void>;
      catalogHarness.filters.mockImplementationOnce((query:unknown)=>new Promise(resolve=>{finish=async()=>resolve(await originalFilters(query));}));
      fireEvent.click(screen.getByRole('button',{name:'返回'}));
      await waitFor(()=>expect(finish).toBeDefined());
      expect((await screen.findAllByText('正在准备全局筛选结果…')).length).toBeGreaterThan(0);
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
      await act(async()=>finish());
      await ready();await waitFor(()=>expect(left.scrollTop).toBe(700));
      expect(latest().messages.some((message:Message)=>message.id==='A')).toBe(true);
    }finally{
      view.unmount();dimensions.forEach(spy=>spy.mockRestore());
      mockApi.getWorkbenchSnapshot.mockImplementation(originalSnapshot);catalogHarness.callbacks=null;
    }
  });

  it('restores a rejected container preview and its JOIN history without corrupting the preview exit',async()=>{
    fixture('CLASSIFY',true);
    const dimensions=[vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400))];
    graphRendering.actual=true;
    try{
      render(<MessageWorkbenchPage/>);
      await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
      await act(async()=>latest().onMessageDoubleClick(event(),'A'));
      await act(async()=>latest().onRelatedMessageNavigate('C'));
      expect(latest().comparisonSingle).toBe(true);
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      const left=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      left.scrollTop=350;
      await act(async()=>latest().onJoinFilterClick('C','outgoing'));
      await moveBrowserHistory(-1,'返回');
      expect(latest().comparisonSingle).toBe(true);
      await waitFor(()=>expect(left.scrollTop).toBe(350));
      await moveBrowserHistory(1,'前进');
      expect(screen.getByText('被加入记录临时分类（1）')).toBeInTheDocument();
      await moveBrowserHistory(-1,'返回');
      fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
      expect(latest().comparisonSingle).toBe(false);
      expect(latest().rejectedContainerIds.has('C')).toBe(true);
      expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      await moveBrowserHistory(-1,'返回');
      expect(latest().comparisonSingle).toBe(true);
      fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
      expect(latest().comparisonSingle).toBe(false);
      expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{graphRendering.actual=false;dimensions.forEach(spy=>spy.mockRestore());}
  });

  it('selects the effective JOIN through its records instead of offering a fixed remove-container action',async()=>{
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
    expect(screen.queryByRole('button',{name:'移出容器'})).toBeNull();
    fireEvent.click(await screen.findByRole('button',{name:'查看加入消息（1条）'}));
    fireEvent.click(document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="join-B"]')!);
    expect(document.querySelector('[data-guide-selection-staging]')).toHaveTextContent('join-B');
    fireEvent.click(screen.getByRole('button',{name:'反对'}));
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledWith('C',expect.objectContaining({relationType:'DISAGREE',targetRefs:[expect.objectContaining({reference:{messageId:'join-B',context:{kind:'MESSAGE'}}})]})));
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
    const reference=screen.getByRole('group',{name:'暂存消息 B'});
    expect(entry).toHaveAttribute('aria-pressed','false');
    fireEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed','true');
    expect(reference).toHaveTextContent('A 内的 B');
    expect(latest().draftUnits).toEqual(selection);
    fireEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed','false');
    expect(reference).toHaveTextContent('B · 已选择整条');
    expect(reference).not.toHaveTextContent('A 内的 B');
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
    fireEvent.click(staged);expect(screen.getByRole('group',{name:'暂存消息 A'})).toHaveTextContent('【分类】 A 的分类正文');expect(screen.getByRole('group',{name:'暂存消息 A'})).not.toHaveTextContent('目标：');
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
    fireEvent.click(within(target.closest('li')!).getByRole('button',{name:'删除'}));
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
    const originalIds=latest().messages.map((m:Message)=>m.id);
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
    await act(async()=>latest().onMessageDoubleClick(event(),'C'));
    expect(latest().messages.map((m:Message)=>m.id)).toContain('B');
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    expect(latest().messages.map((m:Message)=>m.id)).toContain('C');
    await act(async()=>latest().onCanvasBlankClick(event()));
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    await waitFor(()=>expect(screen.queryByRole('region',{name:'单侧对比'})).toBeNull());
    expect(latest().messages.map((m:Message)=>m.id)).toEqual(originalIds);
    expect(latest().draftUnits).toEqual([]);
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
    expect(latest().messages.some((message:Message)=>String(message.kind).toLowerCase()==='join')).toBe(false);
    expect(screen.getByRole('button',{name:'退出分类'})).toBeInTheDocument();
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
  });

  it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'])('preserves selections made while viewing a rejected %s container on exit',async type=>{
    fixture(type,true);render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await act(async()=>latest().onMessageClick(event(),'B'));
    await act(async()=>latest().onRelatedMessageNavigate('C'));
    await act(async()=>latest().onCanvasBlankClick(event()));
    await act(async()=>latest().onMessageClick(event(),'C'));
    const selection=latest().draftUnits;
    expect(selection).toEqual([expect.objectContaining({messageId:'C'})]);
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(latest().draftUnits).toEqual(selection);
    expect(screen.getByRole('button',{name:'暂存消息 C'})).toBeInTheDocument();
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
  });

  it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'])('can send an actual stance on a rejected %s container selected in its viewing mode',async type=>{
    localStorage.setItem('token','test-token');
    fixture(type,true);
    mockApi.createRelation.mockResolvedValueOnce({id:'support-C',relationType:'AGREE',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'C'}],createdAt:'2026-01-01',createdBy:makeUser()});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    try{
      render(<MessageWorkbenchPage/>);
      await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
      await act(async()=>latest().onMessageDoubleClick(event(),'A'));
      await act(async()=>latest().onRelatedMessageNavigate('C'));
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      await act(async()=>latest().onMessageClick(event(),'C'));
      fireEvent.click(screen.getByRole('button',{name:'赞同'}));
      expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledWith('A',expect.objectContaining({
        relationType:'AGREE',targetRefs:[expect.objectContaining({reference:{messageId:'C',context:{kind:'MESSAGE'}}})],
      })));
    }finally{geometry.mockRestore();graphRendering.actual=false;}
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
    expect(messageCanvas().getByText('A 内的 B')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-view')).toBeNull();
  });

  it('paints loading feedback before opening a category and includes native stance counts in its chooser',async()=>{
    fixture();
    const original=await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({data:original.data.filter((relation:Relation)=>relation.id!=='against-C').map((relation:Relation)=>relation.id==='C'?{
      ...relation,state:{messageId:'C',revision:1,supportCount:1,oppositionCount:0,recommendationTotal:0,suppressed:false},
    }:relation)});
    render(<MessageWorkbenchPage/>);
    await waitForWorkbenchIdle();
    let opening:Promise<void>|undefined;
    act(()=>{opening=latest().onMessageDoubleClick(event(),'A');});
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async()=>{await opening;});
    await waitForWorkbenchIdle();
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    await selectComparisonTarget('C');
    expect(screen.getByRole('button',{name:'审阅'})).toBeEnabled();
  });

  it('retains the comparison chooser list and scroll position when selecting different messages',async()=>{
    fixture();
    const original=await mockApi.getRelations();
    mockApi.getRelations.mockResolvedValue({data:[...original.data,{
      id:'agree-A',relationType:'AGREE',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'A'}],
      createdAt:'2024-01-01T00:00:00Z',createdBy:makeUser(),
    }]});
    render(<MessageWorkbenchPage/>);
    await waitForWorkbenchIdle();
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await waitForWorkbenchIdle();
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    await waitForWorkbenchIdle();
    const panel=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    const list=panel.querySelector('[data-virtual-message-list]')!;
    const cards=new Map(['A','C'].map(id=>[id,panel.querySelector(`[data-msgid="${id}"]:not([data-rel-overlay])`)]));
    expect(list).not.toBeNull();
    panel.scrollTop=180;panel.scrollLeft=24;
    for(const id of ['C','A','C']){
      await selectComparisonTarget(id);
      await waitForWorkbenchIdle();
      expect(screen.getByRole('button',{name:`暂存消息 ${id}`})).toBeInTheDocument();
      expect(panel.querySelector('[data-virtual-message-list]')).toBe(list);
      expect(panel.querySelector(`[data-msgid="${id}"]:not([data-rel-overlay])`)).toBe(cards.get(id));
      expect(panel.scrollTop).toBe(180);
      expect(panel.scrollLeft).toBe(24);
    }
  });

  it('can select a rejected container in the original comparison list and review both sides',async()=>{
    fixture();render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    await selectComparisonTarget('C');
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    expect(latest().comparisonAgreeMessages.map((message:Message)=>message.id)).toContain('C');
    expect(latest().comparisonAgreeMessages.map((message:Message)=>message.id)).toContain('B');
    expect(latest().comparisonAgreeContext.expandedFrameIds).toEqual(new Set(['A','C']));
    expect(latest().comparisonDisagreeContext.expandedFrameIds).toEqual(new Set(['A']));
    expect(latest().comparisonDisagreeMessages.map((message:Message)=>message.id)).toContain('B');
    expect(latest().comparisonAgreeContext.rejectedContainerIds.has('C')).toBe(false);
    expect(latest().comparisonDisagreeContext.rejectedContainerIds.has('C')).toBe(true);
    expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('restores the selected candidate and chooser viewport after every review',async()=>{
    fixture();render(<MessageWorkbenchPage/>);
    await waitForWorkbenchIdle();
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await waitForWorkbenchIdle();
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    await selectComparisonTarget('C');await waitForWorkbenchIdle();
    const panel=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    for(const [key,value] of Object.entries({clientHeight:400,scrollHeight:4000,clientWidth:500,scrollWidth:2000})){
      Object.defineProperty(panel,key,{configurable:true,value});
    }
    const list=panel.querySelector('[data-virtual-message-list]');
    for(const top of [1200,700]){
      panel.scrollTop=top;panel.scrollLeft=125;
      fireEvent.click(screen.getByRole('button',{name:'审阅'}));
      await waitForWorkbenchIdle();expect(latest().comparisonPair).toBe(true);
      await act(async()=>latest().onMessageClick(event(),'B'));
      panel.scrollTop=0;panel.scrollLeft=0;
      fireEvent.click(screen.getByRole('button',{name:'返回对比消息'}));
      await waitForWorkbenchIdle();
      expect(panel.scrollTop).toBe(top);expect(panel.scrollLeft).toBe(125);
      expect(panel.querySelector('[data-virtual-message-list]')).toBe(list);
      expect(panel.querySelector('[data-msgid="C"]')).toHaveAttribute('aria-label','消息 C，已选中');
      expect(screen.getByRole('button',{name:'暂存消息 C'})).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'审阅'})).toBeEnabled();
    }
  });

  it.each(['graph', 'list'])('limits comparison candidates to the entering root or classification view in %s',async mode=>{
    fixture('CLASSIFY',true);
    const original=await mockApi.getRelations();
    const extra=(id:string,relationType:string,target:string):Relation=>({id,relationType,sourceMessageId:null,targetRefs:[{kind:'message',messageId:target}],createdAt:'2024-01-01T00:00:00Z',createdBy:makeUser()});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('B','A 内的 B'),makeMessage('reason','引用说明')]});
    mockApi.getRelations.mockResolvedValue({data:[...original.data.map((relation:Relation)=>relation.id==='A'?{
      ...relation,targetRefs:[...relation.targetRefs,{kind:'message',messageId:'reason'}],
    }:relation),
      extra('agree-A','AGREE','A'),
      {...extra('voted-reference','REFERENCE','B'),sourceMessageId:'reason'},extra('agree-reference','AGREE','voted-reference'),
      {...extra('unvoted-reference','REFERENCE','B'),sourceMessageId:'reason'},extra('agree-join','AGREE','join-B'),
    ]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('C');
    if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
    await waitForWorkbenchIdle();
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    await waitForWorkbenchIdle();
    expect(screen.getByText(/^选择对比消息/).textContent).toBe('选择对比消息（1）');
    expect(screen.queryByRole('button',{name:'退出临时分类'})).toBeNull();
    expect(document.querySelector('[data-msgid="A"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="C"]')).toBeNull();
    expect(document.querySelector('[data-msgid="voted-reference"]')).toBeNull();
    fireEvent.click(screen.getAllByRole('button',{name:'退出对比'})[0]);
    await waitForWorkbenchIdle();
    await act(async()=>latest().onMessageDoubleClick(event(),'A'));
    await waitForWorkbenchIdle();
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    await waitForWorkbenchIdle();
    expect(screen.getByText(/^选择对比消息/).textContent).toBe('选择对比消息（4）');
    expect(document.querySelector('[data-msgid="A"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="C"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="join-B"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="voted-reference"]')).not.toBeNull();
    expect(document.querySelector('[data-msgid="unvoted-reference"]')).toBeNull();
    expect(document.querySelector('[data-msgid="B"]')).toBeNull();
    await selectComparisonTarget('C');
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    expect(latest().comparisonTargetId).toBe('C');
    expect(latest().comparisonAgreeMessages.map((message:Message)=>message.id)).toContain('C');
    expect(latest().comparisonDisagreeMessages.map((message:Message)=>message.id)).toContain('B');
    fireEvent.click(screen.getByRole('button',{name:'返回对比消息'}));
    expect(screen.getByText('选择对比消息（4）')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button',{name:'退出对比'})[0]);
    await waitForWorkbenchIdle();
    expect(screen.queryByRole('button',{name:'返回对比消息'})).toBeNull();
    if(mode==='graph')expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
    else expect(document.querySelector('[data-workbench-left-panel] [data-msgid="B"]')).not.toBeNull();
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('A');
    expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('reviews a voted JOIN with rendered category frames on both sides and restores the entering view', async () => {
    fixture('CLASSIFY', true);
    const original = await mockApi.getRelations();
    const join = original.data.find((relation: Relation) => relation.id === 'join-B')!;
    mockApi.getRelations.mockResolvedValue({ data: [
      ...original.data.filter((relation: Relation) => relation.id !== 'against-C'),
      { ...join, id: 'previous-join', sourceMessageId: 'A', createdAt: '2023-01-01' },
      { ...join, id: 'vote-join', relationType: 'AGREE', sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId: 'join-B' }] },
    ] });
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      await act(async () => latest().onMessageDoubleClick(event(), 'A'));
      await waitForWorkbenchIdle();
      await act(async () => latest().onMessageDoubleClick(event(), 'C'));
      await waitForWorkbenchIdle();
      const originalIds = latest().messages.map((message: Message) => message.id);
      fireEvent.click(screen.getByRole('button', { name: '对比' }));
      await selectComparisonTarget('join-B');
      expect(screen.getByText('选择对比消息（1）')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '审阅' }));
      await waitForWorkbenchIdle();
      expect(latest().comparisonTargetId).toBe('join-B');
      expect(latest().comparisonAgreeContext.joinStatusByMessage.get('join-B')).toBe('valid');
      expect(latest().comparisonDisagreeContext.joinStatusByMessage.get('previous-join')).toBe('valid');
      for (const [side, owner] of [['agree', 'C'], ['disagree', 'A']]) {
        const panel = view.container.querySelector(`[data-comparison-view="${side}"]`)!;
        expect(panel.querySelectorAll('[data-msgid="B"]:not([data-rel-overlay])')).toHaveLength(1);
        for (const id of ['A', 'C']) expect(panel.querySelector(`[data-frame-visual="${id}"]`)).not.toBeNull();
        const edges = side === 'agree' ? latest().comparisonAgreeEdges : latest().comparisonDisagreeEdges;
        expect(edges.filter((edge: DemoEdge) => edge.to.messageId === 'B').map((edge: DemoEdge) => edge.relationMessageId)).toEqual([owner]);
      }
      fireEvent.click(screen.getByRole('button', { name: '返回对比消息' }));
      await waitForWorkbenchIdle();
      expect(screen.getByText('选择对比消息（1）')).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: '退出对比' })[0]);
      await waitForWorkbenchIdle();
      expect(latest().messages.map((message: Message) => message.id)).toEqual(originalIds);
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('C');
      expect(mockApi.createMessage).not.toHaveBeenCalled(); expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { view.unmount(); graphRendering.actual = false; }
  });

  it.each(['content', 'outside', 'field'])('does not review a retained %s selection outside the current candidates', async selection => {
    fixture();
    const original = await mockApi.getRelations();
    const outside: Relation = { ...makeRelation(), id: 'outside-choice', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [], payload: { title: '其他分类' } };
    const vote: Relation = { ...makeRelation(), id: 'vote-outside', relationType: 'AGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'relation', relationId: outside.id }] };
    mockApi.getRelations.mockResolvedValue({ data: [...original.data, outside, vote] });
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      if (selection === 'outside') await act(async () => latest().onMessageClick(event(), outside.id));
      await act(async () => latest().onMessageDoubleClick(event(), 'A'));
      await waitForWorkbenchIdle();
      if (selection === 'content') await act(async () => latest().onMessageClick(event(), 'B'));
      if (selection === 'field') act(() => window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT, {
        detail: { reference: { messageId: 'C', revision: 1, partId: 'body' }, label: '正文' },
      })));
      const selected = latest().draftUnits;
      expect(selected).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: '对比' }));
      await waitForWorkbenchIdle();
      expect(screen.getByText('选择对比消息（1）')).toBeInTheDocument();
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="outside-choice"]')).toBeNull();
      expect(screen.getByRole('button', { name: '审阅' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: '审阅' }));
      expect(screen.queryByRole('button', { name: '返回对比消息' })).toBeNull();
      expect(latest().draftUnits).toEqual(selected);
      await selectComparisonTarget('C');
      fireEvent.click(screen.getByRole('button', { name: '审阅' }));
      await waitForWorkbenchIdle();
      expect(latest().comparisonPair).toBe(true);
      expect(latest().comparisonTargetId).toBe('C');
      expect(screen.queryByRole('button', { name: '退出分类' })).toBeNull();
      expect(latest().comparisonAgreeContext.expandedFrameIds.has('A')).toBe(true);
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { view.unmount(); }
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
    expect(screen.getByText('仅列出当前视图内已有赞同或反对记录、且会改变显示效果的关系消息。')).toBeInTheDocument();
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
    expect(latest().draftUnits).toEqual(selection);
    await selectComparisonTarget('C');
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    fireEvent.click(screen.getByRole('button',{name:'退出对比'}));
    expect(screen.getByRole('region',{name:'单侧对比'})).toBeInTheDocument();
    expect(latest().comparisonPair).toBe(false);
    expect(latest().comparisonDisplay).toBe('agree');
    expect(latest().comparisonTargetId).toBe('C');
    expect(latest().draftUnits.map((unit:{messageId:string})=>unit.messageId)).toEqual(['C']);
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
    expect(latest().draftUnits.map((unit:{messageId:string})=>unit.messageId)).toEqual(['C']);
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('shares the assumed membership state while paired review expands paths and single-side preview retains ordinary navigation',async()=>{
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
    expect(latest().draftUnits).toEqual(selection);
    await selectComparisonTarget('C');
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    const comparisonSide = () => {
      const { getMemberCounts: _counts, expandedFrameIds, crossCanvasRelations: _cross, ...context } = latest().comparisonAgreeContext;
      expect(expandedFrameIds).toEqual(new Set(['P','A','C']));
      expect(latest().comparisonAgreeMessages.map((message:Message)=>message.id)).toContain('B');
      for (const messages of [latest().comparisonAgreeMessages, latest().comparisonDisagreeMessages]) {
        expect(messages.some((message:Message) => ['neighbor', 'outside'].includes(message.id))).toBe(false);
      }
      return context;
    };
    const agreeInA=comparisonSide();
    expect(latest().comparisonScopeHeader).toBeUndefined();
    expect(screen.queryByRole('button',{name:'退出分类'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'退出对比'}));
    await act(async()=>latest().onRelatedMessageNavigate('C'));
    const single=()=>({relatedMessages:latest().relatedMessages,relatedEdges:latest().relatedEdges,rejectedContainerIds:latest().rejectedContainerIds,rejectedRelationIds:latest().rejectedRelationIds,joinStatusByMessage:latest().joinStatusByMessage,joinEffectSourcesByMessage:latest().joinEffectSourcesByMessage});
    expect(single()).toEqual(agreeInA);
    expect(latest().messages.map((message:Message)=>message.id)).toContain('neighbor');
    expect(screen.queryByRole('button',{name:'返回上层查看'})).toBeNull();
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('A');
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    expect(single()).toEqual(agreeInA);
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('C');
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('B');
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('P');
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    expect(single()).toEqual(agreeInA);
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('C');
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('B');
    expect(latest().messages.map((message:Message)=>message.id)).toContain('outside');
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('测试分类');
    // Normal navigation and a comparison round-trip retain the root scope.
    await act(async()=>latest().onMessageDoubleClick(event(),'P'));
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    fireEvent.click(screen.getAllByRole('button',{name:'退出对比'})[0]);
    expect(single()).toEqual(agreeInA);
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('C');
    expect(latest().messages.map((message:Message)=>message.id)).not.toContain('B');
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    expect(screen.queryByRole('region',{name:'单侧对比'})).toBeNull();
    expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
    expect(latest().draftUnits.map((unit:{messageId:string})=>unit.messageId)).toEqual(['C']);
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('A');
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('leaves a rejected container preview when jumping to a staged message outside it',async()=>{
    fixture('CLASSIFY',true);
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await waitFor(()=>expect(latest()?.rejectedContainerIds.has('C')).toBe(true));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageDoubleClick(event(),'A'));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),'B'));
      await act(async()=>latest().onRelatedMessageNavigate('C'));await waitForWorkbenchIdle();
      expect(latest().comparisonSingle).toBe(true);
      expect(latest().messages.map((message:Message)=>message.id)).not.toContain('B');
      fireEvent.click(screen.getByRole('button',{name:'跳转到暂存消息 B'}));await waitForWorkbenchIdle();
      expect(latest().comparisonSingle).toBe(false);
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="B"]:not([data-rel-overlay])')).not.toBeNull();
      expect(screen.getByText('已定位目标消息')).toBeInTheDocument();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    }finally{view.unmount();graphRendering.actual=false;geometry.mockRestore();}
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

describe('directed reading and continuous traces',()=>{
  async function setup(extraRelations:Relation[]=[]){
    vi.clearAllMocks();
    const participant={...makeUser(),id:'discussion-writer',username:'discussion-writer'};
    const records=discussionMessages.map(message=>({...makeMessage(message.id,message.content),createdAt:message.createdAt,createdBy:participant}));
    const relations:Relation[]=[...discussionEdges.map(edge=>({id:edge.relationMessageId,relationType:edge.relationType.toUpperCase(),sourceMessageId:edge.from.messageId,
      targetRefs:[{kind:'message' as const,messageId:edge.to.messageId}],createdAt:records.find(message=>message.id===edge.from.messageId)!.createdAt,createdBy:participant})),...extraRelations];
    const model=convertMessagesToDemoModel(records,relations);
    const bodyMarks=['A','B','D'].map(id=>({format:3 as const,messageId:id,scope:'message' as const,key:messageReadingKey(id),bodySignature:messageReadingKey(id),version:bodyVersion(id),state:'READ' as const}));
    const progress=deriveReadingProgress({...model,relations,username:'tester',readStatus:new Map(),marks:bodyMarks});
    const retained=new Set(['A:C-A','B:F-B','C:E-C','D:N-D','E:N-E','N:P-N','P:Q-P']);
    const marks=[...bodyMarks,...[...progress.influences].flatMap(([target,items])=>influenceReadingMarks(target,items.filter(item=>!retained.has(`${target}:${item.messageId}`))))];
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'发布讨论'});mockApi.getMessages.mockResolvedValue({data:records});mockApi.getRelations.mockResolvedValue({data:relations});
    mockApi.getReadingState.mockResolvedValue({marks});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    return {view,geometry};
  }
  const latest=()=>mockGraphView.mock.lastCall![0];
  const ids=()=>latest().messages.filter((message:any)=>message.kind==='normal').map((message:any)=>message.id).sort();
  async function visitReading(id:string){
    await act(async()=>latest().onNavigateToMessage(id));await waitForWorkbenchIdle();
  }
  async function traceB(){
    await waitForWorkbenchIdle();await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'B'));
    fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
    for(const name of ['向上追溯距离','向下追溯距离'])fireEvent.change(screen.getByRole('spinbutton',{name}),{target:{value:2}});
    await waitForWorkbenchIdle();
  }
  it('keeps the most recently selected group after deselection and restores whole reading groups in history',async()=>{
    const {view,geometry}=await setup();
    const current=()=>[...view.container.querySelectorAll('[data-reading-current-id]')].map(element=>element.getAttribute('data-reading-current-id')!);
    const pick=async(id:string)=>{await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},id));};
    try{
      await traceB();await act(async()=>latest().onCanvasBlankClick());
      await pick('N');await pick('F');
      expect(current()).toEqual(['B']);
      expect(view.container.querySelector('[data-reading-recent-selection]')).toHaveAttribute('data-reading-recent-selection',JSON.stringify(['N','F']));
      await pick('F');await act(async()=>latest().onCanvasBlankClick());
      expect(latest().draftUnits).toEqual([]);
      expect(view.container.querySelector('[data-reading-recent-selection]')).toHaveAttribute('data-reading-recent-selection',JSON.stringify(['N','F']));
      fireEvent.click(screen.getByRole('button',{name:'设为阅读消息'}));await waitForWorkbenchIdle();
      expect(current()).toEqual(['N','F']);expectReadingPath(['N','F']);expect(latest().draftUnits).toEqual([]);
      expect(view.container.querySelectorAll('[data-reading-message-details]')).toHaveLength(2);
      expect(mockApi.markReading).not.toHaveBeenCalled();
      const groupView=view.container.querySelector('[data-workbench-left-panel] [data-workbench-view-cache]')?.firstElementChild;
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();expect(current()).toEqual(['B']);expectReadingPath(['B']);
      for(const id of ['N','F'])expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${id}"]:not([data-rel-overlay])`)?.getAttribute('data-reading-position')?.split(' ')).toContain('next');
      fireEvent.click(screen.getByRole('button',{name:'阅读前进'}));await waitForWorkbenchIdle();expect(current()).toEqual(['N','F']);
      expect(view.container.querySelector('[data-workbench-left-panel] [data-workbench-view-cache]')?.firstElementChild).toBe(groupView);
      fireEvent.click(screen.getByRole('button',{name:'本组已读并继续'}));await waitForWorkbenchIdle();
      expect(mockApi.markReading.mock.calls[0][0].filter((mark:any)=>mark.scope==='message').map((mark:any)=>mark.messageId)).toEqual(['N','F']);
      expect(screen.queryByRole('button',{name:'继续追溯本组消息'})).toBeNull();
      const afterRead=[...current()];expectReadingPath(afterRead);
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();expectReadingPath(['N','F']);expect(current()).toEqual(['N','F']);
      fireEvent.click(screen.getByRole('button',{name:'阅读前进'}));await waitForWorkbenchIdle();expectReadingPath(afterRead);expect(current()).toEqual(afterRead);
      expect(mockApi.markReading).toHaveBeenCalledOnce();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('starts a multi-root trace with every root in the current reading group',async()=>{
    const {view,geometry}=await setup();
    try{
      await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'B'));
      await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'F'));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      expectReadingPath(['B','F']);
      expect([...view.container.querySelectorAll('[data-reading-current-id]')].map(element=>element.getAttribute('data-reading-current-id'))).toEqual(['B','F']);
      for(const id of ['B','F'])expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${id}"]:not([data-rel-overlay])`)).toHaveAttribute('data-reading-position','current');
      expect(view.container.querySelector('[data-reading-trace-current]')).toHaveTextContent('当前阅读与追溯消息（2 条）');
      expect(screen.getByRole('button',{name:'阅读后退'})).toBeDisabled();expect(screen.getByRole('button',{name:'阅读前进'})).toBeDisabled();
      expect(screen.queryByRole('button',{name:'继续追溯本组消息'})).toBeNull();
      fireEvent.click(screen.getByRole('button',{name:'设为阅读消息'}));await waitForWorkbenchIdle();
      expectReadingPath(['B','F']);expect(screen.getByRole('button',{name:'阅读后退'})).toBeDisabled();
      await visitReading('A');
      for(const id of ['B','F'])expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${id}"]:not([data-rel-overlay])`)?.getAttribute('data-reading-position')?.split(' ')).toContain('previous');
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect([...view.container.querySelectorAll('[data-reading-current-id]')].map(element=>element.getAttribute('data-reading-current-id'))).toEqual(['B','F']);
      for(const id of ['B','F'])expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${id}"]:not([data-rel-overlay])`)).toHaveAttribute('data-reading-position','current');
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="A"]:not([data-rel-overlay])')).toHaveAttribute('data-reading-position','next');
      await visitReading('N');
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      const shared=view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="N"]:not([data-rel-overlay])')!;
      expect(shared).toHaveAttribute('data-reading-position','next continue');
      expect(shared.style.getPropertyValue('--reading-next-offset')).toBe('-9px');
      expect(shared.style.getPropertyValue('--reading-continue-offset')).toBe('9px');
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('keeps both selected classifications expanded without adding duplicate reading history for the same group',async()=>{
    const categoryIds=['cmtgyl9ph00zz13qjjl7gqoc0','cmt4dpf2s006dggsriy6ruf2a'];
    const categories=categoryIds.map((id,index):Relation=>({...makeRelation(),id,relationType:'CLASSIFY',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:index?'F':'B'}]}));
    const {view,geometry}=await setup(categories);
    try{
      await waitForWorkbenchIdle();
      for(const id of categoryIds)await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},id));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      expect(screen.queryByRole('button',{name:'继续追溯本组消息'})).toBeNull();
      const button=screen.getByRole('button',{name:'设为阅读消息'});
      fireEvent.click(button);fireEvent.click(button);await waitForWorkbenchIdle();
      expectReadingPath(categoryIds);expect(latest().traceExpandedFrameIds).toEqual(new Set(categoryIds));
      expect(screen.getByRole('button',{name:'阅读后退'})).toBeDisabled();expect(screen.getByRole('button',{name:'阅读前进'})).toBeDisabled();
      expect(view.container.querySelectorAll('[data-reading-message-section]')).toHaveLength(2);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('restores correction records after opening a reading group that crosses the parent trace boundary',async()=>{
    const correction:Relation={...makeRelation(),id:'reading-correction',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'F'}],
      payload:{correctionBeforeContent:'F',correctionAfterContent:'更正后的 F'},createdAt:'2026-10-28T12:00:00Z',createdBy:{...makeUser(),id:'correction-writer',username:'correction-writer'}};
    const {view,geometry}=await setup([correction]);
    try{
      await traceB();
      fireEvent.click(screen.getByText('范围外及筛选隐藏的待阅内容'));
      fireEvent.click(screen.getByRole('button',{name:/继续追溯并阅读.*P$/}));await waitForWorkbenchIdle();
      await act(async()=>latest().onCanvasBlankClick());
      for(const id of ['N','P'])await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},id));
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      await visitReading('reading-correction');
      expect(screen.getByText('消息列表')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'设为阅读消息'}));await waitForWorkbenchIdle();
      expect([...view.container.querySelectorAll('[data-reading-current-id]')].map(element=>element.getAttribute('data-reading-current-id'))).toEqual(['N','P']);
      expectReadingPath(['N','P']);
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage('reading-correction')).toBeInTheDocument();expectReadingPath(['reading-correction']);
      expect(screen.getByText('消息列表')).toBeInTheDocument();
      expect(mockApi.markReading).not.toHaveBeenCalled();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('starts at the trace source and preserves both directions after reading the source and its older reference target',async()=>{
    vi.clearAllMocks();
    const root='cmv4k86ww0017md14h9mjckvf',older='cmsuf23l00005teehv3uqi37y',participant={...makeUser(),id:'reference-writer',username:'reference-writer'};
    const records=[{...makeMessage(root,'测试1'),createdAt:'2026-10-12T01:15:01Z',createdBy:participant},
      {...makeMessage(older,'2222'),createdAt:'2026-08-15T13:33:12Z',createdBy:participant}];
    const reference:Relation={...makeRelation(),id:'navigation-reference',relationType:'REFERENCE',sourceMessageId:root,
      targetRefs:[{kind:'message',messageId:older}],createdBy:participant,createdAt:'2026-10-26T09:52:49Z'};
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'引用导航'});mockApi.getMessages.mockResolvedValue({data:records});
    mockApi.getRelations.mockResolvedValue({data:[reference]});mockApi.getReadingState.mockResolvedValue({marks:[]});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400)),view=render(<MessageWorkbenchPage/>);
    const readCurrent=async()=>{
      const details=within(screen.getByRole('region',{name:'追溯阅读'})).getByRole('region',{name:'消息阅读确认'});
      const confirm=within(details).getByRole('button');if(!confirm.hasAttribute('disabled')){fireEvent.click(confirm);await waitForWorkbenchIdle();}
    };
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},root));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage(root)).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'阅读后退'})).toBeDisabled();
      await readCurrent();
      await visitReading(older);
      expect(readingCurrentMessage(older)).toBeInTheDocument();await readCurrent();
      expect(screen.getByRole('button',{name:'阅读后退'})).toBeEnabled();
      expect(screen.getByRole('button',{name:'阅读前进'})).toBeDisabled();
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage(root)).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'阅读后退'})).toBeDisabled();expect(screen.getByRole('button',{name:'阅读前进'})).toBeEnabled();
      fireEvent.click(screen.getByRole('button',{name:'阅读前进'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage(older)).toBeInTheDocument();
      expect(mockApi.markReading.mock.calls.flatMap(([marks]:any)=>marks).filter((mark:any)=>mark.scope==='message').map((mark:any)=>mark.messageId)).toEqual([root,older]);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it.each(['graph','list'] as const)('returns from a correction reading visit to the previous message in its original %s presentation',async mode=>{
    const correction:Relation={...makeRelation(),id:'reading-correction',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'F'}],
      payload:{correctionBeforeContent:'F',correctionAfterContent:'更正后的 F'},createdAt:'2026-10-28T12:00:00Z',createdBy:{...makeUser(),id:'correction-writer',username:'correction-writer'}};
    const {view,geometry}=await setup([correction]);
    try{
      await traceB();
      if(mode==='list'){fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();}
      fireEvent.change(screen.getByRole('combobox',{name:'阅读顺序'}),{target:{value:'time'}});await waitForWorkbenchIdle();
      const previous=view.container.querySelector('[data-reading-current-id]')?.getAttribute('data-reading-current-id');
      await visitReading('reading-correction');
      expect(previous).toBeTruthy();expect(readingCurrentMessage('reading-correction')).toBeInTheDocument();
      expectReadingPath(['reading-correction']);
      for(let repeat=0;repeat<2;repeat++){
        fireEvent.click(within(readingCurrentMessage('reading-correction')).getByRole('button',{name:'跳转到消息 reading-correction'}));await waitForWorkbenchIdle();
      }
      expect(screen.getByText('消息列表')).toBeInTheDocument();
      for(let repeat=0;repeat<2;repeat++){
        fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
        expect(readingCurrentMessage(previous!)).toBeInTheDocument();
        expect(screen.getByRole('button',{name:mode==='graph'?'切换为消息表':'切换为消息图'})).toBeInTheDocument();
        expectReadingPath(['B']);
        if(!repeat){fireEvent.click(screen.getByRole('button',{name:'阅读前进'}));await waitForWorkbenchIdle();expect(readingCurrentMessage('reading-correction')).toBeInTheDocument();}
      }
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('marks the current reading message and confirms its status without inventing unvisited neighbors',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      expect(view.container.querySelector('[data-msgid="N"]')?.getAttribute('data-reading-position')).not.toBe('current');
      await visitReading('N');
      expect(view.container.querySelector('[data-msgid="N"]')).toHaveAttribute('data-reading-position','current');
      expect(view.container.querySelector('[data-msgid="F"]')?.getAttribute('data-reading-position')).not.toBe('current');
      await visitReading('F');
      expect(view.container.querySelector('[data-msgid="N"]')?.getAttribute('data-reading-position')).not.toBe('current');
      expect(view.container.querySelector('[data-msgid="F"]')).toHaveAttribute('data-reading-position','current');
      fireEvent.click(screen.getByRole('button',{name:/显示提示 F：/}));
      fireEvent.click(within(screen.getByRole('tooltip')).getByRole('button',{name:'标记当前消息已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());await waitForWorkbenchIdle();
      expect(readingCurrentMessage('F')).toBeInTheDocument();
      expect(view.container.querySelector('[data-msgid="F"]')).toHaveAttribute('data-reading-position','current');
      expect(screen.getByRole('button',{name:'已读'})).toBeDisabled();
      expect(screen.getByRole('button',{name:'下一条'})).toBeDisabled();
      expect(mockApi.markReading.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({messageId:'F',scope:'message'}),expect.objectContaining({messageId:'B',scope:'influence'})]));
      fireEvent.click(screen.getByRole('button',{name:'关闭消息提示'}));
      expect(screen.getByRole('button',{name:'阅读前进'})).toBeDisabled();
      expect(view.container.querySelector('[data-msgid="N"]')?.getAttribute('data-reading-position')).not.toBe('current');
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('defaults to one hop up and two down and changes either distance without changing the other',async()=>{
    const {view,geometry}=await setup();
    try{
      await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'B'));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      const up=()=>screen.getByRole('spinbutton',{name:'向上追溯距离'}),down=()=>screen.getByRole('spinbutton',{name:'向下追溯距离'});
      expect(up()).toHaveValue(1);expect(down()).toHaveValue(2);
      expect(screen.queryByRole('combobox',{name:'追溯方向'})).toBeNull();
      expect(ids()).toEqual(['A','B','D','F','N']);
      fireEvent.change(down(),{target:{value:1}});await waitForWorkbenchIdle();
      expect(up()).toHaveValue(1);expect(ids()).toEqual(['A','B','D','F']);
      fireEvent.change(down(),{target:{value:2}});await waitForWorkbenchIdle();
      fireEvent.change(up(),{target:{value:0}});await waitForWorkbenchIdle();
      expect(down()).toHaveValue(2);expect(ids()).toEqual(['B','D','F','N']);
      fireEvent.change(down(),{target:{value:0}});await waitForWorkbenchIdle();
      expect(ids()).toEqual(['B']);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('jumps forward without reading and returns to the previous visit even after confirming it',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      await visitReading('N');
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      await visitReading('F');
      expect(readingCurrentMessage('F')).toBeInTheDocument();expect(mockApi.markReading).not.toHaveBeenCalled();
      expectReadingPath(['F']);
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage('N')).toBeInTheDocument();expect(mockApi.markReading).not.toHaveBeenCalled();
      expect(document.querySelector('[data-display-hint="N"]')).toHaveAttribute('data-reading-body','unread');
      fireEvent.click(screen.getByRole('button',{name:'已读并继续'}));await waitForWorkbenchIdle();
      const next=view.container.querySelector<HTMLElement>('[data-reading-current-id]')!.dataset.readingCurrentId!;
      expect(next).not.toBe('N');expectReadingPath([next]);
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'已读并继续'})).toBeDisabled();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('switches between breadth and depth without changing trace distances, scope or read marks',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      const before=ids(),selector=()=>screen.getByRole('combobox',{name:'阅读顺序'});
      expect(selector()).toHaveValue('discussion');
      expect(screen.getByRole('option',{name:'深度优先（顺着讨论读）'})).toBeInTheDocument();
      fireEvent.change(selector(),{target:{value:'breadth'}});await waitForWorkbenchIdle();
      expect(selector()).toHaveValue('breadth');expect(ids()).toEqual(before);
      expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(2);
      expect(screen.getByRole('spinbutton',{name:'向下追溯距离'})).toHaveValue(2);
      await visitReading('F');
      expect(readingCurrentMessage('F')).toBeInTheDocument();
      const fScope=ids();
      await visitReading('N');
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      fireEvent.change(selector(),{target:{value:'discussion'}});await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage('F')).toBeInTheDocument();
      expect(ids()).toEqual(fScope);expect(mockApi.markReading).not.toHaveBeenCalled();
      fireEvent.change(selector(),{target:{value:'breadth'}});await waitForWorkbenchIdle();
      expect(readingCurrentMessage('F')).toBeInTheDocument();
      await visitReading('N');
      fireEvent.change(selector(),{target:{value:'time'}});await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(selector()).toHaveValue('breadth');expect(ids()).toEqual(fScope);
      expect(readingCurrentMessage('F')).toBeInTheDocument();
      expect(mockApi.markReading).not.toHaveBeenCalled();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('restores parent filters, direction, distance, reading order and focus after a child trace',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      fireEvent.change(screen.getByRole('spinbutton',{name:'向上追溯距离'}),{target:{value:1}});await waitForWorkbenchIdle();
      const readingPanel=screen.getByRole('region',{name:'追溯阅读'}),exitTrace=screen.getByRole('button',{name:'退出追溯'});
      expect(readingPanel.closest('[data-guide-selection-staging]')).toBeNull();
      expect(readingPanel.compareDocumentPosition(exitTrace)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await visitReading('N');
      const parentScope=ids();
      await visitReading('P');
      fireEvent.click(within(screen.getByRole('region',{name:'消息阅读确认'})).getByRole('button',{name:'标记当前消息已阅'}));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'P'));
      const staged=latest().draftUnits;
      setTraceDirectionForTest('down');
      fireEvent.change(screen.getByRole('combobox',{name:'阅读顺序'}),{target:{value:'time'}});
      stepTraceDistanceForTest(-1);await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'过滤'}));fireEvent.click(screen.getByRole('button',{name:'按发送者'}));
      const sender=screen.getByPlaceholderText('例如: 张三');fireEvent.change(sender,{target:{value:'child-only-filter'}});fireEvent.keyDown(sender,{key:'Enter'});
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(ids()).toEqual(parentScope);
      expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(1);expect(screen.getByRole('spinbutton',{name:'向下追溯距离'})).toHaveValue(2);expect(screen.getByRole('combobox',{name:'阅读顺序'})).toHaveValue('discussion');
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      expectReadingPath(['N']);
      expect(latest().draftUnits).toEqual(staged);
      expect(mockApi.markReading.mock.calls.flatMap(([marks]:any)=>marks).some((mark:any)=>mark.messageId==='P'&&mark.scope==='message')).toBe(true);
      fireEvent.click(screen.getByRole('button',{name:'已读并继续'}));await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-reading-current-id]')).not.toHaveAttribute('data-reading-current-id','N');expect(latest().draftUnits).toEqual(staged);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it.each([false,true])('restores both graph and table scroll positions after returning from a child trace (delayed layout: %s)',async delayed=>{
    const dimensions=[vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(5000),vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(400),vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(600)];
    const {view,geometry}=await setup();
    const left=()=>document.querySelector<HTMLElement>('[data-workbench-left-panel]')!,right=()=>screen.getByRole('region',{name:'发言与关系操作'});
    const scroll=(top:number,x:number)=>{left().scrollTop=top;left().scrollLeft=x;fireEvent.scroll(left());};
    try{
      await traceB();await visitReading('N');
      scroll(360,25);right().scrollTop=90;fireEvent.scroll(right());
      fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();scroll(620,40);
      await visitReading('P');
      fireEvent.click(screen.getByRole('button',{name:'切换为消息图'}));await waitForWorkbenchIdle();scroll(1200,200);right().scrollTop=500;
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(screen.getByRole('button',{name:'切换为消息图'})).toBeInTheDocument();
      expect(left().scrollTop).toBe(620);expect(left().scrollLeft).toBe(40);expect(right().scrollTop).toBe(90);
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      if(delayed)vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button',{name:'切换为消息图'}));
      if(delayed){
        let release!:()=>void;
        act(()=>{release=graphRendering.tasks!.begin('measurement').release;});
        // Keep layout pending past automatic selection navigation's deadline.
        await act(async()=>{await vi.advanceTimersByTimeAsync(150);});
        act(release);
      }
      await waitForWorkbenchIdle();
      expect(left().scrollTop).toBe(360);expect(left().scrollLeft).toBe(25);
    }finally{view.unmount();vi.useRealTimers();geometry.mockRestore();dimensions.forEach(spy=>spy.mockRestore());graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  },15000);
  it('keeps the reading card at its prior visible position when the parent layout changes while tracing a child',async()=>{
    const {view,geometry}=await setup();let shift=0;
    const dimensions=[vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(5000),vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(400),vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(600)];
    const left=()=>document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    geometry.mockImplementation(function(this:HTMLElement){
      if(this.dataset.msgid==='N'&&!this.hasAttribute('data-rel-overlay'))return new DOMRect(40,700+shift-left().scrollTop,320,86);
      return new DOMRect(0,120,600,400);
    });
    const card=()=>document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="N"]:not([data-rel-overlay])')!;
    try{
      await traceB();await visitReading('N');
      const before=card().getBoundingClientRect().top;
      await visitReading('P');
      shift=240;
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(card().getBoundingClientRect().top).toBeCloseTo(before);
    }finally{view.unmount();geometry.mockRestore();dimensions.forEach(spy=>spy.mockRestore());graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  },15000);
  it('does not restore a failed parent location as a successful reading position',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();geometry.mockReturnValue(new DOMRect(0,0,0,0));
      await visitReading('N');
      expect(screen.getByRole('button',{name:'已读并继续'})).toBeDisabled();
      geometry.mockReturnValue(new DOMRect(0,120,600,400));
      await visitReading('P');
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'已读并继续'})).toBeDisabled();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it.each(['P','N'])('opens reading %s from JOIN history in its own trace and restores the JOIN view on return',async(destination)=>{
    const records:Relation[]=[{...makeRelation(),id:'join-container',relationType:'CLASSIFY',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'N'}]},
      {...makeRelation(),id:'N-join',relationType:'JOIN',sourceMessageId:'join-container',targetRefs:[{kind:'message',messageId:'N'}]}];
    const {view,geometry}=await setup(records);
    try{
      await traceB();
      await act(async()=>latest().onJoinFilterClick('N','incoming'));await waitForWorkbenchIdle();
      expect(screen.getByText('加入记录临时分类（1）')).toBeInTheDocument();
      if(destination==='P'){
        fireEvent.click(screen.getByText('范围外及筛选隐藏的待阅内容'));
        fireEvent.click(screen.getByRole('button',{name:/继续追溯并阅读.*P$/}));
      }else await visitReading('N');
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText('加入记录临时分类（1）')).toBeNull();
      expectReadingPath([destination]);
      expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${destination}"]:not([data-rel-overlay])`)).not.toBeNull();
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(screen.getByText('加入记录临时分类（1）')).toBeInTheDocument();
      expectReadingPath(['B']);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('requires a completed location before confirming the focused message and allows retry',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      await act(async()=>latest().onCanvasBlankClick());
      await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'N'));
      geometry.mockReturnValue(new DOMRect(0,0,0,0));
      fireEvent.click(screen.getByRole('button',{name:'设为阅读消息'}));await waitForWorkbenchIdle();
      expect(screen.getByRole('alert')).toHaveTextContent('目标消息未能定位');
      expect(screen.getByRole('button',{name:'已读并继续'})).toBeDisabled();
      expect(mockApi.markReading).not.toHaveBeenCalled();
      geometry.mockReturnValue(new DOMRect(0,120,600,400));
      fireEvent.click(screen.getByRole('button',{name:'重新定位当前消息'}));await waitForWorkbenchIdle();
      expect(screen.getByRole('button',{name:'已读并继续'})).toBeEnabled();
      fireEvent.click(screen.getByRole('button',{name:'已读并继续'}));await waitForWorkbenchIdle();
      expect(mockApi.markReading.mock.calls.flatMap(([marks]:any)=>marks).some((mark:any)=>mark.messageId==='N'&&mark.scope==='message')).toBe(true);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('traces an explicitly revealed filtered visit while preserving the filter',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      fireEvent.click(screen.getByRole('button',{name:'过滤'}));fireEvent.click(screen.getByRole('button',{name:'按发送者'}));
      const sender=screen.getByPlaceholderText('例如: 张三');
      fireEvent.change(sender,{target:{value:'not-in-this-discussion'}});fireEvent.keyDown(sender,{key:'Enter'});
      await waitForWorkbenchIdle();
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="N"]')).toBeNull();
      fireEvent.click(screen.getByText('范围外及筛选隐藏的待阅内容'));
      fireEvent.click(screen.getByRole('button',{name:/临时显示并阅读.*N$/}));await waitForWorkbenchIdle();
      expectReadingPath(['N']);
      await waitFor(()=>expect(document.querySelector('[data-workbench-left-panel] [data-msgid="N"]:not([data-rel-overlay])')).not.toBeNull());
      expect(screen.getByRole('button',{name:'下一条'})).toBeDisabled();
      fireEvent.click(screen.getByRole('button',{name:'已读'}));await waitForWorkbenchIdle();
      expect(mockApi.markReading.mock.calls.flatMap(([marks]:any)=>marks).some((mark:any)=>mark.messageId==='N'&&mark.scope==='message')).toBe(true);
      expectReadingPath(['N']);
      expect(screen.getByRole('button',{name:/过滤中/})).toBeInTheDocument();
      expect(screen.getByText('发送者: not-in-this-discussion')).toBeInTheDocument();
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="F"]')).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('confirms the displayed original and advances without correction prerequisites',async()=>{
    const correction:Relation={...makeRelation(),id:'N-edit',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'N'}],
      payload:{correctionBeforeContent:'N',correctionAfterContent:'更正后的 N'},createdAt:'2026-10-27T09:10:00Z'};
    const {view,geometry}=await setup([correction]);
    try{
      await traceB();
      await visitReading('N');
      fireEvent.click(screen.getByRole('button',{name:'切换消息 N 的版本'}));
      fireEvent.click(screen.getByRole('radio',{name:'原文'}));
      const close=screen.queryByRole('button',{name:'关闭版本选择'});if(close)fireEvent.click(close);
      await waitForWorkbenchIdle();
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'已读并继续'}));await waitForWorkbenchIdle();
      expect(mockApi.markReading).toHaveBeenCalledOnce();
      const marks=mockApi.markReading.mock.calls[0][0];
      expect(marks.some((mark:any)=>mark.messageId==='N'&&mark.scope==='original')).toBe(false);
      expect(marks.some((mark:any)=>mark.messageId==='N'&&mark.scope==='message')).toBe(true);
      expect(screen.queryByText('原文已记录。请先阅读更正内容，再确认当前正文。')).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('keeps a late save failure from replacing the new scope with an old error',async()=>{
    const {view,geometry}=await setup();let failSave:((reason:Error)=>void)|undefined;
    try{
      await traceB();
      await visitReading('N');
      mockApi.markReading.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failSave=reject;}));
      fireEvent.click(screen.getByRole('button',{name:'已读并继续'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());
      setTraceDirectionForTest('up');
      await act(async()=>failSave!(new Error('旧范围保存失败')));await waitForWorkbenchIdle();
      expect(ids()).toEqual(['B','C','D','E','N']);expect(screen.queryByRole('alert')).toBeNull();
      setTraceDirectionForTest('both');await waitForWorkbenchIdle();
      expect(document.querySelector('[data-display-hint="N"]')).toHaveAttribute('data-reading-body','unread');
    }finally{failSave?.(new Error('测试结束'));view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it.each(['direction','order','focus'] as const)('keeps the new %s after a pending read save completes',async(change)=>{
    const {view,geometry}=await setup();let finishSave:(()=>void)|undefined;
    try{
      await traceB();
      await visitReading('N');
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      mockApi.markReading.mockImplementationOnce((marks:any)=>new Promise(resolve=>{finishSave=()=>resolve({marks});}));
      fireEvent.click(screen.getByRole('button',{name:'已读并继续'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());
      if(change==='direction')setTraceDirectionForTest('up');
      else if(change==='order')fireEvent.change(screen.getByRole('combobox',{name:'阅读顺序'}),{target:{value:'time'}});
      else await act(async()=>latest().onNavigateToMessage('F'));
      await act(async()=>finishSave!());await waitForWorkbenchIdle();
      expect(readingCurrentMessage(change==='focus'?'F':'N')).toBeInTheDocument();
      expectReadingPath([change==='focus'?'F':'N']);
      expect(screen.queryByRole('alert')).toBeNull();
      if(change==='direction'){
        expect(ids()).toEqual(['B','C','D','E','N']);
        setTraceDirectionForTest('both');await waitForWorkbenchIdle();
      }
      if(change==='focus'){fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();}
      expect(document.querySelector('[data-display-hint="N"]')).toHaveAttribute('data-reading-body','read');
    }finally{finishSave?.();view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('keeps scope and reading order independent and reads N before F in discussion mode',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      setTraceDirectionForTest('up');await waitForWorkbenchIdle();
      expect(ids()).toEqual(['A','B']);
      setTraceDirectionForTest('down');await waitForWorkbenchIdle();
      expect(ids()).toEqual(['B','D','F','N']);
      setTraceDirectionForTest('both');await waitForWorkbenchIdle();
      expect(ids()).toEqual(['A','B','D','F','N']);
      await visitReading('N');
      expect(readingCurrentMessage('N')).toBeInTheDocument();expect(latest().draftUnits.map((unit:any)=>unit.messageId)).toEqual(['B']);
      fireEvent.change(screen.getByRole('combobox',{name:'阅读顺序'}),{target:{value:'time'}});await waitForWorkbenchIdle();
      expect(readingCurrentMessage('N')).toBeInTheDocument();expect(screen.getByRole('button',{name:'阅读前进'})).toBeDisabled();
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(readingCurrentMessage('B')).toBeInTheDocument();expectReadingPath(['B']);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('opens an outside reminder as a new trace, shares read marks and restores the parent scope',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      await visitReading('N');
      fireEvent.click(within(screen.getByRole('region',{name:'消息阅读确认'})).getByRole('button',{name:'标记当前消息已阅'}));await waitForWorkbenchIdle();
      const savedMarks=()=>mockApi.markReading.mock.calls.flatMap(([marks]:any)=>marks);
      expect(savedMarks().some((mark:any)=>mark.messageId==='N'&&mark.scope==='message')).toBe(true);
      expect(savedMarks().some((mark:any)=>mark.messageId==='D'&&mark.scope==='influence')).toBe(true);
      expect(savedMarks().some((mark:any)=>mark.messageId==='E'&&mark.scope==='influence')).toBe(true);
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByText('范围外及筛选隐藏的待阅内容'));
      fireEvent.click(screen.getByRole('button',{name:/继续追溯并阅读.*P$/}));await waitForWorkbenchIdle();
      expectReadingPath(['P']);expect(ids()).toEqual(['D','E','N','P','Q']);
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expectReadingPath(['B']);expect(ids()).toEqual(['A','B','D','F','N']);
      expect(latest().draftUnits.map((unit:any)=>unit.messageId)).toEqual(['B']);
      // Offscreen cards are virtualized. Revisit N before checking its shared read status.
      await visitReading('N');
      expect(document.querySelector('[data-display-hint="N"]')?.getAttribute('data-reading-body')).toBe('read');
      expect(mockApi.markReading).toHaveBeenCalledOnce();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('automatically retraces each reading message downward without adding duplicate history',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      setTraceDirectionForTest('down');await waitForWorkbenchIdle();
      fireEvent.click(screen.getByText('范围外及筛选隐藏的待阅内容'));
      fireEvent.click(screen.getByRole('button',{name:/继续追溯并阅读.*P$/}));await waitForWorkbenchIdle();
      expect(ids()).toEqual(['P','Q']);expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(0);
      expect(screen.getByRole('note')).toHaveTextContent('来源提示不扩展当前追溯范围');
      expectReadingPath(['P']);
      await act(async()=>latest().onNavigateToMessage('Q'));await waitForWorkbenchIdle();
      expectReadingPath(['Q']);
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="Q"]:not([data-rel-overlay])')).not.toBeNull();
      expect(ids()).toEqual(['Q']);
      await act(async()=>latest().onNavigateToMessage('P'));await waitForWorkbenchIdle();
      expect(ids()).toEqual(['P','Q']);expectReadingPath(['P']);
      await act(async()=>latest().onNavigateToMessage('P'));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();expectReadingPath(['Q']);
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
  });
  it('keeps the current unread visit when saving fails and advances only after a successful retry',async()=>{
    const {view,geometry}=await setup();
    try{
      await traceB();
      await visitReading('N');
      mockApi.markReading.mockRejectedValueOnce(new Error('保存失败，请重试'));
      fireEvent.click(screen.getByRole('button',{name:'已读并继续'}));
      await screen.findByRole('alert');await waitForWorkbenchIdle();
      expect(readingCurrentMessage('N')).toBeInTheDocument();
      expect(document.querySelector('[data-display-hint="N"]')).toHaveAttribute('data-reading-body','unread');
      expect(screen.getByRole('alert')).toHaveTextContent('保存失败，请重试');
      fireEvent.click(screen.getByRole('button',{name:'已读并继续'}));await waitForWorkbenchIdle();
      const next=view.container.querySelector<HTMLElement>('[data-reading-current-id]')!.dataset.readingCurrentId!;
      expect(next).not.toBe('N');expectReadingPath([next]);
      fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
      expect(document.querySelector('[data-display-hint="N"]')).toHaveAttribute('data-reading-body','read');
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;mockApi.getReadingState.mockResolvedValue({marks:[]});}
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
    fireEvent.click(screen.getByRole('radio', { name: /^自发$/ }));

    await waitFor(() => {
      const graphProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const messageIds = new Set(graphProps.messages.map((message: { id: string }) => message.id));
      expect(messageIds).toEqual(new Set(['outer-classify']));
    });
  });

  it('shows join records in the temporary category and preserves it when navigating to its record', async () => {
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const getLatestGraphProps = () => mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    await act(async () => {
      getLatestGraphProps().onJoinFilterClick('inner-arrange', 'outgoing');
    });
    expect(document.querySelector('[data-workbench-left-panel] [data-msgid="join-hit"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
    expect(document.querySelector('[data-workbench-left-panel] [data-msgid="join-hit"]')).toBeNull();

    await act(async () => {
      getLatestGraphProps().onJoinFilterClick('inner-arrange', 'outgoing');
    });
    await jumpToMessageId('join-hit');
    expect(document.querySelector('[data-workbench-left-panel] [data-msgid="join-hit"]')).not.toBeNull();
  });
});

describe('MessageWorkbenchPage composer refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.createMessage.mockReset();
    mockApi.createRelation.mockReset();
    mockApi.withCommandBatch.mockReset().mockImplementation(defaultCommandBatch);
    const scope: ScopeView = { messageId: 'classification-1', title: '测试分类' };
    mockApi.getScope.mockResolvedValue(scope);
    mockApi.getMessages.mockResolvedValue({ data: [makeMessage('msg-1', '第一条'), makeMessage('msg-2', '第二条')] });
    mockApi.getRelations.mockResolvedValue({ data: [makeRelation()] });
  });

  it.each([
    { type:'TEXT', button:'', text:'发送定位正文', target:false },
    ...[['REFERENCE','引用'],['REPLY','回复'],['ANNOTATION','注释'],['NOTIFY','通知']].map(([type,button])=>({type,button,text:'发送定位的来源正文',target:true})),
    ...[['AGREE','赞同'],['DISAGREE','反对']].map(([type,button])=>({type,button,text:'',target:true})),
    { type:'TAG',button:'标注',secondary:'可靠',text:'',target:true },
    { type:'RECOMMEND',button:'标注',secondary:'推荐',text:'',target:true },
    { type:'ARCHIVE',button:'标注',secondary:'冷藏',text:'',target:true },
    ...[['ATTENTION','关注'],['BLOCK','拉黑']].flatMap(([type,secondary])=>['是','否'].map(reason=>({type,button:'标注',secondary,reason,text:'',target:true}))),
    { type:'CLASSIFY',button:'分类',text:'新的定位分类',target:true },
    { type:'SUMMARY',button:'总结',text:'新的定位总结',target:true },
    ...['纵','横'].map(secondary=>({type:'ARRANGE',button:'排列',secondary,text:'',target:true})),
    { type:'MERGE',button:'归并',text:'',target:true },
    { type:'CORRECT',button:'更正',secondary:'修正文字',text:'更正后的正文',target:true },
    { type:'CORRECT',button:'更正',secondary:'宽度调整',text:'',target:true },
    { type:'DELEGATION',button:'委托',secondary:'创建委托',text:'报酬数量=5；委托内容=核对来源',target:false },
    { type:'DELEGATION',button:'委托',secondary:'完成委托',text:'完成说明=已核对来源',target:true },
    { type:'PROPOSAL',button:'提案',text:'提案定位正文',target:false },
    { type:'CODE_CHANGE',button:'代码',text:'代码定位正文',target:false },
    { type:'OPERATIONS',button:'运营',text:'公告定位正文',target:false },
  ].flatMap(scenario=>['graph','list'].map(mode=>({...scenario,mode,secondary:String('secondary' in scenario?scenario.secondary:''),reason:String('reason' in scenario?scenario.reason:'')}))))(
    'locates committed $type $secondary $reason in $mode and releases the send lock',async({type,button,secondary,reason,text,target,mode})=>{
    localStorage.setItem('token','test-token');
    const original={...makeMessage('msg-1','定位目标正文'),revision:1,parts:[{id:'body',type:'text' as const,text:'定位目标正文'}]};
    const baseRelations:Relation[]=type==='TAG'?[{...makeRelation(),id:'existing-tag',relationType:'TAG',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:original.id}],payload:{label:'可靠'}}]:secondary==='完成委托'?[{...makeRelation(),id:'delegation-target',relationType:'DELEGATION',sourceMessageId:null,
      targetRefs:[],payload:{delegationKind:'CREATE',content:'报酬数量=5；委托内容=核对来源',rewardAmount:5}}]:[];
    const asMessage=(relation:Relation):Message=>({...makeMessage(relation.id,relation.payload?.content??relation.payload?.title??''),kind:'RELATION',
      relationType:relation.relationType,relSourceId:relation.sourceMessageId,targetRefs:relation.targetRefs,relationPayload:relation.payload,parts:relation.parts,revision:relation.revision});
    const sentMessages:Message[]=[],sentRelations:Relation[]=[],located:string[]=[];
    mockApi.getMessages.mockResolvedValue({data:[original]});mockApi.getRelations.mockResolvedValue({data:baseRelations});
    mockApi.createMessage.mockImplementation(async(_parent,body)=>{const message=makeMessage('sent-text',body.content);sentMessages.push(message);return message;});
    let finishCommit!:()=>void;
    const publishCommit=()=>window.dispatchEvent(new CustomEvent('gonglun:committed',{detail:[{scope:{messageId:'classification-1',title:'测试分类'},sequence:2,
      messages:[original,...sentMessages,...baseRelations.map(asMessage),...sentRelations.map(asMessage)],relations:[...baseRelations,...sentRelations],users:[makeUser()],stakes:{},tagCounts:{},attentionUsers:{}}]}));
    mockApi.createRelation.mockImplementation(async(_parent,body)=>{
      const relation:Relation={...makeRelation(),...body,id:`sent-${body.relationType.toLowerCase()}-${sentRelations.length}`};
      if(secondary==='修正文字')relation.payload={...body.payload,correctionBeforeContent:original.content,correctionAfterContent:text};
      sentRelations.push(relation);
      // The correction comparison confirms through the single-message endpoint.
      if(secondary==='修正文字'){await new Promise<void>(resolve=>{finishCommit=resolve;});publishCommit();}
      return relation;
    });
    mockApi.withCommandBatch.mockImplementationOnce(async(work,onCommitted)=>{
      await work();if(!sentMessages.length&&!sentRelations.length)return;
      await new Promise<void>(resolve=>{finishCommit=resolve;});publishCommit();
      onCommitted?.(sentMessages.length+sentRelations.length);
    });
    const recipients=vi.spyOn(notificationApi,'getNotificationRecipients').mockResolvedValue({users:[participant]});
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const observer=new MutationObserver(()=>{
      const id=document.querySelector('[data-message-jump-overlay="true"]')?.getAttribute('data-message-jump-target');
      if(id&&located.at(-1)!==id)located.push(id);
    });
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(target){
        if(secondary==='修正文字')act(()=>window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT,{detail:{reference:{messageId:original.id,revision:1,partId:'body'},label:'正文'}})));
        else await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},secondary==='完成委托'?'delegation-target':original.id));
      }
      if(mode==='list'){fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();}
      if(button)fireEvent.click(screen.getByRole('button',{name:['提案','委托','代码','运营'].includes(button)?new RegExp(`${button}$`):button}));
      if(secondary){const choice=screen.getByRole('button',{name:secondary});if(choice.getAttribute('aria-pressed')!=='true')fireEvent.click(choice);}
      if(reason)fireEvent.click(screen.getByRole('button',{name:reason}));
      if(text)fireEvent.change(screen.getByRole('region',{name:'发言与关系操作'}).querySelector('textarea')!,{target:{value:text}});
      await waitFor(()=>expect(screen.getByRole('button',{name:'发送'})).toBeEnabled());
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      if(secondary==='修正文字'){
        const confirm=await screen.findByRole('button',{name:'确认发送更正'});await waitFor(()=>expect(confirm).toBeEnabled());fireEvent.click(confirm);
      }
      await waitFor(()=>expect(finishCommit).toBeDefined());
      expect(document.querySelector('[data-message-jump-overlay="true"]')).toBeNull();
      expect(screen.getByRole('button',{name:'预览'})).toBeDisabled();
      observer.observe(document.body,{subtree:true,childList:true,attributes:true});
      await act(async()=>finishCommit());
      if(secondary==='宽度调整'){
        await waitForWorkbenchIdle();expect(located).toEqual([]);
        expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')).not.toBeNull();
      }else{
        await waitFor(()=>expect(located).toEqual([...sentMessages.map(message=>message.id),...sentRelations.map(relation=>relation.id)]));
        await waitForWorkbenchIdle();
      }
      expect(type==='TEXT'?sentMessages.length:sentRelations.filter(relation=>relation.relationType===type).length).toBe(1);
      expect(screen.queryByText(/绘制超时|绘制或定位尚未完成|暂时未能完成定位/)).toBeNull();
      expect(mockNavigate).not.toHaveBeenCalled();
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'),{target:{value:'下一条草稿'}});
      await waitFor(()=>expect(screen.getByRole('button',{name:'预览'})).toBeEnabled());
      expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
    }finally{observer.disconnect();view.unmount();geometry.mockRestore();recipients.mockRestore();graphRendering.actual=false;}
  });

  it('excludes voted text and delegation bodies from comparison and blocks a retained delegation selection', async () => {
    const originals = [receivedMessage('msg-1', '来源正文'), receivedMessage('msg-2', '目标正文')];
    const delegation: Relation = { ...receivedRelation(), id: 'delegation', relationType: 'DELEGATION', sourceMessageId: null, targetRefs: [],
      parts: [{ id: 'body', type: 'text', text: '委托内容' }], payload: { delegationKind: 'CREATE', rewardAmount: 10 } };
    const reference: Relation = { ...receivedRelation(), id: 'reference', relationType: 'REFERENCE', sourceMessageId: 'msg-1',
      targetRefs: [{ kind: 'message', messageId: 'msg-2' }] };
    const vote = (id: string, target: string): Relation => ({ ...receivedRelation(), id, relationType: 'AGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: target }] });
    const relations = [delegation, reference, vote('vote-text', 'msg-1'), vote('vote-delegation', delegation.id), vote('vote-reference', reference.id)];
    const records: Message[] = relations.map(relation => ({ ...receivedMessage(relation.id, relation.id === delegation.id ? '委托内容' : ''),
      kind: 'RELATION', relationType: relation.relationType, relSourceId: relation.sourceMessageId ?? undefined,
      targetRefs: relation.targetRefs, relationPayload: relation.payload, parts: relation.parts }));
    const snapshotLoader = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    mockApi.getWorkbenchSnapshot.mockResolvedValue({ scope: { messageId: 'classification-1', title: '测试分类' },
      messages: [...originals, ...records], relations, users: [makeUser(), participant], stakes: {}, tagCounts: {}, attentionUsers: {},
      sequence: 1, hasMore: false, nextCursor: null });
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）'); await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' })); await waitForWorkbenchIdle();
      fireEvent.click(view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="delegation"]')!);
      fireEvent.click(screen.getByRole('button', { name: '对比' })); await waitForWorkbenchIdle();
      expect(screen.getByText('选择对比消息（1）')).toBeInTheDocument();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="delegation"]')).toBeNull();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')).toBeNull();
      expect(screen.getByRole('button', { name: '审阅' })).toBeDisabled();
      fireEvent.click(view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="reference"]')!);
      expect(screen.getByRole('button', { name: '审阅' })).toBeEnabled();
      expect(mockApi.createMessage).not.toHaveBeenCalled(); expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { view.unmount(); mockApi.getWorkbenchSnapshot.mockImplementation(snapshotLoader); }
  });

  it('reviews a text correction with different bodies and does not invent a personal opposition', async () => {
    localStorage.setItem('token', 'test-token');
    const original: Message = { ...receivedMessage('msg-1', '好玩吗？'), revision: 1, parts: [{ id: 'body', type: 'text', text: '好玩吗？' }] };
    const reference = { messageId: original.id, revision: 1, partId: 'body', range: { start: 2, end: 4 } };
    const correction: Relation = { ...receivedRelation(), id: 'correction-under-review', revision: 1,
      relationType: 'CORRECT', sourceMessageId: null,
      targetRefs: [{ kind: 'text-fragment', messageId: original.id, text: '吗？', hash: 'range', reference }],
      payload: { correctionKind: 'TEXT', correctionBeforeContent: '好玩吗？', correctionAfterContent: '好玩1111', correctionValue: '1111' },
      parts: [{ id: 'corrected-body', type: 'text', text: '好玩1111' },
        { id: 'relation', type: 'relation', relation: 'correct', roles: { target: [{ id: 'target', reference }] } }],
      state: { messageId: 'correction-under-review', revision: 1, suppressed: true, supportCount: 0, oppositionCount: 1, recommendationTotal: 0 } };
    const opposition: Relation = { ...receivedRelation(), id: 'public-opposition', relationType: 'DISAGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'relation', relationId: correction.id }] };
    const relationMessage = (relation: Relation): Message => ({ ...receivedMessage(relation.id, ''), kind: 'RELATION',
      revision: relation.revision, relationType: relation.relationType, targetRefs: relation.targetRefs,
      relationPayload: relation.payload, parts: relation.parts, state: relation.state });
    const snapshotLoader = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    mockApi.getWorkbenchSnapshot.mockResolvedValue({ scope: { messageId: 'classification-1', title: '测试分类' },
      messages: [original, relationMessage(correction), relationMessage(opposition)], relations: [correction, opposition],
      users: [makeUser(), participant], stakes: {}, tagCounts: {}, attentionUsers: {}, sequence: 1, hasMore: false, nextCursor: null });
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）'); await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '切换消息 msg-1 的版本' }));
      expect(screen.getByRole('dialog')).toHaveTextContent('当前用户尚未选择');
      fireEvent.click(screen.getByRole('button', { name: '关闭版本选择' }));
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' })); await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '对比' })); await waitForWorkbenchIdle();
      const record = view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="correction-under-review"]')!;
      expect(within(record).getByText('当前未生效')).toBeInTheDocument();
      expect(within(record).queryByText('你已反对 · 点赞同恢复')).toBeNull();
      fireEvent.click(record);
      await waitFor(() => expect(screen.getByRole('button', { name: '审阅' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: '审阅' })); await waitForWorkbenchIdle();
      const body = (side: string) => view.container.querySelector<HTMLElement>(`[data-comparison-view="${side}"] [data-msgid="msg-1"] [data-message-part-id="body"]`);
      expect(body('agree')).toHaveTextContent('好玩1111');
      expect(body('disagree')).toHaveTextContent('好玩吗？');
      expect(within(view.container.querySelector<HTMLElement>('[data-comparison-view="agree"]')!).getByText('✏更正 1/1')).toBeInTheDocument();
      expect(within(view.container.querySelector<HTMLElement>('[data-comparison-view="disagree"]')!).getByText('✏更正 0/1')).toBeInTheDocument();
      expect(mockGraphView.mock.lastCall![0].comparisonAgreeCorrectionVersions.get(original.id).current.appliedCorrectionIds).toEqual([correction.id]);
      expect(mockGraphView.mock.lastCall![0].comparisonDisagreeCorrectionVersions.get(original.id).current).toBeUndefined();
      expect(mockApi.createMessage).not.toHaveBeenCalled(); expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { view.unmount(); graphRendering.actual = false; mockApi.getWorkbenchSnapshot.mockImplementation(snapshotLoader); }
  }, 15000);

  it('opens a conflicting JOIN basis in its record category with its statistics controls',async()=>{
    const parent=(id:string):Relation=>({...makeRelation(),id,relationType:'CLASSIFY',sourceMessageId:null,targetRefs:[],payload:{title:id,independentMemberships:true},createdBy:participant});
    const old:Relation={...makeRelation(),id:'old-choice',relationType:'JOIN',sourceMessageId:'A',targetRefs:[{kind:'message',messageId:'msg-1'}],createdAt:'2024-01-01T00:00:01Z'};
    const next:Relation={...old,id:'recommended-choice',sourceMessageId:'B',createdBy:participant,createdAt:'2024-01-01T00:00:02Z'};
    mockApi.getRelations.mockResolvedValue({data:[parent('A'),parent('B'),old,next]});
    const view=render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    await act(async()=>mockGraphView.mock.lastCall![0].onJoinFilterClick('B','outgoing'));
    const listSwitch=screen.queryByRole('button',{name:'切换为消息表'});if(listSwitch)fireEvent.click(listSwitch);await waitForWorkbenchIdle();
    const current=view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="recommended-choice"]')!;
    fireEvent.click(within(current).getByRole('button',{name:/^显示提示 recommended-choice：/}));
    fireEvent.click(screen.getByRole('button',{name:'查看当前选择依据 old-choice'}));
    await waitFor(()=>expect(screen.getByText('加入记录临时分类（2）')).toBeInTheDocument());
    const chosen=view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="old-choice"]')!;
    expect(chosen).not.toBeNull();expect(within(chosen).getByTitle('真假仲裁')).toBeVisible();
    expect(screen.queryByRole('button',{name:'退出查看'})).toBeNull();
    expect(screen.getByText('当前未选择任何候选。')).toBeInTheDocument();
  });

  it.each(['agree','disagree','recommend','tag'] as const)('opens %s records in a temporary category and restores the previous view',async type=>{
    const label=type==='agree'?'赞同':type==='disagree'?'反对':type==='recommend'?'推荐':'核实';
    const record:Relation={...makeRelation(),id:'record-entry',relationType:type.toUpperCase(),sourceMessageId:null,payload:type==='tag'?{label}:undefined};
    mockApi.getRelations.mockResolvedValue({data:[record]});
    const view=render(<MessageWorkbenchPage/>),latest=()=>mockGraphView.mock.lastCall![0];
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    const before=latest().messages.map((message:{id:string})=>message.id);
    await act(async()=>{
      const event={stopPropagation:vi.fn(),clientX:20,clientY:30};
      if(type==='agree'||type==='disagree')latest().onDecorationDoubleClick(event,'msg-1',type);
      else if(type==='tag')latest().onTagDoubleClick(event,'msg-1',label,[record.id]);
      else latest().onInlineBadgeDoubleClick(event,record.id);
    });
    await waitForWorkbenchIdle();
    expect(screen.getByText(`${label}记录临时分类（1）`)).toBeInTheDocument();
    expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${record.id}"]`)).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
    expect(latest().messages.map((message:{id:string})=>message.id)).toEqual(before);
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('compares the original with the currently displayed body on a correction click without selecting it',async()=>{
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('comparison-body','正文原文')]});
    mockApi.getRelations.mockResolvedValue({data:[{...makeRelation(),id:'comparison-edit',relationType:'CORRECT',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'comparison-body'}],
      payload:{correctionBeforeContent:'正文原文',correctionAfterContent:'当前正文'}}]});
    const view=render(<MessageWorkbenchPage/>),latest=()=>mockGraphView.mock.lastCall![0];
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    await waitFor(()=>expect(latest().messages.find((message:{id:string})=>message.id==='comparison-body')?.content).toBe('当前正文'));
    await act(async()=>latest().onInlineBadgeClick({stopPropagation:vi.fn(),clientX:0,clientY:0},'comparison-edit'));
    const dialog=await screen.findByRole('dialog',{name:'原文与当前版本正文对比'});
    expect(within(dialog).getByRole('region',{name:'原文'})).toHaveTextContent('正文原文');
    expect(within(dialog).getByRole('region',{name:'当前版本正文'})).toHaveTextContent('当前正文');
    expect(latest().draftUnits).toEqual([]);
    view.unmount();
  });

  it.each(['推荐','冷藏'])('keeps body text editable with %s and separates the custom cause',async label=>{
    localStorage.setItem('token','test-token');
    mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.createMessage.mockResolvedValue(makeMessage('new-text','附带文本'));
    mockApi.createRelation.mockImplementation(async(_scope,input)=>({...makeRelation(),...input,id:'new-annotation'}));
    const view=render(<MessageWorkbenchPage/>),latest=()=>mockGraphView.mock.lastCall![0];
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'msg-1'));
    fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'),{target:{value:'附带文本'}});
    fireEvent.click(screen.getByRole('button',{name:'标注'}));
    const annotation=screen.getByRole('button',{name:label});
    if(annotation.getAttribute('aria-pressed')!=='true')fireEvent.click(annotation);
    const textarea=screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）');
    expect(textarea).not.toHaveAttribute('readonly');expect(textarea).toHaveValue('附带文本');
    fireEvent.click(screen.getByRole('button',{name:'自定义'}));
    expect(screen.getByText('标注原因：')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'发送'})).toBeDisabled();
    const cause=screen.getByRole('textbox',{name:'自定义标注原因'});
    expect(cause.tagName).toBe('INPUT');
    fireEvent.change(cause,{target:{value:'自定义原因'}});
    expect(textarea).toHaveValue('附带文本');
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1',expect.objectContaining({relationType:label==='推荐'?'RECOMMEND':'ARCHIVE',sourceMessageId:'new-text',payload:{subType:'CUSTOM',customLabel:'自定义原因'}})));
    expect(mockApi.createMessage).toHaveBeenCalledWith('classification-1',expect.objectContaining({content:'附带文本'}));
    view.unmount();
  });

  it('shows native join records in the message table only after opening a join label',async()=>{
    const container:Relation={...makeRelation(),id:'join-container',relationType:'ARRANGE',sourceMessageId:null,targetRefs:[],payload:{title:'容器'}};
    const join:Relation={...makeRelation(),id:'visible-join',relationType:'JOIN',sourceMessageId:container.id,
      parts:[{id:'relation',type:'relation',relation:'member-of',roles:{parent:[{id:'parent',reference:{messageId:container.id}}],member:[{id:'member',reference:{messageId:'msg-1'}}]}},
        {id:'display',type:'display',relationPartId:'relation',target:{messageId:container.id},layout:'relation'}]};
    mockApi.getRelations.mockResolvedValue({data:[container,join]});
    const view=render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
    expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="visible-join"]')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'查看加入消息（1条）'}));await waitForWorkbenchIdle();
    expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="visible-join"]')).not.toBeNull();
  });

  it.each(['trace','view'])('opens every nested frame by default in %s and preserves subsequent manual choices',async mode=>{
    const members=Array.from({length:8},(_,index)=>makeMessage(`member-${index}`,`内部消息 ${index}`));
    const container=(id:string,type:string,targets:string[]):Relation=>({...makeRelation(),id,relationType:type,sourceMessageId:null,
      targetRefs:targets.map(messageId=>({kind:'message',messageId})),payload:{title:id}});
    mockApi.getMessages.mockResolvedValue({data:members});
    mockApi.getRelations.mockResolvedValue({data:[container('outer','CLASSIFY',['inner']),container('inner','SUMMARY',['arrangement']),
      container('arrangement','ARRANGE',members.map(message=>message.id))]});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>),latest=()=>mockGraphView.mock.lastCall![0];
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      latest().frameViewStateRef.current={main:{sizes:{outer:{width:480,height:180}},scrolls:{},full:{outer:false,inner:false},collapsed:['inner']}};
      if(mode==='view')await act(async()=>latest().onRelatedRelationView('outer'));
      else {
        await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'outer'));
        fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));
      }
      await waitForWorkbenchIdle();
      const panel=view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      expect(latest().traceExpandedFrameIds).toEqual(new Set(['outer','inner']));
      for(const id of ['outer','inner','arrangement']){
        expect(panel.querySelector(`[data-frame-visual="${id}"]`)).not.toBeNull();
        if(id!=='arrangement')expect(within(panel).getByRole('button',{name:`还原尺寸 ${id}`})).toHaveAttribute('aria-pressed','true');
      }
      expect(panel.querySelector('[data-frame-clip], [data-frame-scrollbar]')).toBeNull();
      expect(panel.querySelector('[data-msgid="member-0"]:not([data-rel-overlay])')).not.toBeNull();
      fireEvent.click(within(panel).getByRole('button',{name:'收起下方框架 inner'}));await waitForWorkbenchIdle();
      fireEvent.click(within(panel).getByRole('button',{name:'还原尺寸 outer'}));await waitForWorkbenchIdle();
      expect(within(panel).getByRole('button',{name:'展开下方框架 inner'})).toHaveAttribute('aria-expanded','false');
      expect(within(panel).getByRole('spinbutton',{name:'框架宽度 outer'})).toHaveValue(480);
      fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'切换为消息图'}));await waitForWorkbenchIdle();
      expect(within(panel).getByRole('button',{name:'完全展开 outer'})).toHaveAttribute('aria-pressed','false');
      expect(within(panel).getByRole('button',{name:'展开下方框架 inner'})).toHaveAttribute('aria-expanded','false');
      expect(panel.querySelector('[data-msgid="member-0"]:not([data-rel-overlay])')).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each([false,true])('fully opens a traced classification even with outside messages (outside: %s)',async outside=>{
    const category:Relation={...makeRelation(),id:'sole-category',relationType:'CLASSIFY',sourceMessageId:null,
      targetRefs:['first','second'].map(messageId=>({kind:'message',messageId}))};
    mockApi.getRelations.mockResolvedValue({data:[category]});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('first','内部一'),makeMessage('second','内部二'),makeMessage('outside','分类外消息')]});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
      await act(async()=>latest().onMessageClick(event(),'sole-category'));
      if(outside)await act(async()=>latest().onMessageClick(event(),'outside'));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      expect(latest().traceExpandedFrameIds.has('sole-category')).toBe(true);
      if(outside)expect(latest().messages.some((message:{id:string})=>message.id==='outside')).toBe(true);
      expect(view.container.querySelector('[data-frame-visual="sole-category"]')).not.toBeNull();
      expect(latest().messages.map((message:{id:string})=>message.id)).toEqual(expect.arrayContaining(['first','second']));
      expect(view.container.querySelector('[data-frame-scrollbar="sole-category"]')).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['CLASSIFY','SUMMARY'].flatMap(type=>['trace','preview'].map(source=>({type,source}))))('enters an expanded $type as a temporary category from $source and restores its position',async({type,source})=>{
    const category:Relation={...makeRelation(),id:'temporary-frame',relationType:type,sourceMessageId:null,payload:{title:'当前展开的框架'},
      targetRefs:['first','second'].map(messageId=>({kind:'message',messageId}))};
    mockApi.getRelations.mockResolvedValue({data:[category]});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('first','内部一'),makeMessage('second','内部二'),makeMessage('outside','分类外消息')]});
    const dimensions=[vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(6000),vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(500),
      vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockReturnValue(4000),vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(600)];
    const view=render(<MessageWorkbenchPage/>),latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),'first'));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      if(source==='preview'){await act(async()=>latest().onRelatedMessageNavigate('temporary-frame'));await waitForWorkbenchIdle();}
      const beforeIds=latest().messages.map((message:{id:string})=>message.id),expanded=[...latest().traceExpandedFrameIds];
      const left=view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      left.scrollTop=650;left.scrollLeft=120;
      const frameState={main:{sizes:{'temporary-frame':{width:480,height:220}},scrolls:{'temporary-frame':{left:40,top:180}}}};
      latest().frameViewStateRef.current=frameState;
      await act(async()=>latest().onFrameHeaderDoubleClick(event(),'temporary-frame'));await waitForWorkbenchIdle();
      expect(screen.getByRole('button',{name:'退出临时分类'}).parentElement).toHaveTextContent('当前展开的框架');
      expect(latest().messages.map((message:{id:string})=>message.id)).toContain('first');
      expect(latest().messages.map((message:{id:string})=>message.id)).not.toContain('outside');
      if(source==='trace')expect(latest().messages.map((message:{id:string})=>message.id)).not.toContain('second');
      expect(latest().messages.map((message:{id:string})=>message.id)).not.toContain('temporary-frame');
      fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
      if(source==='trace')expect(screen.getByRole('button',{name:'切换为消息表'})).toBeInTheDocument();
      else expect(latest().comparisonSingle).toBe(true);
      expect(latest().messages.map((message:{id:string})=>message.id)).toEqual(beforeIds);
      expect([...latest().traceExpandedFrameIds]).toEqual(expanded);
      expect(latest().frameViewStateRef.current).toEqual(frameState);
      await waitFor(()=>{expect(left.scrollTop).toBe(650);expect(left.scrollLeft).toBe(120);});
    }finally{view.unmount();dimensions.forEach(spy=>spy.mockRestore());}
  },15000);

  it('shows a newly sent member in a temporary frame category without admitting previously hidden peers',async()=>{
    localStorage.setItem('token','test-token');
    const category:Relation={...makeRelation(),id:'live-frame',relationType:'CLASSIFY',sourceMessageId:null,
      targetRefs:['first','second'].map(messageId=>({kind:'message',messageId}))};
    mockApi.getRelations.mockResolvedValue({data:[category]});
    mockApi.getMessages.mockResolvedValue({data:['first','second','outside'].map(id=>makeMessage(id,id))});
    const fresh:Message={...makeMessage('fresh','临时分类内的新消息'),revision:1,parts:[
      {id:'body',type:'text',text:'临时分类内的新消息'},
      {id:'placement',type:'relation',relation:'member-of',roles:{parent:[{id:'parent',reference:{messageId:'live-frame',revision:1,context:{kind:'MESSAGE'}}}]}}
    ]};
    mockApi.createMessage.mockImplementation(async()=>{
      mockApi.getMessages.mockResolvedValue({data:[...['first','second','outside'].map(id=>makeMessage(id,id)),fresh]});
      mockApi.getRelations.mockResolvedValue({data:[category,{...makeRelation(),id:'fresh-join',relationType:'JOIN',sourceMessageId:'live-frame',targetRefs:[{kind:'message',messageId:'fresh'}]}]});
      return fresh;
    });
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>),latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),'first'));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      fireEvent.doubleClick(screen.getByRole('group',{name:'组织消息 live-frame'}));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'清空'}));
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'),{target:{value:'临时分类内的新消息'}});
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createMessage).toHaveBeenCalledWith('live-frame',expect.anything()));
      act(()=>window.dispatchEvent(new Event('focus')));
      await waitFor(()=>expect(latest().messages.map((message:{id:string})=>message.id)).toContain('fresh'));
      expect(latest().messages.map((message:{id:string})=>message.id)).not.toContain('second');
      expect(latest().messages.map((message:{id:string})=>message.id)).not.toContain('outside');
      await waitForWorkbenchIdle();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['graph','list'] as const)('recomputes a sole classification message range when either trace distance grows or shrinks in %s',async mode=>{
    const latest=()=>mockGraphView.mock.lastCall?.[0],event=()=>({button:0,stopPropagation:vi.fn()});
    const category:Relation={...makeRelation(),id:'range-category',relationType:'CLASSIFY',sourceMessageId:null,
      targetRefs:['first','second'].map(messageId=>({kind:'message',messageId}))};
    const reference=(id:string,sourceMessageId:string,target:string):Relation=>({...makeRelation(),id,relationType:'REFERENCE',sourceMessageId,targetRefs:[{kind:'message',messageId:target}]});
    mockApi.getMessages.mockResolvedValue({data:['first','second','up-1','up-2','down-1','down-2'].map(id=>makeMessage(id,id))});
    mockApi.getRelations.mockResolvedValue({data:[category,reference('up-1-ref','first','up-1'),reference('up-2-ref','up-1','up-2'),
      reference('down-1-ref','down-1','first'),reference('down-2-ref','down-2','down-1')]});
    const view=render(<MessageWorkbenchPage/>);
    try{
      await waitFor(()=>expect(latest()?.messages.some((message:{id:string})=>message.id==='range-category')).toBe(true));
      await act(async()=>latest().onMessageClick(event(),'range-category'));
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      const ids=()=>mode==='graph'?latest().messages.map((message:{id:string})=>message.id):[...document.querySelectorAll('[data-workbench-left-panel] [data-msgid]')].map(element=>element.getAttribute('data-msgid'));
      for(const depths of [{up:0,down:0},{up:2,down:0},{up:1,down:0},{up:0,down:0},{up:0,down:2},{up:0,down:1},{up:0,down:0}]){
        fireEvent.change(screen.getByRole('spinbutton',{name:'向上追溯距离'}),{target:{value:depths.up}});
        fireEvent.change(screen.getByRole('spinbutton',{name:'向下追溯距离'}),{target:{value:depths.down}});
        await waitForWorkbenchIdle();
        await waitFor(()=>{
          expect(ids()).toEqual(expect.arrayContaining(['first','second']));
          for(const side of ['up','down'] as const)for(const depth of [1,2])expect(ids().includes(`${side}-${depth}`)).toBe(depth<=depths[side]);
        });
      }
    }finally{view.unmount();}
  });

  it('confirms current votes and annotations with one status-window read button',async()=>{
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    mockApi.getMessages.mockResolvedValue({data:[receivedMessage('auto-target','当前待阅消息')]});
    const records:Relation[]=['AGREE','DISAGREE','TAG','RECOMMEND','ARCHIVE','ATTENTION','BLOCK'].map(type=>({...receivedRelation(),
      id:`auto-${type}`,relationType:type,sourceMessageId:null,targetRefs:[{kind:'message',messageId:'auto-target'}],payload:type==='TAG'?{label:'可靠'}:{}}));
    mockApi.getRelations.mockResolvedValue({data:records});
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:/^显示提示 auto-target：/}));
      const automatic=screen.getByRole('region',{name:'消息阅读确认'}),individual=readingEffects();
      for(const label of ['赞同','反对','标注「可靠」','推荐','冷藏','关注','拉黑']){
        expect(individual).toHaveTextContent(label);
      }
      expect(screen.queryByRole('button',{name:'标记赞同影响已阅'})).toBeNull();
      fireEvent.click(within(automatic).getByRole('button',{name:'标记当前消息已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());
      const saved=mockApi.markReading.mock.calls[0][0];
      expect(saved.filter((mark:any)=>mark.scope==='message').map((mark:any)=>mark.messageId)).toEqual(['auto-target']);
      expect(new Set(saved.filter((mark:any)=>mark.scope==='influence').map((mark:any)=>JSON.parse(mark.eventId)[0]))).toEqual(new Set(records.map(record=>record.id)));
      await waitFor(()=>expect(document.querySelector('[data-display-hint="auto-target"]')).toHaveAttribute('data-reading-impact-count','0'));
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['REFERENCE'])('highlights the actual %s record when jumping to an unread influence',async type=>{
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const record:Relation={...receivedRelation(),id:'hint-record',relationType:type,sourceMessageId:type==='REFERENCE'?'hint-source':null,targetRefs:[{kind:'message',messageId:'hint-target'}]};
    mockApi.getMessages.mockResolvedValue({data:[receivedMessage('hint-source','来源正文'),receivedMessage('hint-target','目标正文')]});
    mockApi.getRelations.mockResolvedValue({data:[record]});
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const affected=type==='REFERENCE'?'hint-source':'hint-target';
      fireEvent.click(screen.getByRole('button',{name:new RegExp(`^显示提示 ${affected}：`)}));
      expandReadingEffects();fireEvent.click(within(screen.getByRole('tooltip')).getByTitle('查看引用 hint-record'));
      await waitForWorkbenchIdle();
      await waitFor(()=>expect(document.querySelector('[data-workbench-left-panel] [data-view-target="true"][data-msgid="hint-record"], [data-workbench-left-panel] [data-view-target="true"][data-jump-visual-msgids="hint-record"]')).not.toBeNull());
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="hint-source"][data-view-target="true"]:not([data-rel-overlay])')).toBeNull();
      expect(screen.queryByText('目标消息未能定位，请重试')).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it('shows drawing progress before a reference hint replaces the graph and waits for its slow layout and location', async () => {
    const { computeSceneLayout } = await import('../utils/frameLayout');
    const { planMessageStructures } = await import('../utils/messageStructurePlan');
    type Request = import('../hooks/useSceneComputation').SceneComputationRequest;
    const { createSceneRequestDecoder } = await import('../utils/sceneComputationTransport');
    let hold = false;
    const pending: Array<() => void> = [];
    class SceneWorker {
      decode = createSceneRequestDecoder();
      onmessage!: (event: MessageEvent) => void;
      terminated = false;
      postMessage(request: Request) {
        const job = this.decode(request);
        const deliver = () => {
          if (this.terminated) return;
          const result = job.kind === 'layout' ? computeSceneLayout(job.input) : planMessageStructures(job.input);
          this.onmessage({ data: { id: request.id, result } } as MessageEvent);
        };
        if (hold) pending.push(deliver); else queueMicrotask(deliver);
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', SceneWorker);
    graphRendering.actual = true;
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    mockApi.getMessages.mockResolvedValue({ data: [receivedMessage('hint-source', '来源正文'), receivedMessage('hint-target', '目标正文')] });
    mockApi.getRelations.mockResolvedValue({ data: [{ ...receivedRelation(), id: 'hint-record', relationType: 'REFERENCE', sourceMessageId: 'hint-source', targetRefs: [{ kind: 'message', messageId: 'hint-target' }] }] });
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: /^显示提示 hint-source：/ }));
      expandReadingEffects();
      vi.useFakeTimers(); hold = true;
      fireEvent.click(within(screen.getByRole('tooltip')).getByTitle('查看引用 hint-record'));
      expect(screen.getByRole('dialog', { name: '正在加载消息' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '退出查看' })).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(16); });
      expect(screen.queryByRole('button', { name: '退出查看' })).toBeNull();
      for (let frame = 0; frame < 5; frame++) await act(async () => { await vi.advanceTimersByTimeAsync(16); });
      expect(pending.length).toBeGreaterThan(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      // The pending worker may still own a structure-loading task. Both stages
      // must keep the progress barrier up until the target is actually laid out.
      expect(screen.getByRole('dialog', { name: /^正在(?:绘制|加载消息)$/ })).toBeInTheDocument();
      expect(document.querySelector('[data-message-jump-target="hint-record"]')).toBeNull();
      hold = false;
      await act(async () => { pending.splice(0).forEach(deliver => deliver()); });
      await waitForWorkbenchIdle();
      expect(document.querySelector('[data-workbench-progress-active]')).toBeNull();
      expect(document.querySelector('[data-message-jump-target="hint-record"]')).not.toBeNull();
      expect(screen.queryByText('目标消息未能定位，请重试')).toBeNull();
    } finally { view.unmount(); geometry.mockRestore(); graphRendering.actual = false; vi.unstubAllGlobals(); vi.useRealTimers(); }
  });

  it.each(['id','hint','first-hint'])('locates a visible correction in place from an id and opens its history from a hint (%s)',async entry=>{
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const corrections:Relation[]=['first-correction','unadopted-correction'].map((id,index)=>({...receivedRelation(),id,relationType:'CORRECT',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],createdAt:`2024-01-0${index+2}`,payload:{correctionBeforeContent:'原文',correctionAfterContent:`更正正文${index}`}}));
    const opposition:Relation={...makeRelation(),id:'oppose-correction',relationType:'DISAGREE',sourceMessageId:null,targetRefs:[{kind:'relation',relationId:'unadopted-correction'}]};
    mockApi.getMessages.mockResolvedValue({data:[receivedMessage('msg-1','原文')]});mockApi.getRelations.mockResolvedValue({data:[...corrections,opposition]});
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const expected=entry==='first-hint'?'first-correction':'unadopted-correction';
      const anchor=document.querySelector(`[data-workbench-left-panel] [data-msgid="${expected}"][data-rel-overlay]`);
      if(entry==='id'){
        expect(anchor).not.toBeNull();
        await jumpToMessageId(expected);
      }else{
        fireEvent.click(screen.getByRole('button',{name:/^显示提示 msg-1：/}));
        expandReadingEffects();fireEvent.click(within(screen.getByRole('tooltip')).getByTitle(`查看更正 ${expected}`));
      }
      if(entry!=='id')await waitFor(()=>expect(screen.getByText('更正记录临时分类（2）')).toBeInTheDocument());
      await waitFor(()=>expect(document.querySelector(`[data-message-jump-target="${expected}"]`)).not.toBeNull());
      await waitForWorkbenchIdle();
      if(entry==='id'){
        expect(screen.queryByText('更正记录临时分类（2）')).toBeNull();
        expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${expected}"][data-rel-overlay]`)).toBe(anchor);
        expect(screen.getByRole('button',{name:'切换为消息表'})).toBeInTheDocument();
      }else expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${expected}"]:not([data-rel-overlay])`)).not.toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it('opens the requested text from received JOIN targets instead of substituting its rejected classification',async()=>{
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const memberId='1a80df4f-9934-41f9-92c6-a8b40671ec87';
    const rel=(id:string,type:string,targets:string[],source:string|null=null):Relation=>({...makeRelation(),id,relationType:type,sourceMessageId:source,targetRefs:targets.map(messageId=>({kind:'message',messageId}))});
    const parent=rel('5ee3510d-0cb1-412e-9ce1-2091100a9544','CLASSIFY',[]);
    mockApi.getMessages.mockResolvedValue({data:[makeMessage(memberId,'测试移除容器功能')]});
    mockApi.getRelations.mockResolvedValue({data:[parent,rel('rejected','CLASSIFY',[]),rel('old-join','JOIN',[memberId],parent.id),
      {...rel('new-join','JOIN',[memberId],'rejected'),createdAt:'2024-01-02'},rel('opposition','DISAGREE',['rejected'])]});
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:new RegExp(`^显示提示 ${parent.id}：`)}));
      const expandRead=within(screen.getByRole('tooltip')).queryByRole('button',{name:/^展开已阅无新影响/});if(expandRead)fireEvent.click(expandRead);
      fireEvent.click(within(screen.getByRole('tooltip')).getByRole('button',{name:`查看被加入目标 ${memberId}`}));
      await waitForWorkbenchIdle();
      await waitFor(()=>expect(document.querySelector(`[data-message-jump-target="${memberId}"]`)).not.toBeNull());
      await waitFor(()=>expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${memberId}"][data-view-target="true"]`)).not.toBeNull());
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="rejected"][data-view-target="true"]:not([data-rel-overlay])')).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['none','provisional','initial','always'] as const)('locates the reference label in the same classification, using view mode only after a failed attempt (%s)', async failure => {
    localStorage.setItem('token','test-token');
    const categoryId='cmtgyl9ph00zz13qjjl7gqoc0',sourceId='cmsy54awp003lkysj9xatck1g',targetId='ead583e4-4e8a-4581-8960-92cc87935a9b';
    const sentId='44798120-67f9-4d6c-aba0-8853c27e245b';
    const peers=Array.from({length:65},(_,index)=>makeMessage(`peer-${index}`,`独立消息 ${index}`));
    const source:Message={...makeMessage(sourceId,'已有来源'),revision:1,parts:[
      {id:'text',type:'text',text:'已有来源'},
      {id:'old-placement',type:'relation',relation:'member-of',roles:{parent:[{id:'old-parent',reference:{messageId:'retired-category',revision:1,context:{kind:'MESSAGE'}}}]}}
    ]};
    const target=makeMessage(targetId,'测试引用对来源消息的推移');
    const category:Relation={...makeRelation(),id:categoryId,relationType:'CLASSIFY',sourceMessageId:null,
      targetRefs:[...peers,source,target].map(message=>({kind:'message',messageId:message.id}))};
    const reference:Relation={...makeRelation(),id:sentId,revision:1,relationType:'REFERENCE',sourceMessageId:sourceId,
      targetRefs:[{kind:'message',messageId:targetId}],parts:[{id:'reference',type:'relation',relation:'reference',roles:{
        source:[{id:'source',reference:{messageId:sourceId,revision:1,context:{kind:'MESSAGE'}}}],
        target:[{id:'target',reference:{messageId:targetId,revision:1,context:{kind:'MESSAGE'}}}]
      }}]};
    mockApi.getMessages.mockResolvedValue({data:[...peers,source,target]});
    mockApi.getRelations.mockResolvedValue({data:[category]});
    mockApi.createRelation.mockResolvedValueOnce(failure==='provisional'?{...reference,parts:[]}:reference);
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
      const isTarget=this.getAttribute('data-msgid')===sentId||this.getAttribute('data-jump-msgids')?.split(/\s+/).includes(sentId);
      if(isTarget&&(failure==='always'||failure==='initial'&&!this.hasAttribute('data-view-target')))
        return new DOMRect(0,120,0,0);
      return new DOMRect(0,120,600,400);
    });
    graphRendering.actual=true;
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
      await act(async()=>latest().onMessageDoubleClick(event(),categoryId));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),sourceId));
      fireEvent.click(screen.getByRole('button',{name:'加入来源集合'}));
      await act(async()=>latest().onMessageClick(event(),targetId));
      fireEvent.click(screen.getByRole('button',{name:'加入目标集合'}));
      fireEvent.click(screen.getByRole('button',{name:'引用'}));
      const fallbackLog=`进入追溯 message=${sentId}`;
      const fallbackCount=()=>document.body.textContent?.split(fallbackLog).length??0;
      const beforeFallbacks=fallbackCount();
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledOnce());
      if(failure==='always'){
        // Exhaust both the original positioning attempt and its fallback before asserting the result.
        await screen.findByRole('button',{name:'退出查看'},{timeout:10_000});
        await waitForWorkbenchIdle();
        expect(fallbackCount()).toBe(beforeFallbacks+1);
        expect(document.querySelector(`[data-message-jump-target="${sentId}"]`)).toBeNull();
      }
      else await waitFor(()=>expect(document.querySelector(`[data-message-jump-target="${sentId}"]`)).not.toBeNull(),{timeout:5000});
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('button',{name:'退出追溯'})).toBeNull();
      if(failure==='none'||failure==='provisional'){
        expect(screen.queryByRole('button',{name:'退出查看'})).toBeNull();
        expect(screen.getByRole('button',{name:'退出分类'})).toBeInTheDocument();
        expect(latest().traceExpandedFrameIds).toEqual(new Set());
      }else{
        expect(screen.getByRole('button',{name:'退出查看'})).toBeInTheDocument();
        expect(latest().traceExpandedFrameIds).toEqual(new Set([categoryId]));
      }
      expect(latest().lastClickedMessageId).toBe(sentId);
      expect(document.querySelector(`[data-message-jump-target="${sourceId}"]`)).toBeNull();
      expect(document.querySelector(`[data-message-jump-region~="${sourceId}"]`)).toBeNull();
      expect(latest().messages.some((message:{id:string})=>message.id===sentId)).toBe(true);
      expect(view.container.querySelector(`[data-directed-edge-label="${sentId}"]`)).not.toBeNull();
      expect(mockApi.getMessageContext).not.toHaveBeenCalled();
      if(failure!=='always')expect(screen.queryByText(/暂时未能完成定位|绘制超时|绘制或定位尚未完成/)).toBeNull();
      if(failure==='provisional'){
        expect(mockApi.markReading).not.toHaveBeenCalled();
        const published={...reference,sequence:9876};
        await act(async()=>window.dispatchEvent(new CustomEvent('gonglun:committed',{detail:[{
          scope:{messageId:'classification-1',title:'测试分类'},sequence:9876,
          messages:[{...makeMessage(sentId,''),kind:'RELATION',revision:1,sequence:9876,parts:published.parts,
            relationType:'REFERENCE',relSourceId:sourceId,targetRefs:published.targetRefs}],
          relations:[published],users:[],stakes:{},tagCounts:{},attentionUsers:{},
        }]})));
        await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());
        const marks=mockApi.markReading.mock.calls[0][0];
        expect(marks.some((mark:any)=>mark.scope==='message'&&mark.messageId===sentId)).toBe(true);
        const influences=marks.filter((mark:any)=>mark.scope==='influence'&&!mark.eventId.startsWith('selection:'));
        expect(influences.length).toBeGreaterThan(0);
        for(const mark of influences)expect(JSON.parse(mark.eventId)).toEqual([sentId,1,9876]);
      }
    }finally{view.unmount();graphRendering.actual=false;geometry.mockRestore();}
  },15000);

  it('falls back to a related view and locates the reference label after sending between closed classifications', async () => {
    localStorage.setItem('token','test-token');
    const relation=(id:string,type:string,targets:string[],source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,
      targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdAt:'2026-10-26',createdBy:makeUser()});
    const source={...makeMessage('source','已有来源'),createdBy:{...makeUser(),id:'other-author',username:'来源作者'}};
    const target=makeMessage('target','已有目标');
    mockApi.getMessages.mockResolvedValue({data:[source,target]});
    mockApi.getRelations.mockResolvedValue({data:[relation('A','CLASSIFY',['source']),relation('B','CLASSIFY',['target'])]});
    const sentId='44798120-67f9-4d6c-aba0-8853c27e245b';
    mockApi.createRelation.mockResolvedValueOnce(relation(sentId,'REFERENCE',['target'],'source'));
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;
    const view=render(<MessageWorkbenchPage/>);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
      await act(async()=>latest().onMessageDoubleClick(event(),'A'));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),'source'));
      fireEvent.click(screen.getByRole('button',{name:'加入来源集合'}));
      fireEvent.click(screen.getByRole('button',{name:'退出分类'}));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageDoubleClick(event(),'B'));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),'target'));
      fireEvent.click(screen.getByRole('button',{name:'加入目标集合'}));
      fireEvent.click(screen.getByRole('button',{name:'退出分类'}));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'引用'}));
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledOnce());
      await waitFor(()=>expect(document.querySelector(`[data-message-jump-target="${sentId}"]`)).not.toBeNull(),{timeout:5000});
      await waitForWorkbenchIdle();
      const panel=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      expect(screen.queryByRole('dialog',{name:'正在发送'})).toBeNull();
      expect(screen.queryByRole('button',{name:'退出追溯'})).toBeNull();
      expect(latest().comparisonSingle).toBe(false);expect(latest().comparisonPair).toBe(false);
      for(const id of ['A','B'])expect(panel.querySelector(`[data-msgid="${id}"]`)).not.toBeNull();
      expect(mockApi.getMessageContext).not.toHaveBeenCalled();
      const draft=screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）');
      fireEvent.change(draft,{target:{value:'继续发言'}});
      expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
      fireEvent.change(draft,{target:{value:''}});
      expect(screen.getByRole('button',{name:'退出查看'})).toBeInTheDocument();
      expect(latest().traceExpandedFrameIds).toEqual(new Set(['A','B']));
      for(const id of ['source','target'])expect(panel.querySelector(`[data-msgid="${id}"]`)).not.toBeNull();
      expect(panel.querySelector(`[data-msgid="${sentId}"]`)).toHaveAttribute('data-view-target','true');
      expect(panel).toHaveTextContent('引用');expect(panel.querySelector(`[data-edge-label-arrow="${sentId}"]`)).toBeNull();
      expect(panel.querySelector(`[data-edge-label-arrow-slot="${sentId}"]`)).toBeNull();
      expect(panel).not.toHaveTextContent(/引用\s+(tester|来源作者)/);
      expect(mockApi.createMessage).not.toHaveBeenCalled();
    } finally {view.unmount();graphRendering.actual=false;geometry.mockRestore();}
  });

  it.each(['view','trace'].flatMap(mode=>['graph','list'].map(layout=>({mode,layout}))))('keeps a text anchor marked after repeated double clicks in $mode $layout until exit',async({mode,layout})=>{
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
      if(mode==='view')await act(async()=>latest().onRelatedRelationView('msg-1'));
      else{
        await act(async()=>latest().onMessageClick(event(),'msg-1'));
        fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));
      }
      await waitForWorkbenchIdle();
      if(layout==='list'){fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();}
      const card=()=>document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="msg-1"]:not([data-rel-overlay])')!;
      expect(card()).toHaveAttribute('data-view-target','true');
      for(let click=0;click<2;click++){
        fireEvent.doubleClick(card());
        await act(async()=>{});
        expect(card()).toHaveAttribute('data-view-target','true');
      }
      fireEvent.click(screen.getByRole('button',{name:mode==='view'?'退出查看':'退出追溯'}));
      await waitForWorkbenchIdle();
      expect(document.querySelector('[data-view-target="true"]')).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE'])('locates the new opposition after the first %s rejection',async type=>{
    localStorage.setItem('token','test-token');graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const category:Relation={...makeRelation(),id:'798cd57a-efa5-40e6-9ee3-adf8606855bf',relationType:type,sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],payload:{title:'首次反对的容器'}};
    mockApi.getRelations.mockResolvedValue({data:[category]});
    mockApi.createRelation.mockImplementation(async(_scope,data)=>({...makeRelation(),...data,id:'first-opposition'}));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await waitForWorkbenchIdle();
      await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},category.id));
      fireEvent.click(screen.getByRole('button',{name:'反对'}));
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(screen.getByText('已定位目标消息')).toBeInTheDocument());
      await waitForWorkbenchIdle();
      expect(document.querySelector('[data-workbench-left-panel] [data-jump-msgids~="first-opposition"], [data-workbench-left-panel] [data-msgid="first-opposition"]')).not.toBeNull();
      expect(mockApi.createRelation).toHaveBeenCalledOnce();
      expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1',expect.objectContaining({relationType:'DISAGREE',
        targetRefs:[expect.objectContaining({reference:{messageId:category.id,context:{kind:'MESSAGE'}}})]}));
      expect(screen.queryByRole('dialog',{name:'正在发送'})).toBeNull();
      expect(graphRendering.tasks!.pending).toBe(0);
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
      expect(screen.queryByText(/绘制超时|绘制或定位尚未完成/)).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each([['CLASSIFY','分类'],['SUMMARY','总结'],['ARRANGE','排列'],['MERGE','归并']])('locates the existing %s container after sending JOIN from another scope',async(type,label)=>{
    localStorage.setItem('token','test-token');
    const container:Relation={...makeRelation(),id:'destination-container',relationType:type,sourceMessageId:null,targetRefs:[],payload:{title:`已有${label}`}};
    const outer:Relation={...container,id:'enclosing-category',relationType:'CLASSIFY',targetRefs:[{kind:'relation',relationId:container.id}],payload:{title:'容器的外层分类'}};
    mockApi.getRelations.mockResolvedValue({data:[container,outer]});
    mockApi.createRelation.mockImplementation(async(_scope,data)=>({...makeRelation(),...data,id:'new-container-join'}));
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
      await act(async()=>latest().onMessageDoubleClick(event(),outer.id));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),container.id));
      fireEvent.click(screen.getByRole('button',{name:'加入来源集合'}));
      fireEvent.click(screen.getByRole('button',{name:'退出分类'}));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),'msg-2'));
      fireEvent.click(screen.getByRole('button',{name:label}));
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledOnce());await waitForWorkbenchIdle();
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="destination-container"]')).not.toBeNull();
      expect(screen.getByText('已定位目标消息')).toBeInTheDocument();
      expect(screen.queryByRole('dialog',{name:'正在发送'})).toBeNull();
      expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1',expect.objectContaining({relationType:'JOIN',sourceMessageId:container.id}));
      expect(mockApi.createMessage).not.toHaveBeenCalled();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it('shares one staging area and source/target collections when entering, editing and exiting trace', async () => {
    render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
    await act(async()=>latest().onMessageClick(event(),'msg-1'));
    fireEvent.click(screen.getByRole('button',{name:'加入来源集合'}));
    await act(async()=>latest().onMessageClick(event(),'msg-2'));
    fireEvent.click(screen.getByRole('button',{name:'加入目标集合'}));
    await act(async()=>latest().onMessageClick(event(),makeRelation().id));
    fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
    expect(screen.getByRole('button',{name:/^来源消息/})).toHaveTextContent('msg-1');
    expect(screen.getByRole('button',{name:/^目标消息/})).toHaveTextContent('msg-2');
    fireEvent.click(screen.getByRole('button',{name:'清空'}));
    expect(latest().draftUnits).toEqual([]);
    fireEvent.click(screen.getByRole('button',{name:'退出追溯'}));await waitForWorkbenchIdle();
    expect(latest().draftUnits).toEqual([]);
    expect(screen.getByRole('button',{name:/^来源消息/})).toHaveTextContent('msg-1');
    expect(screen.getByRole('button',{name:/^目标消息/})).toHaveTextContent('msg-2');
    expect(mockApi.createRelation).not.toHaveBeenCalled();
  });

  it('retains a manually collapsed enclosing frame when returning from a nested trace', async () => {
    mockApi.getRelations.mockResolvedValue({data:[makeRelation(),{...makeRelation(),id:'outer',relationType:'CLASSIFY',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],payload:{title:'外层分类'}}]});
    render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
    const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
    await act(async()=>latest().onMessageDoubleClick(event(),'outer'));await waitForWorkbenchIdle();
    await act(async()=>latest().onMessageClick(event(),'msg-1'));
    fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
    expect(latest().traceExpandedFrameIds.has('outer')).toBe(true);
    await act(async()=>latest().onMessageDoubleClick(event(),'outer'));await waitForWorkbenchIdle();
    expect(latest().traceExpandedFrameIds.has('outer')).toBe(false);
    await act(async()=>latest().onJoinFilterClick('msg-1','incoming'));
    fireEvent.click(screen.getByRole('button',{name:'清空'}));
    await act(async()=>latest().onMessageClick(event(),'msg-2'));
    fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
    fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
    expectTraceOrigin('msg-1');
    expect(latest().traceExpandedFrameIds.has('outer')).toBe(false);
  });

  it.each(['graph','list'])('updates body authors and keeps each sender investment separate through version switching in %s',async mode=>{
    localStorage.setItem('token','test-token');
    const original:Message={...makeMessage('msg-1','开头旧字结尾'),revision:1,parts:[{id:'body',type:'text',text:'开头旧字结尾'}],spending:{protocol:1,wager:2,recommendation:3}};
    const correction:Relation={...makeRelation(),id:'author-correction',relationType:'CORRECT',sourceMessageId:null,
      createdBy:{id:'bob',username:'bob',createdAt:''},spending:{protocol:1,wager:5,recommendation:7},
      targetRefs:[{kind:'text-fragment',messageId:'msg-1',text:'旧字',hash:'fragment',reference:{messageId:'msg-1',revision:1,partId:'body',range:{start:2,end:4}}}],
      payload:{correctionBeforeContent:'开头旧字结尾',correctionAfterContent:'开头新字结尾'}};
    mockApi.getMessages.mockResolvedValue({data:[original]});mockApi.getRelations.mockResolvedValue({data:[correction]});
    const snapshotLoader=mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    mockApi.getWorkbenchSnapshot.mockResolvedValue({scope:{messageId:'classification-1',title:'测试分类'},
      messages:[original,{...makeMessage(correction.id,''),kind:'RELATION',createdBy:correction.createdBy,spending:correction.spending,relationType:'CORRECT',targetRefs:correction.targetRefs,relationPayload:correction.payload}],
      relations:[correction],users:[makeUser(),correction.createdBy],stakes:{},tagCounts:{},attentionUsers:{},sequence:1,nextCursor:null,hasMore:false});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();
      const card=()=>view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="msg-1"]')!;
      expect(card()).toHaveTextContent('开头新字结尾');
      expect(card().querySelector('[data-message-authors],time')).toBeNull();
      fireEvent.click(within(card()).getByRole('button',{name:/^显示提示 msg-1：/}));
      const info=()=>screen.getByRole('region',{name:'消息信息'});
      expect(info().querySelector('[data-message-self-stake="msg-1"]')).toHaveTextContent('自押 2/3');
      const authors=within(info()).getByRole('button',{name:/当前正文作者：tester，共 2 人/});
      fireEvent.wheel(authors,{deltaY:100});
      expect(authors).toHaveAccessibleName(/当前正文作者：bob，共 2 人/);
      expect(info().querySelector('[data-message-self-stake="msg-1"]')).toHaveTextContent('自押 5/7');
      fireEvent.wheel(authors,{deltaY:-100});
      expect(info().querySelector('[data-message-self-stake="msg-1"]')).toHaveTextContent('自押 2/3');
      fireEvent.click(authors);
      const dialog=screen.getByRole('dialog',{name:'消息 msg-1 的当前正文作者'});
      expect(dialog.querySelector('[data-author-contribution="author-correction"]')).toHaveTextContent('自押 5/7');
      expect(dialog).not.toHaveTextContent('开头');expect(dialog).not.toHaveTextContent('新字');
      mockApi.getMessageStakes.mockResolvedValueOnce({messageId:'msg-1',pool:{lockedPro:0,lockedCon:0},counts:{pro:6,con:0},
        countsByType:{TRUTH:{pro:6,con:0},VALUE:{pro:4,con:0}},stakes:[
          {id:'initial',side:'PRO',settlementType:'TRUTH',amount:2,user:makeUser(),createdAt:''},
          {id:'later-truth',side:'PRO',settlementType:'TRUTH',amount:4,user:makeUser(),createdAt:''},
          {id:'later-value',side:'PRO',settlementType:'VALUE',amount:4,user:makeUser(),createdAt:''},
        ]});
      act(()=>window.dispatchEvent(new CustomEvent('stakes-refresh',{detail:{messageId:'msg-1'}})));
      await waitFor(()=>expect(dialog.querySelector('[data-author-contribution="msg-1"]')).toHaveTextContent('自押 6/7'));await waitForWorkbenchIdle();
      expect(info().querySelector('[data-message-self-stake="msg-1"]')).toHaveTextContent('自押 6/7');
      expect(dialog.querySelector('[data-author-contribution="msg-1"]')).toHaveTextContent('首次 2/3 · 追加 4/4');
      fireEvent.click(within(dialog).getByRole('button',{name:'关闭作者详情'}));
      fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));fireEvent.click(screen.getByRole('radio',{name:'原文'}));await waitForWorkbenchIdle();
      fireEvent.click(within(card()).getByRole('button',{name:/^显示提示 msg-1：/}));
      expect(within(info()).getByRole('button',{name:'查看消息 msg-1 的当前正文作者：tester'})).toBeInTheDocument();
      expect(card()).toHaveTextContent('开头旧字结尾');
      fireEvent.click(screen.getByRole('button',{name:'关闭消息提示'}));
      if(!screen.queryByRole('radio',{name:'推荐选择'}))fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));
      fireEvent.click(screen.getByRole('radio',{name:'推荐选择'}));await waitForWorkbenchIdle();
      fireEvent.click(within(card()).getByRole('button',{name:/^显示提示 msg-1：/}));
      expect(within(info()).getByRole('button',{name:/当前正文作者：tester，共 2 人/})).toBeInTheDocument();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.markReading).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;mockApi.getWorkbenchSnapshot.mockImplementation(snapshotLoader);}
  },15000);

  it('does not offer version back or forward when viewing a correction that already supplies the displayed body',async()=>{
    localStorage.setItem('token','test-token');mockApi.getMessages.mockResolvedValue({data:[makeMessage('msg-1','原文')]});
    mockApi.getRelations.mockResolvedValue({data:[{...makeRelation(),id:'same-correction',relationType:'CORRECT',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],payload:{correctionBeforeContent:'原文',correctionAfterContent:'当前更正正文'}}]});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const card=()=>view.container.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')!;
      expect(card()).toHaveTextContent('当前更正正文');
      fireEvent.doubleClick(view.container.querySelector('[data-workbench-left-panel] [data-jump-msgids~="same-correction"]')!);await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:/^查看消息 same-correction：/}));await waitForWorkbenchIdle();
      expect(screen.getByText('更正记录临时分类（1）')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('当前更正正文');
      fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));
      expect(screen.queryByRole('button',{name:'版本后退 msg-1'})).toBeNull();expect(screen.queryByRole('button',{name:'版本前进 msg-1'})).toBeNull();
      expect(screen.getByRole('button',{name:'切换消息 msg-1 的版本'})).toHaveAttribute('data-reading-version-override','false');
      expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.markReading).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);

  it('keeps arbitration on correction history records without extra stance or expression disclosures',async()=>{
    localStorage.setItem('token','test-token');mockApi.getMessages.mockResolvedValue({data:[makeMessage('msg-1','原文')]});
    const relation=(id:string,type:string,target:string,author:string):Relation=>({...makeRelation(),id,relationType:type,sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:target}],createdBy:{id:author,username:author,createdAt:''}});
    mockApi.getRelations.mockResolvedValue({data:[
      {...relation('correction-one','CORRECT','msg-1','作者甲'),payload:{correctionBeforeContent:'原文',correctionAfterContent:'更正正文'}},
      relation('foreign-stance','DISAGREE','correction-one','用户乙'),
      {...relation('expression','TAG','correction-one','用户丙'),payload:{label:'重要'}},
    ]});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));
      expect(screen.getByRole('dialog')).toHaveTextContent('当前用户尚未选择');expect(screen.getByRole('dialog')).not.toHaveTextContent('当前用户选择');
      fireEvent.click(screen.getByRole('button',{name:'关闭版本选择'}));
      expect(screen.queryByRole('button',{name:'显示装饰 correction-one'})).toBeNull();
      fireEvent.doubleClick(view.container.querySelector('[data-workbench-left-panel] [data-jump-msgids~="correction-one"]')!);
      await waitForWorkbenchIdle();expect(screen.getByText('更正记录临时分类（1）')).toBeInTheDocument();
      expect(screen.queryByRole('button',{name:'查看消息 correction-one 的站队'})).toBeNull();
      expect(screen.queryByRole('button',{name:'查看消息 correction-one 的表态'})).toBeNull();
      const record=view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="correction-one"]')!;
      expect(within(record).getByTitle('真假仲裁')).toBeInTheDocument();
      expect(within(record).getByTitle('价值仲裁')).toBeInTheDocument();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();expect(mockApi.markReading).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);

  it('previews and sends a width correction from the attachment before text correction', async () => {
    localStorage.setItem('token', 'test-token');
    mockApi.getRelations.mockResolvedValue({ data: [] });
    mockApi.createRelation.mockImplementationOnce(async (_scope, input) => ({ ...makeRelation(), ...input,
      id: 'width-correction', sourceMessageId: null, payload: input.payload,
      parts: [{ id: 'relation', type: 'relation', relation: 'correct', roles: { target: [{ id: 'target', reference: { messageId: 'msg-1' } }] } },
        { id: 'data', type: 'data', value: input.payload }] }));
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）'); await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: /^更正$/ }));
      const widthOption = screen.getByRole('button', { name: '宽度调整' });
      expect(widthOption.compareDocumentPosition(screen.getByRole('button', { name: '修正文字' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.click(widthOption);
      const card = () => view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="msg-1"]:not([data-rel-overlay])')!;
      fireEvent.click(card());
      await waitFor(() => expect(screen.getByRole('separator', { name: '调整消息 msg-1 的宽度' })).toBeInTheDocument());
      fireEvent.change(screen.getByRole('spinbutton', { name: '消息卡宽度' }), { target: { value: '640' } });
      await waitFor(() => expect(card().style.width).toBe('640px'));
      fireEvent.keyDown(screen.getByRole('separator', { name: '调整消息 msg-1 的宽度' }), { key: 'ArrowRight' });
      await waitFor(() => expect(card().style.width).toBe('650px'));
      expect(card()).toHaveTextContent('第一条');
      expect(mockApi.createRelation).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledOnce());
      expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1', expect.objectContaining({
        relationType: 'CORRECT', sourceMessageId: null, targetRefs: [expect.objectContaining({ kind: 'message', messageId: 'msg-1', reference: { messageId: 'msg-1' } })],
        payload: { correctionKind: 'WIDTH', correctionWidth: 650 },
      }));
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      await waitForWorkbenchIdle();
      expect(card().style.width).toBe('650px');
      expect(card()).toHaveTextContent('第一条');
      expect(screen.queryByRole('separator', { name: '调整消息 msg-1 的宽度' })).toBeNull();
    } finally { view.unmount(); graphRendering.actual = false; }
  });

  it.each(['graph','list'])('keeps status hints in place in %s without navigating, sending or marking read',async mode=>{
    localStorage.setItem('token','test-token');
    mockApi.getMessages.mockResolvedValue({data:[{...makeMessage('msg-1','未读正文'),createdBy:{id:'bob',username:'bob',createdAt:''}},makeMessage('msg-2','本人正文')]});
    mockApi.getRelations.mockResolvedValue({data:[]});
    graphRendering.actual=true;
    const view=render(<MessageWorkbenchPage/>);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      await waitForWorkbenchIdle();
      const marker=await screen.findByRole('button',{name:/显示提示 msg-1：消息待阅/});
      const card=marker.closest('[data-msgid="msg-1"]')!;
      expect(card.getAttribute('aria-label')).toContain('未选中');
      fireEvent.mouseDown(marker);fireEvent.click(marker);
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('dialog',{name:'显示提示与差别'})).toBeNull();
      expect(card.getAttribute('aria-label')).toContain('未选中');
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
      expect(mockApi.castVote).not.toHaveBeenCalled();
      expect(await screen.findByRole('button',{name:/显示提示 msg-1：消息待阅/})).toBeInTheDocument();
      expect(screen.getByRole('button',{name:mode==='graph'?'切换为消息表':'切换为消息图'})).toBeInTheDocument();
    } finally {view.unmount();graphRendering.actual=false;}
  });

  it.each(['graph','list'])('returns from an influence to the pinned hint and its saved scroll positions in %s',async mode=>{
    localStorage.setItem('token','test-token');
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('msg-1','目标正文'),makeMessage('msg-2','其他正文')]});
    mockApi.getRelations.mockResolvedValue({data:Array.from({length:12},(_,index)=>({...makeRelation(),id:`hint-impact-${index}`,sourceMessageId:null,
      relationType:'REPLY',targetRefs:[{kind:'message',messageId:'msg-1'}],createdBy:{id:'bob',username:'bob',createdAt:''}}))});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:/显示提示 msg-1：/}));
      const tooltip=screen.getByRole('tooltip'),list=tooltip.querySelector<HTMLElement>('[data-display-hint-influences]')!;
      const retained=view.container.querySelector('[data-workbench-left-panel] [data-workbench-view-cache]')?.firstElementChild;
      tooltip.scrollTop=24;list.scrollTop=106;fireEvent.scroll(list);
      expandReadingEffects();fireEvent.click(within(tooltip).getByRole('button',{name:'回复 · hint-impact-5'}));
      await waitFor(()=>expect(screen.getByRole('button',{name:'返回'})).toBeEnabled());
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('tooltip')).toBeNull();
      await moveBrowserHistory(-1,'返回');
      await waitForWorkbenchIdle();
      const restored=await screen.findByRole('tooltip');
      expect(view.container.querySelector('[data-workbench-left-panel] [data-workbench-view-cache]')?.firstElementChild).toBe(retained);
      expect(restored).toHaveTextContent('未阅影响（12 条）');
      expect(restored.scrollTop).toBe(24);expect(restored.querySelector('[data-display-hint-influences]')!.scrollTop).toBe(106);
      expect(screen.getByRole('button',{name:mode==='graph'?'切换为消息表':'切换为消息图'})).toBeInTheDocument();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);
  it.each(['graph','list'])('updates retained views with synchronized messages and influences after returning in %s',async mode=>{
    localStorage.setItem('token','test-token');
    const originalSnapshot=mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    let sequence=1;
    mockApi.getWorkbenchSnapshot.mockImplementation(async(...args)=>({...await originalSnapshot(...args),sequence}));
    const initial=receivedMessage('live-target','原有正文'),reply={...receivedRelation(),id:'live-reply',relationType:'REPLY',sourceMessageId:null,targetRefs:[{kind:'message' as const,messageId:'live-target'}]};
    mockApi.getMessages.mockResolvedValue({data:[initial]});mockApi.getRelations.mockResolvedValue({data:[reply]});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      const left=view.container.querySelector('[data-workbench-left-panel]')!;
      await waitFor(()=>expect(left.querySelector('[data-msgid="live-target"]')).not.toBeNull());
      const retained=left.querySelector('[data-workbench-view-cache]')!.firstElementChild;
      fireEvent.click(screen.getByRole('button',{name:/^显示提示 live-target：/}));expandReadingEffects();
      fireEvent.click(screen.getByTitle('查看回复 live-reply'));await waitForWorkbenchIdle();
      const added=receivedMessage('live-new','同步收到的新正文');
      mockApi.getMessages.mockResolvedValue({data:[initial,added]});
      mockApi.getRelations.mockResolvedValue({data:[reply,{...receivedRelation(),id:'live-vote',relationType:'AGREE',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'live-target'}]}]});
      sequence++;
      const stream=mockApi.subscribeChanges.mock.results.at(-1)?.value as unknown as EventSource;
      await act(async()=>{stream.onmessage?.(new MessageEvent('message'));});
      await waitFor(()=>expect(view.container.querySelector('.workbench-right-panel')).toHaveTextContent('新增 1 条'));
      await moveBrowserHistory(-1,'返回');await waitForWorkbenchIdle();
      await waitFor(()=>expect(left.querySelector('[data-msgid="live-new"]')).toHaveTextContent('同步收到的新正文'));
      expect(left.querySelector('[data-workbench-view-cache]')!.firstElementChild).toBe(retained);
      expect(screen.getByRole('button',{name:/^显示提示 live-target：/})).toHaveAttribute('data-reading-impact-count','2');
    }finally{view.unmount();graphRendering.actual=false;mockApi.getWorkbenchSnapshot.mockImplementation(originalSnapshot);}
  },15000);
  it.each(['graph','list'])('switches corrected versions in place with back/forward without reading prerequisites in %s',async mode=>{
    localStorage.setItem('token','test-token');
    mockApi.getMessages.mockResolvedValue({data:[receivedMessage('msg-1','版本测试原文')]});
    mockApi.getRelations.mockResolvedValue({data:[
      {...receivedRelation(),id:'version-1',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'msg-1'}],
        createdAt:'2026-10-21T00:00:00Z',payload:{correctionBeforeContent:'版本测试原文',correctionAfterContent:'版本测试更正一'}},
      {...receivedRelation(),id:'version-2',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'msg-1'}],
        createdAt:'2026-10-22T00:00:00Z',state:{messageId:'version-2',revision:1,suppressed:false,supportCount:3,oppositionCount:0,recommendationTotal:0},payload:{correctionBeforeContent:'版本测试原文',correctionAfterContent:'版本测试更正二'}},
      {...makeRelation(),id:'version-choice',relationType:'AGREE',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'version-1'}],createdAt:'2026-10-23T00:00:00Z',payload:{}},
      ...Array.from({length:3},(_,index)=>({...makeRelation(),id:`public-choice-${index}`,relationType:'AGREE',sourceMessageId:null,targetRefs:[{kind:'message' as const,messageId:'version-2'}],createdBy:{id:`voter-${index}`,username:`voter-${index}`,createdAt:''},payload:{}})),
    ]});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    const card=()=>view.container.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')!;
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正一');
      expect(card().querySelector('[data-display-hint-scope="corrections"]')).toBeNull();
      fireEvent.click(screen.getByRole('button',{name:/^显示提示 msg-1：/}));
      expect(screen.getByRole('button',{name:'标记当前消息已阅'})).toBeEnabled();
      fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());await waitForWorkbenchIdle();
      expect(mockApi.markReading.mock.calls[0][0].filter((mark:any)=>mark.scope==='message').map((mark:any)=>mark.messageId)).toEqual(['msg-1']);
      const defaultCard=card();
      fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));fireEvent.click(screen.getByRole('radio',{name:'原文'}));
      await waitForWorkbenchIdle();expect(card()).toHaveTextContent('版本测试原文');
      fireEvent.click(screen.getByRole('button',{name:'版本后退 msg-1'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正一');
      expect(card()).toBe(defaultCard);
      const versionClose=screen.queryByRole('button',{name:'关闭版本选择'});if(versionClose)fireEvent.click(versionClose);
      fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));
      expect(screen.getAllByRole('radio')).toHaveLength(3);
      fireEvent.click(screen.getByRole('radio',{name:'推荐选择'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正二');expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('推荐选择');
      const recommendedCard=card();
      fireEvent.click(screen.getByRole('button',{name:'版本后退 msg-1'}));await waitForWorkbenchIdle();expect(card()).toHaveTextContent('版本测试更正一');
      fireEvent.click(screen.getByRole('button',{name:'版本前进 msg-1'}));await waitForWorkbenchIdle();expect(card()).toHaveTextContent('版本测试更正二');
      expect(card()).toBe(recommendedCard);
      expect(mockNavigate).not.toHaveBeenCalled();expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
      const marker=()=>screen.getByRole('button',{name:'切换消息 msg-1 的版本'});
      expect(marker()).toHaveAttribute('data-reading-version-override','true');
      fireEvent.click(screen.getByRole('button',{name:'恢复默认显示 msg-1'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正一');expect(marker()).toHaveAttribute('data-reading-version-override','false');
      expect(card()).toBe(defaultCard);
      fireEvent.click(screen.getByRole('button',{name:'关闭版本选择'}));
      const newChoice:Relation={...makeRelation(),id:'new-own-choice',relationType:'AGREE',sourceMessageId:null,
        targetRefs:[{kind:'message',messageId:'version-2'}],createdAt:'2026-10-24T00:00:00Z',payload:{}};
      mockApi.createRelation.mockResolvedValueOnce(newChoice);
      await act(async()=>{mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},'version-2');});
      fireEvent.click(screen.getByRole('button',{name:'赞同'}));fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledOnce());await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正二');expect(marker()).toHaveAttribute('data-reading-version-override','false');
      fireEvent.click(marker());
      expect(screen.getAllByRole('radio')).toHaveLength(3);
      expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('与当前用户选择相同');
      fireEvent.click(screen.getByRole('radio',{name:'原文'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试原文');expect(marker()).toHaveAttribute('data-reading-version-override','true');
      fireEvent.click(screen.getByRole('button',{name:'恢复默认显示 msg-1'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正二');expect(marker()).toHaveAttribute('data-reading-version-override','false');
      expect(mockNavigate).not.toHaveBeenCalled();expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);
  it.each(['CLASSIFY','SUMMARY'].flatMap(type=>['graph','list'].map(mode=>({type,mode}))))('retains corrected $type through message type filtering in $mode',async({type,mode})=>{
    localStorage.setItem('token','test-token');
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('msg-1','无关正文')]});
    mockApi.getRelations.mockResolvedValue({data:[
      {...makeRelation(),id:'filter-body',relationType:type,sourceMessageId:null,targetRefs:[],payload:{title:'过滤正文',independentMemberships:true}},
      {...makeRelation(),id:'filter-correction',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'filter-body'}],
        createdAt:'2026-10-22T00:00:00Z',payload:{correctionBeforeContent:'过滤正文',correctionAfterContent:'过滤更正后'}},
    ]});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'过滤'}));fireEvent.click(screen.getByRole('button',{name:'按消息类型'}));
      fireEvent.click(screen.getByRole('checkbox',{name:'文本'}));
      fireEvent.click(screen.getByRole('checkbox',{name:'更正'}));
      const editor=screen.getByText('消息类型（可多选）：').parentElement!;
      fireEvent.click(within(editor).getByRole('button',{name:'确认'}));await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="filter-body"]')).toHaveTextContent('过滤更正后');
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')).toBeNull();
      expect(screen.getByText(/^显示 2 条/)).toBeInTheDocument();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);
  it.each(['graph','list'])('confirms reading privately from the hint in %s without sending a message',async mode=>{
    localStorage.setItem('token','test-token');
    mockApi.getMessages.mockResolvedValue({data:[{...makeMessage('msg-1','待阅正文'),createdBy:{id:'bob',username:'bob',createdAt:''}},makeMessage('msg-2','本人正文')]});
    mockApi.getRelations.mockResolvedValue({data:[{...makeRelation(),id:'earlier-reply',createdAt:'2026-10-23T00:00:00.000Z',createdBy:{id:'bob',username:'bob',createdAt:''}}]});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:/显示提示 msg-1：消息待阅/}));
      fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());
      expect(mockApi.markReading.mock.calls[0][0]).toContainEqual(expect.objectContaining({messageId:'msg-1',scope:'message',signature:expect.stringMatching(/^display:1:/),bodySignature:expect.stringMatching(/^message:3:/)}));
      await waitFor(()=>expect(screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/})).toHaveAttribute('data-display-reading','read'));
      const marker=screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/});fireEvent.click(marker);
      expect(screen.getByRole('tooltip')).not.toHaveTextContent('条影响待阅');
      expect(screen.getByRole('tooltip')).toHaveTextContent('earlier-reply');
      expect(screen.queryByRole('button',{name:/标记回复 earlier-reply 已阅/})).toBeNull();
      expandReadingEffects();fireEvent.click(screen.getByRole('button',{name:/ · earlier-reply$/}));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:/^显示提示 earlier-reply：/}));
      fireEvent.click(within(screen.getByRole('tooltip')).getByRole('button',{name:'标记当前消息已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledTimes(2));
      await waitFor(()=>expect(within(screen.getByRole('tooltip')).getByRole('button',{name:'当前消息已阅'})).toBeDisabled());
      fireEvent.click(screen.getByRole('button',{name:'退出查看'}));await waitForWorkbenchIdle();
      await waitFor(()=>expect(screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/})).toHaveAttribute('data-display-reading','read'));
      fireEvent.click(screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/}));
      expect(readingEffects()).toHaveTextContent('影响已阅');
      expect(screen.getByRole('button',{name:'当前消息已阅'})).toBeDisabled();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
      fireEvent.pointerDown(document.body);
      fireEvent.click(view.container.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')!);
      fireEvent.click(screen.getByRole('button',{name:'标注'}));
      expect(screen.queryByRole('button',{name:'已读'})).toBeNull();expect(screen.queryByRole('button',{name:'未读'})).toBeNull();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);
  it.each(['CLASSIFY','SUMMARY'].flatMap(type=>['graph','list'].map(mode=>({type,mode}))))('confirms a single JOIN privately inside $type in $mode without an extra container read',async({type,mode})=>{
    localStorage.setItem('token','test-token');
    mockApi.getMessages.mockResolvedValue({data:[receivedMessage('msg-1','当前成员'),receivedMessage('msg-2','仍待阅的成员')]});
    mockApi.getRelations.mockResolvedValue({data:[
      {...makeRelation(),id:'classification-1',relationType:type,sourceMessageId:null,targetRefs:[{kind:'message',messageId:'msg-1'},{kind:'message',messageId:'msg-2'}],payload:{title:'当前容器'}},
      {...receivedRelation(),id:'current-join',relationType:'JOIN',sourceMessageId:'classification-1',targetRefs:[{kind:'message',messageId:'msg-1'}]},
    ]});
    graphRendering.actual=true;const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(mode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      await waitForWorkbenchIdle();
      if(!screen.queryByRole('button',{name:/显示提示 msg-1：消息待阅/})){
        fireEvent.doubleClick(view.container.querySelector('[data-workbench-left-panel] [data-msgid="classification-1"]')!);
        await waitForWorkbenchIdle();
      }
      fireEvent.click(screen.getByRole('button',{name:/显示提示 msg-1：消息待阅/}));
      const tooltip=screen.getByRole('tooltip');expect(tooltip).toHaveTextContent('未阅影响（1 条）');expect(tooltip).toHaveTextContent('current-join');
      expect(within(tooltip).queryByRole('button',{name:/^(分类|总结) · classification-1/})).toBeNull();
      fireEvent.click(within(tooltip).getByRole('button',{name:'标记当前消息已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());
      const marks=mockApi.markReading.mock.calls[0][0];
      expect(marks).toContainEqual(expect.objectContaining({messageId:'msg-1',scope:'message'}));
      expect(marks.some((mark:{messageId:string;scope:string})=>mark.messageId==='current-join'&&mark.scope==='message')).toBe(false);
      expect(marks.filter((mark:{scope:string})=>mark.scope!=='influence')).toHaveLength(1);expect(marks.some((mark:{messageId:string;scope:string})=>mark.messageId==='classification-1'&&mark.scope!=='influence')).toBe(false);
      expect(marks.some((mark:{messageId:string;scope:string})=>mark.messageId==='msg-2'&&mark.scope!=='influence')).toBe(false);
      await waitFor(()=>expect(screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/})).toHaveAttribute('data-display-reading','read'));
      expect(marks).toContainEqual(expect.objectContaining({messageId:'current-join',scope:'influence',eventId:expect.stringContaining('current-join'),resultKey:'effective'}));
      expect(mockApi.markReading).toHaveBeenCalledOnce();
      expect(screen.getByRole('button',{name:/显示提示 msg-2：消息待阅/})).toBeInTheDocument();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);
  it.each(THEMES.flatMap(({ id: theme }) => (['graph', 'list'] as const).map(mode => ({ theme, mode }))))('keeps a migrated classification name while double-clicking and correcting it in $theme / $mode', async ({ theme, mode }) => {
    const previousTheme = getTheme();setTheme(theme);
    localStorage.setItem('token', 'test-token');
    const title = '图书馆开放时间', description = '建立关系：CLASSIFY；目标：msg-1';
    const container: Relation = { ...makeRelation(), id: 'legacy-container', revision: 1, relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }], payload: { title, independentMemberships: true },
      parts: [{ id: 'body', type: 'text', text: description },
        { id: 'relation', type: 'relation', relation: 'classify', roles: { members: [{ id: 'member', reference: { messageId: 'msg-1' } }] } },
        { id: 'data', type: 'data', value: { title, kind: 'RELATION', legacyTopicId: 'old-topic' } }] };
    const snapshotLoader = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    mockApi.getRelations.mockResolvedValue({ data: [container] });
    mockApi.getWorkbenchSnapshot.mockResolvedValue({ scope: { messageId: 'classification-1', title: '测试分类' },
      messages: [makeMessage('msg-1', '成员'), { ...makeMessage(container.id, description), kind: 'RELATION', revision: 1,
        relationType: container.relationType, targetRefs: container.targetRefs, relationPayload: container.payload, parts: container.parts }],
      relations: [container], users: [makeUser()], stakes: {}, tagCounts: {}, attentionUsers: {}, sequence: 1, hasMore: false, nextCursor: null });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    const view = render(<StrictMode><MessageWorkbenchPage /></StrictMode>);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: /^更正$/ }));
      const card = view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="legacy-container"]:not([data-rel-overlay])')!;
      const exits = screen.queryAllByRole('button', { name: '退出分类' }).length;
      expect(card).toHaveTextContent(title);
      const titleBody = within(card).getByText(title);
      fireEvent.mouseDown(titleBody, { button: 0, detail: 1 });
      fireEvent.mouseUp(titleBody, { button: 0, detail: 1 });
      fireEvent.click(titleBody, { button: 0, detail: 1 });
      expect(titleBody.isConnected).toBe(true);
      if (mode === 'graph') expect(mockGraphView.mock.lastCall![0].draftUnits).toEqual([{ messageId: container.id, selection: { kind: 'whole' } }]);
      fireEvent.mouseDown(titleBody, { button: 0, detail: 2 });
      // A real browser selects a word before dispatching the second click.
      const nativeWord = document.createRange(); nativeWord.setStart(titleBody.firstChild!, 0); nativeWord.setEnd(titleBody.firstChild!, 3);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(nativeWord);
      expect(window.getSelection()!.toString()).toBe('图书馆');
      fireEvent.mouseUp(titleBody, { button: 0, detail: 2 });
      fireEvent.click(titleBody, { button: 0, detail: 2 });
      fireEvent.doubleClick(titleBody, { button: 0, detail: 2 });
      expect(card).toHaveTextContent(title);
      expect(card).not.toHaveTextContent('建立关系');
      expect(screen.queryAllByRole('button', { name: '退出分类' })).toHaveLength(exits);
      expect(within(card).getByText('拖选文字即可选择片段，或点击已有高亮片段')).toBeInTheDocument();
      expect(mockGraphView.mock.lastCall![0].draftUnits).toEqual([]);
      const body = card.querySelector<HTMLElement>('[data-message-part-id="data"]')!;
      expect(body.textContent).toBe(title);
      const range = document.createRange(); range.setStart(body.firstChild!, 3); range.setEnd(body.firstChild!, 5);
      window.getSelection()!.addRange(range);
      fireEvent.mouseUp(body, { detail: 1 });
      expect(window.getSelection()!.toString()).toBe('开放');
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '闭馆' } });
      fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
      const confirm = await screen.findByRole('button', { name: '确认发送更正' });
      expect([...confirm.closest('[role="dialog"]')!.querySelectorAll('pre')].map(node => node.textContent)).toEqual([title, '图书馆闭馆时间']);
      expect(mockApi.createRelation).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      fireEvent.click(screen.getByRole('button', { name: '清空' }));
      expect(within(card).queryByText('拖选文字即可选择片段，或点击已有高亮片段')).toBeNull();
      expect(window.getSelection()!.toString()).toBe('');
    } finally { window.getSelection()?.removeAllRanges(); view.unmount(); geometry.mockRestore(); graphRendering.actual = false; mockApi.getWorkbenchSnapshot.mockImplementation(snapshotLoader); setTheme(previousTheme); }
  });

  it.each(THEMES.flatMap(({ id: theme }) => ['CLASSIFY', 'SUMMARY'].flatMap(type => ['graph', 'list'].map(mode => ({ theme, type, mode, correctionKind: 'TEXT' as const })))))(
    'displays a body correction of $type from $theme / $mode ($correctionKind), restores the original on personal rejection and keeps correction history', async ({ theme, type, mode, correctionKind }) => {
    const previousTheme = getTheme();setTheme(theme);
    localStorage.setItem('token', 'test-token');
    const replacement = '加长的新正文';
    const before = '开头保留\n需要更正的旧正文\n结尾也保留', after = before.replace('旧正文', replacement);
    const start = before.indexOf('旧正文');
    const container: Relation = { ...makeRelation(), id: 'editable-container', revision: 1, relationType: type, sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }], payload: { title: before, independentMemberships: true },
      parts: [{ id: 'body', type: 'text', text: before }, { id: 'relation', type: 'relation', relation: type.toLowerCase(), roles: { members: [{ id: 'm', reference: { messageId: 'msg-1' } }] } }] };
    const correction: Relation = { ...makeRelation(), id: 'body-correction', revision: 1, relationType: 'CORRECT', sourceMessageId: null,
      targetRefs: [{ kind: 'text-fragment', messageId: container.id, text: '旧正文', hash: 'part', reference: { messageId: container.id, revision: 1, partId: 'body', range: { start, end: start + 3 } } }],
      payload: { correctionContent: after, correctionValue: replacement, correctionKind, correctionBeforeContent: before, correctionAfterContent: after },
      parts: [{ id: 'corrected-body', type: 'text', text: after }, { id: 'relation', type: 'relation', relation: 'correct', roles: { target: [{ id: 't', reference: { messageId: container.id, revision: 1, partId: 'body', range: { start, end: start + 3 } } }] } }],
      state: { messageId: 'body-correction', revision: 1, suppressed: false, supportCount: 0, oppositionCount: 0, recommendationTotal: 0 },
      createdAt: '2026-10-21T00:00:00Z' };
    const oldVote:Relation={...makeRelation(),id:'old-body-agreement',relationType:'AGREE',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:container.id}],spending:{protocol:1,recommendation:0,wager:7}};
    const snapshotLoader=mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    let savedRelations:Relation[]=[container,oldVote],sequence=1;
    const saveRelation=(relation:Relation)=>{savedRelations=[...savedRelations,relation];sequence++;
      mockApi.getRelations.mockResolvedValue({data:savedRelations});return relation;};
    mockApi.getRelations.mockResolvedValue({data:savedRelations});
    mockApi.createRelation.mockReset().mockImplementationOnce(async()=>saveRelation(correction));
    // Background reads must include committed records and native parts, as the real server does.
    mockApi.getWorkbenchSnapshot.mockImplementation(async()=>({scope:{messageId:'classification-1',title:'测试分类'},
      messages:[makeMessage('msg-1','成员'),...savedRelations.map(relation=>({...makeMessage(relation.id,relation.id===container.id?before:''),
        kind:'RELATION',revision:relation.revision,relationType:relation.relationType,targetRefs:relation.targetRefs,relSourceId:relation.sourceMessageId,
        relationPayload:relation.payload,parts:relation.parts,state:relation.state,spending:relation.spending,createdBy:relation.createdBy,createdAt:relation.createdAt}))],
      relations:savedRelations,users:[makeUser()],stakes:{[container.id]:{messageId:container.id,pool:{lockedPro:7,lockedCon:0},stakes:[],counts:{pro:7,con:0}}},
      tagCounts:{},attentionUsers:{},sequence,hasMore:false,nextCursor:null}));
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: /^更正$/ }));
      const exits = screen.queryAllByRole('button', { name: /^退出分类$|^退出总结$/ }).length;
      const card = view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="editable-container"]:not([data-rel-overlay])')!;
      expect(screen.getByRole('button', { name: '修正文字' })).toHaveAttribute('aria-pressed', 'true');

      fireEvent.doubleClick(card);
      expect(screen.queryAllByRole('button', { name: /^退出分类$|^退出总结$/ })).toHaveLength(exits);
      expect(within(card).getByText('拖选文字即可选择片段，或点击已有高亮片段')).toBeInTheDocument();
      if (mode === 'graph') expect(mockGraphView.mock.lastCall![0].activeTextSelectId).toBe(container.id);
      const body = card.querySelector<HTMLElement>('[data-message-part-id="body"]')!;
      expect(body.textContent).toBe(before);
      const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 3);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      fireEvent.mouseUp(body, { detail: 1 });
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: replacement } });
      expect(screen.getByRole('button', { name: /^发送$/ })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
      const confirm = await screen.findByRole('button', { name: '确认发送更正' });
      expect([...confirm.closest('[role="dialog"]')!.querySelectorAll('pre')].map(node => node.textContent)).toEqual([before, after]);
      fireEvent.click(confirm);
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        relationType: 'CORRECT', payload: { correctionContent: after, correctionKind, correctionValue: replacement },
        targetRefs: [expect.objectContaining({ reference: { messageId: container.id, revision: 1, partId: 'body', range: { start, end: start + 3 } } })],
      })));
      await waitForWorkbenchIdle();
      const correctedCard = view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="editable-container"]:not([data-rel-overlay])')!;
      expect(correctedCard).toHaveTextContent(`需要更正的${replacement}`);
      expect(correctedCard).not.toHaveTextContent('需要更正的旧正文');
      fireEvent.click(within(correctedCard).getByRole('button',{name:/^显示提示 editable-container：/}));
      expect(within(screen.getByRole('region',{name:'消息信息'})).getByRole('button',{name:'查看消息 editable-container 的当前正文作者：tester，共 1 人'})).toHaveTextContent('✎ 1人');
      fireEvent.click(screen.getByRole('button',{name:'关闭消息提示'}));
      expect(screen.queryByRole('combobox', { name: '正文版本' })).toBeNull();
      fireEvent.click(within(correctedCard).getByRole('button',{name:'切换消息 editable-container 的版本'}));
      expect(screen.getByRole('dialog',{name:'消息 editable-container 的版本'})).not.toHaveTextContent('当前用户尚未选择');
      expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('与当前用户选择相同');
      fireEvent.click(screen.getByRole('button',{name:'关闭版本选择'}));
      if (mode === 'graph') expect(correctedCard.querySelector('[data-jump-msgids~="body-correction"]')).not.toBeNull();
      else {
        expect(view.container.querySelector('[data-msgid="body-correction"]')).toHaveTextContent(`将「旧正文」修改为「${replacement}」`);
        expect(within(correctedCard).getByTitle('双击查看更正记录')).toHaveTextContent('✏ 1');
        expect(within(correctedCard).getByTitle('双击查看更正记录')).not.toHaveTextContent('更正');
      }
      // Keep the corrected body visible while selecting a suffix whose offset shifted.
      fireEvent.click(screen.getByRole('button', { name: /^更正$/ }));
      fireEvent.doubleClick(correctedCard);
      const displayedPart = correctedCard.querySelector<HTMLElement>('[data-message-part-id="body"]')!;
      expect(displayedPart.textContent).toBe(after);
      const displayedText = document.createTreeWalker(displayedPart, NodeFilter.SHOW_TEXT).nextNode()!;
      const suffix = '结尾也保留', visibleStart = after.indexOf(suffix), baseStart = before.indexOf(suffix);
      const nextRange = document.createRange(); nextRange.setStart(displayedText, visibleStart); nextRange.setEnd(displayedText, visibleStart + suffix.length);
      window.getSelection()!.addRange(nextRange);
      fireEvent.mouseUp(displayedPart, { detail: 1 });
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '修正后的结尾' } });
      fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
      const nextConfirm = await screen.findByRole('button', { name: '确认发送更正' });
      expect([...nextConfirm.closest('[role="dialog"]')!.querySelectorAll('pre')].map(node => node.textContent))
        .toEqual([before, before.slice(0, baseStart) + '修正后的结尾']);
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      fireEvent.click(screen.getByRole('button', { name: /^清空$/ }));
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '' } });
      // Let the drag guard finish before starting a separate card click gesture.
      const clearedAt = Date.now();
      await waitFor(() => expect(Date.now() - clearedAt).toBeGreaterThan(350));
      const opposition: Relation = { ...makeRelation(), id: 'against-correction', relationType: 'DISAGREE', sourceMessageId: null,
        targetRefs: [{ kind: 'relation', relationId: correction.id }], createdAt: '2026-10-21T01:00:00Z' };
      mockApi.createRelation.mockImplementationOnce(async()=>saveRelation(opposition));
      const record = mode === 'graph' ? correctedCard.querySelector('[data-jump-msgids~="body-correction"]')!
        : view.container.querySelector('[data-workbench-left-panel] [data-msgid="body-correction"]')!;
      if(mode==='graph'){
        fireEvent.doubleClick(record);await waitForWorkbenchIdle();
        fireEvent.click(view.container.querySelector('[data-workbench-left-panel] [data-msgid="body-correction"]')!);
        fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
      }else fireEvent.click(record);
      fireEvent.click(screen.getByRole('button', { name: /^反对$/ }));
      fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledTimes(2));
      await waitForWorkbenchIdle();
      const restoredCard = view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="editable-container"]:not([data-rel-overlay])')!;
      expect(restoredCard).toHaveTextContent('需要更正的旧正文');
      expect(within(restoredCard).getByRole('button',{name:/^显示提示 editable-container：/})).toHaveAttribute('data-display-comparison','same');
      expect(within(restoredCard).getByRole('button',{name:'切换消息 editable-container 的版本'}).querySelector('[data-reading-version-recommendation-difference]')).not.toBeNull();
      if (mode === 'graph') expect(restoredCard.querySelector('[data-jump-msgids~="body-correction"]')).not.toBeNull();
      else expect(view.container.querySelector('[data-msgid="body-correction"]')).toHaveTextContent(`将「旧正文」修改为「${replacement}」`);
      if (mode === 'graph') {
        fireEvent.doubleClick(restoredCard.querySelector('[data-jump-msgids~="body-correction"]')!);
        await waitForWorkbenchIdle();
        expect(screen.getByText('更正记录临时分类（1）')).toBeInTheDocument();
        const historyCard = view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="body-correction"]')!;
        expect(historyCard).toHaveTextContent(`将「旧正文」修改为「${replacement}」`);
        expect(historyCard).toHaveTextContent(`start=${start} len=3`);
        expect(historyCard).not.toHaveTextContent(/具体更改|修改前全文|修改后全文|开头保留|结尾也保留/);
        expect(historyCard).toHaveTextContent('修正文字');
        const targetButton=within(historyCard).getByRole('button',{name:container.id});
        expect(targetButton.parentElement).toHaveTextContent(`目标：${container.id}`);
        expect(targetButton.parentElement).not.toHaveTextContent(makeUser().username);
        expect(historyCard).not.toHaveTextContent('更正了消息');
        expect(historyCard.querySelectorAll('pre')).toHaveLength(0);
        const viewTag=within(historyCard).getByRole('button',{name:/^查看消息 body-correction：/});
        expect(viewTag).toHaveTextContent('查看');
        expect(viewTag.getAttribute('aria-label')).toContain('选择不显示');
        expect(within(historyCard).getByRole('link',{name:correction.id}).nextElementSibling).toBe(viewTag);
        fireEvent.click(viewTag);
        await waitForWorkbenchIdle();
        expect(screen.queryByText('更正查看')).toBeNull();
        expect(screen.getByText('更正记录临时分类（1）')).toBeInTheDocument();
        const returnedCard=view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="body-correction"]')!;
        fireEvent.doubleClick(returnedCard);
        expect(screen.getByText('✏ 更正对比')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button',{name:'关闭'}));
        fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
        await waitForWorkbenchIdle();
      } else {
        fireEvent.doubleClick(view.container.querySelector('[data-workbench-left-panel] [data-msgid="body-correction"]')!);
        expect(screen.getByText('✏ 更正对比')).toBeInTheDocument();
        expect(screen.getByText(/消息卡按本人立场及公共统计显示有效正文/)).toBeInTheDocument();
      }
      expect(mockApi.createMessage).not.toHaveBeenCalled();
    } finally { window.getSelection()?.removeAllRanges(); view.unmount(); geometry.mockRestore(); graphRendering.actual = false; mockApi.getWorkbenchSnapshot.mockImplementation(snapshotLoader); setTheme(previousTheme); }
  },15000);

  it.each(['RECOMMEND', 'ARCHIVE'])('displays the %s returned by a value vote immediately in the annotation group', async type => {
    localStorage.setItem('token', 'test-token');
    const annotation: Relation = { ...makeRelation(), id: 'value-vote', relationType: type, sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1', reference: { messageId: 'msg-1', revision: 1 } }], payload: {} };
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      await act(async () => { window.dispatchEvent(new CustomEvent('relation-created', { detail: annotation })); });
      await waitFor(() => expect(mockGraphView.mock.lastCall![0].edges).toContainEqual(expect.objectContaining({
        relationMessageId: annotation.id, relationType: type.toLowerCase(), to: expect.objectContaining({ messageId: 'msg-1' }),
      })));
      fireEvent.click(await screen.findByRole('button', { name: '显示标注 msg-1' }));
      await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-jump-msgids*="value-vote"][data-rel-overlay]')).not.toBeNull();
      expect(mockApi.getMessageStakes).toHaveBeenCalledWith('msg-1');
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { view.unmount(); geometry.mockRestore(); graphRendering.actual = false; }
  });

  it.each(['RECOMMEND','ARCHIVE'].flatMap(type=>['AGREE','DISAGREE'].map(stanceType=>({type,stanceType}))))(
    'finishes sending $stanceType to $type as the corresponding annotation',async({type,stanceType})=>{
    localStorage.setItem('token','test-token');
    const annotation:Relation={...makeRelation(),id:'annotation-target',relationType:type,sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],revision:1,parts:[
        {id:'relation',type:'relation',relation:type.toLowerCase(),roles:{target:[{id:'target',reference:{messageId:'msg-1'}}]}},
        {id:'data',type:'data',value:{uiType:type}},
      ]};
    const effectiveType=stanceType==='AGREE'?type:type==='RECOMMEND'?'ARCHIVE':'RECOMMEND';
    const stance:Relation={...makeRelation(),id:'annotation-stance',relationType:effectiveType,sourceMessageId:null,
      targetRefs:annotation.targetRefs,revision:1,payload:{annotationStance:{target:{messageId:annotation.id},side:stanceType==='AGREE'?'pro':'con'}}};
    mockApi.getRelations.mockResolvedValue({data:[annotation]});
    mockApi.getWorkbenchSnapshot.mockResolvedValueOnce({scope:{messageId:'classification-1',title:'测试分类'},
      messages:[makeMessage('msg-1','第一条'),makeMessage('msg-2','第二条'),{...makeMessage(annotation.id,''),kind:'RELATION',
        relationType:type,targetRefs:annotation.targetRefs,relationPayload:annotation.payload,parts:annotation.parts,revision:1}],
      relations:[annotation],users:[makeUser()],stakes:{},tagCounts:{},attentionUsers:{},sequence:1,nextCursor:null,hasMore:false});
    mockApi.createRelation.mockResolvedValueOnce(stance);
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'显示标注 msg-1'}));
      fireEvent.click(view.container.querySelector('[data-msgid="annotation-target"][data-rel-overlay]')!);
      fireEvent.click(screen.getByRole('button',{name:stanceType==='AGREE'?'赞同':'反对'}));
      expect(screen.getByLabelText(`${effectiveType==='RECOMMEND'?'推荐':'冷藏'}真假投入`)).toBeDisabled();
      expect(screen.getByLabelText(`${effectiveType==='RECOMMEND'?'推荐':'冷藏'}真假投入`)).toHaveValue(0);
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledExactlyOnceWith('classification-1',expect.objectContaining({
        relationType:stanceType,targetRefs:[expect.objectContaining({reference:{messageId:annotation.id,revision:1,context:{kind:'MESSAGE',version:bodyVersion(annotation.id)}}})],
      })));
      await waitFor(()=>expect(document.querySelector('[data-message-jump-target="annotation-stance"]')).not.toBeNull());
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('dialog',{name:'正在发送'})).toBeNull();
      expect(mockGraphView.mock.lastCall![0].messages.find((message:{id:string})=>message.id===stance.id)).toMatchObject({relationType:effectiveType.toLowerCase()});
      await waitFor(()=>expect(document.querySelector('[data-message-jump-target="annotation-stance"]')).toBeNull());
      expect(view.container.querySelector('[data-jump-msgids*="annotation-stance"][data-rel-overlay]')).not.toBeNull();
      expect(screen.queryByText(/绘制超时|绘制或定位尚未完成/)).toBeNull();
      expect(mockApi.createRelation).toHaveBeenCalledOnce();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['attention','block'].flatMap(type=>['YES','NO'].map(reason=>({type,reason}))))('directly sends $type with reason $reason',async({type,reason})=>{
    localStorage.setItem('token','test-token');
    const result:Relation={...makeRelation(),id:'personal-annotation',relationType:type.toUpperCase(),sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],payload:{subType:reason as 'YES'|'NO'}};
    mockApi.createRelation.mockResolvedValueOnce(result);
    const view=render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    await waitForWorkbenchIdle();
    act(()=>window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT,{detail:{reference:{messageId:'msg-1'},label:'第一条'}})));
    fireEvent.click(screen.getByRole('button',{name:'标注'}));
    fireEvent.click(screen.getByRole('button',{name:type==='attention'?'关注':'拉黑'}));
    fireEvent.click(screen.getByRole('button',{name:reason==='YES'?'是':'否'}));
    expect(screen.getByRole('button',{name:reason==='YES'?'是':'否'})).toHaveAttribute('aria-pressed','true');
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1',expect.objectContaining({relationType:type.toUpperCase(),payload:expect.objectContaining({subType:reason})})));
    view.unmount();
  });

  it.each([false,true])('blocks opposing custom annotations even with legacy opposite metadata (legacy: %s)',async configured=>{
    const annotation:Relation={...makeRelation(),id:'custom-annotation',relationType:'TAG',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],payload:{label:'可靠',...(configured?{oppositeLabel:'存疑'}:{})}};
    mockApi.getRelations.mockResolvedValue({data:[annotation]});
    const view=render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    await waitForWorkbenchIdle();
    act(()=>window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT,{detail:{reference:{messageId:annotation.id},label:'可靠'}})));
    fireEvent.click(screen.getByRole('button',{name:'反对'}));
    const button=screen.getByRole('button',{name:'发送'});
    expect(button).toBeDisabled();
    expect(screen.getByText('该标注没有互斥项，不能发送反对')).toBeInTheDocument();
    expect(screen.queryByLabelText('互斥标注')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(mockApi.createRelation).not.toHaveBeenCalled();
    expect(mockApi.createMessage).not.toHaveBeenCalled();
    view.unmount();
  });

  it('finishes agreeing with a custom annotation and temporarily reveals the new tag',async()=>{
    localStorage.setItem('token','test-token');
    const annotation:Relation={...makeRelation(),revision:1,id:'custom-annotation',relationType:'TAG',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],payload:{label:'可靠'},parts:[{id:'relation',type:'relation',relation:'tag',roles:{target:[{id:'t',reference:{messageId:'msg-1',revision:1,context:{kind:'MESSAGE',version:bodyVersion('msg-1')}}}]}}]};
    const result:Relation={...annotation,id:'new-custom-annotation',payload:{label:'可靠',
      annotationStance:{target:{messageId:annotation.id},side:'pro'}}};
    mockApi.getRelations.mockResolvedValue({data:[annotation]});
    mockApi.createRelation.mockResolvedValueOnce(result);
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      act(()=>window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT,{detail:{reference:{messageId:annotation.id},label:'可靠'}})));
      fireEvent.click(screen.getByRole('button',{name:'赞同'}));
      expect(screen.getByLabelText('标注真假投入')).toBeDisabled();
      expect(screen.getByLabelText('标注真假投入')).toHaveValue(0);
      fireEvent.change(screen.getByLabelText('标注价值投入'),{target:{value:'4'}});
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(document.querySelector('[data-message-jump-target="new-custom-annotation"]')).not.toBeNull());
      await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-jump-msgids*="new-custom-annotation"]')).toHaveTextContent(result.payload!.label!);
      expect(mockApi.createRelation).toHaveBeenCalledOnce();
      expect(mockApi.createRelation).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({relationType:'AGREE',wager:0,recommendation:4,selfAgree:false}));
      await waitFor(()=>expect(document.querySelector('[data-message-jump-target="new-custom-annotation"]')).toBeNull());
      expect(screen.getByRole('button',{name:'收起标注 msg-1'})).toHaveAttribute('aria-expanded','true');
      expect(screen.queryByText(/绘制超时|绘制或定位尚未完成/)).toBeNull();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['AGREE','DISAGREE'] as const)('finishes sending %s to a reference without waiting for a missing decoration',async stanceType=>{
    localStorage.setItem('token','test-token');
    const reference:Relation={...makeRelation(),id:'voted-reference',relationType:'REFERENCE',sourceMessageId:'msg-1',
      targetRefs:[{kind:'message',messageId:'msg-2'}]};
    const stance:Relation={...makeRelation(),id:'reference-stance',relationType:stanceType,sourceMessageId:null,
      targetRefs:[{kind:'relation',relationId:reference.id}]};
    mockApi.getRelations.mockResolvedValue({data:[reference]});
    mockApi.createRelation.mockResolvedValueOnce(stance);
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    graphRendering.actual=true;
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('group',{name:'关系消息 voted-reference'}));
      fireEvent.click(screen.getByRole('button',{name:stanceType==='AGREE'?'赞同':'反对'}));
      expect(screen.getByLabelText(`${stanceType==='AGREE'?'赞同':'反对'}价值投入`)).toBeDisabled();
      expect(screen.getByLabelText(`${stanceType==='AGREE'?'赞同':'反对'}价值投入`)).toHaveValue(0);
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledOnce());
      await waitFor(()=>expect(document.querySelector('[data-message-jump-target="reference-stance"]')).not.toBeNull());
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('dialog',{name:'正在发送'})).toBeNull();
      expect(graphRendering.tasks!.failure).toBeNull();
      expect(mockGraphView.mock.lastCall![0].draftUnits).toEqual([]);
      await waitFor(()=>expect(document.querySelector('[data-message-jump-target="reference-stance"]')).toBeNull());
      if(stanceType==='AGREE')expect(screen.getByRole('button',{name:'收起装饰 voted-reference'})).toHaveAttribute('aria-expanded','true');
      else {
        expect(view.container.querySelector('[data-msgid="voted-reference"]:not([data-rel-overlay])')).not.toBeNull();
        expect(view.container.querySelector('[data-msgid="reference-stance"]:not([data-rel-overlay])')).toBeNull();
        expect(screen.getByRole('button',{name:'收起装饰 voted-reference'})).toHaveAttribute('aria-expanded','true');
      }
      expect(screen.queryByText(/绘制超时|绘制或定位尚未完成/)).toBeNull();
      expect(mockApi.createRelation).toHaveBeenCalledOnce();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each([false, true].flatMap(empty => [false, true].map(shown => ({ empty, shown }))))(
    'finishes agreeing to an arrangement and restores its manual card visibility (empty=$empty, shown=$shown)', async ({ empty, shown }) => {
    localStorage.setItem('token', 'test-token');
    const arrangement: Relation = { ...makeRelation(), id: 'arrangement', relationType: 'ARRANGE', sourceMessageId: null,
      targetRefs: empty ? [] : ['msg-1', 'msg-2'].map(messageId => ({ kind: 'message', messageId })),
      payload: { title: '排列', targetLayout: 'single-row' } };
    const agreement: Relation = { ...makeRelation(), id: 'arrangement-agreement', relationType: 'AGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'relation', relationId: arrangement.id }] };
    mockApi.getRelations.mockResolvedValue({ data: [arrangement] });
    mockApi.createRelation.mockResolvedValueOnce(agreement);
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      fireEvent.click(view.container.querySelector('div[data-msgid="arrangement"][data-rel-overlay]')!);
      if (shown) fireEvent.click(screen.getByRole('button', { name: '显示排列消息卡 arrangement' }));
      fireEvent.click(screen.getByRole('button', { name: /^赞同$/ }));
      fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledOnce());
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="arrangement-agreement"]')).not.toBeNull());
      expect(screen.getByRole('group', { name: '组织消息 arrangement' })).toBeInTheDocument();
      expect(mockGraphView.mock.lastCall![0].draftUnits).toEqual([]);
      await waitForWorkbenchIdle();
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="arrangement-agreement"]')).toBeNull());
      expect(!!screen.queryByRole('group', { name: '组织消息 arrangement' })).toBe(shown);
      if (shown) {
        fireEvent.click(view.container.querySelector('div[data-msgid="arrangement"][data-rel-overlay]')!);
        expect(screen.getByRole('button',{name:'收起装饰 arrangement'})).toHaveAttribute('aria-expanded','true');
        const badge = view.container.querySelector<HTMLElement>('[data-msgid="arrangement"][title^="赞同："]')!;
        fireEvent.click(within(badge).getByText('1', { exact: true }));
        fireEvent.click(view.container.querySelector('div[data-msgid="arrangement"][data-rel-overlay]')!);
        expect(mockGraphView.mock.lastCall![0].draftUnits.map((unit: { messageId: string }) => unit.messageId)).toEqual([agreement.id]);
        expect(screen.getByRole('group', { name: '组织消息 arrangement' })).toBeInTheDocument();
        expect(badge).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '收起排列消息卡 arrangement' }));
        expect(screen.queryByRole('group', { name: '组织消息 arrangement' })).toBeNull();
        expect(mockGraphView.mock.lastCall![0].draftUnits.map((unit: { messageId: string }) => unit.messageId)).toEqual([agreement.id]);
        fireEvent.click(screen.getByRole('button', { name: '显示排列消息卡 arrangement' }));
        const reopenedBadge = view.container.querySelector<HTMLElement>('[data-msgid="arrangement"][title^="赞同："]')!;
        fireEvent.click(within(reopenedBadge).getByText('1', { exact: true }));
        expect(mockGraphView.mock.lastCall![0].draftUnits).toEqual([]);
      }
      expect(screen.queryByRole('dialog', { name: '正在发送' })).toBeNull();
      expect(screen.queryByText(/绘制超时|绘制或定位尚未完成/)).toBeNull();
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '赞同后继续输入' } });
      expect(screen.getByRole('button', { name: /^发送$/ })).toBeEnabled();
      expect(mockApi.createRelation).toHaveBeenCalledOnce();
    } finally { view.unmount(); geometry.mockRestore(); graphRendering.actual = false; }
  });

  it.each(['direct', 'join'].flatMap(membership => [false, true].map(allMembers => ({ membership, allMembers }))))(
    'classifies released merge members after rejection ($membership memberships, all members=$allMembers)', async ({ membership, allMembers }) => {
    localStorage.setItem('token', 'test-token');
    const memberIds = ['msg-1', 'msg-2'];
    const merge: Relation = { ...makeRelation(), id: 'merge-A', relationType: 'MERGE', sourceMessageId: null,
      targetRefs: memberIds.map(messageId => ({ kind: 'message', messageId })),
      payload: { title: '归并 A', ...(membership === 'join' ? { independentMemberships: true } : {}) } };
    const joins: Relation[] = membership === 'join' ? memberIds.map(messageId => ({ ...makeRelation(), id: `join-${messageId}`,
      relationType: 'JOIN', sourceMessageId: merge.id, targetRefs: [{ kind: 'message', messageId }] })) : [];
    const rejection: Relation = { ...makeRelation(), id: 'reject-merge', relationType: 'DISAGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'relation', relationId: merge.id }] };
    const selectedIds = allMembers ? memberIds : memberIds.slice(0, 1);
    const category: Relation = { ...makeRelation(), id: 'new-category', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: selectedIds.map(messageId => ({ kind: 'message', messageId })), payload: { title: '重新分类' } };
    mockApi.getRelations.mockResolvedValue({ data: [merge, ...joins] });
    mockApi.createRelation.mockResolvedValueOnce(rejection).mockResolvedValueOnce(category);
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      const latest = () => mockGraphView.mock.lastCall![0];
      const event = () => ({ button: 0, stopPropagation: vi.fn() });
      await act(async () => latest().onMessageClick(event(), merge.id));
      fireEvent.click(screen.getByRole('button', { name: '反对' }));
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledTimes(1));
      await waitForWorkbenchIdle();
      expect(latest().rejectedContainerIds.has(merge.id)).toBe(true);
      for (const id of selectedIds) await act(async () => latest().onMessageClick(event(), id));
      fireEvent.click(screen.getByRole('button', { name: '分类' }));
      fireEvent.change(screen.getByPlaceholderText('输入分类名称（不能为空）'), { target: { value: '重新分类' } });
      expect(screen.queryByText(/已在归并消息\(merge-A\)中/)).toBeNull();
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenLastCalledWith('classification-1', expect.objectContaining({
        relationType: 'CLASSIFY', targetRefs: selectedIds.map(messageId => expect.objectContaining({ kind: 'message', messageId })),
      })));
      await waitForWorkbenchIdle();
    } finally {
      view.unmount(); geometry.mockRestore(); graphRendering.actual = false;
    }
  });

  it.each(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].flatMap(type =>
    ['graph', 'list'].map(mode => ({ type, mode }))))(
    'finishes agreeing to a rejected JOIN into $type in $mode without moving the view', async ({ type, mode }) => {
    localStorage.setItem('token', 'test-token');
    const container: Relation = { ...makeRelation(), id: 'join-owner', relationType: type, sourceMessageId: null,
      targetRefs: [], payload: { title: '加入的容器', independentMemberships: true } };
    const join: Relation = { ...makeRelation(), id: 'rejected-join', relationType: 'JOIN', sourceMessageId: container.id,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }] };
    const rejection: Relation = { ...makeRelation(), id: 'against-join', relationType: 'DISAGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'relation', relationId: join.id }] };
    const agreement: Relation = { ...rejection, id: 'restore-join', relationType: 'AGREE', createdAt: '2026-10-21T00:00:00Z' };
    mockApi.getRelations.mockResolvedValue({ data: [container, join, rejection] });
    mockApi.createRelation.mockResolvedValueOnce(agreement);
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      const latest = () => mockGraphView.mock.lastCall![0];
      expect(latest().joinStatusByMessage.get(join.id)).toBe('rejected');
      await act(async () => latest().onJoinFilterClick('msg-1', 'incoming'));
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, join.id));
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      panel.scrollTop = 127; panel.scrollLeft = 35;
      fireEvent.click(screen.getByRole('button', { name: /^赞同$/ }));
      fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledWith(expect.any(String),
        expect.objectContaining({ relationType: 'AGREE', targetRefs: [expect.objectContaining({ reference: expect.objectContaining({ messageId: join.id }) })] })));
      await waitForWorkbenchIdle();
      if (mode === 'graph') expect(latest().joinStatusByMessage.get(join.id)).toBe('valid');
      else expect(panel.querySelector(`[data-msgid="${join.id}"]`)).toHaveTextContent('生效');
      expect(screen.getByRole('button', { name: '退出临时分类' })).toBeInTheDocument();
      expect([panel.scrollTop, panel.scrollLeft]).toEqual([127, 35]);
      expect(document.querySelector('[data-message-jump-overlay]')).toBeNull();
      expect(screen.queryByRole('dialog', { name: '正在发送' })).toBeNull();
      expect(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
      // The member remains reachable through its existing explicit navigation.
      await act(async () => latest().onNavigateToMessage('msg-1'));
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="msg-1"]')).not.toBeNull());
    } finally {
      view.unmount(); geometry.mockRestore(); graphRendering.actual = false;
    }
  });

  it.each(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].flatMap(type =>
    ['graph', 'list'].flatMap(mode => [false, true].map(keepsMember => ({ type, mode, keepsMember })))))(
    'finishes rejecting a JOIN and restoring $type in $mode after its member moves (remaining member=$keepsMember)', async ({ type, mode, keepsMember }) => {
    localStorage.setItem('token', 'test-token');
    const container: Relation = { ...makeRelation(), id: 'join-owner', relationType: type, sourceMessageId: null,
      targetRefs: [], payload: { title: '原容器', independentMemberships: true } };
    const join: Relation = { ...makeRelation(), id: 'active-join', relationType: 'JOIN', sourceMessageId: container.id,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }] };
    const retained: Relation = { ...join, id: 'retained-join', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] };
    const rejection: Relation = { ...makeRelation(), id: 'reject-join', relationType: 'DISAGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: join.id }], createdAt: '2026-10-21T00:00:00Z' };
    mockApi.getRelations.mockResolvedValue({ data: [container, join, ...(keepsMember ? [retained] : [])] });
    mockApi.createRelation.mockResolvedValueOnce(rejection);
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      const latest = () => mockGraphView.mock.lastCall![0];
      if (type === 'CLASSIFY' || type === 'SUMMARY') {
        await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, container.id));
        await waitForWorkbenchIdle();
      }
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      await act(async () => latest().onJoinFilterClick('msg-1', 'incoming'));
      await waitForWorkbenchIdle();
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, join.id));
      fireEvent.click(screen.getByRole('button', { name: /^反对$/ }));
      fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalled());
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('button', { name: '退出临时分类' })).toBeNull();
      expect(screen.queryByRole('dialog', { name: '正在绘制' })).toBeNull();
      expect(screen.queryByText(/绘制超时|绘制或定位尚未完成/)).toBeNull();
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      if (type === 'CLASSIFY' || type === 'SUMMARY') {
        expect(panel.querySelector('[data-msgid="msg-1"]:not([data-rel-overlay])')).toBeNull();
        expect(screen.getAllByRole('button', { name: type === 'CLASSIFY' ? '退出分类' : '退出总结' }).length).toBeGreaterThan(0);
      } else expect(panel.querySelector('[data-msgid="msg-1"]:not([data-rel-overlay])')).not.toBeNull();
      const input = screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）');
      fireEvent.change(input, { target: { value: '退出后继续编辑' } });
      expect(input).toHaveValue('退出后继续编辑');
      expect(input.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    } finally {
      view.unmount(); geometry.mockRestore(); graphRendering.actual = false;
    }
  });

  it.each([
    ['CLASSIFY', 'graph'], ['SUMMARY', 'graph'], ['MERGE', 'graph'], ['ARRANGE', 'graph'],
    ['CLASSIFY', 'list'], ['SUMMARY', 'list'], ['MERGE', 'list'], ['ARRANGE', 'list'],
  ])('releases sending and input after rejecting %s in the %s view', async (type, viewMode) => {
    localStorage.setItem('token', 'test-token');
    const category: Relation = { ...makeRelation(), id: 'category', relationType: type, sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }], payload: { title: '分类' } };
    const rejection: Relation = { ...makeRelation(), id: 'against-category', relationType: 'DISAGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'relation', relationId: category.id }] };
    mockApi.getRelations.mockResolvedValue({ data: [category] });
    mockApi.createRelation.mockResolvedValueOnce(rejection);
    let finishCommit!: () => void;
    mockApi.withCommandBatch.mockImplementationOnce(async (work, onCommitted) => {
      await work();
      await new Promise<void>(resolve => { finishCommit = resolve; });
      onCommitted?.(1);
    });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitFor(() => expect(document.querySelector('[role="dialog"][aria-label="正在绘制"]')).toBeNull());
      const latest = () => mockGraphView.mock.lastCall![0];
      if (viewMode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, category.id));
      fireEvent.click(screen.getByRole('button', { name: '反对' }));
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(finishCommit).toBeDefined());
      expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
      await act(async () => finishCommit());
      await waitFor(() => expect(document.querySelector('[role="dialog"][aria-label="正在发送"]')).toBeNull(), { timeout: 2000 });
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="category"]:not([data-rel-overlay])')).not.toBeNull();
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')).not.toBeNull();
      expect(document.body.style.overflow).not.toBe('hidden');
      const textarea = screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）');
      expect(textarea.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
      expect((textarea.closest('[aria-busy]') as HTMLElement).inert).toBe(false);
      for (const canvas of document.querySelectorAll<HTMLElement>('[data-workbench-left-panel] [data-jump-canvas]')) {
        expect(canvas.style.visibility).not.toBe('hidden');
      }
      const graph = latest();
      fireEvent.change(textarea, { target: { value: '反对后立即继续输入' } });
      expect(textarea).toHaveValue('反对后立即继续输入');
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
      if (viewMode === 'graph') {
        expect(latest().rejectedContainerIds.has(category.id)).toBe(true);
        expect(latest().messages).toBe(graph.messages);
        expect(latest().edges).toBe(graph.edges);
        expect(latest().invalidCorrectionIds).toBe(graph.invalidCorrectionIds);
      }
    } finally {
      geometry.mockRestore();
      graphRendering.actual = false;
    }
  });

  it('keeps natural content inside independent sticky viewports after sending', async () => {
    localStorage.setItem('token', 'test-token');
    mockApi.createMessage.mockResolvedValueOnce(makeMessage('sent-height-check', '新增消息'));
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 200, 500, 500));
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1800);
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      const left = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const pane = left.closest<HTMLElement>('.workbench-message-pane')!;
      expect(pane.style.maxHeight).toBe('');
      expect(pane.style.height).toBe('');
      expect(pane.style.position).toBe('sticky');
      const right = screen.getByRole('region', { name: '发言与关系操作' });
      expect(right.style.maxHeight).toBe('');
      expect(right.style.height).toBe('var(--workbench-viewport-height, auto)');
      const content = right.querySelector<HTMLElement>('[data-workbench-panel-content]')!;
      expect(content.style.height).toBe('');
      expect(content.style.maxHeight).toBe('');
      expect(right.style.position).toBe('sticky');
      expect(right.style.top).toBe(document.querySelector<HTMLElement>('[data-workbench-view-toolbar]')!.style.top);
      expect(pane.style.top).toBe(right.style.top);
      const relationToolbarHeight=document.querySelector('.workbench-relation-toolbar')?500:0;
      expect(pane.style.top).toBe(`${relationToolbarHeight}px`);
      expect(left.style.height).toBe('var(--workbench-viewport-height, auto)');
      expect(parseFloat(left.style.getPropertyValue('--workbench-viewport-height'))).toBeGreaterThan(0);
      expect(left.style.minHeight).toBe('0');
      expect(left.style.maxHeight).toBe('');
      expect(left.style.flexGrow).toBe('1');
      expect(left.style.flexShrink).toBe('1');
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '新增消息' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => {
        expect(mockApi.createMessage).toHaveBeenCalled();
        expect(document.querySelector('[data-workbench-scroll-panel]')?.textContent).toContain('新增消息');
      });
      expect(document.querySelector<HTMLElement>('[data-workbench-left-panel]')).toBe(left);
      expect(left.style.height).toBe('var(--workbench-viewport-height, auto)');
      expect(left.style.minHeight).toBe('0');
      expect(left.style.maxHeight).toBe('');
      expect(left.style.flexGrow).toBe('1');
      expect(left.closest('.workbench-message-pane')).toBe(pane);
      expect(pane.style.maxHeight).toBe('');
      expect(pane.style.position).toBe('sticky');
      expect(right.style.maxHeight).toBe('');
      expect(right.style.position).toBe('sticky');
      expect(content.style.height).toBe('');
      expect(content.style.maxHeight).toBe('');
      expect(left.style.overflow).toBe('auto');
      expect(document.querySelector('[data-fixed-left-horizontal-scroll]')).toBeNull();
    } finally {
      scrollWidth.mockRestore();
      geometry.mockRestore();
    }
  });

  it.each([
    ['CLASSIFY', 'text'], ['SUMMARY', 'text'], ['CLASSIFY', 'relation'], ['SUMMARY', 'relation'],
  ])('keeps the nested %s and its parent history after sending and locating a %s', async (relationType, sentKind) => {
    localStorage.setItem('token', 'test-token');
    // A SUMMARY keeps its existing members together. Sending an empty nested
    // classification is legal; moving one of the summary's members is not.
    const classifiedTargets = relationType === 'SUMMARY' ? [] : [{ kind: 'message' as const, messageId: 'msg-1' }];
    const inner: Relation = { ...makeRelation(), id: 'inner', relationType, sourceMessageId: null,
      targetRefs: ['msg-1', 'msg-2'].map(messageId => ({ kind: 'message', messageId })), payload: { title: '内层容器' } };
    const outer: Relation = { ...inner, id: 'outer', relationType: 'CLASSIFY',
      targetRefs: [{ kind: 'relation', relationId: inner.id }], payload: { title: '外层容器' } };
    const createdRelation: Relation = { ...inner, id: 'sent-inside', relationType: 'CLASSIFY',
      targetRefs: classifiedTargets, payload: { title: '在内层发送', independentMemberships: true } };
    const sent: Message = sentKind === 'text' ? makeMessage('sent-inside', '在内层发送') : {
      ...makeMessage(createdRelation.id, ''), kind: 'RELATION', relationType: createdRelation.relationType,
      relSourceId: null, targetRefs: createdRelation.targetRefs, relationPayload: createdRelation.payload,
    };
    const join: Relation = { ...makeRelation(), id: 'join-sent', relationType: 'JOIN', sourceMessageId: inner.id,
      targetRefs: [{ kind: 'message', messageId: sent.id }] };
    const memberJoin: Relation = { ...join, id: 'join-member', sourceMessageId: createdRelation.id,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }], createdAt: '2026-01-01' };
    const placement = sentKind === 'relation' && classifiedTargets.length ? [join, memberJoin] : [join];
    mockApi.getRelations.mockResolvedValue({ data: [outer, inner] });
    if (sentKind === 'text') mockApi.createMessage.mockResolvedValueOnce(sent);
    else mockApi.createRelation.mockResolvedValueOnce(createdRelation);
    mockApi.withCommandBatch.mockImplementationOnce(async (work, onCommitted) => {
      await work();
      window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: [{
        scope: { messageId: 'classification-1', title: '测试分类' }, sequence: 2,
        messages: [sent, ...placement.map(relation => ({
          ...makeMessage(relation.id, ''), kind: 'RELATION', relationType: relation.relationType,
          relSourceId: relation.sourceMessageId, targetRefs: relation.targetRefs,
        }))],
        relations: sentKind === 'text' ? placement : [createdRelation, ...placement],
        users: [], stakes: {}, tagCounts: {}, attentionUsers: {},
      }] }));
      onCommitted?.(1);
    });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      const latest = () => mockGraphView.mock.lastCall![0];
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, outer.id));
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, inner.id));
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      if (sentKind === 'relation') {
        if (classifiedTargets.length) await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
        fireEvent.click(screen.getByRole('button', { name: '分类' }));
      }
      fireEvent.change(screen.getByPlaceholderText(sentKind === 'text' ? '输入一条新文本消息（支持自由换行）' : '输入分类名称（不能为空）'),
        { target: { value: '在内层发送' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(screen.getByText('已定位目标消息')).toBeInTheDocument());
      const exitInner = screen.getByRole('button', { name: relationType === 'SUMMARY' ? '退出总结' : '退出分类' });
      expect(exitInner.parentElement).toHaveTextContent('内层容器');
      expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${sent.id}"]`)).not.toBeNull();
      if (sentKind === 'text') expect(mockApi.createMessage).toHaveBeenCalledWith(inner.id, expect.objectContaining({ content: sent.content }));
      else {
        expect(mockApi.createRelation).toHaveBeenCalledWith(inner.id, expect.objectContaining({ relationType: 'CLASSIFY',
          targetRefs: classifiedTargets.map(target => expect.objectContaining(target)) }));
        expect(document.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]') !== null).toBe(!classifiedTargets.length);
      }
      fireEvent.click(exitInner);
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('外层容器');
      fireEvent.click(screen.getByRole('button', { name: '退出分类' }));
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('测试分类');
    } finally {
      geometry.mockRestore();
    }
  });

  it('locates the destination container after an appended JOIN within its enclosing classification', async () => {
    localStorage.setItem('token', 'test-token');
    const destination: Relation = { ...makeRelation(), id: 'destination', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [], payload: { title: '目标分类' } };
    const current: Relation = { ...destination, id: 'current', payload: { title: '当前分类' },
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'relation', relationId: destination.id }] };
    const join: Relation = { ...makeRelation(), id: 'appended-join', relationType: 'JOIN', sourceMessageId: destination.id,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }] };
    mockApi.getRelations.mockResolvedValue({ data: [current, destination] });
    mockApi.createRelation.mockResolvedValueOnce(join);
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage />);
    try{
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    await waitForWorkbenchIdle();
    const latest = () => mockGraphView.mock.lastCall![0];
    await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
    await waitForWorkbenchIdle();
    await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, destination.id));
    fireEvent.click(screen.getByRole('button', { name: '加入来源集合' }));
    await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
    fireEvent.click(screen.getByRole('button', { name: '分类' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledWith(current.id, expect.objectContaining({ relationType: 'JOIN', sourceMessageId: destination.id })));
    await waitForWorkbenchIdle();
    expect(latest().lastClickedMessageId).toBe(destination.id);
    expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
    expect(document.querySelector('[data-message-jump-target="destination"]')).not.toBeNull();
    expect(document.querySelector('[data-message-jump-target="appended-join"]')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['graph', 'list'])('locates text and every relation in send order within the current classification in %s, skipping generated JOINs', async mode => {
    const displayedTargets: string[] = [];
    const transitions = new MutationObserver(() => {
      const active = document.querySelector<HTMLElement>('[data-message-jump-overlay="true"]');
      const id = active?.getAttribute('data-message-jump-target');
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
    graphRendering.actual = mode === 'graph';
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      const latest = () => mockGraphView.mock.lastCall![0];
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
      await waitForWorkbenchIdle();
      await act(async () => {
        latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1');
        latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-2');
      });
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      fireEvent.click(screen.getByRole('button', { name: '回复' }));
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: sent.content } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(finishCommit).toBeDefined());
      expect(screen.queryByText('已定位目标消息')).toBeNull();
      transitions.observe(document.body, { subtree: true, childList: true, attributes: true });
      await act(async () => finishCommit());
      // Each next overlay replaces the current one as soon as it is ready.
      await waitFor(() => expect(displayedTargets).toEqual([sent.id, ...replies.map(reply => reply.id)]), { timeout: 5000 });
      expect(screen.queryByRole('region', { name: '追溯阅读' })).toBeNull();
      expect(screen.queryByRole('button', { name: '退出查看' })).toBeNull();
      expect(screen.getByText('已定位目标消息')).toBeInTheDocument();
      expect(document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="sent-text"]')?.style.visibility).toBe('');
      expect(document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="sent-reply-1"]')?.style.visibility).toBe('');
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
      await waitFor(() => expect(screen.queryByText('已定位目标消息')).toBeNull(), { timeout: 2500 });
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
      expect(mockApi.createMessage).toHaveBeenCalledOnce();
      expect(mockApi.createRelation).toHaveBeenCalledTimes(2);
      expect(mockNavigate).not.toHaveBeenCalled();
    } finally {
      transitions.disconnect();
      geometry.mockRestore();
      graphRendering.actual = false;
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
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await act(async () => mockGraphView.mock.lastCall![0].onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: sent.content } });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })));
      // The optimistic text is present in data, but its membership has not arrived.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });
      expect(screen.queryByText('已定位目标消息')).toBeNull();
      // Retrying placement must not expose an interactive gap before the new-message mask.
      expect(screen.getByRole('dialog', { name: '正在发送' })).toHaveTextContent('正在完成消息绘制和新消息定位');
      const workbench = screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）').closest<HTMLElement>('[aria-busy]')!;
      expect(workbench).toHaveAttribute('aria-busy', 'true');
      expect(workbench.inert).toBe(true);
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true });
      window.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      await act(async () => window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: [{
        scope: { messageId: 'classification-1', title: '测试分类' }, sequence: 2,
        messages: [sent, { ...makeMessage(join.id, ''), kind: 'RELATION', relationType: join.relationType,
          relSourceId: join.sourceMessageId, targetRefs: join.targetRefs }],
        relations: [join], users: [], stakes: {}, tagCounts: {}, attentionUsers: {},
      }] })));
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="delayed-text"]')).not.toBeNull());
      expect(document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="delayed-text"]')?.style.visibility).toBe('');
      expect(screen.getByText('已定位目标消息')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '正在发送' })).toBeNull());
      expect(document.querySelector('[data-message-jump-target="delayed-text"]')).not.toBeNull();
      expect(workbench).toHaveAttribute('aria-busy', 'false');
      expect(workbench.inert).toBe(false);
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
    } finally {
      geometry.mockRestore();
    }
  });

  it('keeps progress visible through two slow sends and enables each next send only after its own mask commits', async () => {
    localStorage.setItem('token', 'test-token');
    const sent = [makeMessage('slow-first', '第一条慢发送'), makeMessage('slow-second', '第二条慢发送')];
    const originalBatch = mockApi.withCommandBatch.getMockImplementation()!;
    mockApi.createMessage.mockReset().mockResolvedValueOnce(sent[0]).mockResolvedValueOnce(sent[1]);
    const commits: Array<() => void> = [];
    const commit = async (work: () => Promise<unknown>, onCommitted?: (count: number) => void) => {
      const result = await work();
      await new Promise<void>(resolve => commits.push(resolve));
      onCommitted?.(1);
      return result;
    };
    mockApi.withCommandBatch.mockImplementationOnce(commit).mockImplementationOnce(commit);
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    const view = render(<MessageWorkbenchPage />);
    const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    const frames = async (count = 12) => { for (let index = 0; index < count; index++) await tick(16); };
    try {
      const input = await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitFor(() => expect(input.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitFor(() => expect(document.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')).not.toBeNull());
      await waitFor(() => expect(input.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
      vi.useFakeTimers();
      const root = input.closest<HTMLElement>('[aria-busy]')!;
      const send = screen.getByRole('button', { name: '发送' });
      const preview = screen.getByRole('button', { name: '预览' });
      fireEvent.change(input, { target: { value: sent[0].content } });
      fireEvent.click(send); fireEvent.click(send);
      expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      await frames(3);
      expect(commits).toHaveLength(1);
      expect(mockApi.createMessage).toHaveBeenCalledOnce();
      expect(screen.queryByRole('button', { name: /收起进度|显示进度/ })).toBeNull();
      await tick(25_000);
      expect(root.inert).toBe(true);
      expect(send).toBeDisabled();
      expect(screen.getByRole('dialog', { name: '正在发送' })).toHaveTextContent('正在等待服务器确认发送');
      await act(async () => commits[0]());
      // Programmatic events also must not bypass the send guard while placement is pending.
      fireEvent.change(input, { target: { value: sent[1].content } });
      expect(send).toBeDisabled();
      expect(preview).toBeDisabled();
      fireEvent.click(preview);
      expect(mockApi.prepareCommandBatch).not.toHaveBeenCalled();
      expect(mockApi.previewCommandBatch).not.toHaveBeenCalled();
      fireEvent.click(send);
      expect(mockApi.createMessage).toHaveBeenCalledOnce();
      expect(root.inert).toBe(true);
      await frames();
      expect(document.querySelector('[data-message-jump-target="slow-first"]')).not.toBeNull();
      expect(root.inert).toBe(false);
      expect(send).toBeEnabled();
      expect(preview).toBeEnabled();
      fireEvent.click(send);
      await frames(3);
      expect(commits).toHaveLength(2);
      expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
      // The previous message's highlight expires while this request is still pending.
      await tick(10_000);
      expect(root.inert).toBe(true);
      expect(send).toBeDisabled();
      await act(async () => commits[1]());
      expect(root.inert).toBe(true);
      await frames();
      expect(document.querySelector('[data-message-jump-target="slow-second"]')).not.toBeNull();
      expect(root.inert).toBe(false);
      expect(mockApi.createMessage).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      view.unmount();
      vi.useRealTimers();
      geometry.mockRestore();
      mockApi.withCommandBatch.mockReset().mockImplementation(originalBatch);
    }
  });

  it('bounds a placement wait despite incoming updates, cancels late masks, and allows a fresh send after recovery', async () => {
    localStorage.setItem('token', 'test-token');
    const current: Relation = { ...makeRelation(), id: 'bounded-class', relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: 'msg-1' }], payload: { title: '等待测试分类' } };
    const sent = makeMessage('abandoned-placement', '归属迟迟未返回');
    const next = makeMessage('recovered-placement', '恢复后继续发送');
    mockApi.getRelations.mockResolvedValue({ data: [current] });
    mockApi.createMessage.mockReset().mockResolvedValueOnce(sent).mockResolvedValueOnce(next);
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    const view = render(<MessageWorkbenchPage />);
    const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    const frames = async (count = 12) => { for (let index = 0; index < count; index++) await tick(16); };
    const publish = async (sequence: number, records: Message[], joins: Relation[] = []) => act(async () => {
      window.dispatchEvent(new CustomEvent('gonglun:committed', { detail: [{
        scope: { messageId: 'classification-1', title: '测试分类' }, sequence,
        messages: [...records, ...joins.map(join => ({ ...makeMessage(join.id, ''), kind: 'RELATION', relationType: join.relationType,
          relSourceId: join.sourceMessageId, targetRefs: join.targetRefs }))],
        relations: joins, users: [], stakes: {}, tagCounts: {}, attentionUsers: {},
      }] }));
    });
    try {
      const input = await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitFor(() => expect(input.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
      await act(async () => mockGraphView.mock.lastCall![0].onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitFor(() => expect(document.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')).not.toBeNull());
      await waitFor(() => expect(input.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
      vi.useFakeTimers();
      const root = input.closest<HTMLElement>('[aria-busy]')!;
      fireEvent.change(input, { target: { value: sent.content } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await tick(0);
      expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
      await frames(3);
      for (let index = 0; index < 5; index++) {
        await tick(5000);
        await publish(index + 2, [sent]);
        expect(root.inert).toBe(true);
        expect(document.querySelector('[data-message-jump-overlay]')).toBeNull();
      }
      await tick(WORKBENCH_DRAWING_TIMEOUT_MS - 25_000 + 100);
      expect(root.inert).toBe(false);
      expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('超过 30 秒'))).toBe(true);
      expect(document.querySelector('[data-workbench-progress-active]')).toBeNull();
      const lateJoin: Relation = { ...makeRelation(), id: 'late-join', relationType: 'JOIN', sourceMessageId: current.id,
        targetRefs: [{ kind: 'message', messageId: sent.id }] };
      await publish(8, [sent], [lateJoin]);
      await frames();
      expect(document.querySelector('[data-message-jump-overlay]')).toBeNull();
      expect(root.inert).toBe(false);
      fireEvent.change(input, { target: { value: next.content } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await tick(0);
      expect(root.inert).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
      const nextJoin: Relation = { ...lateJoin, id: 'next-join', targetRefs: [{ kind: 'message', messageId: next.id }] };
      await publish(9, [next], [nextJoin]);
      await frames();
      expect(document.querySelector('[data-message-jump-target="recovered-placement"]')).not.toBeNull();
      expect(root.inert).toBe(false);
      expect(mockApi.createMessage).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
      geometry.mockRestore();
    }
  });

  it('keeps the trace view after sending a message outside the trace', async () => {
    localStorage.setItem('token', 'test-token');
    mockApi.createMessage.mockResolvedValueOnce(makeMessage('sent-outside-trace', '追溯中发送'));
    render(<MessageWorkbenchPage />);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    await act(async () => mockGraphView.mock.lastCall![0].onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    expect(screen.getByRole('button', { name: '退出追溯' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '追溯中发送' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })));
    await waitFor(()=>expect(mockApi.createMessage).toHaveBeenCalledWith('classification-1', expect.objectContaining({ content: '追溯中发送' })));
    await waitFor(() => expect(screen.queryByText('正在发送消息并更新关联结构，请稍候…')).toBeNull(), { timeout: 2000 });
    expect(screen.getByRole('button', { name: '退出追溯' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出追溯' }));
    expect(screen.queryByRole('button', { name: '退出追溯' })).toBeNull();
  });

  it('locates a sent message with its overlay only after a slow commit finishes', async () => {
    localStorage.setItem('token', 'test-token');
    let finishCommit!: () => void;
    mockApi.createMessage.mockResolvedValueOnce(makeMessage('sent-message', '发送后定位'));
    mockApi.withCommandBatch.mockImplementationOnce(async (work, onCommitted) => {
      await work();
      await new Promise<void>(resolve => { finishCommit = resolve; });
      window.dispatchEvent(new CustomEvent('gonglun:committed',{detail:[{
        scope:{messageId:'classification-1',title:'测试分类'},sequence:2,
        messages:[{...makeMessage('sent-message','发送后定位'),revision:1,sequence:2}],relations:[],users:[],stakes:{},tagCounts:{},attentionUsers:{},
      }]}));
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
      const textarea = await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      Object.defineProperties(panel, { clientHeight: { value: 500 }, scrollHeight: { value: 2000 } });
      fireEvent.change(textarea, { target: { value: '发送后定位' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(finishCommit).toBeDefined());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
      expect(screen.getByRole('dialog',{name:'正在发送'})).toBeInTheDocument();
      expect(screen.queryByText('已定位目标消息')).toBeNull();
      expect(panel.scrollTop).toBe(0);
      expect(mockApi.markReading).not.toHaveBeenCalled();
      await act(async () => finishCommit());
      await waitFor(() => expect(screen.getByText('已定位目标消息')).toBeInTheDocument());
      await waitFor(() => expect(screen.queryByText('正在等待服务器确认发送，请勿重复提交。')).toBeNull());
      await waitFor(() => expect(panel.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
      expect(panel.scrollTop).toBeGreaterThan(0);
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalled());
      expect(mockApi.markReading.mock.calls.flatMap(([marks]:any)=>marks)).toContainEqual(expect.objectContaining({
        messageId:'sent-message',scope:'message',signature:expect.stringMatching(/^display:1:/),version:bodyVersion('sent-message'),
        confirmation:{kind:'direct',messageId:'sent-message'},
      }));
    } finally {
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
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
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

  it.each(['left', 'right'].flatMap(side => [1, -1].map(direction => ({ side, direction }))))(
    'scrolls the active $side and hands its boundary remainder directly to the page (direction $direction)', async ({ side, direction }) => {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      const left = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const right = document.querySelector<HTMLElement>('[data-workbench-scroll-panel]')!;
      const current = side === 'left' ? left : right, other = side === 'left' ? right : left;
      const page = document.documentElement;
      const pageHeight = vi.spyOn(page, 'clientHeight', 'get').mockReturnValue(200);
      const pageContentHeight = vi.spyOn(page, 'scrollHeight', 'get').mockReturnValue(1000);
      [left, right].forEach(element => Object.defineProperties(element, {
        clientHeight: { value: 200 }, scrollHeight: { value: 1000 },
      }));
      const nested = document.createElement('div');
      nested.style.overflowY = 'auto';
      Object.defineProperties(nested, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
      current.append(nested);
      const wheel = (target: HTMLElement, amount: number) => {
        const event = new WheelEvent('wheel', { deltaY: direction * amount, bubbles: true, cancelable: true });
        act(() => { target.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(true);
      };
      const edge = direction > 0 ? 800 : 0;
      try {
        current.scrollTop = 400; other.scrollTop = 300; page.scrollTop = 400;
        wheel(current, 100);
        expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([400 + direction * 100, 300, 400]);
        current.scrollTop = edge - direction * 40;
        wheel(current, 100);
        expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge, 300, 400 + direction * 60]);
        wheel(current, -20);
        expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge - direction * 20, 300, 400 + direction * 60]);

        nested.scrollTop = current.scrollTop = edge - direction * 40; other.scrollTop = 300; page.scrollTop = 400;
        wheel(nested, 100);
        expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge, edge, 300, 400 + direction * 20]);
        wheel(nested, -20);
        expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge - direction * 20, edge, 300, 400 + direction * 20]);

        nested.scrollTop = current.scrollTop = edge;
        other.scrollTop = edge - direction * 10;
        wheel(nested, 40);
        expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge, edge, edge - direction * 10, 400 + direction * 60]);
        wheel(nested, -20);
        expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge - direction * 20, edge, edge - direction * 10, 400 + direction * 60]);
      } finally {
        page.scrollTop = 0;
        pageHeight.mockRestore(); pageContentHeight.mockRestore();
      }
    },
  );

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
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 400));
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
      await act(async () => mockGraphView.mock.lastCall![0].onMessageClick({ button: 0, stopPropagation: vi.fn() }, inner.id));
      fireEvent.click(screen.getByRole('button', { name: '分类' }));
      const textarea = screen.getByPlaceholderText('输入分类名称（不能为空）');
      fireEvent.change(textarea, { target: { value: '外层分类' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1', expect.objectContaining({
        relationType: 'CLASSIFY', targetRefs: [expect.objectContaining({ kind: 'relation', relationId: inner.id, reference: { messageId: inner.id,context:{kind:'MESSAGE'} } })],
      })));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '查看被加入消息（1条）' }));
      expect(screen.getByText('被加入记录临时分类（1）')).toBeInTheDocument();
      expect(document.querySelector('[data-msgid="join-inner"]')).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
      fireEvent.doubleClick(messageCanvas().getByText(outer.id));
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '查看加入消息（1条）' }));
      expect(screen.getByText('加入记录临时分类（1）')).toBeInTheDocument();
      expect(document.querySelector('[data-msgid="join-inner"]')).not.toBeNull();
    } finally { view.unmount(); geometry.mockRestore(); graphRendering.actual = false; }
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
    expect([...document.querySelectorAll('[data-container-join-records] [data-msgid]')].map(element=>element.getAttribute('data-msgid')).sort()).toEqual(joins.map(join=>join.id).sort());
  });

  it('prices a new classification and its member placements separately and submits both configurations',async()=>{
    localStorage.setItem('token','test-token');
    mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.createRelation.mockImplementation(async (_scope,data)=>({...makeRelation(),...data,id:'new-classification'}));
    render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    await waitForWorkbenchIdle();
    for(const id of ['msg-1','msg-2'])await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},id));
    fireEvent.click(screen.getByRole('button',{name:'分类'}));
    fireEvent.change(screen.getByPlaceholderText('输入分类名称（不能为空）'),{target:{value:'新建分类'}});
    expect(screen.getByText('分类消息 × 1')).toBeInTheDocument();
    expect(screen.getByText('加入消息 × 2')).toBeInTheDocument();
    for(const [label,value] of [['分类真假投入','2'],['分类价值投入','1'],['加入真假投入','4'],['加入价值投入','2']])
      fireEvent.change(screen.getByLabelText(label),{target:{value}});
    expect(screen.getByText(/本次 3 条消息，预计 18 点/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledTimes(1));
    expect(mockApi.createMessage).not.toHaveBeenCalled();
    expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1',expect.objectContaining({relationType:'CLASSIFY',wager:2,recommendation:1,joinContribution:{wager:4,recommendation:2},
      targetRefs:[expect.objectContaining({messageId:'msg-1'}),expect.objectContaining({messageId:'msg-2'})]}));
  });

  it('only shows and sends JOIN messages when adding several members to an existing classification',async()=>{
    localStorage.setItem('token','test-token');
    const container={...makeRelation(),id:'existing-classification',relationType:'CLASSIFY',sourceMessageId:null,targetRefs:[],payload:{title:'已有分类'}};
    mockApi.getRelations.mockResolvedValue({data:[container]});
    mockApi.createRelation.mockImplementation(async (_scope,data)=>({...makeRelation(),...data,id:'new-join-'+data.targetRefs[0].messageId}));
    render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    await waitForWorkbenchIdle();
    await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},container.id));
    fireEvent.click(screen.getByRole('button',{name:'加入来源集合'}));
    for(const id of ['msg-1','msg-2'])await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},id));
    fireEvent.click(screen.getByRole('button',{name:'分类'}));
    expect(screen.getByText('加入消息 × 2')).toBeInTheDocument();
    expect(screen.queryByText('分类消息 × 1')).toBeNull();
    fireEvent.change(screen.getByLabelText('加入真假投入'),{target:{value:'4'}});
    fireEvent.change(screen.getByLabelText('加入价值投入'),{target:{value:'2'}});
    expect(screen.getByText(/本次 2 条消息，预计 14 点/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledTimes(2));
    expect(mockApi.createMessage).not.toHaveBeenCalled();
    for(const [,data] of mockApi.createRelation.mock.calls)expect(data).toMatchObject({relationType:'JOIN',sourceMessageId:container.id,wager:4,recommendation:2});
  });

  it.each([['CLASSIFY','分类'],['SUMMARY','总结'],['ARRANGE','排列'],['MERGE','归并']])('recognizes an existing %s source before targets, sends only JOIN and preserves unsent text',async(type,label)=>{
    localStorage.setItem('token','test-token');
    const container:Relation={...makeRelation(),id:'existing-container',relationType:type,sourceMessageId:null,targetRefs:[],payload:{title:`已有${label}`}};
    mockApi.getRelations.mockResolvedValue({data:[container]});
    mockApi.createRelation.mockImplementation(async(_scope,data)=>({...makeRelation(),...data,id:'new-membership'}));
    render(<MessageWorkbenchPage/>);
    const input=await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    await waitForWorkbenchIdle();
    fireEvent.change(input,{target:{value:'尚未发送的正文'}});
    const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
    await act(async()=>latest().onMessageClick(event(),container.id));
    fireEvent.click(screen.getByRole('button',{name:'加入来源集合'}));
    fireEvent.click(screen.getByRole('button',{name:label}));
    const joinInput=screen.getByPlaceholderText('加入已有容器消息，此处不可输入');
    expect(joinInput).toHaveAttribute('readonly');
    expect(joinInput).toHaveValue('');
    expect(screen.getByRole('button',{name:'发送'})).toBeDisabled();
    expect(screen.getByText('请选择要加入已有容器的目标消息，此处不可输入')).toBeInTheDocument();
    expect(screen.queryByText('请输入消息内容')).toBeNull();
    await act(async()=>latest().onMessageClick(event(),'msg-1'));
    expect(screen.getByText('加入消息 × 1')).toBeInTheDocument();
    expect(screen.queryByText('文本消息 × 1')).toBeNull();
    expect(screen.queryByText(`${label}消息 × 1`)).toBeNull();
    expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledOnce());
    expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1',expect.objectContaining({relationType:'JOIN',sourceMessageId:container.id,
      targetRefs:[expect.objectContaining({messageId:'msg-1'})]}));
    expect(mockApi.createMessage).not.toHaveBeenCalled();
    await waitFor(()=>expect(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）')).toHaveValue('尚未发送的正文'));
  });

  it.each(['incoming','outgoing'].flatMap(direction=>[['CLASSIFY','分类'],['SUMMARY','总结'],['ARRANGE','排列'],['MERGE','归并']].map(([type,label])=>({direction:direction as 'incoming'|'outgoing',type,label}))))(
    'shows concrete container and target types in $direction $type records in both views',async({direction,type,label})=>{
      const container:Relation={...makeRelation(),id:'typed-container',relationType:type,sourceMessageId:null,targetRefs:[],payload:{title:`已有${label}`}};
      const target:Relation={...container,id:'typed-target',payload:{title:`目标${label}`}};
      const join:Relation={...makeRelation(),id:'typed-join',relationType:'JOIN',sourceMessageId:container.id,
        targetRefs:[{kind:'message',messageId:'msg-1'},{kind:'relation',relationId:target.id}]};
      mockApi.getRelations.mockResolvedValue({data:[container,target,join]});
      graphRendering.actual=true;
      const view=render(<MessageWorkbenchPage/>);
      try{
        await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
        await act(async()=>mockGraphView.mock.lastCall![0].onJoinFilterClick(direction==='incoming'?'msg-1':container.id,direction));
        await waitForWorkbenchIdle();
        expect(screen.getByText(`${direction==='incoming'?'加入':'被加入'}记录临时分类（1）`)).toBeInTheDocument();
        for(let mode=0;mode<2;mode++){
          const card=document.querySelector('[data-workbench-left-panel] [data-msgid="typed-join"]:not([data-rel-overlay])')!;
          expect(card).not.toBeNull();
          expect(card.querySelector('[data-join-endpoint-type="typed-container"]')).toHaveTextContent(`【${label}】ID：`);
          expect(card).not.toHaveTextContent('容器 ID：');
          expect(card.querySelector('[data-join-endpoint-type="typed-target"]')).toHaveTextContent(`【${label}】`);
          expect(card.querySelector('[data-join-endpoint-type="msg-1"]')).toHaveTextContent('【文本】');
          if(direction==='incoming')expect(card.querySelector('[data-join-target-self="msg-1"]')).toHaveTextContent('自身');
          else expect(card.querySelector('[data-join-target-self]')).toBeNull();
          expect(card.querySelector('[data-join-target-self="typed-target"]')).toBeNull();
          expect(within(card as HTMLElement).getByText('加入',{exact:true})).toBeInTheDocument();
          expect(card).not.toHaveTextContent('加入容器');
          if(mode===0){
            fireEvent.click(screen.getByRole('button',{name:direction==='incoming'?'切换为消息表':'切换为消息图'}));
            await waitForWorkbenchIdle();
          }
        }
      }finally{view.unmount();graphRendering.actual=false;}
    });

  it.each([false,true])('jumps from a traced text to its staged root classification (home excludes target: %s)',async(filtered)=>{
    const origin='cmv4klz1h0029md14splwe0vb',destination='5ee3510d-0cb1-412e-9ce1-2091100a9544';
    mockApi.getMessages.mockResolvedValue({data:[{...makeMessage(origin,'追溯起点'),createdBy:{...makeUser(),id:'other',username:'other'}}]});
    mockApi.getRelations.mockResolvedValue({data:[{...makeRelation(),id:destination,relationType:'CLASSIFY',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:origin}],createdBy:{...makeUser(),id:'other',username:'other'},payload:{title:'测试'}}]});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
      await act(async()=>latest().onNavigateToMessage(origin));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),destination));
      const staged=latest().draftUnits;
      if(filtered){
        fireEvent.click(screen.getByRole('button',{name:'主页'}));
        fireEvent.click(screen.getByRole('radio',{name:/^自发$/}));
        await screen.findByText('追溯范围内没有可见消息');
      }
      let sawLocation=false;
      const observer=new MutationObserver(()=>{if(document.querySelector(`[data-message-jump-region~="${destination}"]`))sawLocation=true;});
      observer.observe(document.body,{childList:true,subtree:true});
      fireEvent.click(screen.getByRole('button',{name:`跳转到暂存消息 ${destination}`}));
      await waitForWorkbenchIdle();
      observer.disconnect();expect(sawLocation).toBe(true);
      expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${destination}"]`)).not.toBeNull();
      expect(latest().draftUnits).toEqual(staged);
      expect(screen.getByRole('button',{name:'阅读后退'})).toBeEnabled();
      expect(screen.queryByRole('button',{name:'返回上一层追溯'})).toBeNull();
      expectReadingPath([destination]);
      expect(readingCurrentMessage(destination)).toBeInTheDocument();
      expect(document.querySelector('[role="alert"]')).toBeNull();
      if(filtered){
        expect(screen.getByRole('radio',{name:/^自发$/})).toBeChecked();
        fireEvent.click(screen.getByRole('button',{name:'阅读后退'}));await waitForWorkbenchIdle();
        expect(screen.getByText('追溯范围内没有可见消息')).toBeInTheDocument();
        expectReadingPath([origin]);
      }
    }finally{view.unmount();graphRendering.actual=false;geometry.mockRestore();}
  });

  it('jumps from a staged whole message into its classification and preserves the shared staging area',async()=>{
    const container:Relation={...makeRelation(),id:'outer-container',relationType:'CLASSIFY',sourceMessageId:null,
      targetRefs:[{kind:'message',messageId:'msg-1'}],payload:{title:'目标的外层分类'}};
    mockApi.getRelations.mockResolvedValue({data:[container]});
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const latest=()=>mockGraphView.mock.lastCall![0],event=()=>({button:0,stopPropagation:vi.fn()});
      await act(async()=>latest().onMessageDoubleClick(event(),container.id));await waitForWorkbenchIdle();
      await act(async()=>latest().onMessageClick(event(),'msg-1'));
      fireEvent.click(screen.getByRole('button',{name:'退出分类'}));await waitForWorkbenchIdle();
      const selections=latest().draftUnits;
      fireEvent.click(screen.getByRole('button',{name:'跳转到暂存消息 msg-1'}));
      await waitForWorkbenchIdle();
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]:not([data-rel-overlay])')).not.toBeNull();
      expect(screen.getByText('已定位目标消息')).toBeInTheDocument();
      expect(latest().draftUnits).toEqual(selections);
      expect(screen.getByRole('button',{name:'跳转到暂存消息 msg-1'})).toBeInTheDocument();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;geometry.mockRestore();}
  });

  it('groups two references into one pair of inputs while text and placement retain their own contributions',async()=>{
    localStorage.setItem('token','test-token');
    mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.createMessage.mockResolvedValue({...makeMessage('new-reference-body','同时引用'),revision:1});
    mockApi.createRelation.mockImplementation(async (_scope,data)=>({...makeRelation(),...data,id:'new-'+data.targetRefs[0].messageId}));
    render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    await waitForWorkbenchIdle();
    for(const id of ['msg-1','msg-2'])await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},id));
    fireEvent.click(screen.getByRole('button',{name:'引用'}));
    fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'),{target:{value:'同时引用'}});
    expect(screen.getByText('文本消息 × 1')).toBeInTheDocument();
    expect(screen.getByText('引用消息 × 2')).toBeInTheDocument();
    expect(screen.getByText('加入消息 × 1')).toBeInTheDocument();
    expect(screen.getAllByLabelText('引用真假投入')).toHaveLength(1);
    for(const [label,value] of [['真假投入','2'],['价值投入','1'],['引用真假投入','4'],['引用价值投入','3'],['加入真假投入','5'],['加入价值投入','2']])
      fireEvent.change(screen.getByLabelText(label),{target:{value}});
    expect(screen.getByText(/本次 4 条消息，预计 28 点/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledTimes(2));
    expect(mockApi.createMessage).toHaveBeenCalledWith('classification-1',expect.objectContaining({wager:2,recommendation:1,joinContribution:{wager:5,recommendation:2}}));
    for(const [,data] of mockApi.createRelation.mock.calls)expect(data).toMatchObject({relationType:'REFERENCE',wager:4,recommendation:3});
  });

  it('does not validate a hidden text contribution when only a classification and its placement will be sent',async()=>{
    render(<MessageWorkbenchPage/>);
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    fireEvent.change(screen.getByLabelText('真假投入'),{target:{value:''}});
    fireEvent.click(screen.getByRole('button',{name:'分类'}));
    fireEvent.change(screen.getByPlaceholderText('输入分类名称（不能为空）'),{target:{value:'独立分类'}});
    expect(screen.getByText('分类消息 × 1')).toBeInTheDocument();
    expect(screen.getByText('加入消息 × 1')).toBeInTheDocument();
    expect(screen.queryByText('文本消息 × 1')).toBeNull();
    expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
  });

  it('shows truth before value, rejects both zero and permits investing in both', async () => {
    localStorage.setItem('token','test-token');
    mockApi.createMessage.mockResolvedValue({...makeMessage('invested-message','同时投入'),revision:1});
    render(<MessageWorkbenchPage />);
    const textarea=await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    fireEvent.change(textarea,{target:{value:'同时投入'}});
    const truth=screen.getByLabelText('真假投入'),value=screen.getByLabelText('价值投入');
    const policy=screen.getByText('协议费 1 点/条').parentElement!;
    expect(policy).toHaveAttribute('data-contribution-policy','true');
    expect(policy.children).toHaveLength(2);
    expect(policy.children[1]).toHaveTextContent('每条消息的真假、价值至少一项大于 0');
    expect(policy).toHaveStyle({whiteSpace:'nowrap'});
    expect(policy.querySelector('input')).toBeNull();
    expect(policy.nextElementSibling).toContainElement(truth);
    expect(truth.compareDocumentPosition(value)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(truth,{target:{value:'0'}});
    fireEvent.change(value,{target:{value:'0'}});
    expect(screen.getByRole('button',{name:'发送'})).toBeDisabled();
    expect(screen.getByText('真假和价值至少一项须大于 0')).toBeInTheDocument();
    fireEvent.change(value,{target:{value:'2'}});
    expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
    fireEvent.change(truth,{target:{value:'3'}});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mockApi.createMessage).toHaveBeenCalledWith('classification-1',expect.objectContaining({wager:3,recommendation:2,selfAgree:true})));
  });

  it('refreshes both the protocol fee and estimated total when the rules change with the same account balance',async()=>{
    const getRules=mockApi.getCurrentRules.getMockImplementation()!;
    try{
      mockApi.getCurrentRules.mockResolvedValue({parameters:{minStake:1,stakeFeeAmount:1,moderation:{enabled:false}}});
      render(<MessageWorkbenchPage/>);
      fireEvent.change(await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）'),{target:{value:'协议费刷新'}});
      expect(await screen.findByText('协议费 1 点/条')).toBeInTheDocument();
      expect(screen.getByText(/本次 2 条消息，预计 4 点/)).toBeInTheDocument();
      mockApi.getCurrentRules.mockResolvedValue({parameters:{minStake:1,stakeFeeAmount:3,moderation:{enabled:false}}});
      await act(async()=>{window.dispatchEvent(new Event('points-refresh'));});
      expect(await screen.findByText('协议费 3 点/条')).toBeInTheDocument();
      expect(screen.getByText(/本次 2 条消息，预计 8 点/)).toBeInTheDocument();
    }finally{mockApi.getCurrentRules.mockImplementation(getRules);}
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

    const textarea = await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
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
    expect(mockApi.createMessage).toHaveBeenCalledWith('classification-1', expect.objectContaining({ wager: 1, recommendation: 0, selfAgree: true }));
  });

  it('traces the newly selected body part instead of a previously clicked message', async () => {
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('old','原先点击的消息'),makeMessage('new','刚选择的正文部件')]});
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(mockGraphView).toHaveBeenCalled());
    await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},'old'));
    fireEvent.click(screen.getByRole('button',{name:'清空'}));
    act(()=>window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT,{detail:{reference:{messageId:'new',revision:1,partId:'body'},label:'正文'}})));
    fireEvent.click(screen.getByRole('button',{name:'设为追溯消息'}));
    expectTraceOrigin('new');expectTraceOrigin('old',false);
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
      relationType: 'DISAGREE', targetRefs: [expect.objectContaining({ reference:{...reference,context:{kind:'MESSAGE',version:bodyVersion('msg-1',3)}} })], wager: 1, recommendation: 0,
    })));
  });

  it('restores the composer and optimistic cards when the atomic submission fails', async () => {
    mockApi.createMessage.mockResolvedValue({ ...makeMessage('uncommitted', '尚未提交'), revision: 1 });
    mockApi.withCommandBatch.mockImplementationOnce(async work => { await work(); throw new Error('整批提交失败'); });
    render(<MessageWorkbenchPage />);
    const textarea = await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    fireEvent.change(textarea, { target: { value: '尚未提交' } });
    fireEvent.change(screen.getByLabelText('价值投入'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('整批提交失败');
    expect(textarea).toHaveValue('尚未提交');
    expect(screen.getByLabelText('价值投入')).toHaveValue(4);
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
      const textarea = screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）');
      expect(textarea).not.toHaveAttribute('readonly');
    });

    fireEvent.click(screen.getByRole('button', { name: '清空' }));

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）');
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

  it('jumps directly into the current inner classification when an outer declaration still lists the merge', async () => {
    const stored = await mockApi.getRelations();
    const outer = stored.data.find((relation: Relation) => relation.id === 'rel-outer');
    outer.targetRefs.push({ kind: 'relation', relationId: 'rel-merge' });
    stored.data.push({ id: 'join-merge', relationType: 'JOIN', sourceMessageId: 'rel-inner',
      targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }], createdAt: '2024-01-01T00:05:00Z', createdBy: makeUser() });
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    await jumpToMessageId('rel-merge');
    await waitFor(() => expect(mockGraphView.mock.lastCall![0].messages.map((message: { id: string }) => message.id))
      .toEqual(expect.arrayContaining(['rel-merge', 'msg-a', 'msg-b'])));
    expect(screen.getByRole('button',{name:'退出分类'}).parentElement).toHaveTextContent('内层分类');
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
      expect(messageCanvas().getByText('rel-middle')).toBeInTheDocument();
    });
    expect(screen.queryByText('msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类 rel-inner')).not.toBeInTheDocument();

    fireEvent.doubleClick(messageCanvas().getByText('rel-middle'));
    await waitForWorkbenchIdle();

    const exitButton = await screen.findByRole('button', { name: '退出分类' });
    fireEvent.click(exitButton);
    await waitFor(() => {
      expect(messageCanvas().getByText('rel-middle')).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-classify')).toBeInTheDocument();
    });

    // Enter the classify classification
    fireEvent.doubleClick(screen.getByText('rel-classify'));

    await waitFor(() => {
      // The arrange relation message must be visible in the classification view
      expect(messageCanvas().getByText('rel-supp')).toBeInTheDocument();
    });
    // The arrange's source text (msg-a) must also be visible so its frame can render
    expect(screen.getByRole('group', { name: '消息 msg-a，未选中' })).toHaveTextContent('排列来源');
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

    fireEvent.click(await screen.findByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByText('rel-summary')).toBeInTheDocument();
    });

    // Enter the summary classification
    fireEvent.doubleClick(screen.getByText('rel-summary'));

    await waitFor(() => {
      expect(messageCanvas().getByText('rel-supp')).toBeInTheDocument();
    });
    expect(screen.getByRole('group', { name: '消息 msg-a，未选中' })).toHaveTextContent('排列来源');
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
    await waitForWorkbenchIdle();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    });
    // msg-orig (direct target) must be visible
    expect(screen.getByRole('group',{name:/^消息 msg-orig，/})).toBeInTheDocument();
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
    expect(screen.getByRole('group',{name:/^消息 msg-orig，/})).toBeInTheDocument();
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

  it('opens summary targets by default and keeps manual collapse reversible in trace', async () => {
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
      expect(ids.has('msg-orig')).toBe(true);
      expect(ids.has('msg-corr')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-summary')).toBe(true);
      expect(props.hideMessageIds?.has('rel-summary') ?? false).toBe(false);
    });

    const expandedProps = mockGraphView.mock.lastCall![0];
    await act(async()=>expandedProps.onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-summary'));
    await waitFor(()=>expect(mockGraphView.mock.lastCall![0].traceExpandedFrameIds.has('rel-summary')).toBe(false));
    await act(async()=>mockGraphView.mock.lastCall![0].onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-summary'));
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('msg-orig')).toBe(true);
      expect(ids.has('msg-corr')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-summary')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => {
      expect(screen.getByRole('group',{name:/^消息 msg-orig，/})).toBeInTheDocument();
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

  it('traces the classify relation as an expanded frame with direct reference text', async () => {
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
      expect(ids.has('frame-member-a')).toBe(true);
      expect(ids.has('frame-member-b')).toBe(true);
      expect(ids.has('external-text')).toBe(true);
      expect(props.traceFrameIds.has('rel-classify')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-classify')).toBe(true);
      expect(props.edges.map((edge: { relationMessageId: string }) => edge.relationMessageId)).toContain('rel-reference');
      expect(props.edges.some((edge:{relationMessageId:string})=>edge.relationMessageId==='rel-classify')).toBe(true);
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
    await waitFor(() => expect(latest().traceExpandedFrameIds.has('old-frame')).toBe(true));
    await waitFor(() => {
      expect(latest().messages.map((item: { id: string }) => item.id).sort()).toEqual(['old-frame', 'stayed']);
      expect(latest().edges.filter((item: { relationMessageId: string }) => item.relationMessageId === 'old-frame')
        .map((item: { to: { messageId: string } }) => item.to.messageId)).toEqual(['stayed']);
    });
  });

  it.each([false, true])('reaches an arrangement peer at distance two through a reference (JOINs: %s)', async withJoins => {
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
    await act(async () => latest().onMessageDoubleClick({ stopPropagation: vi.fn() }, 'A'));
    await waitFor(() => expect(ids()).toContain('B'));
    await act(async () => latest().onMessageDoubleClick({ stopPropagation: vi.fn() }, 'B'));
    await waitFor(() => expect(ids()).toContain('E'));
    act(() => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'E'));
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
    await waitFor(() => expect(ids()).toEqual(expect.arrayContaining(['A', 'B', 'E'])));
    await waitFor(() => {
      expect(ids()).toEqual(expect.arrayContaining(['B', 'C', 'D', 'E', 'ref']));
      expect(ids()).not.toContain('F');
    });
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    expect(screen.queryByText('正文 F')).not.toBeInTheDocument();
    stepTraceDistanceForTest(1);
    fireEvent.click(screen.getByRole('button', { name: '切换为消息图' }));
    await waitFor(() => expect(ids()).toContain('A'));
    await waitFor(() => expect(ids()).toContain('F'));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    await waitFor(() => expect(screen.getByText('正文 F')).toBeInTheDocument());
    stepTraceDistanceForTest(-1);
    await waitFor(() => expect(screen.queryByText('正文 F')).not.toBeInTheDocument());
  });

  it.each(['MERGE','SUMMARY','CLASSIFY','ARRANGE'])('respects distance changes around a %s in graph and list views', async type => {
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
    await waitFor(() => { expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(1); expect(ids()).not.toContain('far'); });
    stepTraceDistanceForTest(1);
    await waitFor(() => { expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(2); expect(ids().includes('far')).toBe(type==='ARRANGE'); });
    stepTraceDistanceForTest(-1);
    await waitFor(() => expect(ids()).not.toContain('far'));
    fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
    expect(screen.queryByText('正文 far')).not.toBeInTheDocument();
    stepTraceDistanceForTest(1);
    await waitFor(() => expect(screen.queryByText('正文 far')!==null).toBe(type==='ARRANGE'));
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
      expect(ids.has('rel-summary')).toBe(true);
      expect(ids.has('summary-member-a')).toBe(true);
      expect(ids.has('summary-member-b')).toBe(true);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-classify')).toBe(true);
    });

    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      expect(props.messages.some((message: { id: string }) => message.id === 'rel-summary')).toBe(true);
    });
    const expandedParentProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    expandedParentProps.onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-summary');
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('summary-member-a')).toBe(false);
      expect(ids.has('summary-member-b')).toBe(false);
      expect(props.traceExpandedFrameIds.has('rel-summary')).toBe(false);
      expect(props.traceExpandedFrameIds.has('rel-classify')).toBe(true);
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
      expect(ids.has('rel-a')).toBe(true);
      expect(ids.has('rel-c')).toBe(true);
    });

    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('rel-c')).toBe(true);
      expect(ids.has('rel-b')).toBe(true);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-b')).toBe(true);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-c')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-b')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-c')).toBe(true);
      expect(props.traceExpandedFrameIds.has('rel-e')).toBe(false);
    });
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('msg-d')).toBe(true);
      expect(ids.has('rel-e')).toBe(true);
      expect(ids.has('msg-f')).toBe(true);
      expect(props.edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-e')).toBe(true);
    });
  });

  it('opens a nested classify and its summary parent together by default', async () => {
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
      expect(props.traceExpandedFrameIds).toEqual(new Set(['rel-summary','rel-classify']));
      expect(props.messages.some((message: { id: string }) => message.id === 'rel-classify')).toBe(true);
    });
    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const ids = new Set(props.messages.map((message: { id: string }) => message.id));
      expect(ids.has('rel-classify')).toBe(true);
      expect(ids.has('classify-member')).toBe(true);
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

  it.each(['graph', 'list'] as const)('shows the exited classification mask in %s without recentering its saved viewport', async mode => {
    graphRendering.actual = true;
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 120, 300, 140));
    const dimensions = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(3000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
    ];
    try {
      render(<MessageWorkbenchPage />);
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      await waitFor(() => expect(panel.querySelector('[data-msgid="rel-classify"]')).not.toBeNull());
      panel.scrollTop = 480; panel.scrollLeft = 90;
      fireEvent.doubleClick(panel.querySelector('[data-msgid="rel-classify"]')!);
      await waitForWorkbenchIdle();
      await waitFor(() => expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('测试分类'));
      panel.scrollTop = 150; panel.scrollLeft = 20;
      fireEvent.click(screen.getByRole('button', { name: '退出分类' }));
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="rel-classify"]')).not.toBeNull());
      expect([panel.scrollTop, panel.scrollLeft]).toEqual([480, 90]);
      expect(document.querySelector('[data-message-jump-target="rel-classify"]')).not.toBeNull();
    } finally { geometry.mockRestore(); dimensions.forEach(spy => spy.mockRestore()); graphRendering.actual = false; }
  });

  it.each(['graph','list'] as const)('restores the original %s mode and all scroll positions without loading known messages again',async originalMode=>{
    const descriptors=Object.getOwnPropertyDescriptor(document,'scrollingElement');
    Object.defineProperty(document,'scrollingElement',{configurable:true,value:document.documentElement});
    const dimensions=[
      vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockReturnValue(3000),
      vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(600),
    ];
    try{
      render(<MessageWorkbenchPage/>);
      await waitFor(()=>expect(mockGraphView).toHaveBeenCalled());
      await waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      if(originalMode==='list')fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));
      const left=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const right=document.querySelector<HTMLElement>('.workbench-right-panel')!;
      const page=document.documentElement;
      left.scrollTop=480;left.scrollLeft=90;
      right.scrollTop=140;right.scrollLeft=40;
      page.scrollTop=800;page.scrollLeft=30;
      const requests=mockApi.getWorkbenchSnapshot.mock.calls.length;
      const latest=()=>mockGraphView.mock.lastCall![0];
      if(originalMode==='list')fireEvent.doubleClick(screen.getByText('rel-classify'));
      else await act(async()=>latest().onMessageDoubleClick({button:0,stopPropagation:vi.fn()},'rel-classify'));
      await waitForWorkbenchIdle();
      expect(left.scrollTop).toBe(0);
      expect(page.scrollTop).toBe(0);
      // Changes made inside the category must not replace its origin snapshot.
      left.scrollTop=210;left.scrollLeft=55;page.scrollTop=300;
      fireEvent.click(screen.getByRole('button',{name:originalMode==='list'?'切换为消息图':'切换为消息表'}));
      await act(async()=>latest().onMessageClick({button:0,stopPropagation:vi.fn()},'msg-a'));
      left.scrollTop=50;left.scrollLeft=10;
      right.scrollTop=70;right.scrollLeft=5;
      page.scrollTop=90;page.scrollLeft=0;
      fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
      expect(screen.getByRole('button',{name:originalMode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
      await waitFor(()=>expect([left.scrollTop,left.scrollLeft,right.scrollTop,right.scrollLeft,page.scrollTop,page.scrollLeft]).toEqual([480,90,140,40,800,30]));
      // The former delayed centering ran at 150ms and overwrote restored scroll.
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,200));});
      expect([left.scrollTop,left.scrollLeft,right.scrollTop,right.scrollLeft,page.scrollTop,page.scrollLeft]).toEqual([480,90,140,40,800,30]);
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(requests);
      expect(mockApi.subscribeChanges).toHaveBeenCalledOnce();
      expect(mockNavigate).not.toHaveBeenCalled();
      if(originalMode==='graph')expect(latest().messages.map((message:Message)=>message.id)).toContain('msg-c');
      else expect(screen.getByText('msg-c')).toBeInTheDocument();
    }finally{
      dimensions.forEach(spy=>spy.mockRestore());
      if(descriptors)Object.defineProperty(document,'scrollingElement',descriptors);
      else Reflect.deleteProperty(document,'scrollingElement');
    }
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
    await waitForWorkbenchIdle();

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
      expect(messageCanvas().getByText('rel-classify')).toBeInTheDocument();
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
    await waitForWorkbenchIdle();
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
    expect(screen.getAllByText('msg-a').length).toBeGreaterThan(0);
    expect(screen.queryByText('msg-c')).not.toBeInTheDocument();
  });
});

describe('MessageWorkbenchPage trace and temporary view history', () => {
  const cases = ['trace', 'join-incoming', 'join-outgoing', 'comparison', 'correction', 'trace-through-join', 'join-through-trace'].flatMap(flow =>
    (['graph', 'list'] as const).filter(mode => !['correction', 'trace-through-join', 'join-through-trace'].includes(flow) || mode === 'graph').flatMap(mode =>
      [false, true].map(offline => ({ flow, mode, offline }))));
  beforeEach(() => { vi.clearAllMocks(); });

  it.each(cases)('restores $flow from $mode after background resumes (offline=$offline)', async ({ flow, mode, offline }) => {
    const relation = (id: string, relationType: string, targets: string[], sourceMessageId: string | null = null): Relation => ({
      id, relationType, sourceMessageId, targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
      payload: { title: `${id}标题` }, createdAt: '2024-01-01T00:00:00.000Z', createdBy: makeUser(),
    });
    mockApi.getScope.mockResolvedValue({ messageId: 'classification-1', title: '测试分类' });
    mockApi.getMessages.mockResolvedValue({ data: ['m1', 'm2', 'replacement', 'outside'].map(id => makeMessage(id, `${id}正文`)) });
    mockApi.getRelations.mockResolvedValue({ data: [
      relation('outer', 'CLASSIFY', ['inner']), relation('inner', 'SUMMARY', ['m1', 'm2']),
      relation('reference', 'REFERENCE', ['m1'], 'm2'), relation('join', 'JOIN', ['m1'], 'inner'),
      relation('correction', 'CORRECT', ['m1'], 'replacement'),
    ] });
    const originalSnapshot = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const initial = await originalSnapshot({ parent: 'classification-1' });
    initial.sequence = 100;
    let sequence = 100, changes: Message[] = [], hidden = false;
    mockApi.getWorkbenchSnapshot.mockImplementation(async ({ after }: { after?: number }) => after === undefined ? initial : {
      ...initial, sequence, messages: after < sequence ? changes : [], relations: [], users: [],
    });
    if (offline) viewerRoute.archive = {
      formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '阅览文件' },
      view: { username: 'tester', mode: 'graph', classificationId: 'outer', messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] },
      messages: initial.messages.map((message: Message) => ({ ...message, kind: message.kind ?? 'TEXT', contentType: message.contentType ?? null, content: message.content ?? null, authorId: message.createdBy.id, author: message.createdBy.username })),
      relations: initial.relations.map((record: Relation) => ({ ...record, payload: record.payload ?? null, authorId: record.createdBy.id, author: record.createdBy.username, supersededBy: null })),
    };
    const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const scrollingElement = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement });
    const dimensions = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(3000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
    ];
    try {
      render(<MessageWorkbenchPage />);
      const latest = () => mockGraphView.mock.lastCall![0];
      const event = () => ({ button: 0, stopPropagation: vi.fn() });
      const paint = () => act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      await waitFor(() => expect(latest()?.messages.length).toBeGreaterThan(0));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      if (!offline) await act(async () => latest().onMessageDoubleClick(event(), 'outer'));
      const sourceScope = flow === 'join-outgoing' ? 'outer' : 'inner';
      if (sourceScope === 'inner') await act(async () => latest().onMessageDoubleClick(event(), 'inner'));
      if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await paint();
      const left = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const right = document.querySelector<HTMLElement>('.workbench-right-panel')!;
      const page = document.documentElement;
      const readScroll = () => [left.scrollTop, left.scrollLeft, right.scrollTop, right.scrollLeft, page.scrollTop, page.scrollLeft];
      const writeScroll = (offset: number) => {
        left.scrollTop = 480 + offset; left.scrollLeft = 90 + offset;
        right.scrollTop = 140 + offset; right.scrollLeft = 40 + offset;
        page.scrollTop = 800 + offset; page.scrollLeft = 30 + offset;
        return readScroll();
      };
      const select = async (id: string, list: boolean) => {
        if (list) fireEvent.click(left.querySelector(`[data-msgid="${id}"]`)!);
        else await act(async () => latest().onMessageClick(event(), id));
      };
      const traceMode = flow.startsWith('trace');
      const joinIncoming = flow === 'join-incoming' || flow === 'join-through-trace';
      if (traceMode) await select('m2', mode === 'list');
      const originScroll = writeScroll(0);
      const beforeEntry = mockApi.getWorkbenchSnapshot.mock.calls.length;
      if (traceMode) fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
      else if (flow === 'comparison') fireEvent.click(screen.getByRole('button', { name: '对比' }));
      else if (flow === 'correction') await act(async () => latest().onInlineBadgeDoubleClick(event(), 'correction'));
      else if (mode === 'list') fireEvent.click(within(left).getByRole('button', { name: flow === 'join-incoming' ? '查看加入消息（1条）' : '查看被加入消息（1条）' }));
      else await act(async () => latest().onJoinFilterClick(joinIncoming ? 'm1' : 'inner', joinIncoming ? 'incoming' : 'outgoing'));
      const exitName = traceMode ? '退出追溯' : flow === 'comparison' ? '退出对比' : '退出临时分类';
      const exit = () => traceMode ? screen.getByRole('button', { name: exitName })
        : within(document.querySelector<HTMLElement>('[data-workbench-view-toolbar]')!).getByRole('button', { name: exitName });
      expect(exit()).toBeInTheDocument();
      const transientList = flow === 'comparison' || flow === 'correction' || flow === 'join-outgoing' || mode === 'list';
      if (traceMode) {
        stepTraceDistanceForTest(1);
        expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(2);
        fireEvent.click(screen.getByRole('button', { name: '清空' }));
        await select('replacement', transientList);
        fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
        expectTraceOrigin('replacement');
      }
      if (flow === 'trace-through-join') await act(async () => latest().onJoinFilterClick('m1', 'incoming'));
      if (flow.endsWith('through-trace') || flow.endsWith('through-join')) {
        fireEvent.click(screen.getByRole('button', { name: '清空' }));
        await select('join', false);
        fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
      }
      if (flow === 'trace' && mode === 'graph') {
        const frameId = [...latest().traceFrameIds][0] as string;
        expect(frameId).toBeDefined();
        if (latest().traceExpandedFrameIds.has(frameId)) await act(async () => latest().onMessageDoubleClick(event(), frameId));
        await act(async () => latest().onGroupFrameDoubleClick(event(), frameId));
        const expanded = [...latest().traceExpandedFrameIds];
        expect(expanded).toContain(frameId);
        await paint();
        const traceScroll = writeScroll(50);
        await act(async () => latest().onJoinFilterClick('m1', 'incoming'));
        fireEvent.click(screen.getByRole('button', { name: '清空' }));
        await select('join', false);
        fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
        expectTraceOrigin('join');
        fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
        expectTraceOrigin('replacement');
        expect([...latest().traceExpandedFrameIds]).toEqual(expanded);
        await waitFor(() => expect(readScroll()).toEqual(traceScroll));
      }
      await paint();
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(beforeEntry);
      const transientScroll = writeScroll(100);
      const readIds = () => transientList
        ? Array.from(left.querySelectorAll('[data-msgid]')).map(element => element.getAttribute('data-msgid'))
        : latest().messages.map((message: Message) => message.id);
      const transientIds = readIds();
      const transientLabel = traceMode ? null : exit().parentElement!.textContent;
      for (const changed of [false, true]) {
        const beforeResume = mockApi.getWorkbenchSnapshot.mock.calls.length;
        act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
        await paint();
        expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(beforeResume);
        if (changed && !offline) {
          sequence++;
          changes = [{ ...initial.messages.find((message: Message) => message.id === 'm2')!, content: 'm2后台更新正文', revision: 2 }];
        }
        act(() => {
          hidden = false;
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('focus'));
          window.dispatchEvent(new Event('pageshow'));
        });
        if (!offline) await waitFor(() => expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(beforeResume + 1));
        await paint();
        expect(readScroll()).toEqual(transientScroll);
        expect(readIds()).toEqual(transientIds);
        if (transientLabel) expect(exit().parentElement).toHaveTextContent(transientLabel);
        if (traceMode) {
          expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(2);
          expectTraceOrigin(flow === 'trace-through-join' ? 'join' : 'replacement');
        }
      }
      const beforeExit = mockApi.getWorkbenchSnapshot.mock.calls.length;
      const stagedBeforeExit = latest().draftUnits;
      fireEvent.click(exit());
      expect(screen.getByRole('button', { name: sourceScope === 'inner' ? '退出总结' : '退出分类' }).parentElement).toHaveTextContent(`${sourceScope}标题`);
      expect(screen.getByRole('button', { name: mode === 'graph' ? '切换为消息表' : '切换为消息图' })).toBeInTheDocument();
      await waitFor(() => expect(readScroll()).toEqual(originScroll));
      await paint();
      expect(readScroll()).toEqual(originScroll);
      expect(latest().draftUnits).toEqual(stagedBeforeExit);
      expect(screen.queryByRole('spinbutton',{name:'向上追溯距离'})).toBeNull();
      if (sourceScope === 'inner') {
        if (mode === 'graph') expect(latest().messages.find((message: Message) => message.id === 'm2')?.content).toBe(offline ? 'm2正文' : 'm2后台更新正文');
        else expect(left.querySelector('[data-msgid="m2"]')).toHaveTextContent(offline ? 'm2正文' : 'm2后台更新正文');
        fireEvent.click(screen.getByRole('button', { name: '退出总结' }));
        expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('outer标题');
      }
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(beforeExit);
      expect(mockApi.getWorkbenchSnapshot.mock.calls.filter(([query]) => query.after === undefined)).toHaveLength(offline ? 0 : 1);
      expect(mockApi.subscribeChanges).toHaveBeenCalledTimes(offline ? 0 : 1);
      expect(mockNavigate).not.toHaveBeenCalled();
    } finally {
      viewerRoute.archive = null;
      visibility.mockRestore();
      dimensions.forEach(spy => spy.mockRestore());
      mockApi.getWorkbenchSnapshot.mockImplementation(originalSnapshot);
      if (scrollingElement) Object.defineProperty(document, 'scrollingElement', scrollingElement);
      else Reflect.deleteProperty(document, 'scrollingElement');
    }
  });
});

describe('MessageWorkbenchPage rapid mixed view navigation', () => {
  const cases = ['CLASSIFY', 'SUMMARY'].flatMap(outerType => (['graph', 'list'] as const).flatMap(mode =>
    [false, true].map(offline => ({ outerType, mode, offline }))));
  beforeEach(() => { vi.clearAllMocks(); });

  it.each(cases)('keeps every origin through rapid $outerType/trace/temporary transitions from $mode (offline=$offline)', async ({ outerType, mode, offline }) => {
    // Also exercise the real graph's measurement and overlay cancellation in
    // the online and offline graph cases, alongside the list-view cases.
    graphRendering.actual = outerType === 'CLASSIFY' && mode === 'graph';
    const innerType = outerType === 'CLASSIFY' ? 'SUMMARY' : 'CLASSIFY';
    const relation = (id: string, relationType: string, targets: string[], sourceMessageId: string | null = null): Relation => ({
      id, relationType, sourceMessageId, targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
      payload: { title: `${id}标题` }, createdAt: '2024-01-01T00:00:00.000Z', createdBy: makeUser(),
    });
    mockApi.getScope.mockResolvedValue({ messageId: 'classification-1', title: '初始画布' });
    mockApi.getMessages.mockResolvedValue({ data: ['root-member', 'outer-member', 'm1', 'm2'].map(id => makeMessage(id, `${id}正文`)) });
    mockApi.getRelations.mockResolvedValue({ data: [
      relation('outer', outerType, ['inner', 'outer-member']), relation('inner', innerType, ['m1', 'm2']),
      relation('reference', 'REFERENCE', ['m1'], 'm2'), relation('join', 'JOIN', ['m2'], 'inner'),
    ] });
    const originalSnapshot = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const initial = await originalSnapshot({ parent: 'classification-1' });
    initial.sequence = 100;
    let sequence = 100, hidden = false;
    const updated = { ...initial.messages.find((message: Message) => message.id === 'm2')!, content: 'm2后台更新正文', revision: 2 };
    mockApi.getWorkbenchSnapshot.mockImplementation(async ({ after }: { after?: number }) => after === undefined ? initial : {
      ...initial, sequence, messages: after < sequence ? [updated] : [], relations: [], users: [],
    });
    if (offline) viewerRoute.archive = {
      formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '初始画布' },
      view: { username: 'tester', mode, classificationId: null, messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] },
      messages: initial.messages.map((message: Message) => ({ ...message, kind: message.kind ?? 'TEXT', contentType: message.contentType ?? null, content: message.content ?? null, authorId: message.createdBy.id, author: message.createdBy.username })),
      relations: initial.relations.map((record: Relation) => ({ ...record, payload: record.payload ?? null, authorId: record.createdBy.id, author: record.createdBy.username, supersededBy: null })),
    };
    const scrollingElement = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement });
    const dimensions = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(3000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
    ];
    const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    // Hold browser frames while still allowing React events and synchronization.
    // Each new navigation must cancel old callbacks before frames resume.
    const nativeFrame = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
    const held = new Map<number, FrameRequestCallback>();
    let hold = false;
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const id = nativeFrame(time => { if (hold) held.set(id, callback); else callback(time); });
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { held.delete(id); nativeCancel(id); });
    const release = async () => {
      hold = false;
      await act(async () => { const callbacks = [...held.values()]; held.clear(); callbacks.forEach(callback => callback(performance.now())); });
    };
    try {
      render(<MessageWorkbenchPage />);
      const latest = () => mockGraphView.mock.lastCall![0];
      const event = () => ({ button: 0, stopPropagation: vi.fn() });
      const paint = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      await waitFor(() => expect(latest()?.messages.length).toBeGreaterThan(0));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      let currentMode: 'graph' | 'list' = offline ? mode : 'graph';
      const setMode = async (next: 'graph' | 'list') => {
        if (next !== currentMode) fireEvent.click(screen.getByRole('button', { name: next === 'list' ? '切换为消息表' : '切换为消息图' }));
        currentMode = next;
        await paint();
      };
      await setMode(mode);
      const left = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const right = document.querySelector<HTMLElement>('.workbench-right-panel')!;
      const page = document.documentElement;
      const readScroll = () => [left.scrollTop, left.scrollLeft, right.scrollTop, right.scrollLeft, page.scrollTop, page.scrollLeft];
      const writeScroll = (depth: number) => {
        left.scrollTop = 400 + depth * 200; left.scrollLeft = 50 + depth * 20;
        right.scrollTop = 100 + depth * 90; right.scrollLeft = 20 + depth * 10;
        page.scrollTop = 700 + depth * 250; page.scrollLeft = 10 + depth * 5;
        return readScroll();
      };
      const enter = async (id: string) => {
        if (!hold) {
          if (currentMode === 'graph') await act(async () => latest().onMessageDoubleClick(event(), id));
          else fireEvent.doubleClick(left.querySelector(`[data-msgid="${id}"]`)!);
          await waitForWorkbenchIdle();
          return;
        }
        // Let the new category's preparation paint while retaining later scroll
        // callbacks. Holding every frame would deadlock the navigation itself.
        let opening: void | Promise<void> = undefined;
        if (currentMode === 'graph') act(() => { opening = latest().onMessageDoubleClick(event(), id); });
        else fireEvent.doubleClick(left.querySelector(`[data-msgid="${id}"]`)!);
        const type = id === 'outer' ? outerType : innerType;
        const entered = () => screen.queryByRole('button', { name: type === 'SUMMARY' ? '退出总结' : '退出分类' })?.parentElement?.textContent?.includes(`${id}标题`);
        for (let count = 0; count < 20 && !entered(); count++) {
          await act(async () => {
            await new Promise<void>(resolve => nativeFrame(() => resolve()));
            const callbacks = [...held.values()]; held.clear();
            callbacks.forEach(callback => callback(performance.now()));
          });
        }
        expect(entered()).toBe(true);
        await act(async () => { await opening; });
      };
      const select = async (id: string) => {
        if (currentMode === 'graph') await act(async () => latest().onMessageClick(event(), id));
        else fireEvent.click(left.querySelector(`[data-msgid="${id}"]`)!);
      };
      const exitCategory = (type: string) => fireEvent.click(screen.getByRole('button', { name: type === 'SUMMARY' ? '退出总结' : '退出分类' }));
      const expectPosition = async (scroll: number[], expectedMode: 'graph' | 'list') => {
        currentMode = expectedMode;
        expect(screen.getByRole('button', { name: expectedMode === 'graph' ? '切换为消息表' : '切换为消息图' })).toBeInTheDocument();
        await release();
        await waitFor(() => expect(readScroll()).toEqual(scroll));
        await paint();
        expect(readScroll()).toEqual(scroll);
      };

      const rootScroll = writeScroll(0);
      await enter('outer');
      const outerMode = mode === 'graph' ? 'list' : 'graph';
      await setMode(outerMode);
      const outerScroll = writeScroll(1);
      await enter('inner');
      await setMode(mode);
      await select('m2');
      const innerScroll = writeScroll(2);
      fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
      await setMode('graph');
      stepTraceDistanceForTest(1);
      await paint();
      const traceScroll = writeScroll(3);
      await act(async () => latest().onJoinFilterClick('m2', 'incoming'));
      writeScroll(4);
      fireEvent.click(screen.getByRole('button', { name: '清空' }));
      await select('join');
      fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));

      hold = true;
      fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
      expectTraceOrigin('m2');
      // Re-enter before the previous layer's saved scroll has been applied.
      for (let repeat = 0; repeat < 3; repeat++) {
        await act(async () => latest().onJoinFilterClick('m2', 'incoming'));
        fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
      }
      const beforeResume = mockApi.getWorkbenchSnapshot.mock.calls.length;
      let resumes = 0;
      const resume = async (changed = false) => {
        const before = mockApi.getWorkbenchSnapshot.mock.calls.length;
        const pausedScroll = readScroll();
        act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
        // Backgrounding cancels paint callbacks; the positioning task waits until visible again.
        expect(graphRendering.tasks!.pending).toBeGreaterThan(0);
        expect(readScroll()).toEqual(pausedScroll);
        expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(before);
        const previousSequence = sequence;
        if (changed && !offline) sequence++;
        act(() => {
          hidden = false;
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('focus'));
          window.dispatchEvent(new Event('pageshow'));
        });
        if (!offline) {
          await waitFor(() => expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(before + 1));
          expect(mockApi.getWorkbenchSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({ after: previousSequence });
        }
        resumes++;
      };
      await resume(true);
      await expectPosition(traceScroll, 'graph');
      expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(2);
      expectTraceOrigin('m2');

      hold = true;
      fireEvent.click(screen.getByRole('button', { name: '退出追溯' }));
      currentMode = mode;
      for (let repeat = 0; repeat < 3; repeat++) {
        fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
        fireEvent.click(screen.getByRole('button', { name: '退出追溯' }));
      }
      await resume();
      await expectPosition(innerScroll, mode);
      expect(screen.getByRole('button', { name: innerType === 'SUMMARY' ? '退出总结' : '退出分类' }).parentElement).toHaveTextContent('inner标题');

      hold = true;
      exitCategory(innerType);
      currentMode = outerMode;
      for (let repeat = 0; repeat < 3; repeat++) {
        await enter('inner');
        exitCategory(innerType);
      }
      await resume();
      await expectPosition(outerScroll, outerMode);
      expect(screen.getByRole('button', { name: outerType === 'SUMMARY' ? '退出总结' : '退出分类' }).parentElement).toHaveTextContent('outer标题');

      hold = true;
      exitCategory(outerType);
      currentMode = mode;
      for (let repeat = 0; repeat < 3; repeat++) {
        await enter('outer');
        exitCategory(outerType);
      }
      await resume();
      await expectPosition(rootScroll, mode);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
      expect(readScroll()).toEqual(rootScroll);
      expect(screen.queryByRole('spinbutton',{name:'向上追溯距离'})).toBeNull();
      expect(screen.queryByRole('button', { name: '退出临时分类' })).toBeNull();
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(beforeResume + (offline ? 0 : resumes));
      expect(mockApi.getWorkbenchSnapshot.mock.calls.filter(([query]) => query.after === undefined)).toHaveLength(offline ? 0 : 1);
      expect(mockApi.subscribeChanges).toHaveBeenCalledTimes(offline ? 0 : 1);
      expect(mockNavigate).not.toHaveBeenCalled();

      await enter('outer');
      await enter('inner');
      await setMode('graph');
      for (const id of ['m1', 'm2']) expect(latest().messages.filter((message: Message) => message.id === id)).toHaveLength(1);
      expect(latest().messages.find((message: Message) => message.id === 'm2')?.content).toBe(offline ? 'm2正文' : 'm2后台更新正文');
    } finally {
      hold = false;
      held.clear();
      frame.mockRestore(); cancel.mockRestore();
      graphRendering.actual = false;
      viewerRoute.archive = null;
      visibility.mockRestore();
      dimensions.forEach(spy => spy.mockRestore());
      mockApi.getWorkbenchSnapshot.mockImplementation(originalSnapshot);
      if (scrollingElement) Object.defineProperty(document, 'scrollingElement', scrollingElement);
      else Reflect.deleteProperty(document, 'scrollingElement');
    }
  }, 15_000);
});

describe('MessageWorkbenchPage nested classification and summary view history', () => {
  const cases = [
    ['CLASSIFY', 'CLASSIFY', 'CLASSIFY'],
    ['SUMMARY', 'SUMMARY', 'SUMMARY'],
    ['CLASSIFY', 'SUMMARY', 'CLASSIFY'],
    ['SUMMARY', 'CLASSIFY', 'SUMMARY'],
  ].flatMap(types => (['graph', 'list'] as const).map(mode => ({ types, mode, path: types.join(' / ') })));

  beforeEach(() => { vi.clearAllMocks(); });

  it('reopens the same archive with its original view and no selections from the previous visit', async () => {
    viewerRoute.archive = {
      formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '重新阅览' },
      messages: [{ ...makeMessage('saved', '原文件的正文'), authorId: 'user-1', author: 'tester' }],
      relations: [], view: { username: 'tester', mode: 'graph', classificationId: null,
        messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] },
    };
    viewerRoute.key = 'first-visit';
    const latest = () => mockGraphView.mock.lastCall?.[0];
    try {
      const view = render(<MessageWorkbenchPage />);
      await waitFor(() => expect(latest()?.messages.map((message: Message) => message.id)).toEqual(['saved']));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'saved'));
      expect(latest().draftUnits).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      expect(screen.getByRole('button', { name: '切换为消息图' })).toBeInTheDocument();
      viewerRoute.key = 'second-visit';
      view.rerender(<MessageWorkbenchPage />);
      expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: '切换为消息表' })).toBeInTheDocument());
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      expect(latest().draftUnits).toEqual([]);
      expect(latest().messages.map((message: Message) => message.id)).toEqual(['saved']);
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled();
    } finally { viewerRoute.archive = null; viewerRoute.key = ''; }
  });

  it('reopens the actual last category after exiting a saved category and preserves a resumed parent path', async () => {
    const relations: Relation[] = ['outer', 'inner'].map(id => ({
      id, relationType: 'CLASSIFY', sourceMessageId: null,
      targetRefs: id === 'outer' ? [{ kind: 'relation', relationId: 'inner' }] : [{ kind: 'message', messageId: 'member' }],
      payload: { title: id }, createdAt: '2024-01-01T00:00:00.000Z', createdBy: makeUser(),
    }));
    viewerRoute.archive = { formatVersion: 5, exportedAt: '', scope: { messageId: null, title: '分类位置回归' },
      view: { username: 'tester', mode: 'graph', classificationId: 'inner', messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] },
      messages: [{ ...makeMessage('member', ''), authorId: 'user-1', author: 'tester' },
        ...relations.map(relation => ({ ...relation, kind: 'RELATION', contentType: 'TEXT', content: '', relationPayload: relation.payload, authorId: 'user-1', author: 'tester' }))],
      relations: relations.map(relation => ({ ...relation, payload: relation.payload ?? null, authorId: 'user-1', author: 'tester', supersededBy: null })),
    };
    viewerRoute.key = 'position-first';
    const saved = vi.spyOn(exportViewerCache, 'saveExportNavigation').mockResolvedValue();
    const view = render(<MessageWorkbenchPage />);
    const header = () => screen.getByRole('button', { name: '退出分类' }).parentElement!;
    const reopen = async (key: string) => {
      fireEvent.click(screen.getByRole('button', { name: '退出阅览' }));
      viewerRoute.navigation = saved.mock.lastCall![1]; viewerRoute.key = key;
      view.rerender(<MessageWorkbenchPage />); await waitForWorkbenchIdle();
    };
    try {
      await waitFor(() => expect(header()).toHaveTextContent('inner')); await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '退出分类' })); await waitForWorkbenchIdle();
      await reopen('position-root');
      expect(screen.queryByRole('button', { name: '退出分类' })).toBeNull();
      expect(viewerRoute.navigation).toEqual({ classificationId: null, classificationPath: [] });
      for (const id of ['outer', 'inner']) {
        await act(async () => mockGraphView.mock.lastCall![0].onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, id));
        await waitForWorkbenchIdle();
      }
      await reopen('position-inner');
      expect(header()).toHaveTextContent('inner');
      expect(viewerRoute.navigation).toEqual({ classificationId: 'inner', classificationPath: ['outer', 'inner'] });
      fireEvent.click(screen.getByRole('button', { name: '退出分类' })); await waitForWorkbenchIdle();
      expect(header()).toHaveTextContent('outer');
      await reopen('position-parent');
      expect(header()).toHaveTextContent('outer');
      expect(viewerRoute.archive.view!.classificationId).toBe('inner');
    } finally { view.unmount(); saved.mockRestore(); viewerRoute.archive = null; viewerRoute.key = ''; viewerRoute.navigation = null; }
  });

  it.each(['CLASSIFY', 'SUMMARY'].flatMap(type => (['graph', 'list'] as const).map(mode => ({ type, mode }))))('returns to the exported starting $type in $mode after leaving its child', async ({ type, mode }) => {
    const relations: Relation[] = ['outer', 'inner'].map(id => ({
      id, relationType: type, sourceMessageId: null,
      targetRefs: id === 'outer' ? [{ kind: 'relation', relationId: 'inner' }] : [{ kind: 'message', messageId: 'member' }],
      payload: { title: `${id}保存的标题` }, createdAt: '2024-01-01T00:00:00.000Z', createdBy: makeUser(),
    }));
    viewerRoute.archive = {
      formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '阅览文件' },
      view: { username: 'tester', mode, classificationId: 'outer', messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] },
      messages: [
        { ...makeMessage('member', '保存的成员正文'), authorId: 'user-1', author: 'tester' },
        ...relations.map(relation => ({ ...relation, kind: 'RELATION', contentType: 'TEXT', content: '', relationPayload: relation.payload, authorId: 'user-1', author: 'tester' })),
      ],
      relations: relations.map(relation => ({ ...relation, payload: relation.payload ?? null, authorId: 'user-1', author: 'tester', supersededBy: null })),
    };
    const dimensions = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600),
    ];
    let hidden = false;
    const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    try {
      render(<MessageWorkbenchPage />);
      const exitName = type === 'SUMMARY' ? '退出总结' : '退出分类';
      const header = () => screen.getByRole('button', { name: exitName }).parentElement!;
      await waitFor(() => expect(header()).toHaveTextContent('outer保存的标题'));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      const left = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      left.scrollTop = 650;
      if (mode === 'graph') await act(async () => mockGraphView.mock.lastCall![0].onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, 'inner'));
      else fireEvent.doubleClick(within(left).getByText('inner'));
      await waitForWorkbenchIdle();
      expect(header()).toHaveTextContent('inner保存的标题');
      fireEvent.click(screen.getByRole('button', { name: mode === 'graph' ? '切换为消息表' : '切换为消息图' }));
      act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
      act(() => {
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
      });
      fireEvent.click(screen.getByRole('button', { name: exitName }));
      expect(header()).toHaveTextContent('outer保存的标题');
      expect(screen.getByRole('button', { name: mode === 'graph' ? '切换为消息表' : '切换为消息图' })).toBeInTheDocument();
      await waitFor(() => expect(left.scrollTop).toBe(650));
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled();
      expect(mockApi.subscribeChanges).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    } finally {
      viewerRoute.archive = null;
      dimensions.forEach(spy => spy.mockRestore());
      visibility.mockRestore();
    }
  });

  it.each(cases)('restores every level of $path from $mode after background updates without reloading messages', async ({ types, mode }) => {
    const scopes = ['outer', 'middle', 'inner'].map((id, depth) => ({ id, title: `第${depth + 1}层标题`, type: types[depth] }));
    const members = ['base-member', 'outer-member', 'middle-member', 'inner-member'];
    mockApi.getScope.mockResolvedValue({ messageId: 'classification-1', title: '测试分类' });
    mockApi.getMessages.mockResolvedValue({ data: members.map(id => makeMessage(id, `${id}原始正文`)) });
    mockApi.getRelations.mockResolvedValue({ data: scopes.map((scope, depth): Relation => ({
      id: scope.id, relationType: scope.type, sourceMessageId: null,
      targetRefs: [
        ...(scopes[depth + 1] ? [{ kind: 'relation' as const, relationId: scopes[depth + 1].id }] : []),
        { kind: 'message', messageId: members[depth + 1] },
      ],
      payload: { title: scope.title }, createdAt: '2024-01-01T00:00:00.000Z', createdBy: makeUser(),
    })) });
    const originalSnapshot = mockApi.getWorkbenchSnapshot.getMockImplementation()!;
    const initial = await originalSnapshot({ parent: 'classification-1' });
    let sequence = 100;
    initial.sequence = sequence;
    let changes: Message[] = [];
    mockApi.getWorkbenchSnapshot.mockImplementation(async ({ after }: { after?: number }) => after === undefined ? initial : {
      ...initial, sequence, messages: after < sequence ? changes : [], relations: [], users: [],
    });
    let hidden = false;
    const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const scrollingElement = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement });
    const dimensions = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(3000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
    ];
    try {
      render(<MessageWorkbenchPage />);
      const latest = () => mockGraphView.mock.lastCall![0];
      await waitFor(() => expect(latest()?.messages.some((message: Message) => message.id === 'outer')).toBe(true));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      const left = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const right = document.querySelector<HTMLElement>('.workbench-right-panel')!;
      const page = document.documentElement;
      const readScroll = () => [left.scrollTop, left.scrollLeft, right.scrollTop, right.scrollLeft, page.scrollTop, page.scrollLeft];
      const writeScroll = (depth: number) => {
        left.scrollTop = 400 + depth * 100; left.scrollLeft = 80 + depth * 10;
        right.scrollTop = 120 + depth * 50; right.scrollLeft = 30 + depth * 5;
        page.scrollTop = 700 + depth * 150; page.scrollLeft = 20 + depth * 10;
        return readScroll();
      };
      const paint = () => act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      let currentMode: 'graph' | 'list' = 'graph';
      const setMode = async (next: 'graph' | 'list') => {
        if (next !== currentMode) {
          fireEvent.click(screen.getByRole('button', { name: next === 'list' ? '切换为消息表' : '切换为消息图' }));
          currentMode = next;
          await paint();
        }
      };
      const header = () => screen.getByRole('button', { name: /^退出(分类|总结)$/ }).parentElement!;
      const expectVisibleOnce = (id: string, content?: string) => {
        if (currentMode === 'graph') {
          const records = latest().messages.filter((message: Message) => message.id === id);
          expect(records).toHaveLength(1);
          if (content) expect(records[0].content).toBe(content);
        } else {
          expect(within(left).getAllByText(id)).toHaveLength(1);
          if (content) expect(left.querySelector(`[data-msgid="${id}"]`)).toHaveTextContent(content);
        }
      };
      const resume = async (memberId: string, title: string) => {
        const scroll = readScroll(), before = mockApi.getWorkbenchSnapshot.mock.calls.length;
        act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
        await paint();
        expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(before);
        changes = [{ ...initial.messages.find((message: Message) => message.id === memberId)!, content: `${memberId}后台更新正文`, revision: 2 }];
        const previousSequence = sequence++;
        act(() => {
          hidden = false;
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('focus'));
          window.dispatchEvent(new Event('pageshow'));
        });
        await waitFor(() => expectVisibleOnce(memberId, changes[0].content));
        expect(header()).toHaveTextContent(title);
        expect(readScroll()).toEqual(scroll);
        expect(mockApi.getWorkbenchSnapshot.mock.calls.slice(before)).toHaveLength(1);
        expect(mockApi.getWorkbenchSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({ after: previousSequence });
      };

      await setMode(mode);
      const saved: Array<{ mode: 'graph' | 'list'; scroll: number[] }> = [];
      for (let depth = 0; depth < scopes.length; depth++) {
        const scope = scopes[depth];
        saved.push({ mode: currentMode, scroll: writeScroll(depth) });
        const before = mockApi.getWorkbenchSnapshot.mock.calls.length;
        expectVisibleOnce(scope.id);
        if (currentMode === 'graph') await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, scope.id));
        else fireEvent.doubleClick(within(left).getByText(scope.id));
        await waitForWorkbenchIdle();
        expect(header()).toHaveTextContent(scope.title);
        expect(screen.getByRole('button', { name: scope.type === 'SUMMARY' ? '退出总结' : '退出分类' })).toBeInTheDocument();
        await setMode(currentMode === 'graph' ? 'list' : 'graph');
        await paint();
        expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(before);
      }
      writeScroll(3);
      await resume('inner-member', scopes[2].title);

      for (let depth = scopes.length - 1; depth >= 0; depth--) {
        const before = mockApi.getWorkbenchSnapshot.mock.calls.length;
        fireEvent.click(screen.getByRole('button', { name: scopes[depth].type === 'SUMMARY' ? '退出总结' : '退出分类' }));
        currentMode = saved[depth].mode;
        expect(screen.getByRole('button', { name: currentMode === 'graph' ? '切换为消息表' : '切换为消息图' })).toBeInTheDocument();
        await waitFor(() => expect(readScroll()).toEqual(saved[depth].scroll));
        const title = depth ? scopes[depth - 1].title : '测试分类';
        expect(header()).toHaveTextContent(title);
        expectVisibleOnce(scopes[depth].id);
        expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(before);
        await resume(members[depth], title);
      }
      // Earlier levels' deltas must survive subsequent catch-ups and exits too.
      const beforeReentry = mockApi.getWorkbenchSnapshot.mock.calls.length;
      for (const [depth, scope] of scopes.entries()) {
        if (currentMode === 'graph') await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, scope.id));
        else fireEvent.doubleClick(within(left).getByText(scope.id));
        await waitForWorkbenchIdle();
        expectVisibleOnce(members[depth + 1], `${members[depth + 1]}后台更新正文`);
      }
      // Exit again before the preceding layer's restoration has had a frame to
      // run. A cancelled inner restoration must never overwrite the root view.
      for (let depth = scopes.length - 1; depth >= 0; depth--) {
        fireEvent.click(screen.getByRole('button', { name: scopes[depth].type === 'SUMMARY' ? '退出总结' : '退出分类' }));
      }
      await waitFor(() => expect(readScroll()).toEqual(saved[0].scroll));
      await paint();
      expect(readScroll()).toEqual(saved[0].scroll);
      expect(header()).toHaveTextContent('测试分类');
      expectVisibleOnce('base-member', 'base-member后台更新正文');
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(beforeReentry);
      expect(mockApi.getWorkbenchSnapshot.mock.calls.filter(([query]) => query.after === undefined)).toHaveLength(1);
      expect(mockApi.subscribeChanges).toHaveBeenCalledOnce();
      expect(mockNavigate).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
      dimensions.forEach(spy => spy.mockRestore());
      mockApi.getWorkbenchSnapshot.mockImplementation(originalSnapshot);
      if (scrollingElement) Object.defineProperty(document, 'scrollingElement', scrollingElement);
      else Reflect.deleteProperty(document, 'scrollingElement');
    }
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
    await waitForWorkbenchIdle();

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
    expect(screen.getByRole('group',{name:/^消息 m3，/})).toBeInTheDocument();
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

  it('opens an inactive annotation card in approval viewing mode and restores its rejected state on exit',async()=>{
    render(<MessageWorkbenchPage/>);
    await waitFor(()=>expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    fireEvent.click(await screen.findByRole('button',{name:'切换为消息表'}));
    await waitFor(()=>expect(screen.getByText('rel-classify')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText('rel-classify'));
    await waitFor(()=>expect(screen.getAllByText('rel-annotation').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button',{name:'切换为消息图'}));
    const latest=()=>mockGraphView.mock.calls.at(-1)![0];
    await waitFor(()=>expect(latest().rejectedRelationIds.has('rel-annotation')).toBe(true));
    act(()=>latest().onMessageDoubleClick({stopPropagation:vi.fn()},'rel-annotation'));
    await waitFor(()=>{
      expect(latest().comparisonSingle).toBe(true);expect(latest().comparisonDisplay).toBe('agree');
      expect(screen.getByText('消息效果查看')).toBeInTheDocument();
      expect(latest().rejectedRelationIds.has('rel-annotation')).toBe(false);
      expect(latest().edges.some((edge:{relationMessageId:string})=>edge.relationMessageId==='rel-annotation')).toBe(true);
    });
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    await waitFor(()=>{
      expect(latest().comparisonSingle).toBe(false);expect(latest().rejectedRelationIds.has('rel-annotation')).toBe(true);
      expect(latest().edges.some((edge:{relationMessageId:string})=>edge.relationMessageId==='rel-annotation')).toBe(false);
    });
    expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
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

  it('expands classify contents in the agree frame and releases them without that frame on disagree', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    await screen.findByRole('button', { name: '对比' });
    await waitForWorkbenchIdle();

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
      expect(agreeIds.has('inside-a')).toBe(true);
      expect(agreeIds.has('inside-b')).toBe(true);
      expect(props.comparisonAgreeContext.expandedFrameIds.has('rel-classify-preview')).toBe(true);
      expect(props.comparisonDisagreeContext.expandedFrameIds.has('rel-classify-preview')).toBe(false);
      expect(agreeIds.has('rel-join-preview')).toBe(false);
      expect(agreeIds.has('round-preview')).toBe(false);
      expect(props.comparisonDisagreeSuppressedRelIds.has('rel-classify-preview')).toBe(true);
      expect(props.comparisonDisagreeSuppressedRelIds.has('rel-annotation-preview')).toBe(true);
      expect(disagreeIds.has('rel-classify-preview')).toBe(true);
      expect(disagreeIds.has('rel-annotation-preview')).toBe(false);
      expect((props.comparisonDisagreeEdges ?? []).some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-classify-preview')).toBe(false);
      expect((props.comparisonDisagreeEdges ?? []).some((edge: { relationMessageId: string }) => edge.relationMessageId === 'rel-annotation-preview')).toBe(false);
      expect(disagreeIds.has('inside-a')).toBe(true);
      expect(disagreeIds.has('inside-b')).toBe(true);
      expect(disagreeIds.has('rel-join-preview')).toBe(false);
      expect(disagreeIds.has('round-preview')).toBe(false);
    });
  });

  it('reviews an owned relation only after entering its classification view', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockApi.getScope).toHaveBeenCalledWith('classification-1'));
    await screen.findByRole('button', { name: '对比' });
    await waitForWorkbenchIdle();

    fireEvent.click(screen.getByRole('button', { name: '对比' }));
    await waitForWorkbenchIdle();
    expect(document.querySelector('[data-workbench-left-panel] [data-msgid="rel-annotation-preview"]')).toBeNull();
    expect(screen.getByText('选择对比消息（1）')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '退出对比' })[0]);
    await waitForWorkbenchIdle();
    await act(async () => mockGraphView.mock.lastCall![0].onMessageDoubleClick({ stopPropagation: vi.fn() }, 'rel-classify-preview'));
    await waitForWorkbenchIdle();
    fireEvent.click(screen.getByRole('button', { name: '对比' }));
    await waitForWorkbenchIdle();
    const card = document.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="rel-annotation-preview"]:not([data-rel-overlay])');
    expect(card).not.toBeNull();
    fireEvent.click(card!);
    await waitFor(() => expect(screen.getByRole('button', { name: '审阅' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '审阅' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '退出分类' })).toBeNull();
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      expect(props.comparisonAgreeContext.expandedFrameIds.has('rel-classify-preview')).toBe(true);
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
    await screen.findByRole('button', { name: '对比' });
    await waitForWorkbenchIdle();

    fireEvent.click(screen.getByRole('button', { name: '对比' }));
    await waitFor(() => expect(screen.getByText('rel-reference')).toBeInTheDocument());
    fireEvent.click(screen.getByText('rel-reference'));
    fireEvent.click(screen.getByRole('button', { name: '审阅' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '设为追溯消息' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));

    await waitFor(() => {
      const props = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
      const disagreeIds = new Set((props.comparisonDisagreeMessages ?? []).map((message: { id: string }) => message.id));
      expect(screen.getByRole('spinbutton',{name:'向上追溯距离'})).toHaveValue(1);
      expect(disagreeIds.has('rel-reference')).toBe(true);
      expect(disagreeIds.has('reference-source')).toBe(true);
      expect(disagreeIds.has('reference-target')).toBe(true);
    });
  });
});

describe('unified send preview integration',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();sessionStorage.clear();localStorage.setItem('user',JSON.stringify(makeUser()));localStorage.setItem('token','test-token');
    graphRendering.actual=false;
    const message={...makeMessage('msg-1','原正文'),revision:1,parts:[{id:'body',type:'text' as const,text:'原正文'}]};
    const snapshot={scope:{messageId:'classification-1',title:'测试分类'},messages:[message],relations:[],users:[makeUser()],stakes:{},tagCounts:{},attentionUsers:{},sequence:1};
    mockApi.getScope.mockResolvedValue(snapshot.scope);mockApi.getMessages.mockResolvedValue({data:[message]});mockApi.getRelations.mockResolvedValue({data:[]});
    mockApi.getWorkbenchSnapshot.mockResolvedValue(snapshot);
    mockApi.prepareCommandBatch.mockImplementation((work,previous,reviewContext)=>prepareCommandBatch(work,{apiBase:'/api',reviewContext},previous));
    mockApi.createMessage.mockImplementation(async(parent,body)=>queueCommand('/messages',{method:'POST',body:JSON.stringify({...body,parentMessageId:parent})}));
    mockApi.createRelation.mockImplementation(async(parent,body)=>queueCommand('/relations',{method:'POST',body:JSON.stringify({...body,parentMessageId:parent})}));
    mockApi.previewCommandBatch.mockImplementation(async prepared=>({snapshots:[{...snapshot,messages:[],sequence:2}],baseSequence:1,messageIds:prepared.envelope.commands.map((command:{id:string})=>command.id)}));
    mockApi.confirmCommandPreview.mockResolvedValue({snapshots:[{...snapshot,messages:[],sequence:2}]});
  });

  it.each(['empty','zero contribution','over budget','missing review verdict','protected summary member'])(
    'disables both send and preview for %s without preparing a command',async(reason)=>{
    if(reason==='protected summary member'){
      const summary:Relation={...makeRelation(),id:'protected-summary',relationType:'SUMMARY',sourceMessageId:null,
        targetRefs:[{kind:'message',messageId:'msg-1'},{kind:'message',messageId:'msg-2'}],payload:{title:'完整总结'}};
      mockApi.getWorkbenchSnapshot.mockResolvedValue({scope:{messageId:'classification-1',title:'测试分类'},sequence:1,
        messages:[makeMessage('msg-1','受保护的成员'),makeMessage('msg-2','另一个成员'),{...makeMessage(summary.id,''),kind:'RELATION',relationType:'SUMMARY',targetRefs:summary.targetRefs,relationPayload:summary.payload}],
        relations:[summary],users:[makeUser()],stakes:{},tagCounts:{},attentionUsers:{}});
    }
    const view=render(<MessageWorkbenchPage/>);
    try{
      const input=await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(reason==='zero contribution'||reason==='over budget'){
        fireEvent.change(input,{target:{value:'暂不可发送的草稿'}});
        fireEvent.change(screen.getByLabelText('真假投入'),{target:{value:reason==='zero contribution'?'0':'1000'}});
      }else if(reason==='missing review verdict'){
        await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},'msg-1'));
        fireEvent.click(screen.getByRole('button',{name:/运营$/}));fireEvent.click(screen.getByRole('button',{name:'审核'}));
      }else if(reason==='protected summary member'){
        await act(async()=>mockGraphView.mock.lastCall![0].onMessageDoubleClick({button:0,stopPropagation:vi.fn()},'protected-summary'));
        await waitForWorkbenchIdle();
        await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},'msg-1'));
        fireEvent.click(screen.getByRole('button',{name:'分类'}));
        fireEvent.change(screen.getByPlaceholderText('输入分类名称（不能为空）'),{target:{value:'不允许拆分成员'}});
        expect(screen.getByText(/不能拆分已有容器/)).toBeVisible();
      }
      expect(screen.getByRole('button',{name:'发送'})).toBeDisabled();
      const preview=screen.getByRole('button',{name:'预览'});expect(preview).toBeDisabled();fireEvent.click(preview);
      expect(mockApi.prepareCommandBatch).not.toHaveBeenCalled();expect(mockApi.previewCommandBatch).not.toHaveBeenCalled();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{view.unmount();}
  });

  it.each(['pass','reject'].flatMap(verdict=>['graph','list'].flatMap(mode=>[false,true].map(inReview=>({verdict,mode,inReview})))))(
    'keeps the $verdict review preview in the same discussion region after confirmation ($mode, inReview=$inReview)',async({verdict,mode,inReview})=>{
    const summary={caseId:'preview-review-case',messageId:'msg-1',revision:1,round:1,status:'pending' as const,fee:6,deposit:10,pass:10,reject:0,reviewerCount:0,releaseAt:null,finalized:false};
    const target={...receivedMessage('msg-1','原正文'),revision:1,parts:[{id:'body',type:'text' as const,text:'原正文'}],moderation:summary};
    const after={...summary,pass:verdict==='pass'?12:10,reject:verdict==='reject'?2:0,reviewerCount:1};
    const reason=verdict==='pass'?'理由':'';
    let created:Relation|undefined,committed=false;
    const page=(sequence:number)=>({scope:{messageId:'classification-1',title:'测试分类'},sequence,
      messages:[{...target,moderation:created?after:summary},...created?[{...makeMessage(created.id,reason),kind:'RELATION',revision:1,parts:created.parts,relationType:'REVIEW',targetRefs:created.targetRefs,relationPayload:created.payload}]:[]],
      relations:created?[created]:[],users:[makeUser()],stakes:{},tagCounts:{},attentionUsers:{}});
    mockApi.getWorkbenchSnapshot.mockResolvedValue(page(1));
    mockApi.getReview.mockImplementation(async()=>({summary:committed?after:summary,target:{...target,moderation:committed?after:summary},records:committed&&created?[created]:[],canReview:true,canAppeal:false,canSettle:false,policy:DEFAULT_MODERATION_POLICY}));
    mockApi.previewCommandBatch.mockImplementation(async prepared=>{
      const command=prepared.envelope.commands[0];
      created={...makeRelation(),id:command.id,revision:1,relationType:'REVIEW',sourceMessageId:null,targetRefs:command.body.targetRefs,payload:command.body.payload,
        parts:[...(reason?[{id:'body',type:'text' as const,text:reason}]:[]),{id:'review',type:'relation',relation:'review',roles:{target:[{id:'target',reference:{messageId:target.id,revision:1}}]}},{id:'data',type:'data',value:command.body.payload}]};
      return {snapshots:[page(2)],baseSequence:1,messageIds:[command.id]};
    });
    mockApi.confirmCommandPreview.mockImplementationOnce(async()=>{
      committed=true;const snapshots=[page(3)];
      window.dispatchEvent(new CustomEvent('gonglun:committed',{detail:snapshots}));
      return {snapshots};
    });
    graphRendering.actual=true;
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,120,600,400));
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(inReview){
        act(()=>window.dispatchEvent(new CustomEvent('gonglun:open-review',{detail:{messageId:target.id,revision:1}})));
        await screen.findByText(/审核临时分类（1 条被审核消息/);await waitForWorkbenchIdle();
      }
      await act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},target.id));
      if(mode==='list'){fireEvent.click(screen.getByRole('button',{name:'切换为消息表'}));await waitForWorkbenchIdle();}
      fireEvent.click(screen.getByRole('button',{name:/运营$/}));fireEvent.click(screen.getByRole('button',{name:'审核'}));
      fireEvent.click(screen.getByRole('button',{name:verdict==='pass'?'审核通过':'审核不通过'}));
      fireEvent.change(screen.getByPlaceholderText('填写审核理由（可选，保存在审核关系消息中）'),{target:{value:reason}});
      fireEvent.click(screen.getByRole('button',{name:'预览'}));
      await waitFor(()=>expect(screen.getByRole('button',{name:'确认发送'})).toBeEnabled());
      await waitForWorkbenchIdle();
      expect(mockApi.confirmCommandPreview).not.toHaveBeenCalled();
      expect(screen.queryByRole('region',{name:'审核理由汇总'})).not.toBeInTheDocument();
      const card=()=>view.container.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${created!.id}"]:not([data-rel-overlay])`)!;
      await waitFor(()=>expect(card()).not.toBeNull());
      expect(card().querySelector('[data-message-type-detail="verdict"]')).toHaveTextContent(verdict==='pass'?'通过':'不通过');
      if(reason)expect(card()).toHaveTextContent(reason);
      if(!inReview){
        fireEvent.click(screen.getByRole('button',{name:'退出预览'}));await waitForWorkbenchIdle();
        expect(screen.queryByText(/审核临时分类（1 条被审核消息/)).toBeNull();
        expect(card()).toBeNull();
        expect(screen.getByPlaceholderText('填写审核理由（可选，保存在审核关系消息中）')).toHaveValue(reason);
        fireEvent.click(screen.getByRole('button',{name:'预览'}));
        await waitFor(()=>expect(screen.getByRole('button',{name:'确认发送'})).toBeEnabled());await waitForWorkbenchIdle();
        expect(card()).not.toBeNull();
      }
      const preview=mockGraphView.mock.lastCall![0];
      if(mode==='graph'){
        expect(preview.edges).toEqual(expect.arrayContaining([expect.objectContaining({relationMessageId:created!.id,relationType:`review-${verdict}`})]));
        expect(preview.messages.find((message:Message)=>message.id===target.id).moderation).toEqual(after);
      }
      const command=mockApi.previewCommandBatch.mock.calls[0][0].envelope.commands[0];
      expect(command.body.parentMessageId).toBe(inReview?'root':'classification-1');
      expect(command.body.reviewContext).toEqual(inReview?{messageId:target.id,revision:1}:undefined);
      fireEvent.click(screen.getByRole('button',{name:'确认发送'}));
      expect(await screen.findByText(/审核临时分类（1 条被审核消息/)).toBeVisible();
      await waitForWorkbenchIdle();expect(mockApi.confirmCommandPreview).toHaveBeenCalledOnce();
      expect(card().querySelector('[data-message-type-detail="verdict"]')).toHaveTextContent(verdict==='pass'?'通过':'不通过');
      if(mode==='graph'){
        expect(mockGraphView.mock.lastCall![0].edges).toEqual(preview.edges);
        expect(mockGraphView.mock.lastCall![0].messages.find((message:Message)=>message.id===target.id).moderation).toEqual(after);
      }
      else expect(screen.getByRole('button',{name:'切换为消息图'})).toBeVisible();
      if(!inReview){
        fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));await waitForWorkbenchIdle();
        expect(screen.queryByText(/审核临时分类（1 条被审核消息/)).toBeNull();
      }
    }finally{view.unmount();geometry.mockRestore();graphRendering.actual=false;}
  });

  it.each(['draft', 'target'].flatMap(collection => ['whole-first', 'fragment-first'].map(order => ({ collection, order }))))(
    'blocks conflicting correction targets in $collection ($order) while retaining both reference targets', async ({ collection, order }) => {
    const view = render(<MessageWorkbenchPage />), latest = () => mockGraphView.mock.lastCall![0];
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      await waitForWorkbenchIdle();
      const selectWhole = () => act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
      const selectFragment = () => act(async () => window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT, {
        detail: { reference: { messageId: 'msg-1', revision: 1, partId: 'body', range: { start: 0, end: 1 } }, label: '原' },
      })));
      if (order === 'whole-first') { await selectWhole(); await selectFragment(); }
      else { await selectFragment(); await selectWhole(); }
      const selected = latest().draftUnits;
      expect(selected).toHaveLength(2);
      if (collection === 'target') fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: '修改后的正文' } });
      fireEvent.click(screen.getByRole('button', { name: '更正' }));
      expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '预览' })).toBeDisabled();
      expect(screen.getByText('更正每次只能选择一个目标，请移除多余的整条消息、字段或片段')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
      if (collection === 'draft') expect(latest().draftUnits).toEqual(selected);
      else expect(screen.getAllByRole('button', { name: /^目标消息 / })).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: '引用' }));
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: '预览' }));
      await waitFor(() => expect(mockApi.previewCommandBatch).toHaveBeenCalledOnce());
      const prepared = mockApi.previewCommandBatch.mock.calls[0][0];
      const targets = prepared.envelope.commands.flatMap((command: { body: { relationType?: string; targetRefs?: unknown[] } }) =>
        command.body.relationType === 'REFERENCE' ? command.body.targetRefs ?? [] : []);
      expect(targets).toHaveLength(2);
      expect(targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'message', messageId: 'msg-1', reference: expect.objectContaining({ messageId: 'msg-1' }) }),
        expect.objectContaining({ kind: 'text-fragment', messageId: 'msg-1', reference: expect.objectContaining({ messageId: 'msg-1', revision: 1, partId: 'body', range: { start: 0, end: 1 } }) }),
      ]));
      fireEvent.click(screen.getByRole('button', { name: '退出预览' }));
      fireEvent.click(screen.getByRole('button', { name: '更正' }));
      expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
      if (collection === 'draft') fireEvent.click(screen.getByRole('button', { name: '删除整条' }));
      else fireEvent.click(within(screen.getByRole('button', { name: '目标消息 msg-1::whole' }).closest('li')!).getByRole('button', { name: '删除' }));
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '预览' })).toBeEnabled();
    } finally { view.unmount(); }
  });

  it('updates a JOIN preview against live membership rather than its own simulated placement',async()=>{
    const container:Relation={...makeRelation(),id:'preview-container',relationType:'CLASSIFY',sourceMessageId:null,targetRefs:[],payload:{title:'已有分类'}};
    const asMessage=(relation:Relation):Message=>({...makeMessage(relation.id,''),kind:'RELATION',relationType:relation.relationType,
      relSourceId:relation.sourceMessageId,targetRefs:relation.targetRefs,relationPayload:relation.payload,state:relation.state});
    const base={scope:{messageId:'classification-1',title:'测试分类'},messages:[makeMessage('msg-1','待加入成员'),asMessage(container)],
      relations:[container],users:[makeUser()],stakes:{},tagCounts:{},attentionUsers:{},sequence:1};
    mockApi.getWorkbenchSnapshot.mockResolvedValue(base);
    mockApi.previewCommandBatch.mockImplementation(async prepared=>{
      const command=prepared.envelope.commands[0];
      const join:Relation={...makeRelation(),...command.body,id:command.id,state:{membershipActive:true}};
      return {snapshots:[{...base,messages:[...base.messages,asMessage(join)],relations:[container,join],sequence:2}],baseSequence:1,messageIds:[join.id]};
    });
    const view=render(<MessageWorkbenchPage/>);
    try{
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      const select=async(id:string)=>act(async()=>mockGraphView.mock.lastCall![0].onMessageClick({button:0,stopPropagation:vi.fn()},id));
      await select(container.id);fireEvent.click(screen.getByRole('button',{name:'加入来源集合'}));
      await select('msg-1');fireEvent.click(screen.getByRole('button',{name:'分类'}));
      fireEvent.click(screen.getByRole('button',{name:'预览'}));
      await waitFor(()=>expect(screen.getByRole('button',{name:'更新预览'})).toBeEnabled());
      fireEvent.click(screen.getByRole('button',{name:'更新预览'}));
      await waitFor(()=>expect(mockApi.previewCommandBatch).toHaveBeenCalledTimes(2));
      const first=mockApi.previewCommandBatch.mock.calls[0][0],second=mockApi.previewCommandBatch.mock.calls[1][0];
      expect(second.envelope.commands).toEqual(first.envelope.commands);
      expect(mockApi.confirmCommandPreview).not.toHaveBeenCalled();
    }finally{view.unmount();}
  });

  it('uses an automatic wait dialog for preview requests and preserves input until confirmation',async()=>{
    const view=render(<MessageWorkbenchPage/>);
    let finishPreview!:(value:unknown)=>void,finishSend!:(value:unknown)=>void;
    const defaultPreview=mockApi.previewCommandBatch.getMockImplementation()!;
    mockApi.previewCommandBatch.mockImplementationOnce(()=>new Promise(resolve=>{finishPreview=resolve;}));
    mockApi.confirmCommandPreview.mockImplementationOnce(()=>new Promise(resolve=>{finishSend=resolve;}));
    try{
      const input=await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      fireEvent.change(input,{target:{value:'弹窗等待测试'}});fireEvent.click(screen.getByRole('button',{name:'预览'}));
      await screen.findByRole('dialog',{name:'正在生成发送预览'});expect(input).toHaveValue('弹窗等待测试');expect(mockApi.confirmCommandPreview).not.toHaveBeenCalled();
      const prepared=mockApi.previewCommandBatch.mock.calls[0][0];
      await act(async()=>{finishPreview(await defaultPreview(prepared));});
      await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(screen.getByRole('button',{name:'确认发送'}));await screen.findByRole('dialog',{name:'正在发送'});
      await act(async()=>{finishSend({snapshots:[{scope:{messageId:'classification-1',title:'测试分类'},messages:[],relations:[],users:[],stakes:{},tagCounts:{},attentionUsers:{},sequence:2}]});});
      await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）')).toHaveValue('');
    }finally{view.unmount();}
  });

  it('can reconcile an uncertain send after clearing the current input',async()=>{
    const view=render(<MessageWorkbenchPage/>);
    try {
      const input=await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      fireEvent.change(input,{target:{value:'等待确认的消息'}});fireEvent.click(screen.getByRole('button',{name:'预览'}));
      await waitFor(()=>expect(screen.getByRole('button',{name:'确认发送'})).toBeEnabled());
      mockApi.confirmCommandPreview.mockRejectedValueOnce(Object.assign(new Error('本次发送结果待核对'),{unknownOutcome:true}));
      fireEvent.click(screen.getByRole('button',{name:'确认发送'}));await screen.findByText('本次发送结果待核对');
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'),{target:{value:''}});
      expect(screen.getByRole('button',{name:'确认发送'})).toBeEnabled();
      fireEvent.click(screen.getByRole('button',{name:'确认发送'}));
      await waitFor(()=>expect(mockApi.confirmCommandPreview).toHaveBeenCalledTimes(2));
      expect(mockApi.confirmCommandPreview.mock.calls[1][0]).toBe(mockApi.confirmCommandPreview.mock.calls[0][0]);
    }finally{view.unmount();}
  });

  it('keeps preview status and exit beside send controls, and exits without consuming the edited draft',async()=>{
    const view=render(<MessageWorkbenchPage/>);
    try{
      const input=await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      fireEvent.change(input,{target:{value:'预览草稿'}});fireEvent.click(screen.getByRole('button',{name:'预览'}));
      const status=await screen.findByText('发送预览 · 尚未发送'),controls=status.closest('.desk-submit-bar')!;
      expect(controls).toContainElement(screen.getByRole('button',{name:'退出预览'}));
      expect(controls).toContainElement(screen.getByRole('button',{name:'确认发送'}));
      expect(view.container.querySelector('[data-workbench-left-panel] [data-send-preview]')).toBeNull();
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'),{target:{value:'保留修改后的草稿'}});
      fireEvent.click(screen.getByRole('button',{name:'退出预览'}));
      expect(screen.queryByText('发送预览 · 尚未发送')).toBeNull();
      expect(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）')).toHaveValue('保留修改后的草稿');
      expect(mockApi.confirmCommandPreview).not.toHaveBeenCalled();
    }finally{view.unmount();}
  });

  it.each(['text','correct','classify'])('previews %s through the composer without a separate dialog or consuming its draft',async type=>{
    const view=render(<MessageWorkbenchPage/>);
    try {
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');await waitForWorkbenchIdle();
      if(type==='correct'){
        act(()=>window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT,{detail:{reference:{messageId:'msg-1',revision:1,partId:'body'},label:'正文'}})));
        fireEvent.click(screen.getByRole('button',{name:'更正'}));
      }
      if(type==='classify')fireEvent.click(screen.getByRole('button',{name:'分类'}));
      const input=screen.getByPlaceholderText(type==='classify'?'输入分类名称（不能为空）':'输入一条新文本消息（支持自由换行）');
      fireEvent.change(input,{target:{value:'待发送内容'}});
      fireEvent.click(screen.getByRole('button',{name:'预览'}));
      await waitFor(()=>expect(mockApi.previewCommandBatch).toHaveBeenCalledOnce());
      expect(input).toHaveValue('待发送内容');expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByText('发送预览 · 尚未发送')).toBeInTheDocument();
      expect(mockApi.confirmCommandPreview).not.toHaveBeenCalled();
      const prepared=mockApi.previewCommandBatch.mock.calls[0][0];
      expect(prepared.envelope.commands[0]).toMatchObject(type==='text'?{path:'/messages',body:{content:'待发送内容'}}:
        {path:'/relations',body:{relationType:type==='correct'?'CORRECT':'CLASSIFY',payload:type==='correct'?{correctionContent:'待发送内容'}:{title:'待发送内容'}}});
      await waitFor(()=>expect(screen.getByRole('button',{name:'确认发送'})).toBeEnabled());
      fireEvent.click(screen.getByRole('button',{name:'确认发送'}));
      await waitFor(()=>expect(mockApi.confirmCommandPreview).toHaveBeenCalledExactlyOnceWith(prepared));
      await waitFor(()=>expect(screen.queryByText('发送预览 · 尚未发送')).toBeNull());
      expect(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）')).toHaveValue('');
    }finally{view.unmount();}
  });
});

describe('Zhihu local workbench', () => {
  it('loads the JOIN history of a closed structural category without opening unrelated branches', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    viewerRoute.archive = nativeZhihuDocument(sendNativeZhihuRelation(largeStructuralFixture(), { relationType: 'CLASSIFY',
      title: '技术测试分组', targetMessageIds: ['zhihu:comment:answer%3Aa:ca', 'zhihu:comment:answer%3Ab:cb'] }));
    viewerRoute.key = 'large-structural-join-history';
    const group = viewerRoute.archive.messages.find(row => row.relationType === 'CLASSIFY' && row.content === '技术测试分组')
      ?? viewerRoute.archive.messages.find(row => row.relationType === 'CLASSIFY' && !row.id.startsWith('zhihu:'))!;
    const latest = () => mockGraphView.mock.lastCall![0];
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      expect(latest().relatedMessages.length).toBeLessThan(5);
      expect(latest().joinRelationsBySource.get(group.id)).toHaveLength(2);
      await act(async () => latest().onJoinFilterClick(group.id, 'outgoing'));
      await waitForWorkbenchIdle();
      expect(screen.getByText('被加入记录临时分类（2）')).toBeInTheDocument();
      expect(view.container.querySelectorAll(`[data-container-join-records="${group.id}"] [data-msgid]`).length).toBeGreaterThanOrEqual(2);
      fireEvent.click(screen.getByRole('button', { name: '切换为消息图' }));
      await waitForWorkbenchIdle();
      expect(latest().messages.filter((row: Message) => row.kind === 'join')).toHaveLength(2);
      expect(latest().relatedMessages.length).toBeLessThan(20);
      fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
      await waitForWorkbenchIdle();
      expect(latest().relatedMessages.length).toBeLessThan(5);
    } finally { view.unmount(); viewerRoute.archive = null; viewerRoute.key = ''; }
  });

  it('follows a structural Zhihu trace across categories without loading unrelated branches', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    const source = largeStructuralFixture();
    viewerRoute.archive = nativeZhihuDocument(sendNativeZhihuRelation(source, { relationType: 'REPLY',
      sourceMessageIds: ['zhihu:comment:answer%3Aa:ca'], targetMessageIds: ['zhihu:item:answer:b'], currentClassificationId: 'zhihu:question:qa' }));
    viewerRoute.key = 'large-structural-trace';
    const latest = () => mockGraphView.mock.lastCall![0];
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle(); await enterAnswerType(view.container);
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:question:qa'));
      await waitForWorkbenchIdle();
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3Aa:ca'));
      fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
      await waitFor(() => expect(latest().messages.some((row: Message) => row.id === 'zhihu:item:answer:b')).toBe(true));
      await waitForWorkbenchIdle();
      expect(latest().relatedMessages.length).toBeLessThan(20);
      expect(latest().relatedMessages.some((row: Message) => row.id.includes('test999'))).toBe(false);
      expect(mockApi.getMessageContext).not.toHaveBeenCalled();
    } finally { view.unmount(); viewerRoute.archive = null; viewerRoute.key = ''; }
  });

  it('restores cached structural categories with asynchronous scene workers through repeated double-click navigation', async () => {
    const { createSceneRequestDecoder } = await import('../utils/sceneComputationTransport');
    const { planMessageStructures } = await import('../utils/messageStructurePlan');
    const { computeSceneLayout } = await import('../utils/frameLayout');
    class SceneWorker {
      decode = createSceneRequestDecoder();
      onmessage!: (event: MessageEvent) => void;
      terminated = false;
      postMessage(request: import('../utils/sceneComputationTransport').SceneComputationRequest) {
        const job = this.decode(request);
        setTimeout(() => {
          if (!this.terminated) this.onmessage({ data: { id: request.id, result: job.kind === 'structures'
            ? planMessageStructures(job.input) : computeSceneLayout(job.input) } } as MessageEvent);
        }, 5);
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', SceneWorker); vi.clearAllMocks(); localStorage.clear();
    viewerRoute.archive = largeStructuralFixture(); viewerRoute.key = 'async-cached-structure'; graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle(); await enterAnswerType(view.container); await waitForWorkbenchIdle();
      for (let n = 0; n < 4; n++) {
        fireEvent.doubleClick(screen.getByRole('group', { name: '分类 zhihu:question:qa，未选中' }));
        await waitForWorkbenchIdle();
        expect(document.querySelector('[data-workbench-left-panel] [data-msgid="zhihu:comment:answer%3Aa:ca"]')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '退出分类' })); await waitForWorkbenchIdle();
        expect(screen.getByRole('group', { name: '分类 zhihu:question:qa，未选中' })).toBeInTheDocument();
      }
      expect(screen.queryByRole('alert')).toBeNull();
    } finally { view.unmount(); viewerRoute.archive = null; viewerRoute.key = ''; graphRendering.actual = false; vi.unstubAllGlobals(); }
  });

  it.each([false, true])('loads large Zhihu categories structurally, shows full counts and saves the complete document (paged=%s)', async paged => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    viewerRoute.archive = largeStructuralFixture(); viewerRoute.key = 'large-structural-viewer';
    const body = viewerRoute.archive.messages.find(row => row.id === 'zhihu:comment:answer%3Aa:ca')!;
    body.content = '按需读取的完整原文'; body.parts = [{ id: 'body', type: 'text', text: body.content }];
    if (paged) {
      const { Blob: NativeBlob } = await vi.importActual<{ Blob: typeof Blob }>('node:buffer');
      vi.stubGlobal('Blob', NativeBlob);
      const { pageNativeZhihuData } = await import('../utils/pagedZhihuArchive');
      viewerRoute.archive = await pageNativeZhihuData(viewerRoute.archive as ReturnType<typeof largeStructuralFixture>);
    }
    const originalCount = viewerRoute.archive.messages.length;
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    const reference = vi.spyOn(exportViewerCache, 'getExportCacheReference').mockReturnValue({ archiveId: 'large-test', viewCacheId: 'large-test-view' });
    const position = vi.spyOn(exportViewerCache, 'saveExportNavigation').mockResolvedValue();
    const latest = () => mockGraphView.mock.lastCall![0];
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      expect(latest().messages.map((row: Message) => row.id)).toEqual(['zhihu:type:answer']);
      expect(latest().relatedMessages).toHaveLength(1);
      expect(latest().getMemberCounts('zhihu:type:answer').total).toBeGreaterThan(10_000);
      await enterAnswerType(view.container);
      expect(latest().messages.map((row: Message) => row.id).sort()).toEqual(['zhihu:question:qa', 'zhihu:question:qb', 'zhihu:question:qbulk']);
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:question:qa'));
      await waitFor(() => expect(latest().messages.some((row: Message) => row.id === 'zhihu:comment:answer%3Aa:ca')).toBe(true));
      await waitForWorkbenchIdle();
      expect(latest().relatedMessages.length).toBeLessThan(15);
      expect(latest().relatedMessages.find((row: Message) => row.id === body.id)?.parts).toEqual(body.parts);
      fireEvent.click(screen.getByText('阅览设置'));
      fireEvent.click(screen.getByRole('button', { name: '保存阅览设置' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      expect(saved.mock.calls[0][0].messages).toHaveLength(originalCount);
      expect(saved.mock.calls[0][0].view?.classificationId).toBe('zhihu:question:qa');
      await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '退出分类' })); await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button', { name: '退出分类' })); await waitForWorkbenchIdle();
      expect(latest().relatedMessages).toHaveLength(1);
      expect(position.mock.lastCall![1]).toEqual({ classificationId: null, classificationPath: [] });
    } finally { view.unmount(); viewerRoute.archive = null; viewerRoute.key = ''; saved.mockRestore(); position.mockRestore(); reference.mockRestore(); if (paged) vi.unstubAllGlobals(); }
  });

  it('navigates by ID into an unloaded Zhihu category and restores the overview without loading other branches', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    viewerRoute.archive = largeStructuralFixture(); viewerRoute.key = 'large-structural-navigation';
    const latest = () => mockGraphView.mock.lastCall![0];
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      await act(async () => latest().onNavigateToMessage('zhihu:comment:answer%3Ab:cb'));
      await waitFor(() => expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('技术测试 b'));
      await waitForWorkbenchIdle();
      expect(latest().relatedMessages.length).toBeLessThan(15);
      expect(latest().messages.some((row: Message) => row.id === 'zhihu:comment:answer%3Ab:cb')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: '退出分类' })); await waitForWorkbenchIdle();
      expect(latest().messages.map((row: Message) => row.id)).toEqual(['zhihu:type:answer']);
    } finally { view.unmount(); viewerRoute.archive = null; viewerRoute.key = ''; }
  });

  it('opens compact Zhihu source files in the editable Zhihu workbench and saves native messages', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    const { zhihu: _source, ...native } = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
      items: [{ id: '10', type: 'answer', text: '' }], comments: [
        { id: '1', sourceId: '1', threadId: 'answer:10', text: '', parentCommentId: null, rootCommentId: '1' },
        { id: '2', sourceId: '2', threadId: 'answer:10', text: '', parentCommentId: null, rootCommentId: '2' }] });
    viewerRoute.archive = { ...native, viewerUsername: '本地整理者', source: { provider: 'zhihu', version: 1, scope: 'own', ownerId: 'fixture-owner', ownerUrl: null } } as ExportData;
    viewerRoute.key = 'native-zhihu-mode-regression';
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      expect(screen.getByText('知乎文档阅览')).toBeInTheDocument();
      expect(screen.queryByText('公论文档阅览')).toBeNull();
      expect(screen.queryByText('当前用户')).toBeNull();
      await enterAnswerType(view.container);
      const latest = () => mockGraphView.mock.lastCall![0];
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3A10:2'));
      fireEvent.click(screen.getByRole('button', { name: '加入来源集合' }));
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3A10:1'));
      fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
      const graph = screen.getByTestId('graph-view');
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      const next = saved.mock.calls[0][0];
      expect(next).not.toHaveProperty('zhihu');
      expect(next.messages.some(message => message.parts?.some(part => part.id === 'local-origin'))).toBe(true);
      expect(screen.getByTestId('graph-view')).toBe(graph);
      expect(mockApi.createMessage).not.toHaveBeenCalled(); expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { view.unmount(); viewerRoute.archive = null; viewerRoute.key = ''; saved.mockRestore(); }
  });

  async function enterAnswerType(container: HTMLElement, actual = false) {
    const id = 'zhihu:type:answer';
    if (actual) {
      const card = await waitFor(() => {
        const element = container.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${id}"]:not([data-rel-overlay])`);
        expect(element).not.toBeNull();
        return element!;
      });
      expect(card).toHaveTextContent('回答');
      fireEvent.doubleClick(card);
    } else {
      const latest = () => mockGraphView.mock.lastCall![0];
      expect(latest().messages.some((message: { id: string }) => message.id === id)).toBe(true);
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, id));
    }
    await waitForWorkbenchIdle();
    expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('回答');
  }

  it('saves local agreement through the original source, target and send controls without server actions', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
      items: [{ id: '10', type: 'answer', text: '' }],
      comments: [
        { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
        { id: '2', sourceId: '2', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
      ] });
    viewerRoute.archive = original;
    const cached = vi.spyOn(exportViewerCache, 'loadCachedExport').mockResolvedValue(null);
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      await enterAnswerType(view.container);
      fireEvent.click(screen.getByRole('button', { name: '赞同' }));
      const latest = () => mockGraphView.mock.lastCall![0];
      const source = 'zhihu:comment:answer%3A10:2', target = 'zhihu:comment:answer%3A10:1';
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, source));
      fireEvent.click(screen.getByRole('button', { name: '加入来源集合' }));
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, target));
      fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      const next = saved.mock.calls[0][0] as ReturnType<typeof prepareZhihuForViewing>;
      const agreement = next.relations.find(relation => relation.relationType === 'AGREE')!;
      expect(agreement).toMatchObject({ sourceMessageId: source, sourceRefs: [{ messageId: source }],
        targetRefs: [expect.objectContaining({ reference: { messageId: target } })] });
      expect(next.zhihu.archive).toEqual(original.zhihu.archive);
      const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(next)));
      expect(reopened.relations.find(relation => relation.id === agreement.id)).toMatchObject(agreement);
      await waitFor(() => expect(latest().edges.some((edge: { relationType: string }) => edge.relationType === 'agree')).toBe(true));
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
      expect(mockApi.previewCommandBatch).not.toHaveBeenCalled();
      expect(mockApi.confirmCommandPreview).not.toHaveBeenCalled();
    } finally {
      view.unmount(); viewerRoute.archive = null; viewerRoute.key = '';
      cached.mockRestore(); saved.mockRestore();
    }
  });

  it('saves a local width correction through the native controls and restores its width after reopening', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
      items: [{ id: '10', type: 'answer', text: '结构测试正文', completeness: { body: 'complete' } }], comments: [] });
    const itemId = 'zhihu:item:answer:10';
    viewerRoute.archive = original;
    const cached = vi.spyOn(exportViewerCache, 'loadCachedExport').mockResolvedValue(null);
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    graphRendering.actual = true;
    let view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle(); await enterAnswerType(view.container, true);
      const card = () => view.container.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${itemId}"]:not([data-rel-overlay])`)!;
      fireEvent.click(card());
      fireEvent.click(screen.getByRole('button', { name: '更正' }));
      fireEvent.click(screen.getByRole('button', { name: '宽度调整' }));
      const width = screen.getByRole('spinbutton', { name: '消息卡宽度' });
      expect(width.closest('.workbench-composer-section')).not.toBeNull();
      expect(screen.queryByText(/^选择有效关系/)).toBeNull();
      fireEvent.change(width, { target: { value: '800' } });
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(card()).toHaveStyle({ width: '800px' }));
      const next = saved.mock.calls[0][0] as ReturnType<typeof prepareZhihuForViewing>;
      expect(next.zhihu.archive).toEqual(original.zhihu.archive);
      const widthId = next.zhihu.localOperations.messages.find(message => message.correctionKind === 'WIDTH')!.id;
      expect(next.messages.find(message => message.id === widthId)?.relationPayload).toMatchObject({ correctionWidth: 800 });
      const reopened = validateExportForViewing(JSON.parse(serializeGonglunZhihuViewingData(next))).data;
      view.unmount(); viewerRoute.archive = reopened; viewerRoute.key = 'width-reopened';
      view = render(<MessageWorkbenchPage />); await waitForWorkbenchIdle();
      await waitFor(() => expect(card()).toHaveStyle({ width: '800px' }));
      expect(mockApi.createMessage).not.toHaveBeenCalled(); expect(mockApi.createRelation).not.toHaveBeenCalled();
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled(); expect(mockApi.previewCommandBatch).not.toHaveBeenCalled();
    } finally { view.unmount(); graphRendering.actual = false; viewerRoute.archive = null; viewerRoute.key = ''; cached.mockRestore(); saved.mockRestore(); }
  }, 15_000);
  it('fills missing question fields through native correction controls, reopens Gonglun format and withdraws the supplement', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
      items: [{ id: '10', type: 'answer', text: '', completeness: { body: 'complete' }, question: { id: '20', title: '' } }], comments: [] });
    const questionId = Object.entries(original.zhihu.byMessageId).find(([, meta]) => meta.kind === 'question')![0];
    original.view = { username: null, mode: 'graph', classificationId: null,
      messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] };
    viewerRoute.archive = original;
    const cached = vi.spyOn(exportViewerCache, 'loadCachedExport').mockResolvedValue(null);
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    graphRendering.actual = true;
    let view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${questionId}"]`)).toBeNull();
      await enterAnswerType(view.container, true);
      const question = await waitFor(() => {
        const card = view.container.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${questionId}"]:not([data-rel-overlay])`);
        expect(card).not.toBeNull();
        return card!;
      });
      fireEvent.doubleClick(question);
      await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-zhihu-question-description]')).toHaveTextContent('问题描述未取得');
      fireEvent.click(screen.getByText(/缺失或待确认的内容（/));
      await waitFor(() => expect(view.container.querySelector(`[data-missing-message="${questionId}"]`)).not.toBeNull());
      const missing = (field: string) => view.container.querySelector(`[data-missing-message="${questionId}"][data-missing-field="${field}"] button`)!;
      fireEvent.click(missing('body'));
      expect(screen.getByRole('button', { name: '更正' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('combobox', { name: '更正字段' })).toHaveValue('body');
      const textarea = screen.getByPlaceholderText('输入更正后的问题描述（保留原文）');
      expect(textarea.closest('.workbench-composer-section')).not.toBeNull();
      fireEvent.change(textarea, { target: { value: '本地测试描述\n第二行' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(view.container.querySelector('[data-zhihu-question-description]')).toHaveTextContent('本地测试描述'));
      expect(view.container.querySelector('[data-zhihu-question-description]')).toHaveTextContent('本地补充');
      expect(view.container.querySelector('[data-zhihu-question-description]')).toHaveTextContent('原文件未取得问题描述');
      fireEvent.click(missing('title'));
      expect(screen.getByRole('combobox', { name: '更正字段' })).toHaveValue('title');
      fireEvent.change(screen.getByPlaceholderText('输入更正后的问题标题（保留原文）'), { target: { value: '本地测试标题' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
      expect(screen.getByText('标题 · 本地补充')).toBeInTheDocument();
      const supplemented = saved.mock.calls[1][0] as ReturnType<typeof prepareZhihuForViewing>;
      expect(supplemented.zhihu.archive).toEqual(original.zhihu.archive);
      const file = JSON.parse(serializeGonglunZhihuViewingData(supplemented));
      expect(file.format).toBe('gonglun-view-3');
      const reopened = validateExportForViewing(file).data as ReturnType<typeof prepareZhihuForViewing>;
      expect(getZhihuDisplayFields(reopened, questionId)).toMatchObject({ title: '本地测试标题', body: '本地测试描述\n第二行' });
      view.unmount(); viewerRoute.archive = reopened; viewerRoute.key = 'question-supplement-reopened';
      view = render(<MessageWorkbenchPage />); await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-zhihu-question-description]')).toHaveTextContent('本地测试描述');
      const correctionId = getZhihuDisplayFields(reopened, questionId).bodyCorrectionId!;
      await act(async () => mockGraphView.mock.lastCall![0].onMessageClick({ button: 0, stopPropagation: vi.fn() }, correctionId));
      fireEvent.click(screen.getByRole('button', { name: '反对' }));
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(view.container.querySelector('[data-zhihu-question-description]')).toHaveTextContent('问题描述未取得'));
      expect(screen.getByText('标题 · 本地补充')).toBeInTheDocument();
      expect(getZhihuInactiveRelationIds(saved.mock.calls.at(-1)![0] as ReturnType<typeof prepareZhihuForViewing>).has(correctionId)).toBe(true);
      expect((saved.mock.calls[2][0] as ReturnType<typeof prepareZhihuForViewing>).zhihu.archive).toEqual(original.zhihu.archive);
      expect(mockApi.createMessage).not.toHaveBeenCalled(); expect(mockApi.createRelation).not.toHaveBeenCalled();
      expect(mockApi.previewCommandBatch).not.toHaveBeenCalled(); expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled();
      expect(mockApi.getPointsBalance).not.toHaveBeenCalled();
    } finally { view.unmount(); graphRendering.actual = false; viewerRoute.archive = null; viewerRoute.key = ''; cached.mockRestore(); saved.mockRestore(); }
  }, 15_000);
  it.each(['graph-edge', 'list-row', 'list-badge', 'list-badge-target'] as const)('opposes a reply selected from actual %s UI without requiring an extra staging action', async route => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
      items: [{ id: '10', type: 'answer', text: '' }], comments: ['1', '2'].map(id => ({
        id, sourceId: id, threadId: 'answer:10', text: '', rootCommentId: id, parentCommentId: null,
      })) });
    viewerRoute.archive = original;
    const reply = getZhihuReplyRelations(original)[0], other = getZhihuReplyRelations(original)[1];
    const cached = vi.spyOn(exportViewerCache, 'loadCachedExport').mockResolvedValue(null);
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    graphRendering.actual = true;
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      if (route !== 'graph-edge') { fireEvent.click(screen.getByRole('button', { name: '切换为消息表' })); await waitForWorkbenchIdle(); }
      const surface = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const selector = route === 'graph-edge' ? `[data-directed-edge-label="${reply.id}"]` : `[data-msgid="${reply.id}"]`;
      expect(surface.querySelector(selector)).toBeNull();
      expect(surface.querySelector('[data-msgid="zhihu:comment:answer%3A10:1"]')).toBeNull();
      await enterAnswerType(view.container, true);
      await waitFor(() => expect(surface.querySelector(selector)).not.toBeNull());
      const row = surface.querySelector<HTMLElement>(selector)!;
      if (route.startsWith('list-badge')) {
        const badge = row.querySelector<HTMLElement>('[data-skin-type-label]')!;
        expect(badge).toHaveTextContent('回复');
        expect(badge).not.toHaveAttribute('data-message-reference');
        expect(badge).not.toHaveAttribute('role');
        fireEvent.click(badge);
      } else fireEvent.click(row);
      if (route === 'graph-edge') expect(mockGraphView.mock.lastCall![0].draftUnits).toContainEqual({ messageId: reply.id, selection: { kind: 'whole' } });
      if (route === 'list-badge-target') fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      fireEvent.click(screen.getByRole('button', { name: '反对' }));
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(surface.querySelector(selector)).toBeNull());
      const next = saved.mock.calls[0][0] as ReturnType<typeof prepareZhihuForViewing>;
      expect(getZhihuInactiveRelationIds(next).has(reply.id)).toBe(true);
      expect(getZhihuInactiveRelationIds(next).has(other.id)).toBe(false);
      expect(next.zhihu.archive).toEqual(original.zhihu.archive);
      expect(surface.querySelector('[data-msgid="zhihu:comment:answer%3A10:1"]')).not.toBeNull();
      expect(surface.querySelector(route === 'graph-edge' ? `[data-directed-edge-label="${other.id}"]` : `[data-msgid="${other.id}"]`)).not.toBeNull();
      expect(getZhihuInactiveRelationIds(prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(next)))).has(reply.id)).toBe(true);
      expect(mockApi.createRelation).not.toHaveBeenCalled(); expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled(); expect(mockApi.previewCommandBatch).not.toHaveBeenCalled();
    } finally { view.unmount(); graphRendering.actual = false; viewerRoute.archive = null; viewerRoute.key = ''; cached.mockRestore(); saved.mockRestore(); }
  }, 15_000);
  it.each([{ name: '分类', type: 'CLASSIFY', text: '结构测试分类' }, { name: '总结', type: 'SUMMARY', text: '结构测试总结' },
    { name: '归并', type: 'MERGE', text: '' }, { name: '排列', type: 'ARRANGE', text: '' }])('creates, reopens, extends and opposes local $name through shared controls', async ({ name, type, text }) => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
      items: [{ id: '10', type: 'answer', text: '' }], comments: ['1', '2', '3'].map(id => ({
        id, sourceId: id, threadId: 'answer:10', text: '', rootCommentId: id, parentCommentId: null,
      })) });
    viewerRoute.archive = original;
    const cached = vi.spyOn(exportViewerCache, 'loadCachedExport').mockResolvedValue(null);
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    let view = render(<MessageWorkbenchPage />);
    const latest = () => mockGraphView.mock.lastCall![0];
    const comment = (id: string) => `zhihu:comment:answer%3A10:${id}`;
    const select = async (id: string) => { await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, id)); };
    try {
      await waitForWorkbenchIdle();
      await enterAnswerType(view.container);
      await select(comment('2')); await select(comment('1'));
      fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      fireEvent.click(screen.getByRole('button', { name }));
      if (text) fireEvent.change(screen.getByPlaceholderText(type === 'CLASSIFY' ? '输入分类名称（不能为空）' : '输入总结内容（不能为空）'), { target: { value: text } });
      if (type === 'ARRANGE') fireEvent.click(screen.getByRole('button', { name: '横' }));
      expect(screen.getByRole('button', { name: '发送' }).closest('.workbench-composer-section')).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(saved.mock.calls[0][0] as ReturnType<typeof prepareZhihuForViewing>)));
      const organization = getZhihuLocalRelations(reopened).find(record => record.relationType === type)!;
      expect(organization?.targetMessageIds).toEqual([comment('2'), comment('1')]);
      if (type === 'ARRANGE') expect((reopened.messages.find(message => message.id === organization.id)?.relationPayload as { targetLayout?: string })?.targetLayout).toBe('single-row');
      view.unmount(); viewerRoute.archive = reopened; viewerRoute.key = 'organization-reopened';
      view = render(<MessageWorkbenchPage />); await waitForWorkbenchIdle();
      await select(organization.id);
      fireEvent.click(screen.getByRole('button', { name: '加入来源集合' }));
      await select(comment('3')); fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      fireEvent.click(screen.getByRole('button', { name }));
      expect(screen.getByPlaceholderText('加入已有容器消息，此处不可输入')).toHaveAttribute('readonly');
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
      const extended = saved.mock.calls[1][0] as ReturnType<typeof prepareZhihuForViewing>;
      expect(getZhihuLocalRelations(extended).find(record => record.id === organization.id)?.targetMessageIds).toEqual([comment('2'), comment('1'), comment('3')]);
      await waitForWorkbenchIdle();
      await select(organization.id);
      fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      fireEvent.click(screen.getByRole('button', { name: '反对' })); fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(3));
      await waitForWorkbenchIdle();
      expect(getZhihuInactiveRelationIds(saved.mock.calls.at(-1)![0] as ReturnType<typeof prepareZhihuForViewing>).has(organization.id)).toBe(true);
      expect(latest().messages.some((message: { id: string }) => message.id === organization.id)).toBe(false);
      expect(latest().messages.some((message: { id: string }) => message.id === comment('3'))).toBe(true);
      expect(latest().edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === organization.id)).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${organization.id}"]`)).toBeNull();
      expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${comment('3')}"]`)).not.toBeNull();
      expect((saved.mock.calls[2][0] as ReturnType<typeof prepareZhihuForViewing>).zhihu.archive).toEqual(original.zhihu.archive);
      expect(screen.getByRole('button', { name: '赞同' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '预览' })).toBeNull();
      expect(screen.queryByText('投入与费用')).toBeNull();
      expect(mockApi.createMessage).not.toHaveBeenCalled(); expect(mockApi.createRelation).not.toHaveBeenCalled();
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled(); expect(mockApi.previewCommandBatch).not.toHaveBeenCalled();
    } finally { view.unmount(); viewerRoute.archive = null; viewerRoute.key = ''; cached.mockRestore(); saved.mockRestore(); }
  }, 15_000);
  it('keeps Gonglun document viewing separate and read only', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('gpt');
    viewerRoute.archive = { formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '' },
      messages: [{ ...makeMessage('saved', ''), authorId: 'user-1', author: 'tester' }], relations: [] };
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      expect(screen.getByText('公论文档阅览')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '知乎本地回复关系' })).toBeNull();
      expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
      expect(screen.queryByRole('button', { name: '回复' })).toBeNull();
      expect(screen.queryByRole('button', { name: '加入来源集合' })).toBeNull();
      expect(screen.queryByRole('button', { name: '预览' })).toBeNull();
      expect(screen.queryByText('投入与费用')).toBeNull();
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled();
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    } finally { view.unmount(); viewerRoute.archive = null; viewerRoute.key = ''; }
  });
  it.each(['gpt', 'gpt-arena', 'opus-paper'] as const)('uses existing graph selections, relation buttons and send controls in %s without server actions', async theme => {
    vi.clearAllMocks();
    localStorage.clear();
    setTheme(theme);
    // Empty bodies are technical structure fixtures, not generated discussion samples.
    viewerRoute.archive = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
      owner: { id: 'fixture-owner', name: '技术测试账号' },
      items: [{ id: '10', type: 'answer', text: '' }],
      comments: [
        { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
        { id: '2', sourceId: '2', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
      ],
    });
    const cached = vi.spyOn(exportViewerCache, 'loadCachedExport').mockResolvedValue(null);
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitForWorkbenchIdle();
      expect(screen.getByRole('region', { name: '知乎本地回复关系' })).toBeInTheDocument();
      expect(screen.getByText('知乎文档阅览')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('输入一条新文本消息（支持自由换行）')).toBeNull();
      expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '发送' }).closest('.desk-submit-bar')).not.toBeNull();
      expect(screen.getByRole('button', { name: '发送' })).toHaveAttribute('data-guide-send', 'true');
      expect(screen.getByRole('button', { name: '发送' })).not.toHaveAttribute('data-shortcut-confirm');
      expect(screen.queryByRole('radio')).toBeNull();
      expect(screen.queryByRole('button', { name: '预览' })).toBeNull();
      expect(screen.queryByText('投入与费用')).toBeNull();
      expect(screen.getByRole('button', { name: '更正' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '分类' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '赞同' })).toBeInTheDocument();
      expect(view.container.querySelector('.desk-send-balance')).toBeNull();
      expect(screen.getByRole('button', { name: '下载阅览文件' })).toBeInTheDocument();
      const latest = () => mockGraphView.mock.lastCall![0];
      await enterAnswerType(view.container);
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3A10:2'));
      await waitFor(() => expect(screen.getByRole('button', { name: '加入来源集合' })).toBeEnabled());
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3A10:2'));
      expect(screen.getByRole('button', { name: '加入来源集合' })).toBeDisabled();
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3A10:2'));
      fireEvent.click(screen.getByRole('button', { name: '加入来源集合' }));
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3A10:1'));
      await waitFor(() => expect(screen.getByRole('button', { name: '加入目标集合' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      const beforeLocalSave = screen.getByTestId('graph-view');
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(latest().edges).toHaveLength(2));
      expect(screen.getByTestId('graph-view')).toBe(beforeLocalSave);
      expect(mockNavigate).not.toHaveBeenCalled();
      await act(async () => latest().onCanvasBlankClick());
      expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
      const created = saved.mock.calls[0][0];
      const reply = getZhihuReplyRelations(created as ReturnType<typeof prepareZhihuForViewing>).find(record => record.sourceMessageId === 'zhihu:comment:answer%3A10:2')!;
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3A10:2'));
      fireEvent.click(screen.getByRole('button', { name: '加入来源集合' }));
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'zhihu:comment:answer%3A10:1'));
      fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(latest().edges).toHaveLength(3));
      const repeated = getZhihuReplyRelations(saved.mock.calls[1][0] as ReturnType<typeof prepareZhihuForViewing>).filter(record => record.sourceMessageId === 'zhihu:comment:answer%3A10:2');
      expect(repeated).toHaveLength(2); expect(repeated.every(record => record.active)).toBe(true);
      const other = repeated.find(record => record.id !== reply.id)!;
      await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, reply.id));
      fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
      fireEvent.click(screen.getByRole('button', { name: '反对' }));
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(3));
      expect(getZhihuInactiveRelationIds(saved.mock.calls.at(-1)![0] as ReturnType<typeof prepareZhihuForViewing>).has(reply.id)).toBe(true);
      await waitFor(() => expect(latest().rejectedRelationIds.has(reply.id)).toBe(true));
      expect(latest().messages.some((message: { id: string }) => message.id === reply.id)).toBe(false);
      expect(latest().edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === reply.id)).toBe(false);
      expect(latest().edges.some((edge: { relationMessageId: string }) => edge.relationMessageId === other.id)).toBe(true);
      expect(latest().messages.some((message: { id: string }) => message.id === 'zhihu:comment:answer%3A10:2')).toBe(true);
      const restored = saved.mock.calls[2][0] as ReturnType<typeof prepareZhihuForViewing>;
      expect(restored.zhihu.archive).toEqual((viewerRoute.archive as ReturnType<typeof prepareZhihuForViewing>).zhihu.archive);
      const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(restored)));
      expect(getZhihuInactiveRelationIds(reopened).has(reply.id)).toBe(true);
      expect(getZhihuReplyRelations(reopened).find(record => record.id === other.id)?.active).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      await waitForWorkbenchIdle();
      expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${reply.id}"]`)).toBeNull();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="zhihu:comment:answer%3A10:2"]')).not.toBeNull();
      await act(async () => latest().onCanvasBlankClick());
      expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled();
      expect(mockApi.getPointsBalance).not.toHaveBeenCalled();
      expect(mockApi.getCurrentRules).not.toHaveBeenCalled();
      expect(mockApi.getReadingState).not.toHaveBeenCalled();
      expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
      expect(mockApi.previewCommandBatch).not.toHaveBeenCalled();
      expect(mockApi.confirmCommandPreview).not.toHaveBeenCalled();
    } finally {
      view.unmount(); viewerRoute.archive = null; viewerRoute.key = '';
      cached.mockRestore(); saved.mockRestore();
    }
  }, 15_000);
});

describe('Zhihu activity local reading', () => {
  it('reads a collection original through author, type and article categories without a reference jump or API', async () => {
    vi.clearAllMocks(); localStorage.clear(); setTheme('opus-paper');
    const actor = { id: 'fixture-collector', name: '技术收藏者' }, author = { id: 'fixture-author', name: '技术原作者' };
    // Empty target body and protocol fields only; this is not a discussion sample.
    const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, owner: actor,
      items: [{ id: '10', type: 'article', text: '', author, completeness: { body: 'complete', comments: 'complete' } }], comments: [],
      activitySource: { version: 1, scope: 'collections', events: [{ id: 'collections:a:1', sourceId: '1', identity: 'source', kind: 'collection-item', actor,
        verb: 'collect', actionText: null, type: 'collection-item', target: { id: '10', type: 'article', url: 'https://zhuanlan.zhihu.com/p/10', author },
        folderId: 'a', createdAt: null, createdAtText: null, sourceUrl: 'https://www.zhihu.com/collection/a', capturedAt: '2026-11-01T01:00:00Z' }],
        folders: [{ id: 'a', title: '技术收藏夹', description: '', creator: actor, createdAt: null, updatedAt: null, isPublic: null, itemCount: 1,
          url: 'https://www.zhihu.com/collection/a', sourceUrl: 'https://www.zhihu.com/collection/a', capturedAt: '2026-11-01T01:00:00Z' }],
        coverage: { scope: 'collections', status: 'complete', pagesComplete: true, allHistoryComplete: false, reason: '', currentEventIds: ['collections:a:1'], currentFolderIds: ['a'] }, unparsedRecords: [] } });
    original.view = { username: null, mode: 'graph', classificationId: null,
      messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] };
    const targetId = 'zhihu:item:article:10', sourceSnapshot = JSON.stringify(original.zhihu.archive);
    viewerRoute.archive = original; viewerRoute.key = 'collection-offline-reference'; graphRendering.actual = true;
    const cached = vi.spyOn(exportViewerCache, 'loadCachedExport').mockResolvedValue(null);
    const saved = vi.spyOn(exportViewerCache, 'saveLastExportPersistent').mockResolvedValue();
    const view = render(<MessageWorkbenchPage />);
    const card = (id: string) => waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${id}"]:not([data-rel-overlay])`);
      expect(element, `Missing ${id}; visible: ${[...view.container.querySelectorAll('[data-workbench-left-panel] [data-msgid]')].map(node => node.getAttribute('data-msgid')).join(',')}`).not.toBeNull(); return element!;
    });
    try {
      await waitForWorkbenchIdle();
      fireEvent.doubleClick(await card('zhihu:source:collections')); await waitForWorkbenchIdle();
      fireEvent.doubleClick(await card('zhihu:folder:a')); await waitForWorkbenchIdle();
      expect(view.container.querySelector(`[data-workbench-left-panel] [data-msgid="${targetId}"]`)).toBeNull();
      const authorCategory = original.relations.find(relation => /^zhihu:author-category:[^:]+$/.test(relation.id))!.id;
      const authorCard = await card(authorCategory); expect(authorCard).toHaveTextContent('技术原作者');
      fireEvent.doubleClick(authorCard); await waitForWorkbenchIdle();
      fireEvent.doubleClick(await card(`${authorCategory}:type:article`)); await waitForWorkbenchIdle();
      fireEvent.doubleClick(await card('zhihu:article:10')); await waitForWorkbenchIdle();
      const originalCard = await card(targetId);
      fireEvent.click(originalCard);
      const originalInfo = await screen.findByText('选中消息的原始信息');
      expect(originalInfo.closest('details')).toHaveTextContent('技术原作者');
      expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('文章（标题未取得）');
      expect(JSON.stringify(original.zhihu.archive)).toBe(sourceSnapshot);
      expect(saved).not.toHaveBeenCalled();
      expect(mockApi.getWorkbenchSnapshot).not.toHaveBeenCalled(); expect(mockApi.getMessageContext).not.toHaveBeenCalled();
      expect(mockApi.getPointsBalance).not.toHaveBeenCalled(); expect(mockApi.createMessage).not.toHaveBeenCalled();
      expect(mockApi.createRelation).not.toHaveBeenCalled(); expect(mockApi.previewCommandBatch).not.toHaveBeenCalled();
    } finally {
      view.unmount(); graphRendering.actual = false; viewerRoute.archive = null; viewerRoute.key = ''; cached.mockRestore(); saved.mockRestore();
    }
  }, 15_000);
});
