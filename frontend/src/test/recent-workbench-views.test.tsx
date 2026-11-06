import { act, fireEvent, render, screen } from '@testing-library/react';
import { createContext, useContext, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecentWorkbenchViews from '../components/RecentWorkbenchViews';
import {useWorkbenchPortalTarget} from '../context/WorkbenchPortalContext';
import {ViewCacheSettingsProvider,VIEW_CACHE_LIMIT_KEY,useViewCacheSettings} from '../context/ViewCacheSettingsContext';

afterEach(()=>localStorage.removeItem(VIEW_CACHE_LIMIT_KEY));

describe('recent workbench views', () => {
  it('releases a large document on leaving before another document starts loading', () => {
    const release = vi.fn();
    function Document() { useEffect(() => release, []); return <div>大档案</div>; }
    const view = render(<RecentWorkbenchViews viewKey="viewer" retainOnLeave={false} deferParking><Document /></RecentWorkbenchViews>);
    view.rerender(<RecentWorkbenchViews viewKey="chooser" deferParking><div>选择文件</div></RecentWorkbenchViews>);
    expect(release).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-cached-view-count]')).toHaveAttribute('data-cached-view-count', '1');
  });
  it('replaces a previous viewer instance without evicting an unrelated online workbench', () => {
    const released = vi.fn();
    function Scene({ id }: { id: string }) {
      const [value] = useState(() => ({ id }));
      useEffect(() => () => released(value), [value]);
      return <div data-scene={id}>{id}</div>;
    }
    const element = (id: string) => <RecentWorkbenchViews viewKey={id}
      exclusiveGroup={id.startsWith('viewer:') ? 'viewer' : undefined} deferParking>
      <Scene id={id} />
    </RecentWorkbenchViews>;
    const view = render(element('online'));
    const online = view.container.querySelector('[data-scene="online"]');
    view.rerender(element('viewer:first'));
    view.rerender(element('home'));
    expect(released).not.toHaveBeenCalled();
    for (let index = 0; index < 8; index++) view.rerender(element(`viewer:${index}`));
    expect(released).toHaveBeenCalledWith({ id: 'viewer:first' });
    expect(view.container.querySelector('[data-cached-view-count]')).toHaveAttribute('data-cached-view-count', '3');
    view.rerender(element('online'));
    expect(view.container.querySelector('[data-scene="online"]')).toBe(online);
  });
  it('restores native scroll offsets after a retained route is detached and reattached', () => {
    const element = (key: string) => <RecentWorkbenchViews viewKey={key} deferParking preserveScroll>
      <div data-testid="scroll-box" style={{ overflow: 'auto', width: 100, height: 100 }}><div style={{ width: 1000, height: 1000 }}>{key}</div></div>
    </RecentWorkbenchViews>;
    const view = render(element('workbench'));
    const original = screen.getByTestId('scroll-box');
    original.scrollTop = 380; original.scrollLeft = 125;
    view.rerender(element('home'));
    // Browsers clear the used offsets while the box has no connected layout.
    original.scrollTop = 0; original.scrollLeft = 0;
    view.rerender(element('workbench'));
    expect(screen.getByTestId('scroll-box')).toBe(original);
    expect([original.scrollTop, original.scrollLeft]).toEqual([380, 125]);
  });

  it('shares a saved capacity across view areas and evicts immediately without rebuilding the active view',()=>{
    localStorage.setItem(VIEW_CACHE_LIMIT_KEY,'invalid');
    let settings!:ReturnType<typeof useViewCacheSettings>;
    function Settings(){settings=useViewCacheSettings();return null;}
    const element=(id:string)=><ViewCacheSettingsProvider><Settings/>
      <RecentWorkbenchViews viewKey={id}><div data-scene={id}>{id}</div></RecentWorkbenchViews>
      <RecentWorkbenchViews viewKey={id}><div data-details={id}>{id} details</div></RecentWorkbenchViews>
    </ViewCacheSettingsProvider>;
    const view=render(element('A')),original=view.container.querySelector('[data-scene="A"]');
    expect(settings.limit).toBe(4);
    act(()=>settings.setLimit(8));
    for(const id of ['B','C','D','E','F'])view.rerender(element(id));
    for(const area of view.container.querySelectorAll('[data-cached-view-count]'))expect(area).toHaveAttribute('data-cached-view-count','6');
    view.rerender(element('A'));expect(view.container.querySelector('[data-scene="A"]')).toBe(original);
    act(()=>settings.setLimit(4));
    expect(view.container.querySelector('[data-scene="A"]')).toBe(original);
    for(const area of view.container.querySelectorAll('[data-cached-view-count]'))expect(area).toHaveAttribute('data-cached-view-count','4');
    act(()=>settings.setLimit(12));
    expect(localStorage.getItem(VIEW_CACHE_LIMIT_KEY)).toBe('12');view.unmount();
    render(element('new'));expect(settings.limit).toBe(12);
  });
  it('reuses DOM and local state, parks layout effects, and resumes with current data', () => {
    const mount = vi.fn(), stop = vi.fn();
    function Scene({ id, text }: { id: string; text: string }) {
      const [collapsed, setCollapsed] = useState(false);
      useLayoutEffect(() => { mount(id, document.querySelector(`[data-scene="${id}"]`)?.isConnected); return () => stop(id); }, [id]);
      return <div data-scene={id}><button onClick={() => setCollapsed(value => !value)}>{collapsed ? '展开' : '折叠'}</button><div hidden={collapsed}>{text}</div></div>;
    }
    const element = (id: string, text: string) => <RecentWorkbenchViews viewKey={id}><Scene id={id} text={text} /></RecentWorkbenchViews>;
    const view = render(element('A', '旧消息'));
    const original = view.container.querySelector('[data-scene="A"]');
    fireEvent.click(screen.getByRole('button', { name: '折叠' }));
    view.rerender(element('B', '另一个视图'));
    expect(original?.isConnected).toBe(false);
    expect(stop).toHaveBeenCalledWith('A');
    view.rerender(element('B', '同步的新消息'));
    expect(screen.getByText('同步的新消息')).toBeVisible();
    view.rerender(element('A', 'A 收到的新消息'));
    expect(view.container.querySelector('[data-scene="A"]')).toBe(original);
    expect(screen.getByRole('button', { name: '展开' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.getByText('A 收到的新消息')).toBeVisible();
    expect(mount.mock.calls.every(([, connected]) => connected === true)).toBe(true);
    expect(view.container.querySelectorAll('[data-scene]')).toHaveLength(1);
  });
  it('evicts the least recently used view and releases all views when its owner changes', () => {
    function Scene({ id }: { id: string }) { return <div data-scene={id}>{id}</div>; }
    const element = (id: string, owner = 'user') => <RecentWorkbenchViews ownerKey={owner} viewKey={id} limit={2}><Scene id={id} /></RecentWorkbenchViews>;
    const view = render(element('A')), firstA = view.container.querySelector('[data-scene="A"]');
    view.rerender(element('B'));const firstB = view.container.querySelector('[data-scene="B"]');
    view.rerender(element('A'));expect(view.container.querySelector('[data-scene="A"]')).toBe(firstA);
    view.rerender(element('C'));expect(view.container.querySelector('[data-cached-view-count]')).toHaveAttribute('data-cached-view-count', '2');
    view.rerender(element('B'));expect(view.container.querySelector('[data-scene="B"]')).not.toBe(firstB);
    const cachedB = view.container.querySelector('[data-scene="B"]');
    view.rerender(element('B', 'other-user'));expect(view.container.querySelector('[data-scene="B"]')).not.toBe(cachedB);
  });
  it('parks floating windows and context-driven work, then resumes the original window with live data',()=>{
    const Data=createContext('initial'),rendered=vi.fn();
    function Scene({id}:{id:string}){
      const target=useWorkbenchPortalTarget(),data=useContext(Data),[open,setOpen]=useState(false);
      rendered(id,data);
      return <><button onClick={()=>setOpen(true)}>打开窗口</button>{open&&createPortal(<div role="dialog">{id}：{data}</div>,target)}</>;
    }
    const element=(id:string,data:string)=><Data.Provider value={data}><RecentWorkbenchViews viewKey={id}>
      <RecentWorkbenchViews viewKey="details"><Scene id={id}/></RecentWorkbenchViews>
    </RecentWorkbenchViews></Data.Provider>;
    const view=render(element('A','旧正文'));fireEvent.click(screen.getByRole('button',{name:'打开窗口'}));
    const popup=screen.getByRole('dialog');
    view.rerender(element('B','新正文'));const count=rendered.mock.calls.filter(([id])=>id==='A').length;
    expect(popup.isConnected).toBe(false);expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(element('B','又一条新消息'));
    expect(rendered.mock.calls.filter(([id])=>id==='A')).toHaveLength(count);
    view.rerender(element('A','已同步的新正文'));
    expect(screen.getByRole('dialog')).toBe(popup);expect(popup).toHaveTextContent('已同步的新正文');
    view.unmount();expect(popup.isConnected).toBe(false);
  });
});
it('keeps each cached scene intact while the next scope is still loading', () => {
  const scene = (id: string, pending = false) => <RecentWorkbenchViews viewKey={id} pending={pending}><div data-testid="scope">{id}</div></RecentWorkbenchViews>;
  const view = render(scene('A'));
  const first = screen.getByTestId('scope');
  view.rerender(scene('B', true));
  expect(screen.getByTestId('scope')).toBe(first); expect(first).toHaveTextContent('A');
  view.rerender(scene('B'));
  const second = screen.getByTestId('scope');
  for (let n = 0; n < 8; n++) {
    view.rerender(scene('A', true)); expect(screen.getByTestId('scope')).toBe(second);
    view.rerender(scene('A')); expect(screen.getByTestId('scope')).toBe(first);
    view.rerender(scene('B', true)); expect(screen.getByTestId('scope')).toBe(first);
    view.rerender(scene('B')); expect(screen.getByTestId('scope')).toBe(second);
  }
  expect(view.container.querySelector('[data-cached-view-count]')).toHaveAttribute('data-cached-view-count', '2');
});
