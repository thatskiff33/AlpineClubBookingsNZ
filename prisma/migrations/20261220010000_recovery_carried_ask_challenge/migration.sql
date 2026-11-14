-- #4755: expand-only. Two nullable columns with no default and no backfill; the
-- deployed client never selects them and keeps superseding as before.
ALTER TABLE "PaymentRecoveryOperation" ADD COLUMN "carriedAskChallengeIntentId" TEXT;
ALTER TABLE "PaymentRecoveryOperation" ADD COLUMN "carriedAskChallengeSeenAt" TIMESTAMP(3);
