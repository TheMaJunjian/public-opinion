-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "relationPayload" JSONB,
ALTER COLUMN "contentType" DROP DEFAULT;
