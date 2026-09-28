import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingDefaultsFindUnique: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
  taskFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  taskCreate: vi.fn(),
  taskUpdate: vi.fn(),
  executeRaw: vi.fn(),
  logAudit: vi.fn(),
  claimAlertCooldown: vi.fn(),
  deferAlertCooldown: vi.fn(),
  releaseAlertCooldown: vi.fn(),
  sendHeldAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const manualRefundTask = {
    findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a),
    findFirst: (...a: unknown[]) => mocks.taskFindFirst(...a),
    create: (...a: unknown[]) => mocks.taskCreate(...a),
    update: (...a: unknown[]) => mocks.taskUpdate(...a),
  };
  return {
    prisma: {
      booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
      bookingDefaults: {
        findUnique: (...a: unknown[]) => mocks.bookingDefaultsFindUnique(...a),
      },
      paymentTransaction: {
        findUnique: (...a: unknown[]) => mocks.paymentTransactionFindUnique(...a),
      },
      manualRefundTask,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $executeRaw: mocks.executeRaw, manualRefundTask }),
    },
  };
});
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => mocks.logAudit(...a) }));
vi.mock("@/lib/alert-cooldown", () => ({
  ALERT_ONCE_EVER_WINDOW_MS: 36_500 * 86_400_000,
  ALERT_NOBODY_ELIGIBLE_RETRY_MS: 86_400_000,
  claimAlertCooldown: (...a: unknown[]) => mocks.claimAlertCooldown(...a),
  deferAlertCooldown: (...a: unknown[]) => mocks.deferAlertCooldown(...a),
  releaseAlertCooldown: (...a: unknown[]) => mocks.releaseAlertCooldown(...a),
}));
vi.mock("@/lib/email", () => ({
  sendAdminLateCaptureHeldAlert: (...a: unknown[]) => mocks.sendHeldAlert(...a),
}));
vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: async () => ({ currency: "NZD" }),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  heldLateCaptureReason,
  holdSupersededLateCaptureIfRequired,
} from "@/lib/late-capture-refund-hold";

/**
 * #3639 review F1: a change payment a cancel had marked for cancellation, which
 * captured anyway, reaches the SUPERSEDED hand-off (webhook hook or recovery
 * cron) before either late-capture handler. On a cancelled booking it must
 * follow the club's setting like every other late capture. Real hold code
 * against a mocked database; `payment-recovery.test.ts` pins what the hand-off
 * does with the answer.
 */
const OPERATION = {
  bookingId: "booking-9",
  paymentId: "payment-9",
  paymentIntentId: "pi_change_late",
  paymentTransactionId: "txn-9",
  amountCents: 2500,
};

/** `sendToAdmins`' result when one admin was sent the alert. */
const DELIVERED = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFindUnique.mockResolvedValue({
    status: "CANCELLED",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    member: { firstName: "Alice", lastName: "Example" },
    organisation: null,
  });
  mocks.claimAlertCooldown.mockResolvedValue(true);
  mocks.sendHeldAlert.mockResolvedValue(DELIVERED);
  mocks.deferAlertCooldown.mockResolvedValue(undefined);
  mocks.releaseAlertCooldown.mockResolvedValue(undefined);
  mocks.paymentTransactionFindUnique.mockResolvedValue({ kind: "ADDITIONAL" });
  mocks.bookingDefaultsFindUnique.mockResolvedValue(null);
  mocks.taskFindUnique.mockResolvedValue(null);
  mocks.taskFindFirst.mockResolvedValue(null);
  mocks.taskCreate.mockResolvedValue({ id: "task-held" });
});

