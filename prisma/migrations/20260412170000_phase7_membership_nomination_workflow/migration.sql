-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM (
  'PENDING_NOMINATORS',
  'PENDING_ADMIN',
  'APPROVED',
  'REJECTED'
);

-- CreateTable
CREATE TABLE "MemberApplication" (
  "id" TEXT NOT NULL,
  "applicantFirstName" TEXT NOT NULL,
  "applicantLastName" TEXT NOT NULL,
  "applicantEmail" TEXT NOT NULL,
  "applicantDateOfBirth" TIMESTAMP(3),
  "applicantPhone" TEXT,
  "applicantAddress" JSONB,
  "familyMembers" JSONB,
  "nominator1Email" TEXT NOT NULL,
  "nominator2Email" TEXT NOT NULL,
  "nominator1Id" TEXT,
  "nominator2Id" TEXT,
  "nominator1ConfirmedAt" TIMESTAMP(3),
  "nominator2ConfirmedAt" TIMESTAMP(3),
  "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING_NOMINATORS',
  "adminNotes" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemberApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NominationToken" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "nominatorMemberId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NominationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberApplication_applicantEmail_idx" ON "MemberApplication"("applicantEmail");

-- CreateIndex
CREATE INDEX "MemberApplication_status_createdAt_idx" ON "MemberApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MemberApplication_nominator1Id_idx" ON "MemberApplication"("nominator1Id");

-- CreateIndex
CREATE INDEX "MemberApplication_nominator2Id_idx" ON "MemberApplication"("nominator2Id");

-- CreateIndex
CREATE UNIQUE INDEX "NominationToken_token_key" ON "NominationToken"("token");

-- CreateIndex
CREATE INDEX "NominationToken_applicationId_idx" ON "NominationToken"("applicationId");

-- CreateIndex
CREATE INDEX "NominationToken_nominatorMemberId_idx" ON "NominationToken"("nominatorMemberId");

-- CreateIndex
CREATE INDEX "NominationToken_expiresAt_idx" ON "NominationToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "NominationToken"
ADD CONSTRAINT "NominationToken_applicationId_fkey"
FOREIGN KEY ("applicationId")
REFERENCES "MemberApplication"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
