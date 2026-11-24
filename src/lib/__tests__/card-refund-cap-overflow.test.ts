import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4159 review round 2 (F2, `INV-PAY-135`): refund money a charge's refunded
 * total could not hold reaches the officers, once per charge and refund-row
 * total, through the payment recovery alert - never only the error log.
 */
type Task = {
  paymentId: string;
  bookingId?: string;
  kind: string;
  status: string;
  occurrenceKey: string | null;
  settlementDirection?: string | null;
  booking?: { payment: { source: string } };
};

/**
 * Round 4 (F1): a Prisma `where` evaluated against rows - equality, `startsWith`, `not`, null, NOT, AND, OR and a
 * nested relation (round 5) - so the
 * test reads which tasks the alert's read actually counts by their occurrence keys, never only the clause's shape.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Record<string, unknown>[]).some((each) => matches(row, each));
    if (key === "AND") return (condition as Record<string, unknown>[]).every((each) => matches(row, each));
    if (key === "NOT") return !matches(row, condition as Record<string, unknown>);
    const value = row[key];
    if (condition === null) return value === null;
    if (typeof condition === "object" && condition && "startsWith" in condition) {
      return typeof value === "string" && value.startsWith((condition as { startsWith: string }).startsWith);
    }
    if (typeof condition === "object" && condition && "not" in condition) return value !== undefined && value !== (condition as { not: unknown }).not;
    if (typeof condition === "object" && condition) return typeof value === "object" && value !== null && matches(value as Record<string, unknown>, condition as Record<string, unknown>);
    return (value ?? null) === condition;
  });
}

const doubles = vi.hoisted(() => ({
  findUnique: vi.fn(),
  tasks: [] as Task[],
  accountCredit: vi.fn(async () => 0),
  onceEver: vi.fn(async (args: { send: () => Promise<unknown> }) => {
    await args.send();
    return true;
  }),
  alertOfficers: vi.fn(async () => ({ sent: 1 })),
  storeOwed: vi.fn(async () => ({})),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentTransaction: { findUnique: doubles.findUnique },
    manualRefundTask: { count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => doubles.tasks.filter((task) => matches(task, where)).length) },
    // #5255: the alert is stored for the sweep, then settled once sent.
    alertCooldown: { create: doubles.storeOwed, deleteMany: vi.fn(async () => ({ count: 1 })) },
  },
}));
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({ accountCreditDispositionCents: doubles.accountCredit }));
vi.mock("@/lib/admin-alert-once", () => ({ sendAdminAlertOnceEver: doubles.onceEver, readOnceEverClaimState: async () => "none" }));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers: doubles.alertOfficers, NOBODY_ALERTED: { sent: 0 } }));
vi.mock("@/lib/club-format-server", async () => ({ clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST }));
vi.mock("@/lib/logger", () => ({ default: { error: doubles.error, warn: vi.fn(), info: vi.fn() } }));

import { alertCardRefundCapOverflow, cardRefundCapOverflowAlertKey } from "@/lib/card-refund-cap-overflow";
import {
  CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX,
  EDIT_REFUND_HAND_BACK_KEY_PREFIX,
  REFUND_REQUEST_HAND_BACK_KEY_PREFIX,
} from "@/lib/manual-refund-task-settlement-rules";

const OVERFLOW = { paymentId: "payment-1", paymentTransactionId: "txn-race", discardedCents: 5_000, recordedRefundCents: 5_000, countedRefundIds: ["re_b", "re_a"] };

describe("a card refund past its charge alerts the officers (#4159 F2, round 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.tasks = [];
    doubles.findUnique.mockResolvedValue({ stripePaymentIntentId: "pi_race", payment: { bookingId: "booking-1" } });
  });

  const task = (occurrenceKey: string | null, over: Partial<Task> = {}): Task => ({
    paymentId: "payment-1", bookingId: "booking-1", kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", occurrenceKey, settlementDirection: null,
    booking: { payment: { source: "STRIPE" } }, ...over,
  });
  /** Round 5 (2): a booking-change review completed on the booking. */
  const review = (source: string, settlementDirection: string | null) =>
    task(null, { kind: "EDIT_FINANCIAL_REVIEW", paymentId: "payment-1", settlementDirection, booking: { payment: { source } } });
  const messageSent = () => (doubles.alertOfficers.mock.calls[0] as unknown as [{ errorMessage: string }])[0].errorMessage;

  it.each([
    ["a cancellation's hand-back", task(null)],
    ["a card cancellation's shortfall part", task("cancel-card-shortfall:booking-1")],
    ["a card refund closed as Paid another way", task(`${CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX}op-1`)],
    ["an edit's refund hand-back", task(`${EDIT_REFUND_HAND_BACK_KEY_PREFIX}mod-1`)],
    ["an approved refund request's hand-back", task(`${REFUND_REQUEST_HAND_BACK_KEY_PREFIX}req-1`)],
    // Round 5 (2): an Internet Banking payment can still hold a card charge (`INV-PAY-102`: one refunded before the
    // switch, or a second instrument kept), so a review paid back by hand on it is money already back another way.
    ["a booking-change review paid back by hand on a non-card payment", review("INTERNET_BANKING", "REFUND_TO_MEMBER")],
    ["a review completed before #3170 stored a direction, paid back by hand", review("INTERNET_BANKING", null)],
  ])("MUTATION (round 4, F1): %s completed on the payment - says the member may have been paid twice", async (_label, row) => {
    doubles.tasks = [row];
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(true);
    expect(doubles.onceEver).toHaveBeenCalledWith(expect.objectContaining({ key: cardRefundCapOverflowAlertKey(OVERFLOW) }));
    // #5255: raised once, so the alert is stored for the sweep to re-send.
    expect(doubles.storeOwed).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: `once-ever-owed:${cardRefundCapOverflowAlertKey(OVERFLOW)}`,
        replayAlert: expect.objectContaining({ alert: expect.objectContaining({ kind: "payment-recovery", amountCents: 5_000 }) }),
      }),
    });
    expect(doubles.alertOfficers).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", amountCents: 5_000, paymentIntentId: "pi_race" }),
      expect.anything(),
    );
    expect(messageSent()).toMatch(/^A card refund took this booking's card charge past what was charged: \$50\.00 of refunds.*may have been paid back twice.*recover any overpayment/);
  });

  it("MUTATION (round 4, F1): account credit given back from the booking says the same", async () => {
    doubles.accountCredit.mockResolvedValueOnce(1_000);
    await alertCardRefundCapOverflow(OVERFLOW);
    expect(messageSent()).toMatch(/may have been paid back twice/);
  });

  it.each([
    ["no task at all", []],
    ["a hand-back still OPEN", [task(null, { status: "OPEN" })]],
    ["a completed hand-back on another payment", [task(null, { paymentId: "payment-2" })]],
    // Round 5 (2): a review on a card payment went back on the card - its refund rows explain it - and one that asked
    // the member to pay moved nothing back.
    ["a review refunded on the card", [review("STRIPE", "REFUND_TO_MEMBER")]],
    ["a review that charged the member", [review("INTERNET_BANKING", "CHARGE_TO_MEMBER")]],
    ["a review paid by hand on another booking", [{ ...review("INTERNET_BANKING", "REFUND_TO_MEMBER"), bookingId: "booking-2" }]],
  ])("CONTROL (round 4, F1): with %s and no credit, says the records drifted and never paid twice", async (_label, rows) => {
    doubles.tasks = rows as Task[];
    await alertCardRefundCapOverflow(OVERFLOW);
    expect(messageSent()).toContain("The charge's records already read it fully refunded with nothing on record behind it (record drift). Check the charge in Stripe");
    expect(messageSent()).not.toMatch(/twice/);
  });

  it("MUTATION (round 3, 4): keyed on the refunds the charge counts - the same set in any order is one alert; a new refund, even at the same total, is another", () => {
    const key = cardRefundCapOverflowAlertKey(OVERFLOW);
    expect(key).toMatch(/^card-refund-cap-overflow:txn-race:[0-9a-f]{24}$/);
    expect(cardRefundCapOverflowAlertKey({ ...OVERFLOW, countedRefundIds: ["re_a", "re_b"], discardedCents: 1 })).toBe(key);
    expect(cardRefundCapOverflowAlertKey({ ...OVERFLOW, countedRefundIds: ["re_a", "re_c"] })).not.toBe(key);
  });

  it("never throws: a charge with no booking, or a failing alert, is logged as an error", async () => {
    doubles.findUnique.mockResolvedValueOnce(null);
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(false);
    doubles.onceEver.mockRejectedValueOnce(new Error("mail down"));
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(false);
    expect(doubles.error).toHaveBeenCalledTimes(2);
  });
});
