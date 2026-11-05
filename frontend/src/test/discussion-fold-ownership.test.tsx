import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { discussionBranchKey } from '../pages/workbench/model/discussionBranches';
import { MIN_CARD_H } from '../utils/layout';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';

type Kind = 'agree' | 'reply' | 'disagree';
type Box = { x: number; y: number; width: number; height: number };
const message = (id: string, sequence: number): DemoMessage => ({ id, sequence, kind: 'normal', author: 'structure-fixture', content: `fixture:${id}`, createdAt: '' });
function connection(id: string, type: DemoEdge['relationType'], source: string, target: string, sequence: number) {
  const record: DemoMessage = { ...message(`${id}:record`, sequence), kind: 'relation', relationType: type };
  const edge: DemoEdge = { id: `${id}:edge`, relationMessageId: record.id, relationType: type, relationLabel: type,
    from: { messageId: source, selection: { kind: 'whole' } },
    // Historical relationships deliberately remain individually selectable.
    to: { messageId: target, selection: { kind: 'whole' }, reference: { messageId: target, revision: 2 } } };
  return { record, edge };
}
function renderDiscussion(ids: string[], links: ReturnType<typeof connection>[], initialCollapsed: readonly string[] = []) {
  const props: GraphViewProps = { messages: [...ids.map(message), ...links.map(link => link.record)], edges: links.map(link => link.edge),
    draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null, onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(),
    onTextMouseUp: vi.fn(), onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false };
  function Controlled() {
    const [view, setView] = useState({ mode: 'discussion' as 'discussion' | 'graph', collapsed: initialCollapsed });
    return <GraphView {...props} discussionView={view} onDiscussionViewChange={setView} />;
  }
  const ui = render(<Controlled />);
  const card = (id: string) => ui.container.querySelector<HTMLElement>(`.themed-message[data-msgid="${id}"]`);
  const label = (id: string) => ui.container.querySelector<HTMLElement>(`[data-directed-edge-label="${id}"]`);
  const region = (id: string, type: Kind) => [...ui.container.querySelectorAll<HTMLElement>('[data-discussion-region]')]
    .find(value => value.dataset.discussionRegion === discussionBranchKey(id, type));
  const box = (element: HTMLElement, cardHeight?: number): Box => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top),
    width: parseFloat(element.style.width), height: cardHeight ?? parseFloat(element.style.height) });
  return { ...ui, props, card, label, region, cardBox: (id: string) => box(card(id)!, MIN_CARD_H), regionBox: (id: string, type: Kind) => box(region(id, type)!) };
}
function expectInside(outer: Box, inner: Box) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x); expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}
function referencedNestedSupport() {
  const support = connection('support', 'agree', 'support-source', 'root', 10);
  const nested = connection('nested-disagree', 'disagree', 'nested-source', support.record.id, 11);
  const sourceReference = connection('source-reference', 'reference', 'support-source', 'external', 12);
  const nestedReference = connection('nested-reference', 'reference', 'nested-source', 'external', 13);
  const sibling = connection('sibling-reply', 'reply', 'sibling-source', 'root', 14);
  return { support, nested, sourceReference, nestedReference, sibling,
    links: [support, nested, sourceReference, nestedReference, sibling] };
}

