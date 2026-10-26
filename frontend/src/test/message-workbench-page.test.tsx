import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import MessageWorkbenchPage from '../pages/MessageWorkbenchPage';
import type { ExportData } from '../api/client';
import type { Message, Relation, ScopeView, User } from '../types';
import { PART_SELECTION_EVENT } from '../utils/messageElementSelection';
import * as leaderboardMetrics from '../utils/leaderboardMetrics';
import { LEADERBOARD_PREFERENCES_KEY } from '../utils/leaderboardPreferences';
import GestureShortcutManager from '../components/GestureShortcutManager';
import { WORKBENCH_DRAWING_TIMEOUT_MS } from '../context/WorkbenchDrawingContext';
import {bodyVersion,messageReadingKey} from '@gonglun/core';

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
  }, viewerRoute: { archive: null as ExportData | null, key: '' } };
});

const catalogHarness = vi.hoisted(() => ({ callbacks: null as any, data: null as any,
  progress: { ready: false, count: 0, syncing: true }, prioritize: vi.fn(), filters: vi.fn() }));
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
    return { prioritize: catalogHarness.prioritize, filters: catalogHarness.filters, catchUp: vi.fn(), applyCommitted: vi.fn(),
      refresh: vi.fn().mockResolvedValue(false), stop: vi.fn(), getProgress: () => catalogHarness.progress, subscribe: () => () => {} };
  } };
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
    useParams: () => viewerRoute.archive ? {} : ({ messageId: 'classification-1' }),
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: viewerRoute.archive ? '/viewer' : '/messages/classification-1', state: viewerRoute.archive ? { exportData: viewerRoute.archive } : null, key: viewerRoute.key, search: '', hash: '' }),
    useSearchParams: () => [new URLSearchParams(), vi.fn()] as const,
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

