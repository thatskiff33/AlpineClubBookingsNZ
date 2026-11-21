/**
 * Ledger M13 (#4525, ALP-437): the combined group invoice's manifest, its
 * coverage generations and coverage releases, against real PostgreSQL as the
 * INSERT/SELECT-only application role. The migration's indexes, triggers and
 * deferred checks are the judge; ordinary Vitest runs skip the file.
 */
import type { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLiveInvoiceCoverage, releaseExportCoverage, writeExportManifest, type ExportManifestRow } from "@/lib/member-money/internal/store";
import { createMemberMoneyScratchDatabase, MEMBER_MONEY_SCRATCH_HOOK_TIMEOUT_MS, type MemberMoneyScratchDatabase } from "./support/member-money-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LODGE = "lodge-4525-group";
const TAX = "GST_INCLUSIVE_1500BP";

let scratch: MemberMoneyScratchDatabase;
let appPrisma: PrismaClient;
let app: Client;
let sequence = 0;

/** An organiser booking, one child and a settlement of their own per case. */
async function group(): Promise<{ organiser: string; child: string; settlementId: string }> {
  const n = ++sequence;
  const ids = { organiser: `organiser-4525-${n}`, child: `child-4525-${n}`, settlementId: `settle-4525-${n}` };
  await scratch.owner.query(`INSERT INTO "Booking" VALUES ($1, $3), ($2, $3)`, [ids.organiser, ids.child, LODGE]);
  await scratch.owner.query(`INSERT INTO "GroupBookingSettlement" VALUES ($1)`, [ids.settlementId]);
  return ids;
}

const stayOf = (bookingId: string) => `booking:${bookingId}:charge`;
const stay = (bookingId: string, coveredCents = 9000) =>
  ({ account: "BOOKING_REVENUE" as const, chargeIdentity: stayOf(bookingId), coveredCents, taxCode: TAX });

function combined(ids: { organiser: string; child: string; settlementId: string }, attempt: number, overrides: Partial<ExportManifestRow> = {}): ExportManifestRow {
  return {
    documentRole: "COMBINED_GROUP_INVOICE",
    legacyKey: `group-settlement:${ids.settlementId}:invoice:attempt-${attempt}:v1`,
    bookingId: ids.organiser,
    settlementId: ids.settlementId,
    outcome: "COVERED",
    reason: null,
    payloadHash: "d".repeat(64),
    frozenMapping: { source: "BUILT" },
    lineTotalCents: 9000,
    providerInvoiceId: `INV-GROUP-${ids.settlementId}-${attempt}`,
    coverage: [stay(ids.child)],
    ...overrides,
  };
}

function primary(bookingId: string, overrides: Partial<ExportManifestRow> = {}): ExportManifestRow {
  return {
    documentRole: "PRIMARY_BOOKING_INVOICE",
    legacyKey: `booking:${bookingId}:invoice:v1`,
    bookingId,
    outcome: "COVERED",
    reason: null,
    payloadHash: "a".repeat(64),
    frozenMapping: { source: "BUILT" },
    lineTotalCents: 9000,
    providerInvoiceId: `INV-${bookingId}`,
    coverage: [stay(bookingId)],
    ...overrides,
  };
}

const write = (manifest: ExportManifestRow) => appPrisma.$transaction((tx) => writeExportManifest(tx, manifest));

async function manifestId(legacyKey: string): Promise<string> {
  return (await app.query(`SELECT id FROM "MemberMoneyExportManifest" WHERE "legacyKey" = $1`, [legacyKey])).rows[0].id;
}
const release = async (legacyKey: string) => {
  const id = await manifestId(legacyKey);
  return appPrisma.$transaction((tx) => releaseExportCoverage(tx, id, "VOIDED"));
};
async function generations(chargeIdentity: string) {
  return (await app.query(`SELECT "documentRole", "coverageGeneration" FROM "MemberMoneyExportCoverage" WHERE "chargeIdentity" = $1
    ORDER BY "coverageGeneration", "documentRole"`, [chargeIdentity])).rows;
}

