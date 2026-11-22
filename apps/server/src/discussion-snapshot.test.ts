import { PARTICIPATION_AGREEMENT_VERSION } from '@gonglun/core';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bindRoles, isRelationView, type Message, type Part, type Session, type WorkbenchSnapshot } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases, withTestContribution } from './test-database.js';
import { Mutation } from './db.js';
import { viewsFor } from './ui-projections.js';
import { recordStance } from './projections.js';
import { convertMessagesToDemoModel, computeCorrectionVersions, computeEffectiveSuppressedRelIds } from '../../../frontend/src/utils/modelBridge.js';
import { deriveContainerEffect } from '../../../frontend/src/pages/workbench/model/containerEffect.js';

afterEach(cleanupTestDatabases);
type App = Awaited<ReturnType<typeof createTestApp>>;
async function actor(app: App, name = 'window-reader') {
  const agent = request.agent(app);
  const response = await agent.post('/api/register').send({acceptedAgreementVersion: PARTICIPATION_AGREEMENT_VERSION,  name, password: 'test-password' });
  expect(response.status).toBe(201);
  return { agent, session: response.body as Session };
}
const body = (text: string): Part => ({ id: 'body', type: 'text', text });
const relation = (name: string, roles: Record<string, Array<{messageId:string}>>): Part => ({ id: 'relation', type: 'relation', relation: name, roles: bindRoles(roles) });
async function seed(app: App, userId: string, parts: Part[][]) {
  return app.store.transaction(async () => {
    const tx = new Mutation(app.store), messages: Message[] = [];
    for (const value of parts) messages.push(await tx.create(userId, value));
    await tx.commit(); return messages;
  });
}
async function page(who: Awaited<ReturnType<typeof actor>>, query: object): Promise<WorkbenchSnapshot> {
  const response = await who.agent.post('/api/ui/snapshot/discussion').send(query);
  expect(response.status, response.text).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['server-timing']).toContain('projection;dur=');
  return response.body;
}

it('pages root messages after leaving a category without reopening its members', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [category, child] = await seed(app, who.session.user.id, [[body('退出的分类'), relation('classify', {})], [body('分类内正文')]]);
  const roots = await seed(app, who.session.user.id, Array.from({length:45}, (_, n) => [body(`根目录 ${n}`)]));
  await app.store.transaction(async () => {
    await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(child!.id,category!.id);
  });
  const seen = new Set<string>(); let cursor: string | undefined;
  for (const size of [20,20,5]) {
    const result = await page(who,{focusId:category!.id,classificationId:'root',cursor});
    expect(result.discussion!.pageIds).toHaveLength(size);
    expect(result.messages.some(row=>row.id===category!.id)).toBe(true);
    expect(result.messages.some(row=>row.id===child!.id)).toBe(false);
    for (const id of result.discussion!.pageIds) { expect(seen.has(id)).toBe(false); seen.add(id); }
    cursor = result.discussion!.nextCursor ?? undefined;
  }
  expect(cursor).toBeUndefined();
  expect(seen).toEqual(new Set(roots.map(row=>row.id)));
});

it.each(['merge','arrange'])('includes effective inline %s members but keeps nested classifications closed', async kind => {
  const app = await createTestApp(), who = await actor(app);
  const [category, frame, nested, hidden, moved, ...members] = await seed(app, who.session.user.id, [
    [body('分类'),relation('classify',{})], [body('行内组织'),relation(kind,{})],
    [body('关闭的分类'),relation('classify',{})], [body('关闭的分类内正文')], [body('已移出的成员')],
    ...Array.from({length:4},(_,n)=>[body(`成员 ${n}`)]),
  ]);
  await app.store.transaction(async()=>{
    for(const [member,parent] of [[frame!,category!],[nested!,frame!],[hidden!,nested!],[moved!,category!],...members.map(row=>[row,frame!] as const)])
      await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(member.id,parent.id);
  });
  const result = await page(who,{focusId:category!.id});
  expect(result.discussion!.pageIds).toEqual(expect.arrayContaining([frame!.id,moved!.id]));
  expect(result.messages.map(row=>row.id)).toEqual(expect.arrayContaining(members.map(row=>row.id)));
  expect(result.messages.some(row=>row.id===hidden!.id)).toBe(false);
  expect(result.messages.find(row=>row.id===frame!.id)!.targetRefs!.map(ref=>ref.kind==='relation'?ref.relationId:ref.messageId))
    .toEqual(expect.arrayContaining([...members.map(row=>row.id),nested!.id]));
  expect(result.discussion!.memberCounts[frame!.id]).toEqual({direct:5,total:6});
});

