/**
 * Ledger M13 (#4525): the primary invoice's export manifest against real
 * PostgreSQL, as the INSERT/SELECT-only application role. The migration's
 * triggers and deferred check are the judge; ordinary Vitest runs skip the file.
 */
import type { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeExportManifest, type ExportManifestRow } from "@/lib/member-money/internal/store";
import { createMemberMoneyScratchDatabase, type MemberMoneyScratchDatabase } from "./support/member-money-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LODGE = "lodge-4525";

let scratch: MemberMoneyScratchDatabase;
let appPrisma: PrismaClient;
let app: Client;
let sequence = 0;

/** A booking of its own per case, so each manifest key is fresh. */
async function booking(): Promise<string> {
  const id = `booking-4525-${++sequence}`;
  await scratch.owner.query(`INSERT INTO "Booking" VALUES ($1, $2)`, [id, LODGE]);
  return id;
}

function row(bookingId: string, overrides: Partial<ExportManifestRow> = {}): ExportManifestRow {
  return {
    documentRole: "PRIMARY_BOOKING_INVOICE",
    legacyKey: `booking:${bookingId}:invoice:v1`,
    bookingId,
    outcome: "COVERED",
    reason: null,
    payloadHash: "a".repeat(64),
    frozenMapping: { source: "BUILT" },
    lineTotalCents: 16500,
    providerInvoiceId: "INV-4525",
    coverage: [
      { account: "BOOKING_REVENUE", chargeIdentity: `booking:${bookingId}:charge`, coveredCents: 14000, taxCode: "GST_INCLUSIVE_1500BP" },
      { account: "FEE_REVENUE", chargeIdentity: `fee:${bookingId}`, coveredCents: 2500, taxCode: "GST_INCLUSIVE_1500BP" },
    ],
    ...overrides,
  };
}

const write = (manifest: ExportManifestRow) => appPrisma.$transaction((tx) => writeExportManifest(tx, manifest));

async function stored(bookingId: string) {
  const manifests = (await app.query(`SELECT id, outcome, "payloadHash", "providerInvoiceId" FROM "MemberMoneyExportManifest" WHERE "bookingId" = $1`, [bookingId])).rows;
  const coverage = (await app.query(`SELECT c."chargeIdentity", c."coveredCents" FROM "MemberMoneyExportCoverage" c
    JOIN "MemberMoneyExportManifest" m ON m.id = c."manifestId" WHERE m."bookingId" = $1 ORDER BY c."chargeIdentity"`, [bookingId])).rows;
  return { manifests, coverage };
}

(RUN ? describe : describe.skip)("member-money export manifest against real PostgreSQL (#4525)", () => {
  beforeAll(async () => {
    scratch = await createMemberMoneyScratchDatabase(RACE_DB_URL, "member money export manifest");
    await scratch.owner.query(`INSERT INTO "Lodge" VALUES ($1)`, [LODGE]);
    const { PrismaClient: Prisma } = await import("@prisma/client");
    const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
    appPrisma = new Prisma({ adapter: createPrismaPgAdapter(scratch.appUrl) });
    app = new Client({ connectionString: scratch.appUrl });
    await app.connect();
  }, 30_000);

  afterAll(async () => {
    await appPrisma?.$disconnect();
    await app?.end();
    await scratch?.drop();
  });

  it("writes a COVERED manifest with its coverage, and a same-hash repeat is a no-op", async () => {
    const id = await booking();
    await expect(write(row(id))).resolves.toBe("WRITTEN");
    await expect(write(row(id))).resolves.toBe("SAME");
    await expect(write(row(id, { payloadHash: "b".repeat(64) }))).resolves.toBe("KEPT_FIRST");
    const { manifests, coverage } = await stored(id);
    expect(manifests).toMatchObject([{ outcome: "COVERED", payloadHash: "a".repeat(64), providerInvoiceId: "INV-4525" }]);
    expect(coverage).toEqual([
      { chargeIdentity: `booking:${id}:charge`, coveredCents: 14000 },
      { chargeIdentity: `fee:${id}`, coveredCents: 2500 },
    ]);
  });

  it("refuses UPDATE and DELETE of a written manifest and its coverage, even for the owner", async () => {
    const id = await booking();
    await write(row(id));
    for (const table of ["MemberMoneyExportManifest", "MemberMoneyExportCoverage"]) {
      await expect(app.query(`UPDATE "${table}" SET id = id`)).rejects.toMatchObject({ code: "42501" });
      await expect(app.query(`DELETE FROM "${table}"`)).rejects.toMatchObject({ code: "42501" });
      await expect(scratch.owner.query(`UPDATE "${table}" SET id = id`)).rejects.toMatchObject({ code: "23514" });
      await expect(scratch.owner.query(`DELETE FROM "${table}"`)).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("refuses coverage that does not add up to the line total, at commit", async () => {
    const id = await booking();
    await expect(write(row(id, { lineTotalCents: 16499 }))).rejects.toThrow(/coverage_total_mismatch/);
    expect(await stored(id)).toEqual({ manifests: [], coverage: [] });
  });

  it("refuses a component covered twice, by another manifest too", async () => {
    const id = await booking();
    const stay = row(id).coverage[0];
    await expect(write(row(id, { lineTotalCents: 28000, coverage: [stay, stay] }))).rejects.toMatchObject({ code: "P2002" });
    await write(row(id));
    const other = await booking();
    await expect(write(row(other, { lineTotalCents: 14000, coverage: [stay] }))).rejects.toMatchObject({ code: "P2002" });
    expect((await stored(other)).manifests).toEqual([]);
  });

  it("writes a CONFLICT with no coverage, and refuses coverage added to it later", async () => {
    const id = await booking();
    await expect(write(row(id, { outcome: "CONFLICT", reason: "STAY_CENTS", coverage: [] }))).resolves.toBe("WRITTEN");
    const { manifests, coverage } = await stored(id);
    expect(manifests).toMatchObject([{ outcome: "CONFLICT" }]);
    expect(coverage).toEqual([]);
    await expect(app.query(`INSERT INTO "MemberMoneyExportCoverage" (id,"manifestId","documentRole",account,"chargeIdentity","coveredCents")
      VALUES ('late-4525', $1, 'PRIMARY_BOOKING_INVOICE', 'BOOKING_REVENUE', $2, 16500)`, [manifests[0].id, `booking:${id}:late`]))
      .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("conflict_with_coverage") });
  });
});
