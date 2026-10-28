import {describe,it,expect} from 'vitest';
import {bodyVersion,messageReadingKey,type ReadingMark} from '@gonglun/core';
import {discussionMessages as messages,discussionEdges as edges} from './discussion-fixture';
import {traceRange} from '../utils/traceRange';
import {readingTasks,marksForReadingVisit} from '../pages/workbench/model/readingTasks';
import {deriveReadingProgress} from '../pages/workbench/model/readingProgress';
import {deriveDisplayHints} from '../pages/workbench/model/displayHints';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';

const body=(id:string):ReadingMark=>({format:3,messageId:id,scope:'message',key:messageReadingKey(id),bodySignature:messageReadingKey(id),version:bodyVersion(id),state:'READ'});
const records=edges.map(edge=>({...messages[0],id:edge.relationMessageId,kind:'relation' as const,relationType:edge.relationType,content:'',createdAt:messages.find(message=>message.id===edge.from.messageId)!.createdAt}));
const all=[...messages,...records],allowed=new Set(all.map(message=>message.id));
const input=(marks:ReadingMark[]=[])=>({messages:all,edges,relations:[],marks,readStatus:new Map<string,'READ'|'UNREAD'>(),username:'viewer'});
describe('reading tasks by destination and affected target',()=>{
  it('uses different orders without changing the trace set',()=>{
    const scope=traceRange(all,edges,['B'],2,'both').ids;
    const values=input(['A','B','D'].map(body));
    const bodies=(order:'discussion'|'time')=>readingTasks(values,scope,allowed,'both',order).tasks.filter(task=>task.kind==='body'&&task.location==='inside').map(task=>task.destinationId);
    expect(bodies('discussion')).toEqual(['N','F','C']);expect(bodies('time')).toEqual(['C','F','N']);
  });
  it('merges the two reasons for E into one destination and preserves both reasons',()=>{
    const scope=traceRange(all,edges,['B'],2,'both').ids;
    const model=readingTasks(input(['A','B','D'].map(body)),scope,allowed);
    const e=model.tasks.filter(task=>task.destinationId==='E');
    expect(e.some(task=>task.kind==='predecessor')).toBe(true);
    expect(e.some(task=>task.kind==='influence'&&task.targetId==='C')).toBe(true);
    expect(e.every(task=>task.location==='outside')).toBe(true);
  });
  it('retains out-of-direction reminders even when all upstream bodies are read',()=>{
    const scope=traceRange(all,edges,['B'],2,'up').ids;
    const model=readingTasks(input(['A','B','D'].map(body)),scope,allowed,'up');
    expect(model.tasks.filter(task=>task.kind==='body')).toHaveLength(0);
    expect(model.tasks.find(task=>task.destinationId==='F')).toMatchObject({location:'outside',outsideReason:'不在当前追溯方向'});
  });
  it('reads N through D while leaving its effect on E and reply from P pending',()=>{
    const values=input(['A','B','D'].map(body)),scope=traceRange(all,edges,['B'],2,'both').ids;
    const tasks=readingTasks(values,scope,allowed).tasks.filter(task=>task.destinationId==='N'&&task.location==='inside'&&(task.kind==='body'||task.targetId==='D'));
    const effect=deriveContainerEffect({...values,stakeCounts:{}});
    const hints=deriveDisplayHints({...values,readingMarks:values.marks,personalEffect:effect,corrections:new Map()});
    const displays=new Map([...hints.hints].map(([id,hint])=>[id,hint.displayed]));
    const marks=marksForReadingVisit(values,tasks,displays),after=deriveReadingProgress(input([...values.marks,...marks]));
    expect(marks.filter(mark=>mark.scope==='message'&&mark.messageId==='N')).toHaveLength(1);
    expect(after.pendingBodies.has('N-D')).toBe(false);expect(after.pendingBodies.has('N-E')).toBe(true);
    expect(after.pendingBodies.has('N')).toBe(false);expect(after.pendingBodies.has('E')).toBe(true);
    expect(after.pendingInfluences.get('D')?.some(item=>item.messageId==='N-D')??false).toBe(false);
    expect(after.pendingInfluences.get('E')?.some(item=>item.messageId==='N-E')).toBe(true);
    expect(after.pendingInfluences.get('N')?.some(item=>item.messageId==='P-N')).toBe(true);
    const next=readingTasks(input([...values.marks,...marks]),traceRange(all,edges,['P'],2,'both').ids,allowed);
    expect(next.tasks.some(task=>task.destinationId==='N'&&task.targetId==='E'&&task.kind==='influence')).toBe(true);
  });
  it('keeps filtered tasks distinct from targets outside the semantic range',()=>{
    const scope=traceRange(all,edges,['B'],2,'both').ids;
    const tasks=readingTasks(input(),scope,new Set([...allowed].filter(id=>id!=='F'))).tasks;
    expect(tasks.find(task=>task.kind==='body'&&task.destinationId==='F')?.location).toBe('filtered');
    expect(tasks.find(task=>task.destinationId==='P')?.location).toBe('outside');
  });
});