it('loads a direct message independently of unrelated records and writes no reading or public state', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [focus, ...unrelated] = await seed(app, who.session.user.id, Array.from({length:150}, (_, n) => [body(`讨论 ${n}`)]));
  const sequence = await app.store.latestSequence();
  const result = await page(who, {focusId:focus!.id});
  expect(result.messages.map(row => row.id)).toEqual([focus!.id]);
  expect(result.messages.some(row => unrelated.some(other => other.id === row.id))).toBe(false);
  expect(result.discussion?.nextCursor).toBeNull();
  expect(await app.store.latestSequence()).toBe(sequence);
  expect((await who.agent.get('/api/ui/reading-state')).body.marks).toEqual([]);
  expect((await request(app).post('/api/ui/snapshot/discussion').send({focusId:focus!.id})).status).toBe(401);
  expect((await who.agent.post('/api/ui/snapshot/discussion').send({focusId:focus!.id, limit:5000})).status).toBe(400);
});

it('pages a wide classification without loading unopened descendants, and binds the cursor to its scope and reader', async () => {
  const app = await createTestApp(), who = await actor(app), other = await actor(app, 'other-reader');
  const [category, nested] = await seed(app, who.session.user.id, [[body('分类'), relation('classify',{})], [body('尚未打开的分类'), relation('classify',{})]]);
  const children = await seed(app, who.session.user.id, Array.from({length:65}, (_, n) => [body(`分类内 ${n}`)]));
  const [hidden] = await seed(app, who.session.user.id, [[body('尚未打开的正文')]]);
  await app.store.transaction(async () => {
    for (const row of [...children, nested!]) await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(row.id,category!.id);
    await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(hidden!.id,nested!.id);
  });
  const first = await page(who,{focusId:category!.id});
  expect(first.discussion?.pageIds).toHaveLength(20);
  expect(first.messages.length).toBeLessThanOrEqual(21);
  expect(first.messages.some(row => row.id === hidden!.id)).toBe(false);
  expect(first.discussion?.memberCounts[category!.id]).toEqual({direct:66,total:67});
  expect(first.messages.find(row=>row.id===category!.id)?.targetRefs).toHaveLength(20);
  const withSelection = await page(who,{focusId:category!.id,cursor:first.discussion!.nextCursor,extraIds:[first.discussion!.pageIds[0]]});
  expect(withSelection.messages.some(row=>row.id===first.discussion!.pageIds[0])).toBe(true);
  expect(withSelection.discussion!.pageIds.some(id=>first.discussion!.pageIds.includes(id))).toBe(false);
  const seen = new Set(first.discussion!.pageIds);
  let next = first.discussion!.nextCursor;
  while(next) {
    const result = await page(who,{focusId:category!.id,cursor:next});
    for (const id of result.discussion!.pageIds) { expect(seen.has(id)).toBe(false); seen.add(id); }
    expect(result.messages.length).toBeLessThanOrEqual(22);
    next = result.discussion!.nextCursor;
  }
  expect(seen.size).toBe(66);
  expect((await other.agent.post('/api/ui/snapshot/discussion').send({focusId:category!.id,cursor:first.discussion!.nextCursor})).status).toBe(409);
  expect((await who.agent.post('/api/ui/snapshot/discussion').send({focusId:nested!.id,cursor:first.discussion!.nextCursor})).status).toBe(409);
  const [newest] = await seed(app, who.session.user.id, [[body('分页后新到的消息')]]);
  await app.store.transaction(() => app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(newest!.id, category!.id));
  const refreshed = await page(who, {focusId:category!.id,cursor:first.discussion!.cursor});
  expect(refreshed.discussion!.pageIds).toEqual(first.discussion!.pageIds);
  expect((await page(who, {focusId:category!.id})).discussion!.pageIds).toContain(newest!.id);
  const inside = await page(who,{focusId:category!.id,classificationId:nested!.id});
  expect(inside.messages.some(row => row.id === hidden!.id)).toBe(true);
});

