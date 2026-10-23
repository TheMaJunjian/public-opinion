import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { RelationPayload, TargetRef } from '../types';
import { MemoryRouter } from 'react-router-dom';
import WorkbenchMessageList from '../pages/workbench/ui/WorkbenchMessageList';
import type { DemoMessage, RelationType } from '../utils/modelBridge';
import { convertMessagesToDemoModel } from '../utils/modelBridge';
import { capturePartSelection } from '../utils/partSelection';
import { renderMessageContentWithAnchorsForList, renderRelationContentWithTargets } from '../pages/workbench/actions/messageRendering';

const message = (id: string, extra: Partial<DemoMessage> = {}): DemoMessage => ({
  id, revision: 1, kind: 'normal', author: '作者', authorId: 'author', createdAt: '2026-10-20T00:00:00Z', content: `正文 ${id}`, ...extra,
});

function listProps(messages: DemoMessage[]): ComponentProps<typeof WorkbenchMessageList> {
  const onNavigate = vi.fn();
  return {
    visibleMessages: messages,
    catalog: { messages, edges: [], msgMap: new Map(messages.map(item => [item.id, item])), relationById: new Map(),
      relationTypeByRelMsgId: new Map(messages.flatMap(item => item.relationType ? [[item.id, item.relationType] as const] : [])),
      joinRelationsByTarget: new Map(), joinRelationsBySource: new Map(), effectiveJoinRelationIds: new Set(),
      summaryCoverageByMessageId: new Map(), correctionVersions: new Map() },
    display: { embeddedMessageIds: new Set(), suppressedRelIds: new Set(), rejectedContainerIds: new Set(), overriddenStanceRelIds: new Set(),
      readStatusByMessageId: new Map(), homeDisplayRoleByMessageId: new Map(), authorStakes: {}, stakeCounts: {}, correctionFilterTargetId: null, joinFilterTargetId: null },
    comparison: { comparisonReviewed: false, comparisonTargetId: null, comparisonRecommendedDisplay: 'agree',
      activeStanceByRelMsgId: new Map(), activeStanceMap: new Map(), stanceEffectByRelMsgId: new Map() },
    settlement: { settlementOpenMsgId: null, settlementOpenType: null, settlementEntryHighlight: null,
      closeSettlement: vi.fn(), openSettlement: vi.fn(), onMessageCreated: vi.fn() },
    selection: { draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null },
    cardHandlers: { onClick: vi.fn(), onDoubleClick: vi.fn(), onMouseDown: vi.fn(), onMouseUp: vi.fn(), onContentMouseUp: vi.fn() },
    scopeMessageId: 'root', onJoinFilter: vi.fn(), onNavigate, onCorrectionNavigate: vi.fn(),
    renderRelation: item => renderRelationContentWithTargets({ handleNavigateToMessage: onNavigate }, item),
    renderContent: item => renderMessageContentWithAnchorsForList({ edges: [], isFragmentSelected: () => false, handleFragmentAnchorClick: vi.fn() }, item),
  };
}

const renderList = (messages: DemoMessage[], props = listProps(messages)) => render(<MemoryRouter><WorkbenchMessageList {...props} /></MemoryRouter>);
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.getSelection()?.removeAllRanges(); });

