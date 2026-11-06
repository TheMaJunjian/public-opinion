import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createRef, useState, type ComponentProps } from 'react';
import type { ExportData } from '../api/client';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import LocalReplyEditor from '../components/ZhihuReplyEditor';
import RelationToolbar, { RelationChoices, type LocalRelationType } from '../pages/workbench/ui/RelationToolbar';
import { setTheme } from '../theme/theme';
import { getZhihuCorrectableFields, getZhihuDisplayFields, getZhihuMissingContent, getZhihuInactiveRelationIds, getZhihuLocalRelations, getZhihuReplyRelations, prepareZhihuForViewing, serializeZhihuViewingData, sendZhihuLocalRelation, updateZhihuRelations, type ZhihuViewingData } from '../utils/zhihuArchive';
import { loadCachedExport, loadLastExport, saveLastExportPersistent } from '../utils/exportViewerCache';
import { api } from '../api';
import { referenceToUnit } from '../utils/modelBridge';
import { bodyVersion } from '@gonglun/core';

const route = vi.hoisted(() => ({ current: { pathname: '/viewer', search: '', hash: '', key: 'first', state: null as { exportData: ExportData; viewerInstanceKey?: string } | null } }));
vi.mock('react-router-dom', () => ({ useLocation: () => route.current }));
vi.mock('../utils/exportViewerCache', () => ({ loadCachedExport: vi.fn(), loadLastExport: vi.fn(), saveLastExportPersistent: vi.fn(),
  loadReferencedExport: vi.fn(), loadExportNavigation: vi.fn(async () => null), releaseDurableExportMemory: vi.fn(), inheritExportCacheReference: (data: unknown) => data }));
vi.mock('../api', () => ({ api: { getWorkbenchSnapshot: vi.fn(), subscribeChanges: vi.fn() } }));

// Empty-body structural fixtures; no invented discussion content is presented as a sample.
function fixture() {
  return prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    owner: { id: 'fixture-owner', name: '技术测试账号' },
    items: [{ id: '10', type: 'answer', text: '' }],
    comments: [
      { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
      { id: '2', sourceId: '2', threadId: 'answer:10', text: '', rootCommentId: '2', parentCommentId: null },
      { id: '3', sourceId: '3', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null, sourceLabels: ['包含AI生成内容'] },
    ],
  });
}
const id = (number: string) => `zhihu:comment:answer%3A10:${number}`;
const unit = (number: string) => ({ messageId: id(number), selection: { kind: 'whole' as const } });
const changed = (data = fixture()) => updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [id('3')], targetMessageIds: [id('2')] });
const input = (navigate = vi.fn()) => ({ user: null, authLoading: false, scopeMessageId: 'root', navigate, viewMode: 'list' as const });

function composerFixture(): ComponentProps<typeof RelationChoices>['composer'] {
  return {
    relationType: null, secondaryRelationType: 'none', newMessageContent: '', subType: null,
    setRelationType: vi.fn(), setSecondaryRelationType: vi.fn(), setNewMessageContent: vi.fn(),
    lastTagSecondaryRef: { current: '' }, lastDelegationSecondaryRef: { current: 'create' },
    savedTextOnTypeSwitchRef: { current: '' }, subTypeCustomBufferRef: { current: '' }, guideTargetIdRef: { current: null },
  };
}

