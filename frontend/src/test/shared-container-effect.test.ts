import {expect,it} from 'vitest';
import type {Message,Relation} from '../types';
import {convertMessagesToDemoModel} from '../utils/modelBridge';
import {projectGraphScene} from '../utils/graphProjection';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {projectContainerCanvas} from '../pages/workbench/projections/containerCanvas';
import {projectContainerPreview} from '../pages/workbench/projections/containerPreview';
import {deriveComparisonGraphProjections} from '../pages/workbench/projections/comparisonGraphProjections';
import type {DeriveComparisonGraphProjectionsInput} from '../pages/workbench/projections/comparisonGraphProjections';
import {applyMessageFilter} from '../components/MessageFilterPanel';

const user={id:'tester',username:'tester',createdAt:''};
const text=(id:string):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:'2026-01-01',createdBy:user});
const rel=(id:string,type:string,ids:string[]=[],source:string|null=null,at='2026-01-01'):Relation=>({id,relationType:type,sourceMessageId:source,targetRefs:ids.map(messageId=>({kind:'message',messageId})),createdAt:at,createdBy:user,payload:{title:id,targetLayout:'single-row'}});
const state=(id:string,suppressed:boolean)=>({messageId:id,revision:1,supportCount:0,oppositionCount:1,recommendationTotal:0,suppressed});
function compare(model:ReturnType<typeof convertMessagesToDemoModel>,relations:Relation[],id:string,scopeId:string|null='A',extra:Partial<DeriveComparisonGraphProjectionsInput>={}){
  const source=deriveContainerEffect({...model,relations,username:'tester'}),base=projectContainerCanvas(source,scopeId?{kind:'inside',id:scopeId}:{kind:'root'});
  return deriveComparisonGraphProjections({comparisonReviewed:true,comparisonTargetId:id,username:'tester',scopeId,sourceEffect:source,messages:model.messages,edges:model.edges,relations,traceEntries:[],traceDistance:1,traceExpandedFrameIds:new Set(),traceRelationMsgIds:new Set(),traceContainerMemberships:[],collectExclusiveRelationMsgIds:()=>new Set(),replacedRelationMsgIds:new Set(),comparisonReviewBaseMessages:null,comparisonReviewBaseEdges:null,normalGraphProjection:{...base,scopedMessages:base.messages},isInsideClassify:scopeId!==null,filterMessages:messages=>applyMessageFilter(messages,{hideJoin:true,hideSettlement:true}),...extra})!;
}
function scene(projection:{messages:ReturnType<typeof convertMessagesToDemoModel>['messages'];edges:ReturnType<typeof convertMessagesToDemoModel>['edges'];context?:{rejectedContainerIds:Set<string>}}){
  const result=projectGraphScene({...projection,rejectedContainerIds:projection.context?.rejectedContainerIds,isTraceWindow:false,traceExpandedFrameIds:new Set()});
  return {ids:[...result.normalIds].sort(),frames:result.frameBlocks.map(frame=>({id:frame.relMsgId,members:[...frame.directCardIds].sort()})),members:projection.edges.filter(edge=>edge.relationMessageId==='C').map(edge=>edge.to.messageId).sort()};
}

it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'])('shares %s approval, JOIN switching and membership between preview and comparison',type=>{
  const relations=[rel('A','CLASSIFY',['C','one','two']),rel('C',type),rel('old','JOIN',['one','two'],'A'),rel('new','JOIN',['one','two'],'C','2026-01-02')];
  const model=convertMessagesToDemoModel(['one','two'].map(text),relations);
  model.messages.find(message=>message.id==='C')!.state=state('C',true);
  const before=JSON.stringify({relations,...model});
  const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  const comparison=compare(model,relations,'C');
  expect(scene(comparison.agree)).toEqual(scene(preview));
  expect(comparison.agree.context.rejectedContainerIds.has('C')).toBe(false);
  expect(comparison.disagree.context.rejectedContainerIds.has('C')).toBe(true);
  expect(comparison.agree.context.joinStatusByMessage.get('new')).toBe('valid');
  expect(comparison.agree.context.joinStatusByMessage.get('old')).toBe('superseded');
  expect(comparison.disagree.context.joinStatusByMessage.get('new')).toBe('container-rejected');
  expect(comparison.disagree.context.joinStatusByMessage.get('old')).toBe('valid');
  expect(scene(comparison.disagree).ids).toEqual(['one','two']);
  const rejected=deriveContainerEffect({...model,relations,username:'tester',assumption:{messageId:'C',side:'disagree'}});
  expect(rejected.ownership.direct('A').textIds).toEqual(new Set(['one','two']));
  const rootIds=scene(projectContainerCanvas(rejected,{kind:'root'})).ids;
  expect(rootIds).toContain('A');expect(rootIds).not.toContain('one');expect(rootIds).not.toContain('two');
  expect(JSON.stringify({relations,...model})).toBe(before);
});

