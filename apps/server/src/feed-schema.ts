/** Derived previews and private discovery preferences are separate from the public journal. */
export const feedSchema = `
CREATE TABLE IF NOT EXISTS feed_entries (
  id TEXT PRIMARY KEY, "authorId" TEXT NOT NULL, revision INTEGER NOT NULL,
  sequence BIGINT NOT NULL, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL,
  kind TEXT NOT NULL, excerpt TEXT NOT NULL, "contextId" TEXT
);
CREATE INDEX IF NOT EXISTS feed_sequence ON feed_entries(sequence DESC,id DESC);
CREATE INDEX IF NOT EXISTS feed_author ON feed_entries("authorId",sequence DESC,id DESC);
CREATE INDEX IF NOT EXISTS feed_context ON feed_entries("contextId",sequence DESC,id DESC);
CREATE TABLE IF NOT EXISTS feed_corrections (
  "sourceId" TEXT NOT NULL, "targetId" TEXT NOT NULL, PRIMARY KEY("sourceId","targetId")
);
CREATE INDEX IF NOT EXISTS feed_correction_target ON feed_corrections("targetId");
CREATE TABLE IF NOT EXISTS feed_hidden (
  "userId" TEXT NOT NULL, "messageId" TEXT NOT NULL, PRIMARY KEY("userId","messageId")
);
`;
