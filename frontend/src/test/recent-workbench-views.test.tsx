import { act, fireEvent, render, screen } from '@testing-library/react';
import { createContext, useContext, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecentWorkbenchViews from '../components/RecentWorkbenchViews';
import {useWorkbenchPortalTarget} from '../context/WorkbenchPortalContext';
import {ViewCacheSettingsProvider,VIEW_CACHE_LIMIT_KEY,useViewCacheSettings} from '../context/ViewCacheSettingsContext';

afterEach(()=>localStorage.removeItem(VIEW_CACHE_LIMIT_KEY));

describe('recent workbench views', () => {
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
