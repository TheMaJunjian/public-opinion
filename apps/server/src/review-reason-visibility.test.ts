import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { PARTICIPATION_AGREEMENT_VERSION, reviewContextPart, type Part } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases } from './test-database.js';
import { Mutation } from './db.js';
import { migrateReviewReasons } from '../../migrate/src/review-reasons.js';

afterEach(cleanupTestDatabases);

it('shows a migrated reason only on its own card even when the viewer can read the historical vote',async()=>{
  const app=await createTestApp({moderation:true}),client=request.agent(app);
  const registration=await client.post('/api/register').send({name:'voter',password:'password',acceptedAgreementVersion:PARTICIPATION_AGREEMENT_VERSION});
  expect(registration.status).toBe(201);
  const send=(parts:Part[],costs:object)=>client.post('/api/messages').set('x-csrf-token',registration.body.csrf).send({requestId:randomUUID(),parts,...costs});
  const original=await send([{type:'text',id:'body',text:'可公开的原文'}],{recommendation:1});
  expect(original.status).toBe(201);
  const reference={messageId:original.body.message.id,revision:1};
  const result=await send([{type:'relation',id:'decision',relation:'review',roles:{target:[{id:'t',reference}]}},
    {type:'data',id:'fact',value:{verdict:'pass'}}],{reviewWager:2});
  expect(result.status).toBe(201);
  const vote=await app.store.message(result.body.message.id),text='对旧票的独立说明';
  await app.store.transaction(async()=>{
    const tx=new Mutation(app.store);
    await tx.put({...vote,revision:2,parts:[...vote.parts,{type:'text',id:'words',text},{type:'data',id:'old-content',value:{content:text}}]});
    await tx.commit();
    await migrateReviewReasons(app.store);
  });
  const detail=await client.get(`/api/moderation/messages/${reference.messageId}`);
  expect(detail.status,detail.text).toBe(200);
  expect(detail.body.target.restricted).toBeFalsy();
  const fact=detail.body.records.find((record:{id:string})=>record.id===vote.id);
  expect(fact).toMatchObject({revision:2,payload:{verdict:'pass'},spending:{reviewWager:2},targetRefs:[{reference}]});
  expect(JSON.stringify(fact)).not.toContain(text);
  expect(detail.body.records.filter((record:{content:string})=>record.content===text)).toHaveLength(1);
  expect((await app.store.message(vote.id,2)).parts).toContainEqual({type:'text',id:'words',text});
});

