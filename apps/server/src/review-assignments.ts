import { DEFAULT_MODERATION_POLICY, reviewAssignmentSize, reviewEconomy } from '@gonglun/core';
import { Mutation, now, type Store } from './db.js';
import type { ModerationCase } from './moderation.js';

export const REVIEW_ONLINE_WINDOW_MS=2*60_000;
export function reviewWindowOpen(c:ModerationCase):boolean{
  return c.settlement ? !c.settlement.finalized&&!!c.releaseAt&&Date.now()<Date.parse(c.releaseAt) : ['pending','appeal'].includes(c.status);
}
export const openReviewCaseSql=(at:string)=>`(status IN ('pending','appeal') OR (settlement->>'finalized'='false' AND "releaseAt">${at}))`;
export interface ReviewAssignment {
  caseId:string;round:number;userId:string;stage:number;assignedAt:string;expiresAt:string;submittedAt:string|null;revokedAt:string|null;
}
export const assignmentValidSql=(alias:string,at:string)=>`${alias}."revokedAt" IS NULL AND (${alias}."submittedAt" IS NOT NULL OR ${alias}."expiresAt">${at})`;
export async function reviewAssignment(store:Store,c:ModerationCase,userId?:string):Promise<ReviewAssignment|undefined>{
  if(!userId)return;
  return store.db.prepare('SELECT * FROM moderation_assignments WHERE "caseId"=$1 AND round=$2 AND "userId"=$3').get<ReviewAssignment>(c.id,c.round,userId);
}
export function assignmentIsValid(assignment:ReviewAssignment|undefined):boolean{
  return !!assignment&&!assignment.revokedAt&&(!!assignment.submittedAt||assignment.expiresAt>now());
}
export async function assignmentCounts(store:Store,c:ModerationCase){
  const rows=await store.db.prepare('SELECT * FROM moderation_assignments WHERE "caseId"=$1 AND round=$2').all<ReviewAssignment>(c.id,c.round);
  return {assignedCount:rows.filter(assignmentIsValid).length,exposedCount:rows.length,
    exposureLimit:reviewAssignmentSize(c.policy)*(c.policy.exposureMultiplier??DEFAULT_MODERATION_POLICY.exposureMultiplier!)};
}
export async function assignmentRecord(tx:Mutation,c:ModerationCase,text:string,data:Record<string,unknown>){
  const record=await tx.create('system',[{id:'body',type:'text',text},
    {id:'record',type:'relation',relation:'review-record',roles:{target:[{id:'target',reference:{messageId:c.messageId,revision:c.revision}}]}},
    {id:'data',type:'data',value:{uiType:'REVIEW_RECORD',caseId:c.id,reviewRound:c.round,reviewStage:c.stage,...data} as import('@gonglun/core').Json}]);
  tx.affected.add(c.messageId);
  return record;
}
/** Call under the store write transaction. Expired users are never drawn twice in one round. */
export async function refreshCaseAssignments(tx:Mutation,c:ModerationCase):Promise<void>{
  if(!reviewWindowOpen(c))return;
  // The first check also invalidates old globally-authorized cached bodies after migration.
  if(c.assignmentCheckAt===0)tx.affected.add(c.messageId);
  const store=tx.store,at=now(),rules=await store.rules();
  const expired=await store.db.prepare(`UPDATE moderation_assignments a SET "revokedAt"=$3
    WHERE a."caseId"=$1 AND a.round=$2 AND a."revokedAt" IS NULL AND a."submittedAt" IS NULL
    AND (a."expiresAt"<=$3 OR EXISTS(SELECT 1 FROM disabled_accounts d WHERE d."userId"=a."userId")
      OR EXISTS(SELECT 1 FROM moderation_candidate_preferences p WHERE p."userId"=a."userId" AND NOT p.enabled)) RETURNING "userId"`)
    .all<{userId:string}>(c.id,c.round,at);
  const counts=await assignmentCounts(store,c),target=reviewAssignmentSize(c.policy);
  const slots=Math.max(0,Math.min(target-counts.assignedCount,counts.exposureLimit-counts.exposedCount));
  const candidates=slots?await store.db.prepare(`SELECT u.id FROM users u JOIN accounts a ON a."userId"=u.id
    LEFT JOIN moderation_candidate_preferences p ON p."userId"=u.id
    WHERE u.id<>$1 AND u.id<>'system' AND COALESCE(p.enabled,TRUE) AND a.available>=$4
    AND NOT EXISTS(SELECT 1 FROM disabled_accounts d WHERE d."userId"=u.id)
    AND EXISTS(SELECT 1 FROM sessions s WHERE s."userId"=u.id AND s.expires>$5 AND s."lastActiveAt">$7)
    AND NOT EXISTS(SELECT 1 FROM moderation_assignments r WHERE r."caseId"=$2 AND r.round=$3 AND r."userId"=u.id)
    ORDER BY random() LIMIT $6`).all<{id:string}>(c.authorId,c.id,c.round,rules.protocolFee+reviewEconomy(c.policy).minWager,Date.now(),slots,Date.now()-REVIEW_ONLINE_WINDOW_MS):[];
  const expiresAt=new Date(Date.now()+(c.policy.assignmentTtlMs??DEFAULT_MODERATION_POLICY.assignmentTtlMs!)).toISOString();
  for(const user of candidates)await store.db.prepare(`INSERT INTO moderation_assignments("caseId",round,"userId",stage,"assignedAt","expiresAt") VALUES($1,$2,$3,$4,$5,$6)`)
    .run(c.id,c.round,user.id,c.stage,at,expiresAt);
  if(expired.length||candidates.length)await assignmentRecord(tx,c,'从当前在线用户中随机分配审核任务；超时未审核的任务和临时阅读权限收回并补位',
    {assigned:candidates.map(user=>user.id),revoked:expired.map(user=>user.userId),expiresAt,stageSize:target,exposureLimit:counts.exposureLimit});
  const deadline=await store.db.prepare(`SELECT MIN("expiresAt") AS deadline FROM moderation_assignments WHERE "caseId"=$1 AND round=$2 AND "revokedAt" IS NULL AND "submittedAt" IS NULL`).get<{deadline:string|null}>(c.id,c.round);
  const next=Math.min(Date.now()+60_000,deadline?.deadline?Date.parse(deadline.deadline):Infinity);
  await store.db.prepare('UPDATE moderation_cases SET "assignmentCheckAt"=$2 WHERE id=$1').run(c.id,next);
}
/** One bounded batch per application tick; permission reads independently enforce deadlines. */
export async function processReviewAssignments(store:Store):Promise<void>{
  if(!(await store.rules()).moderation?.enabled)return;
  const due=await store.db.prepare(`SELECT id FROM moderation_cases WHERE ${openReviewCaseSql('$2')} AND "assignmentCheckAt"<=$1 LIMIT 1`).get(Date.now(),now());
  if(!due)return;
  await store.transaction(async()=>{
    const rows=await store.db.prepare(`SELECT * FROM moderation_cases WHERE ${openReviewCaseSql('$2')} AND "assignmentCheckAt"<=$1 ORDER BY "assignmentCheckAt",position LIMIT 50`).all<ModerationCase>(Date.now(),now());
    const tx=new Mutation(store);
    for(const c of rows)await refreshCaseAssignments(tx,c);
    if(tx.affected.size)await tx.commit();
  });
}