describe("holdSupersededLateCaptureIfRequired", () => {
  it("refunds as before (answers false) for a club on automatic refunds, including one that never saved the setting", async () => {
    for (const saved of [null, { lateCaptureRefundNeedsApproval: false }]) {
      mocks.bookingDefaultsFindUnique.mockResolvedValue(saved);
      await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(false);
    }
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("holds a change payment on a CANCELLED booking as one marked approval task, and moves no money", async () => {
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ lateCaptureRefundNeedsApproval: true });

    await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(true);

    expect(mocks.executeRaw).toHaveBeenCalled();
    expect(mocks.taskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "booking-9",
        paymentId: "payment-9",
        amountCents: 2500,
        kind: "DELETED_BOOKING_LATE_CAPTURE",
        lateCaptureApprovalIntentId: "pi_change_late",
        status: "OPEN",
        reason: expect.stringContaining("A payment for a change to the booking"),
      }),
      select: { id: true },
    });
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.payment.late_capture_refund_held" }),
    );
  });

  it("never holds a superseded ask on a LIVE booking: that refund is not a late capture", async () => {
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ lateCaptureRefundNeedsApproval: true });
    mocks.bookingFindUnique.mockResolvedValue({ status: "CONFIRMED" });

    await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(false);
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("lets an existing task own the capture whatever the setting now says", async () => {
    mocks.taskFindUnique.mockResolvedValue({ id: "task-held", status: "DISMISSED" });

    await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(true);
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("marks the confirm route's open #2700 question instead of raising a second one", async () => {
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ lateCaptureRefundNeedsApproval: true });
    mocks.taskFindFirst.mockResolvedValue({ id: "task-2700" });

    await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(true);

    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: "task-2700" },
      // The kind in the same write: a pre-kind #2700 row carries NULL, and the
      // marker's CHECK allows only this kind (delta D5).
      data: {
        lateCaptureApprovalIntentId: "pi_change_late",
        kind: "DELETED_BOOKING_LATE_CAPTURE",
      },
    });
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("emails the finance alert once per payment, claim-guarded, naming the booking and the amount (delta D7)", async () => {
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ lateCaptureRefundNeedsApproval: true });

    await holdSupersededLateCaptureIfRequired(OPERATION);

    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "late-capture-held:pi_change_late" }),
    );
    expect(mocks.sendHeldAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendHeldAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Example",
        bookingId: "booking-9",
        amountCents: 2500,
      }),
      expect.anything(),
    );

    // A replay raises nothing and sends nothing: the task owns it now, and the
    // kept claim makes its re-announce a no-op.
    mocks.sendHeldAlert.mockClear();
    mocks.taskCreate.mockClear();
    mocks.claimAlertCooldown.mockResolvedValue(false);
    mocks.taskFindUnique.mockResolvedValue({ id: "task-held", status: "OPEN" });
    await holdSupersededLateCaptureIfRequired(OPERATION);
    expect(mocks.taskCreate).not.toHaveBeenCalled();
    expect(mocks.sendHeldAlert).not.toHaveBeenCalled();
  });

  it("#3635: an alert nobody received is held a day, and the next notice for the still-open task sends it", async () => {
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ lateCaptureRefundNeedsApproval: true });
    mocks.sendHeldAlert.mockResolvedValueOnce({
      deliveryAllowed: true,
      recipients: 0,
      sent: 0,
      queuedForRetry: 0,
      notDelivered: 0,
    });

    await holdSupersededLateCaptureIfRequired(OPERATION);
    expect(mocks.deferAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "late-capture-held:pi_change_late" }),
    );

    // The next Stripe notice (or cron pass) finds the OPEN task and announces
    // again; the claim is free once the day has passed.
    mocks.taskFindUnique.mockResolvedValue({ id: "task-held", status: "OPEN" });
    await holdSupersededLateCaptureIfRequired(OPERATION);
    expect(mocks.sendHeldAlert).toHaveBeenCalledTimes(2);
    expect(mocks.deferAlertCooldown).toHaveBeenCalledTimes(1);
  });

  it("#3635: a send that throws gives the claim back; a DECIDED task never re-announces", async () => {
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ lateCaptureRefundNeedsApproval: true });
    mocks.sendHeldAlert.mockRejectedValueOnce(new Error("smtp down"));
    await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(true);
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "late-capture-held:pi_change_late" }),
    );

    for (const status of ["COMPLETED", "DISMISSED"]) {
      mocks.claimAlertCooldown.mockClear();
      mocks.taskFindUnique.mockResolvedValue({ id: "task-held", status });
      await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(true);
      expect(mocks.claimAlertCooldown).not.toHaveBeenCalled();
    }
  });

  it("does not send when another instance already holds the claim, and never fails the hold over the mail", async () => {
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ lateCaptureRefundNeedsApproval: true });
    mocks.claimAlertCooldown.mockResolvedValueOnce(false);
    await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(true);
    expect(mocks.sendHeldAlert).not.toHaveBeenCalled();

    mocks.taskFindUnique.mockResolvedValue(null);
    mocks.sendHeldAlert.mockRejectedValueOnce(new Error("smtp down"));
    await expect(holdSupersededLateCaptureIfRequired(OPERATION)).resolves.toBe(true);
  });
});

describe("heldLateCaptureReason (review item 3)", () => {
  it("is true on BOTH app versions: not refunded, and do not mark it paid back unless the club returned the money", () => {
    const reason = heldLateCaptureReason({ ...OPERATION, captureKind: "primary" });
    expect(reason).toContain("has NOT been refunded");
    expect(reason).toContain("Do not mark it paid back unless the club has already returned the money itself");
    // No button the previous version lacks is named as "on this screen".
    expect(reason).not.toMatch(/from this screen/);
    expect(reason.length).toBeLessThanOrEqual(500);
  });
});
