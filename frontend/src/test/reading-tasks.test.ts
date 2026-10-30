import {describe,it,expect} from 'vitest';
import {bodyVersion,messageReadingKey,type ReadingMark} from '@gonglun/core';
import {discussionMessages as messages,discussionEdges as edges} from './discussion-fixture';
import {traceRange} from '../utils/traceRange';
import {buildTraceProjection} from '../utils/traceProjection';
import {readingTasks,marksForReadingVisit,type ReadingOrder} from '../pages/workbench/model/readingTasks';
import {deriveReadingProgress} from '../pages/workbench/model/readingProgress';
import {deriveDisplayHints} from '../pages/workbench/model/displayHints';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import type {DemoMessage,DemoEdge} from '../utils/modelBridge';

const body=(id:string):ReadingMark=>({format:3,messageId:id,scope:'message',key:messageReadingKey(id),bodySignature:messageReadingKey(id),version:bodyVersion(id),state:'READ'});
const records=edges.map(edge=>({...messages[0],id:edge.relationMessageId,kind:'relation' as const,relationType:edge.relationType,content:'',createdAt:messages.find(message=>message.id===edge.from.messageId)!.createdAt}));
const all=[...messages,...records],allowed=new Set(all.map(message=>message.id));
const input=(marks:ReadingMark[]=[])=>({messages:all,edges,relations:[],marks,readStatus:new Map<string,'READ'|'UNREAD'>(),username:'viewer'});
describe('reading tasks by destination and affected target',()=>{
  it.each(['discussion','breadth','time'] as const)('keeps a fully read trace source first and its older reference target navigable in %s order',order=>{
    const messages:DemoMessage[]=[{id:'root',kind:'normal',content:'测试1',author:'writer',createdAt:'2026-10-12'},
      {id:'older',kind:'normal',content:'2222',author:'writer',createdAt:'2026-08-15'},
      {id:'reference',kind:'relation',relationType:'reference',content:'',author:'writer',createdAt:'2026-10-26'}];
    const edge:DemoEdge={id:'reference',relationMessageId:'reference',relationType:'reference',relationLabel:'引用',
      from:{messageId:'root',selection:{kind:'whole'}},to:{messageId:'older',selection:{kind:'whole'}}};
    const values={messages,edges:[edge],relations:[],marks:['root','older'].map(body),readStatus:new Map<string,'READ'|'UNREAD'>(),username:'viewer'};
    const ids=new Set(messages.map(message=>message.id));
    const model=readingTasks(values,ids,ids,'both',order,undefined,undefined,new Set(['root']));
    expect(model.navigationIds).toEqual(['root','older']);
    expect(model.tasks.some(task=>task.kind==='body')).toBe(false);
  });
  it('reads bodyless votes and annotations with their host instead of separate navigation steps',()=>{
    const hosts:DemoMessage[]=['host','next'].map(id=>({id,kind:'normal',content:id,author:'writer',createdAt:''}));
    const links:DemoEdge[]=(['agree','disagree','tag'] as const).map(type=>({id:type,relationMessageId:type,relationType:type,relationLabel:type,
      from:{messageId:`anon:${type}`,selection:{kind:'whole'}},to:{messageId:'host',selection:{kind:'whole'}}}));
    const messages:DemoMessage[]=[...hosts,...links.map(link=>({...hosts[0],id:link.id,kind:'relation' as const,relationType:link.relationType,content:''}))];
    const ids=new Set(messages.map(message=>message.id));
    const result=readingTasks({messages,edges:links,relations:[],marks:[],readStatus:new Map(),username:'viewer'},ids,ids);
    expect(result.tasks.filter(task=>task.kind==='influence')).toHaveLength(3);
    expect(result.tasks.filter(task=>task.kind==='influence').every(task=>task.destinationId==='host')).toBe(true);
    expect(new Set(result.tasks.map(task=>task.destinationId))).toEqual(new Set(['host','next']));
  });
  it('includes the selected classification members in reading tasks and retracts bodies beyond a reduced distance',()=>{
    const category={...messages[0],id:'category',kind:'relation' as const,relationType:'classify' as const};
    const membership={...edges[0],id:'category-B',relationMessageId:'category',relationType:'classify' as const,
      from:{...edges[0].from,messageId:'anon:category'},to:{...edges[0].to,messageId:'B'}};
    const values={...input(),messages:[...all,category],edges:[...edges,membership]},allowed=new Set(values.messages.map(message=>message.id));
    for(const depth of [0,2,1,0]){
      const projection=buildTraceProjection({...values,startIds:['category'],distance:depth,depths:{up:0,down:depth},expandedContainerIds:new Set(['category'])});
      const bodies=readingTasks(values,projection.semanticMessageIds!,allowed,'down').tasks.filter(task=>task.kind==='body'&&task.location==='inside').map(task=>task.destinationId);
      expect(bodies).toContain('B');expect(bodies.includes('D')).toBe(depth>=1);expect(bodies.includes('N')).toBe(depth>=2);
      expect(bodies).not.toContain('A');
    }
  });
  it.each(['up','down'] as const)('includes arrangement peers in %s reading scope and retracts them when distance shrinks',direction=>{
    const hosts:DemoMessage[]=['anchor','peer','before','after'].map(id=>({id,kind:'normal',content:id,author:'writer',createdAt:''}));
    const link=(owner:string,type:DemoEdge['relationType'],source:string,target:string):DemoEdge=>({id:owner+target,relationMessageId:owner,relationType:type,relationLabel:type,
      from:{messageId:source,selection:{kind:'whole'}},to:{messageId:target,selection:{kind:'whole'}}});
    const edges=[link('row','arrange','anon:row','anchor'),link('row','arrange','anon:row','peer'),
      link('up-reference','reference','peer','before'),link('down-reference','reference','after','peer')];
    const messages=[...hosts,...(['row','up-reference','down-reference'].map(id=>({...hosts[0],id,kind:'relation' as const,relationType:id==='row'?'arrange' as const:'reference' as const})))];
    const values={messages,edges,relations:[],marks:[],readStatus:new Map<string,'READ'|'UNREAD'>(),username:'viewer'},allowed=new Set(messages.map(message=>message.id));
    for(const distance of [0,2,1,0]){
      const depths={up:0,down:0,[direction]:distance};
      const projection=buildTraceProjection({...values,startIds:['anchor'],distance,depths});
      const bodies=readingTasks(values,projection.semanticMessageIds!,allowed,direction).tasks.filter(task=>task.kind==='body'&&task.location==='inside').map(task=>task.destinationId);
      expect(bodies.includes('peer')).toBe(distance>=1);
      expect(bodies.includes('before')).toBe(direction==='up'&&distance>=2);
      expect(bodies.includes('after')).toBe(direction==='down'&&distance>=2);
    }
  });
  it('uses different orders without changing the trace set',()=>{
    const scope=traceRange(all,edges,['B'],2,'both').ids;
    const values=input(['A','B','D'].map(body));
    const bodies=(order:'discussion'|'time')=>readingTasks(values,scope,allowed,'both',order).tasks.filter(task=>task.kind==='body'&&task.location==='inside').map(task=>task.destinationId);
    expect(bodies('discussion')).toEqual(['N','F','C']);expect(bodies('time')).toEqual(['C','F','N']);
  });
  it('switches depth, breadth and time while preserving all task identities, scope and progress',()=>{
    const scope=new Set(all.map(message=>message.id)),values=input();
    const models=(['discussion','breadth','time'] as ReadingOrder[]).map(order=>readingTasks(values,scope,allowed,'both',order));
    const bodies=models.map(model=>model.tasks.filter(task=>task.kind==='body'&&task.location==='inside').map(task=>task.destinationId));
    expect(bodies[0]).toEqual(['A','B','D','N','P','Q','F','C','E']);
    expect(bodies[1]).toEqual(['A','B','C','D','F','E','N','P','Q']);
    expect(bodies[2]).toEqual(['A','B','C','D','E','F','N','P','Q']);
    for(const model of models){
      expect(new Set(model.tasks.map(task=>task.key))).toEqual(new Set(models[0].tasks.map(task=>task.key)));
      expect(model.progress.pendingBodies).toEqual(models[0].progress.pendingBodies);
    }
    const overridden=readingTasks(values,scope,allowed,'both','breadth',bodies[0]);
    expect(overridden.tasks.filter(task=>task.kind==='body').map(task=>task.destinationId)).toEqual(bodies[1]);
    expect(values.marks).toEqual([]);
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
    expect(next.tasks.some(task=>task.destinationId==='E'&&task.targetId==='E'&&task.kind==='influence')).toBe(true);
  });
  it('keeps filtered tasks distinct from targets outside the semantic range',()=>{
    const scope=traceRange(all,edges,['B'],2,'both').ids;
    const tasks=readingTasks(input(),scope,new Set([...allowed].filter(id=>id!=='F'))).tasks;
    expect(tasks.find(task=>task.kind==='body'&&task.destinationId==='F')?.location).toBe('filtered');
    expect(tasks.find(task=>task.destinationId==='P')?.location).toBe('outside');
  });
});
