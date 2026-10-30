import {describe,expect,it} from 'vitest';
import type {ReadingMark} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {convertMessagesToDemoModel,computeCorrectionVersions} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {deriveDisplayHints,getMessageDisplaySignature} from '../pages/workbench/model/displayHints';
import {authoredReadingMark,authoredReadingMarks,deriveReadingProgress,readingMarksFor,influenceReadingMarks} from '../pages/workbench/model/readingProgress';
import {bodyVersion,bodyVersionKey,messageReadingKey} from '@gonglun/core';
import {deriveHomeFilterResult} from '../pages/workbench/projections/homeFilterResult';
import {authoredReadingBackfill} from '../pages/workbench/model/authoredReadingBackfill';

const user={id:'alice',username:'alice',createdAt:''},other={id:'bob',username:'bob',createdAt:''};
const message=(id:string,author=other):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:'2026-01-01',createdBy:author});
const relation=(id:string,type:string,targets:string[],source:string|null=null,payload:Relation['payload']={}):Relation=>({id,relationType:type,sourceMessageId:source,
  targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdBy:other,createdAt:'2026-01-02',payload});
it('backfills historical author confirmations with exact events and preserves other bodies and explicit unread choices',()=>{
  const owned={...relation('old-reference','REFERENCE',['target'],'mine'),createdBy:user,sequence:30};
  const foreign={...relation('foreign','AGREE',['mine']),sequence:31};
  const input=fixture([{...message('mine',user),sequence:10},{...message('target'),sequence:11}], [owned,foreign]);
  const marks=authoredReadingBackfill(input,user.id,id=>getMessageDisplaySignature(input,id));
  expect(marks.some(mark=>mark.scope==='message'&&mark.messageId==='mine')).toBe(true);
  expect(marks.some(mark=>mark.scope==='message'&&mark.messageId==='target')).toBe(false);
  const influences=marks.filter(mark=>mark.scope==='influence'&&!mark.eventId?.startsWith('selection:'));
  expect(influences.length).toBeGreaterThan(0);
  for(const mark of influences)expect(JSON.parse(mark.eventId!)).toEqual(['old-reference',1,30]);
  const saved={...input,marks};
  expect(authoredReadingBackfill(saved,user.id,id=>getMessageDisplaySignature(input,id))).toEqual([]);
  const unread=marks.map(mark=>({...mark,state:'UNREAD' as const}));
  expect(authoredReadingBackfill({...input,marks:unread},user.id,id=>getMessageDisplaySignature(input,id))).toEqual([]);
  expect(authoredReadingBackfill({...input,messages:input.messages.map(message=>({...message,sequence:undefined}))},user.id,()=> 'display')).toEqual([]);
});
it('records an authored body with the actual display fingerprint and keeps its citation target unread',()=>{
  const input=fixture([message('authored',user),message('target')],[relation('citation','REFERENCE',['target'],'authored')]);
  const authored=input.messages.find(message=>message.id==='authored')!;
  const mark=authoredReadingMark(authored,getMessageDisplaySignature(input,authored.id)!);
  const hints=deriveDisplayHints({...input,readingMarks:[mark]}).hints;
  expect(hints.get('authored')).toMatchObject({unread:false,readChanged:false});
  expect(hints.get('target')).toMatchObject({unread:true});
});
it.each(['parts','payload'])('auto-reads a self-initiated settlement and its effects using %s attribution',source=>{
  const system={id:'system',username:'公论规则',createdAt:''};
  const round=(id:string,openedBy:string,triggerId:string):Message=>({...message(id,system),kind:'ROUND',sequence:20,
    targetRefs:[{kind:'message',messageId:'target'}],
    ...(source==='parts'?{parts:[{id:'basis',type:'data',value:{openedBy,triggerId}}]}:{relationPayload:{openedBy,triggerId,subjectId:'target'}})});
  const own=round('own-round',user.id,'mine'),foreign=round('foreign-round',other.id,'foreign');
  const result:Message={...round('later-result',user.id,'mine'),kind:'ROUND_RESULT',sequence:30};
  const input=fixture([{...message('mine',user),sequence:10},{...message('target'),sequence:11},own,foreign,result],
    [{...relation('incoming','AGREE',['mine']),sequence:31}]);
  const progress=deriveReadingProgress(input);
  expect(progress.pendingBodies.has('mine')).toBe(false);expect(progress.pendingBodies.has(own.id)).toBe(false);
  for(const id of ['target',foreign.id,result.id])expect(progress.pendingBodies.has(id)).toBe(true);
  expect(pending(input,'target')).toEqual(new Set([foreign.id,result.id]));expect(pending(input,'mine')).toEqual(new Set(['incoming']));
  expect(deriveDisplayHints(input).hints.get(own.id)?.unread).toBe(false);
  const marks=authoredReadingBackfill(input,user.id,id=>getMessageDisplaySignature(input,id));
  expect(new Set(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId))).toEqual(new Set(['mine',own.id]));
  expect(marks.filter(mark=>mark.scope==='influence').map(mark=>JSON.parse(mark.eventId!)[0])).toEqual([own.id]);
  expect(authoredReadingMarks(input,own.id,'display:sent').filter(mark=>mark.scope==='influence')).toEqual(marks.filter(mark=>mark.scope==='influence'));
  const saved={...input,marks};expect(authoredReadingBackfill(saved,user.id,id=>getMessageDisplaySignature(input,id))).toEqual([]);
  const unread=marks.map(mark=>({...mark,state:'UNREAD' as const}));
  expect(deriveReadingProgress({...input,marks:unread}).pendingBodies.has(own.id)).toBe(true);
  expect(authoredReadingBackfill({...input,marks:unread},user.id,id=>getMessageDisplaySignature(input,id))).toEqual([]);
  expect(input.messages.find(message=>message.id===own.id)?.authorId).toBe('system');
});
it('identifies the settlement initiator even when the triggering message is not loaded',()=>{
  const system={id:'system',username:'公论规则',createdAt:''};
  const round:Message={...message('own-round',system),kind:'ROUND',sequence:20,relationPayload:{openedBy:user.id,triggerId:'unloaded',subjectId:'target'}};
  const input={...fixture([message('target'),round],[]),userId:user.id};
  expect(deriveDisplayHints(input).hints.get(round.id)?.unread).toBe(false);
  expect(pending(input,'target')).toEqual(new Set());
  const marks=authoredReadingBackfill(input,user.id,id=>getMessageDisplaySignature(input,id));
  expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual([round.id]);
  expect(marks.filter(mark=>mark.scope==='influence').map(mark=>mark.messageId)).toEqual(['target']);
  const confirmed=deriveHomeFilterResult({...input,displayUser:user,homeFilterMode:{scope:'all',status:'confirmed'},msgMap:new Map(input.messages.map(message=>[message.id,message])),
    readStatusByMessageId:input.readStatus,traceContainerMemberships:input.memberships});
  expect(confirmed?.matchIds.has(round.id)).toBe(true);
});
it('keeps authored reading progress when an export viewer has a display-only identity',()=>{
  const system={id:'system',username:'公论规则',createdAt:''};
  const round:Message={...message('own-round',system),kind:'ROUND',sequence:20,relationPayload:{openedBy:user.id,triggerId:'mine',subjectId:'mine'}};
  const input={...fixture([message('mine',user),round],[]),userId:'viewer:alice'};
  const progress=deriveReadingProgress(input);
  expect(progress.pendingBodies.has('mine')).toBe(false);expect(progress.pendingBodies.has(round.id)).toBe(false);
  expect(progress.pendingInfluences.has('mine')).toBe(false);
});
function fixture(records:Message[],relations:Relation[],marks:ReadingMark[]=[]){
  const model=convertMessagesToDemoModel(records,relations),personalEffect=deriveContainerEffect({...model,relations,username:user.username,stakeCounts:{}});
  const corrections=computeCorrectionVersions(model.messages,model.edges,personalEffect.suppressed,user.username);
  return {...model,relations,personalEffect,corrections,username:user.username,readStatus:new Map<string,'READ'|'UNREAD'>(),marks,readingMarks:marks,memberships:personalEffect.memberships,effectiveJoinIds:personalEffect.effectiveJoinIds};
}
function mark(input:ReturnType<typeof fixture>,id:string){
  const hints=deriveDisplayHints(input).hints;
  return readingMarksFor({...input,displays:new Map([...hints].map(([id,hint])=>[id,hint.displayed]))},id,hints.get(id)!.displayed);
}
function pending(input:ReturnType<typeof fixture>,id='m'){return new Set(deriveReadingProgress(input).pendingInfluences.get(id)?.map(item=>item.messageId));}

