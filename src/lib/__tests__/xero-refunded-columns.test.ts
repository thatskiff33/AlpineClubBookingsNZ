import { beforeEach, describe, expect, it, vi } from "vitest";

// #4449 (`INV-SSOT`): the one step after the shared refunded-total decision
// that the inbound recount, the kept settle and the allocation write all take.
// Each caller's own suite pins that it calls this; this pins the step itself.

const mocks = vi.hoisted(() => ({ floor: vi.fn(), rows: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-inbound/credit-note-bank-transfer-floor", () => ({ bankTransferFloorCents: mocks.floor }));
// The status rule is the real one (`refundedTotalStatus`), reading the payment's rows on the caller's client.

import { decideXeroRefundedColumns } from "@/lib/xero-inbound/xero-refunded-columns";

const store = { paymentTransaction: { findMany: mocks.rows } } as never;
const pendingPrimary = [{ kind: "PRIMARY", status: "PENDING", createdAt: new Date("2026-06-01T00:00:00.000Z"), insertionSeq: 1 }];
const payment = (overrides: Record<string, unknown> = {}) => ({
  id: "pay-1",
  bookingId: "booking-1",
  source: "INTERNET_BANKING" as const,
  amountCents: 30_000,
  refundedAmountCents: 5_000,
  status: "PARTIALLY_REFUNDED" as const,
  booking: { organiserSettled: false },
  ...overrides,
});

function decide(decidedCents: number, overrides: Record<string, unknown> = {}, organiserSettled = false) {
  return decideXeroRefundedColumns(store, {
    payment: { ...payment(overrides), booking: { organiserSettled } } as never,
    decidedCents,
    creditNoteId: "cn-1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.floor.mockImplementation(async (_store: unknown, input: { xeroDerivedCents: number }) => ({ cents: input.xeroDerivedCents, alert: null }));
  // A captured receipt: a total falling to nothing returns the payment to SUCCEEDED.
  mocks.rows.mockResolvedValue([{ ...pendingPrimary[0], status: "SUCCEEDED" }]);
});

describe("decideXeroRefundedColumns (#4449)", () => {
  it("MUTATION (clamp): clamps to 0 and to the payment's amount before the floor", async () => {
    await expect(decide(-8_000)).resolves.toMatchObject({ refundedAmountCents: 0 });
    expect(mocks.floor).toHaveBeenLastCalledWith(store, expect.objectContaining({ xeroDerivedCents: 0, creditNoteId: "cn-1" }));
    await expect(decide(45_000)).resolves.toMatchObject({ refundedAmountCents: 30_000, status: "REFUNDED" });
  });

  it("MUTATION (floor): the bank-transfer floor's figure and alert are what it returns, on the caller's client", async () => {
    const alert = { paymentId: "pay-1", bookingId: "booking-1", creditNoteId: "cn-1", creditNoteNumber: null, xeroDerivedCents: 1_000, floorCents: 4_000 };
    mocks.floor.mockResolvedValueOnce({ cents: 4_000, alert });
    await expect(decide(1_000)).resolves.toEqual({ refundedAmountCents: 4_000, status: "PARTIALLY_REFUNDED", floorAlert: alert });
  });

  it("the status the total implies, from the status the writer leaves", async () => {
    await expect(decide(10_000, { status: "SUCCEEDED" })).resolves.toMatchObject({ status: "PARTIALLY_REFUNDED" });
    // Nothing refunded on a payment the writer leaves captured: no change.
    await expect(decide(0, { status: "SUCCEEDED", refundedAmountCents: 0 })).resolves.toMatchObject({ status: null });
  });

  it("MUTATION (#3979): a total falling to nothing on a payment never captured returns it to its uncaptured state", async () => {
    mocks.rows.mockResolvedValue(pendingPrimary);
    await expect(decide(0)).resolves.toMatchObject({ refundedAmountCents: 0, status: "PENDING" });
    expect(mocks.rows).toHaveBeenCalledWith(expect.objectContaining({ where: { paymentId: "pay-1" } }));
  });

  it("MUTATION (#3653): never for an organiser-settled child, whose mirror keeps SUCCEEDED", async () => {
    mocks.rows.mockResolvedValue(pendingPrimary);
    await expect(decide(0, {}, true)).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("MUTATION (F5, #1353): never un-refunds a card payment", async () => {
    await expect(decide(0, { source: "STRIPE" })).resolves.toMatchObject({ status: null });
    expect(mocks.rows).not.toHaveBeenCalled();
  });
});
