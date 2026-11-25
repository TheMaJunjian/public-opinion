import { Router } from 'express';
import { z } from 'zod';
import { reviewDecisionFacts, reviewEconomy, type ReviewEligibility } from '@gonglun/core';
import { currentSession, requireSession } from './auth.js';
import { DomainError, type Store } from './db.js';
import { moderationCase, moderationPolicy, reviewVotes, reviewWindowOpen, summarizeReview, type ModerationCase } from './moderation.js';
import { viewsFor } from './ui-projections.js';
import { inaccessibleReferences, moderationReadSql, sanitizeModeration } from './moderation-visibility.js';
import { reviewDeposits, reviewStakes } from './review-finances.js';
import { reviewDiscussionRecords } from './review-discussion.js';

export function createModerationRouter(store:Store){
  const router=Router();
  router.get('/queue',(req,res,next)=>{void store.read(async()=>{
    const session=await requireSession(store,req);
    const before=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(Number.MAX_SAFE_INTEGER).parse(req.query.before);
    const readableCase=await moderationReadSql(store,'c',session.user.id,'case');
    const rows=await store.db.prepare(`SELECT c.* FROM moderation_cases c WHERE c.position<$1 AND (
      ((c.status IN ('pending','appeal') OR (c.settlement->>'finalized'='false' AND c."releaseAt">$3)) AND ${readableCase}) OR c."authorId"=$2
      OR EXISTS(SELECT 1 FROM moderation_votes v WHERE v."caseId"=c.id AND v.round=c.round AND v."userId"=$2))
      AND (c.status NOT IN ('approved','unknown') OR c.settlement->>'finalized'='false') ORDER BY c.position DESC LIMIT 31`).all<ModerationCase>(before,session.user.id,new Date().toISOString());
    const items=await Promise.all(rows.slice(0,30).map(async c=>({...summarizeReview(c,await reviewVotes(store,c.id),await reviewDeposits(store,c.id)),author:await store.user(c.authorId)})));
    res.json({items,nextCursor:rows.length>30?String(rows[29]!.position):null,policy:await moderationPolicy(store)});
  }).catch(next);});
  router.get('/messages/:id',(req,res,next)=>{void store.read(async()=>{
    const messageId=z.string().min(1).max(100).parse(req.params.id),revision=z.coerce.number().int().positive().max(2147483647).optional().parse(req.query.revision),session=await currentSession(store,req),c=await moderationCase(store,messageId,revision);
    if(!c)throw new DomainError('该消息没有审核记录',404);
    const owner=session?.user.id===c.authorId;
    const readable=!(await inaccessibleReferences(store,[{id:messageId,revision:c.revision}],session?.user.id)).size;
    const scope={messageId:c.messageId,revision:c.revision};
    const records=(await reviewDiscussionRecords(store,c)).map(record=>{
      const decision=reviewDecisionFacts(record,scope);
      return decision?{...record,parts:decision.parts}:record;
    });
    const summary=summarizeReview(c,await reviewVotes(store,c.id),await reviewDeposits(store,c.id),session?.user.id);
    const reviewEligibility:ReviewEligibility=!session?'login-required':!readable?'content-restricted':!reviewWindowOpen(c)?'closed':'eligible';
    const economy=reviewEconomy(c.policy),protocol=(await store.rules()).protocolFee;
    const publication=await moderationPolicy(store);
    const reasonFee=publication.enabled?publication.fee:0,reasonDeposit=publication.enabled?publication.deposit:0;
    const feePaid=!!(await store.db.prepare('SELECT paid FROM moderation_round_fees WHERE "caseId"=$1 AND round=$2').get<{paid:boolean}>(c.id,c.round))?.paid;
    const detail=await sanitizeModeration(store,{summary,snapshot:readable?c.snapshot:undefined,target:(await viewsFor(store,[c.snapshot]))[0],records:await viewsFor(store,records),
      restricted:(await inaccessibleReferences(store,[{id:messageId,revision:c.revision}])).size>0,feePaid,available:session?.account.available,
      costs:{protocol,reviewMinimum:economy.minWager,appealFee:economy.appealFee,appealDeposit:economy.appealDeposit,appealTotal:protocol+economy.appealFee+economy.appealDeposit,
        reasonFee,reasonDeposit,reasonTotal:1+protocol+reasonFee+reasonDeposit},
      canReview:reviewEligibility==='eligible',reviewEligibility,
      appealVerdict:c.status==='approved'?'reject':c.status==='rejected'?'pass':undefined,
      canSettle:!!session&&readable&&!summary.finalized&&(summary.pass+summary.reject>0),
      canAppeal:['approved','rejected','unknown'].includes(c.status)&&(owner||!!session&&c.status!=='rejected'),policy:c.policy},session?.user.id);
    // Funded review entries contain only the actor, position, amount and source address.
    // They remain public when the reviewed body is hidden.
    const stakes=await reviewStakes(store,c);
    res.set('Cache-Control','private, no-store').type('json').send(JSON.stringify({...detail,stakes}));
  }).catch(next);});
  return router;
}
