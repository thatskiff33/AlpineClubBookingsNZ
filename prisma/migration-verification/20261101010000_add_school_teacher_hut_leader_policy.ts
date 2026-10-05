import type { DataMigrationVerification } from "./types";

const verification: DataMigrationVerification = {
  migration: "20261101010000_add_school_teacher_hut_leader_policy",
  intent:
    "Add the default-OFF school teacher hut-leader policy without changing an existing singleton row or preventing an old-code-shaped upsert.",
  idempotentReRun: false,
  cases: [
    {
      name: "existing settings retain their values and receive the safe OFF default",
      seed: `
        INSERT INTO "BookingRequestSettings" (
          "id", "showPricingToNonMembers", "quoteResponseTtlDays",
          "quoteReminderLeadDays", "attendeeConfirmationLeadDays",
          "attendeeConfirmationReminderDays", "createdAt", "updatedAt"
        ) VALUES ('dmv-school-teacher-policy-existing', true, 10, 2, 21, 4, now(), now());
      `,
      afterMigration: `
        -- This names only the columns the previous Prisma client writes.
        INSERT INTO "BookingRequestSettings" (
          "id", "showPricingToNonMembers", "quoteResponseTtlDays",
          "quoteReminderLeadDays", "attendeeConfirmationLeadDays",
          "attendeeConfirmationReminderDays", "createdAt", "updatedAt"
        ) VALUES ('dmv-school-teacher-policy-old-upsert', false, 14, 3, 14, 3, now(), now());
      `,
      expectations: [
        {
          claim:
            "an old-code-shaped existing row and insert both retain their other values and read the new policy as false",
          sql: `
            SELECT "id", "showPricingToNonMembers", "quoteResponseTtlDays",
                   "assignSchoolTeachersAsHutLeaders"
            FROM "BookingRequestSettings"
            WHERE "id" LIKE 'dmv-school-teacher-policy-%'
            ORDER BY "id" COLLATE "C"
          `,
          rows: [
            {
              id: "dmv-school-teacher-policy-existing",
              showPricingToNonMembers: true,
              quoteResponseTtlDays: 10,
              assignSchoolTeachersAsHutLeaders: false,
            },
            {
              id: "dmv-school-teacher-policy-old-upsert",
              showPricingToNonMembers: false,
              quoteResponseTtlDays: 14,
              assignSchoolTeachersAsHutLeaders: false,
            },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "default school teacher assignments on",
      harm:
        "Every existing club receives automatic teacher hut-leader assignments without an administrator choosing that policy.",
      find: "DEFAULT false",
      replace: "DEFAULT true",
    },
    {
      name: "remove the database default",
      harm:
        "The draining application's old-shaped singleton upsert fails during the blue-green window.",
      find: "BOOLEAN NOT NULL DEFAULT false",
      replace: "BOOLEAN NOT NULL",
    },
  ],
};

export default verification;
