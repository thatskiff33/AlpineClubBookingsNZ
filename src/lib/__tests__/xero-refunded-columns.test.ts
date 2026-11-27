import { beforeEach, describe, expect, it, vi } from "vitest";

// #4449 (`INV-SSOT`): the one step after the shared refunded-total decision
// that the inbound recount, the kept settle and the allocation write all take.
// Each caller's own suite pins that it calls this; this pins the step itself.

const mocks = vi.hoisted(() => ({ floor: vi.fn(), rows: vi.fn(), cap: vi.fn(), warn: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-inbound/credit-note-bank-transfer-floor", () => ({ bankTransferFloorCents: mocks.floor }));
vi.mock("@/lib/organiser-child-refund", () => ({ capCardRefundedTotalAtStripeRefunds: mocks.cap }));
vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: mocks.notify }));
// The status rule is the real one (`refundedTotalStatus`), reading the payment's rows on the caller's client.

import { decideXeroRefundedColumns, sendCardLedgerFloorAlert } from "@/lib/xero-inbound/xero-refunded-columns";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

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
  // Stripe backs whatever is proposed unless a case says otherwise.
  mocks.cap.mockImplementation(async (_store: unknown, _payment: unknown, proposedCents: number) => proposedCents);
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
    await expect(decide(1_000)).resolves.toEqual({ refundedAmountCents: 4_000, status: "PARTIALLY_REFUNDED", floorAlert: alert, cardFloorAlert: null });
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
    // A refunded status with nothing on the ledger: the raise-only floor keeps nothing, and the status stays.
    await expect(decide(0, { source: "STRIPE", refundedAmountCents: 0 })).resolves.toMatchObject({ refundedAmountCents: 0, status: null });
    expect(mocks.rows).not.toHaveBeenCalled();
  });

  describe("a card ledger is never lowered (#5289 E, owner decision D3, F5 #1353)", () => {
    const card = { source: "STRIPE", amountCents: 10_000, refundedAmountCents: 15_000, status: "REFUNDED" };

    it("MUTATION (clamp only Xero's figure): a card total stored above the amount stays, its divergence logged and its alert returned", async () => {
      const decided = await decide(15_000, card);
      expect(decided).toEqual({
        refundedAmountCents: 15_000,
        status: "REFUNDED",
        floorAlert: null,
        cardFloorAlert: { paymentId: "pay-1", creditNoteId: "cn-1", xeroDerivedCents: 10_000, ledgerCents: 15_000 },
      });
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "pay-1", localRefundedAmountCents: 15_000, xeroDerivedRefundedTotalCents: 10_000 }),
        expect.stringContaining("raise-only floor"),
      );
      // Returned, never sent here: the writer sends it after its commit.
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("MUTATION (raise-only): a lower Xero figure keeps the card ledger; a higher one raises it, with no alert", async () => {
      await expect(decide(2_000, { ...card, amountCents: 30_000, refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" })).resolves.toMatchObject({ refundedAmountCents: 5_000, cardFloorAlert: { xeroDerivedCents: 2_000, ledgerCents: 5_000 } });
      await expect(decide(8_000, { ...card, amountCents: 30_000, refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" })).resolves.toMatchObject({ refundedAmountCents: 8_000, cardFloorAlert: null });
    });

    it("MUTATION (#3653, #4444): any card total is capped at Stripe's refunds after the floor; a bank transfer is not", async () => {
      mocks.cap.mockResolvedValue(3_000);
      await expect(decide(8_000, { ...card, amountCents: 30_000, refundedAmountCents: 1_000, status: "PARTIALLY_REFUNDED" })).resolves.toMatchObject({ refundedAmountCents: 3_000 });
      expect(mocks.cap).toHaveBeenCalledWith(store, expect.objectContaining({ id: "pay-1" }), 8_000);
      mocks.cap.mockClear();
      await expect(decide(8_000)).resolves.toMatchObject({ refundedAmountCents: 8_000 });
      expect(mocks.cap).not.toHaveBeenCalled();
    });

    it("the floor's alert, sent by the writer, names the payment, both figures and #1353", async () => {
      await sendCardLedgerFloorAlert({ paymentId: "pay-1", creditNoteId: null, xeroDerivedCents: 10_000, ledgerCents: 15_000 }, CLUB_FORMAT_TEST);
      expect(mocks.notify).toHaveBeenCalledWith({
        errorType: "refund-ledger-divergence",
        operation: "inbound-credit-note-repair:recount:pay-1",
        errorMessage: expect.stringMatching(/payment pay-1 .*raise-only floor, #1353/),
      });
    });
  });
});
