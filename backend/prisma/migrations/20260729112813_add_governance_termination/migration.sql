-- AlterTable
ALTER TABLE "SettlementRound" ADD COLUMN     "effectiveAt" TIMESTAMP(3),
ADD COLUMN     "terminatedByRoundId" TEXT;

-- AddForeignKey
ALTER TABLE "SettlementRound" ADD CONSTRAINT "SettlementRound_terminatedByRoundId_fkey" FOREIGN KEY ("terminatedByRoundId") REFERENCES "SettlementRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;
