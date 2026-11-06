import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

// Empty records test native drawing/interaction addresses, not discussion content.
const message = (id: string, extra: Partial<DemoMessage> = {}): DemoMessage => ({ id, kind: 'normal', author: '', content: '', createdAt: '', ...extra });
const relation = (): DemoEdge => ({ id: 'native-edge', relationMessageId: 'native-record', relationType: 'reference', relationLabel: 'reference',
  from: { messageId: 'source', selection: { kind: 'whole' } }, to: { messageId: 'target', selection: { kind: 'whole' } } });
const base = (): GraphViewProps => ({ messages: [message('source'), message('target'), message('unrelated'),
  message('native-record', { kind: 'relation', relationType: 'reference' })], edges: [relation()],
  draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null,
  onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
  onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false });

beforeEach(() => {
  const original = SVGElement.prototype.getBoundingClientRect;
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: SVGElement) {
    return this.tagName.toLowerCase() === 'text'
      ? new DOMRect(Number(this.getAttribute('x')) - 12, Number(this.getAttribute('y')) - 7, 24, 14)
      : original.call(this);
  });
});
afterEach(() => vi.restoreAllMocks());

function layers(container: HTMLElement) {
  return { paths: container.querySelector<SVGSVGElement>('[data-graph-edge-layer="paths"]')!,
    labels: container.querySelector<SVGSVGElement>('[data-graph-edge-layer="labels"]')! };
}

it('draws lines, arrowheads and labels above ordinary cards', async () => {
  const props = base(), view = render(<GraphView {...props} />);
  await waitFor(() => expect(layers(view.container).paths).not.toBeNull());
  const { paths, labels } = layers(view.container);
  expect(paths.style.zIndex).toBe('11'); expect(labels.style.zIndex).toBe('12');
  // Labels moved beside a tall card remain visible beyond the canvas's base padding.
  expect(labels.style.overflow).toBe('visible');
  expect(paths.style.pointerEvents).toBe('none'); expect(labels.style.pointerEvents).toBe('none');
  for (const card of view.container.querySelectorAll<HTMLElement>('.themed-message')) {
    expect(Number(card.style.zIndex)).toBeLessThan(Number(paths.style.zIndex));
    expect(Number(card.style.zIndex)).toBeLessThan(Number(labels.style.zIndex));
  }
  expect(paths.querySelectorAll('.relation-edge-path')).toHaveLength(1);
  expect(paths.querySelectorAll('.relation-edge-arrow')).toHaveLength(1);
  expect(paths.querySelector('.skin-edge-art')).toHaveAttribute('pointer-events', 'none');
  expect(paths.querySelector('.skin-edge-art')).toHaveAttribute('aria-hidden', 'true');
  // Decorative skin textPath glyphs are allowed, but the measured relation text is not duplicated.
  expect(paths.querySelector('.graph-edge-label-text')).toBeNull();
  expect(paths.querySelector('.graph-edge-label-plate')).toBeNull();
  expect(labels.querySelector('.relation-edge-path')).toBeNull();
  expect(labels.querySelector('.relation-edge-arrow')).toBeNull();
  expect(labels.querySelector('.skin-edge-art')).toBeNull();
  expect(labels.querySelectorAll('.graph-edge-label-text')).toHaveLength(1);
  expect(view.container.querySelectorAll('.graph-edge-label-text')).toHaveLength(1);
  expect(labels.querySelector('.graph-edge-label-plate')).not.toBeNull();
  expect(labels.querySelector('.skin-edge-label-art')).toHaveAttribute('pointer-events', 'none');
  expect(paths.querySelector('.relation-edge-label-anchor')).toBeNull();
  expect(paths.querySelector('.relation-edge-label-link')).toBeNull();
  const plate=labels.querySelector<SVGRectElement>('.graph-edge-label-plate')!;
  expect(plate.style.display).toBe('block');
  expect(plate.style.stroke).toBe(paths.querySelector('.relation-edge-path')!.getAttribute('stroke'));
});