describe('rejected child container boundaries and single-side comparison',()=>{
  const latest=()=>mockGraphView.mock.lastCall![0];
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
    const view = render(<MessageWorkbenchPage />);
    try {
      await waitFor(() => expect(catalogHarness.callbacks).not.toBeNull());
      expect(screen.queryByTestId('graph-view')).toBeNull();
      expect(screen.queryByRole('dialog', { name: '排行榜' })).toBeNull();
      act(() => catalogHarness.callbacks.onReady({ snapshot: { ...full, sequence: 9 }, projected, rows }));
      expect(screen.queryByTestId('graph-view')).toBeNull();
      expect(screen.queryByRole('dialog', { name: '排行榜' })).toBeNull();
      act(() => {
        catalogHarness.data = { snapshot: full, projected, rows };
        catalogHarness.progress = { ready: true, count: 53, syncing: false };
        catalogHarness.callbacks.onReady(catalogHarness.data);
      });
      // A complete model still needs its lazy view modules and drawing tasks.
      // Wait until the browser would allow interaction before opening the board.
      await waitForWorkbenchIdle();
      fireEvent.click(await screen.findByRole('button', { name: '排行榜' }));
      const dialog = await screen.findByRole('dialog', { name: '排行榜' });
      const row = within(dialog).getByText(remoteUser.username).closest('tr')!;
      expect(row.children[4]).toHaveTextContent('52');
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      expect(latest().messages).toHaveLength(53);
      expect(visibleGraphMessages()).toHaveLength(50);
      act(() => catalogHarness.callbacks.onProgress({ ready: false, count: 0, syncing: true }));
      expect(visibleGraphMessages()).toHaveLength(50);
      act(() => catalogHarness.callbacks.onReady(catalogHarness.data));
      fireEvent.change(screen.getByRole('textbox', { name: '消息 ID' }), { target: { value: 'remote-51' } });
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
      await waitFor(() => expect(visibleGraphMessages().some((message: Message) => message.id === 'remote-51')).toBe(true));
      expect(mockApi.getWorkbenchSnapshot.mock.calls.some(([query]) => query.ids?.includes('remote-51'))).toBe(false);
      expect(visibleGraphMessages()).toHaveLength(53);
      expect(screen.queryByRole('button', { name: '加载更多消息' })).toBeNull();
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

  it('keeps whole organizations in both presentations and restores the table page after entering a classification', async () => {
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
      expect(graphIds).toEqual(expect.arrayContaining(['frame', 'peer-0', 'peer-149', 'A']));
      expect(graphIds.some((id: string) => id.startsWith('child-'))).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      const row = (id: string) => document.querySelector<HTMLElement>(`[data-workbench-left-panel] [data-msgid="${id}"]`);
      await waitFor(() => expect(row('frame')).not.toBeNull());
      expect(row('peer-0')).not.toBeNull(); expect(row('peer-149')).not.toBeNull();
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
  });

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
      expect(screen.getByText('追溯距离：1')).toBeInTheDocument();
      expect(latest().visibleMessageIds).toBeUndefined();
      fireEvent.click(screen.getByRole('button', { name: '退出查看' }));
      await waitFor(() => expect(card(hidden.id)).toBeNull());
      expect(card('unread-74')).not.toBeNull();
    } finally { view.unmount(); graphRendering.actual = false; mockApi.getWorkbenchSnapshot.mockImplementation(original); catalogHarness.callbacks = null; }
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

  it('近期列表按文本和关系类型区分，加入、结算和治理消息均归关系列表', async () => {
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
    const texts = screen.getByText('最近文本消息').nextElementSibling as HTMLElement;
    const relations = screen.getByText('最近关系消息').nextElementSibling as HTMLElement;
    await waitFor(() => expect(within(texts).getAllByRole('listitem').map(item => item.textContent)).toEqual(['text-newer：较新文本', 'text-older：较早文本']));
    expect(within(relations).getAllByRole('listitem')).toHaveLength(5);
    expect(relations).toHaveTextContent('【回复】rel-1：');
    expect(relations).toHaveTextContent('提案正文');
    expect(texts).not.toHaveTextContent('提案正文');
    expect(relations).toHaveTextContent('【发起结算】round：结算记录');
    expect(relations).toHaveTextContent('【结算结果】result：结算完成');
    expect(relations).toHaveTextContent('【加入】join：加入容器');
    expect(texts).not.toHaveTextContent('结算记录');
    expect(texts).not.toHaveTextContent('加入容器');
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
      expect(group.getByRole('button',{name:/选择相关.*消息部件/})).toHaveTextContent('cross');
      fireEvent.click(group.getByRole('button',{name:/选择相关.*消息部件/}));
      await act(async()=>fireEvent.click(group.getByRole('button',{name:'查看'})));
      expect(screen.getByText('追溯距离：1')).toBeInTheDocument();
      expect(screen.getByText('当前追溯消息：').parentElement).toHaveTextContent('cross');
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
      expect(screen.getByText('当前追溯消息：').parentElement).toHaveTextContent(side);
      exit=screen.getByRole('button',{name:'退出查看'});
      fireEvent.click(exit);
      expect(screen.queryByText(/追溯距离：/)).toBeNull();
      expect(screen.queryByRole('button',{name:'退出查看'})).toBeNull();
      expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${side}"]`)).not.toBeNull();
      expect(document.querySelector(`[data-workbench-left-panel] [data-msgid="${side==='source'?'target':'source'}"]`)).toBeNull();
      expect(document.querySelector('[data-guide-selection-staging]')).toHaveTextContent('cross');
      expect(screen.getByRole('button',{name:viewMode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{graphRendering.actual=false;}
  });

  it('loads the other endpoint for a directly opened scope and discards it on exiting related view',async()=>{
    const user=makeUser();
    const relation:Relation={id:'cross',relationType:'REFERENCE',sourceMessageId:'source',targetRefs:[{kind:'message',messageId:'remote'}],createdAt:'2026-01-01',createdBy:user};
    mockApi.getScope.mockResolvedValue({messageId:'classification-1',title:'直接打开的分类'});
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('source','本地消息')]});
    mockApi.getRelations.mockResolvedValue({data:[relation]});
    mockApi.getMessageContext.mockResolvedValueOnce({messages:[makeMessage('remote','另一画布的消息')],relations:[]});
    graphRendering.actual=true;
    try{
      render(<MessageWorkbenchPage/>);
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='source')).toBe(true));
      fireEvent.click(screen.getByRole('button',{name:/其他相关消息：1/}));
      await act(async()=>fireEvent.click(screen.getByRole('button',{name:'查看'})));
      expect(mockApi.getMessageContext).toHaveBeenCalledWith(['remote'],expect.any(AbortSignal));
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="remote"]')).not.toBeNull();
      expect(screen.getByText('追溯距离：1')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="remote"]')).toBeNull();
      expect(latest().relatedMessages.some((message:Message)=>message.id==='remote')).toBe(false);
      expect(screen.queryByText(/追溯距离：/)).toBeNull();
    }finally{graphRendering.actual=false;}
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
      fireEvent.click(screen.getByRole('button',{name:/清爽/}));
      expect(screen.getByRole('checkbox',{name:'屏蔽加入消息'})).toBeChecked();
      expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{geometry.mockRestore();graphRendering.actual=false;}
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
      expect(screen.queryByText('加入记录临时分类（1）')).toBeNull();
      const card = panel.querySelector<HTMLElement>('[data-msgid="join-B"]:not([data-rel-overlay])')!;
      const rect = card.getBoundingClientRect(), viewport = panel.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
      expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom);
      expect(panel.scrollTop).toBeCloseTo(2460);
      await waitFor(() => expect(document.querySelector('[data-message-jump-target="join-B"]')).toBeNull());
      const retained = panel.querySelector<HTMLElement>('[data-msgid="join-B"]:not([data-rel-overlay])')!;
      expect(retained).toBeVisible();
      expect(retained.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewport.top);
      expect(retained.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.bottom);
      expect(panel.scrollTop).toBeCloseTo(2460);
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
      const ready=()=>waitFor(()=>expect(document.querySelector('[aria-busy="true"]')).toBeNull());
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
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
      fireEvent.click(screen.getByRole('button',{name:/清爽/}));
      fireEvent.click(screen.getByRole('checkbox',{name:'屏蔽结算消息'}));
      const filterState=()=>[screen.getByRole<HTMLInputElement>('checkbox',{name:'屏蔽加入消息'}).checked,
        screen.getByRole<HTMLInputElement>('checkbox',{name:'屏蔽结算消息'}).checked];
      expect(filterState()).toEqual([true,false]);
      const originScroll=write(0),requests=mockApi.getWorkbenchSnapshot.mock.calls.length;
      fireEvent.click(within(left).getByRole('button',{name:'查看加入消息（1条）'}));
      await ready();
      fireEvent.click(screen.getByRole('button',{name:mode==='graph'?'切换为消息表':'切换为消息图'}));
      fireEvent.click(screen.getByRole('checkbox',{name:'屏蔽结算消息'}));
      await ready();
      const joinMode=mode==='graph'?'list':'graph',joinScroll=write(100);
      expect(filterState()).toEqual([false,true]);
      const join=left.querySelector<HTMLElement>('[data-msgid="join-B"]')!;
      fireEvent.click(within(join).getByTitle(/跳转到.*消息 C/));
      await ready();
      expect(screen.queryByText('加入记录临时分类（1）')).toBeNull();
      const destinationMode=screen.queryByRole('button',{name:'切换为消息表'})?'graph':'list';
      const destinationFilters=filterState(),destinationScroll=write(200);
      const back=()=>fireEvent.click(screen.getByRole('button',{name:'返回'}));
      const forward=()=>fireEvent.click(screen.getByRole('button',{name:'前进'}));
      const assertRecords=async()=>{
        expect(screen.getByText('加入记录临时分类（1）')).toBeInTheDocument();
        expect(screen.getByRole('button',{name:joinMode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
        expect(filterState()).toEqual([false,true]);
        await ready();await waitFor(()=>expect(read()).toEqual(joinScroll));
      };
      back();await assertRecords();
      back();
      expect(screen.queryByText('加入记录临时分类（1）')).toBeNull();
      expect(screen.getByRole('button',{name:mode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
      expect(filterState()).toEqual([true,false]);
      await ready();await waitFor(()=>expect(read()).toEqual(originScroll));
      forward();await assertRecords();
      forward();await ready();await waitFor(()=>expect(read()).toEqual(destinationScroll));
      expect(filterState()).toEqual(destinationFilters);
      expect(screen.getByRole('button',{name:destinationMode==='list'?'切换为消息图':'切换为消息表'})).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      // Reverse before the viewport restore paints: preserve its intended scroll.
      back();forward();await ready();await waitFor(()=>expect(read()).toEqual(destinationScroll));
      back();await assertRecords();
      fireEvent.click(screen.getByRole('button',{name:'退出临时分类'}));
      await ready();await waitFor(()=>expect(read()).toEqual(originScroll));
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      back();await assertRecords();
      expect(mockApi.getWorkbenchSnapshot).toHaveBeenCalledTimes(requests);
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();
    }finally{
      graphRendering.actual=false;dimensions.forEach(spy=>spy.mockRestore());
      if(scrollingElement)Object.defineProperty(document,'scrollingElement',scrollingElement);
      else Reflect.deleteProperty(document,'scrollingElement');
    }
  });

  it('waits for background view positioning before saving a manually scrolled location', async () => {
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
      // aria-busy only describes the blocking load; mode-switch navigation has
      // a live positioning ticket even though the workbench is interactive.
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
      expect(graphRendering.tasks!.pending).toBeGreaterThan(0);
      const panel = document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      panel.scrollTop = 730; panel.scrollLeft = 90;
      await waitForWorkbenchIdle();
      // Reproduce the old test's race: the scheduled centering overwrites a
      // position assigned while aria-busy is false but navigation is pending.
      expect([panel.scrollTop, panel.scrollLeft]).not.toEqual([730, 90]);
      panel.scrollTop = 730; panel.scrollLeft = 90;
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
      // Ordinary navigation is non-blocking. Its delayed centering still owns a
      // positioning task after aria-busy becomes false, so wait before scrolling.
      const ready=waitForWorkbenchIdle;
      await waitFor(()=>expect(latest()?.messages.some((message:Message)=>message.id==='A')).toBe(true));
      await ready();
      vi.useFakeTimers();
      const left=document.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
      const right=document.querySelector<HTMLElement>('.workbench-right-panel')!,page=document.documentElement;
      const row=(id:string)=>left.querySelector<HTMLElement>(`[data-msgid="${id}"]:not([data-rel-overlay])`)!;
      const readScroll=()=>[left.scrollTop,left.scrollLeft,right.scrollTop,right.scrollLeft,page.scrollTop,page.scrollLeft];
      const filter=()=>[screen.getByRole<HTMLInputElement>('checkbox',{name:'屏蔽加入消息'}).checked,
        screen.getByRole<HTMLInputElement>('checkbox',{name:'屏蔽结算消息'}).checked];
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
      type Saved={kind:'container'|'records'|'root';id:string;mode:'graph'|'list';filter:boolean[];scroll:number[]};
      let position=0;
      const save=async(kind:Saved['kind'],id:string,view:Saved['mode'],settings:boolean[]):Promise<Saved>=>{
        if(mode()!==view){fireEvent.click(screen.getByRole('button',{name:view==='graph'?'切换为消息图':'切换为消息表'}));await ready();}
        if(!screen.queryByRole('checkbox',{name:'屏蔽加入消息'}))fireEvent.click(screen.getByRole('button',{name:/清爽/}));
        for(const [index,label] of ['屏蔽加入消息','屏蔽结算消息'].entries()){
          const input=screen.getByRole<HTMLInputElement>('checkbox',{name:label});
          if(input.checked!==settings[index])fireEvent.click(input);
        }
        await ready();position++;
        const scroll=[300+position*110,20+position*13,80+position*37,10+position*11,650+position*130,15+position*17];
        [left.scrollTop,left.scrollLeft,right.scrollTop,right.scrollLeft,page.scrollTop,page.scrollLeft]=scroll;
        return {kind,id,mode:view,filter:settings,scroll};
      };
      const assertSaved=async(saved:Saved)=>{
        await ready();
        expect(mode()).toBe(saved.mode);expect(filter()).toEqual(saved.filter);
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
            expect(screen.getByRole('button',{name:`暂存消息 ${saved.id}`})).toBeInTheDocument();
          }
        }
        expect(readScroll()).toEqual(saved.scroll);
      };
      const back=()=>fireEvent.click(screen.getByRole('button',{name:'返回'}));
      const forward=()=>fireEvent.click(screen.getByRole('button',{name:'前进'}));
      const opposite=initialMode==='graph'?'list':'graph';
      const states:Saved[]=[];
      await enter('A');states.push(await save('container','A',initialMode,[true,true]));
      await records('A');states.push(await save('records','A',opposite,[false,false]));
      await follow('A','B');states.push(await save('root','B',initialMode,[true,false]));
      await enter('B');states.push(await save('container','B',opposite,[true,false]));
      await records('B');states.push(await save('records','B',initialMode,[false,true]));
      await follow('B','C');states.push(await save('root','C',opposite,[true,true]));
      await enter('C');states.push(await save('container','C',initialMode,[true,false]));
      await records('C');states.push(await save('records','C',opposite,[false,true]));
      await assertSaved(states.at(-1)!);
      for(let index=states.length-2;index>=0;index--){back();await assertSaved(states[index]);}
      for(const state of states.slice(1)){forward();await assertSaved(state);}
      // Return to B's records, then replace the old C route with A -> records -> C.
      for(const index of [6,5,4]){back();await assertSaved(states[index]);}
      expect(screen.getByRole('button',{name:'前进'})).toBeEnabled();
      await follow('B','A');
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      const branch=states.slice(0,5);
      branch.push(await save('root','A',opposite,[true,true]));
      await enter('A');branch.push(await save('container','A',initialMode,[true,false]));
      await records('A');branch.push(await save('records','A',opposite,[false,true]));
      await follow('A','C');branch.push(await save('root','C',initialMode,[true,false]));
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
      fireEvent.click(screen.getByRole('button',{name:'返回'}));
      expect(latest().comparisonSingle).toBe(true);
      await waitFor(()=>expect(left.scrollTop).toBe(350));
      fireEvent.click(screen.getByRole('button',{name:'前进'}));
      expect(screen.getByText('被加入记录临时分类（1）')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'返回'}));
      fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
      expect(latest().comparisonSingle).toBe(false);
      expect(latest().rejectedContainerIds.has('C')).toBe(true);
      expect(latest().messages.map((message:Message)=>message.id)).toContain('B');
      expect(screen.getByRole('button',{name:'前进'})).toBeDisabled();
      fireEvent.click(screen.getByRole('button',{name:'返回'}));
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
    fireEvent.click(screen.getByRole('button',{name:/清爽/}));
    fireEvent.click(screen.getByRole('checkbox',{name:'屏蔽加入消息'}));
    await act(async()=>latest().onCanvasBlankClick(event()));
    fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
    await waitFor(()=>expect(screen.queryByRole('region',{name:'单侧对比'})).toBeNull());
    expect(latest().messages.map((m:Message)=>m.id)).toEqual(originalIds);
    expect(latest().draftUnits).toEqual([]);
    expect(latest().rejectedContainerIds.has('C')).toBe(true);
    expect(screen.getByRole('checkbox',{name:'屏蔽加入消息'})).toBeChecked();
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
    fireEvent.click((await screen.findAllByText('C'))[0]);
    fireEvent.click(screen.getByRole('button',{name:'审阅'}));
    await waitFor(()=>expect(latest().comparisonPair).toBe(true));
    const agreeInA={messages:latest().comparisonAgreeMessages,edges:latest().comparisonAgreeEdges,context:latest().comparisonAgreeContext};
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    const agreeInP={messages:latest().comparisonAgreeMessages,edges:latest().comparisonAgreeEdges,context:latest().comparisonAgreeContext};
    fireEvent.click(screen.getByRole('button',{name:'退出分类'}));
    const agreeAtRoot={messages:latest().comparisonAgreeMessages,edges:latest().comparisonAgreeEdges,context:latest().comparisonAgreeContext};
    fireEvent.click(screen.getByRole('button',{name:'退出对比'}));
    await act(async()=>latest().onRelatedMessageNavigate('C'));
    const single=()=>({messages:latest().messages,edges:latest().edges,context:{relatedMessages:latest().relatedMessages,relatedEdges:latest().relatedEdges,rejectedContainerIds:latest().rejectedContainerIds,joinStatusByMessage:latest().joinStatusByMessage,joinEffectSourcesByMessage:latest().joinEffectSourcesByMessage,crossCanvasRelations:latest().crossCanvasRelations}});
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
    fireEvent.click(screen.getByRole('radio', { name: /^自发$/ }));

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
      expect(card().querySelector('[data-message-self-stake="msg-1"]')).toHaveTextContent('自押 2/3');
      const authors=within(card()).getByRole('button',{name:/当前正文作者：tester，共 2 人/});
      fireEvent.wheel(authors,{deltaY:100});
      expect(authors).toHaveAccessibleName(/当前正文作者：bob，共 2 人/);
      expect(card().querySelector('[data-message-self-stake="msg-1"]')).toHaveTextContent('自押 5/7');
      fireEvent.wheel(authors,{deltaY:-100});
      expect(card().querySelector('[data-message-self-stake="msg-1"]')).toHaveTextContent('自押 2/3');
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
      expect(card().querySelector('[data-message-self-stake="msg-1"]')).toHaveTextContent('自押 6/7');
      expect(dialog.querySelector('[data-author-contribution="msg-1"]')).toHaveTextContent('首次 2/3 · 追加 4/4');
      fireEvent.click(within(dialog).getByRole('button',{name:'关闭作者详情'}));
      fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));fireEvent.click(screen.getByRole('radio',{name:'原文'}));await waitForWorkbenchIdle();
      expect(within(card()).getByRole('button',{name:'查看消息 msg-1 的当前正文作者：tester'})).toBeInTheDocument();
      expect(card()).toHaveTextContent('开头旧字结尾');
      fireEvent.click(screen.getByRole('radio',{name:'推荐选择'}));await waitForWorkbenchIdle();
      expect(within(card()).getByRole('button',{name:/当前正文作者：tester，共 2 人/})).toBeInTheDocument();
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
      tooltip.scrollTop=24;list.scrollTop=106;fireEvent.scroll(list);
      fireEvent.click(within(tooltip).getByRole('button',{name:'回复 · hint-impact-5'}));
      await waitFor(()=>expect(screen.getByRole('button',{name:'返回'})).toBeEnabled());
      await waitForWorkbenchIdle();
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.click(screen.getByRole('button',{name:'返回'}));
      await waitForWorkbenchIdle();
      const restored=await screen.findByRole('tooltip');
      expect(restored).toHaveTextContent('12 条影响待阅');
      expect(restored.scrollTop).toBe(24);expect(restored.querySelector('[data-display-hint-influences]')!.scrollTop).toBe(106);
      expect(screen.getByRole('button',{name:mode==='graph'?'切换为消息表':'切换为消息图'})).toBeInTheDocument();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);
  it.each(['graph','list'])('switches corrected versions in place with back/forward and requires the original in %s',async mode=>{
    localStorage.setItem('token','test-token');
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('msg-1','版本测试原文')]});
    mockApi.getRelations.mockResolvedValue({data:[
      {...makeRelation(),id:'version-1',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'msg-1'}],
        createdAt:'2026-10-21T00:00:00Z',payload:{correctionBeforeContent:'版本测试原文',correctionAfterContent:'版本测试更正一'}},
      {...makeRelation(),id:'version-2',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'msg-1'}],
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
      expect(screen.getByRole('button',{name:'标记当前消息已阅'})).toBeDisabled();
      fireEvent.click(screen.getByRole('button',{name:'切回原文 msg-1'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试原文');expect(card()).not.toHaveTextContent('版本测试更正二');
      fireEvent.click(screen.getByRole('button',{name:'确认原文已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));
      fireEvent.click(screen.getByRole('button',{name:'版本后退 msg-1'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正一');
      fireEvent.click(screen.getByRole('button',{name:/^显示提示 msg-1：/}));
      expect(screen.getByRole('button',{name:'标记当前消息已阅'})).toBeDisabled();
      expect(screen.getByRole('tooltip')).toHaveTextContent('首次确认还需阅读更正');
      fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledTimes(1));await waitForWorkbenchIdle();
      fireEvent.click(screen.getByRole('button',{name:'切换消息 msg-1 的版本'}));
      expect(screen.getAllByRole('radio')).toHaveLength(3);
      fireEvent.click(screen.getByRole('radio',{name:'推荐选择'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正二');expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('推荐选择');
      fireEvent.click(screen.getByRole('button',{name:'版本后退 msg-1'}));await waitForWorkbenchIdle();expect(card()).toHaveTextContent('版本测试更正一');
      fireEvent.click(screen.getByRole('button',{name:'版本前进 msg-1'}));await waitForWorkbenchIdle();expect(card()).toHaveTextContent('版本测试更正二');
      expect(mockNavigate).not.toHaveBeenCalled();expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
      const marker=()=>screen.getByRole('button',{name:'切换消息 msg-1 的版本'});
      expect(marker()).toHaveAttribute('data-reading-version-override','true');
      fireEvent.click(screen.getByRole('button',{name:'恢复默认显示 msg-1'}));await waitForWorkbenchIdle();
      expect(card()).toHaveTextContent('版本测试更正一');expect(marker()).toHaveAttribute('data-reading-version-override','false');
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
  it.each(['CLASSIFY','SUMMARY'].flatMap(type=>['graph','list'].map(mode=>({type,mode}))))('retains corrected $type through relation type filtering in $mode',async({type,mode})=>{
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
      fireEvent.click(screen.getByRole('button',{name:'过滤'}));fireEvent.click(screen.getByRole('button',{name:'按关系类型'}));
      const editor=screen.getByText('选择关系类型：').parentElement!;
      fireEvent.change(within(editor).getByRole('combobox'),{target:{value:'CORRECT'}});
      fireEvent.click(within(editor).getByRole('button',{name:'确认'}));await waitForWorkbenchIdle();
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="filter-body"]')).toHaveTextContent('过滤更正后');
      expect(view.container.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')).toBeNull();
      expect(screen.getByText(/^匹配 1 条/)).toBeInTheDocument();
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
      await waitFor(()=>expect(screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/})).toHaveAttribute('data-display-reading','related-unread'));
      const marker=screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/});fireEvent.click(marker);
      expect(screen.getByRole('tooltip')).toHaveTextContent('1 条影响待阅');
      expect(screen.getByRole('tooltip')).toHaveTextContent('earlier-reply');
      fireEvent.click(screen.getByRole('button',{name:/标记回复 earlier-reply 已阅/}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledTimes(2));
      await waitFor(()=>expect(screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/})).toHaveAttribute('data-display-reading','read'));
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
      fireEvent.pointerDown(document.body);
      fireEvent.click(view.container.querySelector('[data-workbench-left-panel] [data-msgid="msg-1"]')!);
      fireEvent.click(screen.getByRole('button',{name:'标注'}));
      expect(screen.queryByRole('button',{name:'已读'})).toBeNull();expect(screen.queryByRole('button',{name:'未读'})).toBeNull();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);
  it.each(['CLASSIFY','SUMMARY'].flatMap(type=>['graph','list'].map(mode=>({type,mode}))))('confirms a single JOIN privately inside $type in $mode without an extra container read',async({type,mode})=>{
    localStorage.setItem('token','test-token');
    mockApi.getMessages.mockResolvedValue({data:[makeMessage('msg-1','当前成员'),makeMessage('msg-2','仍待阅的成员')]});
    mockApi.getRelations.mockResolvedValue({data:[
      {...makeRelation(),id:'classification-1',relationType:type,sourceMessageId:null,targetRefs:[{kind:'message',messageId:'msg-1'},{kind:'message',messageId:'msg-2'}],payload:{title:'当前容器'}},
      {...makeRelation(),id:'current-join',relationType:'JOIN',sourceMessageId:'classification-1',targetRefs:[{kind:'message',messageId:'msg-1'}]},
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
      const tooltip=screen.getByRole('tooltip');expect(tooltip).toHaveTextContent('1 条影响待阅');expect(tooltip).toHaveTextContent('current-join');
      expect(within(tooltip).queryByRole('button',{name:/^(分类|总结) · classification-1/})).toBeNull();
      fireEvent.click(within(tooltip).getByRole('button',{name:'标记当前消息已阅'}));
      await waitFor(()=>expect(mockApi.markReading).toHaveBeenCalledOnce());
      const marks=mockApi.markReading.mock.calls[0][0];
      for(const id of ['msg-1','current-join'])expect(marks).toContainEqual(expect.objectContaining({messageId:id,scope:'message'}));
      expect(marks.filter((mark:{scope:string})=>mark.scope!=='influence')).toHaveLength(2);expect(marks.some((mark:{messageId:string;scope:string})=>mark.messageId==='classification-1'&&mark.scope!=='influence')).toBe(false);
      expect(marks.some((mark:{messageId:string;scope:string})=>mark.messageId==='msg-2'&&mark.scope!=='influence')).toBe(false);
      await waitFor(()=>expect(screen.getByRole('button',{name:/显示提示 msg-1：消息已阅/})).toHaveAttribute('data-display-reading','read'));
      expect(screen.getByRole('button',{name:/显示提示 msg-2：消息待阅/})).toBeInTheDocument();
      expect(mockApi.createMessage).not.toHaveBeenCalled();expect(mockApi.createRelation).not.toHaveBeenCalled();expect(mockApi.castVote).not.toHaveBeenCalled();
    }finally{view.unmount();graphRendering.actual=false;}
  },15000);
  it.each(['CLASSIFY', 'SUMMARY'].flatMap(type => ['graph', 'list'].flatMap(mode => (['TEXT'] as const).map(correctionKind => ({ type, mode, correctionKind })))))(
    'displays a body correction of $type from $mode ($correctionKind), restores the original on personal rejection and keeps correction history', async ({ type, mode, correctionKind }) => {
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
      expect(within(correctedCard).getByRole('button',{name:'查看消息 editable-container 的当前正文作者：tester，共 1 人'})).toHaveTextContent('✎ 1人');
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
      fireEvent.click(record);
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
        expect(screen.getByText('更正查看')).toBeInTheDocument();
        expect(screen.queryByText('✏ 更正对比')).toBeNull();
        expect(screen.queryByRole('dialog',{name:'显示提示与差别'})).toBeNull();
        const previewCard=view.container.querySelector<HTMLElement>('[data-workbench-left-panel] [data-msgid="editable-container"]:not([data-rel-overlay])')!;
        expect(previewCard).toHaveTextContent('需要更正的加长的新正文');
        expect(previewCard.textContent?.includes('✓7')).toBe(correctionKind==='TEXT');
        const graph=mockGraphView.mock.lastCall![0];
        const priorVote=graph.edges.find((edge:{relationMessageId:string})=>edge.relationMessageId===oldVote.id);
        expect(priorVote).toBeDefined();
        expect(graph.excludedStanceEdges.has(priorVote.id)).toBe(false);
        const ownHint=previewCard.querySelector('[data-display-hint-scope="message"]')!;
        const versionEntry=ownHint.previousElementSibling!;
        expect(versionEntry).toHaveAttribute('data-reading-versions',container.id);
        expect(versionEntry.previousSibling?.textContent).toBe(container.id);
        expect(previewCard.querySelectorAll('[data-display-hint-scope="corrections"]')).toHaveLength(0);
        expect(within(versionEntry as HTMLElement).getByRole('button',{name:'切换消息 editable-container 的版本'})).toBeInTheDocument();
        expect(mockApi.createRelation).toHaveBeenCalledTimes(2);
        await act(async()=>mockGraphView.mock.lastCall![0].onDecorationBodyClick({stopPropagation:vi.fn()},container.id,'agree'));
        expect(mockGraphView.mock.lastCall![0].draftUnits.map((unit:{messageId:string})=>unit.messageId)).toEqual(correctionKind==='TEXT'?[oldVote.id]:[]);
        if(correctionKind==='TEXT')fireEvent.click(screen.getByRole('button',{name:'清空'}));
        fireEvent.click(screen.getByRole('button',{name:'退出查看'}));
        await waitForWorkbenchIdle();
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
    } finally { window.getSelection()?.removeAllRanges(); view.unmount(); geometry.mockRestore(); graphRendering.actual = false; mockApi.getWorkbenchSnapshot.mockImplementation(snapshotLoader); }
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
      expect(screen.getByRole('button',{name:'显示标注 msg-1'})).toHaveAttribute('aria-expanded','false');
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
      if(stanceType==='AGREE')expect(screen.getByRole('button',{name:'显示装饰 voted-reference'})).toHaveAttribute('aria-expanded','false');
      else expect(view.container.querySelector('[data-msgid="reference-stance"]:not([data-rel-overlay])')).toHaveTextContent('反对');
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
        fireEvent.click(screen.getByRole('button',{name:'显示装饰 arrangement'}));
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
      expect(document.querySelector('[data-workbench-left-panel] [data-msgid="category"]:not([data-rel-overlay])')).toBeNull();
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

  it.each([false, true])('keeps natural content inside independent sticky viewports after sending (frozen top controls: %s)', async topControlsFrozen => {
    localStorage.setItem('token', 'test-token');
    mockApi.createMessage.mockResolvedValueOnce(makeMessage('sent-height-check', '新增消息'));
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 200, 500, 500));
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1800);
    try {
      render(<MessageWorkbenchPage topControlsFrozen={topControlsFrozen} />);
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
      expect(pane.style.top).toBe(`${500 + (topControlsFrozen ? 68 : 0)}px`);
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
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      const latest = () => mockGraphView.mock.lastCall![0];
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, outer.id));
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, inner.id));
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      if (sentKind === 'relation') {
        await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
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
    await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
    const latest = () => mockGraphView.mock.lastCall![0];
    await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
    await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, destination.id));
    fireEvent.click(screen.getByRole('button', { name: '加入来源集合' }));
    await act(async () => latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1'));
    fireEvent.click(screen.getByRole('button', { name: '分类' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })));
    await waitFor(()=>expect(mockApi.createRelation).toHaveBeenCalledWith(current.id, expect.objectContaining({ relationType: 'JOIN', sourceMessageId: destination.id })));
    expect(latest().lastClickedMessageId).toBe('msg-1');
    expect(screen.getByRole('button', { name: '退出分类' }).parentElement).toHaveTextContent('当前分类');
    expect(screen.queryByText('已定位目标消息')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('locates text and every relation in send order within the current classification, skipping generated JOINs', async () => {
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
    try {
      render(<MessageWorkbenchPage />);
      await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）');
      const latest = () => mockGraphView.mock.lastCall![0];
      await act(async () => latest().onMessageDoubleClick({ button: 0, stopPropagation: vi.fn() }, current.id));
      await act(async () => {
        latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-1');
        latest().onMessageClick({ button: 0, stopPropagation: vi.fn() }, 'msg-2');
      });
      fireEvent.click(screen.getByRole('button', { name: '切换为消息表' }));
      fireEvent.click(screen.getByRole('button', { name: '回复' }));
      fireEvent.change(screen.getByPlaceholderText('输入一条新文本消息（支持自由换行）'), { target: { value: sent.content } });
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
      fireEvent.click(send);
      expect(mockApi.createMessage).toHaveBeenCalledOnce();
      expect(root.inert).toBe(true);
      await frames();
      expect(document.querySelector('[data-message-jump-target="slow-first"]')).not.toBeNull();
      expect(root.inert).toBe(false);
      expect(send).toBeEnabled();
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
      await act(async () => finishCommit());
      await waitFor(() => expect(screen.getByText('已定位目标消息')).toBeInTheDocument());
      await waitFor(() => expect(screen.queryByText('正在等待服务器确认发送，请勿重复提交。')).toBeNull());
      await waitFor(() => expect(panel.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
      expect(panel.scrollTop).toBeGreaterThan(0);
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
    'scrolls the active $side first and hands only its boundary remainder to the other side, then the page (direction $direction)', async ({ side, direction }) => {
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
        expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge, 300 + direction * 60, 400]);
        wheel(current, -20);
        expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge - direction * 20, 300 + direction * 60, 400]);

        nested.scrollTop = current.scrollTop = edge - direction * 40; other.scrollTop = 300; page.scrollTop = 400;
        wheel(nested, 100);
        expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge, edge, 300 + direction * 20, 400]);
        wheel(nested, -20);
        expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge - direction * 20, edge, 300 + direction * 20, 400]);

        nested.scrollTop = current.scrollTop = edge;
        other.scrollTop = edge - direction * 10;
        wheel(nested, 40);
        expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge, edge, edge, 400 + direction * 30]);
        wheel(nested, -20);
        expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge - direction * 20, edge, edge, 400 + direction * 30]);
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
    render(<MessageWorkbenchPage />);
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());
    await act(async () => mockGraphView.mock.lastCall![0].onMessageClick({ button: 0, stopPropagation: vi.fn() }, inner.id));
    fireEvent.click(screen.getByRole('button', { name: '分类' }));
    const textarea = screen.getByPlaceholderText('输入分类名称（不能为空）');
    fireEvent.change(textarea, { target: { value: '外层分类' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mockApi.createRelation).toHaveBeenCalledWith('classification-1', expect.objectContaining({
      relationType: 'CLASSIFY', targetRefs: [expect.objectContaining({ kind: 'relation', relationId: inner.id, reference: { messageId: inner.id,context:{kind:'MESSAGE'} } })],
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
      mockApi.getCurrentRules.mockResolvedValue({parameters:{minStake:1,stakeFeeAmount:1}});
      render(<MessageWorkbenchPage/>);
      fireEvent.change(await screen.findByPlaceholderText('输入一条新文本消息（支持自由换行）'),{target:{value:'协议费刷新'}});
      expect(await screen.findByText('协议费 1 点/条')).toBeInTheDocument();
      expect(screen.getByText(/本次 2 条消息，预计 4 点/)).toBeInTheDocument();
      mockApi.getCurrentRules.mockResolvedValue({parameters:{minStake:1,stakeFeeAmount:3}});
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
      const textarea = screen.getByPlaceholderText('已选择附加关系，此处不可输入');
      expect(textarea).toHaveAttribute('readonly');
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
    fireEvent.change(screen.getByPlaceholderText('输入消息 ID'), { target: { value: 'rel-merge' } });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(mockGraphView.mock.lastCall![0].messages.map((message: { id: string }) => message.id))
      .toEqual(expect.arrayContaining(['rel-merge', 'msg-a', 'msg-b'])));
    expect(screen.getByText('内层分类')).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole('button', { name: '切换为消息表' }));
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
      expect(screen.getByText('rel-supp')).toBeInTheDocument();
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
        fireEvent.click(screen.getByRole('button', { name: '+' }));
        expect(screen.getByText('追溯距离：2')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '清空' }));
        await select('replacement', transientList);
        fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
        expect(screen.getByText('当前追溯消息：').parentElement).toHaveTextContent('replacement');
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
        await act(async () => latest().onGroupFrameDoubleClick(event(), frameId));
        const expanded = [...latest().traceExpandedFrameIds];
        expect(expanded).toContain(frameId);
        await paint();
        const traceScroll = writeScroll(50);
        await act(async () => latest().onJoinFilterClick('m1', 'incoming'));
        fireEvent.click(screen.getByRole('button', { name: '清空' }));
        await select('join', false);
        fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));
        expect(screen.getByText('当前追溯消息：').parentElement).toHaveTextContent('join');
        fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
        expect(screen.getByText('当前追溯消息：').parentElement).toHaveTextContent('replacement');
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
          expect(screen.getByText('追溯距离：2')).toBeInTheDocument();
          expect(screen.getByText('当前追溯消息：').parentElement).toHaveTextContent(flow === 'trace-through-join' ? 'join' : 'replacement');
        }
      }
      const beforeExit = mockApi.getWorkbenchSnapshot.mock.calls.length;
      fireEvent.click(exit());
      expect(screen.getByRole('button', { name: sourceScope === 'inner' ? '退出总结' : '退出分类' }).parentElement).toHaveTextContent(`${sourceScope}标题`);
      expect(screen.getByRole('button', { name: mode === 'graph' ? '切换为消息表' : '切换为消息图' })).toBeInTheDocument();
      await waitFor(() => expect(readScroll()).toEqual(originScroll));
      await paint();
      expect(readScroll()).toEqual(originScroll);
      if (traceMode) expect(document.querySelector('[data-guide-selection-staging]')).toHaveTextContent('m2');
      expect(screen.queryByText(/追溯距离：/)).toBeNull();
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
        if (currentMode === 'graph') await act(async () => latest().onMessageDoubleClick(event(), id));
        else fireEvent.doubleClick(left.querySelector(`[data-msgid="${id}"]`)!);
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
      fireEvent.click(screen.getByRole('button', { name: '+' }));
      await paint();
      const traceScroll = writeScroll(3);
      await act(async () => latest().onJoinFilterClick('m2', 'incoming'));
      writeScroll(4);
      fireEvent.click(screen.getByRole('button', { name: '清空' }));
      await select('join');
      fireEvent.click(screen.getByRole('button', { name: '设为追溯消息' }));

      hold = true;
      fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
      expect(screen.getByText('当前追溯消息：').parentElement).toHaveTextContent('m2');
      // Re-enter before the previous layer's saved scroll has been applied.
      for (let repeat = 0; repeat < 3; repeat++) {
        await act(async () => latest().onJoinFilterClick('m2', 'incoming'));
        fireEvent.click(screen.getByRole('button', { name: '退出临时分类' }));
      }
      const beforeResume = mockApi.getWorkbenchSnapshot.mock.calls.length;
      let resumes = 0;
      const resume = async (changed = false) => {
        const before = mockApi.getWorkbenchSnapshot.mock.calls.length;
        act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
        expect(held.size).toBeGreaterThan(0);
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
      expect(screen.getByText('追溯距离：2')).toBeInTheDocument();
      expect(screen.getByText('当前追溯消息：').parentElement).toHaveTextContent('m2');

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
      expect(screen.queryByText(/追溯距离：/)).toBeNull();
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
