import { createRef, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import WorkbenchPanel from '../components/WorkbenchPanel';
import GuideOverlay from '../components/GuideOverlay';
import ZhihuReplyEditor from '../components/ZhihuReplyEditor';
import WorkbenchLoadingBoundary, { useWorkbenchLoadingProgress } from '../components/WorkbenchLoadingBoundary';
import * as zhihuArchive from '../utils/zhihuArchive';
import { secondaryRelationLabel } from '../pages/workbench/model/relationComposition';
import type { UnitSelection } from '../utils/modelBridge';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { prepareZhihuForViewing, serializeZhihuViewingData, type ZhihuViewingData } from '../utils/zhihuArchive';

type PanelProps = ComponentProps<typeof WorkbenchPanel>;
type EditorProps = ComponentProps<typeof ZhihuReplyEditor>;
const noop = () => {};

// Structural source records, never presented as captured discussion samples.
function fixture() {
  return prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    owner: { id: 'panel-fixture-owner', name: '结构测试账号' },
    items: [{ id: '10', type: 'answer', text: '结构测试正文', completeness: { body: 'complete', comments: 'complete' } }],
    comments: [{ id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null }],
  });
}

function baseProps(data: ZhihuViewingData): PanelProps {
  const model = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
  return {
    rightPanelRef: createRef(), leftPanelRef: createRef(), TOTAL_FLEX: 10, leftFlex: 7, minWidth: 280,
    isPreviewMode: false, isViewerMode: true, draftUnits: [], draftGroups: [], activeTextSelectId: null,
    clearDraftAll: noop, removeUnitFromDraft: noop, commitDraftTo: noop, selKey: unit => unit.messageId,
    sourceUnits: [], targetUnits: [], removeUnitFrom: noop, describeUnit: unit => unit.messageId,
    traceDistance: 1, canSetTrace: false, canExitTrace: false, getSelectedWholeMessageIds: () => [],
    lastClickedMessageId: model.messages.find(message => data.zhihu.byMessageId[message.id]?.kind === 'item')!.id,
    enterTraceMultiple: noop, enterTrace: noop, exitAllTrace: noop, onNavigateToMessage: noop, currentTraceIds: null,
    ...model, user: null, relationType: 'correct', secondaryRelationType: 'text-correction', setSecondaryRelationType: noop,
    hasSecondaryRelationSelector: true, tagSecondaryOptions: [], correctSecondaryOptions: ['text-correction', 'width-adjustment'],
    proposalSecondaryOptions: [], isArrangeType: false, isClassifyType: false, isSummaryType: false, isMergeType: false,
    isGovernanceOrOpsType: false, isTagWithQuickAnnotate: false, hasTargetsAvailable: true, draftHasRelationTarget: false,
    hasTextContent: false, secondaryRelationLabel, replyAdditionalLabel: value => value,
    subType: '', setSubType: noop, subTypeCustomLabel: '', setSubTypeCustomLabel: noop, subTypeCustomBufferRef: { current: '' },
    SUB_TYPE_OPTIONS: [], subTypeLabel: value => value, relationLabel: '', setRelationLabel: noop,
    newMessageContent: '', setNewMessageContent: noop, composerRefreshKey: 'panel-fixture',
    recommendationAmount: 0, setRecommendationAmount: noop, stakeAmount: 1, setStakeAmount: noop,
    relStakeAmount: 1, setRelStakeAmount: noop, availablePoints: 100, effectiveMinStake: 1,
    singleButtonEnabled: true, singleButtonLabel: '', sendValidationLabel: null, totalConsumption: null,
    stakeFeeAmountRef: { current: 1 }, subTypeStakeMap: { current: {} }, relationStakeMap: { current: {} },
    handleQuickSendAndRelateFromDraftTargets: vi.fn(), sendError: null, sendWarning: null,
    showStanceHistory: false, setShowStanceHistory: noop, showAuditLog: false, setShowAuditLog: noop,
    showRevenue: false, setShowRevenue: noop, scopeMessageId: 'root', contributionGroups: [], onContributionChange: noop,
    relationChoices: <div data-testid="native-relation-choices">关系类型</div>,
  };
}

