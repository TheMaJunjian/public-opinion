import {expect,it} from 'vitest';
import {reviewContextPart,reviewContextOf,selectReviewDiscussion} from './review-context.js';
import {messageDisplayDependency} from './display-dependency.js';
import type {Message,Part} from './types.js';

const scope={messageId:'original',revision:2};
const message=(id:string,parts:Part[])=>({id,parts}) as Message;
const relation=(name:string,id:string,role='target'):Part=>({id:name,type:'relation',relation:name,roles:{[role]:[{id:'target',reference:{messageId:id}}]}});
it('retains the exact review version and keeps scope metadata out of the vote',()=>{
  const value=message('reply',[{id:'body',type:'text',text:'理由讨论'},reviewContextPart(scope)]);
  expect(reviewContextOf(value)).toEqual(scope);
  expect(messageDisplayDependency(value)).toEqual([scope]);
  expect(reviewContextOf(message('unscoped',[]))).toBeUndefined();
});
it('includes connected discussion and its source text, without crossing another review version',()=>{
  const vote=message('vote',[{id:'review',type:'relation',relation:'review',roles:{target:[{id:'target',reference:scope}]}},
    {id:'data',type:'data',value:{caseId:'case',verdict:'pass'}}]);
  const source=message('source',[{id:'body',type:'text',text:'旧讨论正文'}]);
  const reply=message('reply',[{...relation('reply','vote'),roles:{target:[{id:'t',reference:{messageId:'vote'}}],source:[{id:'s',reference:{messageId:'source'}}]}} as Part]);
  const corrected=message('correction',[relation('correct','vote')]);
  const scoped=message('category',[relation('classify','vote','members'),reviewContextPart(scope)]);
  const foreign=message('foreign',[relation('reply','vote'),reviewContextPart({...scope,revision:3})]);
  const originalReply=message('ordinary',[relation('reply','original')]);
  const records=[source,reply,corrected,vote,scoped,foreign,originalReply,reply];
  expect(selectReviewDiscussion(records,scope,'case').map(value=>value.id)).toEqual(['source','reply','correction','vote','category']);
});
it('excludes enrollment, settlement and system process records from review discussion',()=>{
  const records=['review','review-appeal','review-record','review-enrollment','review-settle','review-finalize'].map(name=>message(name,[
    {id:'relation',type:'relation',relation:name,roles:{target:[{id:'t',reference:scope}]}},
    {id:'data',type:'data',value:{caseId:'case'}},
  ]));
  expect(selectReviewDiscussion(records,scope,'case').map(record=>record.id)).toEqual(['review','review-appeal']);
});