it('includes complete correction and stance chains plus competing membership records', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [focus, category, unrelated] = await seed(app,who.session.user.id,[[body('原文')],[body('分类'),relation('classify',{})],[body('无关正文')]]);
  const [correction] = await seed(app,who.session.user.id,[[body('更正'),relation('correct',{target:[{messageId:focus!.id}]})]]);
  const [stance] = await seed(app,who.session.user.id,[[relation('disagree',{target:[{messageId:correction!.id}]})]]);
  const [against, join] = await seed(app,who.session.user.id,[[relation('disagree',{target:[{messageId:stance!.id}]})],[relation('member-of',{parent:[{messageId:category!.id}],member:[{messageId:focus!.id}]})]]);
  const result = await page(who,{focusId:focus!.id});
  expect(new Set(result.messages.map(row=>row.id))).toEqual(new Set([focus,category,correction,stance,against,join].map(row=>row!.id)));
  expect(result.messages.some(row=>row.id===unrelated!.id)).toBe(false);
  expect(result.messages.find(row=>row.id===focus!.id)?.parts).toEqual((await app.store.message(focus!.id)).parts);
});

it('does not treat effects stored in a category or citing it as effects on the category', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [category, focus, outside] = await seed(app, who.session.user.id, [
    [body('当前分类'), relation('classify', {})], [body('本页正文')], [body('另一段讨论')],
  ]);
  const kinds = ['agree', 'disagree', 'correct', 'amend', 'annotation', 'tag', 'recommend', 'archive', 'low-quality', 'follow', 'unfollow', 'block', 'unblock', 'read', 'unread'];
  const unrelated = await seed(app, who.session.user.id, Array.from({ length: kinds.length * 3 }, (_, index) => [
    relation(kinds[index % kinds.length]!, {
      target: [{ messageId: outside!.id }],
      // A reason/source binding is not the target of a stance or correction.
      ...(index % 3 === 0 ? { reason: [{ messageId: category!.id }] } : {}),
      ...(index % 3 === 1 && kinds[index % kinds.length] !== 'annotation' ? { source: [{ messageId: category!.id }] } : {}),
    }),
    { ...relation('member-of', { parent: [{ messageId: category!.id }] }), id: 'placement' },
  ]));
  const [correction] = await seed(app, who.session.user.id, [[body('本页更正'), relation('correct', { target: [{ messageId: focus!.id }] })]]);
  const [stance] = await seed(app, who.session.user.id, [[relation('disagree', { target: [{ messageId: correction!.id }] })]]);
  await app.store.transaction(async () => {
    for (const member of [focus!, ...unrelated]) await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(member.id, category!.id);
  });
  const result = await page(who, { focusId: category!.id });
  expect(result.discussion!.pageIds).toEqual([focus!.id]);
  expect(new Set(result.messages.map(message => message.id))).toEqual(new Set([category, focus, correction, stance].map(message => message!.id)));
});

it('refuses genuinely oversized effect chains instead of publishing incomplete semantics', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [focus] = await seed(app, who.session.user.id, [[body('当前消息')]]);
  await seed(app, who.session.user.id, Array.from({ length: 601 }, () => [relation('agree', { target: [{ messageId: focus!.id }] })]));
  const response = await who.agent.post('/api/ui/snapshot/discussion').send({ focusId: focus!.id });
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('DISCUSSION_TOO_LARGE');
  expect(response.body.messages).toBeUndefined();
}, 30_000);

