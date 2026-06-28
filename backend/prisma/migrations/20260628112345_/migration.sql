/*
  Warnings:

  - The primary key for the `BetPool` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "BetPool" DROP CONSTRAINT "BetPool_pkey",
ADD COLUMN     "settlementType" TEXT NOT NULL DEFAULT 'TRUTH',
ADD CONSTRAINT "BetPool_pkey" PRIMARY KEY ("messageId", "settlementType");
