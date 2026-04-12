-- Prevent multiple concurrently pending applications for the same applicant email.
-- Prisma schema cannot express this partial unique index.
CREATE UNIQUE INDEX "MemberApplication_pending_applicantEmail_unique"
ON "MemberApplication"("applicantEmail")
WHERE "status" IN ('PENDING_NOMINATORS', 'PENDING_ADMIN');
