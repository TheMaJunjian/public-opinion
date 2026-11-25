import { replayArchive, reviewContextPart, type Part } from '@gonglun/core';
import { afterEach, expect, it } from 'vitest';
import { Mutation } from '../../server/src/db.js';
import { inaccessibleMessages, indexModerationDependencies } from '../../server/src/moderation-visibility.js';
import { cleanupTestDatabases, createTestApp, newTestSchema, testDatabaseUrl } from '../../server/src/test-database.js';
import { financialFingerprint } from './financial-fingerprint.js';
import { outstandingMinimumContributions } from './backfill-minimum-contributions.js';
import { openMigratingStore } from './migrations.js';
import { migrationPlan } from './preflight.js';
import { migrateReviewReasons, verifyReviewReasons } from './review-reasons.js';

afterEach(cleanupTestDatabases);

it('previews no review reasons in an empty schema',async()=>{
  expect((await migrationPlan(testDatabaseUrl(),newTestSchema())).reviewReasons).toEqual({messages:0,versions:0});
});

it('migrates a historical reason citing a review assignment removed by the preceding upgrade',async()=>{
  const {store}=await createTestApp(),db=store.db;
  const context={messageId:'original',revision:1};
  const quotedAssignment={messageId:'assignment',revision:1,partId:'body'};
  await store.transaction(async()=>{
    await db.exec('DROP TABLE legacy_review_reason_versions; DELETE FROM schema_migrations WHERE version>=50');
    const tx=new Mutation(store);
    const original=await tx.create('writer',[{id:'body',type:'text',text:'原文'}],undefined,context.messageId);
    await tx.create('system',[
      {id:'body',type:'text',text:'已分配审核任务'},
      {id:'action',type:'relation',relation:'review-record',roles:{target:[{id:'target',reference:context}]}},
      {id:'data',type:'data',value:{assigned:['participant']}},
    ],undefined,quotedAssignment.messageId);
    const vote=await tx.create('participant',[
      {id:'body',type:'text',text:'审核理由'},
      {id:'action',type:'relation',relation:'review',roles:{
        target:[{id:'target',reference:context}],source:[{id:'quote',reference:quotedAssignment}],
      }},
    ],undefined,'vote');
    await db.prepare(`INSERT INTO moderation_cases(id,"messageId",revision,"authorId",snapshot,"ruleVersion",policy,fee,deposit,"createdAt")
      VALUES('original-case','original',1,'writer',$1,1,$2,0,0,$3)`).run(JSON.stringify(original),JSON.stringify((await store.rules()).moderation),original.createdAt);
    await db.prepare(`INSERT INTO moderation_votes("messageId","caseId","userId",verdict,amount,"createdAt")
      VALUES('vote','original-case','participant','pass',2,$1)`).run(vote.createdAt);
    await tx.commit();
  });

  const upgraded=await openMigratingStore(testDatabaseUrl(),{schema:db.schema});
  try {
    await verifyReviewReasons(db);
    await expect(store.message(quotedAssignment.messageId)).rejects.toMatchObject({status:404});
    const mapping=await db.prepare('SELECT "reasonId","citationId" FROM legacy_review_reason_versions').get<{reasonId:string;citationId:string|null}>();
    expect(mapping?.citationId).toBeNull();
    expect((await store.message(mapping!.reasonId)).parts).toEqual(expect.arrayContaining([
      {id:'body',type:'text',text:'审核理由'},
      expect.objectContaining({relation:'reference',roles:{source:[{id:'quote',reference:quotedAssignment}]}}),
    ]));
  } finally {await upgraded.close();}
});