function acknowledge(input:ReturnType<typeof fixture>,target:string,events?:string[]){
  return influenceReadingMarks(target,(deriveReadingProgress(input).pendingInfluences.get(target)??[]).filter(item=>!events||events.includes(item.messageId)));
}
function readAndConfirm(input:ReturnType<typeof fixture>,id:string){return [...mark(input,id),...acknowledge(input,id)];}
describe('private contextual reading progress',()=>{
  it('remembers effective and ineffective correction influences separately without rereading a previously confirmed result',()=>{
    const input=fixture([message('m')],[relation('correction','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'changed'})]);
    const first=mark(input,'m'),inactiveCorrections=computeCorrectionVersions(input.messages,input.edges,new Set(['correction']));
    const inactive={...input,corrections:inactiveCorrections,effectiveCorrections:inactiveCorrections,marks:first,readingMarks:first};
    expect(deriveReadingProgress(inactive).pendingInfluences.get('m')).toContainEqual(expect.objectContaining({messageId:'correction',resultKey:'ineffective'}));
    const both=[...first,...mark(inactive,'m')];
    for(const state of [input,inactive,input]){
      const progress=deriveReadingProgress({...state,marks:both});
      expect(progress.pendingInfluences.get('m')??[]).toEqual([]);expect(progress.selectionChanges.has('m')).toBe(false);
      expect(progress.pendingBodies.has('correction')).toBe(true);
    }
    expect(new Set(both.filter(mark=>mark.scope==='influence'&&mark.key==='correct:correction').map(mark=>mark.resultKey))).toEqual(new Set(['effective','ineffective']));
  });
  it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE','JOIN'])('remembers both %s relationship outcomes using the relation message identity',type=>{
    const relations=type==='JOIN'?[relation('container','CLASSIFY',[]),relation('event','JOIN',['m'],'container')]:[relation('event',type,['m'])];
    const base=fixture([message('m')],relations),input={...base,suppressedIds:new Set<string>()};
    const first=mark(input,'m');
    expect(first).toContainEqual(expect.objectContaining({messageId:'event',scope:'influence',resultKey:'effective'}));
    expect(deriveReadingProgress({...input,marks:first}).pendingBodies.has('event')).toBe(true);
    const readSource=[...first,...mark({...input,marks:first,readingMarks:first},'event')];
    const inactive={...input,marks:readSource,readingMarks:readSource,suppressedIds:new Set(['event']),effectiveJoinIds:new Set<string>()};
    const progress=deriveReadingProgress(inactive),change=progress.pendingInfluences.get('m')?.find(item=>item.messageId==='event');
    expect(change).toMatchObject({messageId:'event',resultKey:'ineffective'});expect(JSON.parse(change!.eventId!)[0]).toBe('event');
    expect(progress.pendingInfluences.get('event')??[]).not.toContainEqual(expect.objectContaining({messageId:'event'}));
    const both=[...readSource,...influenceReadingMarks('m',progress.pendingInfluences.get('m')??[])];
    for(const state of [input,inactive,input]){
      const after=deriveReadingProgress({...state,marks:both});
      expect(after.pendingInfluences.get('m')??[]).toEqual([]);expect(after.pendingInfluences.get('event')??[]).toEqual([]);
      expect(after.pendingBodies.has('event')).toBe(false);
    }
    expect(new Set(both.filter(mark=>mark.scope==='influence'&&JSON.parse(mark.eventId!)[0]==='event').map(mark=>mark.resultKey))).toEqual(new Set(['effective','ineffective']));
  });
  it('does not automatically confirm later outcome changes of an authored correction',()=>{
    const own={...relation('correction','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'mine'}),createdBy:user,sequence:10};
    const input=fixture([{...message('m'),sequence:1}],[own]);
    const first=authoredReadingBackfill(input,user.id,id=>getMessageDisplaySignature(input,id));
    const corrections=computeCorrectionVersions(input.messages,input.edges,new Set([own.id]));
    const changed={...input,corrections,effectiveCorrections:corrections,marks:first,readingMarks:first};
    expect(deriveReadingProgress(changed).pendingInfluences.get('m')).toContainEqual(expect.objectContaining({messageId:own.id,resultKey:'ineffective'}));
    expect(authoredReadingBackfill(changed,user.id,id=>getMessageDisplaySignature(changed,id))).toEqual([]);
  });
  it.each(['send','backfill'])('automatically confirms the relationship outcome caused by my own new stance (%s)',method=>{
    const correction={...relation('correction','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'changed'}),sequence:2};
    const original={...message('m'),sequence:1},before=fixture([original],[correction]),marks=mark(before,'m');
    const stance={...relation('my-opposition','DISAGREE',['correction']),createdBy:user,sequence:3,createdAt:'2026-01-03'};
    const input=fixture([original],[correction,stance],marks);
    const saved=method==='send'?authoredReadingMarks(input,stance.id,getMessageDisplaySignature(input,stance.id)!):authoredReadingBackfill(input,user.id,id=>getMessageDisplaySignature(input,id));
    expect(saved).toContainEqual(expect.objectContaining({messageId:'correction',scope:'influence',resultKey:'ineffective'}));
    expect(saved.some(mark=>mark.messageId==='correction'&&mark.scope==='message')).toBe(false);
    expect(pending({...input,marks:[...marks,...saved]})).toEqual(new Set());
  });
  it('auto-confirms only the current message effects, preserving other targets, records and later events',()=>{
    const records=[message('m'),message('peer')],relations=[relation('shared-tag','TAG',['m','peer'],null,{label:'可靠'}),
      relation('vote','AGREE',['m']),relation('reference','REFERENCE',['peer'],'m'),relation('container','CLASSIFY',[]),relation('join','JOIN',['m'],'container')];
    const before=fixture(records,relations),marks=mark(before,'m'),after=fixture(records,relations,marks);
    expect(pending(after)).toEqual(new Set());
    expect(pending(after,'peer').has('shared-tag')).toBe(true);
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m']);
    expect(deriveReadingProgress(after).pendingBodies.has('shared-tag')).toBe(true);
    const later=fixture(records,[...relations,relation('new-vote','DISAGREE',['m'])],marks);
    expect(pending(later)).toEqual(new Set(['new-vote']));
  });
  it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'])('reads a member body without confirming its %s ancestry or siblings',type=>{
    const relations=[relation('container',type,['m','sibling']),relation('outer','CLASSIFY',['container']),relation('join','JOIN',['m'],'container')];
    const input=fixture([message('m'),message('sibling')],relations),marks=mark(input,'m'),after=fixture([message('m'),message('sibling')],relations,marks);
    expect(marks.filter(mark=>mark.scope==='message')).toHaveLength(1);expect(marks[0]).toMatchObject({messageId:'m',scope:'message'});
    expect(deriveReadingProgress(after).pendingBodies.has('m')).toBe(false);
    for(const id of ['container','outer','join','sibling'])expect(deriveReadingProgress(after).pendingBodies.has(id)).toBe(true);
    expect(pending(after).has('join')).toBe(false);
  });
  it('reading one multi-target relationship does not acknowledge either affected target implicitly',()=>{
    const records=[message('source'),message('x'),message('y')],relations=[relation('reference','REFERENCE',['x','y'],'source')];
    const before=fixture(records,relations),marks=mark(before,'reference'),after=fixture(records,relations,marks);
    expect(pending(after,'x')).toEqual(pending(before,'x'));expect(pending(after,'y')).toEqual(pending(before,'y'));
    const explicit=fixture(records,relations,[...marks,...acknowledge(after,'x',['reference'])]);
    expect(pending(explicit,'x').has('reference')).toBe(false);expect(pending(explicit,'y').has('reference')).toBe(true);
    expect(deriveReadingProgress(explicit).pendingBodies.has('y')).toBe(true);
  });
  it('keeps JOIN votes on the record and member, while the parent only summarizes pending member progress',()=>{
    const relations=[relation('container','CLASSIFY',[]),relation('join','JOIN',['m'],'container'),relation('vote','DISAGREE',['join'])];
    const input=fixture([message('m')],relations),progress=deriveReadingProgress(input);
    expect(pending(input,'container').has('vote')).toBe(false);
    expect(pending(input,'join').has('vote')).toBe(true);
    expect(pending(input,'m').has('vote')).toBe(true);
    expect(progress.pendingMembers.get('container')?.has('m')).toBe(true);
  });
  it('keeps a JOIN body separate from placement confirmation without duplicating receipt as an influence',()=>{
    const records=[message('m')],relations=[relation('container','CLASSIFY',[]),relation('join','JOIN',['m'],'container')];
    const before=fixture(records,relations),after=fixture(records,relations,mark(before,'join'));
    expect(pending(after).has('join')).toBe(true);
    expect(after.marks).toContainEqual(expect.objectContaining({messageId:'join',scope:'message'}));
    expect(after.marks.some(mark=>mark.scope==='influence')).toBe(false);
    expect(deriveReadingProgress(after).pendingBodies.has('m')).toBe(true);expect(pending(after,'container').has('join')).toBe(false);
    const targetMarks=acknowledge(after,'m',['join']),targetRead=fixture(records,relations,[...after.marks,...targetMarks]);
    expect(pending(targetRead).has('join')).toBe(false);expect(pending(targetRead,'container').has('join')).toBe(false);
    expect(targetMarks).toContainEqual(expect.objectContaining({messageId:'join',scope:'influence',key:'join:container:join',resultKey:'effective'}));
    expect(deriveReadingProgress(targetRead).influences.get('container')??[]).toEqual([]);
  });
  it('lists only incoming placement effects and leaves received JOIN records in member progress',()=>{
    const input=fixture([message('m')],[relation('outer','CLASSIFY',[]),relation('container','CLASSIFY',[]),
      relation('into-outer','JOIN',['container'],'outer'),relation('into-container','JOIN',['m'],'container')]);
    const progress=deriveReadingProgress(input),items=progress.influences.get('container')??[];
    expect(items).toContainEqual(expect.objectContaining({messageId:'into-outer',type:'join'}));
    expect(items.some(item=>item.messageId==='into-container')).toBe(false);
    for(const [target,items] of progress.influences)expect(items.every(item=>item.messageId!==target)).toBe(true);
    const marks=mark(input,'container'),after=fixture([message('m')],input.relations,marks);
    expect(pending(after,'container')).toEqual(new Set());expect(pending(after,'m').has('into-container')).toBe(true);
    expect(pending(after,'outer').has('into-outer')).toBe(false);
    expect(marks.some(mark=>mark.messageId==='into-container')).toBe(false);
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['container']);
  });
  it.each(['CLASSIFY','SUMMARY'])('derives %s member counts from each current message, including later influences',type=>{
    const records=[message('first'),message('second')],relations=[relation('container',type,['first','second'])];
    const initial=fixture(records,relations),containerMarks=mark(initial,'container');
    const first=fixture(records,relations,containerMarks);
    expect(deriveDisplayHints(first).hints.get('container')).toMatchObject({unread:false,unreadMemberCount:2,relatedUnreadIds:[]});
    expect(containerMarks.some(item=>item.scope!=='influence'&&(item.messageId==='first'||item.messageId==='second')||item.key.startsWith('member:'))).toBe(false);
    const firstMarks=[...containerMarks,...readAndConfirm(first,'first')],second=fixture(records,relations,firstMarks);
    expect(deriveReadingProgress(second).pendingMembers.get('container')).toEqual(new Set(['second']));
    const complete=fixture(records,relations,[...firstMarks,...readAndConfirm(second,'second')]);
    expect(deriveReadingProgress(complete).confirmed('container')).toBe(true);
    const changed=fixture(records,[...relations,relation('new-reply','REPLY',['first'])],complete.marks);
    expect(deriveReadingProgress(changed).confirmed('container')).toBe(false);
    expect(deriveDisplayHints(changed).hints.get('container')).toMatchObject({unreadMemberCount:1,relatedUnreadIds:[]});
    const acknowledged=fixture(records,changed.relations,[...changed.marks,...mark(changed,'new-reply'),...acknowledge(changed,'first',['new-reply'])]);
    expect(deriveReadingProgress(acknowledged).confirmed('container')).toBe(true);
  });
  it('propagates pending members through nested containers without looping on cycles',()=>{
    const input=fixture([message('m')],[relation('outer','CLASSIFY',['inner']),relation('inner','SUMMARY',['m'])]);
    expect(deriveReadingProgress(input).pendingMembers.get('outer')).toEqual(new Set(['inner']));
    const cyclic={...input,memberships:[...input.memberships,{containerId:'inner',targetIds:['outer']}]};
    expect(deriveReadingProgress(cyclic).confirmed('outer')).toBe(false);
    expect(deriveReadingProgress({...cyclic,memberships:cyclic.memberships,marks:input.messages.flatMap(item=>readAndConfirm(input,item.id))}).confirmed('outer')).toBe(true);
  });
  it('does not treat sibling messages and their replies or settlements as influences on a text',()=>{
    const input=fixture([message('m'),message('sibling')],[relation('container','CLASSIFY',['m','sibling']),
      relation('join-m','JOIN',['m'],'container'),relation('join-sibling','JOIN',['sibling'],'container'),
      relation('reply-sibling','REPLY',['sibling']),relation('round-sibling','ROUND',['sibling']),
      relation('recommend-container','RECOMMEND',['container']),relation('direct-reply','REPLY',['m'])]);
    expect(pending(input)).toEqual(new Set(['join-m','direct-reply']));
  });
  it('does not propagate a former container vote to a member that has moved elsewhere',()=>{
    const input=fixture([message('m')],[relation('former','CLASSIFY',['m']),relation('current','CLASSIFY',[]),
      {...relation('old-join','JOIN',['m'],'former'),createdAt:'2026-01-02'},
      {...relation('new-join','JOIN',['m'],'current'),createdAt:'2026-01-03'},relation('vote-former','DISAGREE',['former'])]);
    expect(pending(input).has('vote-former')).toBe(false);
  });
  it('reads the authored body and its effects while leaving other bodies and incoming effects pending',()=>{
    const input=fixture([message('m',user),message('peer')],[{...relation('my-recommendation','RECOMMEND',['peer']),createdBy:user},relation('new-opinion','AGREE',['m'])]);
    const progress=deriveReadingProgress(input);
    expect(progress.pendingBodies.has('m')).toBe(false);expect(progress.pendingBodies.has('peer')).toBe(true);
    expect(progress.pendingBodies.has('my-recommendation')).toBe(false);
    expect(pending(input,'peer')).toEqual(new Set());
    expect(pending(input)).toEqual(new Set(['new-opinion']));
    const own=deriveHomeFilterResult({displayUser:user,homeFilterMode:{scope:'self',status:'pending'},msgMap:new Map(input.messages.map(item=>[item.id,item])),
      ...input,readingMarks:[],readStatusByMessageId:input.readStatus,traceContainerMemberships:input.memberships});
    expect(own!.matchIds).toEqual(new Set(['m']));
  });
  it('persists every effect of a sent multi-target message without confirming any target body',()=>{
    const records=[message('x'),message('y')],own={...relation('reference','REFERENCE',['x','y']),createdBy:user};
    const input=fixture(records,[own]),marks=authoredReadingMarks(input,own.id,'display:sent');
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['reference']);
    expect(new Set(marks.filter(mark=>mark.scope==='influence').map(mark=>mark.messageId))).toEqual(new Set(['x','y']));
    const later=fixture(records,[own,relation('other-reference','REFERENCE',['x'])],marks),progress=deriveReadingProgress(later);
    expect(progress.pendingBodies.has('reference')).toBe(false);
    expect(progress.pendingBodies.has('x')).toBe(true);expect(progress.pendingBodies.has('y')).toBe(true);
    expect(pending(later,'x')).toEqual(new Set(['other-reference']));
  });
  it('honors explicitly marking an authored body unread',()=>{
    const input=fixture([message('mine',user)],[],[{...authoredReadingMark({id:'mine'},'display:sent'),state:'UNREAD'}]);
    expect(deriveReadingProgress(input).pendingBodies.has('mine')).toBe(true);
  });
  it('confirms the selection change caused by sending a correction and preserves another author’s incoming effect',()=>{
    const records=[message('m')],marks=mark(fixture(records,[]),'m');
    const own={...relation('my-correction','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'本人更正'}),createdBy:user};
    const relations=[own,relation('other-opinion','AGREE',['m'])],input=fixture(records,relations,marks);
    expect(deriveReadingProgress(input).selectionChanges.has('m')).toBe(true);
    const saved=authoredReadingMarks(input,own.id,'display:sent'),after=fixture(records,relations,[...marks,...saved]);
    expect(deriveReadingProgress(after).selectionChanges.has('m')).toBe(false);
    expect(pending(after,'m')).toEqual(new Set(['other-opinion']));
  });
  it('acknowledges the presented events of each type while retaining later events',()=>{
    const relations=[relation('agree-1','AGREE',['m']),relation('agree-2','AGREE',['m']),relation('oppose','DISAGREE',['m']),
      relation('recommend','RECOMMEND',['m']),relation('archive','ARCHIVE',['m']),relation('tag-a','TAG',['m'],null,{label:'可靠'}),relation('tag-b','TAG',['m'],null,{label:'待核查'})];
    const before=fixture([message('m')],relations),marks=[...mark(before,'m').filter(item=>item.messageId==='m'&&item.scope!=='influence'),...influenceReadingMarks('m',deriveReadingProgress(before).influences.get('m')!.filter(item=>['agree','recommend'].includes(item.type)||item.key==='tag:可靠'))];
    const after=fixture([message('m')],[...relations,relation('agree-3','AGREE',['m']),relation('recommend-2','RECOMMEND',['m']),relation('tag-a2','TAG',['m'],null,{label:'可靠'})],marks);
    expect(pending(after)).toEqual(new Set(['oppose','archive','tag-b','agree-3','recommend-2','tag-a2']));
    expect(deriveReadingProgress(after).pendingBodies.has('m')).toBe(false);
    expect(deriveReadingProgress(after).confirmed('m')).toBe(false);
  });
  it('keeps every outgoing reference separate and acknowledges incoming references as one category',()=>{
    const relations=[relation('out-x','REFERENCE',['x'],'m'),relation('out-y','REFERENCE',['y'],'m'),relation('in-x','REFERENCE',['m'],'x'),relation('in-y','REFERENCE',['m'],'y')];
    const records=[message('m'),message('x'),message('y')],before=fixture(records,relations);
    const after=fixture(records,[...relations,relation('in-later','REFERENCE',['m'],'x')],[...mark(before,'in-x'),...mark(before,'out-x'),...acknowledge(before,'m',['in-x','out-x']),...acknowledge(before,'x',['out-x'])]);
    expect(pending(after)).toEqual(new Set(['out-y','in-y','in-later']));
    expect(pending(after,'x').has('out-x')).toBe(false);
  });
  it('keeps concrete JOIN records and their container contexts separate',()=>{
    const relations=[relation('a','CLASSIFY',[]),relation('b','CLASSIFY',[]),relation('join-a','JOIN',['m'],'a'),relation('join-b','JOIN',['m'],'b')];
    const before=fixture([message('m')],relations),after=fixture([message('m')],relations,[...mark(before,'join-a'),...acknowledge(before,'m',['join-a'])]);
    expect(pending(after).has('join-a')).toBe(false);expect(pending(after).has('join-b')).toBe(true);
    const later=fixture([message('m')],[...relations,relation('join-again','JOIN',['m'],'a')],after.marks);
    expect(pending(later).has('join-again')).toBe(true);
  });
  it('confirms a corrected body directly and keeps correction message bodies independent',()=>{
    const correction=relation('v2','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'新版正文'});
    const before=fixture([message('m')],[correction]);
    const direct=mark(before,'m');expect(direct.some(item=>item.messageId==='v2'&&item.scope==='message')).toBe(false);
    expect(direct.find(item=>item.scope==='message')?.version?.corrections.map(item=>item.messageId)).toEqual(['v2']);
    const displayed=deriveDisplayHints(before).hints.get('m')!.displayed;
    const originalMarks=readingMarksFor(before,'m',{...displayed,content:'m',correctionIds:[]});
    expect(originalMarks.some(item=>item.messageId==='v2'&&item.scope==='message')).toBe(false);
    const correctionMarks=mark(fixture([message('m')],[correction],originalMarks),'v2');
    const marks=[...originalMarks,...correctionMarks,...mark(fixture([message('m')],[correction],[...originalMarks,...correctionMarks]),'m')];
    expect(new Set(marks.filter(item=>item.messageId==='m'&&item.scope!=='influence').map(item=>item.bodySignature))).toEqual(new Set([messageReadingKey('m')]));
    expect(marks.some(item=>item.messageId==='v2'&&item.scope==='message')).toBe(true);
    const after=fixture([message('m')],[correction],[...marks,...acknowledge(before,'m',['v2'])]);
    expect(deriveReadingProgress(after).confirmed('m')).toBe(true);
    expect(deriveReadingProgress(fixture([message('m')],[],marks)).pendingBodies.has('m')).toBe(false);
    const newer=relation('v3','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'新版正文'});
    expect(deriveReadingProgress(fixture([message('m')],[newer],marks)).pendingBodies.has('m')).toBe(false);
  });
  it('keeps unknown historical marks pending without imposing a new original-reading prerequisite',()=>{
    const correction=relation('v2','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'新版正文'});
    const signature=bodyVersionKey(bodyVersion('m',1,[{messageId:'v2',revision:1,kind:'TEXT'}]));
    const input=fixture([message('m')],[correction],[{messageId:'m',scope:'message',key:signature,bodySignature:signature}]);
    const progress=deriveReadingProgress(input);
    expect(progress.pendingBodies.has('m')).toBe(true);expect(progress.pendingOriginals.has('m')).toBe(false);
    expect(progress.confirmed('m')).toBe(false);expect(deriveDisplayHints(input).hints.get('m')?.originalUnread).toBe(false);
    expect(()=>mark(input,'m')).not.toThrow();
  });
  it('combines following with viewing state and respects explicit unfollow independently of read',()=>{
    const records=[message('m'),message('unrelated')],follow={...relation('follow','ATTENTION',['m'],null,{subType:'YES'}),createdBy:user,sequence:1};
    const input=fixture(records,[follow]),marks=mark(input,'m');
    const result=(relations:Relation[],readingMarks:ReadingMark[],status:'all'|'pending'|'confirmed')=>{
      const values=fixture(records,relations,readingMarks);
      return deriveHomeFilterResult({...values,displayUser:user,homeFilterMode:{scope:'following',status},msgMap:new Map(values.messages.map(item=>[item.id,item])),
        readStatusByMessageId:values.readStatus,traceContainerMemberships:values.memberships,readingMarks})!.matchIds;
    };
    expect(result([follow],[],'pending')).toEqual(new Set(['m']));
    // The current-message button also confirms its displayed annotation effects.
    expect(result([follow],marks,'confirmed')).toEqual(new Set(['m']));
    const complete=[...marks,...mark(input,'follow'),...acknowledge(input,'m',['follow'])];
    expect(result([follow],complete,'confirmed')).toEqual(new Set(['m']));
    expect(result([follow],complete,'pending')).toEqual(new Set());
    expect(result([follow,{...follow,id:'unfollow',sequence:2,payload:{subType:'NO'}}],complete,'all')).toEqual(new Set());
  });
});
