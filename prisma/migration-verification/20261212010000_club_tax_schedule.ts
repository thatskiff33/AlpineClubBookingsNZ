import type { DataMigrationVerification } from "./types";

const verification: DataMigrationVerification = {
  migration: "20261212010000_club_tax_schedule",
  intent:
    "An existing registered row keeps today's Xero output code, an existing unregistered row names none, and the new CHECK holds both.",
  idempotentReRun: false,
  cases: [
    {
      name: "a registered baseline row takes the default output code",
      seed: `
        INSERT INTO "ClubTaxSettings" ("id", "gstRegistered", "taxRateBasisPoints", "effectiveFrom", "updatedAt")
        VALUES ('default', true, 1500, DATE '2010-10-01', TIMESTAMP '2026-07-01 00:00:00');
      `,
      expectations: [
        {
          claim: "the registered row names OUTPUT2 and records no scheduler",
          sql: `SELECT "id", "gstRegistered", "xeroTaxType", "updatedByMemberId" FROM "ClubTaxSettings" ORDER BY "id" COLLATE "C"`,
          rows: [{ id: "default", gstRegistered: true, xeroTaxType: "OUTPUT2", updatedByMemberId: null }],
        },
      ],
    },
    {
      name: "an unregistered baseline row names no Xero code",
      seed: `
        INSERT INTO "ClubTaxSettings" ("id", "gstRegistered", "taxRateBasisPoints", "effectiveFrom", "updatedAt")
        VALUES ('default', false, 0, DATE '2010-10-01', TIMESTAMP '2026-07-01 00:00:00');
      `,
      expectations: [
        {
          claim: "the unregistered row's Xero code is NULL, so the CHECK holds",
          sql: `SELECT "id", "gstRegistered", "xeroTaxType" FROM "ClubTaxSettings" ORDER BY "id" COLLATE "C"`,
          rows: [{ id: "default", gstRegistered: false, xeroTaxType: null }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "default a different output code",
      harm: "A club that had recorded its registration would render every Xero document under a code its Xero never used.",
      find: `ADD COLUMN "xeroTaxType" TEXT DEFAULT 'OUTPUT2';`,
      replace: `ADD COLUMN "xeroTaxType" TEXT DEFAULT 'OUTPUT3';`,
    },
    {
      name: "clear the code on every row",
      harm: "A registered club's baseline would name no Xero code, and every document it renders would be refused.",
      find: `UPDATE "ClubTaxSettings" SET "xeroTaxType" = NULL WHERE "gstRegistered" = false;`,
      replace: `UPDATE "ClubTaxSettings" SET "xeroTaxType" = NULL;`,
    },
  ],
};

export default verification;
