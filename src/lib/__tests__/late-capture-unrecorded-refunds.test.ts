import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4149 / #4170 / #4173: the late captures whose refund has no record yet, seen
 * from outside the recovery - what `charge.refunded` may do with one, the alert
 * for one refunded outside the app, and the nightly self-heal's own list.
 *
 * The once-ever claim is REAL here (`sendAdminAlertOnceEver` over an in-memory
 * `AlertCooldown` table), so "once" is the claim's own behaviour, not a mock's.
 */
const mocks = vi.hoisted(() => ({
  logAudit: vi.fn(),
  sendOutsideAppAlert: vi.fn(),
  landedAfter: vi.fn(),
  landedAfterMany: vi.fn(),
  findClosed: vi.fn(),
  superseded: vi.fn(),
  knownDoor: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
  paymentRefundFindMany: vi.fn(),
  auditLogFindMany: vi.fn(),
  cooldown: new Map<string, Date>(),
}));

vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email", () => ({
  sendAdminLateCaptureRefundedOutsideAppAlert: (...args: unknown[]) => mocks.sendOutsideAppAlert(...args),
}));
vi.mock("@/lib/club-format-settings", async () => {
  const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
  return { getClubFormat: async () => CLUB_FORMAT_TEST };
});
vi.mock("@/lib/late-capture-landed-after", () => ({
  readCaptureLandedAfterCancellation: (...args: unknown[]) => mocks.landedAfter(...args),
  findCapturesLandedAfterCancellation: (...args: unknown[]) => mocks.landedAfterMany(...args),
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findClosedLateCaptureRecords: (...args: unknown[]) => mocks.findClosed(...args),
}));
vi.mock("@/lib/late-capture-record-recovery", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/late-capture-record-recovery")),
  findSupersededRefundOnlyIntents: (...args: unknown[]) => mocks.superseded(...args),
  findIntentsWithKnownDoorRefund: (...args: unknown[]) => mocks.knownDoor(...args),
}));
vi.mock("@/lib/cancelled-booking-late-capture", () => ({
  lateCaptureDoubleRefundAlertKey: (paymentIntentId: string) => `late-capture-double-refund:${paymentIntentId}`,
  announceAutomaticLateCaptureRefund: vi.fn(),
  recordAutomaticLateCaptureRefund: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findUnique: (...args: unknown[]) => mocks.paymentFindUnique(...args) },
    paymentTransaction: { findUnique: (...args: unknown[]) => mocks.paymentTransactionFindUnique(...args) },
    paymentRefund: { findMany: (...args: unknown[]) => mocks.paymentRefundFindMany(...args) },
    auditLog: { findMany: (...args: unknown[]) => mocks.auditLogFindMany(...args) },
    booking: {
      findUnique: async () => ({
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        deletedAt: null,
        memberId: "member-1",
        member: { firstName: "Alice", lastName: "Example" },
        organisation: null,
      }),
    },
    // The once-ever claim's table, in memory: the real `claimAlertCooldown` runs against it.
    alertCooldown: {
      updateMany: async ({ where, data }: { where: { key: string; lastAlertedAt: { lt?: Date } | Date }; data: { lastAlertedAt: Date } }) => {
        const at = mocks.cooldown.get(where.key);
        const lt = (where.lastAlertedAt as { lt?: Date }).lt;
        const matches = at !== undefined && (lt ? at < lt : at.getTime() === (where.lastAlertedAt as Date).getTime());
        if (matches) mocks.cooldown.set(where.key, data.lastAlertedAt);
        return { count: matches ? 1 : 0 };
      },
      create: async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
        if (mocks.cooldown.has(data.key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        mocks.cooldown.set(data.key, data.lastAlertedAt);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string; lastAlertedAt: Date } }) => {
        const at = mocks.cooldown.get(where.key);
        if (at && at.getTime() === where.lastAlertedAt.getTime()) mocks.cooldown.delete(where.key);
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { key: { in: string[] }; lastAlertedAt: { gte: Date } } }) =>
        where.key.in
          .filter((key) => (mocks.cooldown.get(key)?.getTime() ?? -Infinity) >= where.lastAlertedAt.gte.getTime())
          .map((key) => ({ key, lastAlertedAt: mocks.cooldown.get(key)! })),
    },
  },
}));

