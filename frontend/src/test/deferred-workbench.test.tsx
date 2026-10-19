import { act, render, screen } from '@testing-library/react';
import { lazy } from 'react';
import { expect, it, vi } from 'vitest';
import DeferredWorkbench from '../components/DeferredWorkbench';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';

it('waits for the view module before declaring drawing complete, and releases on unmount',async()=>{
  const tasks=createWorkbenchDrawingTasks();
  let finish!:(module:{default:()=>React.JSX.Element})=>void;
  const module=new Promise<{default:()=>React.JSX.Element}>(resolve=>{finish=resolve;});
  const View=lazy(()=>module);
  const mounted=render(<WorkbenchDrawingContext.Provider value={tasks}><DeferredWorkbench label="消息画布" blocksDrawing><View /></DeferredWorkbench></WorkbenchDrawingContext.Provider>);
  expect(screen.getByRole('status').textContent).toContain('消息画布');
  expect(tasks.pending).toBe(1);
  await act(async()=>{finish({default:()=> <div>view ready</div>});await module;});
  expect(screen.getByText('view ready')).toBeTruthy();expect(tasks.pending).toBe(0);
  mounted.unmount();expect(tasks.pending).toBe(0);
});

it('reports module failure through the drawing boundary and keeps an error visible',async()=>{
  const tasks=createWorkbenchDrawingTasks(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
  const expectedError=(event:ErrorEvent)=>{if(event.error?.message==='module download failed')event.preventDefault();};
  window.addEventListener('error',expectedError);
  const View=lazy(()=>Promise.reject(new Error('module download failed')));
  try {
    render(<WorkbenchDrawingContext.Provider value={tasks}><DeferredWorkbench label="消息画布" blocksDrawing><View /></DeferredWorkbench></WorkbenchDrawingContext.Provider>);
    expect(await screen.findByText('module download failed')).toBeTruthy();
    expect(tasks.failure?.kind).toBe('render');expect(tasks.pending).toBe(0);
  } finally {log.mockRestore();window.removeEventListener('error',expectedError);}
});
