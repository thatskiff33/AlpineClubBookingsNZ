-- CreateTable
CREATE TABLE "MinimumStayPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "triggerDays" INTEGER[],
    "minimumNights" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinimumStayPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MinimumStayPolicy_startDate_endDate_idx" ON "MinimumStayPolicy"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "MinimumStayPolicy_active_idx" ON "MinimumStayPolicy"("active");
