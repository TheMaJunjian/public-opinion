-- Migration: optional_source_message_id
-- Makes sourceMessageId nullable on Relation to support AGREE/DISAGREE relations
-- that carry no attached text message (pure stance declarations).
--
-- AGREE/DISAGREE with null sourceMessageId = pure stance vote with no text.
-- AGREE/DISAGREE with sourceMessageId set  = stance + attached text (support/rebut).
-- All other relation types still require sourceMessageId.

ALTER TABLE "Relation" ALTER COLUMN "sourceMessageId" DROP NOT NULL;
