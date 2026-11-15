import {act,fireEvent,render} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {REVIEW_RECORD_RELATIONS,type ReadingMark} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {convertMessagesToDemoModel,computeCorrectionVersions,isReviewDiscussion} from '../utils/modelBridge';
import {readingTasks,marksForReadingVisit,type ReadingTask} from '../pages/workbench/model/readingTasks';
import {indexReadingStructure,readingNeighbors} from '../pages/workbench/model/readingStructure';
import {deriveDisplayHints} from '../pages/workbench/model/displayHints';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {MessageDisplayHintsProvider} from '../components/MessageDisplayHints';
import TraceReadingController from '../components/TraceReadingController';

const writer={id:'writer',username:'writer',createdAt:''};
const text=(id:string):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:'2026-01-01',createdBy:writer});
const relation=(id:string,type:string,target:string,source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,
  targetRefs:[{kind:'message',messageId:target}],createdAt:'2026-01-02',createdBy:writer,payload:{}});
const reviews=[...REVIEW_RECORD_RELATIONS,'review_record'].map(type=>relation(`audit-${type}`,type.toUpperCase(),'current'));
const records:Message[]=[text('current'),text('next'),...['review-context','review'].map(type=>({...text(`native-${type}`),parts:[
  {id:'body',type:'text' as const,text:'审核讨论正文'},
  {id:'review',type:'relation' as const,relation:type,roles:{target:[{id:'target',reference:{messageId:'current'}}]}},
]}))];
const relations=[...reviews,relation('review-reply','REPLY','current','native-review-context'),
  relation('review-reference','REFERENCE','native-review-context','current'),relation('next-reply','REPLY','current','next')];
const model=convertMessagesToDemoModel(records,relations);
const reviewIds=model.messages.filter(isReviewDiscussion).map(message=>message.id);
const scope=new Set(['current','next',...reviewIds]);
const input={...model,relations,username:'viewer',readStatus:new Map<string,'READ'|'UNREAD'>(),readingMarks:[] as ReadingMark[],
  personalEffect:deriveContainerEffect({...model,relations,username:'viewer',stakeCounts:{}}),
  corrections:computeCorrectionVersions(model.messages,model.edges)};

it.each(['inside','outside','filtered'] as const)('excludes review records and review discussion bodies from reading destinations (%s)',location=>{
  expect(reviewIds).toHaveLength(reviews.length+2);
  const limited=new Set(['current','next']);
  const result=readingTasks(input,location==='outside'?limited:scope,location==='filtered'?limited:scope,
    'both','discussion',undefined,undefined,scope);
  expect(new Set(result.navigationIds)).toEqual(limited);
  expect(result.tasks.length).toBeGreaterThan(0);
  expect(result.tasks.every(task=>!reviewIds.includes(task.destinationId))).toBe(true);
  const displays=new Map([...deriveDisplayHints(input).hints].map(([id,hint])=>[id,hint.displayed]));
  const marks=marksForReadingVisit(input,result.tasks.filter(task=>task.destinationId==='current'),displays);
  expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['current']);
});

it('keeps review records and their discussion out of directional reading neighbors',()=>{
  const neighbors=readingNeighbors(indexReadingStructure(model.messages,model.edges),['current']);
  expect(neighbors.up).toEqual([]);
  expect(neighbors.peer).toEqual([]);
  expect(neighbors.down.map(item=>item.id)).toEqual(['next']);
});

const staleReviewTask:ReadingTask={key:'stale-review',destinationId:'native-review-context',targetId:'native-review-context',
  kind:'body',reason:'正文未读',location:'inside',createdAt:'2026-01-01'};
it.each(['下一条','已读并继续'])('previews and opens the next ordinary message with %s, even with an incoming review task',async action=>{
  const navigate=vi.fn<(id:string)=>Promise<void>>(async()=>{}),save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{}),markers=vi.fn();
  const view=render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={save}>
    <TraceReadingController scopeKey="review-next" scopeIds={scope} allowedIds={scope} direction="both" order="discussion" onOrder={vi.fn()}
      placementOrder={['current',...reviewIds,'next']} path={[[...scope]]} focusId="current" focusLocated incoming={[staleReviewTask]} ready
      onNavigationChange={markers} onNavigate={navigate} onBack={vi.fn()}/>
  </MessageDisplayHintsProvider>);
  expect(markers.mock.lastCall?.[0].continue).toBe('next');
  expect(view.container.querySelector('[data-reading-continue-target]')).toHaveTextContent('next');
  await act(async()=>fireEvent.click(view.getByRole('button',{name:action})));
  expect(navigate.mock.lastCall?.[0]).toBe('next');
  if(action==='下一条')expect(save).not.toHaveBeenCalled();
  else expect(save.mock.lastCall?.[0].filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['current']);
});

it('ends automatic reading when only review messages remain',()=>{
  const ids=new Set(['current',...reviewIds]),navigate=vi.fn(async()=>{});
  const view=render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={vi.fn(async()=>{})}>
    <TraceReadingController scopeKey="review-only" scopeIds={ids} allowedIds={ids} direction="both" order="discussion" onOrder={vi.fn()}
      path={[[...ids]]} focusId="current" focusLocated incoming={[]} ready onNavigate={navigate} onBack={vi.fn()}/>
  </MessageDisplayHintsProvider>);
  expect(view.getByRole('button',{name:'下一条'})).toBeDisabled();
  expect(view.queryByRole('button',{name:'已读并继续'})).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});
