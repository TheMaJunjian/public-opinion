import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MessageJumpOverlay } from '../components/PopupOverlay';

it('copies the message above the mask and guides while keeping the live card interactive', () => {
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
    const copy = overlay.querySelector<HTMLElement>('[data-message-jump-clone]')!;
    expect(copy).not.toBeNull();
    expect(overlay.style.background).toBe('rgba(0, 0, 0, 0.42)');
    expect(copy.parentElement?.style.zIndex).toBe('2');
    expect(overlay.firstElementChild?.getAttribute('style')).toContain('z-index: 1');
    expect(copy.style.left).toBe('20px');
    expect(copy.style.top).toBe('120px');
    expect(copy.style.color).toBe('rgb(238, 238, 238)');
    expect(copy.inert).toBe(true);
    expect(within(copy).getByText('选择消息')).toBeVisible();
    for (const node of [overlay, copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
      expect(node.style.pointerEvents).toBe('none');
    }
    expect(canvas.style.visibility).toBe('');
    expect(target.style.visibility).toBe('');
    expect(screen.getByRole('button', { name: '选择消息' })).toBe(target);
    fireEvent.click(target);
    expect(select).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.querySelector('[data-message-jump-clone]')).toBeNull();
    fireEvent.click(target);
    expect(select).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    vi.restoreAllMocks();
    canvas.remove();
  }
});

it('copies the visible card and SVG label behind a relation hit area without copying the rest of the canvas', () => {
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
    const copy = document.querySelector<HTMLElement>('[data-message-jump-clone]')!;
    expect(within(copy).getByText('消息卡')).toBeVisible();
    expect(within(copy).getByText('关系标签')).toBeVisible();
    expect(within(copy).queryByText('区域外消息')).toBeNull();
    expect(cloneCanvas).toHaveBeenCalledWith(false);
    expect(cloneCanvas).not.toHaveBeenCalledWith(true);
    const copiedMarker = copy.querySelector('marker')!;
    expect(copiedMarker.id).not.toBe('arrow');
    expect(copy.querySelector('text')).toHaveAttribute('marker-end', `url(#${copiedMarker.id})`);
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
