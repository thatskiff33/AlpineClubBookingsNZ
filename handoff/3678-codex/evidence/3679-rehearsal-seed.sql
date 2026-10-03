-- Synthetic PRE-EPIC seed for #3679 only. Never apply to a deployed database.
-- Reviewed against origin/main schema 27a8d82d5c76ab4f3d2e3e02ae7217d5636a22dc.
-- Revalidated statically against 9cd9a646cc4e96261e56676b81fc00d73e0aff1d:
-- added EditReviewChargeRaiseClaim changes none of this seed's model columns.
-- Re-check that schema when the final pre-epic base is selected.
-- Fixture sources: the two 2026110101/020000 migration-verification files,
-- plus school-pending-adult-resolution.realdb.test.ts's named-teacher hold.
-- All identifiers below are TEXT/cuid-shaped model IDs, not PostgreSQL UUID
-- columns. The optional fake Xero contact is UUID-shaped DATA, never a call.
-- Times/dates are fixed synthetic values; money is integer cents.
-- No pendingAdultCount, new reservation table or teacher-policy column is
-- named here: this seed must execute BEFORE either epic migration.
-- Generic rehearsal reads take:1 per model: population permits value decoding
-- but does not guarantee every seeded status/relation is queried. It does not
-- prove application includes, writes, transitions, capacity or live providers.

BEGIN;

-- Use the singleton's real key, preserving a deliberate nondefault cadence.
-- New teacher-policy migration must supply OFF without changing these values.
INSERT INTO "BookingRequestSettings" (
  "id", "showPricingToNonMembers", "quoteResponseTtlDays",
  "quoteReminderLeadDays", "attendeeConfirmationLeadDays",
  "attendeeConfirmationReminderDays", "createdAt", "updatedAt"
) VALUES (
  'default', true, 10, 2, 21, 4,
  TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00'
)
ON CONFLICT ("id") DO UPDATE SET
  "showPricingToNonMembers" = EXCLUDED."showPricingToNonMembers",
  "quoteResponseTtlDays" = EXCLUDED."quoteResponseTtlDays",
  "quoteReminderLeadDays" = EXCLUDED."quoteReminderLeadDays",
  "attendeeConfirmationLeadDays" = EXCLUDED."attendeeConfirmationLeadDays",
  "attendeeConfirmationReminderDays" = EXCLUDED."attendeeConfirmationReminderDays",
  "updatedAt" = EXCLUDED."updatedAt";

