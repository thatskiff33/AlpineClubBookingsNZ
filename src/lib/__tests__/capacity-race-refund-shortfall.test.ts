import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4125: the officers' once-ever alert for the part of a capacity-race charge
 * no card refund covers - what backs the booking page's "the club will be in
 * touch about the remaining $X". The once-ever rule is the real
 * `sendAdminAlertOnceEver`; its claim and the send are doubled.
 *
 * #4154 (`INV-PAY-135`): and the hand-back task to check that records the same
 * remainder, raised in the capacity void's claim.
 */
const doubles = vi.hoisted(() => ({
  claim: vi.fn(),
  alertOfficers: vi.fn(),
}));
vi.mock("@/lib/alert-cooldown", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/alert-cooldown")),
  claimAlertCooldown: doubles.claim,
  releaseAlertCooldown: vi.fn(async () => {}),
  deferAlertCooldown: vi.fn(async () => {}),
}));
vi.mock("@/lib/payment-recovery-alert", () => ({
  alertPaymentRecoveryOfficers: doubles.alertOfficers,
  NOBODY_ALERTED: { deliveryAllowed: true, recipients: 0, sent: 0, queuedForRetry: 0, notDelivered: 0 },
}));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: log }));
// The hand-back raiser's own module pulls these in; nothing here reaches them.
vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: vi.fn() }));
// #5255: the owed row the alert is stored in for the sweep.
const db = vi.hoisted(() => ({ fake: null as unknown as import("./helpers/alert-cooldown-fake").AlertCooldownFake }));
vi.mock("@/lib/prisma", async () => {
  const { createAlertCooldownFake } = await import("./helpers/alert-cooldown-fake");
  db.fake = createAlertCooldownFake();
  return { prisma: { alertCooldown: db.fake.delegate } };
});
vi.mock("server-only", () => ({}));
// #4516 (M4d review B): the part's R05 is the journal's (`member-money-hand-backs.test.ts`); here, that the raise asks for it.
const handBackDoor = vi.hoisted(() => ({ postHandBackObligation: vi.fn(async () => null) }));
vi.mock("@/lib/member-money/doors", () => handBackDoor);

import {
  alertCapacityRaceRefundShortfall,
  capacityRaceRefundShortfallAlertKey,
  capacityRaceRefundShortfallMessage,
  capacityRaceShortfallTaskReason,
  raiseCapacityRaceRefundShortfallTask,
} from "@/lib/capacity-race-refund-shortfall";
import { capacityRaceShortfallIntentId, capacityRaceShortfallOccurrenceKey } from "@/lib/capacity-race-shortfall-task-key";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { cancelCardShortfallOccurrenceKey, cancelCardShortfallPart, isCancelCardShortfallTask } from "@/lib/manual-refund-task-settlement-rules";

const SENT = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 };

describe("the capacity race's refund shortfall alert (#4125)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.fake.reset();
    doubles.claim.mockResolvedValue(true);
    doubles.alertOfficers.mockResolvedValue(SENT);
  });

  it("sends nothing when the plan covers the charge", async () => {
    expect(await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 10000 }, CLUB_FORMAT_TEST)).toBe(false);
    expect(doubles.claim).not.toHaveBeenCalled();
    expect(doubles.alertOfficers).not.toHaveBeenCalled();
  });

  it("MUTATION: a partial plan tells the officers the remainder, once ever on the booking", async () => {
    expect(await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST)).toBe(true);

    expect(doubles.claim).toHaveBeenCalledWith(expect.objectContaining({ key: capacityRaceRefundShortfallAlertKey("booking-1") }));
    expect(capacityRaceRefundShortfallAlertKey("booking-1")).toBe("capacity-race-refund-shortfall:booking-1");
    expect(doubles.alertOfficers).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentIntentId: "pi_1",
        amountCents: 2000,
        errorMessage: expect.stringContaining("only $80.00 of the $100.00 charge refundable"),
      }),
      CLUB_FORMAT_TEST,
    );
    expect(doubles.alertOfficers.mock.calls[0]?.[0]).toMatchObject({ errorMessage: expect.stringContaining("refund the member the $20.00 by hand") });
  });

  it("an empty plan tells them the whole charge", async () => {
    await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 0 }, CLUB_FORMAT_TEST);

    expect(doubles.alertOfficers).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10000, errorMessage: expect.stringContaining("nothing of the $100.00 charge refundable by card") }),
      CLUB_FORMAT_TEST,
    );
  });

  it("a claim already held (a redelivered webhook) sends nothing more", async () => {
    doubles.claim.mockResolvedValue(false);

    expect(await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST)).toBe(false);
    expect(doubles.alertOfficers).not.toHaveBeenCalled();
  });

  it("never throws when the send does, and leaves the alert stored for the sweep to re-send (#5255)", async () => {
    doubles.alertOfficers.mockRejectedValue(new Error("smtp down"));

    await expect(alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST)).resolves.toBe(false);
    expect(db.fake.rows.get("once-ever-owed:capacity-race-refund-shortfall:booking-1")?.replayAlert).toMatchObject({
      label: "capacity-race refund shortfall alert",
      alert: { kind: "payment-recovery", bookingId: "booking-1", paymentIntentId: "pi_1", amountCents: 2000, errorMessage: expect.stringContaining("refund the member the $20.00 by hand") },
    });
  });

  it("settles the stored alert once it is sent (#5255)", async () => {
    await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST);
    expect(db.fake.rows.size).toBe(0);
  });
});

