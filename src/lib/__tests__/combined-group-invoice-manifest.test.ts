import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * #4525 (Ledger M13, ALP-437): the combined group invoice's manifest recorder
 * and its coverage release. It plans each child against the child's posted
 * legs and what other invoices still cover, writes once under the attempt's
 * key on the organiser's booking and the settlement, replays from the CREATE
 * row's stored request, and never throws: the sender's result never depends
 * on it.
 */

const mocks = vi.hoisted(() => {
  const tx = {
    memberMoneyLine: { findMany: vi.fn() },
    memberMoneyExportCoverage: { findMany: vi.fn(), findFirst: vi.fn(), createMany: vi.fn() },
    memberMoneyExportManifest: { findUnique: vi.fn(), createMany: vi.fn() },
    memberMoneyExportCoverageRelease: { createMany: vi.fn() },
  };
  return {
    tx,
    xeroSyncOperation: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    groupBookingSettlement: { findUnique: vi.fn() },
    manifests: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.$transaction,
    xeroSyncOperation: mocks.xeroSyncOperation,
    booking: mocks.booking,
    groupBookingSettlement: mocks.groupBookingSettlement,
    memberMoneyExportManifest: mocks.manifests,
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import type { LineItem } from "xero-node";
import { BASELINE_XERO_TAX_RENDERING } from "@/lib/xero-tax-rendering";
import { sanitizeForJson } from "@/lib/xero-sync";
import {
  recordCombinedGroupInvoiceManifest,
  releaseCombinedGroupInvoiceManifest,
} from "@/lib/member-money/internal/combined-group-invoice-manifest";

const TAX = "GST_INCLUSIVE_1500BP";
const target = { settlementId: "settle-1", organiserBookingId: "organiser-1", providerInvoiceId: "inv-1" };
const stayLine = (cents: number): LineItem => ({ description: "Stay", quantity: 1, unitAmount: cents / 100, accountCode: "200" });
const byChild = [
  { bookingId: "child-a", lodgeId: "lodge-1", seasonType: "WINTER", stayLines: [stayLine(9000)], feeLines: [] },
  { bookingId: "child-b", lodgeId: "lodge-2", seasonType: "WINTER", stayLines: [stayLine(8000)], feeLines: [] },
];
const built = (billedLines: LineItem[] = [stayLine(9000), stayLine(8000)]) => ({
  kind: "BUILT" as const,
  attempt: 1,
  lines: { byChild, hutFeeMapping: { code: "200", itemCode: null, codeExplicitlyConfigured: true },
    hutFeeItemCodeMap: { byKey: new Map(), fullTypeId: null, nonMemberTypeId: null, legacyItemCode: null, size: 0 } },
  taxRendering: BASELINE_XERO_TAX_RENDERING,
  billedLines,
});
const stayLeg = (bookingId: string, cents: number) => ({
  account: "BOOKING_REVENUE", chargeIdentity: `booking:${bookingId}:charge`, side: "CREDIT", amountCents: cents,
  grossCents: cents, netCents: cents, taxCents: 0, taxCode: TAX, bookingId, lodgeId: "lodge-1",
});
const legsOf: Record<string, unknown[]> = {};
const manifestRow = () => mocks.tx.memberMoneyExportManifest.createMany.mock.calls[0]?.[0].data[0];
const coverageRows = () => mocks.tx.memberMoneyExportCoverage.createMany.mock.calls[0]?.[0].data;

beforeEach(() => {
  vi.clearAllMocks();
  legsOf["child-a"] = [stayLeg("child-a", 9000)];
  legsOf["child-b"] = [stayLeg("child-b", 8000)];
  mocks.tx.memberMoneyLine.findMany.mockImplementation(async (args: { where: { bookingId: { in: string[] } } | { bookingId: string } }) => {
    const where = JSON.stringify(args.where);
    return Object.entries(legsOf).filter(([id]) => where.includes(`"${id}"`)).flatMap(([, legs]) => legs);
  });
  mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([]);
  mocks.tx.memberMoneyExportCoverage.findFirst.mockResolvedValue(null);
  mocks.tx.memberMoneyExportCoverage.createMany.mockResolvedValue({ count: 2 });
  mocks.tx.memberMoneyExportManifest.findUnique.mockResolvedValue(null);
  mocks.tx.memberMoneyExportManifest.createMany.mockResolvedValue({ count: 1 });
  mocks.tx.memberMoneyExportCoverageRelease.createMany.mockResolvedValue({ count: 1 });
  mocks.booking.findMany.mockResolvedValue([{ id: "child-a" }, { id: "child-b" }]);
  mocks.xeroSyncOperation.findMany.mockResolvedValue([]);
  mocks.manifests.findMany.mockResolvedValue([]);
  mocks.groupBookingSettlement.findUnique.mockResolvedValue({ xeroInvoiceId: null, groupBooking: { organiserBookingId: "organiser-1" } });
});

describe("recordCombinedGroupInvoiceManifest (#4525, ALP-437)", () => {
  it("writes one COVERED manifest on the organiser's booking and the settlement, covering each child's stay whole", async () => {
    await recordCombinedGroupInvoiceManifest(built(), target);
    expect(manifestRow()).toMatchObject({
      documentRole: "COMBINED_GROUP_INVOICE",
      legacyKey: "group-settlement:settle-1:invoice:attempt-1:v1",
      bookingId: "organiser-1",
      settlementId: "settle-1",
      outcome: "COVERED",
      lineTotalCents: 17000,
      providerInvoiceId: "inv-1",
    });
    expect(coverageRows()).toEqual([
      expect.objectContaining({ documentRole: "COMBINED_GROUP_INVOICE", chargeIdentity: "booking:child-a:charge", coveredCents: 9000, coverageGeneration: 0 }),
      expect.objectContaining({ documentRole: "COMBINED_GROUP_INVOICE", chargeIdentity: "booking:child-b:charge", coveredCents: 8000, coverageGeneration: 0 }),
    ]);
  });

  it("takes the generation after a released one", async () => {
    mocks.tx.memberMoneyExportCoverage.findFirst.mockResolvedValue({ coverageGeneration: 0 });
    await recordCombinedGroupInvoiceManifest(built(), target);
    expect(coverageRows().map((row: { coverageGeneration: number }) => row.coverageGeneration)).toEqual([1, 1]);
  });

  it("records a CONFLICT with no coverage when one child's stay charge differs from its lines", async () => {
    legsOf["child-b"] = [stayLeg("child-b", 7999)];
    await recordCombinedGroupInvoiceManifest(built(), target);
    expect(manifestRow()).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
    expect(mocks.tx.memberMoneyExportCoverage.createMany).not.toHaveBeenCalled();
  });

  it("records ALREADY_COVERED when another invoice still covers a child's stay", async () => {
    mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([
      { account: "BOOKING_REVENUE", chargeIdentity: "booking:child-a:charge", documentRole: "PRIMARY_BOOKING_INVOICE",
        manifest: { settlementId: null, providerInvoiceId: "inv-child-a" } },
    ]);
    await recordCombinedGroupInvoiceManifest(built(), target);
    expect(manifestRow()).toMatchObject({ outcome: "CONFLICT", reason: "ALREADY_COVERED" });
    expect(mocks.tx.memberMoneyExportCoverage.createMany).not.toHaveBeenCalled();
  });

  it("records nothing while an earlier invoice of the same settlement still covers a child, so its void's release records it", async () => {
    mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([
      { account: "BOOKING_REVENUE", chargeIdentity: "booking:child-a:charge", documentRole: "COMBINED_GROUP_INVOICE",
        manifest: { settlementId: "settle-1", providerInvoiceId: "inv-0" } },
    ]);
    await recordCombinedGroupInvoiceManifest(built(), target);
    expect(mocks.tx.memberMoneyExportManifest.createMany).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("holds the plan to the lines Xero says the invoice bills", async () => {
    await recordCombinedGroupInvoiceManifest(built([stayLine(9000)]), target);
    expect(manifestRow()).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
  });

  it("swallows a database failure and a lost race", async () => {
    mocks.tx.memberMoneyExportManifest.findUnique.mockRejectedValueOnce(new Error("connection lost"));
    await expect(recordCombinedGroupInvoiceManifest(built(), target)).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);

    mocks.tx.memberMoneyExportCoverage.createMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }));
    await expect(recordCombinedGroupInvoiceManifest(built(), target)).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it("replays from the CREATE row that raised the invoice, under that row's attempt, rebuilding nothing", async () => {
    mocks.xeroSyncOperation.findMany.mockResolvedValue([
      { correlationKey: "group-settlement:settle-1:invoice:v1", xeroObjectId: null,
        requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(1)]) }] } },
      { correlationKey: "group-settlement:settle-1:invoice:attempt-2:v1", xeroObjectId: "inv-1",
        requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(9000), stayLine(8000)]), lineAmountTypes: "Inclusive" }] } },
    ]);
    await recordCombinedGroupInvoiceManifest({ kind: "REPLAY", operationId: "op-1" }, target);
    expect(mocks.xeroSyncOperation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ localModel: "GroupBookingSettlement", localId: "settle-1",
        OR: [{ xeroObjectId: "inv-1" }, { id: "op-1", xeroObjectId: null }] }),
    }));
    expect(manifestRow()).toMatchObject({
      legacyKey: "group-settlement:settle-1:invoice:attempt-2:v1",
      outcome: "COVERED",
      frozenMapping: expect.objectContaining({ source: "STORED_REQUEST", lineAmountTypes: "Inclusive" }),
    });
  });

  it("replays against the children the stored request billed, not a same-priced child committed since", async () => {
    // child-b left the group; child-c joined at the same charge. The invoice billed child-b.
    legsOf["child-c"] = [stayLeg("child-c", 8000)];
    mocks.booking.findMany.mockResolvedValue([{ id: "child-a" }, { id: "child-c" }]);
    mocks.xeroSyncOperation.findMany.mockResolvedValue([
      { correlationKey: "group-settlement:settle-1:invoice:attempt-2:v1", xeroObjectId: "inv-1",
        requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(9000), stayLine(8000)]) }], childBookingIds: ["child-a", "child-b"] } },
    ]);
    await recordCombinedGroupInvoiceManifest({ kind: "REPLAY", operationId: null }, target);
    expect(mocks.booking.findMany).not.toHaveBeenCalled();
    expect(coverageRows().map((row: { chargeIdentity: string }) => row.chargeIdentity))
      .toEqual(["booking:child-a:charge", "booking:child-b:charge"]);
    delete legsOf["child-c"];
  });

  it("falls back to the children committed now for a request written before the children were recorded", async () => {
    mocks.xeroSyncOperation.findMany.mockResolvedValue([
      { correlationKey: "group-settlement:settle-1:invoice:attempt-2:v1", xeroObjectId: "inv-1",
        requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(9000), stayLine(8000)]) }] } },
    ]);
    await recordCombinedGroupInvoiceManifest({ kind: "REPLAY", operationId: null }, target);
    expect(mocks.booking.findMany).toHaveBeenCalledOnce();
    expect(manifestRow()).toMatchObject({ outcome: "COVERED" });
  });

  it("records nothing on a replay that finds no stored lines", async () => {
    await recordCombinedGroupInvoiceManifest({ kind: "REPLAY", operationId: "op-1" }, target);
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });
});

