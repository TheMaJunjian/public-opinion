import { testInvitation } from './test-database.js';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { bindRoles, type Message, type Part, type Session } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases, withTestContribution } from './test-database.js';
import { processDue, send as domainSend } from './messages.js';
import { recordNotifications } from './notifications.js';
import { changes } from './queries.js';
import { updateUsagePoints } from './usage-points.js';
import { migratePrivateNotifications } from '../../migrate/src/private-notifications.js';
import { Mutation } from './db.js';
import {migrateNotificationMemberships} from '../../migrate/src/notification-memberships.js';
import {notificationDeletionSchema} from './notification-schema.js';

type App=Awaited<ReturnType<typeof createTestApp>>;
type Actor={agent:ReturnType<typeof request.agent>;session:Session};
const instances:App[]=[];
const setup=async()=>{const app=await createTestApp();instances.push(app);return app;};
const register=async(app:App,name:string):Promise<Actor>=>{const agent=request.agent(app);const result=await agent.post('/api/register').send({inviteCode:await testInvitation(app),name,password:'notification-password'});expect(result.status,result.text).toBe(201);return {agent,session:result.body};};
const text=(value:string):Part=>({id:'body',type:'text',text:value});
const rel=(relation:string,id:string,role='target',reason:'YES'|'NO'='YES'):Part=>({id:'relation',type:'relation',relation,roles:bindRoles({[role]:[{messageId:id}]}),...(['follow','block'].includes(relation)?{reason}:{})});
async function send(actor:Actor,parts:Part[],extra:Record<string,unknown>={}):Promise<Message>{
  const result=await actor.agent.post('/api/messages').set('x-csrf-token',actor.session.csrf).send(withTestContribution({requestId:randomUUID(),parts,...extra}));
  expect(result.status,result.text).toBe(201);return result.body.message;
}
async function inbox(actor:Actor,query:Record<string,unknown>={}){const result=await actor.agent.get('/api/ui/notifications').query(query);expect(result.status,result.text).toBe(200);return result.body;}
const seen=(actor:Actor,body:object)=>actor.agent.post('/api/ui/notifications/seen').set('x-csrf-token',actor.session.csrf).send(body);
afterEach(async()=>{for(const app of instances.splice(0))await app.close();await cleanupTestDatabases();});

