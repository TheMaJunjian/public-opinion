import {act,fireEvent,render,screen,within} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import type {ReadingMark} from '@gonglun/core';
import {bodyVersion,messageReadingKey} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {MessageDisplayHintsProvider,MessageDisplayMarker} from '../components/MessageDisplayHints';
import {computeCorrectionVersions,convertMessagesToDemoModel} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {deriveDisplayHints,type DisplayHintsInput} from '../pages/workbench/model/displayHints';
import {bodySignature,deriveReadingProgress,influenceReadingMarks,readingMarksFor} from '../pages/workbench/model/readingProgress';
import {applyReadingVersions,createReadingVersionHistory} from '../pages/workbench/model/readingVersions';
import {groupReadingInfluences} from '../pages/workbench/model/readingInfluenceGroups';
import {deriveHomeFilterResult} from '../pages/workbench/projections/homeFilterResult';

const user={id:'alice',username:'alice',createdAt:''};
const writer={id:'writer',username:'writer',createdAt:''};
const text=(id:string,content=id):Message=>({id,kind:'TEXT',content,contentType:'TEXT',createdAt:'2026-01-01',createdBy:writer});
const relation=(id:string,type:string,target:string,payload:Relation['payload']={},source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,targetRefs:[{kind:'message',messageId:target}],payload,createdAt:`2026-01-0${id.includes('2')?3:2}`,createdBy:writer});
const corrections=[relation('c1','CORRECT','m',{correctionBeforeContent:'原文',correctionAfterContent:'版本一'}),relation('c2','CORRECT','m',{correctionBeforeContent:'原文',correctionAfterContent:'版本二'})];
function fixture(relations:Relation[]=corrections,marks:ReadingMark[]=[],version='current'){
  const model=convertMessagesToDemoModel([text('m','原文'),text('x')],relations),personalEffect=deriveContainerEffect({...model,relations,username:'alice',stakeCounts:{}});
  const available=computeCorrectionVersions(model.messages,model.edges),history=createReadingVersionHistory();history.select('m',version);
  const displayCorrections=applyReadingVersions(available,history.getSnapshot(),model.messages);
  const input:DisplayHintsInput={...model,relations,personalEffect,corrections:available,displayCorrections,readingMarks:marks,username:'alice',readStatus:new Map()};
  const readingInput={...input,marks,corrections:displayCorrections,effectiveCorrections:available,memberships:personalEffect.memberships};
  const hints=deriveDisplayHints(input);
  const confirm=(id:string)=>readingMarksFor({...readingInput,displays:new Map([...hints.hints].map(([id,hint])=>[id,hint.displayed]))},id,hints.hints.get(id)!.displayed);
  return {input,readingInput,hints,confirm};
}