it('loads review history on demand without importing every audit and its trigger discussion', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [focus, trigger] = await seed(app, who.session.user.id, [[body('当前正文')], [body('审核触发原因')]]);
  const audits = await seed(app, who.session.user.id, Array.from({length:601}, () => [
    body('审核历史'), relation('review-record', {target:[{messageId:focus!.id}], trigger:[{messageId:trigger!.id}]}),
  ]));
  const first = await page(who, {focusId:focus!.id});
  expect(first.messages.map(message => message.id)).toEqual([focus!.id]);
  expect(first.discussion!.pageIds).toEqual([]);
  const selected = await page(who, {focusId:focus!.id, recordIds:[audits[0]!.id]});
  expect(new Set(selected.messages.map(message => message.id))).toEqual(new Set([focus!.id, trigger!.id, audits[0]!.id]));
  expect(selected.messages.find(message => message.id === audits[0]!.id)!.parts).toEqual(audits[0]!.parts);
}, 30_000);

it.each(['merge','arrange'])('keeps an ancestor %s closed while preserving the member and its ownership context', async kind => {
  const app = await createTestApp(), who = await actor(app);
  const [focus, frame, ...siblings] = await seed(app, who.session.user.id, [
    [body('当前正文')], [body('所属组织'), relation(kind,{})],
    ...Array.from({length:601}, (_,n) => [body(`另一成员 ${n}`)]),
  ]);
  const [join] = await seed(app, who.session.user.id, [[relation('member-of', {member:[{messageId:focus!.id}],parent:[{messageId:frame!.id}]})]]);
  await seed(app,who.session.user.id,[[relation('reference',{source:[{messageId:frame!.id}],target:[{messageId:siblings[0]!.id}]})]]);
  await app.store.transaction(async () => {
    const tx = new Mutation(app.store);
    focus!.parts.push({...relation('member-of',{parent:[{messageId:frame!.id}]}),id:'placement'});
    await tx.put(focus!); await tx.commit();
    // Legacy placements may name the parent itself as the membership source.
    for (const member of [focus!, ...siblings]) await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$3)').run(member.id,frame!.id,member === focus && kind === 'merge' ? join!.id : frame!.id);
  });
  const result = await page(who,{focusId:focus!.id});
  expect(new Set(result.messages.map(message => message.id))).toEqual(new Set([focus!.id,frame!.id,join!.id]));
  expect(result.discussion!.memberCounts[frame!.id]).toEqual({direct:602,total:602});
}, 30_000);

it('keeps referenced discussions closed and opens their own references only when selected', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [category, ...bodies] = await seed(app, who.session.user.id, [
    [body('当前分类'), relation('classify',{})], ...Array.from({length:45}, (_,n) => [body(`引用链 ${n}`)]),
  ]);
  const links = await seed(app, who.session.user.id, bodies.slice(0,-1).map((source,index) => [
    relation('reference',{source:[{messageId:source.id}],target:[{messageId:bodies[index+1]!.id}]}),
  ]));
  await app.store.transaction(async()=>{
    await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(bodies[0]!.id,category!.id);
    for(const message of bodies) await recordStance(app.store,message,{target:{messageId:message.id},side:'pro'});
  });
  const result = await page(who,{focusId:category!.id});
  expect(new Set(result.messages.map(message => message.id))).toEqual(new Set([category!.id,bodies[0]!.id,bodies[1]!.id,links[0]!.id]));
  expect(new Set(result.discussion!.expandedIds)).toEqual(new Set([category!.id,bodies[0]!.id]));
  const expanded = await page(who,{focusId:category!.id,extraIds:[bodies[1]!.id]});
  expect(new Set(expanded.messages.map(message => message.id))).toEqual(new Set([category!.id,...bodies.slice(0,3).map(message=>message.id),...links.slice(0,2).map(message=>message.id)]));
  expect(expanded.discussion!.expandedIds).toContain(bodies[1]!.id);
});

