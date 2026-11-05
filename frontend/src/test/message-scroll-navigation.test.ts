import { afterEach, expect, it, vi } from 'vitest';
import { createWorkbenchDrawingTasks } from '../context/WorkbenchDrawingContext';
import { findMessageElements, scrollMsgToCenter } from '../pages/workbench/actions/scrollNavigation';
import { REVEAL_VIRTUAL_MESSAGE, type VirtualMessageRevealDetail } from '../hooks/useVirtualMessageMounts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

function dimensions(element: HTMLElement, values: Record<string, number>) {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(element, key, { configurable: true, value });
}

function navigation(panel: HTMLDivElement) {
  const pulse = vi.fn((_id: string, _element: HTMLElement, _request: number | undefined, done?: (located: boolean) => void) => done?.(true));
  return { scrollRequestIdRef: { current: 0 }, pendingScrollMsgIdRef: { current: null as string | null }, MAX_SCROLL_ATTEMPTS: 60 as const,
    pendingScrollDependencyIdsRef: { current: [] as string[] }, leftPanelRef: { current: panel }, scrollRafRef: { current: null as number | null },
    findMessageElements, relationsRef: { current: [] }, edgesRef: { current: [] }, showMessagePulse: pulse, cancelScrollRafs: vi.fn() };
}

it.each([
  {name:'an already visible message',top:150,height:80,initial:100,expected:100},
  {name:'a message partly below the pane',top:400,height:80,initial:100,expected:180},
  {name:'a message partly above the pane',top:50,height:80,initial:100,expected:50},
  {name:'a long message below the pane',top:1200,height:2000,initial:0,expected:1200},
  {name:'a long message whose middle is visible',top:1200,height:2000,initial:1800,expected:1200},
  {name:'a long message with its beginning already visible',top:1200,height:2000,initial:1150,expected:1150},
])('minimally scrolls to $name and exposes its beginning',({top,height,initial,expected})=>{
  vi.useFakeTimers();
  const panel=document.createElement('div'),card=document.createElement('div');
  card.dataset.msgid='destination';panel.append(card);document.body.append(panel);
  dimensions(panel,{clientWidth:400,offsetWidth:400,clientHeight:300,offsetHeight:300,scrollWidth:4000,scrollHeight:5000});
  panel.scrollTop=initial;panel.scrollLeft=70;
  vi.spyOn(panel,'getBoundingClientRect').mockReturnValue(new DOMRect(0,100,400,300));
  vi.spyOn(card,'getBoundingClientRect').mockImplementation(()=>new DOMRect(100-panel.scrollLeft,100+top-panel.scrollTop,200,height));
  const native=vi.spyOn(card,'scrollIntoView'),dependencies=navigation(panel),completed=vi.fn();
  scrollMsgToCenter(dependencies,'destination',{onComplete:completed});
  vi.advanceTimersByTime(100);
  expect(panel.scrollTop).toBe(expected);expect(panel.scrollLeft).toBe(70);
  expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(100);
  expect(native).not.toHaveBeenCalled();expect(completed).toHaveBeenCalledExactlyOnceWith(true);
});

it.each([true,false])('prefers a measurable directed start and falls back to its label when the start is unavailable (start=%s)',available=>{
  vi.useFakeTimers();
  const panel=document.createElement('div'),label=document.createElement('div'),start=document.createElement('div');
  label.dataset.msgid='citation';label.dataset.directedEdgeLabel='citation';label.dataset.relOverlay='true';
  start.dataset.directedEdgeStart='citation';start.dataset.jumpMsgids='citation';
  panel.append(label,start);document.body.append(panel);
  dimensions(panel,{clientWidth:400,offsetWidth:400,clientHeight:300,offsetHeight:300,scrollWidth:4000,scrollHeight:5000});
  vi.spyOn(panel,'getBoundingClientRect').mockReturnValue(new DOMRect(0,100,400,300));
  vi.spyOn(label,'getBoundingClientRect').mockImplementation(()=>new DOMRect(1700-panel.scrollLeft,100+2400-panel.scrollTop,80,30));
  vi.spyOn(start,'getBoundingClientRect').mockImplementation(()=>new DOMRect(800-panel.scrollLeft,100+1200-panel.scrollTop,available?16:0,available?16:0));
  const dependencies=navigation(panel),completed=vi.fn();
  scrollMsgToCenter(dependencies,'citation',{onComplete:completed});vi.advanceTimersByTime(100);
  expect(panel.scrollLeft).toBe(available?416:1380);expect(panel.scrollTop).toBe(available?916:2130);
  expect(dependencies.showMessagePulse).toHaveBeenCalledWith('citation',available?start:label,1,expect.any(Function));
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
});

