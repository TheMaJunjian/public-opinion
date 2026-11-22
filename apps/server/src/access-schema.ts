/** Private access records never enter public messages, snapshots or exports. */
export const agreementSchema = `
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS "agreementVersion" TEXT;
CREATE TABLE IF NOT EXISTS participation_acceptances(
  "userId" TEXT NOT NULL REFERENCES users(id),version TEXT NOT NULL,
  "acceptedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId",version)
);`;
export const accessSchema = `
CREATE INDEX IF NOT EXISTS sessions_user ON sessions("userId");
CREATE TABLE IF NOT EXISTS registration_invites(
  id TEXT PRIMARY KEY,"tokenHash" TEXT UNIQUE NOT NULL,hint TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,"createdAt" TEXT NOT NULL,"expiresAt" TEXT NOT NULL,
  "usedBy" TEXT,"usedAt" TEXT,"revokedAt" TEXT,
  position BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE TABLE IF NOT EXISTS disabled_accounts(
  "userId" TEXT PRIMARY KEY,"disabledAt" TEXT NOT NULL,"disabledBy" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_admin_actions(
  id TEXT PRIMARY KEY,"actorId" TEXT NOT NULL,action TEXT NOT NULL,
  "targetId" TEXT NOT NULL,"createdAt" TEXT NOT NULL
);
`;
