import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import { withCorrectionContent, type DemoEdge, type DemoMessage } from '../utils/modelBridge';
import { planMessageStructures } from '../utils/messageStructurePlan';

// Technical rendering fixtures only; these bodies are not discussion samples.
const message = (id: string, sequence = 0): DemoMessage => ({ id, sequence, author: 'structure-fixture', content: '', kind: 'normal',
  createdAt: new Date(sequence * 1000).toISOString() });
const relation = (id: string, type: DemoEdge['relationType'], source: string, target: string): DemoEdge => ({
  id, relationMessageId: id, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
const propsFor = (messages: DemoMessage[], edges: DemoEdge[], extra: Partial<GraphViewProps> = {}): GraphViewProps => ({
  messages, edges, discussionView: { mode: 'discussion', collapsed: [] }, draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null,
  onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(), onEdgeLabelSingleClick: vi.fn(),
  onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false, ...extra,
});
const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`.themed-message[data-msgid="${id}"]`)!;

describe('existing graph behavior with the discussion layout enabled', () => {
  it('expands a traced classification and restores its bounded viewport, scroll and member addresses across remounts', () => {
    const members = Array.from({ length: 8 }, (_, index) => message(`member-${index}`, index + 1));
    const group: DemoMessage = { ...message('group'), kind: 'relation', relationType: 'classify' };
    const edges = members.map(member => ({ ...relation('group', 'classify', 'anon:group', member.id), id: `group-${member.id}` }));
    const state = { current: {} } as NonNullable<GraphViewProps['frameViewStateRef']>;
    const props = propsFor([group, ...members, message('outside', 20)], edges, {
      traceFrameIds: new Set(['group']), traceExpandedFrameIds: new Set(['group']), frameViewStateRef: state, expandAllFrames: true,
    });
    let view = render(<GraphView {...props} />);
    expect(view.container.querySelector('[data-discussion-layout="true"]')).not.toBeNull();
    for (const member of members) expect(card(view.container, member.id)).not.toBeNull();
    expect(view.queryByLabelText('框架垂直滚动条 group')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: '还原尺寸 group' }));
    fireEvent.change(view.getByRole('spinbutton', { name: '框架宽度 group' }), { target: { value: '480' } });
    fireEvent.change(view.getByRole('spinbutton', { name: '框架高度 group' }), { target: { value: '180' } });
    fireEvent.scroll(view.getByLabelText('框架垂直滚动条 group'), { target: { scrollTop: 100 } });
    const before = { top: card(view.container, 'member-0').style.top, width: view.getByRole('group', { name: '组织消息 group' }).style.width };
    fireEvent.click(view.getByRole('button', { name: '完全展开 group' }));
    expect(view.queryByLabelText('框架垂直滚动条 group')).toBeNull();
    expect(card(view.container, 'member-0').closest('[data-frame-clip]')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: '还原尺寸 group' }));
    expect(view.getByRole('spinbutton', { name: '框架宽度 group' })).toHaveValue(480);
    expect(view.getByRole('spinbutton', { name: '框架高度 group' })).toHaveValue(180);
    expect(view.getByRole('group', { name: '组织消息 group' }).style.width).toBe(before.width);
    expect(view.getByLabelText('框架垂直滚动条 group').scrollTop).toBe(100);
    expect(card(view.container, 'member-0').style.top).toBe(before.top);
    const saved = structuredClone(state.current);
    view.unmount();
    view = render(<GraphView {...props} />);
    expect(state.current).toEqual(saved);
    expect(view.getByLabelText('框架垂直滚动条 group').scrollTop).toBe(100);
    expect(card(view.container, 'member-0').style.top).toBe(before.top);
    fireEvent.click(card(view.container, 'member-0'));
    expect(props.onMessageClick).toHaveBeenCalledWith(expect.anything(), 'member-0');
    expect(edges[0].to.messageId).toBe('member-0');
    view.unmount();
  });

  it('shows a body correction on the original selectable message and keeps its original evidence unchanged', () => {
    const original: DemoMessage = { ...message('source'), content: 'before', parts: [{ id: 'body', type: 'text', text: 'before' }] };
    const correction: DemoMessage = { ...message('correction', 1), kind: 'relation', relationType: 'correct', content: 'after',
      relationPayload: { correctionBeforeContent: 'before', correctionAfterContent: 'after', correctionContent: 'after' },
      parts: [{ id: 'corrected-body', type: 'text', text: 'after' },
        { id: 'relation', type: 'relation', relation: 'correct', roles: { target: [{ id: 'target', reference: { messageId: original.id } }] } }] };
    const edge = relation('correction', 'correct', 'anon:correction', original.id);
    const snapshot = structuredClone({ original, correction, edge });
    const props = propsFor([withCorrectionContent(original, 'after'), correction], [edge]);
    const view = render(<GraphView {...props} />);
    expect(card(view.container, 'source')).toHaveTextContent('after');
    expect(card(view.container, 'source')).not.toHaveTextContent('before');
    expect(card(view.container, 'source').querySelector('[data-jump-msgids~="correction"]')).not.toBeNull();
    expect(card(view.container, 'correction')).toBeNull();
    fireEvent.click(card(view.container, 'source'));
    expect(props.onMessageClick).toHaveBeenCalledWith(expect.anything(), original.id);
    expect({ original, correction, edge }).toEqual(snapshot);
  });

  it('applies and suppresses a width correction without replacing its target ID or body', () => {
    const source = { ...message('source'), content: 'body', parts: [{ id: 'body', type: 'text' as const, text: 'body' }] };
    const width: DemoMessage = { ...message('width', 1), kind: 'relation', relationType: 'correct',
      relationPayload: { correctionKind: 'WIDTH', correctionWidth: 640 },
      parts: [{ id: 'data', type: 'data', value: { correctionKind: 'WIDTH', correctionWidth: 640 } }] };
    const edge = relation('width', 'correct', 'anon:width', source.id);
    const snapshot = structuredClone({ source, width, edge });
    const props = propsFor([source, width], [edge]);
    const view = render(<GraphView {...props} />);
    expect(card(view.container, source.id)).toHaveStyle({ width: '640px' });
    expect(card(view.container, source.id)).toHaveTextContent('body');
    expect(card(view.container, width.id)).toBeNull();
    view.rerender(<GraphView {...props} messages={[source, { ...width, state: { messageId: width.id, revision: 1,
      supportCount: 0, oppositionCount: 1, suppressed: true, recommendationTotal: 0 } }]} />);
    expect(card(view.container, source.id)).toHaveStyle({ width: '320px' });
    fireEvent.click(card(view.container, source.id));
    expect(props.onMessageClick).toHaveBeenCalledWith(expect.anything(), source.id);
    expect({ source, width, edge }).toEqual(snapshot);
  });

  it('keeps mounted cards and native reference addresses stable when later complete trees are revealed', () => {
    const bodies: DemoMessage[] = [], records: DemoMessage[] = [], edges: DemoEdge[] = [];
    for (let tree = 0; tree < 6; tree++) {
      const nodes = ['root', 'child', 'leaf'].map((name, index) => message(`${tree}-${name}`, tree * 3 + index));
      bodies.push(...nodes);
      for (let index = 1; index < nodes.length; index++) {
        const id = `ref-${tree}-${index}`;
        records.push({ ...message(id, tree * 3 + index), kind: 'relation', relationType: 'reference' });
        edges.push(relation(id, 'reference', nodes[index].id, nodes[index - 1].id));
      }
    }
    const messages = [...bodies, ...records], plan = planMessageStructures({ messages, edges });
    const visible = (limit: number) => {
      const units = new Set(plan.units.slice(0, limit));
      return new Set(plan.order.filter(id => units.has(plan.byId.get(id)!)));
    };
    const firstIds = bodies.filter(value => visible(2).has(value.id)).map(value => value.id);
    const sourceEdges = structuredClone(edges);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const index = Number(this.dataset.msgid?.split('-')[0]);
      return Number.isFinite(index) ? 100 + (index % 4) * 70 : 36;
    });
    const props = propsFor(messages, edges, { structureOrder: plan.placementOrder, visibleMessageIds: visible(2) });
    const view = render(<GraphView {...props} />);
    try {
      expect(firstIds).toHaveLength(6);
      const positions = () => firstIds.map(id => ({ id, left: card(view.container, id).style.left, top: card(view.container, id).style.top }));
      const before = positions();
      const renderedBodyCount = () => bodies.filter(value => card(view.container, value.id)).length;
      expect(renderedBodyCount()).toBe(6);
      for (const limit of [4, 6]) {
        view.rerender(<GraphView {...props} visibleMessageIds={visible(limit)} />);
        expect(renderedBodyCount()).toBe(limit * 3);
        expect(positions()).toEqual(before);
      }
      fireEvent.click(view.container.querySelector('[data-directed-edge-label="ref-0-1"]')!);
      expect(props.onEdgeLabelSingleClick).toHaveBeenCalledWith(expect.anything(), 'ref-0-1', 'ref-0-1');
      expect(edges).toEqual(sourceEdges);
    } finally {
      view.unmount();
      height.mockRestore();
    }
  });
});
