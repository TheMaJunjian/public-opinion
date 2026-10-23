import type {Store} from '../../server/src/db.js';
/** Raw source archives exist only for explicit import and verification. */
export async function initializeMigrationArchive(store:Store) {
  await store.db.exec(`CREATE TABLE IF NOT EXISTS legacy_stakes(id TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"messageId" TEXT NOT NULL,"roundId" TEXT,"settlementType" TEXT NOT NULL,side TEXT NOT NULL,amount BIGINT NOT NULL CHECK(amount>=0),"createdAt" TEXT NOT NULL,body JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS legacy_stakes_target ON legacy_stakes("messageId","settlementType");
CREATE TABLE IF NOT EXISTS legacy_pools("messageId" TEXT NOT NULL,"settlementType" TEXT NOT NULL,"lockedPro" BIGINT NOT NULL,"lockedCon" BIGINT NOT NULL,body JSONB NOT NULL,PRIMARY KEY("messageId","settlementType"));
CREATE TABLE IF NOT EXISTS legacy_votes(id TEXT PRIMARY KEY,"roundId" TEXT NOT NULL,"userId" TEXT NOT NULL,vote TEXT NOT NULL,amount BIGINT NOT NULL,"createdAt" TEXT NOT NULL,body JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_accounts("userId" TEXT PRIMARY KEY,body JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_users(id TEXT PRIMARY KEY,"createdAt" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_organization_states("messageId" TEXT PRIMARY KEY,body JSONB NOT NULL);
`);
}