// The controller's send slot is driven directly here; the full-page test covers the shared submit bar.
function ZhihuReplyEditor(props: Omit<ComponentProps<typeof LocalReplyEditor>, 'relationType' | 'renderSendControls'>) {
  const [relationType, setRelationType] = useState<LocalRelationType | null>('reply');
  const [busy, setBusy] = useState(false);
  const composer = composerFixture();
  const localMode = { relationType, onChange: setRelationType, disabled: busy };
  return <>
    <RelationChoices composer={composer} localMode={localMode} placement="toolbar" />
    <RelationChoices composer={composer} localMode={localMode} placement="desk" />
    <LocalReplyEditor {...props} relationType={relationType} onBusyChange={setBusy}
      onSelectCorrection={props.onSelectCorrection ? messageId => { setRelationType('correct'); props.onSelectCorrection?.(messageId); } : undefined}
      renderSendControls={controls => <>{controls.composer && <>
        {controls.composer.settings}
        <textarea value={controls.composer.content} placeholder={controls.composer.placeholder} readOnly={controls.composer.readOnly} onChange={event => controls.composer?.onContentChange(event.target.value)} />
        {controls.composer.direction && <button onClick={() => controls.composer?.onDirectionChange?.('horizontal')}>横</button>}
      </>}<button disabled={!controls.enabled} onClick={controls.onSend}>发送</button>{controls.feedback}</>} />
  </>;
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  setTheme('opus-paper');
  vi.mocked(loadCachedExport).mockResolvedValue(null);
  vi.mocked(loadLastExport).mockResolvedValue(null);
  vi.mocked(saveLastExportPersistent).mockResolvedValue();
  route.current = { pathname: '/viewer', search: '', hash: '', key: 'first', state: { exportData: fixture() } };
});

it.each(['gpt', 'gpt-arena', 'opus-paper'] as const)('shares reply, agreement, opposition and organization choices in %s without touching the online composer', theme => {
  setTheme(theme);
  const composer = composerFixture(), onChange = vi.fn();
  const localMode = { relationType: 'reply' as const, onChange };
  const ref = createRef<HTMLDivElement>();
  const toolbarProps = { barRef: ref, leftControlsRef: ref, rightControlsRef: ref, top: 0, springWidth: 0, rightOffset: 0,
    viewer: true, knownIds: new Set<string>(), onJump: vi.fn(), composer };
  const view = render(<><RelationToolbar {...toolbarProps} localMode={localMode} /><RelationChoices placement="desk" composer={composer} localMode={localMode} /></>);
  expect(screen.getAllByRole('button', { name: '回复' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '赞同' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '反对' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '更正' })).toHaveLength(1);
  for (const name of ['分类', '总结', '归并', '排列']) expect(screen.getAllByRole('button', { name })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '赞同' }));
  expect(onChange).toHaveBeenCalledWith('agree');
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  expect(onChange).toHaveBeenCalledWith('disagree');
  fireEvent.click(screen.getByRole('button', { name: '回复' }));
  expect(onChange).toHaveBeenLastCalledWith(null);
  expect(composer.setRelationType).not.toHaveBeenCalled();
  expect(composer.setSecondaryRelationType).not.toHaveBeenCalled();
  expect(composer.setNewMessageContent).not.toHaveBeenCalled();
  view.rerender(<RelationToolbar {...toolbarProps} />);
  expect(screen.queryByRole('button', { name: '回复' })).toBeNull();
  expect(screen.queryByRole('button', { name: '反对' })).toBeNull();
});

it('persists before updating the local snapshot without replacing browser history', async () => {
  const navigate = vi.fn();
  const { result } = renderHook(() => useWorkbenchData(input(navigate)));
  await waitFor(() => expect(result.current.messages).toHaveLength(fixture().messages.length));
  const previous = result.current.loadedExport;
  let finish!: () => void;
  vi.mocked(saveLastExportPersistent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const next = changed();
  let pending!: Promise<void>;
  act(() => { pending = result.current.persistPreloadedExport(next); });
  await waitFor(() => expect(saveLastExportPersistent).toHaveBeenCalledWith(next, previous));
  expect(result.current.loadedExport).toBe(previous);
  expect(result.current.edges.filter(edge => edge.relationType === 'reply')).toHaveLength(2);
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => { finish(); await pending; });
  expect(result.current.loadedExport).toBe(next);
  expect(result.current.edges.filter(edge => edge.relationType === 'reply')).toHaveLength(3);
  expect(result.current.isPreloaded).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  expect(result.current.preloadedData).toBe(next);
  expect(api.getWorkbenchSnapshot).not.toHaveBeenCalled();
  expect(api.subscribeChanges).not.toHaveBeenCalled();
});

