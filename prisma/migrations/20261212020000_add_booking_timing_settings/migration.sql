-- #4932: three timings a club may set, moved from constants onto the
-- BookingDefaults singleton: the pre-arrival reminder lead, the delay before
-- the first reminder to pay an extra amount, and the policy-exception hold
-- length.
--
-- EXPAND, OLD-CODE COMPATIBLE. Three NOT NULL columns with constant defaults
-- equal to the constants they replace, so an existing row reads exactly what
-- the code did before and the draining release, which never names them, still
-- inserts and updates the row. The CHECK constraints hold each to 1-30 days,
-- the same bounds the admin route and config transfer enforce.
--
-- No DML: an existing row takes the column defaults, and a missing row is
-- synthesised from DEFAULT_BOOKING_DEFAULTS, which carries the same values.

ALTER TABLE "BookingDefaults"
  ADD COLUMN "preArrivalReminderDays" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "additionalPaymentReminderDays" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "policyExceptionHoldDays" INTEGER NOT NULL DEFAULT 7;

ALTER TABLE "BookingDefaults"
  ADD CONSTRAINT "BookingDefaults_preArrivalReminderDays_range"
    CHECK ("preArrivalReminderDays" BETWEEN 1 AND 30),
  ADD CONSTRAINT "BookingDefaults_additionalPaymentReminderDays_range"
    CHECK ("additionalPaymentReminderDays" BETWEEN 1 AND 30),
  ADD CONSTRAINT "BookingDefaults_policyExceptionHoldDays_range"
    CHECK ("policyExceptionHoldDays" BETWEEN 1 AND 30);
