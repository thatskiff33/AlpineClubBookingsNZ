import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  booking: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => vi.fn());
const reconcile = vi.hoisted(() => vi.fn());
const lodgeLock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/audit", () => ({ createAuditLog: audit }));
vi.mock("@/lib/capacity", () => ({ acquireLodgeCapacityLock: lodgeLock }));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: vi.fn(async () => "lodge") }));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({ reconcileBedAllocationsForBookingWithGlobalLockHeld: reconcile }));

import { recoverStaleSavedCardClaims, runSavedCardClaimRelease, releaseSavedCardChargeClaim } from "@/lib/saved-card-charge-claim";

const now = new Date("2026-07-01T00:00:00.000Z");
const marker = new Date("2026-06-30T23:00:00.000Z");
const range = { checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z") };
const context = { bookingId: "booking", lodgeId: "lodge" };
function booking(overrides: Record<string, unknown> = {}) {
  return { id: "booking", lodgeId: "lodge", status: "CONFIRMED", savedCardClaimAt: marker, ...range,
    payment: { source: "STRIPE", status: "PENDING", transactions: [] }, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (work) => work(db));
  db.booking.findMany.mockResolvedValue([booking()]);
  db.booking.findUnique.mockResolvedValue(booking());
  db.booking.updateMany.mockResolvedValue({ count: 1 });
  audit.mockResolvedValue(undefined);
});

describe("saved-card claim recovery", () => {
  it("releases a stranded claim with its marker as the elapsed hold and leaves the attempt ledger alone", async () => {
    expect(await recoverStaleSavedCardClaims(now)).toEqual({ recoveredBookingIds: ["booking"], failedBookingIds: [] });
    expect(db.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "booking", status: "CONFIRMED", savedCardClaimAt: marker },
      data: { status: "PENDING", nonMemberHoldUntil: marker, savedCardClaimAt: null },
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(lodgeLock.mock.invocationCallOrder[0]!);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "booking.saved_card_claim_recovered", category: "payment", severity: "critical", entityId: "booking",
      metadata: { lodgeId: "lodge", markerAgeMs: 60 * 60 * 1000 },
    }));
    expect(db.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "CONFIRMED",
        savedCardClaimAt: { lte: new Date("2026-06-30T23:30:00.000Z") },
        payment: { source: "STRIPE", status: "PENDING" },
      },
    }));
  });

  it.each([
    ["unmarked booking", { savedCardClaimAt: null }],
    ["live charge", { savedCardClaimAt: new Date("2026-06-30T23:59:00.000Z") }],
    ["webhook already paid", { status: "PAID" }],
    ["captured money awaiting promotion", { payment: { source: "STRIPE", status: "PENDING", transactions: [{ status: "SUCCEEDED" }] } }],
    ["bank transfer", { payment: { source: "INTERNET_BANKING", status: "PENDING", transactions: [] } }],
  ])("does not release a %s after the locked re-read", async (_name, overrides) => {
    db.booking.findUnique.mockResolvedValue(booking(overrides));
    await recoverStaleSavedCardClaims(now);
    expect(db.booking.updateMany).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("does nothing after a lost marker guard", async () => {
    db.booking.updateMany.mockResolvedValue({ count: 0 });
    await recoverStaleSavedCardClaims(now);
    expect(reconcile).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("counts a booking recovered even when its audit row cannot be written", async () => {
    audit.mockRejectedValue(new Error("audit offline"));
    expect(await recoverStaleSavedCardClaims(now)).toEqual({ recoveredBookingIds: ["booking"], failedBookingIds: [] });
  });

  it("continues after a failed booking and records the failure", async () => {
    db.booking.findMany.mockResolvedValue([booking(), booking({ id: "second" })]);
    db.$transaction.mockRejectedValueOnce(new Error("unavailable"));
    db.booking.findUnique.mockResolvedValue(booking({ id: "second" }));
    const result = await recoverStaleSavedCardClaims(now);
    expect(result.failedBookingIds).toEqual(["booking"]);
    expect(result.recoveredBookingIds).toEqual(["second"]);
  });
});

describe("saved-card claim compensation", () => {
  it.each(["P2028", "P2034"])("retries %s once with explicit budgets, then awaits a critical audit row", async (code) => {
    db.$transaction.mockRejectedValue({ code });
    const outcome = await runSavedCardClaimRelease(async () => ({ released: true }), context);
    expect(outcome.ok).toBe(false);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 5000, timeout: 10000 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "booking.saved_card_claim_release_failed", severity: "critical" }));
    expect(db.booking.updateMany).not.toHaveBeenCalled();
  });

  it("returns failure data even when the audit sink throws", async () => {
    db.$transaction.mockRejectedValue(new Error("offline"));
    audit.mockRejectedValue(new Error("audit offline"));
    expect(await runSavedCardClaimRelease(async () => ({ released: true }), context)).toEqual({ ok: false });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("keeps a webhook's PAID state when release loses the claim", async () => {
    db.booking.findUnique.mockResolvedValue({ status: "PAID" });
    const outcome = await runSavedCardClaimRelease((tx) => releaseSavedCardChargeClaim(tx, { bookingId: "booking", restoreHoldUntil: marker, previousRange: range }), context);
    expect(outcome).toEqual({ ok: true, value: { released: false, statusFound: "PAID" } });
    expect(db.booking.updateMany).not.toHaveBeenCalled();
  });
});
