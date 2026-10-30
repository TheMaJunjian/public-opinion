import {act,fireEvent,render,screen,within} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import type {ReadingMark} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {MessageDisplayHintsProvider,MessageDisplayMarker} from '../components/MessageDisplayHints';
import TraceReadingController from '../components/TraceReadingController';
import {convertMessagesToDemoModel,computeCorrectionVersions} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {deriveDisplayHints} from '../pages/workbench/model/displayHints';
import {readingTasks,marksForReadingVisit} from '../pages/workbench/model/readingTasks';
import {deriveReadingProgress,readingMarksFor} from '../pages/workbench/model/readingProgress';

const writer={id:'writer',username:'writer',createdAt:''};
const text=(id:string):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:'2026-01-01',createdBy:writer});
const relation=(id:string,type:string,targets:string[],source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,
  targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdAt:'2026-01-02',createdBy:writer,payload:{}});
function fixture(marks:ReadingMark[]=[],extraMessages:Message[]=[],extraRelations:Relation[]=[]){
  const valuePayload={subjectId:'m',settlementType:'VALUE'},truthPayload={subjectId:'reason',settlementType:'TRUTH'};
  const rounds:Message[]=[
    {...text('value'),kind:'ROUND',targetRefs:[{kind:'message',messageId:'m'}],relationPayload:valuePayload},
    {...text('value-round'),kind:'ROUND',targetRefs:[{kind:'message',messageId:'value'}],relationPayload:valuePayload},
    {...text('truth-round'),kind:'ROUND',targetRefs:[{kind:'message',messageId:'reason'}],relationPayload:truthPayload},
  ];
  const relations=[relation('category','CLASSIFY',[]),relation('join','JOIN',['reason'],'category'),relation('archive','ARCHIVE',['m'],'reason'),
    relation('value','ROUND',['m']),relation('value-round','ROUND',['value']),relation('truth-round','ROUND',['reason']),...extraRelations];
  const model=convertMessagesToDemoModel([text('m'),text('reason'),...rounds,...extraMessages],relations);
  const personalEffect=deriveContainerEffect({...model,relations,username:'viewer',stakeCounts:{}});
  return {...model,relations,personalEffect,username:'viewer',readStatus:new Map<string,'READ'|'UNREAD'>(),marks,readingMarks:marks,
    corrections:computeCorrectionVersions(model.messages,model.edges)};
}
const scope=new Set(['m','reason','value']),allowed=new Set(['m','reason']);
const confirm=(input:ReturnType<typeof fixture>,id:string)=>readingMarksFor(input,id,deriveDisplayHints(input).hints.get(id)!.displayed);

