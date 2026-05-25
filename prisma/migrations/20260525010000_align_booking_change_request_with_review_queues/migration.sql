-- Align BookingChangeRequest with the MembershipCancellationRequest and
-- MemberLifecycleActionRequest review-queue conventions: same status
-- vocabulary, same Member FK naming.

-- Rename status enum values.
ALTER TYPE "BookingChangeRequestStatus" RENAME VALUE 'PENDING' TO 'REQUESTED';
ALTER TYPE "BookingChangeRequestStatus" RENAME VALUE 'RESOLVED' TO 'APPROVED';
ALTER TYPE "BookingChangeRequestStatus" RENAME VALUE 'DECLINED' TO 'REJECTED';

-- Rename FK columns.
ALTER TABLE "BookingChangeRequest"
  RENAME COLUMN "requesterId" TO "requestedByMemberId";
ALTER TABLE "BookingChangeRequest"
  RENAME COLUMN "reviewedById" TO "reviewedByMemberId";

-- Rename FK constraints to match new column names.
ALTER TABLE "BookingChangeRequest"
  RENAME CONSTRAINT "BookingChangeRequest_requesterId_fkey"
  TO "BookingChangeRequest_requestedByMemberId_fkey";
ALTER TABLE "BookingChangeRequest"
  RENAME CONSTRAINT "BookingChangeRequest_reviewedById_fkey"
  TO "BookingChangeRequest_reviewedByMemberId_fkey";

-- Rename indexes that reference the renamed columns.
ALTER INDEX "BookingChangeRequest_requesterId_status_createdAt_idx"
  RENAME TO "BookingChangeRequest_requestedByMemberId_status_createdAt_idx";
ALTER INDEX "BookingChangeRequest_reviewedById_reviewedAt_idx"
  RENAME TO "BookingChangeRequest_reviewedByMemberId_reviewedAt_idx";
