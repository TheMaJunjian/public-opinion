import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSceneComputation, type SceneComputationRequest } from '../hooks/useSceneComputation';
import { planMessageStructures } from '../utils/messageStructurePlan';
import { computeSceneLayout } from '../utils/frameLayout';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import type { DemoMessage } from '../utils/modelBridge';
import {useMessageWindow} from '../hooks/useMessageWindow';
import WorkbenchLoadingBoundary,{useWorkbenchLoadingProgress} from '../components/WorkbenchLoadingBoundary';
import { createSceneRequestDecoder } from '../utils/sceneComputationTransport';
import RecentWorkbenchViews from '../components/RecentWorkbenchViews';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage!: (event: MessageEvent) => void;
  onerror!: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  decode = createSceneRequestDecoder();
  finish(request: SceneComputationRequest) {
    const job = this.decode(request);
    const result=job.kind==='structures'?planMessageStructures(job.input):computeSceneLayout(job.input);
    this.onmessage({ data: { id: request.id, result } } as MessageEvent);
  }
}
const job = (id: string) => ({ kind: 'structures' as const, input: {
  messages: [{ id, kind: 'normal', author: 'test', content: id, createdAt: '' } satisfies DemoMessage], edges: [],
} });
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; });

it('finishes work after a cached scene is parked and resumed repeatedly', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const tasks = createWorkbenchDrawingTasks();
  const inputs = { A: job('a'), B: job('b') };
  function Scene({ id }: { id: 'A' | 'B' }) {
    const result = useSceneComputation(inputs[id], true, id);
    return <div data-testid="scene">{result?.order.join(',') ?? 'waiting'}</div>;
  }
  const element = (id: 'A' | 'B') => <WorkbenchDrawingContext.Provider value={tasks}>
    <RecentWorkbenchViews viewKey={id}><Scene id={id} /></RecentWorkbenchViews>
  </WorkbenchDrawingContext.Provider>;
  const view = render(element('A'));
  act(() => FakeWorker.instances[0].finish(FakeWorker.instances[0].postMessage.mock.calls[0][0]));
  expect(tasks.pending).toBe(0);
  view.rerender(element('B'));
  act(() => FakeWorker.instances[1].finish(FakeWorker.instances[1].postMessage.mock.calls[0][0]));
  for (let n = 0; n < 6; n++) {
    view.rerender(element('A'));
    expect(screen.getByTestId('scene')).toHaveTextContent('a');
    expect(tasks.pending).toBe(0);
    view.rerender(element('B'));
    expect(screen.getByTestId('scene')).toHaveTextContent('b');
    expect(tasks.pending).toBe(0);
  }
});

it('reuses a completed layout for equal restored inputs and recomputes changed message data',()=>{
  vi.stubGlobal('Worker',FakeWorker);
  const original=job('m'),view=renderHook(({input})=>useSceneComputation(input),{initialProps:{input:original}}),worker=FakeWorker.instances[0];
  act(()=>worker.finish(worker.postMessage.mock.calls[0][0]));const completed=view.result.current;
  view.rerender({input:structuredClone(original)});
  expect(worker.postMessage).toHaveBeenCalledOnce();expect(view.result.current).toBe(completed);
  const next={...original,input:{...original.input,messages:[...original.input.messages,{...original.input.messages[0],id:'new'}]}};
  view.rerender({input:next});expect(worker.postMessage).toHaveBeenCalledTimes(2);
  act(()=>worker.finish(worker.postMessage.mock.calls[1][0]));expect(view.result.current?.order).toEqual(['m','new']);
});