type Row = { id: string; status: string; amountCents: number | null; kind: string; reason: string; paymentId: string; raisedAmountCents: number };

/** The capacity void's claim transaction: a task table keyed on `occurrenceKey`, as the unique index keeps it. */
function claimTx(existing: Record<string, Partial<Row>> = {}) {
  const rows: Record<string, Partial<Row>> = { ...existing };
  return {
    rows,
    manualRefundTask: {
      createMany: vi.fn(async ({ data, skipDuplicates }: { data: Array<Row & { occurrenceKey: string }>; skipDuplicates: boolean }) => {
        const row = data[0]!;
        if (rows[row.occurrenceKey]) {
          if (!skipDuplicates) throw new Error("unique violation");
          return { count: 0 };
        }
        rows[row.occurrenceKey] = { ...row, id: `task-${Object.keys(rows).length + 1}`, status: "OPEN" };
        return { count: 1 };
      }),
      findUnique: vi.fn(async ({ where }: { where: { occurrenceKey: string } }) => rows[where.occurrenceKey] ?? null),
    },
  };
}

const CHECK_KEY = "cancel-card-shortfall:booking-1:capacity-race:pi_1:check";
const raiseTask = (store: ReturnType<typeof claimTx>, plannedRefundCents: number, chargedCents = 10000) =>
  raiseCapacityRaceRefundShortfallTask(store as never, { bookingId: "booking-1", paymentId: "payment-1", paymentIntentId: "pi_1", chargedCents, plannedRefundCents, format: CLUB_FORMAT_TEST });

