import {act,renderHook} from '@testing-library/react';
import {describe,it,expect} from 'vitest';
import {useReadingQueue} from '../hooks/useReadingQueue';
import type {ReadingTask} from '../pages/workbench/model/readingTasks';
const task=(id:string):ReadingTask=>({key:id,destinationId:id,targetId:id,kind:'body',reason:'正文未读',location:'inside',createdAt:''});
describe('per-view reading sessions',()=>{
  it('moves forward without confirming and returns to a visit after it is confirmed',()=>{
    const view=renderHook(({tasks})=>useReadingQueue('scope',tasks,true),{initialProps:{tasks:[task('A'),task('B'),task('C')]}});
    expect(view.result.current.next?.id).toBe('A');expect(view.result.current.previous).toBeUndefined();
    act(()=>view.result.current.focus('A'));
    expect(view.result.current.next?.id).toBe('B');
    act(()=>view.result.current.focus('B'));
    expect(view.result.current.pending.map(item=>item.id)).toEqual(['A','B','C']);
    expect(view.result.current.previous?.id).toBe('A');expect(view.result.current.next?.id).toBe('C');
    view.rerender({tasks:[task('A'),task('C')]});
    act(()=>view.result.current.focus('C'));
    expect(view.result.current.previous?.id).toBe('B');expect(view.result.current.next).toBeUndefined();
    act(()=>view.result.current.focus('B'));
    expect(view.result.current.current).toEqual([]);expect(view.result.current.next?.id).toBe('C');
    expect(view.result.current.position).toBe(2);expect(view.result.current.total).toBe(3);
  });
  it('allows an explicitly revealed filtered task into the current round without adopting other additions',()=>{
    const hidden:ReadingTask={...task('F'),location:'filtered'};
    const view=renderHook(({tasks})=>useReadingQueue('B',tasks,true),{initialProps:{tasks:[task('N'),hidden]}});
    act(()=>view.result.current.focus('N'));
    act(()=>view.result.current.enroll([hidden]));
    view.rerender({tasks:[task('N'),task('F'),task('H')]});
    act(()=>view.result.current.focus('F'));
    expect(view.result.current.pending.map(item=>item.id)).toEqual(['N','F']);
    expect(view.result.current.current.map(task=>task.key)).toEqual(['F']);
    expect(view.result.current.added.map(item=>item.id)).toEqual(['H']);
  });
  it('keeps new influences on the focused message out of the current confirmation until accepted',()=>{
    const body=task('N'),influence:ReadingTask={...task('new-reference'),destinationId:'N',kind:'influence'};
    const view=renderHook(({tasks})=>useReadingQueue('B',tasks,true),{initialProps:{tasks:[body]}});
    act(()=>view.result.current.focus('N'));
    view.rerender({tasks:[body,influence]});
    expect(view.result.current.added.flatMap(item=>item.tasks.map(task=>task.key))).toEqual(['new-reference']);
    expect(view.result.current.current.map(task=>task.key)).toEqual(['N']);
    act(()=>view.result.current.acceptNew());
    expect(view.result.current.current.map(task=>task.key)).toEqual(['N','new-reference']);
  });
  it('freezes the departing queue without replacing its focus with an outside destination',()=>{
    const view=renderHook(({key,tasks})=>useReadingQueue(key,tasks,true),{initialProps:{key:'B',tasks:[task('N'),task('F')]}});
    act(()=>view.result.current.focus('N'));
    act(()=>view.result.current.start());
    view.rerender({key:'P',tasks:[task('P')]});act(()=>view.result.current.focus('P'));
    view.rerender({key:'B',tasks:[task('H'),task('N'),task('F')]});
    expect(view.result.current.focusId).toBe('N');
    expect(view.result.current.pending.map(item=>item.id)).toEqual(['N','F']);
    expect(view.result.current.added.map(item=>item.id)).toEqual(['H']);
  });
  it('keeps live insertions separate and restores progress against shared completion',()=>{
    const view=renderHook(({key,tasks})=>useReadingQueue(key,tasks,true),{initialProps:{key:'B',tasks:[task('N'),task('F'),task('C')]}});
    act(()=>view.result.current.focus('N'));
    view.rerender({key:'B',tasks:[task('H'),task('F'),task('C')]});
    expect(view.result.current.pending.map(item=>item.id)).toEqual(['F','C']);expect(view.result.current.added.map(item=>item.id)).toEqual(['H']);
    view.rerender({key:'P',tasks:[task('P'),task('Q')]});act(()=>view.result.current.focus('Q'));
    view.rerender({key:'B',tasks:[task('C'),task('H')]});
    expect(view.result.current.focusId).toBe('N');expect(view.result.current.pending.map(item=>item.id)).toEqual(['C']);
    act(()=>view.result.current.acceptNew());expect(view.result.current.pending.map(item=>item.id)).toEqual(['C','H']);
  });
});
