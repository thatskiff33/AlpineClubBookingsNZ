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
    manifests: { findMany: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    $queryRaw: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.$transaction,
    $queryRaw: mocks.$queryRaw,
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
import { groupSettlementInvoiceVoidKey } from "@/lib/xero-group-settlement-invoice-outbox";
import {
  COMBINED_COVER_SWEEP_MAX_PAGES,
  COMBINED_COVER_SWEEP_PAGE_SIZE,
  recordCombinedGroupInvoiceManifest,
  releaseCombinedGroupInvoiceManifest,
  sweepVoidedCombinedGroupInvoiceCover,
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
/** The manifests written so far, by key, with the ids released: what `findUnique` reads back. */
const written = new Map<string, Record<string, unknown>>();
const releasedIds = new Set<string>();
const ATTEMPT_KEY = "group-settlement:settle-1:invoice:attempt-1:v1";
const SUCCESSOR_KEY = `${ATTEMPT_KEY}|after-release`;
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
  written.clear();
  releasedIds.clear();
  mocks.tx.memberMoneyExportManifest.findUnique.mockImplementation(async (args: { where: { documentRole_legacyKey: { legacyKey: string } } }) => {
    const row = written.get(args.where.documentRole_legacyKey.legacyKey);
    return row ? { ...row, release: releasedIds.has(row.id as string) ? { id: `release-${row.id}` } : null } : null;
  });
  mocks.tx.memberMoneyExportManifest.createMany.mockImplementation(async (args: { data: Record<string, unknown>[] }) => {
    for (const row of args.data) written.set(row.legacyKey as string, row);
    return { count: args.data.length };
  });
  mocks.tx.memberMoneyExportCoverageRelease.createMany.mockResolvedValue({ count: 1 });
  mocks.booking.findMany.mockResolvedValue([{ id: "child-a" }, { id: "child-b" }]);
  mocks.xeroSyncOperation.findMany.mockResolvedValue([]);
  mocks.manifests.findMany.mockResolvedValue([]);
  mocks.manifests.findFirst.mockResolvedValue(null);
  mocks.$queryRaw.mockResolvedValue([]);
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

  describe("a replacement behind its settlement's earlier invoice (owner decision, 25 Nov 2026)", () => {
    const earlierCovers = () => mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([
      { account: "BOOKING_REVENUE", chargeIdentity: "booking:child-a:charge", documentRole: "COMBINED_GROUP_INVOICE",
        manifest: { settlementId: "settle-1", providerInvoiceId: "inv-0" } },
    ]);

    it("records exactly one ALREADY_COVERED conflict and no coverage, even while the earlier invoice still covers a child", async () => {
      earlierCovers();
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(mocks.tx.memberMoneyExportManifest.createMany).toHaveBeenCalledOnce();
      expect(mocks.tx.memberMoneyExportManifest.createMany.mock.calls[0][0].data).toEqual([expect.objectContaining({
        documentRole: "COMBINED_GROUP_INVOICE", legacyKey: "group-settlement:settle-1:invoice:attempt-1:v1",
        settlementId: "settle-1", providerInvoiceId: "inv-1", outcome: "CONFLICT", reason: "ALREADY_COVERED",
      })]);
      expect(mocks.tx.memberMoneyExportCoverage.createMany).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "ALREADY_COVERED" }), expect.any(String));
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it("records nothing new on a replay: the first row stands", async () => {
      earlierCovers();
      await recordCombinedGroupInvoiceManifest(built(), target);
      const first = manifestRow();
      vi.clearAllMocks();
      mocks.tx.memberMoneyExportManifest.findUnique.mockResolvedValue({ payloadHash: first.payloadHash, providerInvoiceId: first.providerInvoiceId });
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(mocks.tx.memberMoneyExportManifest.createMany).not.toHaveBeenCalled();
      expect(mocks.tx.memberMoneyExportCoverage.createMany).not.toHaveBeenCalled();
    });

    // inv-0 is the abandoned earlier attempt, voided after inv-1 was sent; the settlement is bound to inv-1.
    const earlierReleased = () => {
      mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([]);
      mocks.tx.memberMoneyExportCoverage.findFirst.mockResolvedValue({ coverageGeneration: 0 });
      mocks.manifests.findMany.mockResolvedValueOnce([{ id: "manifest-0" }]).mockResolvedValue([]);
      mocks.groupBookingSettlement.findUnique.mockResolvedValue({ xeroInvoiceId: "inv-1", groupBooking: { organiserBookingId: "organiser-1" } });
      mocks.xeroSyncOperation.findMany.mockResolvedValue([
        { correlationKey: ATTEMPT_KEY, xeroObjectId: "inv-1",
          requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(9000), stayLine(8000)]) }], childBookingIds: ["child-a", "child-b"] } },
      ]);
    };
    const manifestWrites = () => mocks.tx.memberMoneyExportManifest.createMany.mock.calls.map((call) => call[0].data[0]);

    it("covers the replacement's components exactly once, at the next generation, when the earlier invoice's cover is released", async () => {
      earlierCovers();
      await recordCombinedGroupInvoiceManifest(built(), target);
      earlierReleased();
      await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-0", reason: "VOIDED" });

      expect(mocks.tx.memberMoneyExportCoverageRelease.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ manifestId: "manifest-0", reason: "VOIDED" })], skipDuplicates: true,
      });
      // The conflict stays as history; its successor carries the cover.
      expect(manifestWrites()).toEqual([
        expect.objectContaining({ legacyKey: ATTEMPT_KEY, outcome: "CONFLICT", reason: "ALREADY_COVERED" }),
        expect.objectContaining({ legacyKey: SUCCESSOR_KEY, outcome: "COVERED", reason: null, settlementId: "settle-1",
          bookingId: "organiser-1", providerInvoiceId: "inv-1", lineTotalCents: 17000 }),
      ]);
      expect(mocks.tx.memberMoneyExportCoverage.createMany).toHaveBeenCalledOnce();
      expect(coverageRows()).toEqual([
        expect.objectContaining({ manifestId: manifestWrites()[1].id, chargeIdentity: "booking:child-a:charge", coveredCents: 9000, coverageGeneration: 1 }),
        expect.objectContaining({ manifestId: manifestWrites()[1].id, chargeIdentity: "booking:child-b:charge", coveredCents: 8000, coverageGeneration: 1 }),
      ]);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    // Money review F1: the replacement's CREATE writes `xeroObjectId` only once its email is sent, after the bind.
    describe.each([
      ["before the replacement's CREATE completes (its email still sending)", null],
      ["after the replacement's CREATE completes", "inv-1"],
    ] as const)("the earlier invoice's release committing %s", (_when, createNames) => {
      it("turns the replacement's conflict into cover through the release's retry", async () => {
        earlierCovers();
        await recordCombinedGroupInvoiceManifest(built(), target);
        earlierReleased();
        const createRows = [
          // An older attempt's row that never named an invoice: never the bound invoice's.
          { id: "op-0", correlationKey: "group-settlement:settle-1:invoice:v1", xeroObjectId: null,
            requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(1)]) }], childBookingIds: ["child-a"] } },
          { id: "op-1", correlationKey: ATTEMPT_KEY, xeroObjectId: createNames,
            requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(9000), stayLine(8000)]) }], childBookingIds: ["child-a", "child-b"] } },
        ];
        mocks.xeroSyncOperation.findMany.mockImplementation(async (args: { where: { OR?: Record<string, unknown>[] } }) =>
          createRows.filter((row) => !args.where.OR
            || args.where.OR.some((clause) => Object.entries(clause).every(([key, value]) => row[key as keyof typeof row] === value))));
        await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-0", reason: "VOIDED" });
        expect(written.get(SUCCESSOR_KEY)).toMatchObject({ outcome: "COVERED", providerInvoiceId: "inv-1", lineTotalCents: 17000 });
        expect(coverageRows().map((row: { coverageGeneration: number }) => row.coverageGeneration)).toEqual([1, 1]);
        expect(mocks.logger.error).not.toHaveBeenCalled();
      });
    });

    it("adds nothing on a replayed release or record once the successor is written", async () => {
      earlierCovers();
      await recordCombinedGroupInvoiceManifest(built(), target);
      earlierReleased();
      await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-0", reason: "VOIDED" });
      // The successor now covers the components itself.
      mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([
        { account: "BOOKING_REVENUE", chargeIdentity: "booking:child-a:charge", documentRole: "COMBINED_GROUP_INVOICE",
          manifest: { settlementId: "settle-1", providerInvoiceId: "inv-1" } },
      ]);
      const before = { manifests: manifestWrites().length, coverage: mocks.tx.memberMoneyExportCoverage.createMany.mock.calls.length };
      await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-0", reason: "VOIDED" });
      await recordCombinedGroupInvoiceManifest(built(), target);
      await recordCombinedGroupInvoiceManifest({ kind: "REPLAY", operationId: null }, target);
      expect(manifestWrites()).toHaveLength(before.manifests);
      expect(mocks.tx.memberMoneyExportCoverage.createMany.mock.calls).toHaveLength(before.coverage);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it("keeps the conflict, with no coverage, while the earlier invoice is never released (it carries money)", async () => {
      earlierCovers();
      await recordCombinedGroupInvoiceManifest(built(), target);
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(manifestWrites()).toEqual([expect.objectContaining({ legacyKey: ATTEMPT_KEY, outcome: "CONFLICT", reason: "ALREADY_COVERED" })]);
      expect(mocks.tx.memberMoneyExportCoverage.createMany).not.toHaveBeenCalled();
    });

    it("never turns a conflict of another reason into cover", async () => {
      legsOf["child-b"] = [stayLeg("child-b", 7999)];
      await recordCombinedGroupInvoiceManifest(built(), target);
      legsOf["child-b"] = [stayLeg("child-b", 8000)];
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(manifestWrites()).toEqual([expect.objectContaining({ outcome: "CONFLICT", reason: "STAY_CENTS" })]);
      expect(mocks.tx.memberMoneyExportCoverage.createMany).not.toHaveBeenCalled();
    });

    it("covers when its own row lost the race to a conflict the other run planned before the release committed", async () => {
      // Another run's ALREADY_COVERED conflict: uncommitted when this run looked, so this run's insert meets the key.
      written.set(ATTEMPT_KEY, { id: "manifest-1", legacyKey: ATTEMPT_KEY, outcome: "CONFLICT", reason: "ALREADY_COVERED",
        payloadHash: "f".repeat(64), providerInvoiceId: "inv-1" });
      mocks.tx.memberMoneyExportManifest.findUnique.mockResolvedValueOnce(null);
      mocks.tx.memberMoneyExportManifest.createMany.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }));
      mocks.tx.memberMoneyExportCoverage.findFirst.mockResolvedValue({ coverageGeneration: 0 });
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(written.get(SUCCESSOR_KEY)).toMatchObject({ outcome: "COVERED", providerInvoiceId: "inv-1" });
      expect(coverageRows().map((row: { coverageGeneration: number }) => row.coverageGeneration)).toEqual([1, 1]);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it("covers when the earlier invoice's release lands between this run's own conflict and its step 2, with the release's retry absent", async () => {
      earlierCovers();
      mocks.tx.memberMoneyExportCoverage.findFirst.mockResolvedValue({ coverageGeneration: 0 });
      // inv-0's release commits just after this run's conflict commits; its retry of inv-1's record never runs.
      mocks.$transaction.mockImplementationOnce(async (fn: (client: typeof mocks.tx) => Promise<unknown>) => {
        const result = await fn(mocks.tx);
        mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([]);
        return result;
      });
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(manifestWrites()).toEqual([
        expect.objectContaining({ legacyKey: ATTEMPT_KEY, outcome: "CONFLICT", reason: "ALREADY_COVERED" }),
        expect.objectContaining({ legacyKey: SUCCESSOR_KEY, outcome: "COVERED", providerInvoiceId: "inv-1" }),
      ]);
      expect(coverageRows().map((row: { coverageGeneration: number }) => row.coverageGeneration)).toEqual([1, 1]);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it("releases the successor too when this invoice's own void released its conflict while the successor was written", async () => {
      earlierCovers();
      await recordCombinedGroupInvoiceManifest(built(), target);
      mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([]);
      mocks.tx.memberMoneyExportCoverage.findFirst.mockResolvedValue({ coverageGeneration: 0 });
      // inv-1's void committed its release of the conflict after the successor's transaction read it.
      mocks.manifests.findFirst.mockResolvedValue({ release: { reason: "VOIDED" } });
      mocks.manifests.findMany.mockImplementation(async () => [{ id: written.get(SUCCESSOR_KEY)!.id }]);
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(mocks.manifests.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { documentRole: "COMBINED_GROUP_INVOICE", settlementId: "settle-1", providerInvoiceId: "inv-1", release: { isNot: null } },
      }));
      expect(mocks.tx.memberMoneyExportCoverageRelease.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ manifestId: written.get(SUCCESSOR_KEY)!.id, reason: "VOIDED" })], skipDuplicates: true,
      });
    });

    it("writes no successor for a conflict whose own invoice is already released", async () => {
      earlierCovers();
      await recordCombinedGroupInvoiceManifest(built(), target);
      releasedIds.add(written.get(ATTEMPT_KEY)!.id as string);
      mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValue([]);
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(written.has(SUCCESSOR_KEY)).toBe(false);
    });
  });

  describe("a record that commits after its own invoice's void released nothing", () => {
    const VOID_KEYS = [
      "group-settlement:settle-1:invoice-void-after-cancel:inv-1:v1",
      "group-settlement:settle-1:invoice-void-after-abandon:inv-1:v1",
    ];
    /** The VOID rows the database holds: SUCCEEDED once the handler completes. */
    const voidRows: { status: string; responsePayload: unknown }[] = [];
    /** The manifests of inv-1 not yet released: what the release's sweep reads. */
    const unreleased = () => [...written.values()].filter((row) => row.providerInvoiceId === "inv-1" && !releasedIds.has(row.id as string))
      .map((row) => ({ id: row.id }));
    const isVoidRead = (args: { where: { operationType?: string } }) => args.where.operationType === "UPDATE";
    beforeEach(() => {
      voidRows.length = 0;
      mocks.xeroSyncOperation.findMany.mockImplementation(async (args: { where: { operationType?: string; status?: string } }) =>
        isVoidRead(args) ? voidRows.filter((row) => row.status === args.where.status).map((row) => ({ correlationKey: VOID_KEYS[1], ...row })) : []);
      mocks.manifests.findMany.mockImplementation(async () => unreleased());
      mocks.tx.memberMoneyExportCoverageRelease.createMany.mockImplementation(async (args: { data: { manifestId: string }[] }) => {
        for (const row of args.data) releasedIds.add(row.manifestId);
        return { count: args.data.length };
      });
      mocks.groupBookingSettlement.findUnique.mockResolvedValue({ xeroInvoiceId: "inv-1", groupBooking: { organiserBookingId: "organiser-1" } });
    });
    const releases = () => mocks.tx.memberMoneyExportCoverageRelease.createMany.mock.calls.map((call) => call[0].data[0]);

    it("void then record: the VOID finished before the record, so the record releases its own cover", async () => {
      // The void's release ran with nothing to release, then its row completed.
      await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "VOIDED" });
      voidRows.push({ status: "SUCCEEDED", responsePayload: { invoiceAlreadyVoid: true, invoiceStatus: "VOIDED" } });
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(manifestRow()).toMatchObject({ outcome: "COVERED", providerInvoiceId: "inv-1" });
      expect(mocks.xeroSyncOperation.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ localId: { in: ["settle-1"] }, status: "SUCCEEDED", correlationKey: { in: VOID_KEYS } }),
      }));
      expect(releases()).toEqual([expect.objectContaining({ manifestId: manifestRow().id, reason: "VOIDED" })]);
      expect(unreleased()).toEqual([]);
    });

    it("releases for the reason the VOID found: not in Xero", async () => {
      voidRows.push({ status: "SUCCEEDED", responsePayload: { invoiceNotFoundInXero: true } });
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(releases()).toEqual([expect.objectContaining({ manifestId: manifestRow().id, reason: "NOT_FOUND" })]);
    });

    it("record beside the void: the record read the VOID unfinished, and the handler's release after completing ends the cover", async () => {
      // The release's first passes ran before the record committed; the VOID row is still running when the record reads it.
      await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "VOIDED" });
      voidRows.push({ status: "RUNNING", responsePayload: null });
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(unreleased()).toEqual([{ id: manifestRow().id }]);
      // The handler completes its row, then releases once more.
      voidRows[0] = { status: "SUCCEEDED", responsePayload: { abandonedBySettlement: true, voidInvoice: null } };
      await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "VOIDED" });
      expect(releases()).toEqual([expect.objectContaining({ manifestId: manifestRow().id, reason: "VOIDED" })]);
      expect(unreleased()).toEqual([]);
    });

    it("record then void: the void's own release ends the cover, and the record's read adds nothing", async () => {
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(releases()).toEqual([]);
      voidRows.push({ status: "SUCCEEDED", responsePayload: { cancelledAfterInvoiceCreation: true, voidInvoice: null } });
      await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "VOIDED" });
      expect(releases()).toEqual([expect.objectContaining({ manifestId: manifestRow().id, reason: "VOIDED" })]);
      expect(unreleased()).toEqual([]);
    });

    it("keeps the cover when the VOID found the invoice carrying money", async () => {
      voidRows.push({ status: "SUCCEEDED", responsePayload: { invoiceNotVoidedCarriesMoney: true, invoiceState: { kind: "has_money" } } });
      voidRows.push({ status: "SUCCEEDED", responsePayload: { skippedInvoiceStillLinkedToSettlement: true } });
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(manifestRow()).toMatchObject({ outcome: "COVERED" });
      expect(releases()).toEqual([]);
    });

    it("writes no successor for a conflict the finished VOID released", async () => {
      mocks.tx.memberMoneyExportCoverage.findMany.mockResolvedValueOnce([
        { account: "BOOKING_REVENUE", chargeIdentity: "booking:child-a:charge", documentRole: "COMBINED_GROUP_INVOICE",
          manifest: { settlementId: "settle-1", providerInvoiceId: "inv-0" } },
      ]);
      voidRows.push({ status: "SUCCEEDED", responsePayload: { invoiceAlreadyVoid: true } });
      await recordCombinedGroupInvoiceManifest(built(), target);
      expect(written.get(ATTEMPT_KEY)).toMatchObject({ outcome: "CONFLICT", reason: "ALREADY_COVERED" });
      expect(releasedIds.has(written.get(ATTEMPT_KEY)!.id as string)).toBe(true);
      expect(written.has(SUCCESSOR_KEY)).toBe(false);
    });
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

  // Delta review: the retry's reads take no lock. Between its read of the binding and its read of the CREATE rows,
  // inv-1 is abandoned and attempt 2 queued; attempt 2's handler has stored its request, unnamed.
  it("writes nothing for the bound invoice when it is let go and the next attempt queued during the retry's reads", async () => {
    mocks.groupBookingSettlement.findUnique
      .mockResolvedValueOnce({ xeroInvoiceId: "inv-1", groupBooking: { organiserBookingId: "organiser-1" } })
      .mockResolvedValue({ xeroInvoiceId: null, groupBooking: { organiserBookingId: "organiser-1" } });
    const createRows = [
      // inv-1's own CREATE, its email never sent: it names no invoice.
      { correlationKey: ATTEMPT_KEY, xeroObjectId: null,
        requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(9000), stayLine(8000)]) }], childBookingIds: ["child-a", "child-b"] } },
      // Attempt 2's request, for the invoice still to be raised.
      { correlationKey: "group-settlement:settle-1:invoice:attempt-2:v1", xeroObjectId: null,
        requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(9000)]) }], childBookingIds: ["child-a"] } },
    ];
    mocks.xeroSyncOperation.findMany.mockImplementation(async (args: { where: { OR?: Record<string, unknown>[] } }) =>
      createRows.filter((row) => !args.where.OR
        || args.where.OR.some((clause) => Object.entries(clause).every(([key, value]) => row[key as keyof typeof row] === value))));
    await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-0", reason: "VOIDED" });
    // Attempt 2's key stays free for the invoice it raises.
    expect(mocks.tx.memberMoneyExportManifest.createMany).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("sweeps again after its commit, so a successor its own record wrote beside the first pass is released too", async () => {
    mocks.manifests.findMany.mockResolvedValueOnce([{ id: "manifest-1" }]).mockResolvedValueOnce([{ id: "successor-1" }]).mockResolvedValue([]);
    mocks.groupBookingSettlement.findUnique.mockResolvedValue({ xeroInvoiceId: "inv-1", groupBooking: { organiserBookingId: "organiser-1" } });
    await releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "NOT_FOUND" });
    expect(mocks.tx.memberMoneyExportCoverageRelease.createMany.mock.calls.map((call) => call[0].data[0])).toEqual([
      expect.objectContaining({ manifestId: "manifest-1", reason: "NOT_FOUND" }),
      expect.objectContaining({ manifestId: "successor-1", reason: "NOT_FOUND" }),
    ]);
  });

  it("never throws, and says whether the invoice's manifests were released", async () => {
    await expect(releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "VOIDED" })).resolves.toBe(true);
    mocks.manifests.findMany.mockRejectedValue(new Error("down"));
    await expect(releaseCombinedGroupInvoiceManifest({ settlementId: "settle-1", invoiceId: "inv-1", reason: "VOIDED" })).resolves.toBe(false);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });
});