it('switches a rejected JOIN with the same rules as native state, without restoring other rejected JOINs',()=>{
  const relations=[rel('A','CLASSIFY',['C']),rel('C','CLASSIFY'),rel('old','JOIN',['leaf'],'A'),rel('new','JOIN',['leaf'],'C','2026-01-02')];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  model.messages.find(message=>message.id==='new')!.state=state('new',true);
  const baseline=deriveContainerEffect({...model,relations,username:'tester'});
  expect(baseline.effectiveJoinIds).toEqual(new Set(['old']));
  const comparison=compare(model,relations,'new');
  expect(scene(comparison.agree).ids).toEqual(['C']);
  expect(scene(comparison.disagree).ids).toEqual(['C','leaf']);
  expect(comparison.agree.context.joinStatusByMessage.has('new')).toBe(true);
  expect(baseline.effectiveJoinIds).toEqual(new Set(['old']));
  const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  expect(preview.effectiveJoinIds).toEqual(new Set(['old']));
  expect(preview.edges.some(edge=>edge.relationMessageId==='C'&&edge.to.messageId==='leaf')).toBe(false);
});

it('releases an opaque nested category into A while preserving its own member boundary and independent rejection',()=>{
  const relations=[rel('A','CLASSIFY',['C']),rel('C','CLASSIFY',['D','E']),rel('D','CLASSIFY',['private']),rel('E','CLASSIFY',['released'])];
  const model=convertMessagesToDemoModel(['private','released'].map(text),relations);
  for(const id of ['C','E'])model.messages.find(message=>message.id===id)!.state=state(id,true);
  const comparison=compare(model,relations,'C');
  expect(scene(comparison.agree).ids).toEqual(['C']);
  expect(scene(comparison.disagree).ids).toEqual(['D','released']);
  expect(comparison.agree.context.rejectedContainerIds).toEqual(new Set(['E']));
  expect(comparison.disagree.context.rejectedContainerIds).toEqual(new Set(['C','E']));
  const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  expect(scene(preview)).toEqual(scene(comparison.agree));
  const inside=projectContainerPreview(model.messages,relations,model.edges,'C','tester','C')!;
  expect(scene(inside).ids).toEqual(['D','released']);
});

it('does not resurrect a declared member moved to a different active owner in either view',()=>{
  const relations=[rel('A','CLASSIFY',['C']),rel('C','ARRANGE',['leaf']),rel('elsewhere','CLASSIFY'),rel('old','JOIN',['leaf'],'C'),rel('new','JOIN',['leaf'],'elsewhere','2026-01-02')];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  model.messages.find(message=>message.id==='C')!.state=state('C',true);
  const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester')!;
  const comparison=compare(model,relations,'C');
  expect(scene(preview)).toEqual(scene(comparison.agree));
  expect(scene(comparison.agree).ids).not.toContain('leaf');
  expect(scene(comparison.disagree).ids).not.toContain('leaf');
});

