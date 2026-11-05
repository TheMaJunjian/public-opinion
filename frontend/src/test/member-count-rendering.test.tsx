import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import WorkbenchMessageList from '../pages/workbench/ui/WorkbenchMessageList';
import { deriveContainerEffect, type ContainerEffect } from '../pages/workbench/model/containerEffect';
import { convertMessagesToDemoModel, type DemoMessage } from '../utils/modelBridge';
import type { Relation } from '../types';

const user = { id: 'author', username: '作者', createdAt: '' };
const message = (id: string): DemoMessage => ({
  id, revision: 1, kind: 'normal', author: user.username, authorId: user.id,
  createdAt: '2026-11-01T00:00:00Z', content: `正文 ${id}`,
});
const relation = (id: string, type: string, targets: string[], sourceMessageId: string | null = null): Relation => ({
  id, relationType: type, sourceMessageId, createdBy: user, createdAt: '2026-11-01T00:00:00Z',
  targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
  payload: { title: id },
});

function nestedEffect(moveMember = false): ContainerEffect {
  const relations = [relation('A', 'CLASSIFY', ['a1', 'a2', 'B']), relation('B', 'CLASSIFY', ['b1', 'b2', 'b3']),
    relation('elsewhere', 'CLASSIFY', [])];
  if (moveMember) relations.push({ ...relation('move-b3', 'JOIN', ['b3'], 'elsewhere'), createdAt: '2026-11-02T00:00:00Z' });
  const converted = convertMessagesToDemoModel([], relations);
  return deriveContainerEffect({
    messages: [...converted.messages, ...['a1', 'a2', 'b1', 'b2', 'b3', 'unrelated'].map(message)],
    edges: converted.edges, relations, username: user.username,
  });
}

function listProps(effect: ContainerEffect, ids = ['A']): ComponentProps<typeof WorkbenchMessageList> {
  return {
    visibleMessages: ids.map(id => effect.msgMap.get(id)!), showJoinRecords: true,
    catalog: { messages: effect.messages, edges: effect.edges, msgMap: effect.msgMap, relationById: effect.relationById,
      relationTypeByRelMsgId: new Map(effect.messages.flatMap(item => item.relationType ? [[item.id, item.relationType] as const] : [])),
      joinRelationsByTarget: new Map(), joinRelationsBySource: new Map(), effectiveJoinRelationIds: effect.effectiveJoinIds,
      containerOwnership: effect.ownership, summaryCoverageByMessageId: new Map(), correctionVersions: new Map() },
    display: { embeddedMessageIds: new Set(), suppressedRelIds: effect.suppressed, rejectedContainerIds: effect.rejectedContainerIds,
      overriddenStanceRelIds: new Set(), readStatusByMessageId: new Map(), homeDisplayRoleByMessageId: new Map(),
      authorStakes: {}, stakeCounts: {}, correctionFilterTargetId: null, joinFilterTargetId: null },
    comparison: { comparisonReviewed: false, comparisonTargetId: null, comparisonRecommendedDisplay: 'agree',
      activeStanceByRelMsgId: new Map(), activeStanceMap: new Map() },
    settlement: { settlementOpenMsgId: null, settlementOpenType: null, settlementEntryHighlight: null,
      closeSettlement: vi.fn(), openSettlement: vi.fn() },
    selection: { draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null },
    cardHandlers: { onClick: vi.fn(), onDoubleClick: vi.fn(), onContentMouseUp: vi.fn() },
    scopeMessageId: 'root', onJoinFilter: vi.fn(), onNavigate: vi.fn(), onCorrectionNavigate: vi.fn(),
    renderRelation: item => item.content, renderContent: item => item.content,
  };
}

function graphProps(effect: ContainerEffect, expanded = false): GraphViewProps {
  // Intentionally project away B and most descendants. Statistics must come from
  // the complete effect, never the displayed edge set or loaded visual batch.
  return {
    messages: ['A', 'a1'].map(id => effect.msgMap.get(id)!),
    edges: effect.edges.filter(edge => edge.relationMessageId === 'A' && edge.to.messageId === 'a1'),
    getMemberCounts: effect.context.getMemberCounts,
    traceFrameIds: expanded ? new Set(['A']) : undefined,
    traceExpandedFrameIds: expanded ? new Set(['A']) : undefined,
    draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null,
    onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
    onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false,
  };
}

type Surface = 'list' | 'graph-card' | 'expanded-frame';
const surfaces: Surface[] = ['list', 'graph-card', 'expanded-frame'];
function surfaceElement(surface: Surface, effect: ContainerEffect) {
  return surface === 'list'
    ? <MemoryRouter><WorkbenchMessageList {...listProps(effect)} /></MemoryRouter>
    : <GraphView {...graphProps(effect, surface === 'expanded-frame')} />;
}

