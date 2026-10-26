import {describe,expect,it} from 'vitest';
import {computeCorrectionVersions,type DemoEdge,type DemoMessage} from '../utils/modelBridge';
import {bodyAuthorInvestment,deriveMessageAuthorship,messageAuthorInvestment} from '../utils/messageAuthorship';
import {applyReadingVersions,createReadingVersionHistory} from '../pages/workbench/model/readingVersions';
import {projectWorkbenchSnapshot} from '../utils/workbenchProjection';
import type {MessageStakes,StakeItem,WorkbenchSnapshot} from '@gonglun/core';
import {buildRelationDemoMessage} from '../pages/workbench/model/relationComposition';

const message=(id:string,author='甲',content='甲乙丙丁'):DemoMessage=>({id,author,authorId:author,content,kind:'normal',createdAt:'2026-10-20T00:00:00Z',spending:{protocol:1,wager:3,recommendation:5}});
const correction=(id:string,author:string,after:string,start?:number,len=1)=>{
  const source:DemoMessage={...message(id,author,after),kind:'relation',relationType:'correct',relationPayload:{correctionBeforeContent:'甲乙丙丁',correctionAfterContent:after}};
  const edge:DemoEdge={id:`edge-${id}`,relationMessageId:id,relationType:'correct',relationLabel:'更正',
    from:{messageId:`anon:${id}`,selection:{kind:'whole'}},to:{messageId:'m',selection:start===undefined?{kind:'whole'}:{kind:'text',start,len,text:'甲乙丙丁'.slice(start,start+len)}}};
  return {source,edge};
};
function fixture(changes:ReturnType<typeof correction>[]){
  const original=message('m'),messages=[original,...changes.map(change=>change.source)],edges=changes.map(change=>change.edge);
  const records=new Map(messages.map(message=>[message.id,message])),versions=computeCorrectionVersions(messages,edges);
  return {original,messages,records,versions,authors:()=>deriveMessageAuthorship(original,versions.get('m'),records)};
}
const position=(id:string,amount:number,type:'TRUTH'|'VALUE'='TRUTH',author='甲',side:'PRO'|'CON'='PRO'):StakeItem=>({id,amount,side,settlementType:type,createdAt:'2026-10-21',user:{id:author,username:author,createdAt:''}});
const stakes=(positions:StakeItem[]):MessageStakes=>({messageId:'m',stakes:positions,pool:{lockedPro:0,lockedCon:0},counts:{pro:999,con:999}});

