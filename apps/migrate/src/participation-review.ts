import { DEFAULT_MODERATION_POLICY, reviewEconomy } from '@gonglun/core';
import { Mutation, now, type Store } from '../../server/src/db.js';
import { reviewFinanceSchema } from '../../server/src/moderation-schema.js';
import type { ModerationCase } from '../../server/src/moderation.js';
import { reconcileOrganizationEffects } from '../../server/src/organizations.js';

/** Preserve all money. Old escrows keep their funded budget; future rounds use the new prices. */
export async function migrateParticipationReview(store:Store){
  if((await store.db.prepare("SELECT value FROM settings WHERE key='participation-review-version'").get())?.value==='1')return;
  await store.db.exec(reviewFinanceSchema);
  // Pre-presence draws sent every old task to the same offline users. Retain those records and start
  // a fresh random round only where nobody has ever submitted a vote; no paid position is discarded.
  await store.db.exec(`UPDATE moderation_cases c SET round=round+1,stage=0,"assignmentCheckAt"=0
    WHERE c.status='pending' AND c.settlement IS NULL
    AND NOT EXISTS(SELECT 1 FROM moderation_votes v WHERE v."caseId"=c.id)
    AND EXISTS(SELECT 1 FROM moderation_assignments a WHERE a."caseId"=c.id)`);
  const cases=await store.db.prepare('SELECT * FROM moderation_cases ORDER BY position').all<ModerationCase>();
  const tx=new Mutation(store);
  for(const c of cases){
    const policy={...DEFAULT_MODERATION_POLICY,...c.policy},economy=reviewEconomy(policy);
    await store.db.prepare('UPDATE moderation_cases SET policy=$2::jsonb,"assignmentCheckAt"=0 WHERE id=$1').run(c.id,JSON.stringify(policy));
    const existing=await store.db.prepare('SELECT round FROM moderation_round_fees WHERE "caseId"=$1').all<{round:number}>(c.id);
    if(!existing.length)await store.db.prepare(`INSERT INTO moderation_round_fees("caseId",round,"payerId",amount,"rewardSlots","rewardAmount",paid) VALUES($1,$2,$3,$4,$5,$6,$7)`)
      .run(c.id,c.round,c.authorId,c.fee,economy.rewardSlots,economy.rewardAmount,!!c.settlement?.finalized);
    else if(existing.length===1&&existing[0]!.round!==c.round)await store.db.prepare('UPDATE moderation_round_fees SET round=$2 WHERE "caseId"=$1 AND NOT paid').run(c.id,c.round);
    await store.db.prepare(`INSERT INTO moderation_deposits("caseId",round,"payerId",amount,"messageId")
      SELECT $1,1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM moderation_deposits WHERE "caseId"=$1)`)
      .run(c.id,c.authorId,c.deposit,c.messageId);
    tx.affected.add(c.messageId);
  }
  const rules=await store.rules(),policy={...DEFAULT_MODERATION_POLICY,...rules.moderation};
  if(policy.fee===3)policy.fee=DEFAULT_MODERATION_POLICY.fee;
  // Legacy import prepares an empty target by running all migrations. Keep its journal empty.
  if(!await store.latestSequence()){
    const next={...rules,moderation:policy};
    await store.set('rules',next);
    await store.db.prepare('UPDATE rule_versions SET body=$2 WHERE version=$1').run(next.version,JSON.stringify(next));
    await store.set('participation-review-version',1);return;
  }
  const next={...rules,version:rules.version+1,moderation:policy};
  await store.set('rules',next);
  await store.db.prepare('INSERT INTO rule_versions(version,body,"authorizationId","createdAt") VALUES($1,$2,NULL,$3)').run(next.version,JSON.stringify(next),now());
  await reconcileOrganizationEffects(tx);await tx.commit();
  await store.set('participation-review-version',1);
}