it('raises selected and text-edited cards above paths, arrowheads, labels and label hit areas', async () => {
  const props = base();
  const view = render(<GraphView {...props} draftUnits={[{ messageId: 'source', selection: { kind: 'whole' } }]} activeTextSelectId="target" />);
  await waitFor(() => expect(layers(view.container).paths).not.toBeNull());
  for (const id of ['source', 'target']) {
    const card = view.container.querySelector<HTMLElement>(`.themed-message[data-msgid="${id}"]`)!;
    expect(Number(card.style.zIndex)).toBeGreaterThan(13);
  }
  view.rerender(<GraphView {...props} />);
  expect(Number(view.container.querySelector<HTMLElement>('.themed-message[data-msgid="source"]')!.style.zIndex)).toBeLessThan(11);
});

it.each(['whole', 'fragment'] as const)('colors the entire selected %s relation and restores its native paint without rerouting', async kind => {
  const props = base();
  props.edges.push({ ...relation(), id: 'other-edge', to: { messageId: 'unrelated', selection: { kind: 'whole' } } });
  const view = render(<GraphView {...props} />);
  await waitFor(() => expect(layers(view.container).labels?.querySelector('.graph-edge-label-plate')).not.toBeNull());
  const group = (layer: 'paths' | 'labels', id = 'native-edge') => layers(view.container)[layer].querySelector<SVGGElement>(`g[data-frame-edge-id="${id}"]`)!;
  const path = () => group('paths').querySelector<SVGPathElement>('.relation-edge-path')!;
  const originalPath = path().getAttribute('d'), originalColor = path().getAttribute('stroke');
  const paint = kind === 'whole' ? 'var(--edge-selection-accent, var(--selection-accent))' : 'var(--edge-fragment-accent, var(--fragment-accent))';
  view.rerender(<GraphView {...props} draftUnits={[{ messageId: 'native-record', selection: kind === 'whole' ? { kind: 'whole' } : { kind: 'edge', edgeId: 'native-edge' } }]} />);
  expect(path()).toHaveAttribute('d', originalPath);
  for (const [selector, property] of [['.relation-edge-path', 'stroke'], ['.relation-edge-arrow', 'fill'],
    ['.skin-edge-core', 'stroke'], ['.skin-edge-tip', 'fill']] as const) {
    expect(group('paths').querySelector<SVGElement>(selector)!.style[property]).toBe(paint);
  }
  expect(group('labels').querySelector<SVGTextElement>('.graph-edge-label-text')!.style.fill).toBe(paint);
  expect(group('labels').querySelector<SVGRectElement>('.graph-edge-label-plate')!.style.stroke).toBe(paint);
  // A whole relation selects all of its edges; a single-edge fragment selects only that edge.
  expect(group('paths', 'other-edge').querySelector('.relation-edge-path')).toHaveAttribute('stroke', kind === 'whole' ? paint : originalColor);
  view.rerender(<GraphView {...props} />);
  expect(path()).toHaveAttribute('stroke', originalColor);
  expect(path().style.stroke).toBe('');
  expect(path()).toHaveAttribute('d', originalPath);
  expect(group('paths').querySelector<SVGPathElement>('.skin-edge-core')!.style.stroke).toBe('');
  expect(group('labels').querySelector<SVGTextElement>('.graph-edge-label-text')!.style.fill).toBe('');
});

it('keeps annotation purple across native and decorative paint and restores it after selection', async () => {
  const props=base();
  props.edges[0]={...relation(),relationType:'annotation',relationLabel:'annotation'};
  props.messages[3]={...props.messages[3],relationType:'annotation'};
  const view=render(<GraphView {...props}/>);
  await waitFor(()=>expect(layers(view.container).labels?.querySelector('.graph-edge-label-plate')).not.toBeNull());
  const paint=()=>[
    layers(view.container).paths.querySelector<SVGPathElement>('.relation-edge-path')!.style.stroke,
    layers(view.container).paths.querySelector<SVGPathElement>('.relation-edge-arrow')!.style.fill,
    layers(view.container).paths.querySelector<SVGPathElement>('.skin-edge-core')!.style.stroke,
    layers(view.container).paths.querySelector<SVGPathElement>('.skin-edge-tip')!.style.fill,
    layers(view.container).labels.querySelector<SVGTextElement>('.graph-edge-label-text')!.style.fill,
  ];
  expect(paint()).toEqual(Array(5).fill('var(--graph-label-annotation)'));
  view.rerender(<GraphView {...props} draftUnits={[{messageId:'native-record',selection:{kind:'whole'}}]}/>);
  expect(paint()).toEqual(Array(5).fill('var(--edge-selection-accent, var(--selection-accent))'));
  view.rerender(<GraphView {...props}/>);
  expect(paint()).toEqual(Array(5).fill('var(--graph-label-annotation)'));
});

