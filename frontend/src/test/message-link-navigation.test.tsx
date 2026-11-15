import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { useMessageLinkNavigation } from '../hooks/useMessageLinkNavigation';
import { messageNavigationUrl } from '../utils/messageLink';
import { fullWorkbenchPath } from '../utils/messageRoutes';

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

it.each(['/messages', '/messages/category'])('preserves the destination and filters when opening the full workbench from %s', pathname => {
  const location = { pathname, search: '?msg=original&locate=1&view=list&sender=%E7%94%B2', hash: '' };
  const route = new URL(fullWorkbenchPath(location, '消息:一 & 二'), 'https://example.com');
  expect(route.pathname).toBe(pathname);
  expect(Object.fromEntries(route.searchParams)).toEqual({ msg: '消息:一 & 二', locate: '1', view: 'list', sender: '甲', catalog: 'full' });
  expect(new URL(fullWorkbenchPath(location), route).searchParams.get('msg')).toBe('original');
});

it('keeps the linked member when the oversized snapshot is focused on its route category', () => {
  const route = new URL(fullWorkbenchPath({ pathname: '/messages/category', search: '?msg=member&locate=1' }, 'category'), 'https://example.com');
  expect(route.pathname).toBe('/messages/category');
  expect(Object.fromEntries(route.searchParams)).toEqual({ msg: 'member', locate: '1', catalog: 'full' });
});

it.each(['https://example.com/messages?sender=甲&locate=1', 'file:///app/index.html#/messages?sender=甲&locate=1'])('keeps the route and other parameters when entering and leaving a category: %s', address => {
  const entered = new URL(messageNavigationUrl(address, '分类:一 & 二'));
  const route = entered.hash.startsWith('#/') ? new URL(entered.hash.slice(1), 'https://example.com') : entered;
  expect(route.searchParams.get('msg')).toBe('分类:一 & 二');
  expect(route.searchParams.get('sender')).toBe('甲');
  expect(route.searchParams.has('locate')).toBe(false);
  const exited = new URL(messageNavigationUrl(entered.href, null));
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

it.each(['https://example.com/messages?view=graph&msg=old', 'https://example.com/#/messages?view=graph&msg=old', 'file:///app/index.html#/viewer?view=graph&msg=old'])('encodes a located message and retains route filters: %s', address => {
  const located = new URL(messageNavigationUrl(address, '消息:一 & 二', true));
  const route = located.hash.startsWith('#/') ? new URL(located.hash.slice(1), 'https://example.com') : located;
  expect(route.searchParams.get('msg')).toBe('消息:一 & 二');
  expect(route.searchParams.get('locate')).toBe('1');
  expect(route.searchParams.get('view')).toBe('graph');
  expect(located.pathname).toBe(new URL(address).pathname);
});
