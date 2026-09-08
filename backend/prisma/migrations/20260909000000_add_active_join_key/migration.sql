-- Enforce one active canonical JOIN per topic, container, and target.
ALTER TABLE "Message" ADD COLUMN "joinKey" TEXT;
CREATE UNIQUE INDEX "Message_active_join_key" ON "Message"("topicId", "joinKey")
WHERE "joinKey" IS NOT NULL AND "supersededBy" IS NULL;
