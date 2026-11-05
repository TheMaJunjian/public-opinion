import { expect, it } from 'vitest';
import { comparisonChanges } from '../pages/workbench/projections/comparisonChanges';
import { convertMessagesToDemoModel, type DemoMessage } from '../utils/modelBridge';
import { deriveComparisonGraphProjections } from '../pages/workbench/projections/comparisonGraphProjections';

const message:DemoMessage={id:'body',kind:'normal',content:'正文',author:'reader',createdAt:''};
it('reports body and width differences without including unchanged neighbors',()=>{
  const a={messages:[message,{...message,id:'neighbor'}],edges:[],widths:{body:640}};
  const b={messages:[{...message,content:'修改'},{...message,id:'neighbor'}],edges:[],widths:{body:320}};
  expect(comparisonChanges(a,b).map(change=>[change.id,change.reasons])).toEqual([['body',['正文','宽度']]]);
});
it('reports an absent message rather than losing its comparison entry',()=>{
  expect(comparisonChanges({messages:[message],edges:[]},{messages:[],edges:[]})[0]).toMatchObject({id:'body',reasons:['显示范围']});
});
it('compares recommendation and archive as mutually exclusive effects',()=>{
  const user={id:'reader',username:'reader',createdAt:''};
  const relations=[{id:'mark',relationType:'RECOMMEND',sourceMessageId:null,targetRefs:[{kind:'message' as const,messageId:'body'}],createdAt:'',createdBy:user}];
  const model=convertMessagesToDemoModel([{id:'body',kind:'TEXT',contentType:'TEXT',content:'正文',createdAt:'',createdBy:user}],relations);
  const before=JSON.stringify(model);
  const pair=deriveComparisonGraphProjections({...model,relations,username:null,comparisonReviewed:true,comparisonTargetId:'mark',scopeId:null,
    traceEntries:[],traceDistance:1,traceExpandedFrameIds:new Set(),traceRelationMsgIds:new Set(),traceContainerMemberships:[],
    collectExclusiveRelationMsgIds:()=>new Set(),replacedRelationMsgIds:new Set(),comparisonReviewBaseMessages:model.messages,
    comparisonReviewBaseEdges:model.edges,isInsideClassify:false,normalGraphProjection:{...model,scopedMessages:model.messages},showMembershipFrames:true})!;
  expect(pair.agree.edges.find(edge=>edge.relationMessageId==='mark')?.relationType).toBe('recommend');
  expect(pair.disagree.edges.find(edge=>edge.relationMessageId==='mark')?.relationType).toBe('archive');
  expect(comparisonChanges(pair.agree,pair.disagree).map(change=>change.id)).toContain('body');
  expect(JSON.stringify(model)).toBe(before);
});