it('keeps the viewer loaded across consecutive local saves without a route restore or history clone',async()=>{
  const loadingStates:boolean[]=[];
  const navigate=vi.fn((_path:string,options:{state:NonNullable<typeof route.current.state>})=>{
    route.current={...route.current,key:'saved-route',state:structuredClone(options.state)};
  });
  const {result}=renderHook(()=>{
    const value=useWorkbenchData(input(navigate));
    loadingStates.push(value.loading);
    return value;
  });
  await waitFor(()=>expect(result.current.loading).toBe(false));
  const routeBefore=route.current,reads=vi.mocked(loadCachedExport).mock.calls.length,next=changed();
  loadingStates.length=0;
  await act(async()=>{await result.current.persistPreloadedExport(next);});
  expect(loadingStates).not.toContain(true);
  expect(route.current).toBe(routeBefore);
  expect(navigate).not.toHaveBeenCalled();
  expect(vi.mocked(loadCachedExport)).toHaveBeenCalledTimes(reads);
  expect(result.current.preloadedData).toBe(next);
  const second=changed(next);
  await act(async()=>{await result.current.persistPreloadedExport(second);});
  expect(result.current.loadedExport).toBe(second);
  expect(result.current.preloadedData).toBe(second);
  expect(saveLastExportPersistent).toHaveBeenLastCalledWith(second,next);
  expect(loadingStates).not.toContain(true);
});

it('keeps old snapshot and route intact when durable storage fails', async () => {
  const navigate = vi.fn();
  const { result } = renderHook(() => useWorkbenchData(input(navigate)));
  await waitFor(() => expect(result.current.messages).toHaveLength(fixture().messages.length));
  const previous = result.current.loadedExport;
  vi.mocked(saveLastExportPersistent).mockRejectedValue(new Error('空间不足，调整尚未保存'));
  await act(async () => { await expect(result.current.persistPreloadedExport(changed())).rejects.toThrow('调整尚未保存'); });
  expect(result.current.loadedExport).toBe(previous);
  expect(result.current.edges.filter(edge => edge.relationType === 'reply')).toHaveLength(2);
  expect(navigate).not.toHaveBeenCalled();
});

