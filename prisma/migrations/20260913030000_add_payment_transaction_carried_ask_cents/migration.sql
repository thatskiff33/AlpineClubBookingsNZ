BEGIN;

-- #3371 (INV-PAY-098, INV-PAY-047): record how much of an ADDITIONAL payment
-- request was ABSORBED from an ask the same mint retired.
--
-- Minting an ADDITIONAL PaymentIntent cancels every other live one on the
-- payment, so a replacement ask carries the unpaid balance of the one it
-- supersedes. Once that earlier row is cancelled, what it was owed for is not
-- derivable from anything on the booking, so the carried part is recorded as
-- its own fact instead of being folded invisibly into the figure it sits
-- inside.
--
-- EXPAND ONLY, and no stored amount changes. The column is NOT NULL with a
-- DEFAULT of 0. That is the truthful value for every row in the live
-- population today: no deployed colour has ever written a genuine carry,
-- because the balance a mint would have carried was simply deleted (that is
-- the defect this fixes). A draining old colour omits the column on INSERT
-- and receives 0, and never reads it.
--
-- RELEASE-ORDERING DEPENDENCY, and the reason 0 is not unconditionally true of
-- the CODE on main: #3364 is merged and already folds
-- outstandingAdditionalAskCents into an ordinary edit's amountCents, but its
-- changelog fragment is unreleased, so nothing has run in production yet. If
-- #3364 ships in a release AHEAD of this one, every ordinary-edit ADDITIONAL
-- row minted in that window carries a real balance, is stored as 0, and cannot
-- be reconstructed afterwards because the superseded rows are cancelled. Ship
-- the two together, or ship this one first. The consequence is provenance
-- only: carriedAskCents is read solely by findEditReviewChargeRequest, which
-- filters on the review-charge reason, so no money decision reads it for an
-- ordinary row and no backfill is owed either way.
ALTER TABLE "PaymentTransaction"
  ADD COLUMN "carriedAskCents" INTEGER NOT NULL DEFAULT 0;

COMMIT;
