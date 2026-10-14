import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import { projectGraphScene } from '../utils/graphProjection';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { GRID_TOP } from '../utils/layout';

const message = (id: string): DemoMessage => ({ id, author: 'tester', content: id, kind: 'normal', createdAt: '2026-01-01T00:00:00Z' });
const relation = (id: string, type: DemoEdge['relationType'], source: string, target: string): DemoEdge => ({
  id, relationMessageId: id, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
function renderScene(messages: DemoMessage[], edges: DemoEdge[]) {
  const props: GraphViewProps = {
    messages, edges, draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null, voteStats: {},
    onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
    onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(),
    isFragmentSelected: () => false,
  };
  return render(<GraphView {...props} />);
}

describe('rendered graph scene', () => {
  it('starts a summary at the first visible row and renders no covered-card whitespace', () => {
    const summary: DemoMessage = { ...message('summary'), kind: 'relation', relationType: 'summary', content: '讨论总结' };
    const messages = [message('old-a'), message('old-b'), summary];
    const edges = [relation('summary', 'summary', 'anon:summary', 'old-a'), relation('summary', 'summary', 'anon:summary', 'old-b')];
    const { container } = renderScene(messages, edges);
    expect(container.querySelector('[data-msgid="old-a"]')).toBeNull();
    expect(container.querySelector('[data-msgid="old-b"]')).toBeNull();
    expect((container.querySelector('[data-msgid="summary"]') as HTMLElement).style.top).toBe(`${GRID_TOP}px`);
  });

  it('keeps opposition on the right, agreement on the left, and routes the rendered relation arrows', () => {
    const messages = [message('claim'), message('support'), message('objection')];
    const edges = [relation('agree', 'agree', 'support', 'claim'), relation('disagree', 'disagree', 'objection', 'claim')];
    const { container } = renderScene(messages, edges);
    const left = (id: string) => parseFloat((container.querySelector(`[data-msgid="${id}"]`) as HTMLElement).style.left);
    expect(left('support')).toBeLessThan(left('claim'));
    expect(left('objection')).toBeGreaterThan(left('claim'));
    expect(container.querySelectorAll('svg path').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps trace members addressable while an ordinary summary hides them', () => {
    const messages: DemoMessage[] = [message('claim'), { ...message('summary'), kind: 'relation', relationType: 'summary' }];
    const edges = [relation('summary', 'summary', 'anon:summary', 'claim')];
    const collapsed = projectGraphScene({ messages, edges, isTraceWindow: false, traceExpandedFrameIds: new Set() });
    const expanded = projectGraphScene({ messages, edges, isTraceWindow: true, traceExpandedFrameIds: new Set(['summary']) });
    expect(collapsed.normalIds).toEqual(['summary']);
    expect(expanded.normalIds).toEqual(['claim']);
    expect(expanded.frameBlocks[0].directCardIds.has('claim')).toBe(true);
  });

  it('keeps a reason-bearing objection on the right when newer objections precede older support in the snapshot', () => {
    const objection: DemoMessage = {
      ...message('objection'), kind: 'relation', relationType: 'disagree',
      parts: [{ id: 'body', type: 'text', text: '先核实运营成本。' }],
      executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: 'claim' }, side: 'con' },
    };
    const messages = [message('claim'), message('support'), objection];
    const edges = [relation('objection', 'disagree', 'anon:objection', 'claim'), relation('agree', 'agree', 'support', 'claim')];
    const projection = projectGraphScene({ messages, edges, isTraceWindow: false, traceExpandedFrameIds: new Set() });
    expect(projection.pipelineCol.objection).toBeGreaterThan(projection.pipelineCol.claim);
    expect(projection.pipelineCol.support).toBeLessThan(projection.pipelineCol.claim);
  });
});
