import { randomUUID } from 'node:crypto';
import { requiresModeration, type Message } from '@gonglun/core';
import { Mutation, type Store } from '../../server/src/db.js';
import { moderationPolicy, type ModerationCase } from '../../server/src/moderation.js';
import { legacyReviewReasonSchema } from '../../server/src/moderation-schema.js';
import { indexModerationDependencies } from '../../server/src/moderation-visibility.js';
import type { Postgres } from '../../server/src/postgres.js';
import { addReviewFunding } from '../../server/src/review-finances.js';
import { splitReviewReasonParts } from '../../server/src/review-reason-parts.js';

type LegacyDecision = { body:string; targetId:string; targetRevision:number };

/** Both planning and upgrading use the saved case to pin the actual reviewed version. */
function decisionsSql(mapped:boolean,hasDeposits=true) {
  return `FROM revisions r
    CROSS JOIN LATERAL jsonb_array_elements(r.body::jsonb->'parts') action
    JOIN moderation_cases c ON c."messageId"=action#>>'{roles,target,0,reference,messageId}'
      AND c.id=COALESCE(
        (SELECT v."caseId" FROM moderation_votes v WHERE v."messageId"=r."messageId"),
        ${hasDeposits?'(SELECT d."caseId" FROM moderation_deposits d WHERE d."messageId"=r."messageId" AND d.round>1 LIMIT 1),':''}
        (SELECT saved.id FROM jsonb_array_elements(r.body::jsonb->'parts') p JOIN moderation_cases saved
          ON saved.id=p->'value'->>'caseId' AND saved."messageId"=action#>>'{roles,target,0,reference,messageId}'
          WHERE p->>'type'='data' LIMIT 1),
        (SELECT pinned.id FROM moderation_cases pinned WHERE pinned."messageId"=action#>>'{roles,target,0,reference,messageId}'
          AND pinned.revision::text=action#>>'{roles,target,0,reference,revision}'))
    WHERE action->>'type'='relation' AND action->>'relation' IN ('review','review-appeal')
      AND r.body::jsonb->>'authorId'<>'system'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.body::jsonb->'parts') p
        WHERE CASE p->>'type' WHEN 'text' THEN p->>'text' WHEN 'code' THEN p->>'source' WHEN 'web' THEN p->>'excerpt' END ~ '[^[:space:]]'
          OR p->>'type'='data' AND EXISTS(SELECT 1 FROM unnest(ARRAY['content','title','label']) key
            WHERE jsonb_typeof(p->'value'->key)='string' AND p->'value'->>key ~ '[^[:space:]]'))
      ${mapped?'AND NOT EXISTS(SELECT 1 FROM legacy_review_reason_versions done WHERE done."decisionId"=r."messageId" AND done."decisionRevision"=r.revision)':''}`;
}

export async function reviewReasonPlan(db:Postgres,tables?:Set<string>) {
  const present=tables??new Set((await db.prepare('SELECT tablename FROM pg_tables WHERE schemaname=current_schema()').all()).map(r=>String(r.tablename)));
  if(!['revisions','moderation_cases','moderation_votes'].every(t=>present.has(t)))return {messages:0,versions:0};
  return (await db.prepare(`SELECT COUNT(DISTINCT r."messageId")::integer AS messages,COUNT(*)::integer AS versions
    ${decisionsSql(present.has('legacy_review_reason_versions'),present.has('moderation_deposits'))}`).get<{messages:number;versions:number}>())!;
}

async function enrollHistorical(tx:Mutation,message:Message) {
  const store=tx.store,policy=await moderationPolicy(store);
  const c=(await store.db.prepare(`INSERT INTO moderation_cases(id,"messageId",revision,"authorId",snapshot,"ruleVersion",policy,fee,deposit,"createdAt")
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,0,0,$8) RETURNING *`).get<ModerationCase>(
    randomUUID(),message.id,message.revision,message.authorId,JSON.stringify(message),(await store.rules()).version,JSON.stringify(policy),message.updatedAt))!;
  await addReviewFunding(tx,c,message,0,0);
}

async function publishReason(store:Store,row:LegacyDecision) {
  const decision=JSON.parse(row.body) as Message;
  const previous=await store.db.prepare(`SELECT "reasonId","reasonRevision" FROM legacy_review_reason_versions
    WHERE "decisionId"=$1 ORDER BY "decisionRevision" DESC LIMIT 1`).get<{reasonId:string;reasonRevision:number}>(decision.id);
  const reason:Message={
    id:previous?.reasonId??randomUUID(),revision:(previous?.reasonRevision??0)+1,authorId:decision.authorId,
    createdAt:decision.createdAt,updatedAt:decision.updatedAt,regionId:decision.regionId,ledgerId:decision.ledgerId,
    programVersion:decision.programVersion,ruleVersion:decision.ruleVersion,sequence:0,spending:{protocol:0,recommendation:0,wager:0},
    parts:[],
  };
  const tx=new Mutation(store);
  const separated=await splitReviewReasonParts(store,decision,{messageId:row.targetId,revision:row.targetRevision},
    {messageId:reason.id,revision:reason.revision},{keepUnresolvedCitations:true});
  reason.parts=separated.parts;
  await tx.put(reason);
  await enrollHistorical(tx,reason);
  let citationId:string|null=null;
  if(separated.citation){
    const citation={...reason,id:randomUUID(),revision:1,parts:separated.citation};
    citationId=citation.id;
    await tx.put(citation);
    if(requiresModeration(citation))await enrollHistorical(tx,citation);
  }
  await store.db.prepare('INSERT INTO legacy_review_reason_versions("decisionId","decisionRevision","reasonId","reasonRevision","citationId") VALUES($1,$2,$3,$4,$5)')
    .run(decision.id,decision.revision,reason.id,reason.revision,citationId);
  await store.db.prepare('INSERT INTO moderation_dependencies("sourceId","sourceRevision","targetId","targetRevision") VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING')
    .run(decision.id,decision.revision,reason.id,reason.revision);
  if(citationId)await store.db.prepare('INSERT INTO moderation_dependencies("sourceId","sourceRevision","targetId","targetRevision") VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING')
    .run(decision.id,decision.revision,citationId);
  tx.affected.add(decision.id);
  const change=await tx.commit();
  // The new journal entry synchronizes clients. Existing participants already received the historical activity.
  await store.db.prepare('DELETE FROM notifications WHERE "changeSequence"=$1').run(change.sequence);
}

