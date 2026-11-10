import {afterEach,expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createTestApp,cleanupTestDatabases} from '../../server/src/test-database.js';
import {executeBatch,executeCommand} from '../../server/src/ui-commands.js';
import {pointTransactions} from '../../server/src/point-transactions.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {migrateLedgerOperations} from './ledger-operations.js';

afterEach(cleanupTestDatabases);

it('recovers complete batches from historical receipts without changing money, journals or request data',async()=>{
  const app=await createTestApp(),store=app.store;
  const {body:{user}}=await request(app).post('/api/register').send({name:'迁移操作分组',password:'password'});
  const target=await executeCommand({store,user,requestId:randomUUID()},'POST','/messages',{content:'原目标',recommendation:1});
  const batches=[];
  for(let i=0;i<2;i++){
    const textId=randomUUID();
    const batch={requestId:randomUUID(),commands:[
      {id:textId,method:'POST',path:'/messages',body:{content:'同样的正文',recommendation:1}},
      {id:randomUUID(),method:'POST',path:'/relations',body:{relationType:'REFERENCE',sourceMessageId:textId,targetRefs:[{kind:'message',messageId:target.id}],recommendation:1}},
    ]};
    await executeBatch(store,user,batch);batches.push(batch);
  }
  // Older receipts predate the batch projection range; their child receipts still prove membership.
  await store.db.prepare('UPDATE command_requests SET result=(result::jsonb-\'projection\')::text WHERE "requestId"=$1').run(batches[1].requestId);
  await store.db.exec('UPDATE ledger SET "createdAt"=\'2026-11-10T00:00:00Z\'; DROP TABLE ledger_operations;');
  const before=await financialFingerprint(store.db),journal=await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all();
  const receipts=await store.db.prepare('SELECT * FROM command_requests ORDER BY "requestId"').all();
  await store.transaction(()=>migrateLedgerOperations(store));
  expect(await financialFingerprint(store.db)).toBe(before);
  expect(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).toEqual(journal);
  expect(await store.db.prepare('SELECT * FROM command_requests ORDER BY "requestId"').all()).toEqual(receipts);
  const history=await pointTransactions(store,user.id,{limit:1});
  expect(history.pagination).toEqual({page:1,limit:1,total:4,totalPages:4});
  const latest=history.data[0];expect(latest).toMatchObject({type:'OPERATION_GROUP',amount:-4,entryCount:4});
  expect(latest.messages.map(m=>m.messageId)).toEqual(batches[1].commands.map(c=>c.id));
  const prior=await pointTransactions(store,user.id,{page:2,limit:1});
  expect(prior.data[0].messages.map(m=>m.messageId)).toEqual(batches[0].commands.map(c=>c.id));
  expect(prior.data[0].id).not.toBe(latest.id);
  const mapping=await store.db.prepare('SELECT * FROM ledger_operations ORDER BY "entryId"').all();
  await store.transaction(()=>migrateLedgerOperations(store));
  expect(await store.db.prepare('SELECT * FROM ledger_operations ORDER BY "entryId"').all()).toEqual(mapping);
});