it.each([0.7, 1, 1.5])('minimally reveals a JOIN message in the pane at interface scale %s before announcing success', scale => {
  vi.useFakeTimers();
  const panel = document.createElement('div'), card = document.createElement('div');
  card.dataset.msgid = 'cmtgzbzg101fx13qjrq3v2yo6';
  panel.append(card); document.body.append(panel);
  dimensions(panel, { clientWidth: 400, offsetWidth: 400, clientHeight: 300, offsetHeight: 300, scrollWidth: 4000, scrollHeight: 5000 });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400 * scale, 300 * scale));
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(
    (1700 - panel.scrollLeft) * scale, 100 + (2400 - panel.scrollTop) * scale, 200 * scale, 80 * scale));
  const dependencies = navigation(panel), completed = vi.fn();
  scrollMsgToCenter(dependencies, card.dataset.msgid, { onComplete: completed });
  vi.advanceTimersByTime(100);
  expect(panel.scrollLeft).toBeCloseTo(1500);
  expect(panel.scrollTop).toBeCloseTo(2180);
  const rect = card.getBoundingClientRect(), viewport = panel.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(viewport.left);
  expect(rect.right).toBeLessThanOrEqual(viewport.right);
  expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
  expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom);
  expect(dependencies.showMessagePulse).toHaveBeenCalledWith(card.dataset.msgid, card, 1, expect.any(Function));
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
});

it('scrolls a nested clipping viewport even when the target is already inside the browser viewport', () => {
  vi.useFakeTimers();
  const panel = document.createElement('div'), nested = document.createElement('div'), card = document.createElement('div');
  card.dataset.msgid = 'join-record'; nested.style.overflowY = 'auto';
  nested.append(card); panel.append(nested); document.body.append(panel);
  dimensions(panel, { clientWidth: 600, clientHeight: 400, scrollWidth: 600, scrollHeight: 400 });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 400));
  vi.spyOn(nested, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 120, 200, 150));
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(40, 420 - nested.scrollTop, 100, 80));
  const reveal = vi.spyOn(card, 'scrollIntoView').mockImplementation(() => { nested.scrollTop = 265; });
  const dependencies = navigation(panel), completed = vi.fn();
  scrollMsgToCenter(dependencies, 'join-record', { onComplete: completed });
  vi.advanceTimersByTime(100);
  expect(reveal).toHaveBeenCalledWith({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
  expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(nested.getBoundingClientRect().bottom);
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
});

it('waits for a frame scroll to commit before centering the pane and showing the target prompt', () => {
  vi.useFakeTimers();
  const panel=document.createElement('div'),clip=document.createElement('div'),card=document.createElement('div');
  card.dataset.msgid='frame-member';clip.style.overflow='clip';clip.append(card);panel.append(clip);document.body.append(panel);
  dimensions(panel,{clientWidth:600,clientHeight:400,scrollWidth:600,scrollHeight:400});
  vi.spyOn(panel,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,600,400));
  vi.spyOn(clip,'getBoundingClientRect').mockReturnValue(new DOMRect(20,120,400,180));
  let committed=false;
  vi.spyOn(card,'getBoundingClientRect').mockImplementation(()=>new DOMRect(40,committed?150:1500,320,80));
  const nativeScroll=vi.spyOn(card,'scrollIntoView');
  panel.addEventListener(REVEAL_VIRTUAL_MESSAGE,event=>{
    const detail=(event as CustomEvent<VirtualMessageRevealDetail>).detail;
    if(!detail.ids.length||committed)return;
    detail.positioningPending=true;
    requestAnimationFrame(()=>{committed=true;});
  });
  const dependencies=navigation(panel),completed=vi.fn();
  scrollMsgToCenter(dependencies,'frame-member',{onComplete:completed});
  vi.advanceTimersByTime(17);
  expect(dependencies.showMessagePulse).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
  expect(dependencies.showMessagePulse).toHaveBeenCalledWith('frame-member',card,1,expect.any(Function));
  expect(nativeScroll).not.toHaveBeenCalled();
  expect(clip.scrollTop).toBe(0);
});

it('uses the visible part of the pane without unnecessary native page scrolling', () => {
  vi.useFakeTimers();
  const panel = document.createElement('div'), card = document.createElement('div');
  card.dataset.msgid = 'join-record'; panel.append(card); document.body.append(panel);
  dimensions(panel, { clientWidth: 400, clientHeight: 600, scrollWidth: 400, scrollHeight: 5000 });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 400, 600));
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(40, 500 + 1200 - panel.scrollTop, 200, 80));
  vi.spyOn(card, 'scrollIntoView').mockImplementation(() => { panel.scrollTop = 1130; });
  const dependencies = navigation(panel), completed = vi.fn();
  scrollMsgToCenter(dependencies, 'join-record', { onComplete: completed });
  vi.advanceTimersByTime(150);
  expect(panel.scrollTop).toBe(1780-window.innerHeight);
  expect(card.scrollIntoView).not.toHaveBeenCalled();
  expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
});