describe('current body authors and sender investments',()=>{
  it('keeps the original and attributes independent partial changes to their actual sources',()=>{
    const view=fixture([correction('c1','乙','甲新丙丁',1),correction('c2','丙','甲乙丙末',3)]),authors=view.authors();
    expect(view.versions.get('m')?.current?.content).toBe('甲新丙末');
    expect(authors.authors.map(author=>author.name)).toEqual(['甲','乙','丙']);
    expect(authors.original.content).toBe('甲…丙');
    expect(authors.authors[1].contributions.map(source=>[source.message.id,source.content])).toEqual([['c1','新']]);
    expect(authors.authors[2].contributions.map(source=>[source.message.id,source.content])).toEqual([['c2','末']]);
  });
  it('does not count a fully replaced original as a current author, but retains its sender and separate investment',()=>{
    const view=fixture([correction('c','乙','完整替换')]),authors=view.authors();
    expect(authors.authors.map(author=>author.name)).toEqual(['乙']);expect(authors.original.contributes).toBe(false);
    expect(authors.original.investment.total).toEqual({truth:3,value:5});
  });
  it('deduplicates a person while keeping each correction and its investment separate',()=>{
    const view=fixture([correction('c1','乙','甲新丙丁',1),correction('c2','乙','甲乙丙末',3)]);
    view.records.get('c2')!.spending={protocol:1,wager:8,recommendation:2};
    const authors=view.authors();expect(authors.authors).toHaveLength(2);
    expect(authors.authors[1].contributions.map(source=>source.investment.total)).toEqual([{truth:3,value:5},{truth:8,value:2}]);
  });
  it('counts an original and multiple corrections from the same sender as one person, including immediately after sending',()=>{
    const view=fixture([correction('c1','甲','甲新丙丁',1),correction('c2','甲','甲乙丙末',3)]);
    const immediate=buildRelationDemoMessage({id:'c1',relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'m'}],
      createdAt:'2026-10-21',createdBy:{id:'甲',username:'甲',createdAt:''},spending:{protocol:1,wager:3,recommendation:5},
      payload:{correctionBeforeContent:'甲乙丙丁',correctionAfterContent:'甲新丙丁'}});
    expect(immediate.authorId).toBe('甲');view.records.set('c1',immediate);
    const authors=view.authors();expect(authors.authors).toHaveLength(1);
    expect(authors.authors[0].contributions.map(source=>source.message.id).sort()).toEqual(['c1','c2','m']);
    expect(bodyAuthorInvestment(authors.authors[0]).total).toEqual({truth:9,value:15});
  });
  it('counts the same account once when its name changes across the original and several corrections',()=>{
    const view=fixture([correction('c1','甲','甲新丙丁',1),correction('c2','甲','甲乙丙末',3)]);
    view.records.get('c1')!.author='新名字';view.records.get('c2')!.author='再次改名';
    expect(view.authors().authors).toHaveLength(1);expect(view.authors().authors[0].contributions).toHaveLength(3);
    expect(bodyAuthorInvestment(view.authors().authors[0]).total).toEqual({truth:9,value:15});
  });
  it.each(['m','c1','c2'])('does not infer source %s identity from its name when its ID is missing',missingId=>{
    const view=fixture([correction('c1','甲','甲新丙丁',1),correction('c2','甲','甲乙丙末',3)]);
    view.records.get(missingId)!.authorId=undefined;
    expect(view.authors().authors).toHaveLength(2);
    expect(view.authors().authors.find(author=>author.key===`message:${missingId}`)?.contributions.map(source=>source.message.id)).toEqual([missingId]);
  });
  it('does not merge multiple unidentified sources just because their names match',()=>{
    const view=fixture([correction('c1','甲','甲新丙丁',1),correction('c2','甲','甲乙丙末',3)]);
    for(const source of view.records.values())source.authorId=undefined;
    expect(view.authors().authors).toHaveLength(3);
  });
  it('keeps distinct known accounts separate even if their displayed names match',()=>{
    const view=fixture([correction('c1','甲','甲新丙丁',1)]);view.records.get('c1')!.authorId='另一个账户';
    expect(view.authors().authors).toHaveLength(2);
  });
  it('totals the displayed sources for one person once and preserves an unknown first investment',()=>{
    const view=fixture([correction('c1','乙','甲新丙丁',1),correction('c2','乙','甲乙丙末',3)]);
    view.records.get('c2')!.authorInvestment={total:{truth:10,value:6},initial:{truth:8,value:2},additional:{truth:2,value:4}};
    const author=view.authors().authors[1];author.contributions.push(author.contributions[0]);
    expect(bodyAuthorInvestment(author)).toEqual({total:{truth:13,value:11},initial:{truth:11,value:7},additional:{truth:2,value:4}});
    author.contributions[1].investment={total:{truth:10,value:6}};
    expect(bodyAuthorInvestment(author)).toEqual({total:{truth:13,value:11}});
  });
  it('credits a deletion and ignores a no-op correction',()=>{
    const removed=fixture([correction('c','乙','甲丙丁',1)]).authors();
    expect(removed.authors.map(author=>author.name)).toEqual(['甲','乙']);expect(removed.authors[1].contributions[0].content).toBe('');
    expect(fixture([correction('noop','乙','甲乙丙丁')]).authors().authors.map(author=>author.name)).toEqual(['甲']);
  });
  it('follows the displayed original and different correction sources',()=>{
    const view=fixture([correction('c1','乙','第一版'),correction('c2','丙','第二版')]),history=createReadingVersionHistory();
    history.select('m','original');
    const authors=()=>deriveMessageAuthorship(view.original,applyReadingVersions(view.versions,history.getSnapshot(),view.messages).get('m'),view.records);
    expect(authors().authors.map(author=>author.name)).toEqual(['甲']);
    history.select('m','c1');expect(authors().authors.map(author=>author.name)).toEqual(['乙']);
    history.select('m','c2');expect(authors().authors.map(author=>author.name)).toEqual(['丙']);
  });
  it('includes later author positions in both dimensions once and keeps other people out',()=>{
    const investment=messageAuthorInvestment(message('m'),stakes([
      position('initial',3),position('later-truth',7),position('later-opposition',2,'TRUTH','甲','CON'),
      position('later-value',4,'VALUE'),position('foreign',100,'TRUTH','乙'),position('foreign-value',50,'VALUE','乙'),
    ]));
    expect(investment).toEqual({total:{truth:12,value:9},initial:{truth:3,value:5},additional:{truth:9,value:4}});
  });
  it('matches author investments by ID after a rename and excludes a different account with the old name',()=>{
    const renamed={...position('own',7),user:{id:'甲',username:'新名字',createdAt:''}};
    const sameName={...position('other',100),user:{id:'其他账户',username:'甲',createdAt:''}};
    expect(messageAuthorInvestment(message('m'),stakes([renamed,sameName])).total).toEqual({truth:7,value:5});
    expect(messageAuthorInvestment({...message('m'),authorId:undefined},stakes([renamed,sameName])).total).toEqual({truth:3,value:5});
  });
  it('does not mistake outgoing target investments for a self investment',()=>{
    for(const relationType of ['agree','disagree','recommend','archive'] as const){
      expect(messageAuthorInvestment({...message('outgoing'),kind:'relation',relationType},stakes([])).total).toEqual({truth:0,value:relationType==='agree'||relationType==='disagree'?5:0});
    }
  });
  it('preserves authoritative zeroes and supports old records without inventing a first investment',()=>{
    expect(messageAuthorInvestment({...message('zero'),spending:{protocol:1,wager:0,recommendation:0}},stakes([])).total).toEqual({truth:0,value:0});
    const old=messageAuthorInvestment({...message('old'),spending:undefined},stakes([position('truth',8),position('value',6,'VALUE')]));
    expect(old).toEqual({total:{truth:8,value:6}});
  });
  it('rebuilds cumulative author investments from synchronized snapshots after additions',()=>{
    const source=message('m'),user={id:'甲',username:'甲',createdAt:''};
    const snapshot:WorkbenchSnapshot={scope:{messageId:null,title:'公论'},messages:[{...source,kind:'TEXT',contentType:'TEXT',createdBy:user}],relations:[],users:[user],sequence:1,
      stakes:{m:stakes([position('initial',3)])},tagCounts:{},attentionUsers:{}};
    expect(projectWorkbenchSnapshot(snapshot).messages[0].authorInvestment?.total).toEqual({truth:3,value:5});
    snapshot.stakes.m=stakes([position('initial',3),position('add',4),position('value-add',6,'VALUE')]);snapshot.sequence++;
    expect(projectWorkbenchSnapshot(snapshot).messages[0].authorInvestment).toEqual({total:{truth:7,value:11},initial:{truth:3,value:5},additional:{truth:4,value:6}});
  });
  it('projects sender amounts using account IDs even when displayed names change or match another account',()=>{
    const source=message('m'),user={id:'甲',username:'甲',createdAt:''};
    const own={...position('own',8),user:{...user,username:'新名字'}};
    const other={...position('other',100),user:{...user,id:'其他账户'}};
    const snapshot:WorkbenchSnapshot={scope:{messageId:null,title:'公论'},messages:[{...source,kind:'TEXT',contentType:'TEXT',createdBy:user}],relations:[],users:[user],sequence:1,
      stakes:{m:stakes([own,other])},tagCounts:{},attentionUsers:{}};
    const projected=projectWorkbenchSnapshot(snapshot);
    expect(projected.authorAmounts.m).toBe(8);expect(projected.messages[0].authorInvestment?.total).toEqual({truth:8,value:5});
  });
});
