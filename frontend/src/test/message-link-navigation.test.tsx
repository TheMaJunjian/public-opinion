import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { useMessageLinkNavigation } from '../hooks/useMessageLinkNavigation';
import { categoryMessageUrl } from '../utils/messageLink';

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

it.each(['https://example.com/messages?sender=甲&locate=1', 'file:///app/index.html#/messages?sender=甲&locate=1'])('keeps the route and other parameters when entering and leaving a category: %s', address => {
  const entered = new URL(categoryMessageUrl(address, '分类:一 & 二'));
  const route = entered.hash.startsWith('#/') ? new URL(entered.hash.slice(1), 'https://example.com') : entered;
  expect(route.searchParams.get('msg')).toBe('分类:一 & 二');
  expect(route.searchParams.get('sender')).toBe('甲');
  expect(route.searchParams.has('locate')).toBe(false);
  const exited = new URL(categoryMessageUrl(entered.href, null));
  const original = new URL(address);
  if (original.hash) expect(exited.hash).toBe('#/messages?sender=%E7%94%B2');
  else expect(exited.search).toBe('?sender=%E7%94%B2');
  expect(exited.pathname).toBe(original.pathname);
});

it.each([false, true])('waits for data and preserves a refreshable message URL (hash=%s)', hash => {
  const url = `${hash ? '/#' : ''}/messages?msg=${encodeURIComponent('消息:123')}&sender=甲`;
  window.history.replaceState(null, '', url);
  const navigate = vi.fn();
  const hook = renderHook(({ ready }) => useMessageLinkNavigation(ready, navigate), {
    initialProps: { ready: false }, wrapper: hash ? HashRouter : BrowserRouter,
  });
  expect(navigate).not.toHaveBeenCalled();
  hook.rerender({ ready: true });
  expect(navigate).toHaveBeenCalledExactlyOnceWith('消息:123', { recordHistory: false, enterCategory: true });
  expect(window.location.href).toContain('msg=');
  hook.rerender({ ready: false }); hook.rerender({ ready: true });
  expect(navigate).toHaveBeenCalledTimes(1);
  act(() => {
    window.history.pushState(null, '', `${hash ? '/#' : ''}/messages?msg=second&locate=1`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(navigate).toHaveBeenLastCalledWith('second', { recordHistory: false, enterCategory: false });
});
