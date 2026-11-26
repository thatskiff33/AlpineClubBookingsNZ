import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    xeroTaxOverrideMismatch: { create: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      xeroTaxOverrideMismatch: { findFirst: vi.fn(), findMany: vi.fn() },
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { lineTaxMismatches } from "@/lib/xero-line-tax-mismatches";
import {
  clearXeroTaxOverridePause,
  listOpenXeroTaxOverrideMismatches,
  readXeroTaxOverridePause,
  recordXeroTaxOverrideMismatch,
} from "@/lib/xero-tax-override-safeguard";

/** #5208: the live safeguard on the journal's GST (owner decisions 18 and 20 Nov 2026). */

const line = (unitAmount: number, taxAmount?: number) => ({ description: "stay", quantity: 1, unitAmount, ...(taxAmount === undefined ? {} : { taxAmount }) });

describe("lineTaxMismatches", () => {
  it("pairs lines by position and compares only lines sent with a tax amount, in cents", () => {
    expect(lineTaxMismatches([line(80, 10.44), line(80), line(40, 5.22)], [line(80, 10.43), line(80, 10.43), line(40, 5.22)]))
      .toEqual([{ index: 0, sentCents: 1044, xeroCents: 1043 }]);
  });

  it("reads a float-noisy amount as the cents it means", () => {
    expect(lineTaxMismatches([line(80, 0.1 + 0.2)], [line(80, 0.3)])).toEqual([]);
  });

  it("counts a line Xero returned without tax, or did not return, as a mismatch", () => {
    expect(lineTaxMismatches([line(80, 10.44), line(80, 1)], [line(80)])).toEqual([
      { index: 0, sentCents: 1044, xeroCents: null },
      { index: 1, sentCents: 100, xeroCents: null },
    ]);
  });
});

describe("the pause", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is on while any mismatch is uncleared, and read outside a transaction", async () => {
    mocks.prisma.xeroTaxOverrideMismatch.findFirst.mockResolvedValueOnce(null);
    await expect(readXeroTaxOverridePause()).resolves.toBe("ON");
    mocks.prisma.xeroTaxOverrideMismatch.findFirst.mockResolvedValueOnce({ id: "m1" });
    await expect(readXeroTaxOverridePause()).resolves.toBe("PAUSED");
    expect(mocks.prisma.xeroTaxOverrideMismatch.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { clearedAt: null } }));
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("lists each flagged invoice's stored lines, dropping any entry that is not a line mismatch", async () => {
    const row = { id: "m1", createdAt: new Date("2026-07-01T00:00:00.000Z"), bookingId: "b1", providerInvoiceId: "inv-1", invoiceNumber: "INV-1", documentKind: "CREATE" };
    mocks.prisma.xeroTaxOverrideMismatch.findMany.mockResolvedValueOnce([
      { ...row, lines: [{ index: 0, sentCents: 1044, xeroCents: 1043 }, { index: 1, sentCents: 10.5, xeroCents: 1 }, "junk", { index: 2, sentCents: 522, xeroCents: null }] },
      { ...row, id: "m2", lines: { index: 0 } },
    ]);
    await expect(listOpenXeroTaxOverrideMismatches()).resolves.toEqual([
      { ...row, lines: [{ index: 0, sentCents: 1044, xeroCents: 1043 }, { index: 2, sentCents: 522, xeroCents: null }] },
      { ...row, id: "m2", lines: [] },
    ]);
  });
});

describe("recordXeroTaxOverrideMismatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.xeroTaxOverrideMismatch.create.mockResolvedValue({ id: "m1" });
  });
  const record = (sent: ReturnType<typeof line>[], returned: ReturnType<typeof line>[]) => recordXeroTaxOverrideMismatch({
    xeroSyncOperationId: "op_1", bookingId: "b1", providerInvoiceId: "inv_1", invoiceNumber: "INV-1", documentKind: "CREATE", sent, returned,
  });

  it("records the lines Xero changed and its audit row, in one transaction", async () => {
    await record([line(80, 10.44)], [line(80, 10.43)]);
    expect(mocks.tx.xeroTaxOverrideMismatch.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      xeroSyncOperationId: "op_1", documentKind: "CREATE", lines: [{ index: 0, sentCents: 1044, xeroCents: 1043 }] }) }));
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "XERO_TAX_OVERRIDES_PAUSED", category: "xero" }) });
  });

  it("records nothing when Xero kept every amount, or when its reply bills other lines", async () => {
    await record([line(80, 10.44)], [line(80, 10.44)]);
    await record([line(80, 10.44)], [line(79, 10.3)]);
    await record([line(80, 10.44)], []);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not compare a reply that may be an earlier attempt's invoice, sent with other line tax", async () => {
    const input = { xeroSyncOperationId: "op_1", bookingId: "b1", providerInvoiceId: "inv_1", invoiceNumber: null, documentKind: "CREATE" as const,
      sent: [line(80, 10.44)], returned: [line(80, 10.43)] };
    await recordXeroTaxOverrideMismatch({ ...input, earlierSent: [[line(80)]] });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    // An earlier attempt that sent the same tax is this request's twin: its reply is compared.
    await recordXeroTaxOverrideMismatch({ ...input, earlierSent: [[line(80, 10.44)]] });
    expect(mocks.tx.xeroTaxOverrideMismatch.create).toHaveBeenCalledTimes(1);
  });

  it("treats a second record for the same operation as already done, and never throws", async () => {
    mocks.tx.xeroTaxOverrideMismatch.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }));
    await expect(record([line(80, 10.44)], [line(80, 10.43)])).resolves.toBeUndefined();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalled();

    mocks.tx.xeroTaxOverrideMismatch.create.mockRejectedValueOnce(new Error("database down"));
    await expect(record([line(80, 10.44)], [line(80, 10.43)])).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ xeroSyncOperationId: "op_1" }), expect.stringContaining("Could not record"));
  });
});

describe("clearXeroTaxOverridePause", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims only the named rows still open, and audits the claim", async () => {
    mocks.tx.xeroTaxOverrideMismatch.updateMany.mockResolvedValueOnce({ count: 2 });
    await expect(clearXeroTaxOverridePause("admin_1", ["m1", "m2"], "checked in Xero")).resolves.toEqual({ cleared: 2 });
    expect(mocks.tx.xeroTaxOverrideMismatch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1", "m2"] }, clearedAt: null },
      data: expect.objectContaining({ clearedByMemberId: "admin_1", clearNote: "checked in Xero", clearedAt: expect.any(Date) }),
    });
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "XERO_TAX_OVERRIDE_PAUSE_CLEARED", memberId: "admin_1", category: "admin", severity: "important" }) });
  });

  it("writes no audit row for a lost claim, and touches nothing for an empty list", async () => {
    mocks.tx.xeroTaxOverrideMismatch.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(clearXeroTaxOverridePause("admin_1", ["m1"], "checked")).resolves.toEqual({ cleared: 0 });
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    await expect(clearXeroTaxOverridePause("admin_1", [], "checked")).resolves.toEqual({ cleared: 0 });
    expect(mocks.tx.xeroTaxOverrideMismatch.updateMany).toHaveBeenCalledTimes(1);
  });
});
