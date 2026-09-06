import type { DataMigrationVerification } from "./types";

const verification: DataMigrationVerification = {
  migration: "20260911010000_add_booking_guest_night_price_source",
  intent:
    "Keep officer-repair provenance truthful while the draining colour still omits priceSource: only the exact successful BookingGuest repair audits may mark an existing matching row OFFICER_PRICED.",
  idempotentReRun: false,
  cases: [
    {
      name: "draining-colour officer repairs beside every near-match the trigger must ignore",
      seed: `
        INSERT INTO "Member"
          ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
        VALUES
          ('ps-trigger-owner', 'ps-trigger@example.test', 'x', 'Trigger', 'Owner',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "updatedAt")
        VALUES
          ('ps-trigger-booking', 'ps-trigger-owner', DATE '2026-08-01', DATE '2026-08-02',
           'CONFIRMED', 8000, 8000, TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "BookingGuest"
          ("id", "bookingId", "firstName", "lastName", "ageTier",
           "stayStart", "stayEnd", "priceCents")
        SELECT guest_id, 'ps-trigger-booking', 'Audit', guest_id, 'ADULT',
               DATE '2026-08-01', DATE '2026-08-02', 1000
        FROM unnest(ARRAY[
          'ps-trigger-action',
          'ps-trigger-amount',
          'ps-trigger-date',
          'ps-trigger-date-impossible',
          'ps-trigger-date-shape',
          'ps-trigger-entity',
          'ps-trigger-failed',
          'ps-trigger-metadata',
          'ps-trigger-negative',
          'ps-trigger-overflow',
          'ps-trigger-price-shape',
          'ps-trigger-record',
          'ps-trigger-reconcile',
          'ps-trigger-stale'
        ]) AS guest_ids(guest_id);

        INSERT INTO "BookingGuestNight"
          ("id", "bookingGuestId", "stayDate", "priceCents", "createdAt")
        SELECT 'night-' || guest_id, guest_id, DATE '2026-08-01',
               1000,
               CASE WHEN guest_id = 'ps-trigger-stale'
                 THEN TIMESTAMP '2026-03-01 00:00:00'
                 ELSE TIMESTAMP '2026-01-01 00:00:00'
               END
        FROM unnest(ARRAY[
          'ps-trigger-action',
          'ps-trigger-amount',
          'ps-trigger-date',
          'ps-trigger-date-impossible',
          'ps-trigger-date-shape',
          'ps-trigger-entity',
          'ps-trigger-failed',
          'ps-trigger-metadata',
          'ps-trigger-negative',
          'ps-trigger-overflow',
          'ps-trigger-price-shape',
          'ps-trigger-record',
          'ps-trigger-reconcile',
          'ps-trigger-stale'
        ]) AS guest_ids(guest_id);
      `,
      afterMigration: `
        INSERT INTO "AuditLog"
          ("id", "action", "entityType", "entityId", "outcome", "metadata", "createdAt")
        VALUES
          ('audit-action', 'booking-payment.unrelated', 'BookingGuest',
           'ps-trigger-action', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-amount', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-amount', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":1001}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-date', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-date', 'success',
           '{"nightPrices":[{"date":"2026-08-02","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-date-impossible', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-date-impossible', 'success',
           '{"nightPrices":[{"date":"2026-02-31","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-date-shape', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-date-shape', 'success',
           '{"nightPrices":[{"date":"2026-8-01","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-entity', 'booking-payment.stored-night-price.record', 'Booking',
           'ps-trigger-entity', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-failed', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-failed', 'failure',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-metadata', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-metadata', 'success',
           '{"nightPrices":{"date":"2026-08-01","priceCents":1000}}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-negative', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-negative', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":-1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-overflow', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-overflow', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":999999999999999999999}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-price-shape', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-price-shape', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":"1000"}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-record', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-record', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-reconcile', 'booking-payment.stored-night-price.reconcile', 'BookingGuest',
           'ps-trigger-reconcile', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('audit-stale', 'booking-payment.stored-night-price.record', 'BookingGuest',
           'ps-trigger-stale', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":1000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "both exact officer actions mark their matching rows, while malformed metadata and wrong action, entity, outcome, guest, date, amount, and stale evidence remain UNKNOWN",
          sql: `
            SELECT "bookingGuestId" AS "guest",
                   "priceCents" AS "priceCents",
                   "priceSource"::text AS "priceSource"
              FROM "BookingGuestNight"
             ORDER BY "bookingGuestId"
          `,
          rows: [
            { guest: "ps-trigger-action", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-amount", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-date", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-date-impossible", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-date-shape", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-entity", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-failed", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-metadata", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-negative", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-overflow", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-price-shape", priceCents: 1000, priceSource: "UNKNOWN" },
            { guest: "ps-trigger-record", priceCents: 1000, priceSource: "OFFICER_PRICED" },
            { guest: "ps-trigger-reconcile", priceCents: 1000, priceSource: "OFFICER_PRICED" },
            { guest: "ps-trigger-stale", priceCents: 1000, priceSource: "UNKNOWN" },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "accept non-array repair metadata",
      harm:
        "Malformed audit metadata reaches jsonb_array_elements and aborts the officer's otherwise valid transaction.",
      find: `IF jsonb_typeof(p_night_prices) IS DISTINCT FROM 'array' THEN`,
      replace: `IF FALSE THEN`,
    },
    {
      name: "accept an unrelated audit action",
      harm:
        "An unrelated audit carrying similarly shaped metadata manufactures officer provenance.",
      find: `IF NEW."action" IN (
      'booking-payment.stored-night-price.record',
      'booking-payment.stored-night-price.reconcile'
    )`,
      replace: `IF TRUE`,
    },
    {
      name: "accept the wrong audit entity",
      harm:
        "An audit about a different entity type can relabel a guest night that happens to share its identifier.",
      find: `AND NEW."entityType" = 'BookingGuest'`,
      replace: `AND TRUE`,
    },
    {
      name: "accept a failed officer repair",
      harm:
        "A failed repair audit can claim a stored amount was successfully supplied by an officer.",
      find: `AND NEW."outcome" = 'success'`,
      replace: `AND TRUE`,
    },
    {
      name: "ignore the audited guest",
      harm:
        "An exact audit for one guest can relabel another guest's equal-priced night.",
      find: `    WHERE bgn."bookingGuestId" = p_guest_id
`,
      replace: `    WHERE TRUE
`,
    },
    {
      name: "let an old audit relabel a recreated night",
      harm:
        "Historical repair evidence is applied to a replacement row created after that officer action.",
      find: `    AND bgn."createdAt" <= p_audit_created_at
`,
      replace: "",
    },
    {
      name: "accept a non-canonical audited date",
      harm:
        "A date that the writer could not have emitted is parsed leniently and used as officer provenance.",
      find: `    IF (item->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$') IS DISTINCT FROM TRUE THEN
      CONTINUE;
    END IF;
`,
      replace: "",
    },
    {
      name: "accept a string instead of the writer's numeric amount",
      harm:
        "Metadata with a source shape the officer writer did not emit can manufacture provenance.",
      find: `    IF jsonb_typeof(item->'priceCents') IS DISTINCT FROM 'number' THEN
      CONTINUE;
    END IF;
`,
      replace: "",
    },
    {
      name: "stop containing an impossible calendar date",
      harm:
        "One malformed audit date aborts the entire officer repair transaction instead of being ignored.",
      find: `        OR datetime_field_overflow
`,
      replace: "",
    },
    {
      name: "stop containing an overflowing audited amount",
      harm:
        "One oversized audit amount aborts the entire officer repair transaction instead of being ignored.",
      find: `        OR numeric_value_out_of_range
`,
      replace: "",
    },
    {
      name: "ignore the audited stay date",
      harm:
        "An officer amount for one date is attributed to a different night held by the same guest.",
      find: `      AND bgn."stayDate" = item_date
`,
      replace: "",
    },
    {
      name: "ignore the audited amount",
      harm:
        "An officer audit for a different number is treated as provenance for the stored price.",
      find: `      AND bgn."priceCents" = item_price_cents;
`,
      replace: `;\n`,
    },
  ],
};

export default verification;
