export const notificationMembershipSchema = `
CREATE TABLE IF NOT EXISTS notification_membership_states (
  "messageId" TEXT PRIMARY KEY, active BOOLEAN NOT NULL, sequence BIGINT NOT NULL
);
`;

/** Private inbox state never enters the public execution journal. */
export const notificationSchema = `
${notificationMembershipSchema}
CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "userId" TEXT NOT NULL, "eventId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL, "targetId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
  category TEXT NOT NULL, kind TEXT NOT NULL, "groupKey" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL, "changeSequence" BIGINT NOT NULL,
  body JSONB NOT NULL, "seenAt" TEXT, "deletedAt" TEXT,
  UNIQUE ("userId", "eventId")
);
CREATE INDEX IF NOT EXISTS notification_owner ON notifications("userId", id DESC);
CREATE INDEX IF NOT EXISTS notification_unseen ON notifications("userId", id) WHERE "seenAt" IS NULL;
CREATE TABLE IF NOT EXISTS notification_preferences (
  "userId" TEXT NOT NULL, "targetId" TEXT NOT NULL, muted BOOLEAN NOT NULL,
  PRIMARY KEY ("userId", "targetId")
);
`;

export const notificationDeletionSchema = `
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "deletedAt" TEXT;
`;
