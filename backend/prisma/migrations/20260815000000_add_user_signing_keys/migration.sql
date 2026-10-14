CREATE TABLE "UserSigningKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSigningKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserSigningKey_userId_deviceId_key" ON "UserSigningKey"("userId", "deviceId");
CREATE INDEX "UserSigningKey_userId_idx" ON "UserSigningKey"("userId");

ALTER TABLE "UserSigningKey" ADD CONSTRAINT "UserSigningKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;