import {
  findPaymentsWithUnrecordedLateCaptures,
  readUnrecordedLateCaptureRefund,
} from "@/lib/late-capture-unrecorded-refunds";
import { buildLateCaptureRefundMetadata, LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON } from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const INTENT = "pi_late";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const entriesOf = (action: string) =>
  mocks.logAudit.mock.calls
    .map(([entry]) => entry as { action: string; details: string })
    .filter((entry) => entry.action === action)
    .map((entry) => JSON.parse(entry.details) as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cooldown.clear();
  mocks.sendOutsideAppAlert.mockResolvedValue(undefined);
  mocks.findClosed.mockResolvedValue(new Map());
  mocks.superseded.mockResolvedValue(new Set());
  mocks.knownDoor.mockResolvedValue(new Set());
  mocks.auditLogFindMany.mockResolvedValue([]);
  mocks.landedAfterMany.mockImplementation(async (intents: string[]) => new Set(intents));
});

describe("readUnrecordedLateCaptureRefund — charge.refunded before the record (#4170)", () => {
  const ask = (refunds: { id?: string; metadata?: Record<string, string> | null }[]) =>
    readUnrecordedLateCaptureRefund({ paymentId: "payment-1", paymentIntentId: INTENT, refundedCents: 2500, refunds });

  beforeEach(() => {
    mocks.paymentFindUnique.mockResolvedValue({ bookingId: "booking-1", booking: { status: "CANCELLED" } });
    mocks.paymentTransactionFindUnique.mockResolvedValue({ paymentId: "payment-1", reason: null, refundedAmountCents: 4000 });
    mocks.landedAfter.mockResolvedValue(false);
  });

  it.each([
    ["the late-capture door's", buildLateCaptureRefundMetadata("booking-1")],
    ["the repair tool's", { bookingId: "booking-1", reason: LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON }],
  ])("waits for the record when a refund in the charge is %s for this booking", async (_label, metadata) => {
    mocks.landedAfter.mockResolvedValue(true);
    await expect(ask([{ id: "re_late_1", metadata }])).resolves.toBe("awaiting_record");
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.sendOutsideAppAlert).not.toHaveBeenCalled();
  });

  it("names a refund outside the app of a capture that landed after the cancel, alerts through its own unmuteable template once ever, and notes nothing", async () => {
    // A cancel claim on the intent: the dashboard refund came before the late success notice.
    mocks.landedAfter.mockResolvedValue(true);

    await expect(ask([{ id: "re_dashboard", metadata: {} }])).resolves.toBe("refunded_outside_the_app");
    // A second refund notice for the same capture names it again, but alerts nobody again.
    await expect(ask([{ id: "re_dashboard_2", metadata: {} }])).resolves.toBe("refunded_outside_the_app");

    expect(mocks.landedAfter).toHaveBeenCalledWith({ paymentIntentId: INTENT, reason: null });
    expect(entriesOf("booking.payment.late_capture_refunded_outside_app")).toEqual([
      { paymentIntentId: INTENT, refundIds: ["re_dashboard"], refundedCents: 2500, creditNoteQueued: false },
      { paymentIntentId: INTENT, refundIds: ["re_dashboard_2"], refundedCents: 2500, creditNoteQueued: false },
    ]);
    expect(mocks.sendOutsideAppAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendOutsideAppAlert).toHaveBeenCalledWith(
      // What was refunded OUTSIDE the app - this event's 2500, never the capture's whole 4000.
      expect.objectContaining({ memberName: "Alice Example", bookingId: "booking-1", paymentIntentId: INTENT, refundedCents: 2500 }),
      CLUB_FORMAT_TEST,
    );
    expect(mocks.cooldown.has(`late-capture-refunded-outside-app:${INTENT}`)).toBe(true);
  });

  it("gives the claim back when the send throws, so the next notice (or the nightly check) sends it", async () => {
    mocks.landedAfter.mockResolvedValue(true);
    mocks.sendOutsideAppAlert.mockRejectedValueOnce(new Error("mail provider down"));

    await ask([{ id: "re_dashboard", metadata: {} }]);
    expect(mocks.cooldown.has(`late-capture-refunded-outside-app:${INTENT}`)).toBe(false);
    await ask([{ id: "re_dashboard", metadata: {} }]);
    expect(mocks.sendOutsideAppAlert).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an ordinary refund of a capture with no landed-after evidence", "CANCELLED", { metadata: {} }, false],
    ["another door of the app's for this booking (a superseded-payment refund)", "CANCELLED", { metadata: { bookingId: "booking-1", reason: "zero_dollar_batch_modification_superseded" } }, true],
    ["another booking's door refund", "CANCELLED", { metadata: buildLateCaptureRefundMetadata("booking-2") }, false],
    ["a door refund on a booking that is not cancelled", "CONFIRMED", { metadata: buildLateCaptureRefundMetadata("booking-1") }, true],
  ])("leaves %s to the generic note", async (_label, status, refund, landed) => {
    mocks.paymentFindUnique.mockResolvedValueOnce({ bookingId: "booking-1", booking: { status } });
    mocks.landedAfter.mockResolvedValue(landed);
    await expect(ask([refund])).resolves.toBe("none");
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.sendOutsideAppAlert).not.toHaveBeenCalled();
  });
});

