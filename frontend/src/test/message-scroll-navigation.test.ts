import { afterEach, expect, it, vi } from 'vitest';
import { createWorkbenchDrawingTasks } from '../context/WorkbenchDrawingContext';
import { findMessageElements, scrollMsgToCenter } from '../pages/workbench/actions/scrollNavigation';
import { REVEAL_VIRTUAL_MESSAGE, type VirtualMessageRevealDetail } from '../hooks/useVirtualMessageMounts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); });

function dimensions(element: HTMLElement, values: Record<string, number>) {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(element, key, { configurable: true, value });
}

function navigation(panel: HTMLDivElement) {
  const pulse = vi.fn((_id: string, _element: HTMLElement, _request: number | undefined, done?: (located: boolean) => void) => done?.(true));
  return { scrollRequestIdRef: { current: 0 }, pendingScrollMsgIdRef: { current: null as string | null }, MAX_SCROLL_ATTEMPTS: 60 as const,
    pendingScrollDependencyIdsRef: { current: [] as string[] }, leftPanelRef: { current: panel }, scrollRafRef: { current: null as number | null },
    findMessageElements, relationsRef: { current: [] }, edgesRef: { current: [] }, showMessagePulse: pulse, cancelScrollRafs: vi.fn() };
}

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
  expect(panel.scrollLeft).toBe(available?608:1540);expect(panel.scrollTop).toBe(available?1058:2265);
  expect(dependencies.showMessagePulse).toHaveBeenCalledWith('citation',available?start:label,1,expect.any(Function));
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
});

it.each([0.7, 1, 1.5])('centers a JOIN message in the pane at interface scale %s before announcing success', scale => {
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
  expect(panel.scrollLeft).toBeCloseTo(1600);
  expect(panel.scrollTop).toBeCloseTo(2290);
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
  expect(reveal).toHaveBeenCalledWith({ behavior: 'instant', block: 'center', inline: 'center' });
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

it('keeps the native correction when only part of the pane is visible on the page', () => {
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
  expect(panel.scrollTop).toBe(1130);
  expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(completed).toHaveBeenCalledExactlyOnceWith(true);
});

it.each([0.7, 1.5])('centers and synchronizes comparison viewports at interface scale %s', scale => {
  vi.useFakeTimers();
  const panel = document.createElement('div');
  panel.innerHTML = '<div data-comparison-pair><div data-comparison-view="agree"><div data-comparison-viewport="agree"><div data-msgid="join-record"></div></div></div><div data-comparison-viewport="disagree"></div><div data-comparison-scroll-vertical></div><div data-comparison-scroll-horizontal></div></div>';
  document.body.append(panel);
  const viewport = panel.querySelector<HTMLElement>('[data-comparison-viewport="agree"]')!, card = panel.querySelector<HTMLElement>('[data-msgid]')!;
  viewport.style.overflow = 'auto';
  dimensions(panel, { clientWidth: 800, offsetWidth: 800, clientHeight: 400, offsetHeight: 400, scrollWidth: 800, scrollHeight: 400 });
  dimensions(viewport, { clientWidth: 400, offsetWidth: 400, clientHeight: 300, offsetHeight: 300, scrollWidth: 4000, scrollHeight: 5000 });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 800 * scale, 400 * scale));
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 120, 400 * scale, 300 * scale));
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(
    20 + (1700 - viewport.scrollLeft) * scale, 120 + (2400 - viewport.scrollTop) * scale, 200 * scale, 80 * scale));
  const dependencies = navigation(panel), completed = vi.fn();
  scrollMsgToCenter(dependencies, 'join-record', { onComplete: completed });
  vi.advanceTimersByTime(150);
  for (const target of panel.querySelectorAll<HTMLElement>('[data-comparison-viewport], [data-comparison-scroll-vertical]')) expect(target.scrollTop).toBeCloseTo(2290);
  for (const target of panel.querySelectorAll<HTMLElement>('[data-comparison-viewport], [data-comparison-scroll-horizontal]')) expect(target.scrollLeft).toBeCloseTo(1600);
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
  expect(panel.scrollTop).toBe(990);
  const lateMeasurement = tasks.begin('measurement');
  cardTop = 2400;
  vi.advanceTimersByTime(100);
  expect(dependencies.showMessagePulse).not.toHaveBeenCalled();
  lateMeasurement.release();
  vi.advanceTimersByTime(200);
  expect(panel.scrollTop).toBe(2190);
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