async function reindexDiscussionAndFragments(store:Store) {
  // Only current bodies appear in refs. Old links and pinned correction versions also live in revisions.
  const rows=await store.db.prepare(`SELECT r.body FROM revisions r WHERE EXISTS(
    SELECT 1 FROM jsonb_array_elements(r.body::jsonb->'parts') p JOIN moderation_dependencies d
    ON d."sourceId"=r."messageId" AND d."sourceRevision"=r.revision AND d."targetId"=p#>>'{roles,target,0,reference,messageId}'
    WHERE p->>'type'='relation' AND p->>'relation'='review-context')
    OR EXISTS(SELECT 1 FROM (
      SELECT jsonb_path_query(r.body::jsonb,'$.parts[*].roles.*[*].reference') ref
      UNION ALL SELECT jsonb_path_query(r.body::jsonb,'$.parts[*].target')
    ) refs JOIN legacy_review_reason_versions h ON h."decisionId"=ref->>'messageId'
      JOIN revisions old ON old."messageId"=h."decisionId" AND old.revision=h."decisionRevision"
      WHERE ref ? 'partId' AND (ref->>'revision' IS NULL OR ref->>'revision'=h."decisionRevision"::text)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(old.body::jsonb->'parts') p
          WHERE p->>'id'=ref->>'partId' AND p->>'type' IN ('text','code','web')))`).all<{body:string}>();
  const deps=store.db.prepare(`SELECT "targetId","targetRevision" FROM moderation_dependencies
    WHERE "sourceId"=$1 AND "sourceRevision"=$2 ORDER BY "targetId","targetRevision"`);
  const tx=new Mutation(store);
  for(const row of rows){
    const message=JSON.parse(row.body) as Message;
    const before=await deps.all(message.id,message.revision);
    await indexModerationDependencies(store,message);
    const after=await deps.all(message.id,message.revision);
    if(JSON.stringify(before)!==JSON.stringify(after))tx.affected.add(message.id);
  }
  if(tx.affected.size){
    const change=await tx.commit();
    await store.db.prepare('DELETE FROM notifications WHERE "changeSequence"=$1').run(change.sequence);
  }
}

export async function migrateReviewReasons(store:Store) {
  await store.db.exec(legacyReviewReasonSchema);
  for(;;){
    const rows=await store.db.prepare(`SELECT r.body,c."messageId" AS "targetId",c.revision AS "targetRevision"
      ${decisionsSql(true)} ORDER BY r."messageId",r.revision LIMIT 100`).all<LegacyDecision>();
    if(!rows.length)break;
    for(const row of rows)await publishReason(store,row);
  }
  await reindexDiscussionAndFragments(store);
}

export async function verifyReviewReasons(db:Postgres) {
  const pending=await reviewReasonPlan(db);
  if(pending.versions)throw new Error(`仍有 ${pending.versions} 个历史审核理由版本需要拆分`);
  const invalid=await db.prepare(`SELECT h."decisionId" FROM legacy_review_reason_versions h
    LEFT JOIN revisions decision ON decision."messageId"=h."decisionId" AND decision.revision=h."decisionRevision"
    LEFT JOIN revisions reason ON reason."messageId"=h."reasonId" AND reason.revision=h."reasonRevision"
    LEFT JOIN revisions citation ON citation."messageId"=h."citationId" AND citation.revision=1
    LEFT JOIN moderation_cases c ON c."messageId"=h."reasonId" AND c.revision=h."reasonRevision"
    LEFT JOIN moderation_round_fees f ON f."caseId"=c.id AND f.round=1
    LEFT JOIN moderation_deposits s ON s."caseId"=c.id AND s.round=1
    LEFT JOIN moderation_dependencies d ON (d."sourceId",d."sourceRevision",d."targetId",d."targetRevision")=
      (h."decisionId",h."decisionRevision",h."reasonId",h."reasonRevision")
    LEFT JOIN moderation_dependencies quoted ON (quoted."sourceId",quoted."sourceRevision",quoted."targetId",quoted."targetRevision")=
      (h."decisionId",h."decisionRevision",h."citationId",1)
    WHERE decision.body IS NULL OR reason.body IS NULL OR f.amount IS DISTINCT FROM 0 OR s.amount IS DISTINCT FROM 0
      OR h."citationId" IS NOT NULL AND (citation.body IS NULL OR quoted."sourceId" IS NULL OR NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(citation.body::jsonb->'parts') p WHERE p->>'relation'='reference'
          AND p#>>'{roles,target,0,reference,messageId}'=h."reasonId" AND p#>>'{roles,target,0,reference,revision}'=h."reasonRevision"::text))
      OR d."sourceId" IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reason.body::jsonb->'parts') p
        WHERE p->>'relation'='review-reason' AND p#>>'{roles,target,0,reference,messageId}'=h."decisionId"
          AND p#>>'{roles,target,0,reference,revision}'=h."decisionRevision"::text)
    LIMIT 1`).get();
  if(invalid)throw new Error(`历史审核理由的版本、关联或首次审核资金记录不一致：${invalid.decisionId}`);
}
