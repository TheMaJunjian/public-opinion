import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSceneComputation, type SceneComputationRequest } from '../hooks/useSceneComputation';
import { planMessageStructures } from '../utils/messageStructurePlan';
import { computeSceneLayout } from '../utils/frameLayout';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import type { DemoMessage } from '../utils/modelBridge';
import {useMessageWindow} from '../hooks/useMessageWindow';
import WorkbenchLoadingBoundary,{useWorkbenchLoadingProgress} from '../components/WorkbenchLoadingBoundary';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage!: (event: MessageEvent) => void;
  onerror!: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  finish(request: SceneComputationRequest) {
    const result=request.job.kind==='structures'?planMessageStructures(request.job.input):computeSceneLayout(request.job.input);
    this.onmessage({ data: { id: request.id, result } } as MessageEvent);
  }
}
const job = (id: string) => ({ kind: 'structures' as const, input: {
  messages: [{ id, kind: 'normal', author: 'test', content: id, createdAt: '' } satisfies DemoMessage], edges: [],
} });
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; });

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
    useWorkbenchLoadingProgress(false,null,scope);
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
  act(()=>worker.finish(worker.postMessage.mock.calls[1][0]));
  expect(screen.getByTestId('m')).toBe(card);
  view.rerender(<WorkbenchLoadingBoundary><Window input={job('child')} scope="child"/></WorkbenchLoadingBoundary>);
  expect(screen.queryByTestId('m')).toBeNull();expect(card.isConnected).toBe(false);
  act(()=>worker.finish(worker.postMessage.mock.calls[2][0]));
  expect(screen.getByTestId('child')).toHaveTextContent('child');
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
  expect(worker.postMessage.mock.calls[1][0].job).toBe(third);
  act(() => worker.finish(worker.postMessage.mock.calls[1][0]));
  expect(result.current?.order).toEqual(['latest']);
  expect(tasks.pending).toBe(0);
  unmount(); expect(worker.terminate).toHaveBeenCalledOnce();
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