(RUN ? describe : describe.skip)("combined group invoice manifest and coverage releases against real PostgreSQL (#4525, ALP-437)", () => {
  beforeAll(async () => {
    scratch = await createMemberMoneyScratchDatabase(RACE_DB_URL, "member money combined group invoice");
    await scratch.owner.query(`INSERT INTO "Lodge" VALUES ($1)`, [LODGE]);
    const { PrismaClient: Prisma } = await import("@prisma/client");
    const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
    appPrisma = new Prisma({ adapter: createPrismaPgAdapter(scratch.appUrl) });
    app = new Client({ connectionString: scratch.appUrl });
    await app.connect();
  }, MEMBER_MONEY_SCRATCH_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await appPrisma?.$disconnect();
    await app?.end();
    await scratch?.drop();
  }, MEMBER_MONEY_SCRATCH_HOOK_TIMEOUT_MS);

  it("writes a combined manifest on the organiser's booking and settlement, covering the child's stay", async () => {
    const ids = await group();
    await expect(write(combined(ids, 0))).resolves.toBe("WRITTEN");
    const rows = (await app.query(`SELECT "bookingId", "settlementId" FROM "MemberMoneyExportManifest" WHERE "settlementId" = $1`, [ids.settlementId])).rows;
    expect(rows).toEqual([{ bookingId: ids.organiser, settlementId: ids.settlementId }]);
    expect(await generations(stayOf(ids.child))).toEqual([{ documentRole: "COMBINED_GROUP_INVOICE", coverageGeneration: 0 }]);
    await expect(appPrisma.$transaction((tx) => readLiveInvoiceCoverage(tx, [{ account: "BOOKING_REVENUE", chargeIdentity: stayOf(ids.child) }])))
      .resolves.toEqual([{ account: "BOOKING_REVENUE", chargeIdentity: stayOf(ids.child), documentRole: "COMBINED_GROUP_INVOICE",
        settlementId: ids.settlementId, providerInvoiceId: combined(ids, 0).providerInvoiceId }]);
  });

  it("names a settlement on a combined manifest and on no other", async () => {
    const ids = await group();
    await expect(write(combined(ids, 0, { settlementId: undefined }))).rejects.toThrow(/member_money_export_manifest_settlement/);
    await expect(write(primary(ids.child, { settlementId: ids.settlementId }))).rejects.toThrow(/member_money_export_manifest_settlement/);
  });

  it("refuses UPDATE and DELETE of a release, even for the owner", async () => {
    const ids = await group();
    await write(combined(ids, 0));
    await expect(release(combined(ids, 0).legacyKey)).resolves.toBe("RELEASED");
    await expect(release(combined(ids, 0).legacyKey)).resolves.toBe("ALREADY_RELEASED");
    await expect(app.query(`UPDATE "MemberMoneyExportCoverageRelease" SET id = id`)).rejects.toMatchObject({ code: "42501" });
    await expect(app.query(`DELETE FROM "MemberMoneyExportCoverageRelease"`)).rejects.toMatchObject({ code: "42501" });
    await expect(scratch.owner.query(`UPDATE "MemberMoneyExportCoverageRelease" SET id = id`)).rejects.toMatchObject({ code: "23514" });
    await expect(scratch.owner.query(`DELETE FROM "MemberMoneyExportCoverageRelease"`)).rejects.toMatchObject({ code: "23514" });
  });

  it("never lets a primary invoice and a combined invoice both live-cover one component, in either order", async () => {
    const first = await group();
    await write(primary(first.child));
    await expect(write(combined(first, 0))).rejects.toMatchObject({ code: "P2002" });
    expect((await app.query(`SELECT 1 FROM "MemberMoneyExportManifest" WHERE "settlementId" = $1`, [first.settlementId])).rows).toEqual([]);

    const second = await group();
    await write(combined(second, 0));
    await expect(write(primary(second.child))).rejects.toMatchObject({ code: "P2002" });
  });

  it("lets the next invoice cover a component at the next generation once the last one is released", async () => {
    const ids = await group();
    await write(combined(ids, 0));
    await expect(write(combined(ids, 1))).rejects.toMatchObject({ code: "P2002" });
    await release(combined(ids, 0).legacyKey);
    await expect(write(combined(ids, 1))).resolves.toBe("WRITTEN");
    await release(combined(ids, 1).legacyKey);
    // Across the role group: a primary invoice may follow the released combined ones.
    await expect(write(primary(ids.child))).resolves.toBe("WRITTEN");
    expect(await generations(stayOf(ids.child))).toEqual([
      { documentRole: "COMBINED_GROUP_INVOICE", coverageGeneration: 0 },
      { documentRole: "COMBINED_GROUP_INVOICE", coverageGeneration: 1 },
      { documentRole: "PRIMARY_BOOKING_INVOICE", coverageGeneration: 2 },
    ]);
    await expect(appPrisma.$transaction((tx) => readLiveInvoiceCoverage(tx, [{ account: "BOOKING_REVENUE", chargeIdentity: stayOf(ids.child) }])))
      .resolves.toEqual([{ account: "BOOKING_REVENUE", chargeIdentity: stayOf(ids.child), documentRole: "PRIMARY_BOOKING_INVOICE",
        settlementId: null, providerInvoiceId: `INV-${ids.child}` }]);
  });

  it("refuses a generation whose predecessor is unreleased or missing, at commit", async () => {
    const ids = await group();
    await write(combined(ids, 0));
    const insertAt = async (attempt: number, generation: number) => {
      const row = combined(ids, attempt);
      const id = `manual-${ids.settlementId}-${attempt}`;
      await app.query("BEGIN");
      try {
        await app.query(`INSERT INTO "MemberMoneyExportManifest" (id,"documentRole","legacyKey","renderRevision","bookingId","settlementId",outcome,"payloadHash","frozenMapping","lineTotalCents","providerInvoiceId")
          VALUES ($1,'COMBINED_GROUP_INVOICE',$2,1,$3,$4,'COVERED',$5,'{}',9000,$6)`, [id, row.legacyKey, ids.organiser, ids.settlementId, row.payloadHash, row.providerInvoiceId]);
        await app.query(`INSERT INTO "MemberMoneyExportCoverage" (id,"manifestId","documentRole",account,"chargeIdentity","coveredCents","taxCode","coverageGeneration")
          VALUES ($1,$1,'COMBINED_GROUP_INVOICE','BOOKING_REVENUE',$2,9000,$3,$4)`, [id, stayOf(ids.child), TAX, generation]);
        await app.query("COMMIT");
      } catch (error) {
        await app.query("ROLLBACK");
        throw error;
      }
    };
    await expect(insertAt(1, 1)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("generation_not_released") });
    await release(combined(ids, 0).legacyKey);
    await expect(insertAt(2, 2)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("generation_not_released") });
    await expect(insertAt(3, 1)).resolves.toBeUndefined();
  });

  it("refuses a combined manifest whose coverage does not add up to its line total, and coverage on its conflict", async () => {
    const ids = await group();
    await expect(write(combined(ids, 0, { lineTotalCents: 8999 }))).rejects.toThrow(/coverage_total_mismatch/);
    await expect(write(combined(ids, 0, { outcome: "CONFLICT", reason: "ALREADY_COVERED", coverage: [] }))).resolves.toBe("WRITTEN");
    expect(await generations(stayOf(ids.child))).toEqual([]);
  });
});
