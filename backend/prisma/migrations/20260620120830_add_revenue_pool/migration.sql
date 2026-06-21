-- CreateTable
CREATE TABLE "RevenuePool" (
    "id" TEXT NOT NULL,
    "totalReceived" INTEGER NOT NULL DEFAULT 0,
    "totalDistributed" INTEGER NOT NULL DEFAULT 0,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenuePool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueDistribution" (
    "id" TEXT NOT NULL,
    "revenuePoolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueDistribution_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RevenueDistribution" ADD CONSTRAINT "RevenueDistribution_revenuePoolId_fkey" FOREIGN KEY ("revenuePoolId") REFERENCES "RevenuePool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueDistribution" ADD CONSTRAINT "RevenueDistribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
