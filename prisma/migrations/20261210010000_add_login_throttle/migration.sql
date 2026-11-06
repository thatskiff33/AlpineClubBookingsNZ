-- #4609: additive. A new table only the new code reads and writes; the
-- deployed client never names it.
CREATE TABLE "LoginThrottle" (
    "id" TEXT NOT NULL,
    "failureCount" INTEGER NOT NULL,
    "lastFailureAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("id")
);

-- The idle-row sweep deletes by lastFailureAt.
CREATE INDEX "LoginThrottle_lastFailureAt_idx" ON "LoginThrottle"("lastFailureAt");