it('promotes preview metadata to committed data without another scene computation, but recomputes a changed chronology',()=>{
  vi.stubGlobal('Worker',FakeWorker);
  const input={kind:'structures' as const,input:{messages:[
    {id:'old',kind:'normal' as const,author:'test',content:'已有消息',createdAt:'2026-10-31T01:00:00Z',sequence:1},
    {id:'new',kind:'normal' as const,author:'test',content:'预览消息',createdAt:'2026-10-31T02:00:00Z',sequence:3},
  ],edges:[]}};
  const view=renderHook(({input})=>useSceneComputation(input),{initialProps:{input}}),worker=FakeWorker.instances[0];
  act(()=>worker.finish(worker.postMessage.mock.calls[0][0])); const complete=view.result.current;
  view.rerender({input:{...input,input:{...input.input,messages:[input.input.messages[0],{...input.input.messages[1],createdAt:'2026-10-31T03:00:00Z',sequence:5}]}}});
  expect(worker.postMessage).toHaveBeenCalledOnce();expect(view.result.current).toBe(complete);
  view.rerender({input:{...input,input:{...input.input,messages:[input.input.messages[0],{...input.input.messages[1],createdAt:'2026-10-30T03:00:00Z',sequence:5}]}}});
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
});

it('updates visible body text without a structure job and retains the previous scene during a real structure update',async()=>{
  vi.stubGlobal('Worker',FakeWorker);
  function Window({input,scope}:{input:ReturnType<typeof job>;scope:string}){
    useWorkbenchLoadingProgress(false,null);
    const window=useMessageWindow(input.input.messages,input.input.edges,true,scope,[]);
    return <>{window.messages.map(message=><div key={message.id} data-testid={message.id}>{message.content}</div>)}</>;
  }
  const first=job('m'),view=render(<WorkbenchLoadingBoundary><Window input={first} scope="root"/></WorkbenchLoadingBoundary>),worker=FakeWorker.instances[0];
  act(()=>worker.finish(worker.postMessage.mock.calls[0][0]));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  const card=screen.getByTestId('m'),next={...first,input:{...first.input,messages:[{...first.input.messages[0],content:'更正版本'}]}};
  view.rerender(<WorkbenchLoadingBoundary><Window input={next} scope="root"/></WorkbenchLoadingBoundary>);
  expect(screen.getByTestId('m')).toBe(card);expect(card).toHaveTextContent('更正版本');expect(screen.queryByRole('dialog')).toBeNull();
  expect(worker.postMessage).toHaveBeenCalledOnce();
  const added={...next,input:{...next.input,messages:[...next.input.messages,{...next.input.messages[0],id:'second'}]}};
  view.rerender(<WorkbenchLoadingBoundary><Window input={added} scope="root"/></WorkbenchLoadingBoundary>);
  expect(screen.getByTestId('m')).toBe(card);
  expect(screen.queryByRole('dialog')).toBeNull();
  act(()=>worker.finish(worker.postMessage.mock.calls[1][0]));
  expect(screen.getByTestId('m')).toBe(card);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<WorkbenchLoadingBoundary><Window input={job('child')} scope="child"/></WorkbenchLoadingBoundary>);
  expect(screen.queryByTestId('m')).toBeNull();expect(card.isConnected).toBe(false);
  expect(screen.getByRole('dialog',{name:'正在加载消息'})).toBeInTheDocument();
  act(()=>worker.finish(worker.postMessage.mock.calls[2][0]));
  expect(screen.getByTestId('child')).toHaveTextContent('child');
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  view.unmount();
});

it('reuses measured layout for body changes and recalculates only after a card changes size',()=>{
  vi.stubGlobal('Worker',FakeWorker);
  const messages:DemoMessage[]=['a','b'].map(id=>({id,kind:'normal',author:'test',content:'原正文',createdAt:'',revision:1,parts:[{id:'body',type:'text',text:'原正文'}]}));
  const input={kind:'layout' as const,input:{normals:messages,allMessages:messages,colOf:{a:0,b:0},maxCol:0,measuredHeights:{a:100,b:100},measuredWidths:{a:320,b:320}}};
  const view=renderHook(({input})=>useSceneComputation(input),{initialProps:{input}}),worker=FakeWorker.instances[0];
  act(()=>worker.finish(worker.postMessage.mock.calls[0][0]));const layout=view.result.current;
  const edited=messages.map(message=>({...message,content:'新正文',revision:2,parts:[{id:'body',type:'text' as const,text:'新正文'}]}));
  const next={...input,input:{...input.input,normals:edited,allMessages:edited}};
  view.rerender({input:next});expect(worker.postMessage).toHaveBeenCalledOnce();expect(view.result.current).toBe(layout);
  view.rerender({input:{...next,input:{...next.input,measuredHeights:{a:400,b:100}}}});
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  act(()=>worker.finish(worker.postMessage.mock.calls[1][0]));expect(view.result.current!.layout.b.y).toBeGreaterThan(layout!.layout.b.y);
});

