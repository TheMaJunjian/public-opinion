import type { Store } from './db.js';
export const reviewFinanceSchema = `
CREATE TABLE IF NOT EXISTS moderation_round_fees(
  "caseId" TEXT NOT NULL,round INTEGER NOT NULL,"payerId" TEXT NOT NULL,amount BIGINT NOT NULL,
  "rewardSlots" INTEGER NOT NULL,"rewardAmount" BIGINT NOT NULL,paid BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY("caseId",round)
);
CREATE TABLE IF NOT EXISTS moderation_deposits(
  "caseId" TEXT NOT NULL,round INTEGER NOT NULL,"payerId" TEXT NOT NULL,amount BIGINT NOT NULL,"messageId" TEXT NOT NULL,
  verdict TEXT NOT NULL DEFAULT 'pass' CHECK(verdict IN ('pass','reject')),
  PRIMARY KEY("caseId",round)
);
`;
export const reviewAssignmentSchema = `
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
export async function hasModerationTables(store:Store){
  // Do not cache transactional DDL: a failed migration can roll these tables back.
  return !!(await store.db.prepare("SELECT to_regclass('moderation_cases') AS present").get())?.present;
}
export const moderationSchema = `
CREATE TABLE IF NOT EXISTS moderation_cases(
  id TEXT PRIMARY KEY,"messageId" TEXT NOT NULL,revision INTEGER NOT NULL,"authorId" TEXT NOT NULL,
  snapshot JSONB NOT NULL,"ruleVersion" INTEGER NOT NULL,policy JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',fee BIGINT NOT NULL,deposit BIGINT NOT NULL,
  "releaseAt" TEXT,settlement JSONB,"createdAt" TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,stage INTEGER NOT NULL DEFAULT 0,"assignmentCheckAt" BIGINT NOT NULL DEFAULT 0,
  position BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,UNIQUE("messageId",revision)
);
CREATE INDEX IF NOT EXISTS moderation_message ON moderation_cases("messageId",revision DESC);
CREATE TABLE IF NOT EXISTS moderation_votes(
  "messageId" TEXT PRIMARY KEY,"caseId" TEXT NOT NULL,"userId" TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('pass','reject')),amount BIGINT NOT NULL CHECK(amount>0),
  "createdAt" TEXT NOT NULL,round INTEGER NOT NULL DEFAULT 1,position BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX IF NOT EXISTS moderation_votes_case ON moderation_votes("caseId",position);
CREATE TABLE IF NOT EXISTS moderation_reviewers(
  "userId" TEXT PRIMARY KEY,"authorizationId" TEXT NOT NULL,"createdAt" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS moderation_dependencies("sourceId" TEXT NOT NULL,"sourceRevision" INTEGER NOT NULL,"targetId" TEXT NOT NULL,"targetRevision" INTEGER NOT NULL DEFAULT 0,PRIMARY KEY("sourceId","sourceRevision","targetId","targetRevision"));
CREATE INDEX IF NOT EXISTS moderation_dependency_target ON moderation_dependencies("targetId");
` + reviewAssignmentSchema + reviewFinanceSchema;
