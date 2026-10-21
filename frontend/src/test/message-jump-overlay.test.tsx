import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MessageJumpOverlay } from '../components/PopupOverlay';
import { createMessageJumpGroups, getMessageJumpDisplay, registerMessageJumpGroups } from '../utils/messageJumpDisplay';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

it('cuts the live message out of the entire prompt, including guides and hint text', () => {
  const canvas = document.createElement('div');
  canvas.setAttribute('data-jump-canvas', 'true');
  const target = document.createElement('button');
  target.setAttribute('data-msgid', 'message');
  target.textContent = '选择消息';
  target.style.pointerEvents = 'auto';
  target.style.color = 'rgb(238, 238, 238)';
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 120, 240, 80));
  const select = vi.fn();
  target.addEventListener('click', select);
  canvas.appendChild(target);
  document.body.appendChild(canvas);
  const view = render(<MessageJumpOverlay messageId="message" targetElement={target} targetRect={target.getBoundingClientRect()} />);
  try {
    expect(screen.getByText('已定位目标消息')).toBeInTheDocument();
    const overlay = document.querySelector<HTMLElement>('[data-message-jump-target="message"]')!;
    expect(overlay.querySelector('.popup-guides')).not.toBeNull();
    expect(overlay.querySelector('.popup-backdrop-guides')).toBeNull();
    const mask = document.querySelector('mask')!;
    expect(overlay.style.maskImage).toBe(`url(#${mask.id})`);
    const opening = mask.querySelector('[data-message-jump-region="message"]')!;
    expect(opening).toHaveAttribute('x', '20');
    expect(opening).toHaveAttribute('y', '120');
    expect(opening).toHaveAttribute('width', '240');
    expect(opening).toHaveAttribute('height', '80');
    expect(opening).toHaveAttribute('fill', 'black');
    expect(mask).toHaveStyle({ maskType: 'luminance' });
    expect(overlay.style.background).toBe('rgba(0, 0, 0, 0.42)');
    expect(overlay.contains(screen.getByText('已定位目标消息'))).toBe(true);
    expect(overlay.firstElementChild?.getAttribute('style')).toContain('z-index: 1');
    expect(document.querySelector('[data-message-jump-clone]')).toBeNull();
    expect(screen.getAllByText('选择消息')).toHaveLength(1);
    expect(overlay.style.pointerEvents).toBe('none');
    expect(canvas.style.visibility).toBe('');
    expect(target.style.visibility).toBe('');
    expect(screen.getByRole('button', { name: '选择消息' })).toBe(target);
    fireEvent.click(target);
    expect(select).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.querySelector('[data-message-jump-region]')).toBeNull();
    fireEvent.click(target);
    expect(select).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    vi.restoreAllMocks();
    canvas.remove();
  }
});

it.each([0.7, 1, 1.5])('unmasks a JOIN, its sibling decorations and dependent relation layers at scale %s', scale => {
  const canvas = document.createElement('div');
  canvas.dataset.jumpCanvas = 'true';
  canvas.innerHTML = `<div><div data-msgid="join">加入消息</div><div data-msgid="unrelated">无关消息</div></div>
    <div data-msgid="join" data-jump-msgids="agree" data-rel-overlay>👍 1 赞</div>
    <div data-msgid="join" data-jump-msgids="disagree" data-rel-overlay>👎 1 反</div>
    <svg><g data-jump-visual-msgids="reference"><path d="M 1 1 L 20 20"/><text>依附的引用</text></g>
      <g data-jump-visual-msgids="other-reference"><text>无关引用</text></g></svg>
    <div data-msgid="reference" data-rel-overlay></div>
    <div data-msgid="nested-tag" data-rel-overlay>引用上的标注</div>`;
  document.body.append(canvas);
  Object.defineProperties(canvas, { offsetWidth: { value: 1000 }, offsetHeight: { value: 1000 } });
  const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === canvas) return new DOMRect(0, 0, 1000 * scale, 1000 * scale);
    if (this.getAttribute('data-msgid') === 'join' && !this.hasAttribute('data-rel-overlay')) return new DOMRect(20 * scale, 120 * scale, 240 * scale, 80 * scale);
    if (this.getAttribute('data-msgid') === 'join') return new DOMRect(270 * scale, 120 * scale, 60 * scale, 30 * scale);
    return new DOMRect(500 * scale, 300 * scale, 160 * scale, 50 * scale);
  });
  const unregister = registerMessageJumpGroups(canvas, new Map([
    ['join', new Set(['agree', 'disagree', 'reference'])], ['reference', new Set(['nested-tag'])],
  ]));
  const target = canvas.querySelector<HTMLElement>('[data-msgid="join"]')!;
  const display = getMessageJumpDisplay(target, 'join');
  const view = render(<MessageJumpOverlay messageId="join" targetElement={target} targetRect={target.getBoundingClientRect()} />);
  try {
    const regions = [...document.querySelectorAll('[data-message-jump-region]')];
    const uncovered = regions.flatMap(region => region.getAttribute('data-message-jump-region')!.split(/\s+/));
    for (const id of ['join', 'agree', 'disagree', 'reference', 'nested-tag']) expect(uncovered).toContain(id);
    for (const id of ['unrelated', 'other-reference']) expect(uncovered).not.toContain(id);
    for (const text of ['加入消息', '👍 1 赞', '👎 1 反', '依附的引用', '引用上的标注']) expect(within(canvas).getByText(text)).toBeVisible();
    expect(canvas.querySelector('[data-jump-visual-msgids="reference"] path')).not.toBeNull();
    expect(display.rect.right).toBeCloseTo(660 * scale);
    expect(display.rect.bottom).toBeCloseTo(350 * scale);
    const card = regions.find(region => region.getAttribute('data-message-jump-region') === 'join')!;
    expect(Number(card.getAttribute('x'))).toBeCloseTo(20 * scale);
    expect(Number(card.getAttribute('width'))).toBeCloseTo(240 * scale);
  } finally { view.unmount(); unregister(); geometry.mockRestore(); canvas.remove(); }
});