it('recomputes structural visibility when clearing the readable body of an annotation',()=>{
  vi.stubGlobal('Worker',FakeWorker);
  const input={kind:'structures' as const,input:{messages:[{id:'annotation',kind:'relation' as const,relationType:'annotation' as const,author:'test',content:'注释',createdAt:'',parts:[{id:'body',type:'text' as const,text:'注释'}]}],edges:[]}};
  const view=renderHook(({input})=>useSceneComputation(input),{initialProps:{input}}),worker=FakeWorker.instances[0];
  act(()=>worker.finish(worker.postMessage.mock.calls[0][0]));
  view.rerender({input:{...input,input:{...input.input,messages:[{...input.input.messages[0],content:'',parts:[{id:'body',type:'text',text:''}]}]}}});
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
});

it('coalesces repeated measurements into one geometry update against the last transmitted input', () => {
  vi.stubGlobal('Worker',FakeWorker);
  const messages=job('a').input.messages.concat(job('b').input.messages);
  const first={kind:'layout' as const,input:{normals:messages,allMessages:messages,colOf:{a:0,b:0},maxCol:0,
    measuredHeights:{a:100,b:100},measuredWidths:{}}};
  const view=renderHook(({input})=>useSceneComputation(input),{initialProps:{input:first}});
  const worker=FakeWorker.instances[0], request=worker.postMessage.mock.calls[0][0];
  view.rerender({input:{...first,input:{...first.input,measuredHeights:{a:300,b:100}}}});
  const final={...first,input:{...first.input,measuredHeights:{a:600,b:100}}};
  view.rerender({input:final});
  expect(worker.postMessage).toHaveBeenCalledOnce();
  act(()=>worker.finish(request));
  const update=worker.postMessage.mock.calls[1][0];
  expect(update.patch).toEqual({baseId:request.id,input:{measuredHeights:{a:600,b:100}},removed:[]});
  act(()=>worker.finish(update));
  expect(view.result.current).toEqual(computeSceneLayout(final.input));
});

it('runs one job at a time, skips superseded requests and never publishes stale scope results', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const tasks = createWorkbenchDrawingTasks(); tasks.setBlocking(false);
  const first = job('old'), second = job('intermediate'), third = job('latest');
  const { result, rerender, unmount } = renderHook(({ input }) => useSceneComputation(input), {
    initialProps: { input: first }, wrapper: ({ children }) => <WorkbenchDrawingContext.Provider value={tasks}>{children}</WorkbenchDrawingContext.Provider>,
  });
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  rerender({ input: second }); rerender({ input: third });
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  act(() => worker.finish(worker.postMessage.mock.calls[0][0]));
  expect(result.current).toBeNull();
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(worker.postMessage.mock.calls[1][0].job.input.messages.map((message: DemoMessage) => message.id)).toEqual(['latest']);
  act(() => worker.finish(worker.postMessage.mock.calls[1][0]));
  expect(result.current?.order).toEqual(['latest']);
  expect(tasks.pending).toBe(0);
  unmount(); expect(worker.terminate).toHaveBeenCalledOnce();
});

it('starts an opened classification immediately instead of waiting for an obsolete scope job', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const first = job('root-message'), child = job('classification-message');
  const view = renderHook(({ input, scope }) => useSceneComputation(input, true, scope), {
    initialProps: { input: first, scope: 'root' },
  });
  const oldWorker = FakeWorker.instances[0], oldRequest = oldWorker.postMessage.mock.calls[0][0];
  view.rerender({ input: child, scope: 'classification' });
  expect(oldWorker.terminate).toHaveBeenCalledOnce();
  const currentWorker = FakeWorker.instances[1];
  expect(currentWorker.postMessage).toHaveBeenCalledOnce();
  expect(currentWorker.postMessage.mock.calls[0][0].job.input.messages.map((message: DemoMessage) => message.id)).toEqual(['classification-message']);
  act(() => oldWorker.finish(oldRequest));
  expect(view.result.current).toBeNull();
  act(() => currentWorker.finish(currentWorker.postMessage.mock.calls[0][0]));
  expect(view.result.current?.order).toEqual(['classification-message']);
});

