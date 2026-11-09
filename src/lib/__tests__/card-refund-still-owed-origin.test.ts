/**
 * #4516 review M4: a "still owed" rest (`card_refund_still_owed_<record>`) is read as the row it was first owed on,
 * by every reader that decides something from that row: which late capture it refunds (`INV-PAY-110`'s Xero
 * routing), and whether a cancellation's card part is still moving (the shortfall guard). The Xero card-note cover
 * has its own witness in `card-refund-paid-another-way-xero.test.ts`; the debt the runner reserves against, in
 * `member-money-refunds.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findLateCapturePaymentIntents: async (intents: readonly string[]) => new Set(intents.filter((intent) => intent.startsWith("pi_late"))),
  readPaidAnotherWayLateCaptureXeroReceipt: vi.fn(),
}));
vi.mock("@/lib/payment-transactions", () => ({ lockPaymentForRefundedTotal: async () => undefined, isStripeTransaction: () => true }));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock("@/lib/capacity-race-refunded-total-correction", () => ({
  CAPACITY_RACE_XERO_SENTENCE: {},
  capacityRaceChargeForHandBack: vi.fn(),
  capacityRaceNothingToAllocateMessage: vi.fn(),
  noteMayCover: vi.fn(),
}));

import { CARD_SHORTFALL_CARD_STOPPED_MESSAGE, cardShortfallSettlement } from "@/lib/cancel-card-refund-shortfall-settle";
import { cardRefundStillOwedOrigin } from "@/lib/card-refund-still-owed-origin";
import { lateCaptureIntentOfCardRefundOperation } from "@/lib/late-capture-paid-another-way";
import { cancelCardShortfallOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";

type Op = { id: string; type: string; idempotencyKey: string; bookingId: string; paymentId: string; paymentIntentId: string; amountCents: number;
  status?: string; attempts?: number; nextRetryAt?: Date | null; lastError?: string | null };
const HAND_BACK = "CANCELLED_BOOKING_HAND_BACK";

/** Recovery rows and their "Paid another way" close records, as the database holds them. */
function store(operations: Op[], records: Array<{ id: string; occurrenceKey: string; kind?: string }>) {
  return {
    manualRefundTask: {
      findUnique: async ({ where }: { where: { id?: string } }) => {
        const record = records.find((r) => r.id === where.id);
        return record ? { kind: record.kind ?? HAND_BACK, occurrenceKey: record.occurrenceKey } : null;
      },
    },
    paymentRecoveryOperation: {
      findUnique: async ({ where }: { where: { id: string } }) => operations.find((o) => o.id === where.id) ?? null,
      findMany: async () => operations,
    },
    paymentTransaction: { findMany: async () => [] },
  };
}
const op = (id: string, idempotencyKey: string, extra: Partial<Op> = {}): Op =>
  ({ id, type: "REFUND_BOOKING_MODIFICATION", idempotencyKey, bookingId: "b-1", paymentId: "p-1", paymentIntentId: "pi_1", amountCents: 5_000, ...extra });
const closed = (recordId: string, operationId: string) => ({ id: recordId, occurrenceKey: `card-refund-paid-another-way:${operationId}:no-xero-note` });

describe("the row a still-owed rest was first owed on", () => {
  it("is followed back through each close; any other row has none; a missing link or a record of another kind names none", async () => {
    const operations = [op("op-1", "booking_cancel_refund_recovery_b-1"), op("op-2", "card_refund_still_owed_rec-1")];
    const records = [closed("rec-1", "op-1"), closed("rec-2", "op-2"), { ...closed("rec-3", "op-1"), kind: "EDIT_FINANCIAL_REVIEW" }];
    const db = store(operations, records) as never;
    expect((await cardRefundStillOwedOrigin(db, "card_refund_still_owed_rec-1"))?.id).toBe("op-1");
    expect((await cardRefundStillOwedOrigin(db, "card_refund_still_owed_rec-2"))?.id).toBe("op-1");
    expect(await cardRefundStillOwedOrigin(db, "booking_cancel_refund_recovery_b-1")).toBeNull();
    expect(await cardRefundStillOwedOrigin(db, "card_refund_still_owed_missing")).toBeNull();
    expect(await cardRefundStillOwedOrigin(db, "card_refund_still_owed_rec-3")).toBeNull();
  });

  it("refuses a chain no treasurer made by hand rather than walk it forever", async () => {
    const operations = [op("loop", "card_refund_still_owed_rec-loop")];
    expect(await cardRefundStillOwedOrigin(store(operations, [closed("rec-loop", "loop")]) as never, "card_refund_still_owed_rec-loop")).toBeNull();
  });
});

describe("a still-owed rest of a late capture's refund keeps INV-PAY-110's routing (review M4a)", () => {
  it("MUTATION: names the capture its origin refunds: an approval row's, or a failed-later row's on a late capture", async () => {
    const approval = op("op-approval", "late_capture_approval_refund_recovery_pi_late_1");
    const failedLater = op("op-failed", "card_refund_failed_later_re_9", { paymentIntentId: "pi_late_2" });
    const ordinary = op("op-cancel", "booking_cancel_refund_recovery_b-1");
    const db = store([approval, failedLater, ordinary], [closed("rec-a", "op-approval"), closed("rec-f", "op-failed"), closed("rec-c", "op-cancel")]) as never;
    expect(await lateCaptureIntentOfCardRefundOperation({ idempotencyKey: "card_refund_still_owed_rec-a", paymentIntentId: "pi_late_1" }, db)).toBe("pi_late_1");
    expect(await lateCaptureIntentOfCardRefundOperation({ idempotencyKey: "card_refund_still_owed_rec-f", paymentIntentId: "pi_late_2" }, db)).toBe("pi_late_2");
    expect(await lateCaptureIntentOfCardRefundOperation({ idempotencyKey: "card_refund_still_owed_rec-c", paymentIntentId: "pi_1" }, db)).toBeNull();
  });
});

describe("a cancellation's card shortfall waits on a still-owed rest of its card part (review M4c)", () => {
  const task = { id: "task-1", kind: HAND_BACK, occurrenceKey: cancelCardShortfallOccurrenceKey("b-1", "bank"), bookingId: "b-1", paymentId: "p-1", booking: { memberId: "m-1" } };
  const settle = (db: unknown) => cardShortfallSettlement(task, db as never, { amountCents: 1_000, actingMemberId: "officer", format: {} as never });
  const dead = { status: "PENDING", attempts: 5, nextRetryAt: null, lastError: "Still owed after the treasurer paid part of a card refund another way (#4516)." };

  it("MUTATION: the rest of the cancel's own row, still owed, is a card refund stopped: the settle refuses", async () => {
    const cancel = op("op-cancel", "booking_cancel_refund_recovery_b-1", { status: "SUCCEEDED", attempts: 1 });
    const rest = op("op-rest", "card_refund_still_owed_rec-1", dead);
    await expect(settle(store([cancel, rest], [closed("rec-1", "op-cancel")]))).rejects.toThrow(CARD_SHORTFALL_CARD_STOPPED_MESSAGE);
  });

  it("the rest of another door's row (an appeal's) is not the cancel's card part: the settle goes ahead", async () => {
    const appeal = op("op-appeal", "refund_request_refund_req-1", { status: "SUCCEEDED", attempts: 1 });
    const rest = op("op-rest", "card_refund_still_owed_rec-1", dead);
    await expect(settle(store([appeal, rest], [closed("rec-1", "op-appeal")]))).resolves.toEqual({ preferTransactionIds: [] });
  });
});