describe('status records do not expand automatic trace reading',()=>{
  it('keeps join and arbitration effects at their affected messages without adding record visits',()=>{
    const input=fixture(),tasks=readingTasks(input,scope,allowed).tasks;
    expect(new Set(tasks.map(task=>task.destinationId))).toEqual(new Set(['m','reason']));
    expect(tasks.every(task=>task.location==='inside')).toBe(true);
    expect(tasks.filter(task=>task.influence?.messageId==='value-round')).toEqual([expect.objectContaining({destinationId:'m',targetId:'m'})]);
    expect(tasks.find(task=>task.influence?.messageId==='join')).toMatchObject({destinationId:'reason',targetId:'reason'});
    expect(tasks.find(task=>task.influence?.messageId==='truth-round')).toMatchObject({destinationId:'reason',targetId:'reason'});
  });
  it('does not reopen record bodies or their own effects after confirmation in the status window',()=>{
    const input=fixture(),marks=[...confirm(input,'m'),...confirm(input,'reason')],after=fixture(marks);
    const progress=deriveReadingProgress(after);
    expect(progress.pendingBodies.has('value')).toBe(true);
    expect(progress.pendingInfluences.get('value')?.some(item=>item.messageId==='value-round')).toBe(true);
    expect(readingTasks(after,scope,allowed).tasks).toEqual([]);
  });
  it('confirms the affected body and exact effects without silently reading the record bodies',()=>{
    const input=fixture(),tasks=readingTasks(input,scope,allowed).tasks.filter(task=>task.destinationId==='m');
    const displays=new Map([...deriveDisplayHints(input).hints].map(([id,hint])=>[id,hint.displayed]));
    const marks=marksForReadingVisit(input,tasks,displays),after=fixture(marks);
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m']);
    expect(deriveDisplayHints(after).hints.get('m')?.pendingInfluences).toEqual([]);
    expect(deriveDisplayHints(after).hints.get('reason')?.pendingInfluences.length).toBeGreaterThan(0);
    expect(new Set(readingTasks(after,scope,allowed).tasks.map(task=>task.destinationId))).toEqual(new Set(['reason']));
  });
  it.each(['value','join','archive'])('allows an explicitly opened %s record to keep its own reading progress',entry=>{
    const input=fixture(),ids=new Set(input.messages.map(message=>message.id));
    const tasks=readingTasks(input,new Set([entry]),ids,'both','discussion',undefined,undefined,new Set([entry])).tasks;
    expect(tasks.find(task=>task.kind==='body')).toMatchObject({destinationId:entry,location:'inside'});
    expect(tasks.filter(task=>task.kind==='influence').every(task=>task.destinationId===entry)).toBe(true);
    const displays=new Map([...deriveDisplayHints(input).hints].map(([id,hint])=>[id,hint.displayed]));
    const marks=marksForReadingVisit(input,tasks.filter(task=>task.destinationId===entry),displays);
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual([entry]);
    expect(deriveDisplayHints(fixture(marks)).hints.get(entry)?.unread).toBe(false);
    expect(deriveDisplayHints(fixture(marks)).hints.get('m')?.unread).toBe(true);
  });
  it('keeps a later settlement result pending at the affected message after earlier events were confirmed',()=>{
    const input=fixture(),marks=[...confirm(input,'m'),...confirm(input,'reason')];
    const result:Message={...text('later-result'),kind:'ROUND_RESULT',targetRefs:[{kind:'message',messageId:'m'}]};
    const later=fixture(marks,[result],[relation('later-result','ROUND_RESULT',['m'])]);
    const tasks=readingTasks(later,new Set([...scope,'later-result']),allowed).tasks;
    expect(tasks).toEqual([expect.objectContaining({destinationId:'m',targetId:'m',location:'inside',influence:expect.objectContaining({messageId:'later-result'})})]);
  });
  it.each(['outside','filtered'] as const)('retains an independent unread reply body that is %s',location=>{
    const input=fixture([], [text('reply-body')],[relation('reply','REPLY',['m'],'reply-body')]);
    const currentScope=new Set([...scope,...(location==='filtered'?['reply-body']:[])]);
    const tasks=readingTasks(input,currentScope,allowed).tasks;
    expect(tasks.find(task=>task.destinationId==='reply-body'&&task.influence?.messageId==='reply')).toMatchObject({location,targetId:'m'});
    expect(tasks.some(task=>['join','truth-round','value-round','value'].includes(task.destinationId))).toBe(false);
  });
  it('keeps a reply effect at its target once the separate source body has already been read',()=>{
    const records=[text('reply-body')],relations=[relation('reply','REPLY',['m'],'reply-body')],input=fixture([],records,relations);
    const marks=readingMarksFor(input,'reply-body',deriveDisplayHints(input).hints.get('reply-body')!.displayed,'message',{automaticInfluences:false});
    const tasks=readingTasks(fixture(marks,records,relations),scope,allowed).tasks;
    expect(tasks.find(task=>task.influence?.messageId==='reply'&&task.targetId==='m')).toMatchObject({destinationId:'m',location:'inside'});
    expect(tasks.some(task=>task.destinationId==='reply-body')).toBe(false);
  });
  it('retains the separate unread reply body after its effect was confirmed in the target status window',()=>{
    const records=[text('reply-body')],relations=[relation('reply','REPLY',['m'],'reply-body')],input=fixture([],records,relations);
    const after=fixture(confirm(input,'m'),records,relations),tasks=readingTasks(after,scope,allowed).tasks;
    expect(tasks.find(task=>task.destinationId==='reply-body')).toMatchObject({kind:'predecessor',location:'outside',targetId:'reply-body'});
    expect(tasks.some(task=>task.targetId==='m'&&task.influence?.messageId==='reply')).toBe(false);
    expect(deriveDisplayHints(after).hints.get('reply-body')?.unread).toBe(true);
  });
  it.each(['status','continue'] as const)('uses the %s confirmation without leaving extra record reminders',async action=>{
    const input=fixture(),save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    const element=(value:typeof input)=><MessageDisplayHintsProvider input={value} onView={vi.fn()} onMarkRead={save}>
      <MessageDisplayMarker messageId="m"/>
      <TraceReadingController scopeKey="status-records" scopeIds={scope} allowedIds={allowed} direction="both" order="discussion" onOrder={vi.fn()}
        path={['m'].map(id=>[id])} focusId="m" focusLocated incoming={[]} ready onNavigate={vi.fn(async()=>{})} onBack={vi.fn()}/>
    </MessageDisplayHintsProvider>;
    const view=render(element(input));
    expect(screen.queryByText('范围外及筛选隐藏的待阅内容')).toBeNull();
    if(action==='status'){
      fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
      const popup=within(screen.getByRole('tooltip')),influences=popup.getByRole('region',{name:'相关影响'});
      expect(influences).toHaveTextContent('结算 · 发起结算');
      await act(async()=>fireEvent.click(popup.getByRole('button',{name:'标记当前消息已阅'})));
    }else await act(async()=>fireEvent.click(screen.getByRole('button',{name:'已读并继续'})));
    const marks=save.mock.calls[0][0];
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m']);
    view.rerender(element(fixture(marks)));
    expect(screen.queryByText('范围外及筛选隐藏的待阅内容')).toBeNull();
    expect(within(screen.getByRole('region',{name:'追溯阅读'})).getByRole('button',{name:'已读并继续'})).toBeDisabled();
  });
});