describe('native list content and navigation regressions', () => {
  it.each(['classify', 'summary', 'delegation'] as const)('keeps the %s text card unchanged while only pure relation records use the compact layout', relationType => {
    const textRelation = message('text-relation', { kind: 'relation', relationType,
      relationPayload: { title: '完整的关系正文' }, parts: [{ id: 'body', type: 'text', text: '完整的关系正文' }] });
    const record = message('record', { kind: 'relation', relationType: 'agree', content: '目标：text-relation',
      targetRefs: [{ kind: 'message', messageId: 'text-relation' }] });
    const view = renderList([textRelation, record, message('text')]);
    const textCard = view.container.querySelector<HTMLElement>('[data-msgid="text-relation"]')!;
    const recordRow = view.container.querySelector<HTMLElement>('[data-msgid="record"]')!;
    expect(textCard).not.toHaveAttribute('data-relation-record');
    expect(textCard.style.backgroundColor).not.toBe('transparent');
    expect(textCard).toHaveTextContent('完整的关系正文');
    expect(recordRow).toHaveAttribute('data-relation-record', 'true');
    const textRow = view.container.querySelector<HTMLElement>('[data-msgid="text"]')!;
    expect(recordRow.style.backgroundColor).toBe(textRow.style.backgroundColor);
    expect(recordRow.style.borderTop).toBe(textRow.style.borderTop);
    expect(recordRow.style.borderRadius).toBe(textRow.style.borderRadius);
    expect(within(recordRow).getAllByText('text-relation')).toHaveLength(1);
  });

  it.each([false, true])('shows source and target IDs once for a pure relation record (native description: %s)', native => {
    const record = message('reference', { kind: 'relation', relationType: 'reference',
      sourceMessageId: 'source-id', targetRefs: [{ kind: 'message', messageId: 'target-id' }],
      content: '引用  source-id → target-id',
      ...(native ? { parts: [
        { id: 'body', type: 'text', text: '建立关系：REFERENCE；目标：target-id' },
        { id: 'relation', type: 'relation', relation: 'reference', roles: {} },
        { id: 'display', type: 'display', relationPartId: 'relation', layout: 'relation' },
      ] } : {}),
    });
    const props = listProps([record]), view = renderList([record], props);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="reference"]')!;
    expect(row).not.toHaveTextContent('建立关系');
    expect(row).not.toHaveTextContent('→');
    for (const id of ['source-id', 'target-id']) {
      expect(within(row).getAllByText(id)).toHaveLength(1);
      fireEvent.click(within(row).getByRole('button', { name: id }));
      expect(props.onNavigate).toHaveBeenLastCalledWith(id);
    }
    expect(props.cardHandlers.onClick).not.toHaveBeenCalled();
  });

  it.each(['REPLY', 'AGREE', 'REFERENCE'])('removes generated target descriptions from real %s projections, including relation parts and fragments', relationType => {
    const targetRefs: TargetRef[] = [
      { kind: 'relation', relationId: 'whole-target', part: 'whole' },
      { kind: 'relation', relationId: 'label-target', part: 'label' },
      { kind: 'text-fragment', messageId: 'fragment-target', text: '用于验证长片段摘要也不会被作为重复正文显示的文本', hash: 'fragment-hash' },
      { kind: 'message', messageId: 'message-target' },
    ];
    const converted = convertMessagesToDemoModel([], [{ id: 'projected-relation', relationType, sourceMessageId: 'source-id',
      targetRefs, createdAt: '', createdBy: { id: 'author', username: '作者', createdAt: '' } }]);
    const props = listProps(converted.messages), view = renderList(converted.messages, props);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="projected-relation"]')!;
    expect(row).toHaveAttribute('data-relation-record', 'true');
    expect(row).not.toHaveTextContent('（whole）');
    expect(row).not.toHaveTextContent('（label）');
    expect(row).not.toHaveTextContent('用于验证长片段摘要');
    for (const id of ['source-id', 'whole-target', 'label-target', 'fragment-target', 'message-target']) {
      expect(row.textContent!.split(id)).toHaveLength(2);
      fireEvent.click(within(row).getByRole('button', { name: id }));
      expect(props.onNavigate).toHaveBeenLastCalledWith(id);
    }
    expect(props.cardHandlers.onClick).not.toHaveBeenCalled();
  });

  it('preserves authored native relation text even when it includes a generated-looking target description', () => {
    const body = '这是需要保留的说明\n目标：target-id（whole）';
    const record = message('authored-relation', { kind: 'relation', relationType: 'reference',
      targetRefs: [{ kind: 'relation', relationId: 'target-id', part: 'whole' }],
      parts: [
        { id: 'body', type: 'text', text: body },
        { id: 'relation', type: 'relation', relation: 'reference', roles: {} },
        { id: 'display', type: 'display', relationPartId: 'relation', layout: 'relation' },
      ],
    });
    const view = renderList([record]);
    expect(view.container.querySelector('[data-message-part-id="body"]')?.textContent).toBe(body);
  });

  it.each(['REPLY', 'AGREE', 'REFERENCE'])('removes stored %s descriptions with abbreviated target IDs', relationType => {
    const targetId = 'cmv0xqmon00xt78kz0774od10';
    const converted = convertMessagesToDemoModel([], [{ id: 'legacy-short-description', relationType, sourceMessageId: 'source-id',
      targetRefs: [{ kind: 'message', messageId: targetId }],
      parts: [
        { id: 'body', type: 'text', text: `建立关系：${relationType}；目标：0774od10` },
        { id: 'relation', type: 'relation', relation: relationType.toLowerCase(), roles: {} },
        { id: 'display', type: 'display', relationPartId: 'relation', layout: 'relation' },
      ], createdAt: '', createdBy: { id: 'author', username: '作者', createdAt: '' } }]);
    const view = renderList(converted.messages);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="legacy-short-description"]')!;
    expect(row).not.toHaveTextContent('建立关系');
    expect(row.textContent!.split('0774od10')).toHaveLength(2);
    expect(within(row).getByRole('button', { name: targetId })).toBeVisible();
  });

  it.each([
    ['ROUND', 'TRUTH'], ['ROUND', 'VALUE'], ['ROUND_RESULT', 'TRUTH'], ['ROUND_RESULT', 'VALUE'],
  ] as const)('shows %s %s settlement records compactly with their ID and a navigable target', (kind, settlementType) => {
    const label = `${settlementType === 'VALUE' ? '价值' : '真假'}仲裁`;
    const content = kind === 'ROUND' ? `发起${label}：目标消息「建立关系：JOIN；目标：target-id」`
      : `${label}完成：目标消息 target-id；结果：赞成胜出（TRUE）；TRUE 权重 20，FALSE 权重 10`;
    const converted = convertMessagesToDemoModel([{ id: 'settlement-id', kind, contentType: 'TEXT', content,
      createdAt: '', createdBy: { id: 'author', username: '作者', createdAt: '' },
      targetRefs: [{ kind: 'relation', relationId: 'target-id', part: 'whole' }], relationPayload: { settlementType } as unknown as RelationPayload,
      parts: [{ id: 'body', type: 'text', text: content }],
    }], []);
    const props = listProps(converted.messages), view = renderList(converted.messages, props);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="settlement-id"]')!;
    expect(row).toHaveAttribute('data-relation-record', 'true');
    expect(row).toHaveTextContent('settlement-id');
    expect(row.textContent!.split('target-id')).toHaveLength(2);
    expect(row).not.toHaveTextContent('建立关系');
    if (kind === 'ROUND_RESULT') expect(row).toHaveTextContent('结果：赞成胜出（TRUE）；TRUE 权重 20，FALSE 权重 10');
    fireEvent.click(within(row).getByRole('button', { name: 'target-id' }));
    expect(props.onNavigate).toHaveBeenCalledWith('target-id');
    expect(props.cardHandlers.onClick).not.toHaveBeenCalled();
  });

  it.each(['subjectId', 'targetMessageId'])('uses settlement %s metadata when target references are absent and keeps distribution details', field => {
    const converted = convertMessagesToDemoModel([{ id: 'settlement-result', kind: 'ROUND_RESULT', contentType: 'TEXT',
      content: '对赌分配：30 贡献点；作者 +30。', createdAt: '', createdBy: { id: 'author', username: '作者', createdAt: '' },
      relationPayload: { [field]: 'target-id' },
    }], []);
    const view = renderList(converted.messages);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="settlement-result"]')!;
    expect(within(row).getByRole('button', { name: 'target-id' })).toBeVisible();
    expect(row).toHaveTextContent('对赌分配：30 贡献点；作者 +30。');
  });

  it('identifies a legacy settlement with no recorded target instead of guessing from quoted text', () => {
    const record = message('unlinked-result', { kind: 'round_result', content: '真假仲裁完成：目标消息「相同正文」；结果：赞成胜出' });
    const view = renderList([record]);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="unlinked-result"]')!;
    expect(row).toHaveTextContent('目标未记录');
    expect(row).toHaveTextContent('结果：赞成胜出');
    expect(row.querySelector('button[title^="跳转到目标消息"]')).toBeNull();
  });

  it.each([
    ['recommend', { subType: 'IMPORTANT' }, '推荐', '重要'],
    ['archive', { subType: 'CUSTOM', customLabel: '需要保留完整内容的较长附加关系说明，不能再截断' }, '冷藏', '需要保留完整内容的较长附加关系说明，不能再截断'],
    ['tag', { label: '标签内容' }, '标注', '标签内容'],
  ] as const)('moves the %s secondary label into content without repeating it in the type badge', (relationType, relationPayload, type, content) => {
    const record = message('labeled-record', { kind: 'relation', relationType, relationPayload,
      content: '目标：target-id', targetRefs: [{ kind: 'message', messageId: 'target-id' }] });
    const view = renderList([record]);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="labeled-record"]')!;
    expect(within(row).getByText(type, { exact: true })).toBeVisible();
    expect(row.textContent!.split(content)).toHaveLength(2);
    expect(row).not.toHaveTextContent(`${type} ·`);
  });

  it('shows the correction subtype only in its existing content', () => {
    const record = message('correction', { kind: 'relation', relationType: 'correct', relationPayload: { correctionKind: 'TEXT', correctionContent: '新文字' } });
    const view = renderList([record]);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="correction"]')!;
    expect(within(row).getByText('更正', { exact: true })).toBeVisible();
    expect(row.textContent!.split('修正文字')).toHaveLength(2);
  });

  it.each([
    ['valid', '生效'], ['rejected', '被反对 · 未生效'],
    ['container-rejected', '容器被反对 · 未生效'], ['superseded', '未选中 · 未生效'],
  ] as const)('shows the shared JOIN status %s on the list record', (status, label) => {
    const relation = { id: 'joining', relationType: 'JOIN', sourceMessageId: 'parent', targetRefs: [{ kind: 'message' as const, messageId: 'leaf' }], createdAt: '', createdBy: { id: 'author', username: '作者', createdAt: '' } };
    const converted = convertMessagesToDemoModel([], [relation]), props = listProps(converted.messages);
    props.catalog.relationById.set(relation.id, relation);
    props.catalog.joinStatusByMessage = new Map([[relation.id, status]]);
    if (status === 'valid') props.catalog.effectiveJoinRelationIds.add(relation.id);
    const view = renderList(converted.messages, props);
    expect(view.container.querySelector('[data-msgid="joining"]')).toHaveTextContent(label);
  });

  it.each([['personal','当前用户生效'],['recommended','统计生效']] as const)('distinguishes %s JOIN ownership on the list', (source,label)=>{
    const relation={id:'joining',relationType:'JOIN',sourceMessageId:'parent',targetRefs:[{kind:'message' as const,messageId:'leaf'}],createdAt:'',createdBy:{id:'author',username:'作者',createdAt:''}};
    const converted=convertMessagesToDemoModel([],[relation]),props=listProps(converted.messages);
    props.catalog.relationById.set(relation.id,relation);
    props.catalog.effectiveJoinRelationIds.add(relation.id);
    props.catalog.joinStatusByMessage=new Map([[relation.id,'valid']]);
    props.catalog.joinEffectSourcesByMessage=new Map([[relation.id,new Set([source])]]);
    expect(renderList(converted.messages,props).container.querySelector('[data-msgid="joining"]')).toHaveTextContent(label);
  });

  it('reads native text, code and web parts without a projected body and preserves exact fragment references', () => {
    const target = message('future-native', { kind: 'relation', relationType: 'future-relation' as RelationType, content: '', targetRefs: [{ kind: 'message', messageId: 'native-target' }], parts: [
      { id: 'text', type: 'text', text: '未来原生正文，目标：保留原文' },
      { id: 'code', type: 'code', language: 'ts', source: 'futureNative(1);' },
      { id: 'web', type: 'web', url: 'https://example.test/source', excerpt: '原生网页摘要' },
      { id: 'data', type: 'data', value: { doNotInventBody: true } },
    ] });
    const props = listProps([target]);
    const view = renderList([target], props);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="future-native"]')!;
    expect(row.querySelector('[data-message-part-id="text"]')).toHaveTextContent('未来原生正文，目标：保留原文');
    expect(row.querySelector('[data-message-part-id="web"]')).toHaveTextContent('原生网页摘要');
    expect(row).not.toHaveTextContent('doNotInventBody');
    for (const id of ['text', 'code', 'web']) {
      const part = row.querySelector<HTMLElement>(`[data-message-part-id="${id}"]`)!;
      expect(part).toHaveAttribute('data-message-revision', '1');
      expect(part).toHaveStyle({ fontSize: '13px' });
    }
    const code = row.querySelector<HTMLElement>('[data-message-part-id="code"]')!;
    expect(code).toHaveTextContent('futureNative(1);');
    expect(code.style.fontFamily).toContain('monospace');
    const range = document.createRange();
    range.setStart(code.firstChild!, 0); range.setEnd(code.firstChild!, 6);
    window.getSelection()!.addRange(range);
    expect(capturePartSelection(row, target)).toMatchObject({ reference: {
      messageId: target.id, revision: 1, partId: 'code', range: { start: 0, end: 6 },
    } });
    fireEvent.click(within(row).getByRole('button', { name: 'native-target' }));
    expect(props.onNavigate).toHaveBeenCalledWith('native-target');
    expect(props.cardHandlers.onClick).not.toHaveBeenCalled();
  });

  it.each(['read', 'unread', 'future-relation'])('keeps native %s body text when its compatibility projection differs', relationType => {
    const target = message(`native-${relationType}`, { kind: 'relation', relationType: relationType as RelationType, content: '兼容投影字段',
      parts: [{ id: 'body', type: 'text', text: '实际原生正文' }, { id: 'relation', type: 'relation', relation: relationType, roles: {} }],
    });
    const view = renderList([target]);
    const row = view.container.querySelector(`[data-msgid="${target.id}"]`)!;
    expect(row.querySelector('[data-message-part-id="body"]')).toHaveTextContent('实际原生正文');
    expect(row).not.toHaveTextContent('兼容投影字段');
  });

  it('keeps native JOIN conversion and target navigation with its original body size', () => {
    const converted = convertMessagesToDemoModel([], [{ id: 'native-join', relationType: 'JOIN', sourceMessageId: 'native-container',
      targetRefs: [{ kind: 'message', messageId: 'native-target' }], createdAt: '2026-10-20T00:00:00Z', createdBy: { id: 'author', username: '作者', createdAt: '' },
      parts: [{ id: 'membership', type: 'relation', relation: 'member-of', roles: {} }],
    }]);
    expect(converted.messages[0].kind).toBe('join');
    const props = listProps(converted.messages);
    const view = renderList(converted.messages, props);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="native-join"]')!;
    expect(row).toHaveTextContent('native-target');
    expect(row).toHaveTextContent('native-container');
    const targetButton = within(row).getByRole('button', { name: 'native-target' });
    expect(targetButton.parentElement).toHaveStyle({ fontSize: '12px' });
    fireEvent.click(targetButton);
    expect(props.onNavigate).toHaveBeenCalledWith('native-target');
    expect(props.cardHandlers.onClick).not.toHaveBeenCalled();
  });

  it('uses a native text part instead of a stale projected body for ordinary messages', () => {
    const target = message('native-text', { content: '旧投影正文', parts: [{ id: 'body', type: 'text', text: '原生文本正文' }] });
    const view = renderList([target]);
    const row = view.container.querySelector('[data-msgid="native-text"]')!;
    expect(row.querySelector('[data-message-part-id="body"]')).toHaveTextContent('原生文本正文');
    expect(row).not.toHaveTextContent('旧投影正文');
  });

  it('preserves legacy body and target-link fonts when native readable parts are absent', () => {
    const target = message('legacy', { kind: 'relation', relationType: 'reference', targetRefs: [{ kind: 'message', messageId: 'legacy-target' }] });
    const props = listProps([target]);
    const view = renderList([target], props);
    const row = view.container.querySelector<HTMLElement>('[data-msgid="legacy"]')!;
    expect(row).toHaveTextContent(target.content);
    const link = within(row).getByRole('button', { name: 'legacy-target' });
    expect(link).toHaveStyle({ fontSize: '12px' });
    fireEvent.click(link);
    expect(props.onNavigate).toHaveBeenCalledWith('legacy-target');
  });
});
