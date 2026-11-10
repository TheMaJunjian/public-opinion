import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { Mutation, Store } from '../../server/src/db.js';
import { createTestApp, cleanupTestDatabases, testDatabaseUrl } from '../../server/src/test-database.js';
import { financialFingerprint } from './financial-fingerprint.js';
import { migrateModerationDependencyRevisions } from './moderation-dependency-revisions.js';
import { DATABASE_MIGRATIONS } from '../../server/src/database-version.js';

afterEach(async()=>{vi.restoreAllMocks();await cleanupTestDatabases();});

it('repairs the early review index that breaks login without charging content again',async()=>{
  const app=await createTestApp({moderation:true}),agent=request.agent(app);
  const credentials={name:'migration-login',password:'test-password'};
  const registration=await agent.post('/api/register').send(credentials);
  expect(registration.status,registration.text).toBe(201);
  const target=await agent.post('/api/messages').set('x-csrf-token',registration.body.csrf).send({requestId:randomUUID(),recommendation:1,parts:[{id:'body',type:'text',text:'PRIVATE-REVIEW-CONTENT'}]});
  expect(target.status,target.text).toBe(201);
  await app.store.transaction(async()=>{
    const tx=new Mutation(app.store);
    const source=await tx.create(registration.body.user.id,[{id:'reference',type:'relation',relation:'reference',roles:{target:[{id:'target',reference:{messageId:target.body.message.id}}]}}],undefined,'historical-source');
    await tx.commit();
    const next=new Mutation(app.store);
    await next.put({...source,revision:2,parts:[{id:'reference',type:'relation',relation:'reference',roles:{target:[{id:'target',reference:{messageId:target.body.message.id,revision:1}}]}}]});
    await next.commit();
    await app.store.db.exec('DROP TABLE moderation_dependencies; CREATE TABLE moderation_dependencies("sourceId" TEXT NOT NULL,"targetId" TEXT NOT NULL,PRIMARY KEY("sourceId","targetId"))');
    await app.store.db.exec('DELETE FROM schema_migrations WHERE version>=37');
  });
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  expect((await agent.post('/api/login').send(credentials)).status).toBe(500);
  expect(log.mock.calls.some(([error])=>error?.code==='42703')).toBe(true);
  const before=await financialFingerprint(app.store.db);
  const upgraded=await Store.open(testDatabaseUrl(),{schema:app.store.db.schema});
  await upgraded.close();
  expect((await app.store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())?.version).toBe(DATABASE_MIGRATIONS.length);
  expect(await financialFingerprint(app.store.db)).toBe(before);
  const dependencies=await app.store.db.prepare('SELECT "sourceRevision","targetRevision" FROM moderation_dependencies WHERE "sourceId"=$1 ORDER BY "sourceRevision"').all('historical-source');
  expect(dependencies).toEqual([{sourceRevision:1,targetRevision:0},{sourceRevision:2,targetRevision:1}]);
  const login=await agent.post('/api/login').send(credentials);
  expect(login.status,login.text).toBe(200);expect(login.body.user.name).toBe(credentials.name);
  const hidden=await request(app).get(`/api/messages/${target.body.message.id}`);
  expect(hidden.status,hidden.text).toBe(200);expect(hidden.text).toContain('PRIVATE-REVIEW-CONTENT');
  await app.store.transaction(()=>migrateModerationDependencyRevisions(app.store));
  expect(await financialFingerprint(app.store.db)).toBe(before);
  expect(await app.store.db.prepare('SELECT "sourceRevision","targetRevision" FROM moderation_dependencies WHERE "sourceId"=$1 ORDER BY "sourceRevision"').all('historical-source')).toEqual(dependencies);
});