it('collects frame members and recursively anchored messages without following unrelated endpoints', () => {
  const messages: DemoMessage[] = [{ id: 'join', kind: 'join', author: 'tester', createdAt: '', content: '',
    joinInfo: { containerId: 'frame', containerType: 'MERGE', targetIds: ['member'] } }];
  const edge = (id: string, type: DemoEdge['relationType'], from: string, to: string): DemoEdge => ({
    id, relationMessageId: id, relationType: type, relationLabel: type,
    from: { messageId: from, selection: { kind: 'whole' } }, to: { messageId: to, selection: { kind: 'whole' } },
  });
  const groups = createMessageJumpGroups(messages, [edge('reference', 'reference', 'member', 'outside'),
    edge('agree', 'agree', 'anon:agree', 'reference'), edge('tag', 'tag', 'anon:tag', 'agree'),
    edge('cycle', 'reference', 'tag', 'member')], new Map([['frame', new Set(['member', 'inner'])], ['inner', new Set(['nested-member'])]]));
  const canvas = document.createElement('div'); canvas.dataset.jumpCanvas = 'true';
  for (const id of ['frame', 'join', 'member', 'inner', 'nested-member', 'reference', 'agree', 'tag', 'cycle', 'outside']) {
    const element = document.createElement('div'); element.dataset.msgid = id; canvas.append(element);
  }
  const unregister = registerMessageJumpGroups(canvas, groups);
  try {
    const display = getMessageJumpDisplay(canvas.firstElementChild as HTMLElement, 'frame');
    expect([...display.elements!].map(element => element.getAttribute('data-msgid'))).toEqual([
      'frame', 'join', 'member', 'inner', 'nested-member', 'reference', 'agree', 'tag', 'cycle',
    ]);
  } finally { unregister(); }
});

it('clips openings to the pane and follows the original card when it scrolls', () => {
  vi.useFakeTimers();
  const pane = document.createElement('div'), card = document.createElement('div');
  pane.style.overflow = 'auto'; card.dataset.msgid = 'live'; pane.append(card); document.body.append(pane);
  const viewport = vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 300, 200));
  let top = 80;
  const geometry = vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(80, top, 400, 100));
  const view = render(<MessageJumpOverlay messageId="live" targetElement={card} targetRect={card.getBoundingClientRect()} />);
  const opening = () => document.querySelector('[data-message-jump-region="live"]')!;
  try {
    expect(opening()).toHaveAttribute('x', '100');
    expect(opening()).toHaveAttribute('width', '300');
    expect(opening()).toHaveAttribute('y', '100');
    expect(opening()).toHaveAttribute('height', '80');
    top = 250; fireEvent.scroll(pane);
    act(() => { vi.advanceTimersByTime(17); });
    expect(opening()).toHaveAttribute('y', '250');
    expect(opening()).toHaveAttribute('height', '50');
    expect(card.style.visibility).toBe('');
  } finally { view.unmount(); geometry.mockRestore(); viewport.mockRestore(); pane.remove(); vi.useRealTimers(); }
});

it('reveals the live SVG and card behind a relation hit area without duplicating their IDs or styles', () => {
  const canvas = document.createElement('div');
  canvas.dataset.jumpCanvas = 'true';
  canvas.innerHTML = `<div data-card-wrapper><div data-msgid="card">消息卡</div><div data-msgid="outside">区域外消息</div></div>
    <svg><defs><marker id="arrow"><path d="M 0 0 L 3 3" /></marker></defs>
      <text marker-end="url(#arrow)">关系标签</text></svg>
    <div data-rel-overlay="true" data-msgid="relation" data-jump-msgids="rejection-record" style="pointer-events:auto"></div>`;
  document.body.appendChild(canvas);
  const bounds = new DOMRect(20, 120, 240, 80);
  const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-card-wrapper')) return new DOMRect(0, 100, 300, 0);
    if (this.getAttribute('data-msgid') === 'outside') return new DOMRect(900, 900, 240, 80);
    return bounds;
  });
  const cloneCanvas = vi.spyOn(canvas, 'cloneNode');
  const view = render(<MessageJumpOverlay messageId="rejection-record" targetElement={canvas.querySelector('[data-rel-overlay]')!} targetRect={bounds} />);
  try {
    const region = document.querySelector('[data-message-jump-region]')!;
    expect(region).toHaveAttribute('x', '20');
    expect(region).toHaveAttribute('y', '120');
    expect(region).toHaveAttribute('width', '240');
    expect(region).toHaveAttribute('height', '80');
    expect(within(canvas).getByText('消息卡')).toBeVisible();
    expect(within(canvas).getByText('关系标签')).toBeVisible();
    expect(cloneCanvas).not.toHaveBeenCalled();
    expect(cloneCanvas).not.toHaveBeenCalledWith(true);
    expect(document.querySelectorAll('#arrow')).toHaveLength(1);
    expect(canvas.querySelector('text')).toHaveAttribute('marker-end', 'url(#arrow)');
    expect(document.getElementById('arrow')).toBe(canvas.querySelector('marker'));
    expect(canvas.style.visibility).toBe('');
    expect(document.querySelector('[data-message-jump-target="rejection-record"]')).not.toBeNull();
  } finally {
    view.unmount();
    geometry.mockRestore();
    cloneCanvas.mockRestore();
    canvas.remove();
  }
});