it('does not reopen the viewer if the user leaves while a local save is pending', async () => {
  const navigate = vi.fn();
  const { result, unmount } = renderHook(() => useWorkbenchData(input(navigate)));
  await waitFor(() => expect(result.current.messages).toHaveLength(fixture().messages.length));
  let finish!: () => void;
  vi.mocked(saveLastExportPersistent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = result.current.persistPreloadedExport(changed());
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  unmount();
  finish();
  await expect(pending).rejects.toThrow('页面已切换');
  expect(navigate).not.toHaveBeenCalled();
});

it('restores the newest saved copy of the same archive instead of stale history state', async () => {
  const fresh = changed();
  vi.mocked(loadCachedExport).mockResolvedValue(fresh);
  const { result } = renderHook(() => useWorkbenchData(input()));
  await waitFor(() => expect(result.current.edges.filter(edge => edge.relationType === 'reply')).toHaveLength(3));
  expect(loadCachedExport).toHaveBeenCalledWith(fresh.zhihu.archiveId, { sourceOnly: true });
  expect(loadLastExport).not.toHaveBeenCalled();
  expect(api.getWorkbenchSnapshot).not.toHaveBeenCalled();
});

it('opens the last local file at a bare viewer URL without login or server access', async () => {
  route.current = { ...route.current, state: null };
  vi.mocked(loadLastExport).mockResolvedValue(changed());
  const navigate = vi.fn();
  const { result } = renderHook(() => useWorkbenchData(input(navigate)));
  await waitFor(() => expect(result.current.edges.filter(edge => edge.relationType === 'reply')).toHaveLength(3));
  expect(result.current.isPreloaded).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  expect(api.getWorkbenchSnapshot).not.toHaveBeenCalled();
});

it('reports a missing local file on the viewer route without a login redirect', async () => {
  route.current = { ...route.current, state: null };
  const navigate = vi.fn();
  const { result } = renderHook(() => useWorkbenchData(input(navigate)));
  await waitFor(() => expect(result.current.loadError).toContain('没有可恢复的阅览文件'));
  expect(result.current.loading).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  expect(api.getWorkbenchSnapshot).not.toHaveBeenCalled();
});

it('builds a local set reply and displays storage errors without changing the source', async () => {
  const data = fixture(), onSave = vi.fn().mockRejectedValue(new Error('调整尚未保存'));
  render(<ZhihuReplyEditor data={data} sourceUnits={[unit('3')]} targetUnits={[unit('1'), unit('2')]} draftUnits={[]} onSave={onSave} />);
  expect(screen.getByText('· 原站标签：包含AI生成内容')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('调整尚未保存'));
  expect(getZhihuReplyRelations(onSave.mock.calls[0][0]).find(record => record.sourceMessageId === id('3'))?.targetMessageIds).toEqual([id('1'), id('2')]);
  expect(data.zhihu.overrides.revisions).toHaveLength(0);
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
});

it('sequence fills only unknown replies and preserves existing independent replies', async () => {
  const data = fixture(), onSave = vi.fn().mockResolvedValue(undefined);
  render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]} draftUnits={[]} onSave={onSave} />);
  fireEvent.click(screen.getByText('顺序整理与阅览设置'));
  fireEvent.click(screen.getByRole('button', { name: '按顺序补齐未知回复' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  const next = onSave.mock.calls[0][0];
  expect(getZhihuReplyRelations(next).filter(record => record.active)).toHaveLength(3);
  for (const record of getZhihuReplyRelations(data)) expect(getZhihuReplyRelations(next).find(nextRecord => nextRecord.id === record.id)?.active).toBe(true);
});

it('opposes a reply without deleting text and keeps it hidden after reopening without an agree action', async () => {
  const original = fixture();
  const originalText = original.zhihu.archive.comments.map(comment => comment.text);
  const reply = getZhihuReplyRelations(original).find(record => record.sourceMessageId === id('1'))!;
  let latest = original;
  let selectFromCanvas: (messageId: string) => void = () => {};
  const network = vi.spyOn(globalThis, 'fetch');
  function Editor({ initial }: { initial: ZhihuViewingData }) {
    const [data, setData] = useState(initial);
    const [draft, setDraft] = useState<string[]>([]), [targets, setTargets] = useState<string[]>([]);
    selectFromCanvas = messageId => setDraft([messageId]);
    return <>
      <button onClick={() => { setTargets(draft); setDraft([]); }} disabled={!draft.length}>加入目标集合</button>
      <ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={targets.map(messageId => ({ messageId, selection: { kind: 'whole' } }))}
        draftUnits={draft.map(messageId => ({ messageId, selection: { kind: 'whole' } }))}
        onSave={async next => { latest = next; setData(next); }} />
    </>;
  }
  const view = render(<Editor initial={original} />);
  act(() => selectFromCanvas(reply.id));
  fireEvent.click(screen.getByRole('button', { name: '加入目标集合' }));
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(getZhihuReplyRelations(latest).find(record => record.id === reply.id)?.active).toBe(false));
  expect(latest.zhihu.archive.comments.map(comment => comment.text)).toEqual(originalText);
  expect(screen.getByRole('button', { name: '赞同' })).toBeInTheDocument();
  expect(view.container.querySelector(`[data-reply-record="${reply.id}"]`)).toBeNull();
  const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(latest)));
  expect(getZhihuReplyRelations(reopened).find(record => record.id === reply.id)?.active).toBe(false);
  view.unmount();
  const reopenedView = render(<Editor initial={reopened} />);
  expect(reopenedView.container.querySelector(`[data-reply-record="${reply.id}"]`)).toBeNull();
  expect(getZhihuInactiveRelationIds(reopened).has(reply.id)).toBe(true);
  expect(screen.getByRole('button', { name: '赞同' })).toBeInTheDocument();
  expect(latest.zhihu.archive).toEqual(original.zhihu.archive);
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
});

