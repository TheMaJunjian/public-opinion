import { expect, it } from 'vitest';
import type { WorkbenchSnapshot } from '@gonglun/core';
import { mergeDiscussionSnapshots } from '../data/mergeDiscussionSnapshots';

const user={id:'reader',username:'读者',createdAt:''};
function page(id: string, sequence: number): WorkbenchSnapshot {
  const category={id:'category',revision:1,kind:'RELATION',contentType:'TEXT' as const,content:'分类',createdAt:'',createdBy:user,
    relationType:'CLASSIFY',sourceMessageId:null,targetRefs:[{kind:'message' as const,messageId:id}]};
  return {regionId:'region',sequence,scope:{messageId:null,title:'当前讨论'},messages:[category],relations:[category],users:[user],
    stakes:{},tagCounts:{},attentionUsers:{},discussion:{focusId:'category',pageIds:[id],cursor:id,nextCursor:null,memberCounts:{category:{direct:2,total:2}}}};
}
it('combines projected organization membership across batches without duplicating shared cards',()=>{
  const result=mergeDiscussionSnapshots([page('first',1),page('second',2)]);
  expect(result.messages).toHaveLength(1);expect(result.relations).toHaveLength(1);
  for(const row of [...result.messages,...result.relations])expect(row.targetRefs).toEqual([
    {kind:'message',messageId:'first'},{kind:'message',messageId:'second'},
  ]);
  expect(result.discussion.pageIds).toEqual(['first','second']);
  expect(result.discussion.memberCounts.category).toEqual({direct:2,total:2});
});
it('uses the newest visibility and revision instead of merging an obsolete organization body',()=>{
  const first=page('first',1), second=page('second',2);
  second.messages[0]={...second.messages[0]!,revision:2,restricted:true,content:'正文已遮挡',targetRefs:[]};
  second.relations=[];
  const result=mergeDiscussionSnapshots([first,second]);
  expect(result.messages[0]).toMatchObject({revision:2,restricted:true,content:'正文已遮挡',targetRefs:[]});
  expect(result.relations).toEqual([]);
});
