import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
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