describe('shared reading status across display versions',()=>{
  const ready=(relations:Relation[]=corrections)=>{
    let marks=fixture(relations,[],'original').confirm('m');
    for(const id of relations.filter(item=>item.relationType==='CORRECT').map(item=>item.id))marks=[...marks,...fixture(relations,marks,'original').confirm(id)];
    const input=fixture(relations,marks).readingInput;
    return [...marks,...influenceReadingMarks('m',(deriveReadingProgress(input).pendingInfluences.get('m')??[]).filter(item=>item.type==='correct'))];
  };
  it('records original progress without marking the root or hidden correction bodies read',()=>{
    const original=fixture(corrections,[],'original'),marks=original.confirm('m');
    expect(marks).toHaveLength(1);expect(marks[0]).toMatchObject({messageId:'m',scope:'original',format:3});
    const after=fixture(corrections,marks);expect(after.hints.hints.get('m')).toMatchObject({unread:true,originalUnread:false,unreadCorrectionIds:['c1','c2']});
    expect(()=>after.confirm('m')).toThrow('请先阅读全部更正消息');
  });
  it('requires rejected and unadopted candidates too, then shares one root read across all displays',()=>{
    const relations=[...corrections,{...relation('oppose','DISAGREE','c1'),createdBy:{...user,id:'other',username:'other'}}];
    const marks=ready(relations),current=fixture(relations,marks),all=[...marks,...current.confirm('m')];
    for(const choice of ['original','c1','c2','current']){
      const result=fixture(relations,all,choice);expect(result.hints.hints.get('m')).toMatchObject({unread:false,otherVersionUnreadCount:0,otherVersionInfluenceCount:0});
      expect(deriveReadingProgress(result.readingInput).pendingBodies.has('m')).toBe(false);
    }
    expect(all.filter(item=>item.messageId==='m'&&item.scope==='message')).toHaveLength(1);
    expect(all.find(item=>item.messageId==='m'&&item.scope==='message')!.key).toBe(messageReadingKey('m'));
  });
  it('confirms stance effects across displays while retaining discussion and unread relationship bodies',()=>{
    const relations=[...corrections,relation('agree1','AGREE','c1'),relation('agree2','AGREE','c2'),relation('reply','REPLY','m')];
    const marks=ready(relations),all=[...marks,...fixture(relations,marks).confirm('m')];
    for(const choice of ['original','c1','c2'])expect(fixture(relations,all,choice).hints.hints.get('m')).toMatchObject({unread:false,relatedUnreadIds:['reply']});
    expect(all.some(mark=>['agree1','agree2','reply'].includes(mark.messageId)&&mark.scope==='message')).toBe(false);
  });
  it('new corrections and multi-round results add reminders without reopening the shared body',()=>{
    const marks=ready(),all=[...marks,...fixture(corrections,marks).confirm('m')];
    const newCorrection=relation('c3','CORRECT','m',{correctionBeforeContent:'原文',correctionAfterContent:'新一轮文字'});
    const later=fixture([...corrections,newCorrection],all),progress=deriveReadingProgress(later.readingInput);
    expect(progress.pendingBodies.has('m')).toBe(false);expect(progress.pendingBodies.has('c3')).toBe(true);expect(later.hints.hints.get('m')!.relatedUnreadIds).toContain('c3');
    const input={...later.readingInput,messages:[...later.readingInput.messages,{...later.readingInput.messages[0],id:'round2',kind:'round_result' as const,settlementTargetId:'m'}]};
    expect(deriveReadingProgress(input).pendingInfluences.get('m')!.some(item=>item.messageId==='round2')).toBe(true);
    expect(()=>later.confirm('m')).not.toThrow();
  });
  it('manual unread is shared and the first confirmation evidence permits re-reading after later changes',()=>{
    const marks=ready(),all=[...marks,...fixture(corrections,marks).confirm('m')],main=all.find(mark=>mark.messageId==='m'&&mark.scope==='message')!;
    const unread={...main,state:'UNREAD' as const,position:100,firstConfirmedAt:'2026-01-01'};
    for(const choice of ['original','c1','c2'])expect(fixture(corrections,[...all,unread],choice).hints.hints.get('m')!.unread).toBe(true);
    const c3=relation('c3','CORRECT','m',{correctionBeforeContent:'原文',correctionAfterContent:'后加'});
    expect(()=>fixture([...corrections,c3],[...all,unread]).confirm('m')).not.toThrow();
  });
  it('also propagates a WIDTH correction settlement result as a reminder on the already-read subject',()=>{
    const initial=fixture([],[]),marks=initial.confirm('m');
    const width=relation('width','CORRECT','m',{correctionKind:'WIDTH',correctionWidth:640}),later=fixture([width],marks);
    const result={...later.readingInput.messages[0],id:'width-result',kind:'round_result' as const,settlementTargetId:'width'};
    const progress=deriveReadingProgress({...later.readingInput,messages:[...later.readingInput.messages,result]});
    expect(progress.pendingBodies.has('m')).toBe(false);expect(progress.pendingInfluences.get('m')!.some(item=>item.messageId==='width-result')).toBe(true);
  });
  it('does not infer a shared read from old-format records without migration',()=>{
    const v=bodyVersion('m'),mark={messageId:'m',scope:'message' as const,key:'old',format:2 as const,version:v,state:'READ' as const};
    expect(fixture([], [mark]).hints.hints.get('m')!.unread).toBe(true);
  });
  it('uses one pending home status for the body and concrete new reminders',()=>{
    const marks=ready(),all=[...marks,...fixture(corrections,marks).confirm('m')];
    const result=fixture(corrections,all,'c1');
    const filter=deriveHomeFilterResult({...result.input,displayUser:user,msgMap:result.input.personalEffect.msgMap,readStatusByMessageId:new Map(),traceContainerMemberships:[],homeFilterMode:{scope:'all',status:'pending'}})!;
    expect(filter.matchIds.has('m')).toBe(false);
    const withReply=fixture([...corrections,relation('reply','REPLY','m')],all);
    expect(deriveReadingProgress(withReply.readingInput).confirmed('m')).toBe(false);expect(withReply.hints.hints.get('m')!.unread).toBe(false);
  });
  it('groups each stance and annotation independently and preserves concrete outgoing references',()=>{
    const relations=[relation('a1','AGREE','m'),relation('a2','AGREE','m'),relation('d','DISAGREE','m'),
      relation('t1','TAG','m',{label:'可靠'}),relation('t2','TAG','m',{label:'待核查'}),relation('r1','REFERENCE','x',{},'m'),relation('r2','REFERENCE','m',{},'x')];
    const before=fixture(relations),items=before.hints.hints.get('m')!.pendingInfluences,groups=groupReadingInfluences(items,before.input.personalEffect.msgMap);
    expect(new Set(groups.map(group=>group.label))).toEqual(new Set(['赞同','反对','标注「可靠」','标注「待核查」','引用','被引用']));
    const agree=groups.find(group=>group.label==='赞同')!;
    const marks=influenceReadingMarks('m',agree.items),after=fixture([...relations,relation('a3','AGREE','m')],marks);
    expect(after.hints.hints.get('m')?.relatedUnreadIds).not.toEqual(expect.arrayContaining(['a1','a2']));
    expect(after.hints.hints.get('m')?.relatedUnreadIds).toContain('a3');
    expect(after.hints.hints.get('m')?.relatedUnreadIds).toEqual(expect.arrayContaining(['d','t1','t2','r1','r2']));
    expect(marks).toHaveLength(2);expect(marks.every(mark=>mark.messageId==='m'&&mark.scope==='influence'&&mark.key==='agree:'&&!!mark.eventId)).toBe(true);
  });
  it('confirms votes, annotations and settlement effects from the single current-message button',async()=>{
    const relations=[relation('agree1','AGREE','m'),relation('agree2','AGREE','m'),relation('oppose','DISAGREE','m'),relation('tag','TAG','m',{label:'可靠'}),relation('reply','REPLY','m')];
    const base=fixture(relations),before={...base,input:{...base.input,messages:[...base.input.messages,
      {...base.input.messages[0],id:'start',kind:'round' as const,settlementTargetId:'m'},
      {...base.input.messages[0],id:'result',kind:'round_result' as const,settlementTargetId:'m'}]}},onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{}),onView=vi.fn();
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={onView} onMarkRead={onMarkRead}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(before.input));fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    const tooltip=screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('6 条影响待阅');
    const confirm=within(tooltip).getByRole('button',{name:'标记当前消息已阅'});
    expect(tooltip.querySelector('[data-display-hint-influences]')).toHaveStyle({scrollbarGutter:'stable',paddingRight:'6px',overflowX:'hidden'});
    for(const label of ['当前消息','赞同','反对','标注「可靠」','结算 · 发起结算','结算 · 结算结果'])expect(confirm.getAttribute('title')).toContain(label);
    expect(tooltip).not.toHaveTextContent('agree1');expect(tooltip).not.toHaveTextContent('agree2');expect(tooltip).not.toHaveTextContent('当前更正');
    expect(within(screen.getByRole('region',{name:'点击已阅将确认已读'})).getAllByRole('button',{name:'标记当前消息已阅'})).toHaveLength(1);
    await act(async()=>fireEvent.click(confirm));
    const marks=onMarkRead.mock.calls[0][0];
    expect(marks).toContainEqual(expect.objectContaining({messageId:'m',scope:'message'}));
    expect(new Set(marks.filter(mark=>mark.scope==='influence').map(mark=>JSON.parse(mark.eventId!)[0]))).toEqual(new Set(['agree1','agree2','oppose','tag','start','result']));
    expect(marks.some(mark=>['agree1','agree2','oppose','tag','reply'].includes(mark.messageId)&&mark.scope!=='influence')).toBe(false);
    expect(onView).not.toHaveBeenCalled();
    view.rerender(element({...before.input,readingMarks:onMarkRead.mock.calls[0][0]}));
    expect(screen.getByRole('tooltip')).toHaveTextContent('1 条影响待阅');expect(screen.queryByRole('button',{name:'标记赞同影响已阅'})).toBeNull();
    expect(screen.queryByRole('button',{name:'标记反对影响已阅'})).toBeNull();
    expect(onMarkRead).toHaveBeenCalledOnce();
    expect(within(screen.getByRole('region',{name:'需分别查看确认'})).queryByRole('button',{name:/已阅/})).toBeNull();
  });
  it('keeps start, result and termination as distinct settlement confirmations',()=>{
    const initial=fixture([relation('stop','PROPOSAL','m',{operationType:'TERMINATE_SETTLEMENT'})]);
    const messages=[...initial.readingInput.messages,
      {...initial.readingInput.messages[0],id:'start',kind:'round' as const,settlementTargetId:'m'},
      {...initial.readingInput.messages[0],id:'result',kind:'round_result' as const,settlementTargetId:'m'}];
    const input={...initial.readingInput,messages},progress=deriveReadingProgress(input),groups=groupReadingInfluences(progress.pendingInfluences.get('m')!,new Map(messages.map(message=>[message.id,message])));
    expect(groups.map(group=>group.label)).toEqual(['结算 · 终止结算','结算 · 发起结算','结算 · 结算结果']);
    const marks=influenceReadingMarks('m',groups[1].items),after=deriveReadingProgress({...input,marks});
    expect(new Set(after.pendingInfluences.get('m')?.map(item=>item.messageId))).toEqual(new Set(['stop','result']));
    expect(marks.some(mark=>mark.bodySignature===bodySignature('原文'))).toBe(false);
  });
});
