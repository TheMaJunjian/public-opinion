import {expect,it} from 'vitest';
import type {Relation,Message} from '../types';
import {convertMessagesToDemoModel,type DemoMessage,type DemoEdge} from '../utils/modelBridge';
import {deriveGraphMessagesToRender} from '../pages/workbench/projections/graphMessagesToRender';
import {filterMessageListContext} from '../pages/workbench/projections/messageListContext';
import {projectJoinMembershipEdges} from '../pages/workbench/model/membership';
import {projectGraphScene} from '../utils/graphProjection';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {collectContainerVisibleIds} from '../pages/workbench/model/ownership';
import {getEffectiveJoinRelationIds, filterContainerEdgesByEffectiveJoins} from '../pages/workbench/model/membership';

const author={id:'user',username:'tester',createdAt:''};
const at='2026-01-01T00:00:00Z';
const text=(id:string):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:at,updatedAt:at,createdBy:author});
const rel=(id:string,type:string,targets:string[]=[],source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,targetRefs:targets.map(messageId=>({kind:'message',messageId})),payload:type==='CLASSIFY'?{title:id}:{targetLayout:'single-row'},createdAt:at,createdBy:author});

it('does not revive a native declaration after its independent JOIN is opposed',()=>{
  const container={...rel('C','CLASSIFY',['leaf']),payload:{independentMemberships:true}};
  const joining={...rel('J','JOIN',['leaf'],'C'),payload:{membershipHistory:{id:'J',memberId:'leaf',parentId:'C',previousId:null,previousParentId:null,order:1}},state:{messageId:'J',revision:1,suppressed:true,supportCount:0,oppositionCount:1,recommendationTotal:0}};
  const relations=[container,joining],model=convertMessagesToDemoModel([text('leaf')],relations);
  const effect=deriveContainerEffect({...model,relations,username:'tester'});
  expect(effect.effectiveJoinIds.size).toBe(0);
  expect(effect.ownership.direct('C').textIds.has('leaf')).toBe(false);
  expect(effect.edges.some(edge=>edge.relationMessageId==='C'&&edge.to.messageId==='leaf')).toBe(false);
  const preview=deriveContainerEffect({...model,relations,username:'tester',assumption:{messageId:'J',side:'agree'}});
  expect(preview.ownership.direct('C').textIds.has('leaf')).toBe(true);
});

it('keeps a legacy multi-target JOIN effective only for its remaining target',()=>{
  const relations=[rel('A','CLASSIFY'),rel('B','CLASSIFY'),rel('old','JOIN',['one','two'],'A'),{...rel('new','JOIN',['one'],'B'),createdAt:'2026-01-02T00:00:00Z'}];
  const model=convertMessagesToDemoModel(['one','two'].map(text),relations),active=getEffectiveJoinRelationIds(relations,new Set(),new Set());
  const edges=projectJoinMembershipEdges(filterContainerEdgesByEffectiveJoins(model.edges,relations,active),relations,active,new Set(['A','B']));
  expect(edges.filter(edge=>edge.to.messageId==='one'&&['A','B'].includes(edge.relationMessageId)).map(edge=>edge.relationMessageId)).toEqual(['B']);
  expect(collectContainerVisibleIds('A',relations).textIds).toEqual(new Set(['two']));
});
export function projectContainer(messages:DemoMessage[],edges:DemoEdge[],relations:Relation[],id:string){
  const empty=()=>new Set<string>(),owned=()=>({textIds:empty(),relationIds:empty()});
  return deriveGraphMessagesToRender({messages,edges,messagesToShow:messages,edgesToShow:edges,relations,relationById:new Map(relations.map(r=>[r.id,r])),msgMap:new Map(messages.map(m=>[m.id,m])),traceEntries:[],traceContainerMemberships:[],effectiveSuppressedRelIdsForLayout:empty(),traceDistance:1,traceExpandedFrameIds:empty(),isInsideClassify:true,currentClassifyRelMsgId:id,rejectedContainerIds:empty(),rejectedJoinRelationIds:empty(),activeClassifyOwnership:owned(),activeSummaryOwnership:owned(),classifiedTargetSummaryRelMsgIds:empty(),listExclusiveRelMsgIds:empty(),replacedRelationMsgIds:empty(),classifiedTargetTextIds:empty(),graphOwnedRelationIds:empty(),traceRelationMsgIds:empty(),classifiedTargetClassifyRelMsgIds:empty(),classifiedTargetMergeRelMsgIds:empty(),classifiedTargetARRANGERelMsgIds:empty(),graphExclusiveRelMsgIds:empty(),graphHiddenTextIds:empty()});
}

