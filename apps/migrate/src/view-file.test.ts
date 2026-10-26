import {expect,it} from 'vitest';
import {migrateViewFile} from './migrate-view-file.js';
import {bindRoles,replayArchive,type Message,type Change} from '@gonglun/core';
import {archiveToWorkbenchSnapshot,projectWorkbenchSnapshot} from '../../../frontend/src/utils/workbenchProjection.js';
import {validateExportForViewing} from '../../../frontend/src/utils/exportArchive.js';

it('显式迁移旧阅览范围、是/否理由和容器嵌套，原文件不变且重复迁移结果不变',()=>{
  const data={topic:{id:'topic',title:'讨论'},messages:[
    {id:'a',kind:'TEXT',content:'甲'}, {id:'b',kind:'TEXT',content:'乙'}, {id:'c',kind:'TEXT',content:'丙'},
    {id:'inner',kind:'RELATION'}, {id:'outer',kind:'RELATION'}, {id:'unfollow',kind:'RELATION'}],relations:[
    {id:'inner',relationType:'ARRANGE',targetRefs:[{kind:'message',messageId:'a'},{kind:'message',messageId:'b'}]},
    {id:'outer',relationType:'ARRANGE',targetRefs:['a','b','c'].map(messageId=>({kind:'message',messageId}))},
    {id:'unfollow',relationType:'UNFOLLOW',targetRefs:[{kind:'message',messageId:'a'}]}]};
  const before=structuredClone(data),upgraded=migrateViewFile(data);
  expect(data).toEqual(before);
  expect(upgraded.scope).toEqual({messageId:null,title:'讨论'});
  expect(upgraded.relations.find((relation:any)=>relation.id==='outer').targetRefs.map((ref:any)=>ref.reference.messageId)).toEqual(['c','inner']);
  const follow=upgraded.messages.find((message:any)=>message.id==='unfollow');
  expect(follow.parts.find((part:any)=>part.type==='relation')).toMatchObject({relation:'follow',reason:'NO'});
  expect(migrateViewFile(upgraded)).toEqual(upgraded);
});

it('重复片段没有位置时拒绝猜测，已有明确位置时完整保留',()=>{
  const input={scope:{messageId:null,title:'讨论'},messages:[{id:'text',content:'重复重复'},{id:'tag'}],relations:[
    {id:'tag',relationType:'TAG',payload:{label:'关键'},targetRefs:[{kind:'text-fragment',messageId:'text',text:'重复'}]}]};
  expect(()=>migrateViewFile(input)).toThrow('片段位置不唯一');
  const exact={messageId:'text',revision:2,partId:'body',range:{start:2,end:4}};
  const explicit={...input,relations:[{...input.relations[0],targetRefs:[{...input.relations[0].targetRefs[0],reference:exact}]}]};
  expect(migrateViewFile(explicit).relations[0].targetRefs[0].reference).toEqual({...exact,context:{kind:'UNKNOWN'}});
});

it('旧标签来源与合并次数转换为明确展示位置，保留原消息和精确引用',()=>{
  const data={scope:{messageId:null,title:'讨论'},messages:[{id:'label',content:'关键依据'},{id:'target',content:'正文'},{id:'tag'}],relations:[
    {id:'tag',relationType:'TAG',sourceMessageId:'label',payload:{sendCount:3,transformedFrom:'AGREE'},targetRefs:[{kind:'message',messageId:'target'}]}]};
  const current=migrateViewFile(data),tag=current.relations[0],source=current.messages.find((message:any)=>message.id==='label');
  expect(tag.payload).toMatchObject({label:'关键依据',repetitionCount:3});
  expect(tag.payload).not.toHaveProperty('sendCount');expect(tag.payload).not.toHaveProperty('transformedFrom');
  expect(source.parts).toContainEqual({id:'embedded-presentation',type:'display',layout:'relation',relationPartId:'relation',target:{messageId:'tag',partId:'relation'}});
  expect(source.parts[0].text).toBe('关键依据');
  expect(migrateViewFile(current)).toEqual(current);
});

