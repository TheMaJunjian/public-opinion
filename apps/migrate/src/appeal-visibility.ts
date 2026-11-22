import { Mutation, type Store } from '../../server/src/db.js';
import { reconcileOrganizationEffects } from '../../server/src/organizations.js';

/** A tied case can be appealed on either side. Recover the actual previous
 * settlement from its system reversal, never from the appellant's chosen side. */
export async function migrateAppealVisibility(store: Store) {
  await store.db.exec(`ALTER TABLE moderation_cases ADD COLUMN IF NOT EXISTS "appealFrom"
    TEXT CHECK ("appealFrom" IN ('pass','reject','unknown'))`);
  const recovered = await store.db.prepare(`WITH previous AS (
    SELECT c.id, transfer->'value'->>'verdict' AS verdict
    FROM moderation_cases c
    JOIN moderation_deposits d ON d."caseId"=c.id AND d.round=c.round
    JOIN refs link ON link."targetId"=d."messageId"
    JOIN messages reversal ON reversal.id=link."sourceId" AND reversal."authorId"='system'
    CROSS JOIN LATERAL jsonb_array_elements(reversal.body::jsonb->'parts') undo
    JOIN messages payment ON payment.id=undo->'value'->>'previousSettlementId' AND payment."authorId"='system'
    CROSS JOIN LATERAL jsonb_array_elements(payment.body::jsonb->'parts') transfer
    WHERE c.status='appeal' AND c."appealFrom" IS NULL
      AND undo->>'type'='data' AND undo->'value'->>'caseId'=c.id
      AND transfer->>'type'='data' AND transfer->'value'->>'caseId'=c.id
      AND transfer->'value'->>'verdict' IN ('pass','reject','unknown')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(reversal.body::jsonb->'parts') part
        WHERE part->>'relation'='review-record' AND part->'roles'->'trigger' @>
          jsonb_build_array(jsonb_build_object('reference',jsonb_build_object('messageId',d."messageId"))))
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(payment.body::jsonb->'parts') part
        WHERE part->>'relation'='review-record')
      -- A provisional rejection could reopen in the same round without a new
      -- deposit or reversal. The round's opening verdict then no longer applies.
      AND NOT EXISTS (
        SELECT 1 FROM refs target JOIN messages later ON later.id=target."sourceId"
        CROSS JOIN LATERAL jsonb_array_elements(later.body::jsonb->'parts') data
        WHERE target."targetId"=c."messageId" AND later."authorId"='system'
          AND later.sequence>reversal.sequence AND data->>'type'='data'
          AND data->'value'->>'caseId'=c.id AND data->'value'->>'status'='appeal'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(later.body::jsonb->'parts') part
            WHERE part->>'relation'='review-record'))
  ) UPDATE moderation_cases c SET "appealFrom"=p.verdict
    FROM (SELECT id,min(verdict) AS verdict FROM previous GROUP BY id HAVING count(DISTINCT verdict)=1) p
    WHERE c.id=p.id RETURNING c."messageId",c."appealFrom"`).all<{messageId:string;appealFrom:string}>();
  const publicIds = recovered.filter(row => row.appealFrom !== 'reject').map(row => row.messageId);
  if (publicIds.length) {
    const tx = new Mutation(store);
    for (const id of publicIds) tx.affected.add(id);
    await reconcileOrganizationEffects(tx);
    await tx.commit();
  }
}