it.each(['MERGE', 'ARRANGE', 'SUMMARY'])('keeps a restored %s visible and empty when both original members have a later classification', type => {
  const relations = [rel('merge', type, ['B', 'C']), rel('category', 'CLASSIFY', ['B', 'C']),
    ...['B', 'C'].flatMap(id => [rel(`old-${id}`, 'JOIN', [id], 'merge'), rel(`new-${id}`, 'JOIN', [id], 'category')])];
  for (const container of relations.slice(0, 2)) container.payload = { independentMemberships: true };
  for (const [index, join] of relations.slice(2).entries()) {
    const memberId = join.targetRefs[0].kind === 'relation' ? join.targetRefs[0].relationId : join.targetRefs[0].messageId;
    join.payload = { membershipHistory: { id: join.id, memberId, parentId: join.sourceMessageId!,
      previousId: null, previousParentId: null, order: join.id.startsWith('old-') ? index : index + 10 } };
  }
  const model = convertMessagesToDemoModel(['B', 'C'].map(text), relations);
  model.messages.find(message => message.id === 'merge')!.state = state('merge', true);
  const before = JSON.stringify({ relations, ...model });
  const restored = deriveContainerEffect({ ...model, relations, username: 'tester', assumption: { messageId: 'merge', side: 'agree' } });
  expect(restored.rejectedContainerIds.has('merge')).toBe(false);
  expect(restored.ownership.direct('merge').textIds.size).toBe(0);
  expect(restored.ownership.direct('category').textIds).toEqual(new Set(['B', 'C']));
  const restoredScene = scene(projectContainerCanvas(restored, { kind: 'root' }));
  if (type === 'SUMMARY') expect(restoredScene.ids).toContain('merge');
  else expect(restoredScene.frames).toContainEqual({ id: 'merge', members: [] });
  expect(JSON.stringify({ relations, ...model })).toBe(before);
});

it('honors authoritative active JOIN state despite historical opposing records',()=>{
  const relations=[rel('C','CLASSIFY'),rel('joined','JOIN',['leaf'],'C'),rel('historical-against','DISAGREE',['joined'])];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  model.messages.find(message=>message.id==='joined')!.state=state('joined',false);
  const effect=deriveContainerEffect({...model,relations,username:'tester'});
  expect(effect.effectiveJoinIds).toEqual(new Set(['joined']));
  expect(effect.ownership.direct('C').textIds).toEqual(new Set(['leaf']));
});

it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'])('keeps native %s ownership, edges and record status consistent through successive moves and recovery',type=>{
  const relations=[rel('C',type,['leaf','stay']),rel('P','CLASSIFY'),rel('Q','CLASSIFY'),
    rel('original','JOIN',['leaf'],'C'),rel('stay-join','JOIN',['stay'],'C'),
    rel('first','JOIN',['leaf'],'P'),rel('second','JOIN',['leaf'],'Q')];
  relations[0].payload={...relations[0].payload,independentMemberships:true};
  for(const [order,id,parentId,memberId,previousId] of [
    [1,'original','C','leaf',null],[2,'stay-join','C','stay',null],
    [3,'first','P','leaf',null],[4,'second','Q','leaf','first'],
  ] as const){
    const join=relations.find(relation=>relation.id===id)!;
    join.payload={membershipHistory:{id,parentId,memberId,previousId,previousParentId:previousId?'P':null,order}};
  }
  // The first move was made while C was rejected, so its recorded predecessor
  // is root. Restoring C must never splice its old JOIN into that later branch.
  for(const [rejected,owner] of [
    [new Set(['C']),'Q'],[new Set<string>(),'Q'],[new Set(['second']),'P'],
    [new Set(['second','first']),null],[new Set(['C','second','first']),null],
    [new Set(['C','first']),'Q'],
  ] as const){
    const current=relations.map(relation=>({...relation,state:state(relation.id,rejected.has(relation.id))}));
    const model=convertMessagesToDemoModel(['leaf','stay'].map(text),current);
    const effect=deriveContainerEffect({...model,relations:current,username:'tester'});
    const owners=['C','P','Q'].filter(id=>effect.ownership.direct(id).textIds.has('leaf'));
    expect(owners).toEqual(owner?[owner]:[]);
    const memberEdges=effect.edges.filter(edge=>['C','P','Q'].includes(edge.relationMessageId)&&edge.to.messageId==='leaf');
    expect(memberEdges.map(edge=>edge.relationMessageId)).toEqual(owner?[owner]:[]);
    expect(effect.effectiveJoinIds.has('original')).toBe(false);
    for(const relation of current.filter(relation=>relation.relationType==='JOIN')){
      expect(effect.context.joinStatusByMessage.get(relation.id)==='valid').toBe(effect.effectiveJoinIds.has(relation.id));
    }
    expect(effect.ownership.direct('C').textIds.has('stay')).toBe(!rejected.has('C'));
    const root=projectContainerCanvas(effect,{kind:'root'});
    expect(root.messages.some(message=>message.id==='leaf')).toBe(owner===null);
    if(owner==='Q'){
      const recovered=deriveContainerEffect({...model,relations:current,username:'tester',assumption:{messageId:'C',side:'agree'}});
      expect(recovered.ownership.direct('Q').textIds).toEqual(new Set(['leaf']));
      expect(recovered.ownership.direct('C').textIds).toEqual(new Set(['stay']));
    }
  }
});