describe('discussion folding follows the displayed region ownership', () => {
  it('applies a saved owner fold on first mount even when the hidden source also has a reference and another open reply path', async () => {
    const fixture = referencedNestedSupport();
    const secondary = connection('secondary-reply', 'reply', 'support-source', 'other-root', 15);
    const saved = [discussionBranchKey('root', 'agree')];
    const ui = renderDiscussion(['root', 'external', 'other-root', 'support-source', 'nested-source', 'sibling-source'], [...fixture.links, secondary], saved);
    await waitFor(() => expect(ui.card('root')).not.toBeNull());
    for (const id of ['support-source', fixture.support.record.id, 'nested-source']) expect(ui.card(id)).toBeNull();
    for (const link of [fixture.support, fixture.nested, fixture.sourceReference, fixture.nestedReference, secondary]) expect(ui.label(link.record.id)).toBeNull();
    expect(ui.region(fixture.support.record.id, 'disagree')).toBeUndefined();
    for (const id of ['root', 'external', 'other-root', 'sibling-source']) expect(ui.card(id)).not.toBeNull();
    const control = screen.getByRole('button', { name: '展开支持分支 root' });
    expect(control).toHaveAttribute('aria-expanded', 'false');
    expect(control).toHaveTextContent(/支持\s*1/);
    expect(ui.regionBox('root', 'agree').height).toBe(Number(ui.region('root', 'agree')!.dataset.discussionHeaderHeight));
    expect(screen.queryByRole('button', { name: '收起回复分支 other-root' })).toBeNull();
    fireEvent.click(control);
    await waitFor(() => expect(ui.card('nested-source')).not.toBeNull());
    for (const id of ['support-source', fixture.support.record.id, 'nested-source']) expectInside(ui.regionBox('root', 'agree'), ui.cardBox(id));
    expect(ui.container.querySelectorAll('.themed-message[data-msgid="support-source"]')).toHaveLength(1);
    fireEvent.click(ui.label(secondary.record.id)!);
    expect(ui.props.onEdgeLabelSingleClick).toHaveBeenLastCalledWith(expect.anything(), secondary.record.id, secondary.edge.id);
    expect(saved).toEqual([discussionBranchKey('root', 'agree')]);
  });

  it('folds referenced sources and a nested refutation of the original relation record without moving them to the root', async () => {
    const fixture = referencedNestedSupport();
    const ui = renderDiscussion(['root', 'external', 'support-source', 'nested-source', 'sibling-source'], fixture.links);
    await waitFor(() => expect(ui.card('nested-source')).not.toBeNull());
    expect(ui.card(fixture.support.record.id)).not.toBeNull();
    for (const id of ['support-source', fixture.support.record.id, 'nested-source']) expectInside(ui.regionBox('root', 'agree'), ui.cardBox(id));
    expectInside(ui.regionBox('root', 'agree'), ui.regionBox(fixture.support.record.id, 'disagree'));
    expect(fixture.nested.edge.to.messageId).toBe(fixture.support.record.id);
    for (const link of [fixture.nested, fixture.sourceReference, fixture.nestedReference]) {
      expect(ui.label(link.record.id)).not.toBeNull();
      fireEvent.click(ui.label(link.record.id)!);
      expect(ui.props.onEdgeLabelSingleClick).toHaveBeenLastCalledWith(expect.anything(), link.record.id, link.edge.id);
    }
    const original = JSON.stringify([ui.props.messages, ui.props.edges]);
    fireEvent.click(screen.getByRole('button', { name: '收起支持分支 root' }));
    await waitFor(() => {
      for (const id of ['support-source', fixture.support.record.id, 'nested-source']) expect(ui.card(id)).toBeNull();
      for (const link of [fixture.support, fixture.nested, fixture.sourceReference, fixture.nestedReference]) expect(ui.label(link.record.id)).toBeNull();
      expect(ui.region(fixture.support.record.id, 'disagree')).toBeUndefined();
    });
    for (const id of ['root', 'external', 'sibling-source']) expect(ui.card(id)).not.toBeNull();
    expect(ui.label(fixture.sibling.record.id)).not.toBeNull();
    const header = screen.getByRole('button', { name: '展开支持分支 root' });
    expect(header).toHaveTextContent(/支持\s*1/);
    expect(ui.regionBox('root', 'agree').height).toBe(Number(ui.region('root', 'agree')!.dataset.discussionHeaderHeight));
    fireEvent.click(header);
    await waitFor(() => expect(ui.card('nested-source')).not.toBeNull());
    for (const id of ['support-source', fixture.support.record.id, 'nested-source']) expectInside(ui.regionBox('root', 'agree'), ui.cardBox(id));
    fireEvent.click(ui.label(fixture.nested.record.id)!);
    expect(ui.props.onEdgeLabelSingleClick).toHaveBeenLastCalledWith(expect.anything(), fixture.nested.record.id, fixture.nested.edge.id);
    expect(fixture.nested.edge.to.messageId).toBe(fixture.support.record.id);
    expect(JSON.stringify([ui.props.messages, ui.props.edges])).toBe(original);
  });

  it('retains the nested relation-target fold when its enclosing support region closes and reopens', async () => {
    const fixture = referencedNestedSupport();
    const ui = renderDiscussion(['root', 'external', 'support-source', 'nested-source', 'sibling-source'], fixture.links);
    await waitFor(() => expect(ui.card('nested-source')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: `收起反驳分支 ${fixture.support.record.id}` }));
    await waitFor(() => expect(ui.card('nested-source')).toBeNull());
    expect(ui.card(fixture.support.record.id)).not.toBeNull();
    expect(ui.label(fixture.nested.record.id)).toBeNull();
    expect(ui.label(fixture.nestedReference.record.id)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起支持分支 root' }));
    await waitFor(() => expect(ui.card('support-source')).toBeNull());
    expect(ui.region(fixture.support.record.id, 'disagree')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '展开支持分支 root' }));
    await waitFor(() => expect(ui.card(fixture.support.record.id)).not.toBeNull());
    expect(ui.card('support-source')).not.toBeNull();
    expect(ui.card('nested-source')).toBeNull();
    const nestedHeader = screen.getByRole('button', { name: `展开反驳分支 ${fixture.support.record.id}` });
    expect(nestedHeader).toHaveAttribute('aria-expanded', 'false');
    expect(ui.label(fixture.nested.record.id)).toBeNull();
    fireEvent.click(nestedHeader);
    await waitFor(() => expect(ui.card('nested-source')).not.toBeNull());
    fireEvent.click(ui.label(fixture.nested.record.id)!);
    expect(ui.props.onEdgeLabelSingleClick).toHaveBeenLastCalledWith(expect.anything(), fixture.nested.record.id, fixture.nested.edge.id);
  });

  it('omits an empty secondary region and hides a shared source with its actual owner instead of transferring it', async () => {
    const owner = connection('shared-support', 'agree', 'shared-source', 'owner-root', 10);
    const secondary = connection('shared-reply', 'reply', 'shared-source', 'other-root', 11);
    const child = connection('shared-child', 'disagree', 'child-source', 'shared-source', 12);
    const ui = renderDiscussion(['owner-root', 'other-root', 'shared-source', 'child-source'], [owner, secondary, child]);
    await waitFor(() => expect(ui.card('child-source')).not.toBeNull());
    const original = JSON.stringify([ui.props.messages, ui.props.edges]), before = ui.cardBox('shared-source'), childBefore = ui.cardBox('child-source');
    expectInside(ui.regionBox('owner-root', 'agree'), before);
    expectInside(ui.regionBox('owner-root', 'agree'), childBefore);
    expect(screen.queryByRole('button', { name: '收起回复分支 other-root' })).toBeNull();
    expect(ui.label(secondary.record.id)).not.toBeNull();
    expect(ui.cardBox('shared-source')).toEqual(before);
    expect(ui.cardBox('child-source')).toEqual(childBefore);
    expect(ui.label(owner.record.id)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起支持分支 owner-root' }));
    await waitFor(() => { expect(ui.card('shared-source')).toBeNull(); expect(ui.card('child-source')).toBeNull(); });
    expect(ui.card('owner-root')).not.toBeNull(); expect(ui.card('other-root')).not.toBeNull();
    for (const link of [owner, secondary, child]) expect(ui.label(link.record.id)).toBeNull();
    expect(ui.region('shared-source', 'disagree')).toBeUndefined();
    expect(screen.queryByRole('button', { name: '收起回复分支 other-root' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开支持分支 owner-root' }));
    await waitFor(() => expect(ui.card('child-source')).not.toBeNull());
    expect(ui.cardBox('shared-source')).toEqual(before);
    expect(ui.cardBox('child-source')).toEqual(childBefore);
    expect(ui.container.querySelectorAll('.themed-message[data-msgid="shared-source"]')).toHaveLength(1);
    fireEvent.click(ui.label(secondary.record.id)!);
    expect(ui.props.onEdgeLabelSingleClick).toHaveBeenLastCalledWith(expect.anything(), secondary.record.id, secondary.edge.id);
    expect(JSON.stringify([ui.props.messages, ui.props.edges])).toBe(original);
  });

  it('reveals a hidden descendant through its real owner path while leaving the earlier secondary path and unrelated region folded', async () => {
    const secondary = connection('secondary', 'reply', 'shared-source', 'other-root', 10);
    const owner = connection('owner', 'agree', 'shared-source', 'owner-root', 11);
    const child = connection('nested', 'disagree', 'child-source', 'shared-source', 12);
    const reference = connection('reference', 'reference', 'shared-source', 'external', 13);
    const unrelated = connection('unrelated', 'reply', 'unrelated-child', 'unrelated-root', 14);
    // The alternative path comes first in the original edge list. Navigation
    // must follow visual ownership, rather than the first semantic route found.
    const links = [secondary, owner, child, reference, unrelated];
    const saved = [discussionBranchKey('owner-root', 'agree'), discussionBranchKey('other-root', 'reply'),
      discussionBranchKey('shared-source', 'disagree'), discussionBranchKey('unrelated-root', 'reply')];
    const ui = renderDiscussion(['other-root', 'owner-root', 'external', 'shared-source', 'child-source', 'unrelated-root', 'unrelated-child'], links, saved);
    await waitFor(() => expect(ui.card('owner-root')).not.toBeNull());
    expect(ui.card('shared-source')).toBeNull(); expect(ui.card('child-source')).toBeNull(); expect(ui.card('unrelated-child')).toBeNull();
    const original = JSON.stringify([ui.props.messages, ui.props.edges]);
    const detail = { ids: ['child-source'], positioningPending: false };
    await act(async () => { ui.container.querySelector('[data-jump-canvas]')!.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail })); });
    await waitFor(() => expect(ui.card('child-source')).not.toBeNull());
    expect(detail.positioningPending).toBe(true);
    expect(ui.card('shared-source')).not.toBeNull();
    expectInside(ui.regionBox('owner-root', 'agree'), ui.cardBox('shared-source'));
    expectInside(ui.regionBox('owner-root', 'agree'), ui.cardBox('child-source'));
    expect(screen.getByRole('button', { name: '收起支持分支 owner-root' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '收起反驳分支 shared-source' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: '展开回复分支 other-root' })).toBeNull();
    expect(screen.getByRole('button', { name: '展开回复分支 unrelated-root' })).toHaveAttribute('aria-expanded', 'false');
    expect(ui.card('unrelated-child')).toBeNull();
    expect(ui.label(secondary.record.id)).not.toBeNull();
    expect(ui.label(owner.record.id)).not.toBeNull(); expect(ui.label(reference.record.id)).not.toBeNull();
    fireEvent.click(ui.label(child.record.id)!);
    expect(ui.props.onEdgeLabelSingleClick).toHaveBeenLastCalledWith(expect.anything(), child.record.id, child.edge.id);
    expect(JSON.stringify([ui.props.messages, ui.props.edges])).toBe(original);
    expect(saved).toHaveLength(4);
  });
});
