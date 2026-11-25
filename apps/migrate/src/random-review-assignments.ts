import { DEFAULT_MODERATION_POLICY } from '@gonglun/core';
import type { Store } from '../../server/src/db.js';
export const reviewAssignmentSchema = `
ALTER TABLE moderation_cases ADD COLUMN IF NOT EXISTS stage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE moderation_cases ADD COLUMN IF NOT EXISTS "assignmentCheckAt" BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS moderation_candidate_preferences(
  "userId" TEXT PRIMARY KEY,enabled BOOLEAN NOT NULL,"updatedAt" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS moderation_assignments(
  "caseId" TEXT NOT NULL,round INTEGER NOT NULL,"userId" TEXT NOT NULL,stage INTEGER NOT NULL,
  "assignedAt" TEXT NOT NULL,"expiresAt" TEXT NOT NULL,"submittedAt" TEXT,"revokedAt" TEXT,
  PRIMARY KEY("caseId",round,"userId")
);
CREATE INDEX IF NOT EXISTS moderation_assignment_user ON moderation_assignments("userId","caseId",round);
`;

/** Change review admission only; preserve prior escrows, votes, settlements and charges. */
export async function migrateRandomReviewAssignments(store:Store):Promise<void>{
  const previous=await store.db.prepare(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='moderation_cases' AND column_name='round'`).get();
  await store.db.exec(`ALTER TABLE moderation_cases ADD COLUMN IF NOT EXISTS round INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE moderation_votes ADD COLUMN IF NOT EXISTS round INTEGER NOT NULL DEFAULT 1;
    ${reviewAssignmentSchema}`);
  const rules=await store.rules();
  await store.set('rules',{...rules,moderation:{...DEFAULT_MODERATION_POLICY,...rules.moderation}});
  await store.db.prepare('UPDATE moderation_cases SET policy=$1::jsonb||policy').run(JSON.stringify(DEFAULT_MODERATION_POLICY));
  if(!previous)await store.db.exec(`UPDATE moderation_cases c SET round=2 WHERE status IN ('pending','appeal')
    AND EXISTS(SELECT 1 FROM moderation_votes v WHERE v."caseId"=c.id)`);
}
