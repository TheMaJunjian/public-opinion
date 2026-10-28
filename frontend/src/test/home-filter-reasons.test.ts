import {describe,expect,it} from 'vitest';
import {bodyVersion,messageReadingKey} from '@gonglun/core';
import {deriveHomeFilterResult} from '../pages/workbench/projections/homeFilterResult';
import type {DemoMessage,DemoEdge} from '../utils/modelBridge';
import type {Relation} from '../types';

const user={id:'me',username:'新名字',createdAt:'2026-01-01'};
const message=(id:string,authorId='other'):DemoMessage=>({id,kind:'normal',author:'旧名字',authorId,content:id,createdAt:'2026-01-01'});
const derive=(messages:DemoMessage[],extra:Partial<Parameters<typeof deriveHomeFilterResult>[0]>={})=>deriveHomeFilterResult({
  displayUser:user,homeFilterMode:{scope:'self',status:'all'},messages,msgMap:new Map(messages.map(message=>[message.id,message])),
  edges:[],relations:[],traceContainerMemberships:[],readStatusByMessageId:new Map(),...extra})!;

describe('home filter match explanations',()=>{
  it('uses author identity after a rename and explains context without treating it as a match',()=>{
    const mine=message('mine','me'),background={...message('background'),author:user.username};
    const edge:DemoEdge={id:'cite',relationMessageId:'cite',relationType:'reference',relationLabel:'引用',
      from:{messageId:'mine',selection:{kind:'whole'}},to:{messageId:'background',selection:{kind:'whole'}}};
    const result=derive([mine,background],{edges:[edge]});
    expect(result.matchIds).toEqual(new Set(['mine']));
    expect(result.reasonByMessageId.get('mine')).toBe('由本人发送');
    expect(result.reasonByMessageId.get('background')).toContain('未直接命中');
    expect(result.reasonByMessageId.get('background')).toContain('mine');
    expect(result.reasonByMessageId.get('background')).toContain('引用 cite');
  });
  it('explains the exact related record and pending influences',()=>{
    const mine=message('mine','me'),other=message('other'),record={...message('reply'),kind:'relation' as const,relationType:'reply' as const};
    const edge:DemoEdge={id:'reply',relationMessageId:'reply',relationType:'reply',relationLabel:'reply',
      from:{messageId:'other',selection:{kind:'whole'}},to:{messageId:'mine',selection:{kind:'whole'}}};
    const result=derive([mine,other,record],{edges:[edge],homeFilterMode:{scope:'related',status:'pending'}});
    expect(result.reasonByMessageId.get('other')).toContain('回复消息 reply 与本人消息 mine 关联');
    expect(result.reasonByMessageId.get('other')).toContain('待确认的影响消息：reply');
  });
  it('explains why a read container is pending when its member has not been read',()=>{
    const container={...message('container','me'),kind:'relation' as const,relationType:'classify' as const},member=message('member');
    const version=bodyVersion(container.id),key=messageReadingKey(container.id);
    const result=derive([container,member],{homeFilterMode:{scope:'self',status:'pending'},
      traceContainerMemberships:[{containerId:'container',targetIds:['member'],relationType:'classify'}],
      readingMarks:[{format:3,messageId:container.id,scope:'message',version,key,bodySignature:key,signature:'seen'}]});
    expect(result.reasonByMessageId.get('container')).toContain('容器内仍有待确认的消息：member');
    expect(result.reasonByMessageId.get('container')).not.toContain('正文未阅');
  });
  it('explains followed container descendants and outer context',()=>{
    const messages=[message('outer'),{...message('container'),kind:'relation' as const,relationType:'classify' as const},message('member')];
    const relation:Relation={id:'follow',relationType:'ATTENTION',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'container'}],createdAt:'2026-01-01',createdBy:{...user,username:'旧名字'}};
    const result=derive(messages,{relations:[relation],homeFilterMode:{scope:'following',status:'all'},
      traceContainerMemberships:[{containerId:'outer',targetIds:['container'],relationType:'classify'},{containerId:'container',targetIds:['member'],relationType:'classify'}]});
    expect(result.matchIds).toEqual(new Set(['container','member']));
    expect(result.reasonByMessageId.get('member')).toContain('容器 container');
    expect(result.reasonByMessageId.get('member')).toContain('关注记录 follow');
    expect(result.reasonByMessageId.get('outer')).toContain('外层容器');
    expect(result.reasonByMessageId.get('outer')).toContain('未直接命中');
    expect(derive(messages,{homeFilterMode:null})).toBeNull();
  });
});
