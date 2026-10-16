import {expect,it} from 'vitest';
import type {Message,Relation} from '../types';
import {convertMessagesToDemoModel} from '../utils/modelBridge';
import {projectGraphScene} from '../utils/graphProjection';
import {projectContainerPreview} from '../pages/workbench/projections/containerPreview';
import {collectOwnedByRelation} from '../pages/workbench/model/ownership';

const user={id:'tester',username:'tester',createdAt:''};
const text=(id:string):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:'2026-01-01',createdBy:user});
const rel=(id:string,type:string,ids:string[]=[],source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,targetRefs:ids.map(messageId=>({kind:'message',messageId})),createdAt:'2026-01-01',createdBy:user,payload:{title:id,targetLayout:'single-row'}});
const state=(id:string)=>({messageId:id,revision:1,supportCount:0,oppositionCount:1,recommendationTotal:0,suppressed:true});

it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE'])('previews rejected %s with native members without changing votes or membership',type=>{
  const relations=[rel('C',type,['one','two']),rel('against','DISAGREE',['C'])];
  const model=convertMessagesToDemoModel(['one','two'].map(text),relations);
  model.messages.find(m=>m.id==='C')!.state=state('C');
  const before=JSON.stringify({relations,...model});
  const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  expect(preview.messages.map(m=>m.id)).toContain('C');
  expect(preview.rejectedContainerIds.has('C')).toBe(false);
  expect(preview.target.state?.suppressed).toBe(false);
  expect(preview.target.state?.oppositionCount).toBe(1);
  expect(JSON.stringify({relations,...model})).toBe(before);
  if(type==='ARRANGE'||type==='MERGE'){
    const scene=projectGraphScene({messages:preview.messages,edges:preview.edges,isTraceWindow:false,traceExpandedFrameIds:new Set()});
    expect(scene.frameBlocks.find(frame=>frame.relMsgId==='C')?.directCardIds).toEqual(new Set(['one','two']));
  }else{
    expect(preview.messages.map(m=>m.id)).not.toEqual(expect.arrayContaining(['one','two']));
    const scene=projectGraphScene({messages:preview.messages,edges:preview.edges,isTraceWindow:false,traceExpandedFrameIds:new Set()});
    expect(scene.normalIds).toEqual(['C']);
    expect(new Set(preview.edges.filter(edge=>edge.relationMessageId==='C').map(edge=>edge.to.messageId))).toEqual(new Set(['one','two']));
    const inside=projectContainerPreview(model.messages,relations,model.edges,'C','tester','C')!;
    expect(inside.messages.map(m=>m.id)).toEqual(expect.arrayContaining(['one','two']));
  }
});

it('releases consecutive rejected children only into their enclosing category and keeps other rejections in preview',()=>{
  const relations=[rel('A','CLASSIFY',['C']),rel('C','CLASSIFY',['D']),rel('D','CLASSIFY'),rel('joined','JOIN',['leaf'],'D')];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  for(const message of model.messages)if(message.id==='C'||message.id==='D')message.state=state(message.id);
  const owned=collectOwnedByRelation('A',new Map(relations.map(r=>[r.id,r])),new Set(),new Set(['C','D']));
  expect(owned.textIds.has('leaf')).toBe(true);
  const outer=projectContainerPreview(model.messages,relations,model.edges,'A','tester','A')!;
  expect(outer.messages.filter(m=>m.id==='leaf')).toHaveLength(1);
  const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  expect(preview.rejectedContainerIds).toEqual(new Set(['D']));
  expect(preview.messages.map(m=>m.id)).toContain('C');
  expect(preview.messages.map(m=>m.id)).not.toContain('leaf');
  const inside=projectContainerPreview(model.messages,relations,model.edges,'C','tester','C')!;
  expect(inside.messages.map(m=>m.id)).toContain('leaf');
});

it('recomputes effective JOINs for the assumed approval while retaining the original comparison context',()=>{
  const relations=[rel('C','CLASSIFY'),rel('old-parent','CLASSIFY'),rel('old','JOIN',['leaf'],'old-parent'),{...rel('new','JOIN',['leaf'],'C'),createdAt:'2026-01-02'}];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  model.messages.find(m=>m.id==='C')!.state=state('C');
  const before=JSON.stringify({relations,...model});
  const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  expect(preview.effectiveJoinIds.has('new')).toBe(true);
  expect(preview.effectiveJoinIds.has('old')).toBe(false);
  expect(preview.messages.map(m=>m.id)).toEqual(expect.arrayContaining(['C','old-parent']));
  expect(preview.messages.map(m=>m.id)).not.toContain('leaf');
  expect(preview.edges.some(edge=>edge.relationMessageId==='C'&&edge.to.messageId==='leaf')).toBe(true);
  expect(preview.relations.some(relation=>relation.id.startsWith('preview-scope:'))).toBe(false);
  expect(JSON.stringify({relations,...model})).toBe(before);
});

it('does not resurrect members that have subsequently joined another active category',()=>{
  const relations=[rel('A','CLASSIFY',['C']),rel('C','CLASSIFY',['leaf']),rel('elsewhere','CLASSIFY'),rel('old','JOIN',['leaf'],'C'),{...rel('new','JOIN',['leaf'],'elsewhere'),createdAt:'2026-01-02'}];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  model.messages.find(m=>m.id==='C')!.state=state('C');
  const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  expect(preview.messages.map(m=>m.id)).not.toContain('leaf');
  expect(collectOwnedByRelation('A',new Map(relations.map(r=>[r.id,r])),new Set(),new Set(['C'])).textIds.has('leaf')).toBe(false);
});

it('distinguishes an explicit root from the inferred containing scope when going up',()=>{
  const relations=[rel('A','CLASSIFY',['C']),rel('C','CLASSIFY',['leaf'])];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  model.messages.find(message=>message.id==='C')!.state=state('C');
  const before=JSON.stringify({relations,...model});
  const inferred=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  expect(inferred.scopeId).toBe('A');expect(inferred.scopeTarget?.id).toBe('A');
  const root=projectContainerPreview(model.messages,relations,model.edges,'C','tester',null,undefined,{id:null})!;
  expect(root.scopeId).toBeNull();expect(root.scopeTarget).toBeNull();
  expect(root.messages.map(message=>message.id)).toContain('A');
  expect(root.rejectedContainerIds.has('C')).toBe(false);
  expect(root.messages.map(message=>message.id)).not.toContain('leaf');
  expect(JSON.stringify({relations,...model})).toBe(before);
});