it('retains the same native relation, edge and appearance addresses in both visual layers and the selectable label', async () => {
  const props = base();
  props.stakeCounts = { 'native-record': { truth: { pro: 100_000, con: 0 }, value: { pro: 0, con: 0 } } };
  const view = render(<GraphView {...props} />);
  const hit = await waitFor(() => {
    const value = view.container.querySelector<HTMLElement>('[data-directed-edge-label="native-record"]');
    expect(value).not.toBeNull(); return value!;
  });
  for (const layer of Object.values(layers(view.container))) {
    const record = layer.querySelector('g[data-frame-edge-id="native-edge"]')!;
    expect(record).not.toBeNull();
    expect(record).toHaveAttribute('data-jump-visual-msgids', 'native-record');
    expect(record).toHaveAttribute('data-relation-type', 'reference');
    expect(record).toHaveAttribute('data-stake-level', '2');
    expect(record).toHaveAttribute('data-stake-total', '100000');
  }
  expect(hit.style.zIndex).toBe('13'); expect(hit.style.pointerEvents).toBe('auto');
  expect(hit).toHaveAttribute('data-frame-edge-id', 'native-edge');
  fireEvent.click(hit);
  expect(props.onEdgeLabelSingleClick).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'native-record', 'native-edge');
  fireEvent.doubleClick(hit);
  expect(props.onEdgeLabelDoubleClick).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'native-record');
  expect(props.onMessageClick).not.toHaveBeenCalled();
  const card = view.container.querySelector<HTMLElement>('.themed-message[data-msgid="unrelated"]')!;
  fireEvent.click(card);
  expect(props.onMessageClick).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'unrelated');
});

it('preserves native viewport clipping separately for paths and labels without duplicating relation text', async () => {
  const props = base();
  props.messages.push(message('frame', { kind: 'relation', relationType: 'classify' }));
  props.edges.push(...['source', 'target'].map((id): DemoEdge => ({ id: `frame-${id}`, relationMessageId: 'frame', relationType: 'classify', relationLabel: '',
    from: { messageId: 'anon:frame', selection: { kind: 'whole' } }, to: { messageId: id, selection: { kind: 'whole' } } })));
  props.traceFrameIds = new Set(['frame']); props.traceExpandedFrameIds = new Set(['frame']);
  props.frameViewStateRef = { current: { main: { sizes: { frame: { width: 1100, height: 400 } }, scrolls: { frame: { left: 0, top: 0 } }, full: { frame: false } } } };
  const view = render(<GraphView {...props} />);
  await waitFor(() => expect(layers(view.container).paths?.querySelector('g[data-frame-edge-id="native-edge"]')).toBeTruthy());
  const clips = Object.values(layers(view.container)).map(layer => {
    const record = layer.querySelector('g[data-frame-edge-id="native-edge"]')!;
    const clip = record.parentElement!;
    expect(clip.tagName.toLowerCase()).toBe('svg');
    expect(clip).toHaveAttribute('viewBox');
    expect(record).toHaveAttribute('data-jump-visual-msgids', 'native-record');
    return [clip.getAttribute('x'), clip.getAttribute('y'), clip.getAttribute('width'), clip.getAttribute('height'), clip.getAttribute('viewBox')];
  });
  expect(clips[0]).toEqual(clips[1]);
  expect(view.container.querySelector('[data-directed-edge-label="native-record"]')?.closest('[data-frame-clip]')).not.toBeNull();
  expect(view.container.querySelectorAll('.graph-edge-label-text')).toHaveLength(1);
});
