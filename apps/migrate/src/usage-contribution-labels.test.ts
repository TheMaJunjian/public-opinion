import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { replayArchive, updateUsageRewardMessage, type Message, type Json } from '@gonglun/core';
import { Store } from '../../server/src/db.js';
import { updateUsagePoints } from '../../server/src/usage-points.js';
import { cleanupTestDatabases, createTestApp, testDatabaseUrl } from '../../server/src/test-database.js';
import { financialFingerprint } from './financial-fingerprint.js';

afterEach(cleanupTestDatabases);
it('旧汇总改称使用贡献时不改变余额和原历史，后续自动累计与完整复算保持一致', async () => {
  const app = await createTestApp({ initialGrant: 0 }), store = app.store;
  const {body:session} = await request(app).post('/api/register').send({name:'名称升级',password:'password'});
  const at=Date.parse('2026-11-01T12:00:00+08:00');
  const first=await updateUsagePoints(store,session.user.id,{action:'start'},at);
  const second=await updateUsagePoints(store,session.user.id,{action:'tick',roundId:first.roundId},at+1000);
  const third=await updateUsagePoints(store,session.user.id,{action:'tick',roundId:second.roundId},at+3000);
  const summary=(await store.db.prepare('SELECT "messageId" FROM usage_reward_days').get())!.messageId;
  const legacy=(input:Message):Message=>{
    const message=structuredClone(input),allocation=message.parts.find(part=>part.id==='allocation'&&part.type==='data');
    if(allocation?.type!=='data')throw new Error('缺少汇总');
    const value=allocation.value as Record<string,Json>,inputs=value.inputs as Record<string,Json>;
    delete inputs.terminology;
    (value.allocations as Record<string,Json>[])[0].reason='使用奖励汇总';
    return updateUsageRewardMessage(message,Number(value.total),message.sequence,message.updatedAt);
  };
  await store.transaction(async()=>{
    const message=legacy(await store.message(String(summary)));
    await store.db.prepare('UPDATE messages SET body=$2 WHERE id=$1').run(summary,JSON.stringify(message));
    await store.db.prepare('UPDATE revisions SET body=$2 WHERE "messageId"=$1').run(summary,JSON.stringify(message));
    for(const row of await store.db.prepare('SELECT sequence,body FROM changes ORDER BY sequence').all()){
      const change=JSON.parse(String(row.body));
      change.messages=change.messages.map((m:Message)=>m.id===summary?legacy(m):m);
      await store.db.prepare('UPDATE changes SET body=$2 WHERE sequence=$1').run(row.sequence,JSON.stringify(change));
    }
    await store.db.prepare('UPDATE ledger SET reason=$2 WHERE "messageId"=$1').run(summary,'使用奖励汇总');
    await store.db.exec('DELETE FROM schema_migrations WHERE version>=30');
  });
  const before=await financialFingerprint(store.db), account=await store.account(session.user.id);
  const upgraded=await Store.open(testDatabaseUrl(),{schema:store.db.schema});
  try{
    expect(await financialFingerprint(upgraded.db)).toBe(before);
    expect(await upgraded.account(session.user.id)).toEqual(account);
    expect(JSON.stringify(await upgraded.message(String(summary)))).toContain('使用贡献');
    expect(JSON.stringify(await upgraded.message(String(summary)))).not.toContain('使用奖励');
    await updateUsagePoints(upgraded,session.user.id,{action:'tick',roundId:third.roundId},at+6000);
    const changes=(await upgraded.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
    const replay=replayArchive({format:'gonglun-2',changes});
    expect(replay.messages[0]).toEqual(await upgraded.message(String(summary)));
    expect(replay.accounts.get(session.user.id)).toEqual(await upgraded.account(session.user.id));
    expect((await upgraded.account(session.user.id)).available).toBe(3);
  }finally{await upgraded.close();}
});