it('keeps the reason, original, and decisions independently readable and reviewable',async()=>{
  const app=await createTestApp({moderation:true});
  async function account(name:string){
    const client=request.agent(app);
    const registration=await client.post('/api/register').send({name,password:'password',acceptedAgreementVersion:PARTICIPATION_AGREEMENT_VERSION});
    expect(registration.status).toBe(201);
    return {
      send:(parts:Part[],costs:object)=>client.post('/api/messages').set('x-csrf-token',registration.body.csrf).send({requestId:randomUUID(),parts,...costs}),
      detail:(id:string)=>client.get(`/api/moderation/messages/${id}`),
    };
  }
  const author=await account('author'), voter=await account('voter'), reader=await account('reader');
  const body=(text:string):Part=>({id:'body',type:'text',text});
  const action=(name:string,id:string):Part=>({id:'action',type:'relation',relation:name,roles:{target:[{id:'target',reference:{messageId:id,revision:1}}]}});
  const verdict=(value:string):Part=>({id:'vote',type:'data',value:{verdict:value}});
  const original=await author.send([body('original-private-wording')],{recommendation:1});
  expect(original.status).toBe(201);
  const originalId=original.body.message.id;
  const scope=reviewContextPart({messageId:originalId,revision:1});
  const decision=await voter.send([action('review',originalId),verdict('reject'),body('distinct-reviewer-explanation')],{reviewWager:27});
  expect(decision.status,decision.text).toBe(201);
  const first=await reader.detail(originalId);
  const reason=first.body.records.find((m:any)=>m.content==='distinct-reviewer-explanation');
  expect(reason.id).not.toBe(decision.body.message.id);
  expect(reason.moderation.messageId).toBe(reason.id);
  const root=await request(app).get('/api/messages?limit=100');
  expect(root.body.messages.map((m:any)=>m.id)).not.toContain(reason.id);

  // A citation addresses a real fragment. Membership in this discussion does not.
  const citation=await voter.send([scope,{id:'cite',type:'relation',relation:'reference',roles:{
    source:[{id:'source',reference:{messageId:reason.id}}],
    target:[{id:'excerpt',reference:{messageId:originalId,revision:1,partId:'body',range:{start:0,end:8}}}],
  }}],{recommendation:1});
  expect(citation.status,citation.text).toBe(201);
  const closed=await author.send([action('review-settle',originalId)],{});
  expect(closed.status,closed.text).toBe(201);
  const details=await reader.detail(originalId);
  expect(details.body.target).toMatchObject({restricted:true,restrictedReviewTargets:[{messageId:originalId,revision:1}]});
  expect(details.body.canReview).toBe(false);
  expect(details.body.stakes).toHaveLength(2);
  expect(details.body.stakes).toEqual(expect.arrayContaining([
    expect.objectContaining({sourceMessageId:originalId,revision:1,kind:'self',side:'PRO',amount:10,user:expect.objectContaining({username:'author'})}),
    expect.objectContaining({sourceMessageId:decision.body.message.id,kind:'wager',side:'CON',amount:27,user:expect.objectContaining({username:'voter'})}),
  ]));
  expect(details.body.records.find((m:any)=>m.id===reason.id)).toMatchObject({content:'distinct-reviewer-explanation',moderation:{messageId:reason.id}});
  const citationCard=details.body.records.find((m:any)=>m.id===citation.body.message.id);
  expect(citationCard).toMatchObject({restricted:true,targetRefs:[],restrictedReviewTargets:[{messageId:originalId,revision:1}]});
  expect(details.body.records.find((m:any)=>m.id===decision.body.message.id)).toMatchObject({payload:{verdict:'reject'},spending:{reviewWager:27}});
  expect(details.text).not.toContain('original-private-wording');
  const link=citationCard.restrictedReviewTargets[0];
  const anonymous=await request(app).get(`/api/moderation/messages/${link.messageId}`).query({revision:link.revision});
  expect(anonymous.status,anonymous.text).toBe(200);
  expect(anonymous.body).toMatchObject({target:{restricted:true},canReview:false});
  expect(anonymous.body.snapshot).toBeUndefined();
  expect(anonymous.body.stakes).toEqual(details.body.stakes);
  expect(anonymous.body.records.find((m:any)=>m.id===reason.id)?.content).toBe('distinct-reviewer-explanation');
  expect(anonymous.text).not.toContain('original-private-wording');
  expect((await reader.detail(reason.id)).body.canReview).toBe(true);
  const addition=await reader.send([scope,body('another-independent-comment')],{recommendation:1});
  expect(addition.status,addition.text).toBe(201);
  const classification=await reader.send([scope,{id:'organize',type:'relation',relation:'classify',roles:{}},
    {id:'name',type:'data',value:{title:'讨论分类'}}],{recommendation:1});
  expect(classification.status,classification.text).toBe(201);
  const classificationDetail=await reader.detail(classification.body.message.id);
  expect(classificationDetail.body).toMatchObject({canReview:true,summary:{messageId:classification.body.message.id}});
  const forbidden=await reader.send([scope,action('reference',originalId)],{recommendation:1});
  expect(forbidden.status).toBe(409);
  const atReason=await reader.send([scope,action('review',reason.id),verdict('reject')],{reviewWager:24});
  expect(atReason.status,atReason.text).toBe(201);
  const reasonCase=await reader.detail(reason.id);
  expect(reasonCase.body.records.map((record:{id:string})=>record.id)).toEqual([atReason.body.message.id]);
  const settledReason=await reader.send([action('review-settle',reason.id)],{});
  expect(settledReason.status,settledReason.text).toBe(201);
  const after=await author.detail(originalId);
  expect(after.body.summary).toMatchObject({reject:27,status:'rejected'});
  expect(after.body.records.find((m:any)=>m.id===reason.id)).toMatchObject({restricted:true,moderation:{messageId:reason.id}});
  expect(after.body.records.find((m:any)=>m.id===decision.body.message.id)).toMatchObject({payload:{verdict:'reject'}});
  expect(after.text).not.toContain('distinct-reviewer-explanation');
  expect(after.text).toContain('another-independent-comment');
  expect(after.body.records.map((m:any)=>m.id)).toContain(classification.body.message.id);
  expect(after.body.records.map((m:any)=>m.id)).not.toContain(atReason.body.message.id);
  expect((await voter.detail(reason.id)).body.target.content).toBe('distinct-reviewer-explanation');
});