it('converts the actual Prisma split export shape and keeps every relationship in the viewer',()=>{
  const identity={createdAt:'2026-01-01T00:00:00.000Z',authorId:'user',author:'用户',supersededBy:null};
  const data={formatVersion:2,topic:{title:'旧讨论'},messages:[{...identity,id:'text',kind:'TEXT',content:'正文'},
    {...identity,id:'code',kind:'CODE',content:'const keep = 1;'}],relations:[
    {...identity,id:'group',relationType:'CLASSIFY',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'text'}],payload:{title:'容器'}},
    {...identity,id:'join',relationType:'JOIN',sourceMessageId:'group',targetRefs:[{kind:'message',messageId:'code'}],payload:{}},
    {...identity,id:'follow',relationType:'ATTENTION',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'text'}],payload:{action:'unfollow'}},
  ]};
  const before=structuredClone(data),converted=migrateViewFile(data);
  expect(data).toEqual(before);
  expect(converted.messages.map((message:any)=>message.id)).toEqual(['text','code','group','join','follow']);
  expect(converted.messages.find((message:any)=>message.id==='code').parts[0]).toMatchObject({type:'code',source:'const keep = 1;'});
  expect(converted.messages.find((message:any)=>message.id==='join').parts).toContainEqual(expect.objectContaining({relation:'member-of',roles:{
    parent:[{id:'parent-0',reference:{messageId:'group',context:{kind:'MESSAGE'}}}],member:[{id:'member-0',reference:{messageId:'code',context:{kind:'MESSAGE'}}}],
  }}));
  expect(converted.relations.find((relation:any)=>relation.id==='follow').payload.subType).toBe('NO');
  const projection=projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(validateExportForViewing(converted).data));
  expect(projection.relations.map(relation=>relation.id)).toEqual(['group','join','follow']);
  expect(projection.messages.some(message=>message.id==='join')).toBe(true);
  expect(migrateViewFile(converted)).toEqual(converted);
});

it('converts native journal messages and their view projections together while preserving funds and precise references',()=>{
  const message=(id:string,parts:Message['parts']):Message=>({id,parts,revision:1,authorId:'user',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'',
    regionId:'region',ledgerId:'local',programVersion:'2',ruleVersion:1,sequence:1,spending:{protocol:0,recommendation:0,wager:0}});
  const target=message('target',[{id:'body',type:'text',text:'前原文后'}]);
  const group=message('group',[{id:'relation',type:'relation',relation:'classify',roles:{}}]);
  const join=message('join',[{id:'relation',type:'relation',relation:'legacy-join',roles:bindRoles({source:[{messageId:'group'}],target:[{messageId:'target'}]})},
    {id:'data',type:'data',value:{legacyTopicId:'topic',uiType:'JOIN',kind:'RELATION'}}]);
  const exact={messageId:'target',revision:1,partId:'body',range:{start:1,end:3}};
  const correction=message('correction',[{id:'relation',type:'relation',relation:'amend',roles:bindRoles({target:[exact]})},
    {id:'data',type:'data',value:{legacyTopicId:'topic',uiType:'CORRECT',kind:'RELATION',correctionContent:'前替换后'}}]);
  const messages=[target,group,join,correction];
  const change:Change={sequence:1,previousSequence:0,messages,memberships:[],removedMemberships:[],states:[],ledger:[],treasury:{operating:0,issued:0}};
  const data={format:'gonglun-2',formatVersion:2,scope:{title:'讨论',messageId:null},journal:{version:1,entryCount:1,lastSequence:1},changes:[change],
    messages:messages.map(message=>({...message,kind:'RELATION',content:'原内容',author:'用户',authorId:'user'})),relations:[
      {id:'join',relationType:'JOIN',sourceMessageId:'group',targetRefs:[{kind:'message',messageId:'target'}],payload:{legacyTopicId:'topic'}},
      {id:'correction',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'text-fragment',messageId:'target',text:'原文',reference:exact}],payload:{correctionContent:'前替换后'}},
    ]};
  const converted=migrateViewFile(data),replayed=replayArchive(converted);
  for(const row of converted.messages)expect(row.parts).toEqual(replayed.messages.find(message=>message.id===row.id)?.parts);
  expect(converted.relations[0].parts[0]).toMatchObject({relation:'member-of'});
  expect(converted.relations[1].parts).toContainEqual({id:'corrected-body',type:'text',text:'前替换后'});
  expect(converted.relations[1].targetRefs[0].reference).toEqual({...exact,context:{kind:'MESSAGE'}});
  expect(replayed.operating).toBe(0);expect(replayed.issued).toBe(0);
  expect(converted.changes[0].ledger).toEqual(change.ledger);
  expect(migrateViewFile(converted)).toEqual(converted);
  const journalOnly={format:'gonglun-2',changes:[change],journal:data.journal};
  const complete=migrateViewFile(journalOnly);
  expect(complete.messages.map((message:any)=>message.id)).toEqual(messages.map(message=>message.id));
  expect(complete.relations.map((relation:any)=>relation.id)).toEqual(['group','join','correction']);
  expect(validateExportForViewing(complete).verification).toContain('资金守恒校验通过');
});

