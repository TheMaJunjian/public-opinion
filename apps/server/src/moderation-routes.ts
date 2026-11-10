import { Router } from 'express';
import { z } from 'zod';
import { reviewEconomy, type ReviewEligibility } from '@gonglun/core';
import { currentSession, requireCsrf, requireSession, updateSessionActivity } from './auth.js';
import { DomainError, type Store } from './db.js';
import { isReviewer, moderationCase, moderationPolicy, reviewVotes, summarizeReview, type ModerationCase } from './moderation.js';
import { viewsFor } from './ui-projections.js';
import { inaccessibleReferences } from './moderation-visibility.js';
import { reviewDeposits, reviewStakes } from './review-finances.js';
import { reviewDiscussionRecords } from './review-discussion.js';
import { assignmentCounts, assignmentValidSql, processReviewAssignments, reviewAssignment, reviewWindowOpen, openReviewCaseSql, REVIEW_ONLINE_WINDOW_MS } from './review-assignments.js';

export function createModerationRouter(store:Store){
  const router=Router();
  router.post('/presence',(req,res,next)=>{void updateSessionActivity(store,req).then(()=>res.json({ok:true})).catch(next);});
  router.put('/availability',(req,res,next)=>{void (async()=>{
    const session=await requireCsrf(store,req),{enabled}=z.object({enabled:z.boolean()}).strict().parse(req.body);
    await store.transaction(async()=>{
      await store.db.prepare(`INSERT INTO moderation_candidate_preferences VALUES($1,$2,$3) ON CONFLICT("userId") DO UPDATE SET enabled=$2,"updatedAt"=$3`).run(session.user.id,enabled,new Date().toISOString());
      await store.db.prepare(`UPDATE moderation_cases SET "assignmentCheckAt"=0 WHERE ${openReviewCaseSql('$1')}`).run(new Date().toISOString());
    });
    await processReviewAssignments(store);res.json({enabled});
  })().catch(next);});
  router.get('/queue',(req,res,next)=>{void store.read(async()=>{
    const session=await requireSession(store,req);
    const enabled=(await store.db.prepare('SELECT enabled FROM moderation_candidate_preferences WHERE "userId"=$1').get<{enabled:boolean}>(session.user.id))?.enabled??true;
    const before=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(Number.MAX_SAFE_INTEGER).parse(req.query.before);
    const rows=await store.db.prepare(`SELECT c.* FROM moderation_cases c WHERE c.position<$1 AND (c."authorId"=$2
      OR EXISTS(SELECT 1 FROM moderation_assignments a WHERE a."caseId"=c.id AND a.round=c.round AND a."userId"=$2 AND ${assignmentValidSql('a','$3')})
      OR EXISTS(SELECT 1 FROM moderation_votes v WHERE v."caseId"=c.id AND v.round=c.round AND v."userId"=$2))
      AND (c.status NOT IN ('approved','unknown') OR c.settlement->>'finalized'='false') ORDER BY c.position DESC LIMIT 31`).all<ModerationCase>(before,session.user.id,new Date().toISOString());
    const items=await Promise.all(rows.slice(0,30).map(async c=>({...summarizeReview(c,await reviewVotes(store,c.id),await reviewDeposits(store,c.id)),...await assignmentCounts(store,c),author:await store.user(c.authorId)})));
    const policy=await moderationPolicy(store),minimumRequired=session.rules.protocolFee+reviewEconomy(policy).minWager;
    const online=!!await store.db.prepare('SELECT 1 FROM sessions WHERE "userId"=$1 AND expires>$2 AND "lastActiveAt">$3 LIMIT 1').get(session.user.id,Date.now(),Date.now()-REVIEW_ONLINE_WINDOW_MS);
    res.json({items,nextCursor:rows.length>30?String(rows[29]!.position):null,enabled,policy,eligibility:{online,available:session.account.available,minimumRequired}});
  }).catch(next);});
  router.get('/reviewers',(req,res,next)=>{void store.read(async()=>{
    await requireSession(store,req);
    res.json({items:[],mode:'random-per-message'});
  }).catch(next);});
  router.get('/messages/:id',(req,res,next)=>{void store.read(async()=>{
    const messageId=z.string().min(1).max(100).parse(req.params.id),revision=z.coerce.number().int().positive().max(2147483647).optional().parse(req.query.revision),session=await currentSession(store,req),c=await moderationCase(store,messageId,revision);
    if(!c)throw new DomainError('该消息没有审核记录',404);
    const reviewer=await isReviewer(store,session?.user.id,c),owner=session?.user.id===c.authorId;
    const readable=!(await inaccessibleReferences(store,[{id:messageId,revision:c.revision}],session?.user.id)).size;
    const records=await reviewDiscussionRecords(store,c);
    const summary={...summarizeReview(c,await reviewVotes(store,c.id),await reviewDeposits(store,c.id),session?.user.id),...await assignmentCounts(store,c)};
    const assignment=await reviewAssignment(store,c,session?.user.id);
    const reviewEligibility:ReviewEligibility=!session?'login-required':!readable?'content-restricted':!reviewWindowOpen(c)?'closed':'eligible';
    const readableWithoutAssignment=readable&&!(await inaccessibleReferences(store,[{id:messageId,revision:c.revision}],session?.user.id,true)).size;
    const economy=reviewEconomy(c.policy),protocol=(await store.rules()).protocolFee;
    const feePaid=!!(await store.db.prepare('SELECT paid FROM moderation_round_fees WHERE "caseId"=$1 AND round=$2').get<{paid:boolean}>(c.id,c.round))?.paid;
    res.json({summary,snapshot:readable?c.snapshot:undefined,target:(await viewsFor(store,[c.snapshot]))[0],records:await viewsFor(store,records),
      stakes:readable?await reviewStakes(store,c):[],
      assignment:assignment?{expiresAt:assignment.expiresAt,submittedAt:assignment.submittedAt,revokedAt:assignment.revokedAt}:null,
      restricted:['rejected','appeal'].includes(c.status)||!readableWithoutAssignment,readableWithoutAssignment,feePaid,available:session?.account.available,
      costs:{protocol,reviewMinimum:economy.minWager,appealFee:economy.appealFee,appealDeposit:economy.appealDeposit,appealTotal:protocol+economy.appealFee+economy.appealDeposit},
      canReview:reviewEligibility==='eligible',reviewEligibility,
      appealVerdict:c.status==='approved'?'reject':c.status==='rejected'?'pass':undefined,
      canSettle:readable&&(reviewer||owner)&&!summary.finalized&&(summary.pass+summary.reject>0),
      canAppeal:['approved','rejected','unknown'].includes(c.status)&&(owner||!!session&&c.status!=='rejected'),policy:c.policy});
  }).catch(next);});
  return router;
}