describe("findPaymentsWithUnrecordedLateCaptures — the self-heal's own list (#4149)", () => {
  const refund = (paymentId: string, intent: string, status = "succeeded", amountCents = 2500, createdAt = new Date("2026-06-25T00:00:00Z")) => ({
    paymentId,
    stripePaymentIntentId: intent,
    status,
    amountCents,
    createdAt,
    payment: { bookingId: `booking-${paymentId}` },
  });

  it("lists payments with a recorded refund of a capture that landed after the cancel and has no closed record", async () => {
    mocks.paymentRefundFindMany.mockResolvedValue([
      refund("late", "pi_late"),
      refund("recorded", "pi_recorded"),
      refund("cancel", "pi_cancel_refund"),
      refund("refused", "pi_refused", "failed"),
      refund("hand", "pi_hand"),
    ]);
    mocks.findClosed.mockResolvedValueOnce(new Map([["pi_recorded", "record"], ["pi_hand", "hand-completed"]]));
    mocks.landedAfterMany.mockImplementationOnce(async (intents: string[]) => new Set(intents.filter((i) => i !== "pi_cancel_refund")));

    await expect(findPaymentsWithUnrecordedLateCaptures(NOW)).resolves.toEqual(["late", "hand"]);

    expect(mocks.paymentRefundFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date("2026-06-01T00:00:00.000Z") },
          payment: { booking: { status: "CANCELLED" } },
        }),
      }),
    );
    // A refused refund was never cash; a recorded capture is asked nothing further.
    expect(mocks.findClosed).toHaveBeenCalledWith(["pi_late", "pi_recorded", "pi_cancel_refund", "pi_hand"]);
    expect(mocks.landedAfterMany).toHaveBeenCalledWith(["pi_late", "pi_cancel_refund", "pi_hand"]);
  });

  // #4383: a capture whose receipt recorded $50 of $80 and was refunded the
  // whole $80 has its record: the $30 above what was recorded is the
  // record-by-hand finding's, never a lost record for the self-heal to recover.
  it("never lists a recorded capture refunded above what its capped receipt recorded", async () => {
    mocks.paymentRefundFindMany.mockResolvedValue([refund("capped", "pi_capped", "succeeded", 8000)]);
    mocks.findClosed.mockResolvedValueOnce(new Map([["pi_capped", "record"]]));

    await expect(findPaymentsWithUnrecordedLateCaptures(NOW)).resolves.toEqual([]);
    expect(mocks.landedAfterMany).toHaveBeenCalledWith([]);
    expect(mocks.sendOutsideAppAlert).not.toHaveBeenCalled();
  });

  it("drops what can never resolve BEFORE the cut, so it cannot starve a capture that would", async () => {
    mocks.paymentRefundFindMany.mockResolvedValue([
      refund("superseded", "pi_superseded"),
      refund("escalated", "pi_escalated"),
      refund("outside", "pi_outside"),
      refund("late", "pi_late"),
    ]);
    // #4173: the superseded-payment refund made all of this capture's refunds.
    mocks.superseded.mockResolvedValueOnce(new Set(["pi_superseded"]));
    // #2774's escalation is claimed for this one.
    mocks.findClosed.mockResolvedValueOnce(new Map([["pi_escalated", "hand-completed"]]));
    mocks.cooldown.set("late-capture-double-refund:pi_escalated", NOW);
    // Named refunded outside the app, its alert claim held.
    mocks.auditLogFindMany.mockResolvedValueOnce([{ details: JSON.stringify({ paymentIntentId: "pi_outside" }) }]);
    mocks.cooldown.set("late-capture-refunded-outside-app:pi_outside", NOW);

    await expect(findPaymentsWithUnrecordedLateCaptures(NOW, 1)).resolves.toEqual(["late"]);
    expect(mocks.superseded).toHaveBeenCalledWith(
      new Map(["superseded", "escalated", "outside", "late"].map((id) => [`pi_${id}`, { refundedCents: 2500, bookingId: `booking-${id}` }])),
    );
    // Its claim held, the alert is not sent again.
    expect(mocks.sendOutsideAppAlert).not.toHaveBeenCalled();
  });

  it("raises the outside-the-app alert again when its claim is not held (a send that threw), and still does not list it", async () => {
    // A door refund of 5000 beside the 1800 refunded outside the app.
    mocks.paymentRefundFindMany.mockResolvedValue([refund("outside", "pi_outside", "succeeded", 6800)]);
    mocks.paymentTransactionFindUnique.mockResolvedValue({ refundedAmountCents: 6800 });
    const outsideEntry = { details: JSON.stringify({ paymentIntentId: "pi_outside", refundIds: ["re_dash"], refundedCents: 1800 }) };
    mocks.auditLogFindMany.mockResolvedValue([outsideEntry]);

    await expect(findPaymentsWithUnrecordedLateCaptures(NOW)).resolves.toEqual([]);
    expect(mocks.sendOutsideAppAlert).toHaveBeenCalledWith(
      // Only the cents named outside the app, never the door's 5000 beside them.
      expect.objectContaining({ bookingId: "booking-outside", paymentIntentId: "pi_outside", refundedCents: 1800 }),
      CLUB_FORMAT_TEST,
    );
    // Held now: the next night sends nothing.
    await findPaymentsWithUnrecordedLateCaptures(NOW);
    expect(mocks.sendOutsideAppAlert).toHaveBeenCalledTimes(1);
  });

  it("drops a hand-completed capture whose door-refund check already found none since its latest refund", async () => {
    mocks.paymentRefundFindMany.mockResolvedValue([refund("hand", "pi_hand"), refund("late", "pi_late")]);
    mocks.findClosed.mockResolvedValueOnce(new Map([["pi_hand", "hand-completed"]]));
    mocks.cooldown.set("late-capture-hand-completed-checked:pi_hand", new Date("2026-06-26T00:00:00Z"));

    await expect(findPaymentsWithUnrecordedLateCaptures(NOW)).resolves.toEqual(["late"]);
  });

  it("lists it again when a refund is recorded after that check: a later double payment is not hidden", async () => {
    mocks.paymentRefundFindMany.mockResolvedValue([
      refund("hand", "pi_hand"),
      refund("hand", "pi_hand", "succeeded", 2500, new Date("2026-06-27T00:00:00Z")),
    ]);
    mocks.findClosed.mockResolvedValueOnce(new Map([["pi_hand", "hand-completed"]]));
    mocks.cooldown.set("late-capture-hand-completed-checked:pi_hand", new Date("2026-06-26T00:00:00Z"));

    await expect(findPaymentsWithUnrecordedLateCaptures(NOW)).resolves.toEqual(["hand"]);
  });

  it("lists a hand-completed change payment even without landed-after evidence: the #2700 row is the evidence", async () => {
    mocks.paymentRefundFindMany.mockResolvedValue([refund("hand", "pi_hand")]);
    mocks.findClosed.mockResolvedValueOnce(new Map([["pi_hand", "hand-completed"]]));
    mocks.landedAfterMany.mockResolvedValueOnce(new Set());

    await expect(findPaymentsWithUnrecordedLateCaptures(NOW)).resolves.toEqual(["hand"]);
  });

  it("keeps listing a capture named outside the app when a door refund is known for it too", async () => {
    mocks.paymentRefundFindMany.mockResolvedValue([refund("outside", "pi_outside")]);
    mocks.auditLogFindMany.mockResolvedValueOnce([{ details: JSON.stringify({ paymentIntentId: "pi_outside" }) }]);
    mocks.cooldown.set("late-capture-refunded-outside-app:pi_outside", NOW);
    mocks.knownDoor.mockResolvedValueOnce(new Set(["pi_outside"]));

    await expect(findPaymentsWithUnrecordedLateCaptures(NOW)).resolves.toEqual(["outside"]);
  });

  it("asks nothing further when no refund is in the window", async () => {
    mocks.paymentRefundFindMany.mockResolvedValue([]);
    await expect(findPaymentsWithUnrecordedLateCaptures(NOW)).resolves.toEqual([]);
    expect(mocks.findClosed).not.toHaveBeenCalled();
  });
});