-- Explicit nondefault lodge avoids depending on the chain's default-lodge ID.
INSERT INTO "Lodge" ("id", "name", "slug", "active", "isDefault", "createdAt", "updatedAt")
VALUES ('rehearsal-3679-lodge', 'Synthetic rehearsal lodge', 'rehearsal-3679-lodge',
  true, false, TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00');

-- A school is an Organisation; the real named teacher remains a distinct person.
INSERT INTO "Organisation" ("id", "kind", "name", "email", "xeroContactId", "createdAt", "updatedAt")
VALUES ('rehearsal-3679-school', 'SCHOOL', 'Synthetic rehearsal school',
  'school-3679@example.invalid', '00000000-0000-4000-8000-000000003679',
  TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00');

INSERT INTO "Member" (
  "id", "email", "passwordHash", "firstName", "lastName", "role", "ageTier",
  "canLogin", "inheritParentEmail", "createdAt", "updatedAt"
) VALUES ('rehearsal-3679-teacher', 'teacher-3679@example.invalid',
  'synthetic-disabled-account-not-a-password-hash', 'Ann', 'Teacher', 'USER', 'ADULT',
  false, false, TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00');

INSERT INTO "OrganisationContact" ("id", "organisationId", "memberId", "role", "createdAt", "updatedAt")
VALUES ('rehearsal-3679-school-teacher-contact', 'rehearsal-3679-school',
  'rehearsal-3679-teacher', 'TEACHER', TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00');

-- Exactly-one-owner CHECK: organisation set, member omitted. One accepted quote
-- holds an AWAITING_REVIEW booking; a separate already-converted request names
-- a historical CONFIRMED booking. These are established pre-epic enum values.
INSERT INTO "Booking" (
  "id", "organisationId", "lodgeId", "checkIn", "checkOut", "status",
  "totalPriceCents", "finalPriceCents", "hasNonMembers", "createdAt", "updatedAt"
) VALUES
  ('rehearsal-3679-hold', 'rehearsal-3679-school', 'rehearsal-3679-lodge',
   DATE '2026-08-01', DATE '2026-08-03', 'AWAITING_REVIEW', 601, 601, true,
   TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-sent-hold', 'rehearsal-3679-school', 'rehearsal-3679-lodge',
   DATE '2026-09-01', DATE '2026-09-03', 'AWAITING_REVIEW', 400, 400, true,
   TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-converted-booking', 'rehearsal-3679-school', 'rehearsal-3679-lodge',
   DATE '2026-06-01', DATE '2026-06-03', 'CONFIRMED', 400, 400, true,
   TIMESTAMP '2026-05-01 00:00:00', TIMESTAMP '2026-05-01 00:00:00');

-- Real named people only. Nonmember teacher may be linked to its person record;
-- an unlinked student stays a BookingGuest and is not invented as a Member.
INSERT INTO "BookingGuest" (
  "id", "bookingId", "firstName", "lastName", "ageTier", "isMember", "memberId",
  "stayStart", "stayEnd", "priceCents", "createdAt"
) VALUES
  ('rehearsal-3679-hold-teacher', 'rehearsal-3679-hold', 'Ann', 'Teacher', 'ADULT', false,
   'rehearsal-3679-teacher', DATE '2026-08-01', DATE '2026-08-03', 200, TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-hold-student', 'rehearsal-3679-hold', 'Sam', 'Student', 'CHILD', false,
   NULL, DATE '2026-08-01', DATE '2026-08-03', 401, TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-sent-teacher', 'rehearsal-3679-sent-hold', 'Ann', 'Teacher', 'ADULT', false,
   'rehearsal-3679-teacher', DATE '2026-09-01', DATE '2026-09-03', 400, TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-converted-teacher', 'rehearsal-3679-converted-booking', 'Ann', 'Teacher', 'ADULT', false,
   'rehearsal-3679-teacher', DATE '2026-06-01', DATE '2026-06-03', 400, TIMESTAMP '2026-05-01 00:00:00');

-- Half-open canonical night rows and cents-exact unequal split (401 = 200+201).
INSERT INTO "BookingGuestNight" ("id", "bookingGuestId", "stayDate", "priceCents", "priceSource", "createdAt")
VALUES
  ('rehearsal-3679-night-1', 'rehearsal-3679-hold-teacher', DATE '2026-08-01', 100, 'EVEN_SPLIT', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-night-2', 'rehearsal-3679-hold-teacher', DATE '2026-08-02', 100, 'EVEN_SPLIT', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-night-3', 'rehearsal-3679-hold-student', DATE '2026-08-01', 200, 'EVEN_SPLIT', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-night-4', 'rehearsal-3679-hold-student', DATE '2026-08-02', 201, 'EVEN_SPLIT', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-night-5', 'rehearsal-3679-converted-teacher', DATE '2026-06-01', 200, 'OFFICER_PRICED', TIMESTAMP '2026-05-01 00:00:00'),
  ('rehearsal-3679-night-6', 'rehearsal-3679-converted-teacher', DATE '2026-06-02', 200, 'OFFICER_PRICED', TIMESTAMP '2026-05-01 00:00:00'),
  ('rehearsal-3679-night-7', 'rehearsal-3679-sent-teacher', DATE '2026-09-01', 200, 'EVEN_SPLIT', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-night-8', 'rehearsal-3679-sent-teacher', DATE '2026-09-02', 200, 'EVEN_SPLIT', TIMESTAMP '2026-07-01 00:00:00');

-- Pre-existing request rows must all acquire pendingAdultCount=0 after migrate.
-- Accepted quote FK is assigned AFTER quote inserts to respect the circular FK.
INSERT INTO "BookingRequest" (
  "id", "type", "status", "contactFirstName", "contactLastName", "contactEmail",
  "checkIn", "checkOut", "guests", "teachers", "schoolName", "organisationId",
  "lodgeId", "cateringPreference", "heldBookingId", "convertedBookingId", "priceCents",
  "acceptedPriceCents", "acceptedAt", "version", "createdAt", "updatedAt"
) VALUES
  ('rehearsal-3679-requested', 'SCHOOL', 'QUOTE_SENT', 'Ann', 'Teacher', 'teacher-3679@example.invalid',
   DATE '2026-09-01', DATE '2026-09-03',
   '[{"firstName":"Ann","lastName":"Teacher","ageTier":"ADULT","isMember":false,"memberId":"rehearsal-3679-teacher"}]'::jsonb,
   '[{"firstName":"Ann","lastName":"Teacher","email":"teacher-3679@example.invalid"}]'::jsonb,
   'Synthetic rehearsal school', 'rehearsal-3679-school', 'rehearsal-3679-lodge', 'NON_CATERED',
   'rehearsal-3679-sent-hold', NULL, 400, NULL, NULL, 1, TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-accepted', 'SCHOOL', 'ACCEPTED', 'Ann', 'Teacher', 'teacher-3679@example.invalid',
   DATE '2026-08-01', DATE '2026-08-03',
   '[{"firstName":"Ann","lastName":"Teacher","ageTier":"ADULT","isMember":false,"memberId":"rehearsal-3679-teacher"},{"firstName":"Sam","lastName":"Student","ageTier":"CHILD","isMember":false,"memberId":null}]'::jsonb,
   '[{"firstName":"Ann","lastName":"Teacher","email":"teacher-3679@example.invalid"}]'::jsonb,
   'Synthetic rehearsal school', 'rehearsal-3679-school', 'rehearsal-3679-lodge', 'NON_CATERED',
   'rehearsal-3679-hold', NULL, 601, 601, TIMESTAMP '2026-07-01 00:00:00', 4,
   TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-converted', 'SCHOOL', 'CONVERTED', 'Ann', 'Teacher', 'teacher-3679@example.invalid',
   DATE '2026-06-01', DATE '2026-06-03',
   '[{"firstName":"Ann","lastName":"Teacher","ageTier":"ADULT","isMember":false,"memberId":"rehearsal-3679-teacher"}]'::jsonb,
   '[{"firstName":"Ann","lastName":"Teacher","email":"teacher-3679@example.invalid"}]'::jsonb,
   'Synthetic rehearsal school', 'rehearsal-3679-school', 'rehearsal-3679-lodge', 'NON_CATERED',
   NULL, 'rehearsal-3679-converted-booking', 400, NULL, NULL, 3,
   TIMESTAMP '2026-05-01 00:00:00', TIMESTAMP '2026-05-01 00:00:00');

INSERT INTO "BookingRequestQuote" (
  "id", "bookingRequestId", "version", "status", "pricingMode", "options",
  "sentAt", "acceptedAt", "createdAt", "updatedAt"
) VALUES
  ('rehearsal-3679-sent-quote', 'rehearsal-3679-requested', 1, 'SENT', 'OVERALL_TOTAL',
   '[{"id":"STANDARD","label":"School","cateringOption":"NON_CATERED","totalCents":400,"pricingMode":"OVERALL_TOTAL","guestBreakdown":[{"firstName":"Ann","lastName":"Teacher","ageTier":"ADULT","isMember":false,"memberId":"rehearsal-3679-teacher","guestIndex":0,"nightCount":2,"rateCents":null,"totalCents":400}]}]'::jsonb,
   TIMESTAMP '2026-07-01 00:00:00', NULL, TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00'),
  ('rehearsal-3679-accepted-quote', 'rehearsal-3679-accepted', 1, 'ACCEPTED', 'OVERALL_TOTAL',
   '[{"id":"STANDARD","label":"School","cateringOption":"NON_CATERED","totalCents":601,"pricingMode":"OVERALL_TOTAL","guestBreakdown":[{"firstName":"Ann","lastName":"Teacher","ageTier":"ADULT","isMember":false,"memberId":"rehearsal-3679-teacher","guestIndex":0,"nightCount":2,"rateCents":null,"totalCents":200},{"firstName":"Sam","lastName":"Student","ageTier":"CHILD","isMember":false,"memberId":null,"guestIndex":1,"nightCount":2,"rateCents":null,"totalCents":401}]}]'::jsonb,
   TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00',
   TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00');

UPDATE "BookingRequest" request
SET "acceptedQuoteId" = quote."id", "acceptedQuoteOptionId" = 'STANDARD',
    "acceptedQuoteSnapshot" = quote."options" -> 0
FROM "BookingRequestQuote" quote
WHERE request."id" = 'rehearsal-3679-accepted'
  AND quote."id" = 'rehearsal-3679-accepted-quote';

COMMIT;