it('falls back locally when the worker cannot run and releases its drawing ticket', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const tasks = createWorkbenchDrawingTasks(); tasks.setBlocking(false);
  const input = job('fallback');
  const { result, unmount } = renderHook(() => useSceneComputation(input), {
    wrapper: ({ children }) => <WorkbenchDrawingContext.Provider value={tasks}>{children}</WorkbenchDrawingContext.Provider>,
  });
  const worker = FakeWorker.instances[0];
  act(() => worker.onerror());
  expect(result.current?.order).toEqual(['fallback']);
  expect(tasks.pending).toBe(0);
  expect(worker.terminate).toHaveBeenCalledOnce();
  unmount();
});

it.each(['missing', 'startup', 'runtime'] as const)('uses the graph-owned synchronous layout fallback when the worker is %s', failure => {
  if (failure === 'missing') vi.stubGlobal('Worker', undefined);
  else if (failure === 'startup') vi.stubGlobal('Worker', class { constructor() { throw new Error('Worker unavailable'); } });
  else vi.stubGlobal('Worker', FakeWorker);
  const tasks = createWorkbenchDrawingTasks(); tasks.setBlocking(false);
  const messages = job('local-layout').input.messages;
  const input = { kind: 'layout' as const, input: { normals: messages, allMessages: messages, colOf: {}, maxCol: 0, measuredWidths: {}, measuredHeights: {} } };
  const layoutComputer = vi.fn(computeSceneLayout);
  const { result, unmount } = renderHook(() => useSceneComputation(input, true, undefined, layoutComputer), {
    wrapper: ({ children }) => <WorkbenchDrawingContext.Provider value={tasks}>{children}</WorkbenchDrawingContext.Provider>,
  });
  if (failure === 'runtime') {
    expect(layoutComputer).not.toHaveBeenCalled();
    act(() => FakeWorker.instances[0].onerror());
  }
  expect(result.current).toEqual(computeSceneLayout(input.input));
  expect(layoutComputer).toHaveBeenCalledOnce();
  expect(tasks.pending).toBe(0);
  unmount();
});

it('keeps the default structure fallback synchronous without a graph layout import', () => {
  vi.stubGlobal('Worker', undefined);
  const input = job('local-structure');
  const { result } = renderHook(() => useSceneComputation(input));
  expect(result.current?.order).toEqual(['local-structure']);
});

it('does not run the injected graph calculator while the worker succeeds', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const messages = job('worker-layout').input.messages;
  const input = { kind: 'layout' as const, input: { normals: messages, allMessages: messages, colOf: {}, maxCol: 0, measuredWidths: {}, measuredHeights: {} } };
  const layoutComputer = vi.fn(computeSceneLayout);
  const { result } = renderHook(() => useSceneComputation(input, false, undefined, layoutComputer));
  const worker = FakeWorker.instances[0];
  act(() => worker.finish(worker.postMessage.mock.calls[0][0]));
  expect(result.current?.layout['worker-layout']).toBeDefined();
  expect(layoutComputer).not.toHaveBeenCalled();
});

it('reports worker computation errors through drawing failure instead of waiting indefinitely', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const tasks = createWorkbenchDrawingTasks(); tasks.setBlocking(false);
  const input = job('broken');
  const { unmount } = renderHook(() => useSceneComputation(input), {
    wrapper: ({ children }) => <WorkbenchDrawingContext.Provider value={tasks}>{children}</WorkbenchDrawingContext.Provider>,
  });
  const worker = FakeWorker.instances[0], request = worker.postMessage.mock.calls[0][0];
  act(() => worker.onmessage({ data: { id: request.id, error: '计算失败' } } as MessageEvent));
  expect(tasks.failure?.reason).toBe('error');
  expect(tasks.pending).toBe(0);
  unmount();
});
