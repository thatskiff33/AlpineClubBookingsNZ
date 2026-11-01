-- #4624: additive. A new enum type and two new columns on #4532's table. The
-- reason column's default is the only reason the previous release records, so
-- its inserts (which name neither column) stay correct; it never reads them.
CREATE TYPE "UnrecognisedStripePaymentReason" AS ENUM ('NOT_APP_CREATED', 'APP_INTENT_NO_TRANSACTION', 'APP_INTENT_NOT_PRIMARY');

ALTER TABLE "UnrecognisedStripePayment"
    ADD COLUMN "reason" "UnrecognisedStripePaymentReason" NOT NULL DEFAULT 'NOT_APP_CREATED',
    ADD COLUMN "bookingId" TEXT;
