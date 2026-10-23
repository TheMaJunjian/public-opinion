import {expect,it} from 'vitest';
import {migrateViewFile} from './migrate-view-file.js';

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
  expect(migrateViewFile(explicit).relations[0].targetRefs[0].reference).toEqual(exact);
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
