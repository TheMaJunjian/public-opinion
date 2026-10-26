import {describe,expect,it} from 'vitest';
import {applyReadingVersions,createReadingVersionHistory,knownReadingBodyVersions,readingVersionChoices,readingVersionNavigation,selectedReadingVersion} from '../pages/workbench/model/readingVersions';
import {bodyVersion,bodyVersionKey,type ReadingMark} from '@gonglun/core';
import type {CorrectionVersion,DemoMessage} from '../utils/modelBridge';

describe('message version viewing',()=>{
  it('does not offer retired meaning changes as revisions of the new independent message',()=>{
    const version=bodyVersion('m',1,[{messageId:'independent',revision:1,kind:'MEANING'}]);
    expect(knownReadingBodyVersions('m',[{format:2,messageId:'m',scope:'message',key:bodyVersionKey(version),version}],[])).toEqual([]);
  });
  it('recovers only recorded or cited historical combinations after reopening and displays frozen history without current candidates',()=>{
    const version=bodyVersion('m',1,[{messageId:'c',revision:1,kind:'TEXT'}]),key=bodyVersionKey(version);
    const mark:ReadingMark={format:2,version,messageId:'m',scope:'message',key,bodySignature:key};
    expect(knownReadingBodyVersions('m',[mark,mark],[])).toEqual([version]);
    const history=createReadingVersionHistory();history.freeze('m',{bodyVersion:version,correctionId:key,targetId:'m',baseContent:'原文',content:'历史组合',valid:false,createdAt:''});
    expect(applyReadingVersions(new Map(),history.getSnapshot(),[]).get('m')?.current?.content).toBe('历史组合');
  });
  const version=(id:string,content:string):CorrectionVersion=>({correctionId:id,targetId:'m',content,baseContent:'原文',valid:true,createdAt:''});
  it.each([
    ['原文','原文',['原文','推荐选择','当前用户选择'],[[],[],[]]],
    ['新版本','新版本',['原文','推荐选择','当前用户选择'],[[],[],[]]],
    ['个人版本','原文',['原文','推荐选择','当前用户选择'],[[],[],[]]],
    ['原文','推荐版本',['原文','推荐选择','当前用户选择'],[[],[],[]]],
    ['个人版本','推荐版本',['原文','推荐选择','当前用户选择'],[[],[],[]]],
  ])('merges equivalent sources for personal=%s and recommended=%s',(personal,recommended,labels,sameAs)=>{
    const choices=readingVersionChoices('原文',version('p',personal as string),version('r',recommended as string),true);
    expect(choices.map(choice=>choice.label)).toEqual(labels);expect(choices.map(choice=>choice.sameAs)).toEqual(sameAs);
    expect(new Set(choices.map(choice=>choice.identity)).size).toBe(choices.length);
  });
  it('omits the personal source when the user has not chosen, even if the default matches the recommendation',()=>{
    const recommended=version('r','推荐正文');
    expect(readingVersionChoices('原文',recommended,recommended,false).map(({identity,...choice})=>{void identity;return choice;})).toEqual([
      {value:'original',label:'原文',content:'原文',sameAs:[]},
      {value:'recommended',label:'推荐选择',content:'推荐正文',sameAs:[]},
    ]);
    expect(readingVersionChoices('原文',undefined,undefined,false).map(({identity,...choice})=>{void identity;return choice;})).toEqual([
      {value:'recommended',label:'原文',content:'原文',sameAs:['推荐选择']},
    ]);
  });
  it('uses the complete recommended composition and the actual personal choice without changing either',()=>{
    const first=version('c1','个人版本'),second=version('c2','推荐版本'),composed={...second,content:'推荐组合',appliedCorrectionIds:['c2','c3'],changes:[{start:0,end:2,replacement:'推荐组合'}]};
    const personal=new Map([['m',{current:first,versions:[first,second]}]]),recommended=new Map<string,{current?:CorrectionVersion;versions:CorrectionVersion[]}>([['m',{current:composed,versions:[first,second]}]]);
    const history=createReadingVersionHistory(),messages=[{id:'m',content:'原文'} as DemoMessage];
    history.select('m','recommended');
    expect(applyReadingVersions(personal,history.getSnapshot(),messages,recommended).get('m')?.current).toBe(composed);
    history.select('m','personal');expect(applyReadingVersions(recommended,history.getSnapshot(),messages,recommended,personal).get('m')?.current).toBe(first);
    history.select('m','original');expect(applyReadingVersions(personal,history.getSnapshot(),messages,recommended).get('m')?.current).toBeUndefined();
    expect(personal.get('m')?.current).toBe(first);expect(recommended.get('m')?.current).toBe(composed);
    history.select('m','recommended');recommended.set('m',{current:undefined,versions:[first,second]});
    expect(applyReadingVersions(personal,history.getSnapshot(),messages,recommended).get('m')?.current).toBeUndefined();
  });
  it('keeps independent back/forward history and discards a replaced forward branch',()=>{
    const history=createReadingVersionHistory(),snapshots:unknown[]=[];
    history.subscribe(()=>snapshots.push(history.getSnapshot()));
    expect(selectedReadingVersion(history.getSnapshot(),'m')).toBe('current');
    history.select('m','original');history.select('m','c1');history.select('other','c9');
    const before=history.getSnapshot();history.back('m');
    expect(selectedReadingVersion(history.getSnapshot(),'m')).toBe('original');
    expect(selectedReadingVersion(history.getSnapshot(),'other')).toBe('c9');
    history.forward('m');expect(selectedReadingVersion(history.getSnapshot(),'m')).toBe('c1');
    history.back('m');history.select('m','c2');history.forward('m');
    expect(history.getSnapshot().get('m')).toEqual({values:['current','original','c2'],index:2});
    expect(before.get('m')).toEqual({values:['current','original','c1'],index:2});
    const count=snapshots.length;history.select('m','c2');history.forward('m');expect(snapshots).toHaveLength(count);
  });
  it('keeps distinct version sources reachable even when their current texts match',()=>{
    const history=createReadingVersionHistory();
    for(const value of ['original','missing-correction','personal','recommended'])history.select('m',value);
    const texts=new Map([['current','新正文'],['original','原文'],['personal','新正文'],['recommended','新正文']]);
    const contentFor=(value:string)=>texts.get(value);
    expect(readingVersionNavigation(history.getSnapshot(),'m',contentFor)).toEqual({back:3,forward:undefined});
    history.back('m',contentFor);expect(selectedReadingVersion(history.getSnapshot(),'m')).toBe('personal');
    history.forward('m',contentFor);expect(selectedReadingVersion(history.getSnapshot(),'m')).toBe('recommended');
    const before=history.getSnapshot();history.forward('m',contentFor);expect(history.getSnapshot()).toBe(before);
    texts.set('original','新正文');
    expect(readingVersionNavigation(history.getSnapshot(),'m',contentFor)).toEqual({back:3,forward:undefined});
    history.back('m',contentFor);expect(selectedReadingVersion(history.getSnapshot(),'m')).toBe('personal');
  });
  it('can change an equal-content source without adding a visit or losing its confirmation context',()=>{
    const history=createReadingVersionHistory();history.select('m','original',false);
    expect(history.getSnapshot().get('m')).toEqual({values:['original'],index:0});
    history.back('m');expect(selectedReadingVersion(history.getSnapshot(),'m')).toBe('original');
    history.select('m','recommended',false);
    expect(history.getSnapshot().get('m')).toEqual({values:['recommended'],index:0});
    history.select('m','original');history.back('m');
    history.select('m','personal',false);
    expect(history.getSnapshot().get('m')).toEqual({values:['personal','original'],index:0});
  });
  it('projects an individual version and original without changing effective corrections',()=>{
    const version:CorrectionVersion={correctionId:'c1',targetId:'m',content:'start new end',baseContent:'start old end',valid:true,createdAt:''};
    const corrections=new Map([['m',{current:{...version,content:'current'},versions:[version]}]]);
    const messages=[{id:'m',content:'start old end'} as DemoMessage],history=createReadingVersionHistory();
    history.select('m','c1');
    expect(applyReadingVersions(corrections,history.getSnapshot(),messages).get('m')?.current).toMatchObject({
      content:'start new end',appliedCorrectionIds:['c1'],changes:[{start:6,end:9,replacement:'new'}]});
    history.select('m','original');expect(applyReadingVersions(corrections,history.getSnapshot(),messages).get('m')?.current).toBeUndefined();
    history.select('m','current');expect(applyReadingVersions(corrections,history.getSnapshot(),messages).get('m')?.current?.content).toBe('current');
    expect(corrections.get('m')?.current.content).toBe('current');
  });
});
