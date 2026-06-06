-- Migration: extensible_relation_types
-- Changes RelationType from a restricted PostgreSQL enum to a plain TEXT column.
-- This allows new relation types to be added in the future without database migrations.
--
-- Supported relation types (enforced at application layer, not DB layer):
--   ANNOTATION, REFERENCE, REPLY, AGREE, DISAGREE, SUPPORT, REBUT,
--   CORRECT, ARRANGE, CLASSIFY, MERGE, SUMMARY, RECOMMEND, ARCHIVE
--
-- Also updates the targetRefs JSON column: the new format uses a discriminated union:
--   { "kind": "message",      "messageId": "...", ... }
--   { "kind": "text-fragment","messageId": "...", "text": "...", "hash": "...", ... }
--   { "kind": "relation",     "relationId": "...", "part": "label"|"decoration"|"frame"|"whole" }
--
-- NOTE: Old data is NOT migrated (per product requirement). Start with a clean database.

-- Step 1: Convert relationType column from enum to plain TEXT
ALTER TABLE "Relation" ALTER COLUMN "relationType" TYPE TEXT USING "relationType"::TEXT;

-- Step 2: Drop the old enum type
DROP TYPE IF EXISTS "RelationType";