describe("the capacity race's refund shortfall task (#4154, INV-PAY-135)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("MUTATION: a partial plan raises ONE card shortfall part to CHECK for the remainder, keyed on the booking and the race's intent", async () => {
    const store = claimTx();

    expect(await raiseTask(store, 8000)).toBe(true);

    expect(capacityRaceShortfallOccurrenceKey("booking-1", "pi_1")).toBe(CHECK_KEY);
    expect(Object.keys(store.rows)).toEqual([CHECK_KEY]);
    const task = store.rows[CHECK_KEY]!;
    expect(task).toMatchObject({ status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", paymentId: "payment-1", amountCents: 2000, raisedAmountCents: 2000 });
    // The marker every completion, ledger, Xero and census reader asks: a part to check, never a bank-transfer part.
    expect(isCancelCardShortfallTask({ kind: task.kind!, occurrenceKey: CHECK_KEY })).toBe(true);
    expect(cancelCardShortfallPart({ kind: task.kind!, occurrenceKey: CHECK_KEY })).toBe("check");
    // The completion reads the race's intent back from it, and only on its own booking.
    expect(capacityRaceShortfallIntentId({ kind: task.kind!, occurrenceKey: CHECK_KEY, bookingId: "booking-1" })).toBe("pi_1");
    expect(capacityRaceShortfallIntentId({ kind: task.kind!, occurrenceKey: CHECK_KEY, bookingId: "booking" })).toBeNull();
    expect(capacityRaceShortfallIntentId({ kind: task.kind!, occurrenceKey: cancelCardShortfallOccurrenceKey("booking-1", "check"), bookingId: "booking-1" })).toBeNull();
    expect(capacityRaceShortfallIntentId({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: CHECK_KEY, bookingId: "booking-1" })).toBeNull();
    // The officer is told it is records drift to check first, and how to close it either way.
    expect(task.reason).toContain("only $80.00 of the $100.00 charge refundable");
    expect(task.reason).toContain("Check Stripe and the bank before paying; dismiss only once its refund is confirmed."); // #4516: a part to check keeps its dismissal (owner, 15 Nov 2026)
    // #4154 review (M3): mark first, then pay - one order on every officer surface.
    expect(task.reason).toContain("If it is owed, mark this paid back first, once the card refund has gone through, then pay it by bank transfer straight after the app accepts");
    expect(task.reason).not.toMatch(/pay it by bank transfer and mark/i);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("MUTATION (#4516 review B): with the void's journal context, the part's R05 posts beside it for its cents; without one, none", async () => {
    const store = claimTx();
    const journal = { inactive: "unusable-currency", detail: "a stand-in context; the door is a double here" } as const;
    expect(await raiseCapacityRaceRefundShortfallTask(store as never, { bookingId: "booking-1", paymentId: "payment-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000, format: CLUB_FORMAT_TEST, journal })).toBe(true);
    expect(handBackDoor.postHandBackObligation).toHaveBeenCalledExactlyOnceWith(store, journal, expect.objectContaining({
      bookingId: "booking-1", taskId: store.rows[CHECK_KEY]!.id, amountCents: 2000, debtorRead: "booking-row" }));

    vi.clearAllMocks();
    await raiseTask(claimTx(), 8000);
    expect(handBackDoor.postHandBackObligation).not.toHaveBeenCalled();
  });

  it("the reason fits its limit at its longest, so nothing is cut", () => {
    const most = 999_999_999;
    for (const planned of [0, most - 1]) {
      expect(capacityRaceShortfallTaskReason({ chargedCents: most, plannedRefundCents: planned }, CLUB_FORMAT_TEST).length).toBeLessThanOrEqual(MANUAL_REFUND_TASK_REASON_MAX);
    }
  });

  it("an empty plan raises the whole charge as the task", async () => {
    const store = claimTx();
    expect(await raiseTask(store, 0)).toBe(true);
    expect(store.rows[CHECK_KEY]).toMatchObject({ amountCents: 10000 });
    expect(store.rows[CHECK_KEY]!.reason).toContain("nothing of the $100.00 charge refundable by card");
  });

  it("MUTATION: raises nothing when the plan covers the charge", async () => {
    const store = claimTx();
    expect(await raiseTask(store, 10000)).toBe(false);
    expect(store.manualRefundTask.createMany).not.toHaveBeenCalled();
  });

  it("MUTATION: a second raise for the booking writes no second task, and its identical replay reads the one OPEN task", async () => {
    const store = claimTx();
    await raiseTask(store, 8000);
    expect(await raiseTask(store, 8000)).toBe(true);
    expect(store.manualRefundTask.createMany).toHaveBeenLastCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(Object.keys(store.rows)).toEqual([CHECK_KEY]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([
    ["already settled", { id: "task-old", status: "DISMISSED", amountCents: 2000 }],
    ["open for another amount", { id: "task-old", status: "OPEN", amountCents: 500 }],
  ])("MUTATION: a key the booking already holds, %s, never throws in the settle (the webhook must not wedge): it is logged and left", async (_label, existing) => {
    const store = claimTx({ [CHECK_KEY]: existing });

    await expect(raiseTask(store, 8000)).resolves.toBe(false);
    expect(store.rows[CHECK_KEY]).toEqual(existing);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "booking-1", taskId: "task-old" }), expect.stringContaining("already exists"));
  });

  it("MUTATION: the alert names the task to check once it is raised, and only then", () => {
    const raised = capacityRaceRefundShortfallMessage({ chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST, true);
    expect(raised).toContain("It is under Money to settle on the payments board, as a task to check");
    expect(raised).toContain("Once you have confirmed the card refund reached the member, dismiss the task with a note saying how."); // #4516 (owner, 15 Nov 2026)
    // #4154 review (M3, M4): mark first, then pay; and no Xero promise for a booking with no invoice.
    expect(raised).toContain("If it really is owed, mark the task paid back first, once the card refund has gone through: the app first checks it can record it");
    expect(raised).toContain("Pay the $20.00 by bank transfer straight after it accepts; if it refuses, follow what it says.");
    expect(raised).toContain("a booking with no Xero invoice to credit gets no note");
    expect(raised).not.toMatch(/refund it anyway|before you pay/);
    const none = capacityRaceRefundShortfallMessage({ chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST);
    expect(none).not.toContain("payments board");
    expect(none).toContain("refund the member the $20.00 by hand");
  });

  it("the once-ever alert carries the task's sentence when the settle raised it", async () => {
    doubles.claim.mockResolvedValue(true);
    doubles.alertOfficers.mockResolvedValue(SENT);

    await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000, taskRaised: true }, CLUB_FORMAT_TEST);

    expect(doubles.alertOfficers).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 2000, errorMessage: expect.stringContaining("task to check") }), CLUB_FORMAT_TEST);
  });
});