describe("releaseCombinedGroupInvoiceManifest (#4525, ALP-437)", () => {
  it("releases the invoice's live combined manifest, and records nothing more when the settlement still names it", async () => {
    mocks.manifests.findMany.mockResolvedValue([{ id: "manifest-1" }]);
    mocks.groupBookingSettlement.findUnique.mockResolvedValue({ xeroInvoiceId: "inv-1", groupBooking: { organiserBookingId: "organiser-1" } });
    await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "VOIDED" });
    expect(mocks.manifests.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { documentRole: "COMBINED_GROUP_INVOICE", settlementId: "settle-1", providerInvoiceId: "inv-1", release: { is: null } },
    }));
    expect(mocks.tx.memberMoneyExportCoverageRelease.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ manifestId: "manifest-1", reason: "VOIDED" })], skipDuplicates: true,
    });
    expect(mocks.xeroSyncOperation.findMany).not.toHaveBeenCalled();
  });

  it("then retries the record of the invoice the settlement is bound to now", async () => {
    mocks.groupBookingSettlement.findUnique.mockResolvedValue({ xeroInvoiceId: "inv-2", groupBooking: { organiserBookingId: "organiser-1" } });
    await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "NOT_FOUND" });
    expect(mocks.xeroSyncOperation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ xeroObjectId: "inv-2" }] }),
    }));
  });

  it("never throws", async () => {
    mocks.manifests.findMany.mockRejectedValue(new Error("down"));
    await expect(releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "VOIDED" })).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });
});
