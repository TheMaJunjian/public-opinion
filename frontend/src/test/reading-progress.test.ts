import {describe,expect,it} from 'vitest';
import type {ReadingMark} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {convertMessagesToDemoModel,computeCorrectionVersions} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {deriveDisplayHints} from '../pages/workbench/model/displayHints';
import {deriveReadingProgress,readingMarksFor,influenceReadingMarks} from '../pages/workbench/model/readingProgress';
import {bodyVersion,bodyVersionKey,messageReadingKey,originalReadingKey} from '@gonglun/core';
import {deriveHomeFilterResult} from '../pages/workbench/projections/homeFilterResult';

const user={id:'alice',username:'alice',createdAt:''},other={id:'bob',username:'bob',createdAt:''};
const message=(id:string,author=other):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:'2026-01-01',createdBy:author});
const relation=(id:string,type:string,targets:string[],source:string|null=null,payload:Relation['payload']={}):Relation=>({id,relationType:type,sourceMessageId:source,
  targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdBy:other,createdAt:'2026-01-02',payload});
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

describe('private manual viewing progress',()=>{
  it('confirms every JOIN on the current nested path, including the earlier direct outer JOIN, without reading container bodies',()=>{
    const relations=[relation('A','CLASSIFY',[]),relation('R','ARRANGE',[]),relation('frame-in-category','JOIN',['R'],'A'),
      {...relation('old-outer','JOIN',['m'],'A'),createdAt:'2026-01-01'},
      {...relation('active','JOIN',['m'],'R'),createdAt:'2026-01-03'}];
    const input=fixture([message('m')],relations),marks=mark(input,'m'),after=fixture([message('m')],relations,marks);
    expect(new Set(marks.filter(mark=>mark.scope!=='influence').map(mark=>mark.messageId))).toEqual(new Set(['m','active','old-outer','frame-in-category']));
    expect(marks.filter(mark=>mark.scope!=='influence')).toHaveLength(4);expect(pending(after)).toEqual(new Set());
    for(const joined of ['active','old-outer','frame-in-category'])expect(marks).toContainEqual(expect.objectContaining({messageId:joined,scope:'message',confirmation:{kind:'included',messageId:'m'}}));
    const progress=deriveReadingProgress(after);
    expect(progress.pendingBodies.has('A')).toBe(true);expect(progress.pendingBodies.has('R')).toBe(true);
  });
  it.each(['CLASSIFY','SUMMARY'].flatMap(type=>[false,true].map(join=>({type,join}))))('confirms the placement once without recording a separate $type body read, explicit JOIN=$join',({type,join})=>{
    const records=[message('m'),message('sibling')],relations=[relation('container',type,['m','sibling']),relation('container-reply','REPLY',['container']),
      ...(join?[relation('join','JOIN',['m'],'container')]:[])];
    const before=fixture(records,relations),marks=mark(before,'m'),after=fixture(records,relations,marks),progress=deriveReadingProgress(after);
    expect(marks.some(mark=>mark.messageId==='container'&&mark.scope!=='influence')).toBe(false);
    expect(progress.pendingBodies.has('container')).toBe(true);expect(progress.confirmed('m')).toBe(true);
    expect(progress.pendingBodies.has('sibling')).toBe(true);expect(progress.pendingMembers.get('container')).toEqual(new Set(['sibling']));
    expect(pending(after,'container').has('container-reply')).toBe(true);
    expect(marks.some(mark=>mark.messageId==='sibling'&&mark.scope!=='influence')).toBe(false);
    if(join){expect(progress.pendingBodies.has('join')).toBe(false);expect(marks.filter(mark=>mark.messageId==='join'&&mark.scope!=='influence')).toHaveLength(1);expect(marks.filter(mark=>mark.scope!=='influence')).toHaveLength(2);}
  });
  it('confirms existing JOINs to the current container once each while leaving the container body unread',()=>{
    const relations=[relation('container','CLASSIFY',['m']),{...relation('old','JOIN',['m'],'container'),createdAt:'2026-01-01'},
      {...relation('current','JOIN',['m'],'container'),createdAt:'2026-01-02'},relation('elsewhere','CLASSIFY',[])];
    const before=fixture([message('m')],relations),marks=mark(before,'m'),after=fixture([message('m')],relations,marks);
    expect(deriveReadingProgress(after).pendingBodies.has('container')).toBe(true);
    expect(deriveReadingProgress(after).pendingBodies.has('old')).toBe(false);expect(pending(after)).toEqual(new Set());
    expect(marks.some(mark=>mark.messageId==='elsewhere')).toBe(false);
  });
  it('follows deeper current ancestry through a legacy declaration without confirming sibling or former paths',()=>{
    const relations=[relation('A','CLASSIFY',['S']),relation('B','SUMMARY',['R']),relation('R','ARRANGE',[]),relation('S','ARRANGE',[]),relation('former','CLASSIFY',[]),
      relation('branch','JOIN',['B'],'A'),relation('sibling','JOIN',['sibling-message'],'S'),
      {...relation('old-frame','JOIN',['B'],'former'),createdAt:'2026-01-01'},
      {...relation('old-member','JOIN',['m'],'former'),createdAt:'2026-01-01'},
      {...relation('active','JOIN',['m'],'R'),createdAt:'2026-01-03'}];
    const input=fixture([message('m'),message('sibling-message')],relations),marks=mark(input,'m');
    expect(new Set(marks.filter(mark=>mark.scope!=='influence').map(item=>item.messageId))).toEqual(new Set(['m','branch','active']));
    const after=fixture([message('m'),message('sibling-message')],relations,marks);
    for(const id of ['A','B','R','S','former','old-frame','old-member','sibling','sibling-message'])expect(deriveReadingProgress(after).pendingBodies.has(id)).toBe(true);
  });
  it('uses the displayed fallback path when a nested container is rejected',()=>{
    const relations=[relation('A','CLASSIFY',[]),relation('R','ARRANGE',[]),relation('branch','JOIN',['R'],'A'),
      {...relation('outer','JOIN',['m'],'A'),createdAt:'2026-01-01'},
      {...relation('inner','JOIN',['m'],'R'),createdAt:'2026-01-03'}];
    const input=fixture([message('m')],relations),effect=deriveContainerEffect({...input,stakeCounts:{},assumption:{messageId:'R',side:'disagree'}});
    const preview={...input,personalEffect:effect,memberships:effect.memberships,effectiveJoinIds:effect.effectiveJoinIds};
    const marks=mark(preview,'m');
    expect(new Set(marks.filter(mark=>mark.scope!=='influence').map(item=>item.messageId))).toEqual(new Set(['m','outer']));
  });
  it('records one JOIN read for both endpoints without a separate container influence',()=>{
    const relations=[relation('container','CLASSIFY',['m']),relation('join','JOIN',['m'],'container')];
    const before=fixture([message('m')],relations),after=fixture([message('m')],relations,mark(before,'join'));
    expect(pending(after)).toEqual(new Set());expect(deriveReadingProgress(after).pendingBodies.has('container')).toBe(true);
    expect(pending(before)).toEqual(new Set(['join']));expect(after.marks.filter(mark=>mark.scope!=='influence')).toHaveLength(1);
  });
  it.each(['CLASSIFY','SUMMARY'])('derives %s member counts from each current message, including later influences',type=>{
    const records=[message('first'),message('second')],relations=[relation('container',type,['first','second'])];
    const initial=fixture(records,relations),containerMarks=mark(initial,'container');
    const first=fixture(records,relations,containerMarks);
    expect(deriveDisplayHints(first).hints.get('container')).toMatchObject({unread:false,unreadMemberCount:2,relatedUnreadIds:[]});
    expect(containerMarks.some(item=>item.scope!=='influence'&&(item.messageId==='first'||item.messageId==='second')||item.key.startsWith('member:'))).toBe(false);
    const firstMarks=[...containerMarks,...mark(first,'first')],second=fixture(records,relations,firstMarks);
    expect(deriveReadingProgress(second).pendingMembers.get('container')).toEqual(new Set(['second']));
    const complete=fixture(records,relations,[...firstMarks,...mark(second,'second')]);
    expect(deriveReadingProgress(complete).confirmed('container')).toBe(true);
    const changed=fixture(records,[...relations,relation('new-reply','REPLY',['first'])],complete.marks);
    expect(deriveReadingProgress(changed).confirmed('container')).toBe(false);
    expect(deriveDisplayHints(changed).hints.get('container')).toMatchObject({unreadMemberCount:1,relatedUnreadIds:[]});
    const acknowledged=fixture(records,changed.relations,[...changed.marks,...mark(changed,'new-reply')]);
    expect(deriveReadingProgress(acknowledged).confirmed('container')).toBe(true);
  });
  it('propagates pending members through nested containers without looping on cycles',()=>{
    const input=fixture([message('m')],[relation('outer','CLASSIFY',['inner']),relation('inner','SUMMARY',['m'])]);
    expect(deriveReadingProgress(input).pendingMembers.get('outer')).toEqual(new Set(['inner']));
    const cyclic={...input,memberships:[...input.memberships,{containerId:'inner',targetIds:['outer']}]};
    expect(deriveReadingProgress(cyclic).confirmed('outer')).toBe(false);
    expect(deriveReadingProgress({...cyclic,memberships:cyclic.memberships,marks:input.messages.flatMap(item=>mark(input,item.id))}).confirmed('outer')).toBe(true);
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
  it('confirms visible JOIN and all current expression categories without claiming hidden reasons were viewed',()=>{
    const relations=[relation('container','CLASSIFY',[]),relation('join','JOIN',['m'],'container'),relation('agree','AGREE',['m']),
      relation('recommend','RECOMMEND',['m']),relation('oppose','DISAGREE',['m']),relation('archive','ARCHIVE',['m'])];
    const before=fixture([message('m')],relations),marks=mark(before,'m'),after=fixture([message('m')],relations,marks);
    expect(pending(after)).toEqual(new Set());
    expect(marks.some(item=>item.messageId==='agree'&&item.scope==='message')).toBe(false);
    expect(marks.some(item=>item.messageId==='recommend'&&item.scope==='message')).toBe(false);
    expect(deriveReadingProgress(after).pendingBodies.has('agree')).toBe(true);
  });
  it('does not infer read from authorship, recommendation, archive or participation',()=>{
    const input=fixture([message('m',user),message('peer')],[{...relation('my-recommendation','RECOMMEND',['peer']),createdBy:user},relation('new-opinion','AGREE',['m'])]);
    const progress=deriveReadingProgress(input);
    expect(progress.pendingBodies.has('m')).toBe(true);expect(progress.pendingBodies.has('peer')).toBe(true);
    expect(pending(input)).toEqual(new Set(['new-opinion']));
    const own=deriveHomeFilterResult({displayUser:user,homeFilterMode:{scope:'self',status:'pending'},msgMap:new Map(input.messages.map(item=>[item.id,item])),
      ...input,readingMarks:[],readStatusByMessageId:input.readStatus,traceContainerMemberships:input.memberships});
    expect(own!.matchIds).toEqual(new Set(['m']));
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
    const after=fixture(records,[...relations,relation('in-later','REFERENCE',['m'],'x')],[...mark(before,'in-x'),...mark(before,'out-x')]);
    expect(pending(after)).toEqual(new Set(['out-y','in-y','in-later']));
    expect(pending(after,'x').has('out-x')).toBe(false);
  });

  it('keeps concrete JOIN records and their container contexts separate',()=>{
    const relations=[relation('a','CLASSIFY',[]),relation('b','CLASSIFY',[]),relation('join-a','JOIN',['m'],'a'),relation('join-b','JOIN',['m'],'b')];
    const before=fixture([message('m')],relations),after=fixture([message('m')],relations,mark(before,'join-a'));
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
    const after=fixture([message('m')],[correction],marks);
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
    // The main confirmation includes the displayed follow category.
    expect(result([follow],marks,'confirmed')).toEqual(new Set(['m']));
    const complete=[...marks,...mark(input,'follow')];
    expect(result([follow],complete,'confirmed')).toEqual(new Set(['m']));
    expect(result([follow],complete,'pending')).toEqual(new Set());
    expect(result([follow,{...follow,id:'unfollow',sequence:2,payload:{subType:'NO'}}],complete,'all')).toEqual(new Set());
  });
});
