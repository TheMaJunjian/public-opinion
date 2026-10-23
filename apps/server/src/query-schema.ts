/** Current query records. Importers populate checkpoints once; runtime reads a single current format. */
export const querySchema = `
CREATE TABLE IF NOT EXISTS account_baselines("userId" TEXT PRIMARY KEY,earned BIGINT NOT NULL,lost BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS stake_positions(id TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"subjectId" TEXT NOT NULL,"roundId" TEXT,
  "settlementType" TEXT NOT NULL,side TEXT NOT NULL,amount BIGINT NOT NULL,"createdAt" TEXT NOT NULL,reference JSONB);
CREATE INDEX IF NOT EXISTS stake_positions_subject ON stake_positions("subjectId","createdAt",id);
CREATE TABLE IF NOT EXISTS pool_checkpoints("messageId" TEXT NOT NULL,"settlementType" TEXT NOT NULL,"lockedPro" BIGINT NOT NULL,"lockedCon" BIGINT NOT NULL,PRIMARY KEY("messageId","settlementType"));
CREATE TABLE IF NOT EXISTS message_state_checkpoints("messageId" TEXT PRIMARY KEY,body JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS settlement_access("messageId" TEXT PRIMARY KEY,allowed_keys TEXT[] NOT NULL);
CREATE TABLE IF NOT EXISTS published_round_reports(id TEXT PRIMARY KEY,body JSONB NOT NULL);
`;
