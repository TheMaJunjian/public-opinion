import {describe,expect,it} from 'vitest';
import type {Message,Relation} from '../types';
import {convertMessagesToDemoModel} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {groupContainerJoinRecords} from '../pages/workbench/model/joinRecordGroups';

const user={id:'author',username:'author',createdAt:''};
const relation=(id:string,type:string,parent:string|null,targets:string[],order=1):Relation=>({id,relationType:type,sourceMessageId:parent,
  targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdBy:user,createdAt:new Date(Date.UTC(2026,9,25,0,0,order)).toISOString()});
function fixture(extra:Relation[]=[]){
  const relations=[...['container','nested','deep','elsewhere'].map(id=>relation(id,'CLASSIFY',null,[])),
    relation('nested-in-container','JOIN','container',['nested']),relation('deep-in-nested','JOIN','nested',['deep']),
    relation('old-direct','JOIN','container',['direct'],2),relation('current-direct','JOIN','container',['direct'],3),
    relation('old-nested','JOIN','container',['nested-member'],2),relation('current-nested','JOIN','deep',['nested-member'],3),
    relation('old-outside','JOIN','container',['outside'],2),relation('current-outside','JOIN','elsewhere',['outside'],3),
    {...relation('removed','JOIN','container',['removed-member'],2),state:{messageId:'removed',revision:1,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0,membershipDisabled:true}},...extra];
  const records:Message[]=['direct','nested-member','outside','removed-member','batch-direct','batch-outside'].map(id=>({id,kind:'TEXT',contentType:'TEXT',content:id,createdAt:'',createdBy:user}));
  const model=convertMessagesToDemoModel(records,relations),effect=deriveContainerEffect({...model,relations,username:'viewer',stakeCounts:{}});
  return {relations,effect,groups:groupContainerJoinRecords('container',relations,effect)};
}

describe('container JOIN record adoption and target locations',()=>{
  it('keeps obsolete records separate from current members and follows deep effective nesting',()=>{
    const {groups}=fixture();
    expect(groups.adopted.map(entry=>entry.id)).toEqual(['nested-in-container','current-direct']);
    expect(groups.unadopted.map(entry=>entry.id)).toEqual(['old-direct','old-nested','old-outside','removed']);
    expect(groups.unadopted.map(entry=>[entry.id,entry.targets[0].location])).toEqual([
      ['old-direct','container'],['old-nested','nested'],['old-outside','outside'],['removed','outside'],
    ]);
  });
  it('updates both adoption and location after a personal choice changes the winning placement',()=>{
    const choice={...relation('choice','AGREE',null,['old-nested'],4),createdBy:{...user,id:'viewer',username:'viewer'}};
    const {groups}=fixture([choice]);
    expect(groups.adopted.find(entry=>entry.id==='old-nested')?.targets).toEqual([{id:'nested-member',adopted:true,location:'container'}]);
    expect(groups.unadopted.some(entry=>entry.id==='old-nested')).toBe(false);
  });
  it('counts a partly adopted multi-target record once and marks every target independently',()=>{
    const {groups}=fixture([relation('batch','JOIN','container',['batch-direct','batch-outside','batch-direct'],2),
      relation('move-batch-target','JOIN','elsewhere',['batch-outside'],3)]);
    expect(groups.adopted.filter(entry=>entry.id==='batch')).toHaveLength(1);
    expect(groups.adopted.find(entry=>entry.id==='batch')?.targets).toEqual([
      {id:'batch-direct',adopted:true,location:'container'},{id:'batch-outside',adopted:false,location:'outside'},
    ]);
  });
  it('ignores former nested paths after their container moves outside',()=>{
    const {groups}=fixture([relation('move-nested','JOIN','elsewhere',['nested'],4)]);
    expect(groups.unadopted.find(entry=>entry.id==='old-nested')?.targets[0].location).toBe('outside');
    expect(groups.unadopted.find(entry=>entry.id==='nested-in-container')?.targets[0].location).toBe('outside');
  });
  it('handles empty histories and malformed cycles without treating a container as its own member',()=>{
    const record=relation('old','JOIN','container',['direct','deep-member','container']);
    const effect={joinByTarget:new Map<string,string>(),memberships:[
      {containerId:'container',relationType:'classify' as const,targetIds:['nested','direct']},
      {containerId:'nested',relationType:'classify' as const,targetIds:['container','deep-member','direct']},
    ]};
    expect(groupContainerJoinRecords('container',[],effect)).toEqual({adopted:[],unadopted:[]});
    expect(groupContainerJoinRecords('container',[record],effect).unadopted[0].targets.map(target=>target.location)).toEqual(['container','nested','outside']);
  });
});