it('turns historical meaning changes into independent linked messages with an append-only money-neutral upgrade',()=>{
  const base:Message={id:'m',revision:1,parts:[{id:'body',type:'text',text:'旧主张'}],authorId:'user',createdAt:'2026-01-01',updatedAt:'',regionId:'r',ledgerId:'local',programVersion:'2',ruleVersion:1,sequence:1,spending:{protocol:0,recommendation:0,wager:0}};
  const correction:Message={...base,id:'c',parts:[{id:'relation',type:'relation',relation:'correct',roles:bindRoles({target:[{messageId:'m',revision:1,partId:'body',context:{kind:'MESSAGE'}}]})},{id:'corrected-body',type:'text',text:'不同主张'},{id:'data',type:'data',value:{kind:'RELATION',uiType:'CORRECT',correctionKind:'MEANING',correctionBeforeContent:'旧主张',correctionAfterContent:'不同主张'}}]};
  const change:Change={sequence:1,previousSequence:0,messages:[base,correction],memberships:[],removedMemberships:[],states:[],ledger:[],treasury:{operating:0,issued:0}};
  const input={format:'gonglun-2',formatVersion:4,scope:{title:'旧文件',messageId:null},view:{homeFilter:{scope:'related',status:'pending-versions'}},messages:[base,{...correction,kind:'RELATION',relationType:'CORRECT',content:'不同主张'}],relations:[],changes:[change]},before=structuredClone(input);
  const converted=migrateViewFile(input),replay=replayArchive(converted),current=converted.messages.find((message:any)=>message.id==='c');
  expect(input).toEqual(before);expect(converted.formatVersion).toBe(5);expect(converted.changes).toHaveLength(2);expect(converted.changes[0]).toEqual(change);
  expect(current).toMatchObject({revision:1,kind:'TEXT',sequence:2});expect(current.relationType).toBeUndefined();expect(current.parts.some((part:any)=>part.type==='relation')).toBe(false);
  const reference=converted.messages.find((message:any)=>message.id==='reference:c');expect(reference).toMatchObject({revision:1,kind:'RELATION',relationType:'REFERENCE',sourceMessageId:'c',relationPayload:{label:'修正原意'}});expect(reference.targetRefs[0].messageId).toBe('m');
  expect(converted.view.homeFilter).toEqual({scope:'related',status:'pending'});
  expect(converted.changes[1].ledger).toEqual([]);expect(replay.operating).toBe(0);expect(replay.issued).toBe(0);expect(replay.revisions.get('c')).toHaveLength(1);expect(replay.revisions.get('c')![0].parts).toEqual(current.parts);
  expect(migrateViewFile(converted)).toEqual(converted);
});

it('refuses future formats and missing historical journal entries instead of rewriting them as current',()=>{
  expect(()=>migrateViewFile({formatVersion:99,messages:[],relations:[]})).toThrow('版本比当前程序更新');
  expect(()=>migrateViewFile({messages:[{id:'same'},{id:'same'}],relations:[]})).toThrow('编号缺失或重复');
  const change={sequence:2,messages:[],memberships:[],removedMemberships:[],states:[],ledger:[],treasury:{operating:0,issued:0}};
  expect(()=>migrateViewFile({format:'gonglun-2',messages:[],relations:[],changes:[change]})).toThrow('旧执行记录不连续');
});

it('preserves old economic audit inputs and reconstructs relations without claiming a new ledger replay',()=>{
  const identity={createdById:'original-user',createdAt:'2026-01-01T00:00:00.000Z'};
  const input={formatVersion:1,exportKind:'economic-audit',topicId:'topic',topic:{title:'审计内容'},messages:[
    {...identity,id:'text',kind:'TEXT',content:'前原文后'},
    {...identity,id:'correction',kind:'RELATION',relationType:'CORRECT',content:'',relSourceId:null,
      targetRefs:[{kind:'text-fragment',messageId:'text',text:'原文'}],relationPayload:{correctionContent:'前替换后'}},
  ],stakes:[{id:'old-stake',userId:'original-user',amount:19,side:'PRO'}],auditEvents:[{id:'audit',relationType:'UNFOLLOW',signature:'keep-signature'}],votes:[],rounds:[],rules:[]};
  const converted=migrateViewFile(input),validated=validateExportForViewing(converted);
  expect(validated.verification).toBeNull();
  expect(converted.sourceAudit).toEqual({stakes:input.stakes,auditEvents:input.auditEvents,votes:input.votes,rounds:input.rounds,rules:input.rules});
  expect(converted.messages[0].authorId).toBe('original-user');
  expect(converted.relations[0].parts).toContainEqual({id:'corrected-body',type:'text',text:'前替换后'});
  expect(archiveToWorkbenchSnapshot(converted).stakes).toEqual({});
  expect(migrateViewFile(converted)).toEqual(converted);
});