it.each([0.7, 1.5])('locates the same message at different positions in both comparison panes at scale %s', scale => {
  vi.useFakeTimers(); vi.stubGlobal('innerWidth', 2400); vi.stubGlobal('innerHeight', 1200);
  const panel = document.createElement('div');
  panel.innerHTML = '<div data-comparison-pair><div data-comparison-viewport="agree"><div data-msgid="join-record"></div></div><div data-comparison-viewport="disagree"><div data-msgid="join-record"></div></div></div>';
  document.body.append(panel);
  dimensions(panel, { clientWidth: 900, offsetWidth: 900, clientHeight: 400, offsetHeight: 400, scrollWidth: 900, scrollHeight: 400 });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 900 * scale, 400 * scale));
  const viewports = [...panel.querySelectorAll<HTMLElement>('[data-comparison-viewport]')];
  viewports.forEach((viewport, index) => {
    viewport.style.overflow = 'auto';
    dimensions(viewport, { clientWidth: 400, offsetWidth: 400, clientHeight: 300, offsetHeight: 300, scrollWidth: 4000, scrollHeight: 5000 });
    const x = index * 450 * scale;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, 120, 400 * scale, 300 * scale));
    vi.spyOn(viewport.firstElementChild!, 'getBoundingClientRect').mockImplementation(() => new DOMRect(
      x + (1700 - index * 900 - viewport.scrollLeft) * scale, 120 + (2400 - index * 1200 - viewport.scrollTop) * scale, 200 * scale, 80 * scale));
  });
  const dependencies = navigation(panel), completed = vi.fn();
  scrollMsgToCenter(dependencies, 'join-record', { onComplete: completed });
  vi.advanceTimersByTime(150);
  expect(viewports[0].scrollTop).toBeCloseTo(2180); expect(viewports[0].scrollLeft).toBeCloseTo(1500);
  expect(viewports[1].scrollTop).toBeCloseTo(980); expect(viewports[1].scrollLeft).toBeCloseTo(600);
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
});

it('waits for destination measurement and corrects a later layout shift before showing the mask', () => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks(), measurement = tasks.begin('measurement');
  const panel = document.createElement('div'), card = document.createElement('div');
  card.dataset.msgid = 'join-record'; panel.append(card); document.body.append(panel);
  dimensions(panel, { clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 5000 });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 300));
  let cardTop = 1200;
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(40, cardTop - panel.scrollTop, 200, 80));
  const positioning = tasks.begin('positioning');
  const dependencies = { ...navigation(panel), startPositioning: () => ({ ...positioning, complete: positioning.release, run: (work: () => void) => work() }) };
  const completed = vi.fn();
  scrollMsgToCenter(dependencies, 'join-record', { onComplete: completed });
  vi.advanceTimersByTime(100);
  expect(panel.scrollTop).toBe(0);
  measurement.release();
  vi.advanceTimersByTime(34);
  expect(panel.scrollTop).toBe(880);
  const lateMeasurement = tasks.begin('measurement');
  cardTop = 2400;
  vi.advanceTimersByTime(100);
  expect(dependencies.showMessagePulse).not.toHaveBeenCalled();
  lateMeasurement.release();
  vi.advanceTimersByTime(200);
  expect(panel.scrollTop).toBe(2080);
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
  expect(tasks.pending).toBe(0);
});

it('does not report success or show a mask if scrolling never exposes the target', () => {
  vi.useFakeTimers();
  const panel = document.createElement('div'), card = document.createElement('div');
  card.dataset.msgid = 'join-record'; panel.append(card); document.body.append(panel);
  dimensions(panel, { clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 300 });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 300));
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 500, 200, 80));
  const reveal = vi.fn(); panel.addEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
  const dependencies = navigation(panel), completed = vi.fn();
  scrollMsgToCenter(dependencies, 'join-record', { onComplete: completed });
  vi.advanceTimersByTime(4000);
  expect(dependencies.showMessagePulse).not.toHaveBeenCalled();
  expect(completed).toHaveBeenCalledExactlyOnceWith(false);
  expect(dependencies.pendingScrollMsgIdRef.current).toBeNull();
  expect(reveal.mock.lastCall![0].detail.ids).toEqual([]);
});

it('settles a cancelled location once and releases the virtual pin without showing success', () => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks(), positioning = tasks.begin('positioning');
  const panel = document.createElement('div'); document.body.append(panel);
  const dependencies = { ...navigation(panel), startPositioning: () => ({ ...positioning, complete: positioning.release, run: (work: () => void) => work() }) };
  const completed = vi.fn();
  scrollMsgToCenter(dependencies, 'missing-message', { onComplete: completed });
  positioning.cancel(); vi.advanceTimersByTime(200);
  expect(completed).toHaveBeenCalledExactlyOnceWith(false, true);
  expect(dependencies.pendingScrollMsgIdRef.current).toBeNull();
  expect(dependencies.showMessagePulse).not.toHaveBeenCalled();
  expect(tasks.pending).toBe(0);
});
