import { bindRoles, relations, type ReviewVerdict } from '@gonglun/core';
import { Mutation, type Store } from '../../server/src/db.js';

type LegacyDeposit = {caseId:string;round:number;payerId:string;amount:number;messageId:string;targetId:string;revision:number};

/** Recover an appeal's side from the system conclusion it challenged, never from unvalidated old input. */
async function depositVerdict(store:Store,deposit:LegacyDeposit):Promise<ReviewVerdict> {
  if (deposit.messageId === deposit.targetId) return 'pass';
  const source = await store.message(deposit.messageId);
  if (source.authorId !== deposit.payerId || !relations(source).some(part => part.relation === 'review-appeal'
    && part.roles.target?.some(binding => binding.reference.messageId === deposit.targetId
      && (binding.reference.revision === undefined || binding.reference.revision === deposit.revision))))
    throw new Error(`审核自押迁移无法确认复核来源：${deposit.messageId}`);
  const previous = await store.db.prepare(`SELECT data->'value'->>'verdict' AS verdict
    FROM messages m, jsonb_array_elements(m.body::jsonb->'parts') data
    WHERE m."authorId"='system' AND m.sequence<$1
      AND data->>'type'='data' AND data->'value'->>'caseId'=$2
      AND data->'value'->>'verdict' IN ('pass','reject')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.body::jsonb->'parts') part WHERE part->>'relation'='review-record')
    ORDER BY m.sequence DESC,m.id LIMIT 1`).get<{verdict:ReviewVerdict}>(source.sequence,deposit.caseId);
  if (!previous) throw new Error(`审核自押迁移缺少复核前结论：${deposit.messageId}`);
  return previous.verdict === 'pass' ? 'reject' : 'pass';
}

/** Convert existing principal in place. Completed payouts and every financial entry remain unchanged. */
export async function migrateReviewSelfStakes(store:Store):Promise<number> {
  await store.db.exec('ALTER TABLE moderation_deposits ADD COLUMN IF NOT EXISTS verdict TEXT');
  const deposits = await store.db.prepare(`SELECT d.*,c."messageId" AS "targetId",c.revision
    FROM moderation_deposits d JOIN moderation_cases c ON c.id=d."caseId"
    WHERE d.verdict IS NULL ORDER BY c.position,d.round`).all<LegacyDeposit>();
  for (let start=0;start<deposits.length;start+=100) {
    const tx = new Mutation(store), stakes = [];
    for (const deposit of deposits.slice(start,start+100)) {
      const verdict = await depositVerdict(store,deposit);
      await store.db.prepare('UPDATE moderation_deposits SET verdict=$3 WHERE "caseId"=$1 AND round=$2')
        .run(deposit.caseId,deposit.round,verdict);
      stakes.push({...deposit,verdict});
    }
    const targets = [...new Map(stakes.map(stake => [JSON.stringify([stake.targetId,stake.revision]),{messageId:stake.targetId,revision:stake.revision}])).values()];
    await tx.create('system',[
      {id:'body',type:'text',text:'审核保证金转为对应立场的自押，与审核押注共同结算；不计审核人数，不领取审核参与报酬。原有资金与已完成结算保留。'},
      {id:'record',type:'relation',relation:'review-record',roles:bindRoles({target:targets})},
      {id:'data',type:'data',value:{uiType:'REVIEW_RECORD',migration:'review-self-stakes',stakes}},
    ]);
    await tx.commit();
  }
  await store.db.exec(`ALTER TABLE moderation_deposits ALTER COLUMN verdict SET NOT NULL;
    ALTER TABLE moderation_deposits ALTER COLUMN verdict SET DEFAULT 'pass';
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='moderation_deposits'::regclass AND conname='moderation_deposits_verdict_check') THEN
        ALTER TABLE moderation_deposits ADD CONSTRAINT moderation_deposits_verdict_check CHECK(verdict IN ('pass','reject'));
      END IF;
    END $$`);
  return deposits.length;
}
