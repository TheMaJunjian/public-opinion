import { act, render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SendPreviewProgress from '../components/SendPreviewProgress';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';

it('shows a wait dialog for generation and sending, and releases it on completion',()=>{
  const view=render(<SendPreviewProgress phase="preparing" active={false}/>);
  expect(screen.getByRole('dialog',{name:'正在生成发送预览'})).toHaveTextContent('正在检查消息并生成预览');
  const backgroundScroll=new WheelEvent('wheel',{cancelable:true});window.dispatchEvent(backgroundScroll);expect(backgroundScroll.defaultPrevented).toBe(true);
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(screen.getByRole('dialog')).toBeInTheDocument();
  view.rerender(<SendPreviewProgress phase="idle" active/>);expect(screen.queryByRole('dialog')).toBeNull();
  const restoredScroll=new WheelEvent('wheel',{cancelable:true});window.dispatchEvent(restoredScroll);expect(restoredScroll.defaultPrevented).toBe(false);
  view.rerender(<SendPreviewProgress phase="sending" active/>);
  expect(screen.getByRole('dialog',{name:'正在发送'})).toHaveTextContent('请勿重复提交');
  view.rerender(<SendPreviewProgress phase="idle" active={false}/>);expect(screen.queryByRole('dialog')).toBeNull();
});

it('waits for preview layout without rerendering the workbench, and releases a failed drawing',()=>{
  const tasks=createWorkbenchDrawingTasks(),renderWorkbench=vi.fn();
  function Workbench(){renderWorkbench();return <WorkbenchDrawingContext.Provider value={tasks}><SendPreviewProgress phase="idle" active/></WorkbenchDrawingContext.Provider>;}
  render(<Workbench/>);expect(screen.queryByRole('dialog')).toBeNull();
  let task!:ReturnType<typeof tasks.begin>;act(()=>{task=tasks.begin('measurement');});
  expect(screen.getByRole('dialog',{name:'正在生成发送预览'})).toHaveTextContent('正在完成预览布局');
  act(()=>task.release());expect(screen.queryByRole('dialog')).toBeNull();
  act(()=>{task=tasks.begin('projection');});act(()=>task.fail(new Error('绘制失败')));
  expect(screen.queryByRole('dialog')).toBeNull();expect(renderWorkbench).toHaveBeenCalledOnce();
});