it('separates versions of historical reasons without editing decisions or moving money, and guards old fragment references',async()=>{
  const {store}=await createTestApp({moderation:true}),db=store.db;
  const context={messageId:'original',revision:1};
  const action=(relation:string):Extract<Part,{type:'relation'}>=>({id:'action',type:'relation',relation,roles:{target:[{id:'t',reference:context}]}});
  const legacyText=(text:string):Part=>({id:'body',type:'text',text});
  await store.transaction(async()=>{
    await db.exec('DROP TABLE legacy_review_reason_versions; DELETE FROM schema_migrations WHERE version=51');
    const tx=new Mutation(store);
    const original=await tx.create('writer',[legacyText('原文')],{protocol:1,recommendation:1,wager:0},context.messageId);
    await db.prepare(`INSERT INTO moderation_cases(id,"messageId",revision,"authorId",snapshot,"ruleVersion",policy,fee,deposit,"createdAt")
      VALUES('original-case','original',1,'writer',$1,1,$2,6,10,$3)`).run(JSON.stringify(original),JSON.stringify((await store.rules()).moderation),original.createdAt);
    const vote=await tx.create('participant',[legacyText('第一版理由'),action('review'),{id:'data',type:'data',value:{content:'第一版理由'}}],{protocol:0,wager:0,recommendation:0,reviewWager:2},'vote');
    await db.prepare(`INSERT INTO moderation_votes("messageId","caseId","userId",verdict,amount,"createdAt") VALUES('vote','original-case','participant','reject',2,$1)`).run(vote.createdAt);
    await db.exec("INSERT INTO accounts VALUES('participant',0,0,0,0)");
    await store.ledger('participant',vote.id,10,0,'原有贡献点');
    await store.ledger('participant',vote.id,-2,2,'审核押注冻结');
    await store.set('minted',10);
    await tx.create('participant',[action('review')],{protocol:0,wager:0,recommendation:0,reviewWager:2},'silent');
    const appeal=action('review-appeal');
    appeal.roles.source=[{id:'quote',reference:{...context,partId:'body',range:{start:0,end:1}}}];
    await tx.create('writer',[{id:'data',type:'data',value:{caseId:'original-case',content:'我认为“原”证据不足',label:'原'}},appeal],undefined,'appeal');
    await tx.create('writer',[legacyText('原'),appeal,{id:'data',type:'data',value:{label:'原'}}],undefined,'z-quote-only');
    await tx.create('editor',[{id:'correction',type:'relation',relation:'correct',roles:{target:[{id:'t',reference:{messageId:'vote',revision:1,partId:'body',range:{start:0,end:2}}}]}}],undefined,'correction');
    await tx.create('another',[legacyText('单独的讨论'),reviewContextPart(context)],undefined,'discussion');
    await tx.commit();
    const second=new Mutation(store);
    await second.put({...vote,revision:2,parts:[legacyText('第二版理由'),action('review')]});
    await second.commit();
    // The v50 dependency index still coupled every scoped discussion to its target.
    await db.exec(`INSERT INTO moderation_dependencies VALUES('discussion',1,'original',1) ON CONFLICT DO NOTHING`);
  });
  const before=await financialFingerprint(db),seq=await store.latestSequence();
  const priorDecisions=await db.prepare('SELECT * FROM revisions ORDER BY "messageId",revision').all();
  const inbox=await db.prepare('SELECT * FROM notifications ORDER BY id').all();
  const originalVotes=await db.prepare('SELECT * FROM moderation_votes ORDER BY position').all();
  const plan=await migrationPlan(testDatabaseUrl(),db.schema);
  expect(plan.reviewReasons).toEqual({messages:3,versions:4});
  const upgraded=await openMigratingStore(testDatabaseUrl(),{schema:db.schema});
  try {
    await verifyReviewReasons(db);
    const mappings=await db.prepare('SELECT * FROM legacy_review_reason_versions ORDER BY "decisionId","decisionRevision"').all();
    expect(mappings).toHaveLength(4);
    const [appeal,first,second,quoteOnly]=mappings;
    expect(quoteOnly).toMatchObject({decisionId:'z-quote-only',citationId:null});
    expect(first).toMatchObject({decisionId:'vote',decisionRevision:1,reasonRevision:1});
    expect(second).toMatchObject({decisionId:'vote',decisionRevision:2,reasonId:first!.reasonId,reasonRevision:2});
    expect(appeal).toMatchObject({decisionId:'appeal',decisionRevision:1,reasonRevision:1});
    const reasonId=String(first!.reasonId),appealReason=String(appeal!.reasonId),citationId=String(appeal!.citationId);
    const reason=await store.message(reasonId,1);
    expect(reason.parts).toMatchObject([legacyText('第一版理由'),reviewContextPart(context),
      {relation:'review-reason',roles:{target:[{reference:{messageId:'vote',revision:1}}]}}]);
    expect((await store.message(reasonId)).parts[0]).toEqual(legacyText('第二版理由'));
    expect((await store.message(appealReason)).parts[0]).toEqual(legacyText('我认为“…”证据不足'));
    expect((await store.message(citationId)).parts).toEqual(expect.arrayContaining([
      expect.objectContaining({type:'text',text:'原'}),expect.objectContaining({type:'relation',relation:'reference'})]));
    const quoteOnlyReason=String(quoteOnly!.reasonId);
    expect((await db.prepare('SELECT * FROM revisions WHERE "messageId"<>ALL($1::text[]) ORDER BY "messageId",revision').all([reasonId,appealReason,citationId,quoteOnlyReason]))).toEqual(priorDecisions);
    expect(await db.prepare('SELECT * FROM notifications ORDER BY id').all()).toEqual(inbox);
    expect(await db.prepare('SELECT * FROM moderation_votes ORDER BY position').all()).toEqual(originalVotes);
    expect(await financialFingerprint(db)).toBe(before);
    expect(await outstandingMinimumContributions(db)).toBe(0);
    const changes=await db.prepare('SELECT body FROM changes ORDER BY sequence').all<{body:string}>();
    const replay=replayArchive({format:'gonglun-2',changes:changes.map(c=>JSON.parse(c.body))});
    expect(replay.revisions.get(reasonId)).toHaveLength(2);
    expect(replay.messages.find(m=>m.id===reasonId)).toEqual(await store.message(reasonId));
    expect(replay.accounts.get('participant')).toEqual(await store.account('participant'));
    expect((await migrationPlan(testDatabaseUrl(),db.schema)).reviewReasons).toEqual({messages:0,versions:0});
    await upgraded.transaction(()=>migrateReviewReasons(upgraded));
    expect(await store.latestSequence()).toBe(seq+5);
    await db.exec("UPDATE moderation_cases SET status='rejected' WHERE id='original-case'");
    const hidden=(...ids:string[])=>inaccessibleMessages(store,ids,'observer');
    expect(await hidden(reasonId,appealReason,citationId,quoteOnlyReason,'discussion','original','correction')).toEqual(new Set([citationId,quoteOnlyReason,'original']));
    await db.exec("UPDATE moderation_cases SET status='approved' WHERE id='original-case'");
    await db.prepare(`UPDATE moderation_cases SET status='rejected' WHERE "messageId"=$1 AND revision=1`).run(reasonId);
    await indexModerationDependencies(store,await store.message('vote',1));
    expect(await hidden('correction',appealReason,'original')).toEqual(new Set(['correction']));
    await db.prepare(`UPDATE moderation_cases SET status='rejected' WHERE "messageId"=$1`).run(citationId);
    expect(await hidden('appeal',citationId,appealReason,'original')).toEqual(new Set(['appeal',citationId]));
    await verifyReviewReasons(db);
  } finally {await upgraded.close();}
});