it('records opposition to comment text without removing it and blocks ambiguous target collections', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined), data = fixture();
  const view = render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[unit('1')]} draftUnits={[]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  expect(screen.getByRole('note')).toHaveTextContent('正文与片段只记录表态');
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  const next = onSave.mock.calls[0][0];
  expect(next.messages.find((message: { id: string }) => message.id === id('1'))?.content).toBe('');
  expect(getZhihuInactiveRelationIds(next).has(id('1'))).toBe(false);
  view.rerender(<ZhihuReplyEditor data={data} sourceUnits={[unit('3')]} targetUnits={[unit('1')]} draftUnits={[unit('2')]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '回复' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(screen.getByRole('note')).toHaveTextContent('选择暂存区和目标集合同时有内容');
});

it('sends local agreement from source messages to selected targets and preserves it after reopening', async () => {
  const data = fixture(), onSave = vi.fn().mockResolvedValue(undefined);
  render(<ZhihuReplyEditor data={data} sourceUnits={[unit('3')]} targetUnits={[unit('1')]} draftUnits={[]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '赞同' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  const next = onSave.mock.calls[0][0] as ZhihuViewingData;
  const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(next)));
  const agreement = reopened.relations.find(relation => relation.relationType === 'AGREE');
  expect(agreement).toMatchObject({ sourceMessageId: id('3'), sourceRefs: [{ messageId: id('3') }],
    targetRefs: [expect.objectContaining({ reference: { messageId: id('1') } })] });
  expect(reopened.zhihu.archive).toEqual(data.zhihu.archive);
  expect(api.getWorkbenchSnapshot).not.toHaveBeenCalled();
});

it('keeps multiple source and target fragments from the same messages as native addresses', async () => {
  const raw = fixture().zhihu.archive;
  const data = prepareZhihuForViewing({ ...raw, comments: raw.comments.map(comment => ({ ...comment, text: '技术字段测试🙂' })) });
  const source = [{ start: 0, end: 2 }, { start: 2, end: 4 }].map(range => referenceToUnit({ messageId: id('3'), revision: 1, partId: 'body', range }));
  const targets = [{ start: 0, end: 2 }, { start: 2, end: 4 }].map(range => referenceToUnit({ messageId: id('1'), revision: 1, partId: 'body', range }));
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<ZhihuReplyEditor data={data} sourceUnits={source} targetUnits={targets} draftUnits={[]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '赞同' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  const next = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(onSave.mock.calls[0][0])));
  const operation = next.zhihu.localOperations.operations.at(-1)!;
  expect(operation.sourceMessageIds).toEqual([id('3'), id('3')]);
  expect(operation.sourceReferences).toEqual(source.map(unit => unit.reference));
  expect(operation.targetReferences).toEqual(targets.map(unit => unit.reference));
  expect(next.relations.filter(relation => relation.relationType === 'AGREE')).toHaveLength(2);
  expect(next.zhihu.archive).toEqual(data.zhihu.archive);
});

it('allows agreement to restore an opposed reply without changing its original text', async () => {
  const original = fixture(), reply = getZhihuReplyRelations(original)[0];
  const opposed = sendZhihuLocalRelation(original, { relationType: 'DISAGREE', targetMessageIds: [reply.id] });
  expect(getZhihuInactiveRelationIds(opposed).has(reply.id)).toBe(true);
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<ZhihuReplyEditor data={opposed} sourceUnits={[]} targetUnits={[]}
    draftUnits={[{ messageId: reply.id, selection: { kind: 'whole' } }]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '赞同' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(onSave.mock.calls[0][0])));
  expect(getZhihuInactiveRelationIds(reopened).has(reply.id)).toBe(false);
  expect(reopened.zhihu.archive).toEqual(original.zhihu.archive);
});

