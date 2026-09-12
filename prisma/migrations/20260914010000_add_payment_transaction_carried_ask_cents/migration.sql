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
-- DEFAULT of 0, which is the truthful value for every row that already exists:
-- before this release nothing carried anything, because the balance it would
-- have carried was simply deleted (that is the defect). A draining old colour
-- omits the column on INSERT and receives 0, and never reads it.
ALTER TABLE "PaymentTransaction"
  ADD COLUMN "carriedAskCents" INTEGER NOT NULL DEFAULT 0;

COMMIT;
