-- CreateTable
CREATE TABLE "EvidenceRef" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "stanceType" TEXT NOT NULL,
    "relationId" TEXT,
    "voteId" TEXT,
    "stakeId" TEXT,
    "targetKind" TEXT NOT NULL,
    "messageId" TEXT,
    "textStart" INTEGER,
    "textLen" INTEGER,
    "targetRelId" TEXT,

    CONSTRAINT "EvidenceRef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceRef_userId_idx" ON "EvidenceRef"("userId");

-- CreateIndex
CREATE INDEX "EvidenceRef_relationId_idx" ON "EvidenceRef"("relationId");

-- CreateIndex
CREATE INDEX "EvidenceRef_voteId_idx" ON "EvidenceRef"("voteId");

-- CreateIndex
CREATE INDEX "EvidenceRef_stakeId_idx" ON "EvidenceRef"("stakeId");

-- AddForeignKey
ALTER TABLE "EvidenceRef" ADD CONSTRAINT "EvidenceRef_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRef" ADD CONSTRAINT "EvidenceRef_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRef" ADD CONSTRAINT "EvidenceRef_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "VoteStake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRef" ADD CONSTRAINT "EvidenceRef_stakeId_fkey" FOREIGN KEY ("stakeId") REFERENCES "Stake"("id") ON DELETE SET NULL ON UPDATE CASCADE;
