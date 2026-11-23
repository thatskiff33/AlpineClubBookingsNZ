-- #5433: the owed-notice markers. Expand only: one new, empty table and its
-- index, with no foreign key (the subject is a plain id, as on "EmailLog"),
-- so no existing table is touched. No row is seeded. The deployed release
-- names none of this: it keeps writing and sweeping its bump markers in
-- "AlertCooldown", which the new release also drains.

-- CreateTable
CREATE TABLE "OwedNotice" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "variant" TEXT,
    "payload" JSONB,
    "stampedAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwedNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwedNotice_kind_stampedAt_idx" ON "OwedNotice"("kind", "stampedAt");
