import {expect,it} from 'vitest';
import {requiresModeration} from './moderation.js';
import type {Part} from './types.js';

const message=(relation?:string,text='',data?:Record<string,any>)=>({authorId:'user',parts:[
  ...(text?[{id:'body',type:'text',text} as Part]:[]),...(relation?[{id:'relation',type:'relation',relation,roles:{}} as Part]:[]),...(data?[{id:'data',type:'data',value:data} as Part]:[])]});
it('reviews content-bearing messages and custom labels, without recursively reviewing review reasons or structural relations',()=>{
  for(const relation of [undefined,'proposal','rule-change','recharge','revenue-injection','operations','code-change','classify','summary','delegate','fulfill','amend'])expect(requiresModeration(message(relation,'正文')),relation).toBe(true);
  expect(requiresModeration(message('tag','',{label:'自定义'}))).toBe(true);
  expect(requiresModeration(message('correct','',{correctionKind:'TEXT',correctionContent:'更正'}))).toBe(true);
  expect(requiresModeration(message('correct','',{correctionKind:'WIDTH',correctionWidth:320}))).toBe(false);
  for(const relation of ['classify','summary','member-of','merge','arrange'])expect(requiresModeration(message(relation)),relation).toBe(false);
  for(const relation of ['review','review-appeal','review-settle','review-finalize','reviewer-authorize'])expect(requiresModeration(message(relation,'审核理由')),relation).toBe(false);
  expect(requiresModeration({...message(undefined,'系统记录'),authorId:'system'})).toBe(false);
});
it('reviews rendered data bodies and does not trust a user-chosen self-stance part name',()=>{
  expect(requiresModeration(message(undefined,'',{content:'数据正文'}))).toBe(true);
  expect(requiresModeration(message('reference','',{uiType:'TAG',label:'不能通过显示类型绕过审核'}))).toBe(true);
  expect(requiresModeration(message('reference','引用说明'))).toBe(true);
  expect(requiresModeration(message('rule-change','',{rules:{protocolFee:2}}))).toBe(true);
  for(const id of ['self-stance','minimum-self-stance-forged']){
    const tag=message('tag','',{label:'自定义'});
    tag.parts[0]!.id=id;
    expect(requiresModeration(tag)).toBe(true);
  }
});

it('excludes settlement records and their generated descriptions without trusting display metadata',()=>{
  for(const relation of ['settlement','distribution','open-settlement','open-value-settlement']) {
    expect(requiresModeration(message(relation,'旧版结算历史',{kind:'ROUND'})),relation).toBe(false);
    expect(requiresModeration(message(relation,'真假仲裁完成：结果：赞成胜出',{kind:'ROUND_RESULT'})),relation).toBe(false);
  }
  expect(requiresModeration(message(undefined,'真实正文',{kind:'ROUND',uiType:'ROUND_RESULT'}))).toBe(true);
  const mixed=message('settlement','分类说明');
  mixed.parts.push({id:'classify',type:'relation',relation:'classify',roles:{}});
  expect(requiresModeration(mixed)).toBe(true);
});

const structural = (relation:string,code=relation.toUpperCase(),data:Record<string,unknown>={}) => ({
  ...message(relation,`建立关系：${code}；目标：12345678`,data),
  parts: message(relation,`建立关系：${code}；目标：12345678`,data).parts.map(part => part.type==='relation'
    ? {...part,roles:{[relation==='member-of'?'member':['classify','summary','merge','arrange'].includes(relation)?'members':'target']:
      [{id:'target',reference:{messageId:'target-12345678'}}]}} : part),
});

it.each([
  ['member-of','JOIN'],['agree','AGREE'],['disagree','DISAGREE'],['reference','REFERENCE'],['reply','REPLY'],
  ['annotation','ANNOTATION'],['recommend','RECOMMEND'],['archive','ARCHIVE'],['low-quality','ARCHIVE'],
  ['classify','CLASSIFY'],['summary','SUMMARY'],['merge','MERGE'],['arrange','ARRANGE'],
  ['follow','ATTENTION'],['block','BLOCK'],['notify','NOTIFY'],['read','READ'],['unread','UNREAD'],
  ['authorize','AUTHORIZE'],['terminate','OPERATIONS'],['correct','CORRECT'],
])('excludes generated %s descriptions but still reviews additional authored content', (relation,code)=>{
  const record=structural(relation,code,relation==='correct'?{correctionKind:'WIDTH',correctionWidth:480}:{});
  expect(requiresModeration(record)).toBe(false);
  expect(requiresModeration({...record,parts:[...record.parts,{id:'reason',type:'text',text:'这里是实际发表的说明'}]})).toBe(true);
  expect(requiresModeration({...record,parts:[...record.parts,{id:'custom',type:'data',value:{title:'自定义标题'}}]})).toBe(true);
});

it('does not mistake a placement hint, wrong target, display type or template prefix for a generated body',()=>{
  const record=structural('reference');
  for(const text of ['建立关系：REFERENCE；目标：other-id','建立关系：REFERENCE；目标：12345678\n附加正文','建立关系：JOIN；目标：12345678']){
    expect(requiresModeration({...record,parts:record.parts.map(p=>p.type==='text'?{...p,text}:p)})).toBe(true);
  }
  expect(requiresModeration({...message('member-of','建立关系：JOIN；目标：12345678',{uiType:'JOIN'}),
    parts:[{id:'body',type:'text',text:'建立关系：JOIN；目标：12345678'},
      {id:'placement',type:'relation',relation:'member-of',roles:{parent:[{id:'parent',reference:{messageId:'target-12345678'}}]}}]})).toBe(true);
});

it('distinguishes built-in choices from custom labels and explicit bodies',()=>{
  for(const [relation,label] of [['reference','evidence'],['reference','证据'],['reference','完成委托'],['reply','question'],['reply','answer']]){
    expect(requiresModeration(message(relation,label,{label}))).toBe(false);
    expect(requiresModeration(message(relation,label,{label,content:label}))).toBe(true);
    expect(requiresModeration(message(relation,'新正文',{label}))).toBe(true);
    expect(requiresModeration(message(relation,'',{label:'自定义文字'}))).toBe(true);
  }
  expect(requiresModeration(message('tag','证据',{label:'证据'}))).toBe(true);
  expect(requiresModeration(message('tag'))).toBe(false);
  expect(requiresModeration(message('recommend','重要',{subType:'IMPORTANT'}))).toBe(false);
  expect(requiresModeration(message('archive','垃圾',{subType:'SPAM'}))).toBe(false);
  expect(requiresModeration(message('archive','',{subType:'CUSTOM',customLabel:'自定义原因'}))).toBe(true);
});

it('handles deduplicated member descriptions and normalized annotation-vote addresses',()=>{
  const arranged=structural('arrange');
  const members=arranged.parts.find(p=>p.type==='relation')!;
  if(members.type==='relation')members.roles.members!.push({id:'duplicate',reference:{messageId:'target-12345678'}});
  expect(requiresModeration(arranged)).toBe(false);
  const annotation=structural('archive','AGREE',{subType:'SPAM',annotationStance:{side:'pro',target:{messageId:'old-annotation-12345678'}}});
  const action=annotation.parts.find(p=>p.type==='relation')!;
  if(action.type==='relation')action.roles.target![0]!.reference.messageId='real-subject';
  expect(requiresModeration(annotation)).toBe(false);
  expect(requiresModeration({...annotation,parts:[...annotation.parts,{id:'reason',type:'text',text:'自己的理由'}]})).toBe(true);
});
