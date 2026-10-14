-- CreateTable
CREATE TABLE "SettlementRound" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "result" TEXT,
    "previousRoundId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "SettlementRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoteStake" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vote" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoteStake_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SettlementRound" ADD CONSTRAINT "SettlementRound_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRound" ADD CONSTRAINT "SettlementRound_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRound" ADD CONSTRAINT "SettlementRound_previousRoundId_fkey" FOREIGN KEY ("previousRoundId") REFERENCES "SettlementRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoteStake" ADD CONSTRAINT "VoteStake_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "SettlementRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoteStake" ADD CONSTRAINT "VoteStake_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
