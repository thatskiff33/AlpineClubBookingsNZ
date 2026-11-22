/**
 * Ledger M13 (#4525): the primary invoice's export manifest against real
 * PostgreSQL, as the INSERT/SELECT-only application role. The migration's
 * triggers and deferred check are the judge; ordinary Vitest runs skip the file.
 */
import type { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeExportManifest, type ExportManifestRow } from "@/lib/member-money/internal/store";
import { describeUniqueConstraintTarget } from "@/lib/prisma-errors";
import { createMemberMoneyScratchDatabase, MEMBER_MONEY_SCRATCH_HOOK_TIMEOUT_MS, type MemberMoneyScratchDatabase } from "./support/member-money-fixtures";
import { runEveryTeardownStep } from "./support/teardown-steps";

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

/** A capture receipt of `cents` of one capture, under its own Xero payment key. */
function receipt(bookingId: string, key: string, cents: number): ExportManifestRow {
  return {
    documentRole: "CAPTURE_RECEIPT",
    legacyKey: key,
    bookingId,
    outcome: "COVERED",
    reason: null,
    payloadHash: "c".repeat(64),
    frozenMapping: { invoiceId: "INV-4525" },
    lineTotalCents: cents,
    providerInvoiceId: `PAY-${key}`,
    coverage: [{ account: "STRIPE_CLEARING", chargeIdentity: `capture:pi_${bookingId}`, coveredCents: cents, taxCode: null, sliceKey: key }],
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
  }, MEMBER_MONEY_SCRATCH_HOOK_TIMEOUT_MS);

  afterAll(() => runEveryTeardownStep("member-money-export-manifest.realdb", [
    { what: "disconnect the application Prisma client", run: () => appPrisma?.$disconnect() },
    { what: "end the application connection", run: () => app?.end() },
    { what: "drop the scratch database", run: () => scratch?.drop() },
  ]), MEMBER_MONEY_SCRATCH_HOOK_TIMEOUT_MS);

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

  it("refuses a second refund note covering the same refund debt, while its CONFLICT records with no rows (#4525 M13)", async () => {
    const id = await booking();
    const debt = { account: "REFUND_PAYABLE" as const, chargeIdentity: `refund-obligation|cancellation|${id}`, coveredCents: 5000, taxCode: null };
    const note = (legacyKey: string, overrides: Partial<ExportManifestRow> = {}) => row(id, {
      documentRole: "REFUND_NOTE", legacyKey, lineTotalCents: 5000, providerInvoiceId: `CN-${legacyKey}`, coverage: [debt], ...overrides,
    });
    await expect(write(note("first"))).resolves.toBe("WRITTEN");
    await expect(write(note("reissue"))).rejects.toMatchObject({ code: "P2002" });
    await expect(write(note("reissue", { outcome: "CONFLICT", reason: "ALREADY_COVERED", coverage: [] }))).resolves.toBe("WRITTEN");
    await expect(write(note("short", { outcome: "CONFLICT", reason: "CENTS", lineTotalCents: 4000, coverage: [] }))).resolves.toBe("WRITTEN");
    // The note's payment and a failed-later reversal cover cash, under their own roles.
    const cash = { account: "STRIPE_CLEARING" as const, chargeIdentity: `refund:re_${id}`, coveredCents: 5000, taxCode: null };
    await expect(write(row(id, { documentRole: "REFUND_NOTE_PAYMENT", legacyKey: "pay", lineTotalCents: 5000, providerInvoiceId: "PAY-1", coverage: [cash] })))
      .resolves.toBe("WRITTEN");
    await expect(write(row(id, { documentRole: "FAILED_LATER_REFUND_REVERSAL", legacyKey: "rev", lineTotalCents: 5000, providerInvoiceId: "INV-REV",
      coverage: [{ ...cash, chargeIdentity: `reversal:journal-${id}` }] }))).resolves.toBe("WRITTEN");
    const { manifests, coverage } = await stored(id);
    expect(manifests.map((m) => m.outcome).sort()).toEqual(["CONFLICT", "CONFLICT", "COVERED", "COVERED", "COVERED"]);
    expect(coverage.map((c) => c.chargeIdentity).sort()).toEqual([`refund-obligation|cancellation|${id}`, `refund:re_${id}`, `reversal:journal-${id}`].sort());
  });

  describe("ALP-436: supplementary invoices and primary invoice updates", () => {
    const stayOf = (id: string) => `booking:${id}:charge`;
    const supplementary = (id: string, sliceKey: string, cents: number, overrides: Partial<ExportManifestRow> = {}): ExportManifestRow => row(id, {
      documentRole: "SUPPLEMENTARY_BOOKING_INVOICE",
      legacyKey: `booking-mod:${sliceKey}:supplementary-invoice:v1`,
      lineTotalCents: cents,
      coverage: [{ account: "BOOKING_REVENUE", chargeIdentity: stayOf(id), sliceKey: `modification:${sliceKey}`, coveredCents: cents, taxCode: "GST_INCLUSIVE_1500BP" }],
      ...overrides,
    });
    const update = (id: string, overrides: Partial<ExportManifestRow> = {}): ExportManifestRow => row(id, {
      documentRole: "PRIMARY_BOOKING_INVOICE_UPDATE",
      legacyKey: `booking:${id}:invoice-update:INV-4525:v1`,
      coverage: [],
      ...overrides,
    });

    it("bills each edit's slice of the stay charge once, beside the primary invoice's whole cover", async () => {
      const id = await booking();
      await write(row(id));
      await expect(write(supplementary(id, "mod-a", 4500))).resolves.toBe("WRITTEN");
      await expect(write(supplementary(id, "mod-b", 3000))).resolves.toBe("WRITTEN");
      await expect(write(supplementary(id, "mod-a", 4500, { legacyKey: "another-key" }))).rejects.toMatchObject({ code: "P2002" });
      const slices = (await app.query(`SELECT "sliceKey", "coveredCents" FROM "MemberMoneyExportCoverage" WHERE "chargeIdentity" = $1 ORDER BY "documentRole", "sliceKey"`, [stayOf(id)])).rows;
      expect(slices).toEqual([
        { sliceKey: "", coveredCents: 14000 },
        { sliceKey: "modification:mod-a", coveredCents: 4500 },
        { sliceKey: "modification:mod-b", coveredCents: 3000 },
      ]);
    });

    it("keeps an edit's slice and a later second ask's closure slice apart, and refuses a second cover of the closure on the coverage key", async () => {
      const id = await booking();
      const closure = "review-close:task-t:line-1";
      const secondAsk = (legacyKey: string): ExportManifestRow => supplementary(id, "unused", 1500, {
        legacyKey,
        coverage: [{ account: "BOOKING_REVENUE", chargeIdentity: stayOf(id), sliceKey: closure, coveredCents: 1500, taxCode: "GST_INCLUSIVE_1500BP" }],
      });
      await write(row(id));
      // The edit's single fallback line billed only its own movement; the share it did not itemise is billed later.
      await expect(write(supplementary(id, "mod-e", 4500))).resolves.toBe("WRITTEN");
      await expect(write(secondAsk("review-task:task-t:supplementary-shortfall-invoice:1500:0:v1"))).resolves.toBe("WRITTEN");
      const refused = await write(secondAsk("another-key")).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "P2002" });
      // What the recorder reads to tell this from a race on the manifest's own key.
      expect(describeUniqueConstraintTarget(refused)).toContain("chargeidenti");
      const slices = (await app.query(`SELECT "sliceKey" FROM "MemberMoneyExportCoverage" WHERE "chargeIdentity" = $1 ORDER BY "sliceKey"`, [stayOf(id)])).rows;
      expect(slices).toEqual([{ sliceKey: "" }, { sliceKey: "modification:mod-e" }, { sliceKey: closure }]);
    });

    it("refuses a slice on the primary invoice's own cover", async () => {
      const id = await booking();
      const [stay, fee] = row(id).coverage;
      await expect(write(row(id, { coverage: [{ ...stay!, sliceKey: "modification:x" }, fee!] })))
        .rejects.toThrow(/member_money_export_coverage_slice/);
    });

    it("records a COVERED update with no coverage only against a matching COVERED primary", async () => {
      const id = await booking();
      await expect(write(update(id))).rejects.toThrow(/update_without_primary/);
      await write(row(id));
      await expect(write(update(id, { lineTotalCents: 16000 }))).rejects.toThrow(/update_without_primary/);
      await expect(write(update(id, { providerInvoiceId: "INV-other" }))).rejects.toThrow(/update_without_primary/);
      await expect(write(update(id, { coverage: [row(id).coverage[0]!], lineTotalCents: 14000 }))).rejects.toThrow(/update_with_coverage/);
      await expect(write(update(id))).resolves.toBe("WRITTEN");
      await expect(write(update(id, { legacyKey: "update-2", outcome: "CONFLICT", reason: "PRIMARY_UNMATCHED", lineTotalCents: 1 }))).resolves.toBe("WRITTEN");
    });
  });

  it("lets several receipts cover one capture under their own keys, and refuses a key covering it twice", async () => {
    const id = await booking();
    await expect(write(receipt(id, `payment:${id}:a`, 5000))).resolves.toBe("WRITTEN");
    await expect(write(receipt(id, `payment:${id}:b`, 3000))).resolves.toBe("WRITTEN");
    await expect(write(receipt(id, `payment:${id}:a`, 5000))).resolves.toBe("SAME");
    const { coverage } = await stored(id);
    expect(coverage).toHaveLength(2);
    expect(coverage).toEqual(expect.arrayContaining([{ chargeIdentity: `capture:pi_${id}`, coveredCents: 5000 }, { chargeIdentity: `capture:pi_${id}`, coveredCents: 3000 }]));
    // One key naming the same capture twice, on a manifest of its own.
    const twice = receipt(id, `payment:${id}:c`, 2000);
    await expect(write({ ...twice, lineTotalCents: 4000, coverage: [twice.coverage[0]!, twice.coverage[0]!] })).rejects.toMatchObject({ code: "P2002" });
  });
});