it('keeps a JOIN-only classification inside its frame and its member behind that card despite a Topic annotation',()=>{
  const relations=[rel('topic','CLASSIFY',['merge','annotation']),rel('merge','MERGE'),rel('category','CLASSIFY'),rel('join-category','JOIN',['category'],'merge'),rel('join-leaf','JOIN',['leaf'],'category'),rel('annotation','ANNOTATION',['leaf'],'note')];
  const model=convertMessagesToDemoModel(['leaf','note'].map(text),relations);
  const outer=projectContainer(model.messages,model.edges,relations,'topic');
  expect(outer.graphMessagesToRender.map(m=>m.id)).toContain('category');
  expect(outer.graphMessagesToRender.map(m=>m.id)).not.toContain('leaf');
  const inner=projectContainer(model.messages,model.edges,relations,'category');
  expect(inner.graphMessagesToRender.map(m=>m.id)).toContain('leaf');
});

it('expands effective JOIN members of an arrangement instead of treating an empty declaration as an empty frame',()=>{
  const relations=[rel('topic','CLASSIFY',['arrange']),rel('arrange','ARRANGE'),rel('joined','JOIN',['one','two'],'arrange')];
  const model=convertMessagesToDemoModel(['one','two'].map(text),relations);
  const result=projectContainer(model.messages,model.edges,relations,'topic');
  expect(result.graphMessagesToRender.map(m=>m.id)).toEqual(expect.arrayContaining(['one','two']));
  const edges=projectJoinMembershipEdges(result.graphEdgesToRender,relations,new Set(['joined']),new Set(result.graphMessagesToRender.map(m=>m.id)));
  const scene=projectGraphScene({messages:result.graphMessagesToRender,edges,isTraceWindow:false,traceExpandedFrameIds:new Set()});
  expect(scene.frameBlocks.find(frame=>frame.relMsgId==='arrange')?.directCardIds).toEqual(new Set(['one','two']));
});

it('keeps classification membership edges for nested card counts without expanding their members',()=>{
  const relations=[rel('topic','CLASSIFY',['category']),rel('category','CLASSIFY',['leaf']),rel('joined','JOIN',['other'],'category')];
  const model=convertMessagesToDemoModel(['leaf','other'].map(text),relations);
  const projected=projectContainer(model.messages,model.edges,relations,'topic');
  const edges=projectJoinMembershipEdges(projected.graphEdgesToRender,relations,new Set(['joined']),new Set(projected.graphMessagesToRender.map(m=>m.id)));
  expect(new Set(edges.filter(e=>e.relationMessageId==='category').map(e=>e.to.messageId))).toEqual(new Set(['leaf','other']));
  expect(projected.graphMessagesToRender.map(m=>m.id)).not.toContain('leaf');
});

it('does not pull a parent classification into its descendant canvas because of a shared historical target',()=>{
  const relations=[rel('parent','CLASSIFY',['leaf','inner']),rel('inner','CLASSIFY'),rel('joined','JOIN',['leaf'],'inner')];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  const projected=projectContainer(model.messages,model.edges,relations,'inner');
  expect(projected.graphMessagesToRender.map(m=>m.id)).toContain('leaf');
  expect(projected.graphMessagesToRender.map(m=>m.id)).not.toContain('parent');
});