function localPanel(data: ZhihuViewingData, onSave = vi.fn().mockResolvedValue(undefined), editor: Partial<EditorProps> = {}) {
  const props = baseProps(data);
  const selected: UnitSelection = { messageId: props.lastClickedMessageId!, selection: { kind: 'whole' } };
  props.draftUnits = [selected];
  props.localReplyEditor = renderSendControls => <ZhihuReplyEditor data={data} sourceUnits={[]} targetUnits={[]}
    draftUnits={[selected]} onSave={onSave} relationType="correct" {...editor} renderSendControls={renderSendControls} />;
  return props;
}

function precedes(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
}

function ReadyDocument() { useWorkbenchLoadingProgress(false, null); return null; }

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('shared workbench controls in the local document panel', () => {
  it.each(['text', 'relation'] as const)('blocks sending while reviewing %s consumption, then allows the send step', mode => {
    const props = { ...baseProps(fixture()), isViewerMode: false,
      totalConsumption: { total: 3, messageCount: 1, protocolFeeTotal: 1, stakeTotal: 2, recommendationTotal: 0, delegationRewardStake: 0 } };
    render(<><WorkbenchPanel {...props} /><GuideOverlay open onClose={vi.fn()} /></>);
    if (mode === 'text') {
      fireEvent.input(document.querySelector('[data-guide-message-input="true"]')!, { target: { value: '引导测试' } });
      fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    } else act(() => window.dispatchEvent(new Event('guide-stance-selected')));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    const summary = document.querySelector('[data-guide-contribution-consumption="true"]')!;
    expect(summary).toContainElement(screen.getByLabelText('费用明细'));
    const send = screen.getByRole('button', { name: '发送' });
    expect(summary).not.toContainElement(send);
    fireEvent.pointerDown(send);
    fireEvent.click(send);
    expect(props.handleQuickSendAndRelateFromDraftTargets).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('当前步骤目标区域外有操作限制');
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(send);
    expect(props.handleQuickSendAndRelateFromDraftTargets).toHaveBeenCalledOnce();
  });

  it('shows sending and disables the local submit button before processing the document, then waits for saving',async()=>{
    vi.useFakeTimers();
    const process=vi.spyOn(zhihuArchive,'sendZhihuLocalRelation');
    let finish!:()=>void;
    const save=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const props=localPanel(fixture(),save,{correctionMode:'width-adjustment',correctionWidth:640});
    const view=render(<WorkbenchLoadingBoundary><ReadyDocument/><WorkbenchPanel {...props}/></WorkbenchLoadingBoundary>);
    try{
      act(()=>vi.advanceTimersByTime(50));
      expect(screen.queryByRole('dialog')).toBeNull();
      const send=screen.getByRole('button',{name:'发送'});
      expect(send).toBeEnabled();fireEvent.click(send);
      expect(send).toBeDisabled();
      expect(screen.getByRole('dialog',{name:'正在发送'})).toBeInTheDocument();
      expect(process).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
      await act(async()=>{await vi.advanceTimersByTimeAsync(16);});
      expect(process).not.toHaveBeenCalled();
      await act(async()=>{await vi.advanceTimersByTimeAsync(18);});
      expect(process).toHaveBeenCalledOnce();expect(save).toHaveBeenCalledOnce();
      expect(send).toBeDisabled();
      fireEvent.click(send);expect(save).toHaveBeenCalledOnce();
      await act(async()=>{finish();});
      act(()=>vi.advanceTimersByTime(50));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    }finally{view.unmount();vi.useRealTimers();}
  });

  it.each(['local', 'online'] as const)('keeps the native collection, composer, send and message connections order in %s mode', mode => {
    const data = fixture(), props = mode === 'local' ? localPanel(data) : { ...baseProps(data), isViewerMode: false };
    const { container } = render(<WorkbenchPanel {...props} />);
    const staging = container.querySelector('.desk-staging')!;
    const collections = container.querySelector('.desk-endpoints')!;
    const choices = screen.getByTestId('native-relation-choices');
    const composer = container.querySelector<HTMLElement>('.workbench-composer-section')!;
    const send = screen.getByRole('button', { name: '发送' });
    const connections = screen.getByRole('region', { name: '消息关联' });
    precedes(staging, collections); precedes(collections, choices); precedes(choices, composer);
    expect(composer).toContainElement(send); precedes(send, connections);
    if (mode === 'local') {
      const extras = screen.getByRole('region', { name: '知乎资料整理' });
      precedes(connections, extras);
      expect(within(composer).getByRole('note')).toHaveTextContent('尚未修改');
      expect(screen.queryByText(/选择有效关系/)).toBeNull();
      expect(container.querySelector('[data-local-relation]')).toBeNull();
      expect(screen.getByText('本地发送')).toBeInTheDocument();
      expect(screen.queryByLabelText('当前用户')).toBeNull();
      expect(screen.queryByText('保存到本地文档')).toBeNull();
      expect(screen.queryByRole('button', { name: '预览' })).toBeNull();
      expect(container.querySelector('[data-contribution-policy]')).toBeNull();
      expect(extras).toHaveTextContent('不会覆盖打开的原文件');
    } else {
      expect(screen.queryByRole('region', { name: '知乎资料整理' })).toBeNull();
      expect(container.querySelector('[data-contribution-policy]')).not.toBeNull();
      fireEvent.click(send);
      expect(props.handleQuickSendAndRelateFromDraftTargets).toHaveBeenCalledOnce();
    }
  });

  it('uses the native width editor and send button for a local width correction without publishing or changing source text', async () => {
    const data = fixture(), onSave = vi.fn().mockResolvedValue(undefined), network = vi.spyOn(globalThis, 'fetch');
    const props = localPanel(data, onSave);
    const { container } = render(<WorkbenchPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '宽度调整' }));
    const composer = container.querySelector<HTMLElement>('.workbench-composer-section')!;
    const width = screen.getByRole('spinbutton', { name: '消息卡宽度' });
    expect(composer).toContainElement(width);
    expect(within(composer).queryByRole('textbox')).toBeNull();
    fireEvent.change(width, { target: { value: '640' } });
    const send = screen.getByRole('button', { name: '发送' });
    expect(send.closest('.desk-submit-bar')).not.toBeNull();
    expect(send).toBeEnabled(); fireEvent.click(send);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const next = onSave.mock.calls[0][0] as ZhihuViewingData;
    const correction = archiveToWorkbenchSnapshot(next).relations.find(relation => relation.payload?.correctionKind === 'WIDTH');
    expect(correction?.payload?.correctionWidth).toBe(640);
    expect(correction?.targetRefs).toEqual([expect.objectContaining({ messageId: props.lastClickedMessageId })]);
    expect(next.zhihu.archive).toEqual(data.zhihu.archive);
    const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(next)));
    expect(archiveToWorkbenchSnapshot(reopened).relations.find(relation => relation.id === correction?.id)?.payload?.correctionWidth).toBe(640);
    expect(props.handleQuickSendAndRelateFromDraftTargets).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it.each([319, 2401, 640.5])('keeps an invalid supplied width %s disabled with a nearby explanation', width => {
    render(<WorkbenchPanel {...localPanel(fixture(), vi.fn(), { correctionMode: 'width-adjustment', correctionWidth: width })} />);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('320 至 2400');
  });

  it('keeps a failed save visible beside the shared button and preserves the pending correction for retry', async () => {
    const data = fixture(), onSave = vi.fn().mockRejectedValue(new Error('调整尚未保存'));
    const { container } = render(<WorkbenchPanel {...localPanel(data, onSave)} />);
    const composer = container.querySelector<HTMLElement>('.workbench-composer-section')!;
    const textarea = within(composer).getByRole('textbox');
    const send = screen.getByRole('button', { name: '发送' });
    expect(send).toBeDisabled();
    fireEvent.change(textarea, { target: { value: '更正结构测试正文' } });
    expect(send).toBeEnabled(); fireEvent.click(send);
    await waitFor(() => expect(within(composer).getByRole('alert')).toHaveTextContent('调整尚未保存'));
    expect(textarea).toHaveValue('更正结构测试正文');
    expect(send).toBeEnabled();
    expect(data.zhihu.localOperations.operations).toHaveLength(0);
  });

  it('leaves a standard exported Gonglun document read-only', () => {
    const props = { ...baseProps(fixture()), relationChoices: undefined };
    render(<WorkbenchPanel {...props} />);
    expect(screen.getByLabelText('当前用户')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    expect(screen.queryByRole('region', { name: '知乎资料整理' })).toBeNull();
    expect(screen.getByRole('region', { name: '消息关联' })).toBeInTheDocument();
  });
});