it('preserves a BODY context without widening it into opposition to the whole classification', async () => {
  const data = fixture(), target = 'zhihu:type:answer';
  const reference = { messageId: target, context: { kind: 'BODY' as const, version: bodyVersion(target, 1, []) } };
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]} draftUnits={[referenceToUnit(reference)]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  const next = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(onSave.mock.calls[0][0])));
  expect(next.zhihu.localOperations.operations.at(-1)?.targetReferences).toEqual([reference]);
  expect(getZhihuInactiveRelationIds(next).has(target)).toBe(false);
  expect(next.zhihu.archive).toEqual(data.zhihu.archive);
});

it.each(['whole', 'badge', 'edge-reference', 'target-badge', 'source-and-draft'] as const)('opposes the selected reply through native %s targets without an extra collection step', async route => {
  const data = fixture(), onSave = vi.fn().mockResolvedValue(undefined);
  const reply = getZhihuReplyRelations(data)[0];
  const selected = route === 'whole' ? { messageId: reply.id, selection: { kind: 'whole' as const } }
    : referenceToUnit({ messageId: reply.id, revision: 1, partId: 'relation', ...(route === 'edge-reference' ? { path: ['relation'] } : {}) });
  render(<ZhihuReplyEditor data={data} sourceUnits={route === 'source-and-draft' ? [unit('3')] : []}
    targetUnits={route === 'target-badge' ? [selected] : []} draftUnits={route === 'target-badge' ? [] : [selected]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(getZhihuInactiveRelationIds(onSave.mock.calls[0][0]).has(reply.id)).toBe(true);
  expect(onSave.mock.calls[0][0].zhihu.archive).toEqual(data.zhihu.archive);
});

it('does not reinterpret a selection with a mismatched reference message ID', () => {
  const data = fixture(), onSave = vi.fn(), reply = getZhihuReplyRelations(data)[0];
  render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]}
    draftUnits={[{ ...referenceToUnit({ messageId: id('1'), revision: 1, partId: 'relation' }), messageId: reply.id }]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(onSave).not.toHaveBeenCalled();
});

it('accepts and clears the native canvas selection without a duplicate relation picker', () => {
  const data = fixture(), reply = getZhihuReplyRelations(data)[0];
  const props = { data, sourceUnits: [], targetUnits: [], onSave: vi.fn() };
  const view = render(<ZhihuReplyEditor {...props} draftUnits={[]} />);
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  view.rerender(<ZhihuReplyEditor {...props} draftUnits={[{ messageId: reply.id, selection: { kind: 'whole' } }]} />);
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  expect(screen.queryByText(/选择有效关系/)).toBeNull();
  expect(view.container.querySelector('[data-local-relation]')).toBeNull();
  view.rerender(<ZhihuReplyEditor {...props} draftUnits={[]} />);
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(props.onSave).not.toHaveBeenCalled();
});

it('keeps a source-only reply as evidence instead of silently reversing its role', () => {
  const data = fixture(), onSave = vi.fn(), reply = getZhihuReplyRelations(data)[0];
  render(<ZhihuReplyEditor data={data} sourceUnits={[{ messageId: reply.id, selection: { kind: 'whole' } }]} targetUnits={[]} draftUnits={[]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(screen.getByRole('note')).toHaveTextContent('来源集合表示依据');
  expect(onSave).not.toHaveBeenCalled();
});

it.each([
  { revision: 2, partId: 'relation' },
  { revision: 1, partId: 'relation', path: ['roles', 'targets'] },
  { revision: 1, partId: 'relation', memberId: 'member' },
  { revision: 1, partId: 'relation', range: { start: 0, end: 1 } },
  { revision: 1, partId: 'body' },
])('does not expand partial or historical selection $partId into opposition to a whole relation', reference => {
  const data = fixture(), onSave = vi.fn(), reply = getZhihuReplyRelations(data)[0];
  render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]} draftUnits={[referenceToUnit({ messageId: reply.id, ...reference })]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(screen.getByRole('note')).toHaveTextContent('过期地址不能发送');
  expect(onSave).not.toHaveBeenCalled();
});

it('allows document messages and containers as reply sources', () => {
  const raw = fixture().zhihu.archive;
  const data = prepareZhihuForViewing({ ...raw, items: [{ ...raw.items[0], question: { id: '20', title: '', text: '' } }] });
  const questionId = Object.entries(data.zhihu.byMessageId).find(([, meta]) => meta.kind === 'question')![0];
  const onSave = vi.fn();
  render(<ZhihuReplyEditor data={data} sourceUnits={[{ messageId: questionId, selection: { kind: 'whole' } }]} targetUnits={[unit('1')]} draftUnits={[]} onSave={onSave} />);
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  expect(screen.getByRole('note')).toHaveTextContent('每次发送新增独立回复');
  expect(onSave).not.toHaveBeenCalled();
});

it('keeps repeated reply sends independent and active', async () => {
  let latest = fixture();
  function Editor() {
    const [data, setData] = useState(latest);
    return <ZhihuReplyEditor data={data} sourceUnits={[unit('3')]} targetUnits={[unit('1')]} draftUnits={[]} onSave={async next => { latest = next; setData(next); }} />;
  }
  render(<Editor />);
  for (let count = 1; count <= 2; count++) {
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(getZhihuReplyRelations(latest).filter(record => record.sourceMessageId === id('3') && record.active)).toHaveLength(count));
  }
  const replies = getZhihuReplyRelations(latest).filter(record => record.sourceMessageId === id('3'));
  expect(new Set(replies.map(record => record.id)).size).toBe(2);
  expect(getZhihuReplyRelations(prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(latest)))).filter(record => record.sourceMessageId === id('3') && record.active)).toHaveLength(2);
});

