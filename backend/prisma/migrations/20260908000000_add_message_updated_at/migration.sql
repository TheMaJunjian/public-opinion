-- Add a monotonic update timestamp for incremental topic synchronization.
ALTER TABLE "Message" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "Message" SET "updatedAt" = "createdAt";
ALTER TABLE "Message" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Message" ALTER COLUMN "updatedAt" SET NOT NULL;
