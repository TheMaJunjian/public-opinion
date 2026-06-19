/*
  Warnings:

  - You are about to drop the `EvidenceRef` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "EvidenceRef" DROP CONSTRAINT "EvidenceRef_relationId_fkey";

-- DropForeignKey
ALTER TABLE "EvidenceRef" DROP CONSTRAINT "EvidenceRef_stakeId_fkey";

-- DropForeignKey
ALTER TABLE "EvidenceRef" DROP CONSTRAINT "EvidenceRef_userId_fkey";

-- DropForeignKey
ALTER TABLE "EvidenceRef" DROP CONSTRAINT "EvidenceRef_voteId_fkey";

-- DropTable
DROP TABLE "EvidenceRef";
