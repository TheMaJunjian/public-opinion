import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSkinMotion } from '../theme/useSkinMotion';

const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
beforeEach(() => {
  vi.useFakeTimers(); media.matches = false;
  vi.stubGlobal('matchMedia', () => media);
  document.documentElement.dataset.appearance = 'gpt-arena';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 300, 100));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.appearance; });
function Scene({ tier, count = 1 }: { tier: number; count?: number }) {
  useSkinMotion();
  return <>{Array.from({length:count}, (_, i) => <div key={i} className="themed-message" data-stake-level={tier} />)}</>;
}
it('does not animate loading, caps simultaneous upgrades at four and stops after one pass', async () => {
  const view = render(<Scene tier={1} count={6} />);
  expect(view.container.querySelectorAll('[data-skin-motion]')).toHaveLength(0);
  await act(async () => view.rerender(<Scene tier={2} count={6} />));
  expect(view.container.querySelectorAll('[data-skin-motion="upgrade"]')).toHaveLength(4);
  act(() => vi.advanceTimersByTime(900));
  expect(view.container.querySelectorAll('[data-skin-motion]')).toHaveLength(0);
});
it('skips offscreen objects and reduced-motion users', async () => {
  const geometry = vi.mocked(Element.prototype.getBoundingClientRect);
  geometry.mockReturnValue(new DOMRect(10, 2000, 300, 100));
  const view = render(<Scene tier={1} />);
  await act(async () => view.rerender(<Scene tier={2} />));
  expect(view.container.querySelectorAll('[data-skin-motion]')).toHaveLength(0);
  geometry.mockReturnValue(new DOMRect(10, 10, 300, 100)); media.matches = true;
  await act(async () => view.rerender(<Scene tier={3} />));
  expect(view.container.querySelectorAll('[data-skin-motion]')).toHaveLength(0);
});
