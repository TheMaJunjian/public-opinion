import { Mutation, type Store } from '../../server/src/db.js';
import type { ModerationCase } from '../../server/src/moderation.js';
import { reconcileOrganizationEffects } from '../../server/src/organizations.js';

/** Reopen provisional head-count conclusions without moving any money or revisiting paid results. */
export async function migrateStakeWeightedReview(store:Store):Promise<void>{
  const cases=await store.db.prepare(`SELECT * FROM moderation_cases
    WHERE settlement->>'finalized'='false' OR ((settlement IS NULL OR settlement='null'::jsonb) AND stage<>0) ORDER BY position`).all<ModerationCase>();
  for(let start=0;start<cases.length;start+=100){
    const tx=new Mutation(store);
    for(const review of cases.slice(start,start+100)){
      const status=review.status==='rejected'?'appeal':review.status==='appeal'?'appeal':'pending';
      await store.db.prepare(`UPDATE moderation_cases SET status=$2,settlement=NULL,"releaseAt"=NULL,stage=0,"assignmentCheckAt"=0 WHERE id=$1`).run(review.id,status);
      if(review.settlement)await tx.create('system',[
        {id:'body',type:'text',text:'审核改按双方累计押注点数结算；尚未划转资金的原结论重新待结算，已投入押注与自押保留。'},
        {id:'record',type:'relation',relation:'review-record',roles:{target:[{id:'target',reference:{messageId:review.messageId,revision:review.revision}}]}},
        {id:'data',type:'data',value:{migration:'stake-weighted-review-arbitration',caseId:review.id,reviewRound:review.round,status}},
      ]);
      tx.affected.add(review.messageId);
    }
    await reconcileOrganizationEffects(tx);await tx.commit();
  }
}
