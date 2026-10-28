import {describe,expect,it} from 'vitest';
import type {ReadingMark} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {convertMessagesToDemoModel,computeCorrectionVersions} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {deriveDisplayHints,getMessageDisplaySignature} from '../pages/workbench/model/displayHints';
import {authoredReadingMark,authoredReadingMarks,deriveReadingProgress,readingMarksFor,influenceReadingMarks} from '../pages/workbench/model/readingProgress';
import {bodyVersion,bodyVersionKey,messageReadingKey,originalReadingKey} from '@gonglun/core';
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
  it('auto-confirms only the current message effects, preserving other targets, records and later events',()=>{
    const records=[message('m'),message('peer')],relations=[relation('shared-tag','TAG',['m','peer'],null,{label:'可靠'}),
      relation('vote','AGREE',['m']),relation('reference','REFERENCE',['peer'],'m'),relation('container','CLASSIFY',[]),relation('join','JOIN',['m'],'container')];
    const before=fixture(records,relations),marks=mark(before,'m'),after=fixture(records,relations,marks);
    expect(pending(after)).toEqual(new Set(['reference','join']));
    expect(pending(after,'peer').has('shared-tag')).toBe(true);
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m']);
    expect(deriveReadingProgress(after).pendingBodies.has('shared-tag')).toBe(true);
    const later=fixture(records,[...relations,relation('new-vote','DISAGREE',['m'])],marks);
    expect(pending(later)).toEqual(new Set(['reference','join','new-vote']));
  });
  it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'])('reads a member body without confirming its %s ancestry or siblings',type=>{
    const relations=[relation('container',type,['m','sibling']),relation('outer','CLASSIFY',['container']),relation('join','JOIN',['m'],'container')];
    const input=fixture([message('m'),message('sibling')],relations),marks=mark(input,'m'),after=fixture([message('m'),message('sibling')],relations,marks);
    expect(marks).toHaveLength(1);expect(marks[0]).toMatchObject({messageId:'m',scope:'message'});
    expect(deriveReadingProgress(after).pendingBodies.has('m')).toBe(false);
    for(const id of ['container','outer','join','sibling'])expect(deriveReadingProgress(after).pendingBodies.has(id)).toBe(true);
    expect(pending(after).has('join')).toBe(true);
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
  it('reading a JOIN body and confirming its effect are separate operations',()=>{
    const records=[message('m')],relations=[relation('container','CLASSIFY',[]),relation('join','JOIN',['m'],'container')];
    const before=fixture(records,relations),after=fixture(records,relations,mark(before,'join'));
    expect(pending(after).has('join')).toBe(true);
    const confirmed=fixture(records,relations,[...after.marks,...acknowledge(after,'m',['join'])]);
    expect(pending(confirmed).has('join')).toBe(false);expect(pending(confirmed,'container').has('join')).toBe(false);
    expect(pending(before,'container').has('join')).toBe(false);
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
  it('requires the original before confirming a correction and keeps their reading records separate',()=>{
    const correction=relation('v2','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'新版正文'});
    const before=fixture([message('m')],[correction]);
    expect(()=>mark(before,'m')).toThrow('请先切回原文并确认已阅');
    const displayed=deriveDisplayHints(before).hints.get('m')!.displayed;
    const originalMarks=readingMarksFor(before,'m',{...displayed,content:'m',correctionIds:[]});
    expect(originalMarks.some(item=>item.messageId==='v2')).toBe(false);
    const correctionMarks=mark(fixture([message('m')],[correction],originalMarks),'v2');
    const marks=[...originalMarks,...correctionMarks,...mark(fixture([message('m')],[correction],[...originalMarks,...correctionMarks]),'m')];
    expect(new Set(marks.filter(item=>item.messageId==='m'&&item.scope!=='influence').map(item=>item.bodySignature))).toEqual(new Set([originalReadingKey('m'),messageReadingKey('m')]));
    expect(marks.some(item=>item.messageId==='v2'&&item.scope==='message')).toBe(true);
    const after=fixture([message('m')],[correction],[...marks,...acknowledge(before,'m',['v2'])]);
    expect(deriveReadingProgress(after).confirmed('m')).toBe(true);
    expect(deriveReadingProgress(fixture([message('m')],[],marks)).pendingBodies.has('m')).toBe(false);
    const newer=relation('v3','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'新版正文'});
    expect(deriveReadingProgress(fixture([message('m')],[newer],marks)).pendingBodies.has('m')).toBe(false);
  });
  it('keeps a previously saved corrected mark pending when its original was never confirmed',()=>{
    const correction=relation('v2','CORRECT',['m'],null,{correctionBeforeContent:'m',correctionAfterContent:'新版正文'});
    const signature=bodyVersionKey(bodyVersion('m',1,[{messageId:'v2',revision:1,kind:'TEXT'}]));
    const input=fixture([message('m')],[correction],[{messageId:'m',scope:'message',key:signature,bodySignature:signature}]);
    const progress=deriveReadingProgress(input);
    expect(progress.pendingBodies.has('m')).toBe(true);expect(progress.pendingOriginals.has('m')).toBe(true);
    expect(progress.confirmed('m')).toBe(false);expect(deriveDisplayHints(input).hints.get('m')?.originalUnread).toBe(true);
    expect(()=>mark(input,'m')).toThrow('请先切回原文并确认已阅');
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
