/**
 * #4097 (`INV-PAY-129`): an own-card cancel's card refund shortfall is ONE
 * cancellation hand-back, keyed per booking, counted as owed while OPEN, and
 * marked for the money-to-settle card.
 *
 * MUTATION PROOF. Put the key prefix in the non-cancellation list and "a
 * cancellation's own hand-back" fails (its completion would then queue no
 * cancellation note and take lock(1)); raise on a covered plan and "nothing
 * owed" fails; drop the payload flag and the queue's sentence test fails.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("server-only", () => ({}));

import { raiseCancelCardShortfallHandBack, splitCardShortfall } from "@/lib/cancel-card-refund-shortfall";
import {
  cancelCardShortfallOccurrenceKey,
  isCancelCardShortfallTask,
  isNonCancellationHandBackTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
  openHandBackOwedCents,
} from "@/lib/manual-refund-task-settlement-rules";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const KEY = "cancel-card-shortfall:booking-1";
const CHECK_KEY = "cancel-card-shortfall:booking-1:check";

type Row = { id: string; status: string; amountCents: number | null };

/** A claim transaction: the payment's non-card headroom, and a task table keyed on `occurrenceKey`. */
function tx(nonCardHeadroomCents = 0, existing: Record<string, Row> = {}) {
  const rows: Record<string, Row> = { ...existing };
  return {
    rows,
    paymentTransaction: {
      findMany: vi.fn(async () => (nonCardHeadroomCents > 0 ? [{ id: "txn-bank", amountCents: nonCardHeadroomCents, refundedAmountCents: 0 }] : [])),
    },
    manualRefundTask: {
      createMany: vi.fn(async ({ data }: { data: Array<{ occurrenceKey: string; amountCents: number }> }) => {
        const row = data[0]!;
        if (rows[row.occurrenceKey]) return { count: 0 };
        rows[row.occurrenceKey] = { id: `task-${Object.keys(rows).length + 1}`, status: "OPEN", amountCents: row.amountCents };
        return { count: 1 };
      }),
      findUnique: vi.fn(async ({ where }: { where: { occurrenceKey: string } }) => rows[where.occurrenceKey] ?? null),
    },
  };
}

const raise = (store: ReturnType<typeof tx>, planned: number, due = 10_000) =>
  raiseCancelCardShortfallHandBack(store as never, {
    bookingId: "booking-1",
    paymentId: "payment-1",
    refundAmountCents: due,
    plannedCardRefundCents: planned,
    format: CLUB_FORMAT_TEST,
  });

describe("raising a cancel's card refund shortfall (#4097)", () => {
  it("the part the non-card charges hold is ONE bank task, keyed on the booking, ON CONFLICT DO NOTHING", async () => {
    const store = tx(4_000);
    expect(await raise(store, 6_000)).toEqual({ cardCents: 6_000, bank: { taskId: "task-1", cents: 4_000 }, check: null });
    expect(store.manualRefundTask.createMany).toHaveBeenCalledTimes(1);
    expect(store.manualRefundTask.createMany).toHaveBeenCalledWith({
      data: [
        {
          bookingId: "booking-1",
          paymentId: "payment-1",
          amountCents: 4_000,
          raisedAmountCents: 4_000,
          kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: KEY,
          reason:
            "Booking booking-1 cancelled - its card refund could carry only $60.00 of the $100.00 refund due. $40.00 of the rest is held by the payment's non-card charges: refund it to the member by bank transfer (#4097).",
        },
      ],
      skipDuplicates: true,
    });
  });

  it("MUTATION: what nothing holds is a task to CHECK, never one to pay outright", async () => {
    const store = tx(1_000);
    const raised = await raise(store, 6_000);
    expect(raised).toEqual({ cardCents: 6_000, bank: { taskId: "task-1", cents: 1_000 }, check: { taskId: "task-2", cents: 3_000 } });
    const checkCall = store.manualRefundTask.createMany.mock.calls[1]![0].data[0] as unknown as { occurrenceKey: string; reason: string };
    expect(checkCall.occurrenceKey).toBe(CHECK_KEY);
    expect(checkCall.reason).toBe(
      "Booking booking-1 cancelled - its card refund could carry only $60.00 of the $100.00 refund due. The payment's records show the remaining $30.00 already refunded, or nothing holds it. Check Stripe and the bank before paying; dismiss this with a note if it was refunded (#4097).",
    );
    expect(checkCall.reason).not.toMatch(/refund it to the member/);
  });

  it("a zero plan with nothing holding the money raises the whole refund to check", async () => {
    const store = tx(0);
    expect(await raise(store, 0)).toEqual({ cardCents: 0, bank: null, check: { taskId: "task-1", cents: 10_000 } });
  });

  it.each([
    ["the plan carries it all", 10_000],
    ["the plan carries more than is due", 12_000],
  ])("nothing owed when %s: no task", async (_label, planned) => {
    const store = tx(5_000);
    expect(await raise(store, planned)).toBeNull();
    expect(store.manualRefundTask.createMany).not.toHaveBeenCalled();
  });

  it("a replay that finds the same OPEN row at the same amount answers it", async () => {
    const store = tx(4_000, { [KEY]: { id: "task-first", status: "OPEN", amountCents: 4_000 } });
    expect(await raise(store, 6_000)).toEqual({ cardCents: 6_000, bank: { taskId: "task-first", cents: 4_000 }, check: null });
  });

  it.each([
    ["a closed row", { id: "task-first", status: "COMPLETED", amountCents: 4_000 }],
    ["a different amount", { id: "task-first", status: "OPEN", amountCents: 3_000 }],
  ])("MUTATION: a replay that finds %s throws, rolling the claim back", async (_label, row) => {
    await expect(raise(tx(4_000, { [KEY]: row }), 6_000)).rejects.toThrow(/already exists as/);
  });

  it("refuses, rolling the claim back, when the row cannot be read back", async () => {
    const store = tx(4_000);
    store.manualRefundTask.findUnique.mockResolvedValueOnce(null as unknown as Row);
    await expect(raise(store, 6_000)).rejects.toThrow(/was not written/);
  });

  it("splits by what the non-card charges hold (pure)", () => {
    expect(splitCardShortfall(4_000, 10_000)).toEqual({ bank: 4_000, check: 0 });
    expect(splitCardShortfall(4_000, 1_500)).toEqual({ bank: 1_500, check: 2_500 });
    expect(splitCardShortfall(4_000, 0)).toEqual({ bank: 0, check: 4_000 });
  });
});