/**
 * #4525 review (lane decision under the owner's standing instruction of
 * 25 Nov 2026): the payments cycle's sweep. While the old colour drains, its
 * void handlers finish a VOID and write no release; the sweep reads that VOID
 * and releases through the one release writer, whose retry covers the
 * replacement.
 */
describe("sweepVoidedCombinedGroupInvoiceCover (#4525 review)", () => {
  const ABANDON_VOID_KEY = "group-settlement:settle-1:invoice-void-after-abandon:inv-0:v1";
  /** inv-0: the earlier attempt's invoice, covered; inv-1: the replacement the settlement is bound to. */
  const manifests = [{ id: "manifest-0", settlementId: "settle-1", providerInvoiceId: "inv-0" }];
  /** The group-settlement VOID rows the database holds. */
  let voids: { id: string; createdAt: Date; status: string; responsePayload: Record<string, unknown> }[];
  const unreleasedOf = (invoiceId: string) => manifests.filter((row) => !releasedIds.has(row.id) && row.providerInvoiceId === invoiceId);
  const ENDED = ["cancelledAfterInvoiceCreation", "abandonedBySettlement", "invoiceAlreadyVoid", "invoiceNotFoundInXero"];
  /** The statement the sweep sent: its text and bound values. */
  const statement = (call: unknown[]) => Prisma.sql(call[0] as TemplateStringsArray, ...call.slice(1));

  beforeEach(() => {
    voids = [{ id: "void-0", createdAt: new Date("2026-06-30T00:00:00.000Z"), status: "SUCCEEDED", responsePayload: { abandonedBySettlement: true, voidInvoice: null } }];
    // The earlier invoice covers child-a until its manifest is released.
    mocks.tx.memberMoneyExportCoverage.findMany.mockImplementation(async () => releasedIds.has("manifest-0") ? [] : [
      { account: "BOOKING_REVENUE", chargeIdentity: "booking:child-a:charge", documentRole: "COMBINED_GROUP_INVOICE",
        manifest: { settlementId: "settle-1", providerInvoiceId: "inv-0" } },
    ]);
    mocks.tx.memberMoneyExportCoverage.findFirst.mockImplementation(async () => releasedIds.has("manifest-0") ? { coverageGeneration: 0 } : null);
    mocks.tx.memberMoneyExportCoverageRelease.createMany.mockImplementation(async (args: { data: { manifestId: string }[] }) => {
      for (const row of args.data) releasedIds.add(row.manifestId);
      return { count: args.data.length };
    });
    mocks.manifests.findMany.mockImplementation(async (args: { where: { providerInvoiceId: string } }) =>
      unreleasedOf(args.where.providerInvoiceId).map(({ id }) => ({ id })));
    // The statement's join: a VOID with an ended flag whose invoice still has an unreleased manifest. Its status
    // filter is the statement's own (asserted on its text); every status is returned here, so the re-check is proven too.
    mocks.$queryRaw.mockImplementation(async () => voids
      .filter((row) => ENDED.some((flag) => row.responsePayload[flag] === true) && unreleasedOf("inv-0").length > 0)
      .map((row) => ({ id: row.id, createdAt: row.createdAt, settlementId: "settle-1", invoiceId: "inv-0" })));
    mocks.groupBookingSettlement.findUnique.mockResolvedValue({ xeroInvoiceId: "inv-1", groupBooking: { organiserBookingId: "organiser-1" } });
    const createRow = { id: "op-1", correlationKey: ATTEMPT_KEY, xeroObjectId: "inv-1",
      requestPayload: { invoices: [{ lineItems: sanitizeForJson([stayLine(9000), stayLine(8000)]) }], childBookingIds: ["child-a", "child-b"] } };
    mocks.xeroSyncOperation.findMany.mockImplementation(async (args: { where: { operationType: string; status?: string; correlationKey?: { in: string[] } } }) => {
      if (args.where.operationType === "CREATE") return [createRow];
      if (!args.where.correlationKey?.in.includes(ABANDON_VOID_KEY)) return [];
      return voids.filter((row) => args.where.status === undefined || row.status === args.where.status)
        .map((row) => ({ correlationKey: ABANDON_VOID_KEY, status: row.status, responsePayload: row.responsePayload }));
    });
  });

  /** The replacement's record ran while the earlier invoice still covered: an ALREADY_COVERED conflict. */
  const replacementBehindEarlier = async () => {
    await recordCombinedGroupInvoiceManifest(built(), target);
    expect(written.get(ATTEMPT_KEY)).toMatchObject({ outcome: "CONFLICT", reason: "ALREADY_COVERED" });
  };

  it("releases a cover an old-colour void left live, and the replacement becomes covered", async () => {
    await replacementBehindEarlier();
    // The old colour's handler finished the VOID and wrote no release: nothing else runs.
    expect(releasedIds.has("manifest-0")).toBe(false);
    await expect(sweepVoidedCombinedGroupInvoiceCover()).resolves.toEqual({ checked: 1, released: 1, releaseFailures: 0, truncated: false, failed: false });
    expect(mocks.tx.memberMoneyExportCoverageRelease.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ manifestId: "manifest-0", reason: "VOIDED" })], skipDuplicates: true,
    });
    expect(written.get(SUCCESSOR_KEY)).toMatchObject({ outcome: "COVERED", providerInvoiceId: "inv-1", lineTotalCents: 17000 });
    expect(coverageRows().map((row: { coverageGeneration: number }) => row.coverageGeneration)).toEqual([1, 1]);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("releases for the reason the VOID found: not in Xero", async () => {
    voids[0]!.responsePayload = { invoiceNotFoundInXero: true };
    await sweepVoidedCombinedGroupInvoiceCover();
    expect(mocks.tx.memberMoneyExportCoverageRelease.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ manifestId: "manifest-0", reason: "NOT_FOUND" })], skipDuplicates: true,
    });
  });

  it("adds nothing on a second run", async () => {
    await replacementBehindEarlier();
    await sweepVoidedCombinedGroupInvoiceCover();
    const before = { releases: mocks.tx.memberMoneyExportCoverageRelease.createMany.mock.calls.length, manifests: written.size };
    await expect(sweepVoidedCombinedGroupInvoiceCover()).resolves.toEqual({ checked: 0, released: 0, releaseFailures: 0, truncated: false, failed: false });
    expect(mocks.tx.memberMoneyExportCoverageRelease.createMany.mock.calls).toHaveLength(before.releases);
    expect(written.size).toBe(before.manifests);
  });

  it("never releases an invoice whose VOID found it carrying money, and the replacement keeps its conflict", async () => {
    voids[0]!.responsePayload = { invoiceNotVoidedCarriesMoney: true, invoiceState: { kind: "has_money" } };
    await replacementBehindEarlier();
    await expect(sweepVoidedCombinedGroupInvoiceCover()).resolves.toEqual({ checked: 0, released: 0, releaseFailures: 0, truncated: false, failed: false });
    expect(mocks.tx.memberMoneyExportCoverageRelease.createMany).not.toHaveBeenCalled();
    expect(written.has(SUCCESSOR_KEY)).toBe(false);
  });

  it.each(["RUNNING", "FAILED"])("never releases on a VOID that is %s, even one carrying an ended flag", async (status) => {
    voids[0]!.status = status;
    await replacementBehindEarlier();
    await expect(sweepVoidedCombinedGroupInvoiceCover()).resolves.toMatchObject({ released: 0, releaseFailures: 0, failed: false });
    expect(mocks.tx.memberMoneyExportCoverageRelease.createMany).not.toHaveBeenCalled();
    expect(written.has(SUCCESSOR_KEY)).toBe(false);
  });

  it("reads only SUCCEEDED group-settlement VOIDs with an ended flag whose invoice has an unreleased combined manifest", async () => {
    await sweepVoidedCombinedGroupInvoiceCover();
    const { sql, values } = statement(mocks.$queryRaw.mock.calls[0]!);
    expect(sql).toMatch(/o\."status" = 'SUCCEEDED'/);
    expect(sql).toMatch(/o\."operationType" = 'UPDATE'/);
    expect(sql).toMatch(/o\."localModel" = 'GroupBookingSettlement'/);
    expect(sql).toMatch(/m\."settlementId" = o\."localId"/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "MemberMoneyExportCoverageRelease" r WHERE r\."manifestId" = m\."id"\)/);
    expect(sql).toMatch(/ORDER BY o\."createdAt" ASC, o\."id" ASC/);
    expect(values).toEqual(expect.arrayContaining(["COMBINED_GROUP_INVOICE", ...ENDED.map((flag) => JSON.stringify({ [flag]: true }))]));
  });

  it("keeps the invoice id verbatim in the VOID's key the statement joins on", () => {
    const settlementId = "c".repeat(25);
    const invoiceId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    for (const path of ["cancel", "abandon"] as const) {
      expect(groupSettlementInvoiceVoidKey(settlementId, invoiceId, path)).toContain(invoiceId);
    }
  });

  it("counts a release that failed as a failure, not a release", async () => {
    mocks.manifests.findMany.mockRejectedValue(new Error("down"));
    await expect(sweepVoidedCombinedGroupInvoiceCover()).resolves.toEqual({ checked: 1, released: 0, releaseFailures: 1, truncated: false, failed: false });
  });

  it("pages oldest VOID first by a keyset, stops at its cap and says so", async () => {
    const at = new Date("2026-06-30T00:00:00.000Z");
    const page = Array.from({ length: COMBINED_COVER_SWEEP_PAGE_SIZE }, (_, i) => ({ id: `v-${i}`, createdAt: at, settlementId: `s-${i}`, invoiceId: `i-${i}` }));
    mocks.$queryRaw.mockResolvedValue(page);
    const result = await sweepVoidedCombinedGroupInvoiceCover();
    expect(result).toMatchObject({ released: 0, truncated: true, failed: false });
    expect(mocks.$queryRaw).toHaveBeenCalledTimes(COMBINED_COVER_SWEEP_MAX_PAGES);
    const [first, second] = mocks.$queryRaw.mock.calls.map(statement);
    expect(first!.sql).not.toMatch(/o\."createdAt", o\."id"\) >/);
    expect(first!.values.at(-1)).toBe(COMBINED_COVER_SWEEP_PAGE_SIZE);
    expect(second!.text).toMatch(/AND \(o\."createdAt", o\."id"\) > \(\$\d+, \$\d+\)/);
    expect(second!.values.slice(-3)).toEqual([at, page.at(-1)!.id, COMBINED_COVER_SWEEP_PAGE_SIZE]);
  });

  it("never throws", async () => {
    mocks.$queryRaw.mockRejectedValue(new Error("down"));
    await expect(sweepVoidedCombinedGroupInvoiceCover()).resolves.toMatchObject({ failed: true });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it("treats a statement returning an unexpected shape as a failed read", async () => {
    mocks.$queryRaw.mockResolvedValue([{ id: "void-0", created_at: new Date() }]);
    await expect(sweepVoidedCombinedGroupInvoiceCover()).resolves.toMatchObject({ failed: true, released: 0 });
  });
});
