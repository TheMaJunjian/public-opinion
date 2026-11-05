import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { discussionBranchKey } from '../pages/workbench/model/discussionBranches';

type Kind = 'agree' | 'reply' | 'disagree';
type Counts = { total: number; agree: number; reply: number; disagree: number };
const labels = { agree: '支持', reply: '回复', disagree: '反驳' };
// Explicit native text parts contain technical fixture tokens, not discussion samples.
const body = (id: string, token: string, sequence = 0): DemoMessage => ({ id, sequence, kind: 'normal', author: 'count-fixture', createdAt: '',
  content: token, parts: [{ id: 'body', type: 'text', text: token }] });
function link(id: string, type: Kind, source: string, target: string, sequence: number) {
  const record: DemoMessage = { id: `${id}:record`, sequence, kind: 'relation', relationType: type, author: 'count-fixture', createdAt: '', content: `${type}:${target}`,
    parts: [{ id: 'relation', type: 'relation', relation: type, roles: {
      source: source.startsWith('anon:') ? [] : [{ id: 'source', reference: { messageId: source } }],
      target: [{ id: 'target', reference: { messageId: target } }],
    } }] };
  const edge: DemoEdge = { id: `${id}:edge`, relationMessageId: record.id, relationType: type, relationLabel: type,
    from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } } };
  return { record, edge };
}
function graph(messages: DemoMessage[], links: ReturnType<typeof link>[], initialCollapsed: readonly string[] = []) {
  const props: GraphViewProps = { messages: [...messages, ...links.map(value => value.record)], edges: links.map(value => value.edge), draftUnits: [], activeTextSelectId: null,
    lastClickedMessageId: null, onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(), onEdgeLabelSingleClick: vi.fn(),
    onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false };
  function Controlled() {
    const [view, setView] = useState({ mode: 'discussion' as 'discussion' | 'graph', collapsed: initialCollapsed });
    return <GraphView {...props} discussionView={view} onDiscussionViewChange={setView} />;
  }
  const ui = render(<Controlled />);
  const region = (target: string, type: Kind) => [...ui.container.querySelectorAll<HTMLElement>('[data-discussion-region]')]
    .find(element => element.dataset.discussionRegion === discussionBranchKey(target, type));
  const card = (id: string) => ui.container.querySelector(`.themed-message[data-msgid="${id}"]`);
  return { ...ui, props, region, card };
}
function expectCounts(element: HTMLElement | undefined, counts: Counts, type: Kind) {
  expect(element).toBeDefined();
  for (const [kind, count] of Object.entries(counts)) expect(element).toHaveAttribute(`data-discussion-text-${kind}`, String(count));
  const expected = type === 'agree' ? `支持 ${counts.agree} 条 · 反驳 ${counts.disagree} 条`
    : type === 'disagree' ? `反驳 ${counts.disagree} 条 · 支持 ${counts.agree} 条`
      : [`回复 ${counts.reply} 条`, ...(counts.agree ? [`支持 ${counts.agree} 条`] : []), ...(counts.disagree ? [`反驳 ${counts.disagree} 条`] : [])].join(' · ');
  // Flex gaps between spans need not create literal text-node spaces.
  const text = element!.querySelector('button')!.textContent!.replace(/[▸▾\s]/g, '');
  expect(text).toBe(expected.replace(/\s/g, ''));
}
function nestedFixture(type: 'agree' | 'disagree') {
  const opposite = type === 'agree' ? 'disagree' : 'agree';
  const parent = link('parent', type, 'parent-source', 'root', 10);
  const nested = link('nested', opposite, 'nested-source', parent.record.id, 11);
  // A physically visible, addressed relation card still has no text body.
  parent.record.parts = [];
  const vote = link('pure-vote', type, 'anon:pure-vote:record', 'root', 12);
  vote.record.parts = [];
  return { parent, nested, vote, links: [parent, nested, vote],
    messages: [body('root', 'fixture:root-not-in-region'), body('parent-source', 'fixture:A', 1), body('nested-source', 'fixture:B', 2)] };
}