describe("the shortfall task is a cancellation's own hand-back (#4097)", () => {
  const task = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: cancelCardShortfallOccurrenceKey("booking-1") } as const;

  it("is marked by its kind and key, and by nothing else", () => {
    expect(task.occurrenceKey).toBe(KEY);
    expect(isCancelCardShortfallTask(task)).toBe(true);
    expect(isCancelCardShortfallTask({ ...task, occurrenceKey: null })).toBe(false);
    expect(isCancelCardShortfallTask({ ...task, occurrenceKey: "refund-request-hand-back:r" })).toBe(false);
    expect(isCancelCardShortfallTask({ ...task, kind: "EDIT_FINANCIAL_REVIEW" })).toBe(false);
  });

  it("is never a non-cancellation hand-back: the readers of a cancellation's hand-backs keep it", () => {
    expect(isNonCancellationHandBackTask(task)).toBe(false);
    const excluded = NOT_NON_CANCELLATION_HAND_BACK_WHERE.OR[1]!.AND!.map((clause) => clause.NOT.occurrenceKey.startsWith);
    expect(excluded.some((prefix) => KEY.startsWith(prefix))).toBe(false);
  });

  it("counts as owed while OPEN, and not once closed", () => {
    const row = { ...task, amountCents: 4_000, partPaymentReviewPaymentId: null, reason: "Card refund shortfall (fixture)" };
    expect(openHandBackOwedCents([{ ...row, status: "OPEN" }])).toBe(4_000);
    expect(openHandBackOwedCents([{ ...row, status: "COMPLETED" }, { ...row, status: "DISMISSED" }])).toBe(0);
  });

  it("is marked for the money-to-settle card", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "task-1",
      bookingId: "booking-1",
      amountCents: 4_000,
      raisedAmountCents: 4_000,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      paymentId: "payment-1",
      payment: null,
      lateCaptureApprovalIntentId: null,
      partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null,
      partPaymentReviewXeroPaidCents: null,
      occurrenceKey: KEY,
      reviewContext: null,
      reason: "r",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: {
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        member: { firstName: "Ann", lastName: "Owner" },
        organisation: null,
        memberId: "ann",
        deletedAt: null,
        status: "CANCELLED",
        payment: null,
      },
    };
    const payload = toOpenManualRefundTaskPayload(row as never, null, []);
    expect(payload.cardShortfallHandBack).toBe(true);
    expect(payload.refundRequestHandBack).toBe(false);
    expect(payload.editRefundHandBack).toBe(false);
    expect(payload.cardShortfallCheck).toBe(false);
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: null } as never, null, []).cardShortfallHandBack).toBe(false);
    const check = toOpenManualRefundTaskPayload({ ...row, occurrenceKey: CHECK_KEY } as never, null, []);
    expect([check.cardShortfallHandBack, check.cardShortfallCheck]).toEqual([false, true]);
  });
});
