import {describe,it,expect} from 'vitest';
import {bodyVersion,bodyVersionKey,meaningVersionKey,materializeBodyVersion,contextMatches} from './body-versions.js';
import {referenceKey,resolveReference} from './model.js';
import type {Message} from './types.js';

const original:Message={id:'m',revision:1,authorId:'a',createdAt:'',updatedAt:'',regionId:'r',ledgerId:'l',programVersion:'2',ruleVersion:1,sequence:1,spending:{protocol:1,recommendation:0,wager:0},parts:[{id:'body',type:'text',text:'甲乙'}]};
const edit=(id:string,start:number,end:number,replacement:string,kind:'TEXT'|'MEANING'='TEXT'):Message=>({...original,id,sequence:2,parts:[{id:'relation',type:'relation',relation:'correct',roles:{target:[{id:'t',reference:{messageId:'m',revision:1,partId:'body',range:{start,end}}}]}},{id:'corrected-body',type:'text',text:'甲乙'.slice(0,start)+replacement+'甲乙'.slice(end)},{id:'data',type:'data',value:{correctionKind:kind,correctionBeforeContent:'甲乙'}}]});
const t={messageId:'t',revision:1,kind:'TEXT' as const},a={messageId:'a',revision:1,kind:'MEANING' as const};
const messages=[original,edit('t',0,1,'丙'),edit('a',1,2,'丁','MEANING'),edit('conflict',0,2,'冲突')];
const resolve=(id:string,revision?:number)=>messages.find(m=>m.id===id&&(!revision||m.revision===revision));

describe('immutable body versions and contract contexts',()=>{
  it('normalizes a set and retains both base and correction revisions',()=>{
    expect(meaningVersionKey(bodyVersion('m'))).not.toBe(bodyVersionKey(bodyVersion('m')));
    expect(bodyVersionKey(bodyVersion('m',1,[t,a,t]))).toBe(bodyVersionKey(bodyVersion('m',1,[a,t])));
    expect(bodyVersionKey(bodyVersion('m',2,[a,t]))).not.toBe(bodyVersionKey(bodyVersion('m',1,[a,t])));
    expect(bodyVersionKey(bodyVersion('m',1,[{...t,revision:2}]))).not.toBe(bodyVersionKey(bodyVersion('m',1,[t])));
    expect(()=>bodyVersion('m',1,[t,{...t,revision:2}])).toThrow('不一致');
  });
  it('reconstructs compatible edits without changing the original or consulting votes',()=>{
    const before=JSON.stringify(messages),version=bodyVersion('m',1,[a,t]);
    expect(materializeBodyVersion(version,resolve).parts[0]).toEqual({id:'body',type:'text',text:'丙丁'});
    expect(resolveReference({messageId:'m',revision:1,partId:'body',range:{start:1,end:2},context:{kind:'BODY',version}},resolve)).toBe('丁');
    expect(JSON.stringify(messages)).toBe(before);
  });
  it('rejects cross-message, stale, missing and overlapping edits',()=>{
    expect(()=>materializeBodyVersion(bodyVersion('m',2,[t]),resolve)).toThrow();
    expect(()=>materializeBodyVersion(bodyVersion('elsewhere',1,[t]),resolve)).toThrow();
    expect(()=>materializeBodyVersion(bodyVersion('m',1,[{...t,revision:2}]),resolve)).toThrow();
    expect(()=>materializeBodyVersion(bodyVersion('m',1,[t,{messageId:'conflict',revision:1,kind:'TEXT'}]),resolve)).toThrow('冲突');
  });
  it('shares text-fix meaning but never shares complete-body reading or composite meanings',()=>{
    expect(meaningVersionKey(bodyVersion('m',1,[a,t]))).toBe(meaningVersionKey(bodyVersion('m',1,[a])));
    expect(bodyVersionKey(bodyVersion('m',1,[a,t]))).not.toBe(bodyVersionKey(bodyVersion('m',1,[a])));
    expect(meaningVersionKey(bodyVersion('m',1,[a]))).not.toBe(meaningVersionKey(bodyVersion('m',1,[])));
    expect(contextMatches({kind:'UNKNOWN'},bodyVersion('m'))).toBe(false);
  });
  it('keeps legacy money keys byte-for-byte while isolating new contracts',()=>{
    const ref={messageId:'m',revision:1},legacy=referenceKey(ref);
    expect(referenceKey({...ref,context:{kind:'UNKNOWN'}})).toBe(legacy);
    const originalKey=referenceKey({...ref,context:{kind:'MEANING',version:bodyVersion('m')}});
    expect(referenceKey({...ref,context:{kind:'MEANING',version:bodyVersion('m',1,[t])}})).toBe(originalKey);
    expect(referenceKey({...ref,context:{kind:'MEANING',version:bodyVersion('m',1,[a])}})).not.toBe(originalKey);
    expect(originalKey).not.toBe(legacy);
  });
});
