import {act,renderHook} from '@testing-library/react';
import {describe,it,expect} from 'vitest';
import {useReadingQueue} from '../hooks/useReadingQueue';
import {nextReadingVisit,type ReadingTask} from '../pages/workbench/model/readingTasks';
const task=(id:string):ReadingTask=>({key:id,destinationId:id,targetId:id,kind:'body',reason:'正文未读',location:'inside',createdAt:''});
describe('per-view reading sessions',()=>{
  it('previews the next pending visit after excluding all tasks in the current group and wraps when needed',()=>{
    const visits=['A','B','C','D'].map(id=>({id,tasks:[task(id)]}));
    const queue={pending:visits,visits,position:2};
    expect(nextReadingVisit(queue,[task('A'),task('B')])?.id).toBe('C');
    expect(nextReadingVisit({...queue,position:4},[task('B'),task('C'),task('D')])?.id).toBe('A');
    expect(nextReadingVisit(queue,visits.flatMap(visit=>visit.tasks))).toBeUndefined();
  });
  it('uses a separate root-first navigation sequence even after every task is confirmed',()=>{
    const navigation=['root','older'];
    const view=renderHook(({tasks})=>useReadingQueue('root-first',tasks,true,navigation),{initialProps:{tasks:[task('older'),task('root')]}});
    act(()=>view.result.current.focus('root'));
    expect(view.result.current.focusId).toBe('root');
    expect(view.result.current.next?.id).toBe('older');
    view.rerender({tasks:[]});
    expect(view.result.current.pending).toEqual([]);
    expect(view.result.current.next?.id).toBe('older');
    act(()=>view.result.current.focus('older'));
    expect(view.result.current.previous?.id).toBe('root');
    expect(view.result.current.next).toBeUndefined();
    act(()=>view.result.current.focus('root'));
    expect(view.result.current.next?.id).toBe('older');
  });
  it('keeps already-read messages navigable on a fresh visit with no pending tasks',()=>{
    const view=renderHook(()=>useReadingQueue('already-read',[],true,['root','older']));
    act(()=>view.result.current.focus('root'));
    expect(view.result.current.next?.id).toBe('older');
    act(()=>view.result.current.focus('older'));
    expect(view.result.current.previous?.id).toBe('root');
    expect(view.result.current.current).toEqual([]);
  });
  it('retains an already-read starting message as the way back from the first pending visit',()=>{
    const view=renderHook(()=>useReadingQueue('read-start',[task('B')],true));
    act(()=>view.result.current.focus('A'));
    expect(view.result.current.next?.id).toBe('B');
    expect(view.result.current.pending.map(visit=>visit.id)).toEqual(['B']);
    act(()=>view.result.current.focus('B'));
    expect(view.result.current.previous).toEqual({id:'A',tasks:[]});
    act(()=>view.result.current.focus('A'));
    expect(view.result.current.current).toEqual([]);
    expect(view.result.current.next?.id).toBe('B');
  });
  it('keeps the already-read origin when pending tasks finish loading after it was focused',()=>{
    const view=renderHook(({ready,tasks})=>useReadingQueue('loading',tasks,ready),{initialProps:{ready:false,tasks:[] as ReadingTask[]}});
    act(()=>view.result.current.focus('A'));
    view.rerender({ready:true,tasks:[task('B')]});
    expect(view.result.current.next?.id).toBe('B');
    act(()=>view.result.current.focus('B'));
    expect(view.result.current.previous).toEqual({id:'A',tasks:[]});
  });
  it('keeps confirmed messages in manual navigation without moving the current visit',()=>{
    const view=renderHook(({tasks})=>useReadingQueue('scope',tasks,true),{initialProps:{tasks:[task('A'),task('B'),task('C')]}});
    act(()=>view.result.current.focus('A'));
    view.rerender({tasks:[task('A'),task('C')]});
    expect(view.result.current.focusId).toBe('A');expect(view.result.current.next?.id).toBe('B');
    act(()=>view.result.current.focus('C'));
    expect(view.result.current.previous?.id).toBe('B');
  });
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
