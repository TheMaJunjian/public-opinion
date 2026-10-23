import {afterEach,expect,it} from 'vitest';
import {bindRoles,relations} from '@gonglun/core';
import {Mutation} from '../../server/src/db.js';
import {cleanupTestDatabases,createTestStore} from '../../server/src/test-database.js';
import {migrateMessageFormat} from './migrate-message-format.js';
afterEach(cleanupTestDatabases);

it('仅转换旧文本更正，保留原选区位置和原生修改申请的授权语义',async()=>{
  const store=await createTestStore();
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    await tx.create('system',[{id:'body',type:'text',text:'重复重复'}],undefined,'target');
    const ref={messageId:'target',revision:1,partId:'body',range:{start:2,end:4}};
    for(const [id,metadata] of [['proposal',{value:'申请',expectedRevision:1}],['correction',{uiType:'CORRECT',correctionContent:'改字',value:'改字',expectedRevision:1}]] as const){
      await tx.create('system',[{id:'relation',type:'relation',relation:'amend',roles:bindRoles({target:[ref]})},{id:'data',type:'data',value:metadata}],undefined,id);
    }
    await tx.commit();await migrateMessageFormat(store);
  });
  expect(relations(await store.message('proposal'))[0].relation).toBe('amend');
  const correction=await store.message('correction'),part=relations(correction)[0];
  expect(part.relation).toBe('correct');expect(part.roles.target[0].reference.range).toEqual({start:2,end:4});
  expect(correction.parts).toContainEqual({id:'corrected-body',type:'text',text:'重复改字'});
});