it.each(['AGREE','DISAGREE','REFERENCE','REPLY','ANNOTATION'])('keeps old %s records with their folded content instead of at the beginning of the parent table',type=>{
  const relation={...rel('old-relation',type,['target'],['AGREE','DISAGREE'].includes(type)?null:'source'),createdAt:'2026-01-02T00:00:00Z'};
  const category={...rel('category','CLASSIFY',['source','target']),createdAt:'2026-01-03T00:00:00Z'};
  const topic={...rel('topic','CLASSIFY'),targetRefs:[{kind:'relation',relationId:'category'},{kind:'relation',relationId:'old-relation'},{kind:'message',messageId:'visible'}] as Relation['targetRefs']};
  const relations=[topic,category,relation];
  const model=convertMessagesToDemoModel([text('source'),text('target'),{...text('visible'),createdAt:'2026-01-04T00:00:00Z'}],relations);
  const outer=projectContainer(model.messages,model.edges,relations,'topic');
  expect(outer.listMessagesToRender.map(m=>m.id)).toEqual(['category','visible']);
  const inner=projectContainer(model.messages,model.edges,relations,'category');
  expect(inner.listMessagesToRender.map(m=>m.id)).toEqual(['source','target','old-relation']);
});

it('keeps a cross-classification reference beside its visible source in chronological order',()=>{
  const topic={...rel('topic','CLASSIFY'),targetRefs:[{kind:'relation',relationId:'category'},{kind:'relation',relationId:'reference'},{kind:'message',messageId:'source'}] as Relation['targetRefs']};
  const relations=[topic,{...rel('category','CLASSIFY',['target']),createdAt:'2026-01-03T00:00:00Z'},
    {...rel('reference','REFERENCE',['target'],'source'),createdAt:'2026-01-02T00:00:00Z'}];
  const model=convertMessagesToDemoModel([text('source'),text('target')],relations);
  const projected=projectContainer(model.messages,model.edges,relations,'topic');
  expect(projected.listMessagesToRender.map(m=>m.id)).toEqual(['source','reference','category']);
});

it('folds a chain of relations when its original target is inside a nested classification',()=>{
  const topic={...rel('topic','CLASSIFY'),targetRefs:['category','agree','agree-relation'].map(relationId=>({kind:'relation' as const,relationId}))};
  const relations=[topic,rel('category','CLASSIFY',['target']),rel('agree','AGREE',['target']),
    {...rel('agree-relation','AGREE'),targetRefs:[{kind:'relation' as const,relationId:'agree'}]}];
  const model=convertMessagesToDemoModel([text('target')],relations);
  const projected=projectContainer(model.messages,model.edges,relations,'topic');
  expect(projected.listMessagesToRender.map(m=>m.id)).toEqual(['category']);
});

it('merges visible summary targets into the table in send order rather than appending them after relations',()=>{
  const topic={...rel('topic','CLASSIFY'),targetRefs:[{kind:'relation',relationId:'summary'},{kind:'relation',relationId:'agree'}] as Relation['targetRefs']};
  const relations=[topic,{...rel('summary','SUMMARY',['target']),createdAt:'2026-01-03T00:00:00Z'},
    {...rel('agree','AGREE',['target']),createdAt:'2026-01-02T00:00:00Z'}];
  const model=convertMessagesToDemoModel([text('target')],relations);
  const projected=projectContainer(model.messages,model.edges,relations,'topic');
  expect(projected.listMessagesToRender.map(m=>m.id)).toEqual(['target','agree','summary']);
});

it.each(['join','round','round_result'] as const)('folds votes on a filtered %s record while preserving a visible cross-scope reference',kind=>{
  const relations=[{...rel('agree','AGREE',['target']),createdAt:'2026-01-02T00:00:00Z'},
    {...rel('reference','REFERENCE',['target'],'source'),createdAt:'2026-01-03T00:00:00Z'}];
  const model=convertMessagesToDemoModel([text('source'),text('target')],relations);
  const messages=model.messages.map(message=>message.id==='target'?{...message,kind}:message);
  const visible=messages.filter(message=>message.kind!==kind);
  expect(filterMessageListContext(visible,messages,model.edges).map(m=>m.id)).toEqual(['source','reference']);
  expect(filterMessageListContext(messages,messages,model.edges)).toEqual(messages);
  expect(filterMessageListContext(visible,messages,model.edges,new Set(['agree'])).map(m=>m.id)).toEqual(['source','agree','reference']);
});