it('pages direct replies without treating placement or review context as discussion links', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [focus, parent, auditTrigger] = await seed(app,who.session.user.id,[[body('正文')],[body('父级'),relation('merge',{})],[body('审核触发')]]);
  const replies = await seed(app,who.session.user.id,Array.from({length:45},(_,index)=>[
    body(`回复 ${index}`),relation('reply',{target:[{messageId:focus!.id}]}),
  ]));
  const [reviewReply] = await seed(app,who.session.user.id,[[
    body('审核区讨论'),{...relation('review-context',{target:[{messageId:focus!.id}]}),id:'context'},
    relation('reply',{target:[{messageId:auditTrigger!.id}]}),
  ]]);
  await app.store.transaction(async()=>{
    const tx=new Mutation(app.store);
    focus!.parts.push({...relation('member-of',{parent:[{messageId:parent!.id}]}),id:'placement'});
    await tx.put(focus!);await tx.commit();
    await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(focus!.id,parent!.id);
  });
  const seen=new Set<string>();let cursor:string|undefined;
  for(const size of [20,20,5]){
    const result=await page(who,{focusId:focus!.id,cursor});
    expect(result.discussion!.pageIds).toHaveLength(size);
    expect(new Set(result.messages.map(message=>message.id))).toEqual(new Set([focus!.id,parent!.id,...result.discussion!.pageIds]));
    for(const id of result.discussion!.pageIds){expect(seen.has(id)).toBe(false);seen.add(id);}
    cursor=result.discussion!.nextCursor??undefined;
  }
  expect(cursor).toBeUndefined();expect(seen).toEqual(new Set(replies.map(message=>message.id)));
  const selected=await page(who,{focusId:reviewReply!.id});
  expect(selected.messages.map(message=>message.id)).toEqual(expect.arrayContaining([reviewReply!.id,auditTrigger!.id,focus!.id]));
});

it('preserves complete decisions for corrections, annotations and edited membership history', async () => {
  const app=await createTestApp(),who=await actor(app);
  const [focus,firstParent,nextParent,reason,unrelated,editedTarget]=await seed(app,who.session.user.id,[
    [body('原文')],[body('原归属'),relation('classify',{})],[body('候选归属'),relation('merge',{})],
    [body('注释依据')],[body('修改后的成员')],[body('修改后的表态目标')],
  ]);
  const [correction,annotation,originalJoin,editedJoin]=await seed(app,who.session.user.id,[
    [body('更正正文'),relation('correct',{target:[{messageId:focus!.id}]})],
    [body('注释'),relation('annotation',{source:[{messageId:reason!.id}],target:[{messageId:focus!.id}]})],
    [relation('member-of',{member:[{messageId:focus!.id}],parent:[{messageId:firstParent!.id}]})],
    // Its raw target has changed, but the original executed history still
    // competes for focus. It must be found through the membership index.
    [relation('member-of',{member:[{messageId:unrelated!.id}],parent:[{messageId:nextParent!.id}]})],
  ]);
  const stances=await seed(app,who.session.user.id,[
    [relation('disagree',{target:[{messageId:correction!.id}]})],
    [relation('disagree',{target:[{messageId:annotation!.id}]})],
    [relation('disagree',{target:[{messageId:nextParent!.id}]})],
  ]);
  const [counter]=await seed(app,who.session.user.id,[[relation('disagree',{target:[{messageId:stances[0]!.id}]})]]);
  const [editedStance]=await seed(app,who.session.user.id,[[relation('agree',{target:[{messageId:editedTarget!.id}]})]]);
  await app.store.transaction(async()=>{
    const tx=new Mutation(app.store);
    for(const [index,join] of [originalJoin!,editedJoin!].entries()){
      const history={id:join.id,memberId:focus!.id,parentId:index?nextParent!.id:firstParent!.id,
        previousId:index?originalJoin!.id:null,previousParentId:index?firstParent!.id:null,order:index+1,
        sourcePartId:'relation',bindingId:((originalJoin!.parts[0] as Extract<Part,{type:'relation'}>).roles.member![0]!).id,sourceRevision:1};
      join.parts.push({id:'membership-history',type:'data',value:{membershipHistory:history}});
      await tx.put(join);
      await app.store.db.prepare('INSERT INTO membership_actions(id,body,disabled) VALUES($1,$2,$3)').run(join.id,JSON.stringify(history),!!index);
    }
    await tx.commit();
    const target={messageId:correction!.id,revision:1};
    await app.store.db.prepare('INSERT INTO execution_stances("sourceId",revision,"partId",target,side) VALUES($1,1,$2,$3,$4)')
      .run(editedStance!.id,'relation',JSON.stringify(target),'pro');
    await recordStance(app.store,editedStance!,{target,side:'pro'});
    await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$3)').run(focus!.id,firstParent!.id,originalJoin!.id);
  });
  const window=await page(who,{focusId:focus!.id});
  expect(window.messages.map(message=>message.id)).toEqual(expect.arrayContaining([focus,firstParent,nextParent,reason,correction,annotation,originalJoin,editedJoin,...stances,counter,editedStance].map(message=>message!.id)));
  const fullViews=await app.store.read(async()=>viewsFor(app.store,(await app.store.db.prepare('SELECT body FROM messages').all()).map(row=>JSON.parse(String(row.body)))));
  const fullRelations=fullViews.filter(isRelationView);
  const full=convertMessagesToDemoModel(fullViews,fullRelations),scoped=convertMessagesToDemoModel(window.messages,window.relations);
  for(const username of [null,who.session.user.name]){
    expect(computeEffectiveSuppressedRelIds(scoped.edges,scoped.messages,username)).toEqual(computeEffectiveSuppressedRelIds(full.edges,full.messages,username));
    expect(computeCorrectionVersions(scoped.messages,scoped.edges,new Set(),username).get(focus!.id))
      .toEqual(computeCorrectionVersions(full.messages,full.edges,new Set(),username).get(focus!.id));
    expect(computeCorrectionVersions(scoped.messages,scoped.edges,new Set(),username).get(focus!.id)?.versions.map(version=>version.correctionId)).toEqual([correction!.id]);
    const scopedEffect=deriveContainerEffect({...scoped,relations:window.relations,username});
    const fullEffect=deriveContainerEffect({...full,relations:fullRelations,username});
    expect(scopedEffect.joinByTarget.get(focus!.id)).toBe(fullEffect.joinByTarget.get(focus!.id));
    expect(scopedEffect.joinByTarget.get(focus!.id)).toBe(originalJoin!.id);
    expect(scopedEffect.effectiveJoinIds).toEqual(fullEffect.effectiveJoinIds);
  }
});

