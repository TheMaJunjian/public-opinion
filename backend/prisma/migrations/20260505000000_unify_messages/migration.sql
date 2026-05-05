-- Migration: unify_messages
-- Merges the Relation table into Message by adding a MessageKind enum and
-- relation-specific columns to Message.  Relation messages are now first-class
-- messages stored in the same table, making the design consistent with the
-- "relation messages are also messages" principle.
--
-- No historical data compatibility is required; all existing data is dropped
-- via the Relation table removal.

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'RELATION');

-- Make TEXT-kind columns nullable (they remain NOT NULL for TEXT rows in practice,
-- but RELATION rows will have NULL for these fields).
ALTER TABLE "Message" ALTER COLUMN "content" DROP NOT NULL;
ALTER TABLE "Message" ALTER COLUMN "contentType" DROP NOT NULL;

-- Add kind discriminator (default TEXT so existing rows keep their kind)
ALTER TABLE "Message" ADD COLUMN "kind" "MessageKind" NOT NULL DEFAULT 'TEXT';

-- Add RELATION kind fields (all nullable; TEXT rows leave these NULL)
ALTER TABLE "Message" ADD COLUMN "relationType" TEXT;
ALTER TABLE "Message" ADD COLUMN "relSourceId"  TEXT;
ALTER TABLE "Message" ADD COLUMN "targetRefs"   JSONB;

-- Drop the now-superseded Relation table (no data migration needed)
ALTER TABLE "Relation" DROP CONSTRAINT IF EXISTS "Relation_topicId_fkey";
ALTER TABLE "Relation" DROP CONSTRAINT IF EXISTS "Relation_createdById_fkey";
DROP TABLE IF EXISTS "Relation";