it('keeps JOIN-only released members reachable in comparison trace without restoring the rejected frame',()=>{
  const relations=[rel('C','CLASSIFY'),rel('joined','JOIN',['leaf'],'C')];
  const model=convertMessagesToDemoModel([text('leaf')],relations);
  model.messages.find(message=>message.id==='C')!.state=state('C',true);
  const comparison=compare(model,relations,'C',null,{traceEntries:[{ids:['C'],snapshot:null,mode:'trace',classifyRelMsgId:null,classifyStack:[]}]});
  expect(scene(comparison.agree).ids).toEqual(['C']);
  expect(scene(comparison.disagree).ids).toEqual(['leaf']);
});

it('uses exactly the original comparison agree side including surrounding messages, filters and trace context',()=>{
  const relations=[rel('A','CLASSIFY',['C','neighbor']),rel('C','CLASSIFY'),rel('joined','JOIN',['leaf'],'C')];
  const model=convertMessagesToDemoModel(['leaf','neighbor'].map(text),relations);
  model.messages.find(message=>message.id==='C')!.state=state('C',true);
  const source=deriveContainerEffect({...model,relations,username:'tester'}),base=projectContainerCanvas(source,{kind:'inside',id:'A'});
  const input:DeriveComparisonGraphProjectionsInput={comparisonReviewed:true,comparisonTargetId:'C',username:'tester',scopeId:'A',sourceEffect:source,messages:model.messages,edges:model.edges,relations,traceEntries:[],traceDistance:1,traceExpandedFrameIds:new Set(),traceRelationMsgIds:new Set(),traceContainerMemberships:source.memberships,collectExclusiveRelationMsgIds:()=>new Set(),replacedRelationMsgIds:new Set(),comparisonReviewBaseMessages:null,comparisonReviewBaseEdges:null,normalGraphProjection:{...base,scopedMessages:base.messages},isInsideClassify:true,filterMessages:messages=>applyMessageFilter(messages,{hideJoin:true,hideSettlement:true})};
  for(const trace of [false,true]){
    const scopedInput={...input,traceEntries:trace?[{ids:['C'],snapshot:null,mode:'trace' as const,classifyRelMsgId:'A',classifyStack:[]}]:[]};
    const original=JSON.stringify({relations,...model});
    const pair=deriveComparisonGraphProjections(scopedInput)!;
    const preview=projectContainerPreview(model.messages,relations,model.edges,'C','tester',null,scopedInput)!;
    expect(preview.messages).toEqual(pair.agree.messages);
    expect(preview.edges).toEqual(pair.agree.edges);
    expect(preview.context).toEqual(pair.agree.context);
    expect(preview.suppressed).toEqual(pair.agree.suppressed);
    expect(preview).not.toHaveProperty('disagree');
    if(!trace){expect(scene(preview).ids).toEqual(['C','neighbor']);expect(scene(pair.disagree).ids).toEqual(['leaf','neighbor']);}
    expect(JSON.stringify({relations,...model})).toBe(original);
    expect(preview.allMessages.some(message=>message.id.startsWith('preview-scope:'))).toBe(false);
  }
});

