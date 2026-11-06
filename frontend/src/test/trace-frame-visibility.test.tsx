import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import { applyTraceFrameVisibility, buildTraceProjection } from '../utils/traceProjection';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const frameTypes = ['classify', 'summary', 'merge', 'arrange'] as const;
const message = (id: string, relationType?: DemoEdge['relationType']): DemoMessage => ({
  id, kind: relationType ? 'relation' : 'normal', relationType, content: id, author: 'fixture', createdAt: '',
});
const edge = (owner: string, type: DemoEdge['relationType'], target: string, source = `anon:${owner}`): DemoEdge => ({
  id: `${owner}:${target}`, relationMessageId: owner, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
function renderTrace(messages: DemoMessage[], edges: DemoEdge[], distance = 0) {
  const trace = buildTraceProjection({ messages, edges, startIds: ['member'], distance });
  const frames = new Set(trace.expandableContainerIds);
  const projection = applyTraceFrameVisibility(trace, frames);
  const props: GraphViewProps = {
    messages: projection.messages, edges: projection.edges, traceFrameIds: frames, traceExpandedFrameIds: frames,
    discussionView: { mode: 'discussion', collapsed: [] }, draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null,
    onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
    onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false,
  };
  return render(<GraphView {...props} />);
}

it.each(frameTypes.flatMap(outer => frameTypes.map(inner => ({ outer, inner }))))(
  'keeps partial $outer/$inner frames visible in nesting order before either is selected', ({ outer, inner }) => {
    const messages = [message('inner', inner), message('outer', outer), message('member'), message('inner-hidden'), message('outer-hidden')];
    // Membership records may arrive with the child first. Only one leaf is in range.
    const edges = [edge('inner', inner, 'member'), edge('inner', inner, 'inner-hidden'),
      edge('outer', outer, 'inner'), edge('outer', outer, 'outer-hidden')];
    const view = renderTrace(messages, edges);
    const frames = [...view.container.querySelectorAll('[data-frame-visual]')];
    expect(frames.map(frame => frame.getAttribute('data-frame-visual'))).toEqual(['outer', 'inner']);
    expect(frames.map(frame => frame.getAttribute('data-frame-depth'))).toEqual(['0', '1']);
    for (const frame of frames) {
      expect(frame).not.toHaveAttribute('data-whole-selected');
      expect(Number(frame.querySelector('rect')!.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(frame.querySelector('rect')!.getAttribute('height'))).toBeGreaterThan(0);
    }
    expect(view.container.querySelector('.themed-message[data-msgid="member"]')).not.toBeNull();
    expect(view.container.querySelector('[data-msgid="inner-hidden"], [data-msgid="outer-hidden"]')).toBeNull();
  },
);

it('paints a partial discussion summary border above its enclosing organization fill', () => {
  const messages = [message('outer', 'classify'), message('member'), message('reply-body'), message('hidden'), message('reply', 'reply')];
  const edges = [edge('outer', 'classify', 'member'), edge('outer', 'classify', 'reply-body'), edge('outer', 'classify', 'hidden'),
    edge('reply', 'reply', 'member', 'reply-body')];
  const view = renderTrace(messages, edges, 1);
  const frame = view.container.querySelector('[data-frame-visual="outer"]')!;
  const region = view.container.querySelector<HTMLElement>('[data-discussion-region-type="reply"]')!;
  expect(region).not.toBeNull();
  // A later opaque SVG fill must not cover the region's side borders.
  expect(frame.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(region.style.borderStyle).toBe('solid');
  expect(region.style.pointerEvents).toBe('none');
  expect(view.getByRole('button', { name: '收起回复分支 member' })).toBeInTheDocument();
  expect(view.container.querySelector('.themed-message[data-msgid="reply-body"]')).not.toBeNull();
  expect(view.container.querySelector('[data-msgid="hidden"]')).toBeNull();
});
