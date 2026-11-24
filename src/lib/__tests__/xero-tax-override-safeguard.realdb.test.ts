/**
 * The GST-override pause (#5208) against real PostgreSQL: a Xero reply that
 * changes the tax sent records one mismatch per sync operation and pauses the
 * overrides; clearing claims only the rows named and still open, and the pause
 * lifts only when none is left. The unique index on the operation, not the
 * code, is what makes a second record a no-op.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own namespaced rows.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "race-5208-";

let prisma: PrismaClient;
let safeguard: typeof import("@/lib/xero-tax-override-safeguard");

const sent = [{ description: "stay", quantity: 1, unitAmount: 80, taxType: "OUTPUT2", taxAmount: 10.44 }];
const changed = [{ ...sent[0]!, taxAmount: 10.43 }];

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { action: { in: ["XERO_TAX_OVERRIDES_PAUSED", "XERO_TAX_OVERRIDE_PAUSE_CLEARED"] } } });
  await prisma.xeroTaxOverrideMismatch.deleteMany({ where: { xeroSyncOperationId: { startsWith: PREFIX } } });
}

const record = (operation: string) => safeguard.recordXeroTaxOverrideMismatch({
  xeroSyncOperationId: `${PREFIX}${operation}`, bookingId: `${PREFIX}booking`, providerInvoiceId: `${PREFIX}inv-${operation}`,
  invoiceNumber: null, documentKind: "CREATE", sent, returned: changed,
});

(RUN ? describe : describe.skip)("the GST-override pause against real PostgreSQL (#5208)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "GST-override pause");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    safeguard = await import("@/lib/xero-tax-override-safeguard");
    await cleanup();
    expect(await prisma.xeroTaxOverrideMismatch.count({ where: { clearedAt: null } }), "an open mismatch this suite did not write").toBe(0);
  });
  afterAll(async () => {
    if (prisma) await cleanup();
  });

  it("records once per operation, pauses, and resumes only when every open row is cleared", async () => {
    await expect(safeguard.readXeroTaxOverridePause()).resolves.toBe("ON");
    await record("op-1");
    await record("op-1"); // a retried run of the same operation
    await record("op-2");
    expect(await prisma.xeroTaxOverrideMismatch.count({ where: { xeroSyncOperationId: { startsWith: PREFIX } } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: "XERO_TAX_OVERRIDES_PAUSED" } })).toBe(2);
    await expect(safeguard.readXeroTaxOverridePause()).resolves.toBe("PAUSED");

    const open = await safeguard.listOpenXeroTaxOverrideMismatches();
    expect(open.map((row) => row.lines)).toEqual([[{ index: 0, sentCents: 1044, xeroCents: 1043 }], [{ index: 0, sentCents: 1044, xeroCents: 1043 }]]);
    const [first, second] = open;

    await expect(safeguard.clearXeroTaxOverridePause("member-5208", [first!.id], "checked in Xero")).resolves.toEqual({ cleared: 1 });
    await expect(safeguard.readXeroTaxOverridePause()).resolves.toBe("PAUSED");
    // A second officer clearing the same row loses the claim and writes no audit row.
    await expect(safeguard.clearXeroTaxOverridePause("member-5208b", [first!.id], "again")).resolves.toEqual({ cleared: 0 });
    expect(await prisma.auditLog.count({ where: { action: "XERO_TAX_OVERRIDE_PAUSE_CLEARED" } })).toBe(1);

    await expect(safeguard.clearXeroTaxOverridePause("member-5208", [second!.id], "checked in Xero")).resolves.toEqual({ cleared: 1 });
    await expect(safeguard.readXeroTaxOverridePause()).resolves.toBe("ON");
    const cleared = await prisma.xeroTaxOverrideMismatch.findUnique({ where: { id: first!.id } });
    expect(cleared).toMatchObject({ clearedByMemberId: "member-5208", clearNote: "checked in Xero" });
    expect(cleared!.clearedAt).toBeInstanceOf(Date);
  });
});