it.each([{ name: '分类', type: 'CLASSIFY', text: '结构测试分类' }, { name: '总结', type: 'SUMMARY', text: '结构测试总结' },
  { name: '归并', type: 'MERGE', text: '' }, { name: '排列', type: 'ARRANGE', text: '' }])('creates and reopens local $name using native choice controls', async ({ name, type, text }) => {
  const data = fixture(), onSave = vi.fn().mockResolvedValue(undefined);
  render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[unit('2'), unit('1')]} draftUnits={[]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name }));
  if (text) fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  if (type === 'ARRANGE') fireEvent.click(screen.getByRole('button', { name: '横' }));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(onSave.mock.calls[0][0])));
  const organization = getZhihuLocalRelations(reopened).find(record => record.relationType === type)!;
  expect(organization).toBeDefined(); expect(organization.active).toBe(true);
  expect(organization.targetMessageIds).toEqual([id('2'), id('1')]);
  if (type === 'ARRANGE') expect((reopened.messages.find(message => message.id === organization.id)?.relationPayload as { targetLayout?: string })?.targetLayout).toBe('single-row');
  expect(reopened.zhihu.archive).toEqual(data.zhihu.archive);
});

it('lists reported missing fields and prepares a local correction without guessing text', async () => {
  const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '', completeness: { body: 'partial' }, question: { id: '20', title: '' } }],
    comments: [{ id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null,
      completeness: { body: 'complete' }, issues: [{ code: 'direct-parent-unknown', message: '直接上级未确认' }] }] });
  const questionId = Object.entries(original.zhihu.byMessageId).find(([, meta]) => meta.kind === 'question')![0];
  let latest = original;
  let selectFromCanvas: (messageId: string) => void = () => {};
  function Editor() {
    const [data, setData] = useState(original), [draft, setDraft] = useState<string[]>([]);
    selectFromCanvas = messageId => setDraft([messageId]);
    return <ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]}
      draftUnits={draft.map(messageId => ({ messageId, selection: { kind: 'whole' } }))}
      onSelectCorrection={messageId => setDraft([messageId])}
      onSent={() => setDraft([])} onSave={async next => { latest = next; setData(next); }} />;
  }
  const network = vi.spyOn(globalThis, 'fetch');
  const view = render(<Editor />);
  expect(getZhihuMissingContent(original).map(entry => entry.label)).toEqual(expect.arrayContaining(['问题标题', '问题描述', '作品正文']));
  fireEvent.click(screen.getByText(/^缺失或待确认的内容（/));
  await waitFor(() => expect(view.container.querySelector('[data-missing-message]')).not.toBeNull());
  expect(view.container.querySelector(`[data-missing-message="${id('1')}"]`)).toBeNull();
  const missing = () => view.container.querySelector(`[data-missing-message="${questionId}"][data-missing-field="body"] button`)!;
  fireEvent.click(missing());
  expect(screen.getByRole('button', { name: '更正' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('combobox', { name: '更正字段' })).toHaveValue('body');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '本地测试描述' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(getZhihuDisplayFields(latest, questionId).body).toBe('本地测试描述'));
  expect(missing()).toHaveTextContent('已本地补充');
  expect(latest.zhihu.archive).toEqual(original.zhihu.archive);
  expect(getZhihuCorrectableFields(latest, questionId).find(field => field.field === 'body')?.originalStatus).toBe('unknown');
  const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(latest)));
  expect(getZhihuDisplayFields(reopened, questionId).body).toBe('本地测试描述');
  const correction = getZhihuLocalRelations(latest).find(relation => relation.relationType === 'CORRECT')!;
  act(() => selectFromCanvas(correction.id));
  fireEvent.click(screen.getByRole('button', { name: '反对' }));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(getZhihuDisplayFields(latest, questionId).body).toBe(''));
  expect(missing()).not.toHaveTextContent('已本地补充');
  expect(latest.zhihu.archive).toEqual(original.zhihu.archive);
  expect(network).not.toHaveBeenCalled(); network.mockRestore();
});