it('finishes a necessary semantic chain beyond forty waves without truncation', async () => {
  const app = await createTestApp(), who = await actor(app);
  const messages = await app.store.transaction(async () => {
    const tx = new Mutation(app.store), result = [await tx.create(who.session.user.id,[body('原文')])];
    for(let index=0;index<45;index++) result.push(await tx.create(who.session.user.id,[relation('disagree',{target:[{messageId:result.at(-1)!.id}]})]));
    await tx.commit(); return result;
  });
  const result = await page(who,{focusId:messages[0]!.id});
  expect(new Set(result.messages.map(message=>message.id))).toEqual(new Set(messages.map(message=>message.id)));
});

it('loads references owned by paged category members without opening other members or incoming discussions', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [source, target, outside, nested, hidden] = await seed(app, who.session.user.id, [
    [body('分类正文')], [body('引用原文')], [body('另一段讨论')],
    [body('未打开的分类'), relation('classify', {})], [body('未打开的分类正文')],
  ]);
  const [category] = await seed(app, who.session.user.id, [[body('分类'), relation('classify', {
    members: [source!, target!, nested!].map(message => ({ messageId: message.id })),
  })]]);
  const [reference, reply, incoming, hiddenJoin] = await seed(app, who.session.user.id, [
    [relation('reference', { source: [{messageId:source!.id}], target: [{messageId:target!.id}] })],
    [relation('reply', { source: [{messageId:target!.id}], target: [{messageId:source!.id}] })],
    [relation('reference', { source: [{messageId:outside!.id}], target: [{messageId:target!.id}] })],
    [relation('member-of', { parent: [{messageId:nested!.id}], member: [{messageId:hidden!.id}] })],
  ]);
  const [stance] = await seed(app, who.session.user.id, [[relation('disagree', {target:[{messageId:reference!.id}]})]]);
  await app.store.transaction(async () => {
    for (const member of [source, target, nested]) await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(member!.id, category!.id);
    await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$3)').run(hidden!.id, nested!.id, hiddenJoin!.id);
  });
  const result = await page(who, {focusId:category!.id});
  const ids = result.messages.map(message => message.id);
  expect(result.discussion!.pageIds.sort()).toEqual([source!.id, target!.id, nested!.id].sort());
  expect(ids).toEqual(expect.arrayContaining([reference!.id, reply!.id, stance!.id]));
  for (const absent of [outside, incoming, hidden, hiddenJoin]) expect(ids).not.toContain(absent!.id);
  expect(result.relations.find(message => message.id === reference!.id)).toMatchObject({
    sourceMessageId: source!.id, targetRefs: [expect.objectContaining({messageId:target!.id})],
  });
});