describe('durable private notifications',()=>{
  it('notifies container and member authors about a join and its actual invalidation and restoration',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob'),carol=await register(app,'carol'),dave=await register(app,'dave');
    const parent=await send(alice,[text('自己的分类'),{id:'category',type:'relation',relation:'classify',roles:{}}]);
    const member=await send(bob,[text('加入的成员消息')]);
    const joining=await send(carol,[{id:'relation',type:'relation',relation:'member-of',roles:bindRoles({parent:[{messageId:parent.id}],member:[{messageId:member.id}]})}]);
    const records=async(actor:Actor)=>(await inbox(actor)).items.filter((item:{sourceId:string})=>item.sourceId===joining.id);
    for(const actor of [alice,bob])expect(await records(actor)).toMatchObject([{kind:'member-of',action:'加入已生效',membershipActive:true,navigationId:member.id,targetId:parent.id,actorId:carol.session.user.id,excerpt:'加入的成员消息'}]);
    expect(await records(carol)).toEqual([]);
    await send(dave,[rel('disagree',joining.id)],{wager:1});
    for(const actor of [alice,bob,carol])expect((await records(actor))[0]).toMatchObject({action:'加入已失效',membershipActive:false,navigationId:joining.id,actorId:dave.session.user.id});
    await send(dave,[rel('disagree',joining.id)],{wager:1});
    expect(await records(alice)).toHaveLength(2);
    await send(dave,[rel('agree',joining.id)],{wager:1});
    for(const actor of [alice,bob,carol])expect((await records(actor))[0]).toMatchObject({action:'加入已恢复',membershipActive:true});
    expect(await records(alice)).toHaveLength(3);expect(await records(carol)).toHaveLength(2);expect(await records(dave)).toEqual([]);
    const before=await records(alice);
    await app.store.transaction(async()=>{for(const change of (await changes(app.store,0,100)).changes)await recordNotifications(app.store,change);});
    expect(await records(alice)).toEqual(before);
  });

  it('delivers one alert for an inline member, merges owner and follower reasons, and respects quiet containers',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const parent=await send(alice,[text('分类'),{id:'category',type:'relation',relation:'classify',roles:{}}]);
    await send(alice,[rel('follow',parent.id)]);
    const member=await send(bob,[text('新成员正文'),rel('member-of',parent.id,'parent')]);
    const alerts=(await inbox(alice)).items.filter((item:{kind:string})=>item.kind==='member-of');
    expect(alerts).toHaveLength(1);expect(alerts[0]).toMatchObject({navigationId:member.id,targetId:parent.id,category:'direct'});
    expect(alerts[0].reasons).toEqual(expect.arrayContaining(['你创建了这个分类','你关注了相关消息或分类']));
    await alice.agent.post('/api/ui/notifications/mute').set('x-csrf-token',alice.session.csrf).send({targetId:parent.id,muted:true});
    await send(bob,[text('静音后新成员'),rel('member-of',parent.id,'parent')]);
    await send(alice,[text('自己添加'),rel('member-of',parent.id,'parent')]);
    expect((await inbox(alice)).items.filter((item:{kind:string})=>item.kind==='member-of')).toHaveLength(1);
  });

  it('deletes only the owner’s notifications, never resurrects deliveries, and clears seen snapshots without touching messages or balances',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('正文')]),reply=await send(bob,[text('回复'),rel('reply',target.id)]);
    const snapshot=await inbox(alice),record=snapshot.items.find((item:{sourceId:string})=>item.sourceId===reply.id);
    const remove=(actor:Actor,body:object)=>actor.agent.post('/api/ui/notifications/delete').set('x-csrf-token',actor.session.csrf).send(body);
    expect((await alice.agent.post('/api/ui/notifications/delete').send({through:snapshot.through,ids:[record.id]})).status).toBe(403);
    expect((await remove(alice,{through:snapshot.through})).status).toBe(400);
    await remove(bob,{through:snapshot.through,ids:[record.id]});expect((await inbox(alice)).items).toEqual(snapshot.items);
    const sequence=await app.store.latestSequence(),balance=await app.store.account(alice.session.user.id);
    const reading=(await alice.agent.get('/api/ui/reading-state')).body;
    expect((await remove(alice,{through:snapshot.through,ids:[record.id]})).status).toBe(200);
    expect((await inbox(alice)).unseenCount).toBe(snapshot.unseenCount-1);
    expect(await app.store.message(reply.id)).toEqual(reply);expect(await app.store.latestSequence()).toBe(sequence);
    expect(await app.store.account(alice.session.user.id)).toEqual(balance);
    expect((await alice.agent.get('/api/ui/reading-state')).body).toEqual(reading);
    await app.store.transaction(async()=>{for(const change of (await changes(app.store,0,100)).changes)await recordNotifications(app.store,change);});
    expect((await inbox(alice)).items.some((item:{id:number})=>item.id===record.id)).toBe(false);
    expect((await alice.agent.get('/api/me/notifications')).body.messages.some((item:{id:string})=>item.id===reply.id)).toBe(false);
    await seen(alice,{through:snapshot.through});
    const later=await send(bob,[text('清理期间的新通知'),rel('reply',target.id)]);
    await remove(alice,{through:snapshot.through,seenOnly:true});
    expect((await inbox(alice)).items.map((item:{sourceId:string})=>item.sourceId)).toEqual([later.id]);
  });

  it('upgrades old inboxes and seeds historical membership state without sending old join alerts',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const parent=await send(alice,[text('旧分类'),{id:'category',type:'relation',relation:'classify',roles:{}}]);
    const member=await send(bob,[text('旧成员'),rel('member-of',parent.id,'parent')]);
    const joining=String((await app.store.db.prepare('SELECT "sourceId" FROM memberships WHERE "memberId"=$1').get(member.id))!.sourceId);
    await app.store.transaction(async()=>{
      await app.store.db.prepare('DELETE FROM notifications').run();
      await app.store.db.exec('ALTER TABLE notifications DROP COLUMN "deletedAt"; DROP TABLE notification_membership_states');
      await app.store.db.exec(notificationDeletionSchema);await app.store.db.exec(notificationDeletionSchema);
      await migrateNotificationMemberships(app.store);await migrateNotificationMemberships(app.store);
    });
    await send(bob,[rel('agree',joining)],{wager:1});
    expect((await inbox(alice)).items.filter((item:{sourceId:string})=>item.sourceId===joining)).toEqual([]);
    await send(bob,[rel('disagree',joining)],{wager:1});
    expect((await inbox(alice)).items.find((item:{sourceId:string})=>item.sourceId===joining)).toMatchObject({action:'加入已失效'});
  });

  it('notifies an author without followers, previews recipients, and merges matching reasons',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('原消息')]);
    const preview=await bob.agent.get('/api/ui/notifications/recipients').query({ids:target.id});
    expect(preview.body.users.map((user:{id:string})=>user.id)).toEqual([alice.session.user.id]);
    await send(alice,[rel('follow',target.id)]);
    const explicit=await send(bob,[text('请看这里'),rel('notify',target.id)]);
    const page=await inbox(alice);
    const items=page.items.filter((item:{sourceId:string})=>item.sourceId===explicit.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({category:'direct',seenAt:null,targetId:target.id});
    expect(items[0].reasons).toContain('有人邀请你查看');
    expect(items[0].reasons).toContain('你关注了相关消息或分类');
    expect((await inbox(bob)).items.some((item:{sourceId:string})=>item.sourceId===explicit.id)).toBe(false);
  });

  it('freezes followed descendants at delivery and preserves history after unfollow',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const parent=await send(bob,[text('分类'),{id:'category',type:'relation',relation:'classify',roles:{}}]);
    const child=await send(bob,[text('问题'),rel('member-of',parent.id,'parent')]);
    const old=await send(bob,[text('关注前'),rel('reply',child.id)]);
    await send(alice,[rel('follow',parent.id)]);
    const first=await send(bob,[text('新回复'),rel('reply',child.id)]);
    await send(alice,[rel('follow',parent.id,'target','NO')]);
    const later=await send(bob,[text('取消关注后'),rel('reply',child.id)]);
    const page=await inbox(alice,{category:'following'});
    expect(page.items.map((item:{sourceId:string})=>item.sourceId)).toEqual([first.id]);
    expect(page.items.map((item:{sourceId:string})=>item.sourceId)).not.toContain(old.id);
    expect(page.items.map((item:{sourceId:string})=>item.sourceId)).not.toContain(later.id);
    await send(alice,[rel('follow',parent.id)]);
    expect((await inbox(alice,{category:'following'})).items).toHaveLength(1);
  });

  it('deduplicates retries and rolls inbox writes back with the business transaction',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('目标')]);
    const input=withTestContribution({requestId:randomUUID(),parts:[text('回复'),rel('reply',target.id)]});
    const responses=await Promise.all([1,2].map(()=>bob.agent.post('/api/messages').set('x-csrf-token',bob.session.csrf).send(input)));
    expect(responses.every(response=>response.status===201)).toBe(true);
    const sourceId=responses[0]!.body.message.id;
    expect((await inbox(alice)).items.filter((item:{sourceId:string})=>item.sourceId===sourceId)).toHaveLength(1);
    const journal=await changes(app.store,0,100);
    await app.store.transaction(async()=>{for(const change of journal.changes)await recordNotifications(app.store,change);});
    expect((await inbox(alice)).items.filter((item:{sourceId:string})=>item.sourceId===sourceId)).toHaveLength(1);
    const before=await inbox(alice);
    await expect(app.store.transaction(async()=>{
      await domainSend(app.store,bob.session.user,withTestContribution({requestId:randomUUID(),parts:[text('回滚消息'),rel('reply',target.id)]}));
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect((await inbox(alice)).items).toEqual(before.items);
  });

  it('marks only the selected snapshot, isolates users, and leaves reading, journal and balances intact',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('阅读与通知独立')]);
    await send(bob,[text('第一条'),rel('reply',target.id)]);
    const snapshot=await inbox(alice);
    const later=await send(bob,[text('并发新通知'),rel('reply',target.id)]);
    const sequence=await app.store.latestSequence(),balance=await app.store.account(alice.session.user.id);
    const reading=await alice.agent.get('/api/ui/reading-state');
    expect((await seen(bob,{through:snapshot.through,ids:snapshot.items.map((item:{id:number})=>item.id)})).status).toBe(200);
    expect((await inbox(alice)).unseenCount).toBe(snapshot.unseenCount+1);
    expect((await seen(alice,{through:snapshot.through})).status).toBe(200);
    expect((await inbox(alice,{unread:'true'})).items.map((item:{sourceId:string})=>item.sourceId)).toEqual([later.id]);
    expect((await alice.agent.get('/api/ui/reading-state')).body).toEqual(reading.body);
    expect(await app.store.latestSequence()).toBe(sequence);
    expect(await app.store.account(alice.session.user.id)).toEqual(balance);
    expect((await request(app).get('/api/ui/notifications')).status).toBe(401);
    expect((await alice.agent.post('/api/ui/notifications/seen').send({through:snapshot.through})).status).toBe(403);
    const otherDevice=request.agent(app);
    const login=await otherDevice.post('/api/login').send({name:'alice',password:'notification-password'});
    expect(login.status).toBe(200);
    expect((await otherDevice.get('/api/ui/notifications/summary')).body.unseenCount).toBe(1);
  });

  it('supports quiet discussions, shared vote groups, and excludes automatic usage points',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('讨论')]);
    await send(bob,[rel('agree',target.id)],{wager:2});
    await send(bob,[rel('agree',target.id)],{wager:3});
    const votes=(await inbox(alice)).items.filter((item:{kind:string})=>item.kind==='agree');
    expect(votes).toHaveLength(2);expect(votes[0].groupKey).toBe(votes[1].groupKey);
    expect((await alice.agent.post('/api/ui/notifications/mute').set('x-csrf-token',alice.session.csrf).send({targetId:target.id,muted:true})).status).toBe(200);
    expect((await bob.agent.get('/api/ui/notifications/recipients').query({ids:target.id})).body.users).toEqual([]);
    const rejected=await bob.agent.post('/api/messages').set('x-csrf-token',bob.session.csrf)
      .send(withTestContribution({requestId:randomUUID(),parts:[rel('notify',target.id)]}));
    expect(rejected.status).toBe(400);
    const hidden=await send(bob,[text('静音回复'),rel('reply',target.id)]);
    expect((await inbox(alice)).items.some((item:{sourceId:string})=>item.sourceId===hidden.id)).toBe(false);
    const before=(await inbox(alice)).through,at=Date.now();
    const progress=await updateUsagePoints(app.store,alice.session.user.id,{action:'start'},at);
    await updateUsagePoints(app.store,alice.session.user.id,{action:'tick',roundId:progress.roundId!},at+progress.remainingMs);
    expect((await inbox(alice)).through).toBe(before);
  });

  it('does not let user-supplied usage metadata suppress reply notifications',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('需要收到回复的消息')]);
    const reply=await send(bob,[text('带自定义元数据的回复'),rel('reply',target.id),
      {id:'metadata',type:'data',value:{inputs:{reason:'usage-daily-summary'}}}]);
    expect((await inbox(alice)).items.find((item:{sourceId:string})=>item.sourceId===reply.id))
      .toMatchObject({kind:'reply',actorId:bob.session.user.id,targetId:target.id,seenAt:null});
  });

  it('delivers scheduled settlement results to losers as well as winners, even when muted',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    await app.store.transaction(async()=>app.store.set('rules',{...await app.store.rules(),settlementDelayMs:1}));
    const target=await send(alice,[text('待结算')]);
    await send(alice,[rel('agree',target.id)],{wager:5});
    await send(bob,[rel('disagree',target.id)],{wager:3});
    await bob.agent.post('/api/ui/notifications/mute').set('x-csrf-token',bob.session.csrf).send({targetId:target.id,muted:true});
    await send(alice,[rel('terminate',target.id)]);
    await new Promise(resolve=>setTimeout(resolve,10));await processDue(app.store);
    const winner=(await inbox(alice,{category:'financial'})).items.find((item:{kind:string})=>item.kind==='wager');
    const loser=(await inbox(bob,{category:'financial'})).items.find((item:{kind:string})=>item.kind==='wager');
    expect(winner).toMatchObject({availableDelta:8,lockedDelta:-5,targetId:target.id});
    expect(loser).toMatchObject({availableDelta:0,lockedDelta:-3,targetId:target.id,seenAt:null});
    expect(loser.roundId).toBe(winner.roundId);
    const count=(await inbox(bob)).items.length;await processDue(app.store);expect((await inbox(bob)).items).toHaveLength(count);
  });

  it('migrates only recorded historical recipients as viewed and is repeatable',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('迁移目标')]);
    const explicit=await send(bob,[text('旧通知'),rel('notify',target.id)]);
    await send(alice,[rel('follow',target.id)]);await send(bob,[text('关注动态'),rel('reply',target.id)]);
    await app.store.transaction(async()=>{
      await app.store.db.prepare('DELETE FROM notifications').run();
      await app.store.db.prepare("DELETE FROM settings WHERE key='notifications-start-sequence'").run();
      await migratePrivateNotifications(app.store);await migratePrivateNotifications(app.store);
    });
    const page=await inbox(alice);
    expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({sourceId:explicit.id,seenAt:expect.any(String)});
    expect(page.unseenCount).toBe(0);
  });

  it('keeps pagination stable while new events arrive and rejects a notification with no other recipient',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('分页目标')]);
    const sequence=await app.store.latestSequence();
    const rejected=await alice.agent.post('/api/messages').set('x-csrf-token',alice.session.csrf)
      .send(withTestContribution({requestId:randomUUID(),parts:[rel('notify',target.id)]}));
    expect(rejected.status).toBe(400);expect(await app.store.latestSequence()).toBe(sequence);
    const first=await send(bob,[text('第一页之前'),rel('reply',target.id)]);
    const second=await send(bob,[text('第一页'),rel('reply',target.id)]);
    const top=await inbox(alice,{category:'direct',limit:1});
    expect(top.items[0].sourceId).toBe(second.id);
    await send(bob,[text('分页中到达'),rel('reply',target.id)]);
    const next=await inbox(alice,{category:'direct',limit:1,cursor:top.nextCursor,through:top.through});
    expect(next.items.map((item:{sourceId:string})=>item.sourceId)).toEqual([first.id]);
    expect(next.nextCursor).toBeNull();
  });

  it('attributes later body revisions to the acting user and gives each revision its own notification',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('原始正文')]);
    for(const revision of [2,3])await app.store.transaction(async()=>{
      const tx=new Mutation(app.store);
      await tx.create(bob.session.user.id,[text('修改操作依据')]);
      await tx.put({...await app.store.message(target.id),revision,parts:[text(`第 ${revision} 版`)],updatedAt:new Date().toISOString()});
      await tx.commit();
    });
    const records=(await inbox(alice,{category:'direct'})).items;
    expect(records.map((item:{sourceRevision:number})=>item.sourceRevision)).toEqual([3,2]);
    expect(records.every((item:{actorId:string;kind:string})=>item.actorId===bob.session.user.id&&item.kind==='updated')).toBe(true);
  });

  it('links value settlement notifications to their visible subject and exact round',async()=>{
    const app=await setup(),alice=await register(app,'alice'),bob=await register(app,'bob');
    const target=await send(alice,[text('价值仲裁目标')]);
    const post=(actor:Actor,path:string,body:object)=>actor.agent.post(`/api/ui${path}`).set('x-csrf-token',actor.session.csrf).send(body);
    const round=await post(bob,`/messages/${target.id}/rounds`,{settlementType:'VALUE'});expect(round.status,round.text).toBe(201);
    expect((await post(alice,`/rounds/${round.body.id}/votes`,{vote:'TRUE',amount:5})).status).toBe(201);
    expect((await post(bob,`/rounds/${round.body.id}/votes`,{vote:'FALSE',amount:3})).status).toBe(201);
    const result=await post(bob,`/rounds/${round.body.id}/close-and-settle`,{});expect(result.status,result.text).toBe(201);
    const notification=(await inbox(alice,{category:'financial'})).items.find((item:{kind:string})=>item.kind==='wager');
    expect(notification).toMatchObject({roundId:round.body.id,settlementType:'VALUE',settlementTargetId:target.id});
  });
});