it('keeps question title and description correction fields separate', async () => {
  const data = prepareZhihuForViewing({ ...fixture().zhihu.archive,
    items: [{ id: '10', type: 'answer', text: '', question: { id: '20', title: '', text: '' } }] });
  const questionId = Object.entries(data.zhihu.byMessageId).find(([, meta]) => meta.kind === 'question')![0];
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]} draftUnits={[{ messageId: questionId, selection: { kind: 'whole' } }]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '更正' }));
  fireEvent.change(screen.getByRole('combobox', { name: '更正字段' }), { target: { value: 'title' } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '本地测试标题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(getZhihuDisplayFields(onSave.mock.calls[0][0], questionId)).toMatchObject({ title: '本地测试标题', body: '' });
  expect(onSave.mock.calls[0][0].zhihu.archive).toEqual(data.zhihu.archive);
});

it('lists legacy bodies with no completeness record as unknown rather than verified empty', async () => {
  const data = fixture();
  const missing = getZhihuMissingContent(data).find(entry => entry.messageId === id('1'));
  expect(missing?.originalStatus).toBe('unknown');
  const view = render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]} draftUnits={[]} onSave={vi.fn()} onSelectCorrection={vi.fn()} />);
  fireEvent.click(screen.getByText(/^缺失或待确认的内容（/));
  await waitFor(() => expect(view.container.querySelector(`[data-missing-message="${id('1')}"] button`)).toHaveTextContent('完整性'));
});

it.each(['whole', 'body-part'] as const)('corrects an original body through its complete %s selection', async selection => {
  const data = fixture(), onSave = vi.fn().mockResolvedValue(undefined);
  const selected = selection === 'whole' ? unit('1') : referenceToUnit({ messageId: id('1'), revision: 1, partId: 'body' });
  render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]} draftUnits={[selected]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '更正' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '本地正文测试' } });
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(getZhihuDisplayFields(onSave.mock.calls[0][0], id('1')).body).toBe('本地正文测试');
  expect(onSave.mock.calls[0][0].zhihu.archive).toEqual(data.zhihu.archive);
});

it.each([
  { partId: 'body', range: { start: 0, end: 1 } },
  { partId: 'body', memberId: 'member' },
  { partId: 'body', revision: 2 },
])('does not expand a partial or historical body address into a whole-field correction', reference => {
  const data = fixture(), onSave = vi.fn();
  render(<ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]}
    draftUnits={[referenceToUnit({ messageId: id('1'), ...reference })]} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '更正' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '局部范围结构测试' } });
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(onSave).not.toHaveBeenCalled();
});