it('restores references between released members and same-scope neighbors when a container is opposed',()=>{
  const relations=[rel('A','CLASSIFY',['C','neighbor']),rel('C','CLASSIFY',['leaf']),rel('R','REFERENCE',['neighbor'],'leaf')];
  const model=convertMessagesToDemoModel(['leaf','neighbor'].map(text),relations);
  const comparison=compare(model,relations,'C');
  expect(comparison.disagree.messages.map(message=>message.id)).toContain('R');
  expect(comparison.disagree.edges.some(edge=>edge.relationMessageId==='R')).toBe(true);
});

it('updates cross-category reference badges separately for the assumed sides',()=>{
  const relations=[rel('A','CLASSIFY',['C','neighbor']),rel('C','CLASSIFY',['leaf']),rel('R','REFERENCE',['neighbor'],'leaf')];
  const model=convertMessagesToDemoModel(['leaf','neighbor'].map(text),relations);
  model.messages.find(message=>message.id==='C')!.state=state('C',true);
  const comparison=compare(model,relations,'C');
  expect(comparison.agree.context.crossCanvasRelations?.get('neighbor')?.incoming).toEqual({'引用':['R']});
  expect(comparison.disagree.context.crossCanvasRelations?.has('neighbor')).toBe(false);
  expect(comparison.agree.messages.map(message=>message.id)).not.toContain('leaf');
});

it('keeps independently opposed and filtered references hidden in comparison sides',()=>{
  const relations=[rel('A','CLASSIFY',['C','neighbor']),rel('C','CLASSIFY',['leaf']),rel('R','REFERENCE',['neighbor'],'leaf')];
  const model=convertMessagesToDemoModel(['leaf','neighbor'].map(text),relations);
  model.messages.find(message=>message.id==='R')!.state=state('R',true);
  const opposed=compare(model,relations,'C');
  for(const side of [opposed.agree,opposed.disagree]){
    expect(side.edges.some(edge=>edge.relationMessageId==='R')).toBe(false);
    expect(side.context.crossCanvasRelations.size).toBe(0);
  }
  model.messages.find(message=>message.id==='R')!.state={...state('R',false),oppositionCount:0};
  const filtered=compare(model,relations,'C','A',{filterMessages:messages=>messages.filter(message=>message.id!=='R')});
  for(const side of [filtered.agree,filtered.disagree]){
    expect(side.edges.some(edge=>edge.relationMessageId==='R')).toBe(false);
    expect(side.context.crossCanvasRelations.size).toBe(0);
  }
});

it.each(['CLASSIFY','SUMMARY','ARRANGE','MERGE'].flatMap(type=>[false,true].map(joinOnly=>({type,joinOnly}))))('keeps inspected $type C inside A at every navigation scope (JOIN-only: $joinOnly)',({type,joinOnly})=>{
  const relations=joinOnly
    ? [rel('P','CLASSIFY'),rel('A','CLASSIFY'),rel('C',type),rel('parent-A','JOIN',['A'],'P'),rel('parent-C','JOIN',['C'],'A'),rel('member-B','JOIN',['B'],'C'),rel('unrelated','CLASSIFY')]
    : [rel('P','CLASSIFY',['A']),rel('A','CLASSIFY',['C']),rel('C',type,['B']),rel('unrelated','CLASSIFY')];
  const model=convertMessagesToDemoModel([text('B'),text('outside')],relations);
  model.messages.find(message=>message.id==='C')!.state=state('C',true);
  const before=JSON.stringify({relations,...model});
  const inside=compare(model,relations,'C','A');
  expect(inside.agree.messages.map(message=>message.id)).toContain('C');
  expect(inside.disagree.messages.map(message=>message.id)).toContain('B');
  for(const scope of ['P',null,'unrelated']){
    const pair=compare(model,relations,'C',scope);
    for(const side of [pair.agree,pair.disagree]){
      expect(side.messages.map(message=>message.id)).not.toContain('C');
      expect(side.messages.map(message=>message.id)).not.toContain('B');
      expect(side.edges.some(edge=>edge.relationMessageId==='C')).toBe(false);
    }
  }
  expect(JSON.stringify({relations,...model})).toBe(before);
});
