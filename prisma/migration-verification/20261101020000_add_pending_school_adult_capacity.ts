import type { DataMigrationVerification } from "./types";

const verification: DataMigrationVerification = {
  migration: "20261101020000_add_pending_school_adult_capacity",
  intent:
    "Existing and old-code-shaped school requests receive zero unnamed adults; the migration never invents people or held capacity.",
  idempotentReRun: false,
  cases: [
    {
      name: "existing and draining-code request inserts both default to zero",
      seed: `
        INSERT INTO "BookingRequest" (
          "id", "type", "contactFirstName", "contactLastName", "contactEmail",
          "checkIn", "checkOut", "guests"
        ) VALUES (
          'dmv-pending-adult-existing', 'SCHOOL', 'Ada', 'School',
          'ada@example.invalid', DATE '2026-08-01', DATE '2026-08-03', '[]'::jsonb
        );
      `,
      afterMigration: `
        INSERT INTO "BookingRequest" (
          "id", "type", "contactFirstName", "contactLastName", "contactEmail",
          "checkIn", "checkOut", "guests"
        ) VALUES (
          'dmv-pending-adult-old-insert', 'SCHOOL', 'Bea', 'School',
          'bea@example.invalid', DATE '2026-08-01', DATE '2026-08-03', '[]'::jsonb
        );
      `,
      expectations: [
        {
          claim: "both old-shaped requests have zero pending adults",
          sql: `
            SELECT "id", "pendingAdultCount"
            FROM "BookingRequest"
            WHERE "id" LIKE 'dmv-pending-adult-%'
            ORDER BY "id" COLLATE "C"
          `,
          rows: [
            { id: "dmv-pending-adult-existing", pendingAdultCount: 0 },
            { id: "dmv-pending-adult-old-insert", pendingAdultCount: 0 },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "default one unnamed adult on every school request",
      harm: "Existing and draining-code requests would acquire a phantom adult count without a bed reservation.",
      find: 'ADD COLUMN "pendingAdultCount" INTEGER NOT NULL DEFAULT 0;',
      replace: 'ADD COLUMN "pendingAdultCount" INTEGER NOT NULL DEFAULT 1;',
    },
  ],
};

export default verification;