function expectCount(container: HTMLElement, total: number, direct = 3) {
  const badge = container.querySelector('[data-msgid="A"] [data-message-member-count]');
  expect(badge).not.toBeNull();
  expect(badge).toHaveTextContent(`${total} 条消息`);
  expect(badge).toHaveAttribute('title', `直接成员 ${direct} 条，含内部容器共 ${total} 条消息，已按消息编号去重`);
  expect(badge).not.toHaveAttribute('data-message-reference');
  expect(badge).not.toHaveAttribute('role');
  return badge;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('shared member counts across workbench presentations', () => {
  it.each(surfaces)('shows the complete recursive total in %s with only part of the catalog visible', surface => {
    const effect = nestedEffect();
    expect(effect.ownership.memberCounts('A')).toEqual({ direct: 3, total: 6 });
    const view = render(surfaceElement(surface, effect));
    expectCount(view.container, 6);
    expect(view.container.querySelector('.themed-message[data-msgid="B"]')).toBeNull();
  });

  it.each(surfaces)('updates %s immediately when a synchronized JOIN moves a nested member away', surface => {
    const before = nestedEffect(), after = nestedEffect(true);
    const view = render(surfaceElement(surface, before));
    expectCount(view.container, 6);
    expect(after.ownership.memberCounts('A')).toEqual({ direct: 3, total: 5 });
    view.rerender(surfaceElement(surface, after));
    expectCount(view.container, 5);
    // The old snapshot remains unchanged; the new view never reuses its count.
    expect(before.ownership.memberCounts('A')).toEqual({ direct: 3, total: 6 });
  });

  it('does not calculate hidden list containers and reuses the full count when another page appears', () => {
    const effect = nestedEffect(), getCounts = vi.spyOn(effect.ownership, 'memberCounts');
    const view = render(<MemoryRouter><WorkbenchMessageList {...listProps(effect, ['unrelated'])} /></MemoryRouter>);
    expect(getCounts).not.toHaveBeenCalled();
    view.rerender(<MemoryRouter><WorkbenchMessageList {...listProps(effect, ['A'])} /></MemoryRouter>);
    expectCount(view.container, 6);
    expect(getCounts.mock.calls.every(([id]) => id === 'A')).toBe(true);
    view.rerender(<MemoryRouter><WorkbenchMessageList {...listProps(effect, ['A', 'a1', 'a2'])} /></MemoryRouter>);
    expectCount(view.container, 6);
    expect(getCounts.mock.calls.every(([id]) => id === 'A')).toBe(true);
  });

  it('does not request counts for graph containers outside the visible batch', () => {
    const effect = nestedEffect(), getCounts = vi.fn(effect.ownership.memberCounts);
    const props = { ...graphProps(effect), messages: ['A', 'unrelated'].map(id => effect.msgMap.get(id)!), edges: [], getMemberCounts: getCounts };
    const view = render(<GraphView {...props} visibleMessageIds={new Set(['unrelated'])} />);
    expect(view.container.querySelector('.themed-message[data-msgid="unrelated"]')).not.toBeNull();
    expect(getCounts).not.toHaveBeenCalled();
    view.rerender(<GraphView {...props} visibleMessageIds={new Set(['A', 'unrelated'])} />);
    expectCount(view.container, 6);
    expect(getCounts.mock.calls.every(([id]) => id === 'A')).toBe(true);
  });

  it('keeps comparison sides bound to their own ownership snapshots', () => {
    const before = nestedEffect(), after = nestedEffect(true);
    const actualGetter = vi.fn(before.ownership.memberCounts);
    const agreeGetter = vi.fn(before.context.getMemberCounts), disagreeGetter = vi.fn(after.context.getMemberCounts);
    const common = { ...graphProps(before), messages: [before.msgMap.get('A')!], edges: [] };
    const view = render(<GraphView {...common} getMemberCounts={actualGetter} comparisonPair
      comparisonAgreeMessages={common.messages} comparisonAgreeEdges={[]}
      comparisonAgreeContext={{ getMemberCounts: agreeGetter }}
      comparisonDisagreeMessages={[after.msgMap.get('A')!]} comparisonDisagreeEdges={[]}
      comparisonDisagreeContext={{ getMemberCounts: disagreeGetter }} />);
    const agree = view.container.querySelector<HTMLElement>('[data-comparison-viewport="agree"]')!;
    const disagree = view.container.querySelector<HTMLElement>('[data-comparison-viewport="disagree"]')!;
    expectCount(agree, 6); expectCount(disagree, 5);
    expect(agreeGetter).toHaveBeenCalledWith('A'); expect(disagreeGetter).toHaveBeenCalledWith('A');
    expect(actualGetter).not.toHaveBeenCalled();
  });
});