it('traces each direction from the selected message without crossing into sibling discussions', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [upstream] = await seed(app, who.session.user.id, [[body('共同上游')]]);
  const [focus, sibling] = await seed(app, who.session.user.id, [
    [body('当前讨论'), relation('reply', { target: [{ messageId: upstream!.id }] })],
    [body('另一段讨论'), relation('reply', { target: [{ messageId: upstream!.id }] })],
  ]);
  const [downstream] = await seed(app, who.session.user.id, [[body('当前讨论的后续'), relation('reply', { target: [{ messageId: focus!.id }] })]]);
  const result = await page(who, { focusId: focus!.id, trace: { ids: [focus!.id], depths: { up: 1, down: 1 }, expandedIds: [] } });
  expect(new Set(result.discussion!.pageIds)).toEqual(new Set([upstream!.id, downstream!.id]));
  expect(result.messages.some(row => row.id === sibling!.id)).toBe(false);
});

it.each(['up', 'down'] as const)('traces %s through source/target relations without reversing their direction', async direction => {
  const app = await createTestApp(), who = await actor(app);
  const [upstream, focus, downstream, sibling] = await seed(app, who.session.user.id,
    ['依据', '当前消息', '后续消息', '旁支消息'].map(text => [body(text)]));
  const [reference, reply] = await seed(app, who.session.user.id, [
    [relation('reference', { source: [{ messageId: focus!.id }], target: [{ messageId: upstream!.id }] })],
    [relation('reply', { source: [{ messageId: downstream!.id }], target: [{ messageId: focus!.id }] })],
    [relation('reply', { source: [{ messageId: sibling!.id }], target: [{ messageId: upstream!.id }] })],
  ]);
  const result = await page(who, { focusId: focus!.id, trace: { ids: [focus!.id], depths: { up: direction === 'up' ? 1 : 0, down: direction === 'down' ? 1 : 0 }, expandedIds: [] } });
  const expected = direction === 'up' ? [focus, upstream, reference] : [focus, downstream, reply];
  expect(new Set(result.messages.map(row => row.id))).toEqual(new Set(expected.map(row => row!.id)));
});

it('revalidates moderation for every page and refuses a restricted focus', async () => {
  const app = await createTestApp({moderation:true}), author = await actor(app), reader = await actor(app,'reader');
  const [focus] = await seed(app,author.session.user.id,[[body('原文')]]);
  const sent = await author.agent.post('/api/messages').set('x-csrf-token', author.session.csrf).send(withTestContribution({requestId:randomUUID(),parts:[body('关联正文')]}));
  expect(sent.status,sent.text).toBe(201);
  const reply = sent.body.message as Message;
  const before = await page(reader,{focusId:focus!.id,extraIds:[reply!.id]});
  expect(before.messages.find(row=>row.id===reply!.id)?.content).toBe('关联正文');
  await app.store.transaction(async()=>{
    await app.store.db.prepare(`UPDATE moderation_cases SET status='rejected' WHERE "messageId"=$1`).run(reply.id);
  });
  const after = await page(reader,{focusId:focus!.id,extraIds:[reply!.id]});
  expect(JSON.stringify(after)).not.toContain('关联正文');
  expect((await reader.agent.post('/api/ui/snapshot/discussion').send({focusId:reply!.id})).status).toBe(403);
});