describe('discussion region titles count owned text messages', () => {
  it('widens the region and its collapsed entry to fit measured statistics without clipping them',async()=>{
    const width=vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockImplementation(function(this:HTMLElement){
      return this.hasAttribute('data-discussion-header-content')?460:0;
    });
    try{
      const fixture=nestedFixture('agree'),ui=graph(fixture.messages,fixture.links);
      const button=()=>screen.getByRole('button',{name:/^(展开|收起)支持分支 root$/});
      await waitFor(()=>expect(parseFloat(ui.region('root','agree')!.style.width)).toBeGreaterThanOrEqual(503));
      expect(parseFloat(button().style.width)).toBeGreaterThanOrEqual(503);
      fireEvent.click(button());
      await waitFor(()=>expect(button()).toHaveAttribute('aria-expanded','false'));
      expect(parseFloat(button().style.width)).toBeGreaterThanOrEqual(503);
      const region=ui.region('root','agree')!,canvas=ui.container.querySelector<HTMLElement>('[data-jump-canvas]')!;
      expect(parseFloat(canvas.style.width)).toBeGreaterThanOrEqual(parseFloat(region.style.left)+parseFloat(region.style.width));
    }finally{width.mockRestore();}
  });

  it.each(['agree', 'disagree'] as const)('shows both text sides inside a %s region, excludes a pure vote and stays stable through collapse', async type => {
    const fixture = nestedFixture(type), ui = graph(fixture.messages, fixture.links);
    const counts = { total: 2, agree: 1, reply: 0, disagree: 1 };
    await waitFor(() => expectCounts(ui.region('root', type), counts, type));
    expect(ui.card(fixture.parent.record.id)).not.toBeNull();
    expect(ui.card('parent-source')).not.toBeNull(); expect(ui.card('nested-source')).not.toBeNull();
    const original = JSON.stringify([ui.props.messages, ui.props.edges]);
    fireEvent.click(screen.getByRole('button', { name: `收起${labels[type]}分支 root` }));
    await waitFor(() => expect(ui.card('parent-source')).toBeNull());
    expect(ui.card('nested-source')).toBeNull();
    expectCounts(ui.region('root', type), counts, type);
    fireEvent.click(screen.getByRole('button', { name: `展开${labels[type]}分支 root` }));
    await waitFor(() => expect(ui.card('nested-source')).not.toBeNull());
    expectCounts(ui.region('root', type), counts, type);
    expect(fixture.nested.edge.to.messageId).toBe(fixture.parent.record.id);
    expect(JSON.stringify([ui.props.messages, ui.props.edges])).toBe(original);
  });

  it('counts the complete owned text subtree on a first mount with a saved collapsed region', async () => {
    const fixture = nestedFixture('agree'), saved = [discussionBranchKey('root', 'agree')], ui = graph(fixture.messages, fixture.links, saved);
    const counts = { total: 2, agree: 1, reply: 0, disagree: 1 };
    await waitFor(() => expectCounts(ui.region('root', 'agree'), counts, 'agree'));
    expect(ui.card('parent-source')).toBeNull(); expect(ui.card('nested-source')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开支持分支 root' }));
    await waitFor(() => expect(ui.card('nested-source')).not.toBeNull());
    expectCounts(ui.region('root', 'agree'), counts, 'agree');
    expect(saved).toEqual([discussionBranchKey('root', 'agree')]);
  });

  it('does not count empty native parts, whitespace or generated relation content as body text', async () => {
    const empty: DemoMessage = { ...body('empty-parts', 'fixture:stale-content', 1), parts: [] };
    const whitespace = body('whitespace', ' \n\t ', 2);
    const emptyLink = link('empty-link', 'agree', empty.id, 'root', 10), whitespaceLink = link('whitespace-link', 'agree', whitespace.id, 'root', 11);
    const pure = link('empty-vote', 'agree', 'anon:empty-vote:record', 'root', 12); pure.record.parts = [];
    const generated = link('legacy-relation', 'agree', 'anon:legacy-relation:record', 'root', 13); generated.record.parts = undefined;
    const ui = graph([body('root', 'fixture:target-not-counted'), empty, whitespace], [emptyLink, whitespaceLink, pure, generated]);
    await waitFor(() => expect(ui.card(empty.id)).not.toBeNull());
    expect(ui.region('root', 'agree')).toBeUndefined();
    expect(ui.card(empty.id)).not.toBeNull();
    expect(screen.queryByRole('button', { name: '收起支持分支 root' })).toBeNull();
  });

  it('counts a shared text body once in its primary owner and zero times in the secondary region', async () => {
    const secondary = link('secondary', 'agree', 'shared-source', 'secondary-root', 10);
    const owner = link('owner', 'agree', 'shared-source', 'owner-root', 20);
    const duplicate = link('duplicate-address', 'agree', 'shared-source', 'owner-root', 21);
    const nested = link('nested', 'disagree', 'nested-source', 'shared-source', 30);
    const ui = graph([body('owner-root', 'fixture:owner'), body('secondary-root', 'fixture:secondary'), body('shared-source', 'fixture:shared', 1), body('nested-source', 'fixture:nested', 2)],
      [secondary, owner, duplicate, nested]);
    const owned = { total: 2, agree: 1, reply: 0, disagree: 1 };
    await waitFor(() => expectCounts(ui.region('owner-root', 'agree'), owned, 'agree'));
    expect(ui.region('secondary-root', 'agree')).toBeUndefined();
    expect(ui.container.querySelectorAll('.themed-message[data-msgid="shared-source"]')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '收起支持分支 secondary-root' })).toBeNull();
    expectCounts(ui.region('owner-root', 'agree'), owned, 'agree');
    expect(ui.card('shared-source')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起支持分支 owner-root' }));
    await waitFor(() => expect(ui.card('shared-source')).toBeNull());
    expect(ui.card('nested-source')).toBeNull();
    expectCounts(ui.region('owner-root', 'agree'), owned, 'agree');
    expect(ui.region('secondary-root', 'agree')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '展开支持分支 owner-root' }));
    await waitFor(() => expect(ui.card('nested-source')).not.toBeNull());
    expectCounts(ui.region('owner-root', 'agree'), owned, 'agree');
    expect(ui.region('secondary-root', 'agree')).toBeUndefined();
  });

  it('adds nonzero nested support and refutation counts to a reply region title', async () => {
    const reply = link('reply', 'reply', 'reply-source', 'root', 10), support = link('support', 'agree', 'support-source', 'reply-source', 11),
      opposition = link('opposition', 'disagree', 'opposition-source', 'reply-source', 12);
    const ui = graph([body('root', 'fixture:root'), body('reply-source', 'fixture:reply', 1), body('support-source', 'fixture:support', 2), body('opposition-source', 'fixture:opposition', 3)],
      [reply, support, opposition]);
    const counts = { total: 3, agree: 1, reply: 1, disagree: 1 };
    await waitFor(() => expectCounts(ui.region('root', 'reply'), counts, 'reply'));
    fireEvent.click(screen.getByRole('button', { name: '收起回复分支 root' }));
    await waitFor(() => expect(ui.card('reply-source')).toBeNull());
    expectCounts(ui.region('root', 'reply'), counts, 'reply');
  });
});
