import { describe, expect, it, vi } from "vitest";

import {
  ADDITIONAL_PAYMENT_REMINDER_DAYS,
  CREDIT_RELEASE_CHASE_HORIZON_DAYS,
  CREDIT_RELEASE_REMINDER_COUNT,
  CREDIT_RELEASE_REMINDER_INTERVAL_DAYS,
  creditReleaseCadenceSummary,
  CREDIT_RELEASE_REMINDER_MIN_GAP_MS,
  creditReleaseReminderSlot,
  creditReleaseStampBoundary,
  resolveCreditReleaseChase,
  additionalPaymentFirstReminderDelayDays,
  ADDITIONAL_OWED_BOOKING_STATUSES,
  ADDITIONAL_PAYABLE_BOOKING_STATUSES,
  isAdditionalPayableBookingStatus,
  isAdditionalPaymentDoorOpenForBooking,
  isAdditionalPaymentOwed,
  isLateCaptureRefundedBookingStatus,
  payableAdditionalPaymentIntentId,
  resolveAdditionalPaymentChase,
  resolveAdditionalPaymentDoor,
} from "@/lib/additional-payment-chase";
import { CREDIT_RELEASE_ASK_REASON } from "@/lib/credit-release-ask-keys";
import { buildAdditionalOwedWhere } from "@/lib/unpaid-finished-stays";

/**
 * The shared brain of the additional-payment chase (#2350).
 *
 * Everything downstream — the admin queues, the bookings list chip, the booking
 * page panel, the finance figures, the reports summary, the reminder cron and
 * the manual re-send — asks this module the same two questions: is anything
 * owed, and is a reminder due. So the answers are pinned here, once.
 */

const PAYMENT = {
  additionalAmountCents: 21_000,
  additionalPaymentStatus: "PENDING" as string | null,
};

describe("isAdditionalPaymentOwed", () => {
  it("says yes for every uncollected state on a live booking", () => {
    for (const status of ["PENDING", "FAILED", null]) {
      expect(
        isAdditionalPaymentOwed({
          bookingStatus: "PAID",
          payment: { ...PAYMENT, additionalPaymentStatus: status },
        }),
      ).toBe(true);
    }
  });

  it("says no once the money has arrived, or when there is none to collect", () => {
    expect(
      isAdditionalPaymentOwed({
        bookingStatus: "PAID",
        payment: { ...PAYMENT, additionalPaymentStatus: "SUCCEEDED" },
      }),
    ).toBe(false);
    expect(
      isAdditionalPaymentOwed({
        bookingStatus: "PAID",
        payment: { ...PAYMENT, additionalAmountCents: 0 },
      }),
    ).toBe(false);
    expect(
      isAdditionalPaymentOwed({ bookingStatus: "PAID", payment: null }),
    ).toBe(false);
  });

  /*
    The finding this test exists for: cancelling a booking marks the additional
    intent FAILED (or leaves it PENDING where no intent was ever created) and
    NEVER zeroes additionalAmountCents. An amount-and-status-only test therefore
    reads every cancelled booking as still owing — and the chase would email its
    member a payment demand for money they do not owe.
  */
  it("says no on a booking whose lifecycle has ended the obligation", () => {
    for (const bookingStatus of [
      "CANCELLED",
      "BUMPED",
      "DRAFT",
      "PENDING",
      "PAYMENT_PENDING",
      "WAITLISTED",
      "AWAITING_REVIEW",
      null,
      undefined,
    ]) {
      expect(
        isAdditionalPaymentOwed({
          bookingStatus,
          payment: { ...PAYMENT, additionalPaymentStatus: "FAILED" },
        }),
      ).toBe(false);
    }
  });

  it("agrees with the SQL predicate it claims to be the twin of", () => {
    const where = buildAdditionalOwedWhere();

    // One status list, not two that have to be kept in step by hand.
    expect(where.status).toEqual({ in: [...ADDITIONAL_OWED_BOOKING_STATUSES] });
    for (const status of ADDITIONAL_OWED_BOOKING_STATUSES) {
      expect(
        isAdditionalPaymentOwed({ bookingStatus: status, payment: PAYMENT }),
      ).toBe(true);
    }
  });
});

/*
  The member-facing list is one status wider than the owed list, and the extra
  one is PAYMENT_PENDING — a booking that can genuinely carry a delta the member
  should be able to pay. What both lists refuse is the pair that decides whether
  money may move at all.
*/
describe("isAdditionalPayableBookingStatus", () => {
  it("covers every owed status, plus the one the owed list drops for counting", () => {
    for (const status of ADDITIONAL_OWED_BOOKING_STATUSES) {
      expect(isAdditionalPayableBookingStatus(status)).toBe(true);
    }
    expect(isAdditionalPayableBookingStatus("PAYMENT_PENDING")).toBe(true);
    expect([...ADDITIONAL_PAYABLE_BOOKING_STATUSES].sort()).toEqual(
      [...ADDITIONAL_OWED_BOOKING_STATUSES, "PAYMENT_PENDING"].sort(),
    );
  });

  it("refuses a booking the club has stopped counting", () => {
    for (const status of [
      "CANCELLED",
      "BUMPED",
      "DRAFT",
      "WAITLISTED",
      "WAITLIST_OFFERED",
      "AWAITING_REVIEW",
      "PENDING",
      null,
      undefined,
    ]) {
      expect(isAdditionalPayableBookingStatus(status)).toBe(false);
    }
  });
});

/*
  #3641 (`INV-PAY-104`): the member's pay door. The additional-payment-secret
  route and the Xero outbox reaper both ask it, so the reaper keeps a waiting
  invoice for exactly as long as the member can still pay the ask.
*/
describe("payableAdditionalPaymentIntentId", () => {
  const door = (
    overrides: Partial<{
      bookingStatus: string;
      bookingDeletedAt: Date | null;
      additionalPaymentIntentId: string | null;
      additionalPaymentStatus: string | null;
    }> = {},
  ) =>
    payableAdditionalPaymentIntentId({
      bookingStatus: overrides.bookingStatus ?? "CONFIRMED",
      bookingDeletedAt: overrides.bookingDeletedAt ?? null,
      payment: {
        additionalPaymentIntentId:
          overrides.additionalPaymentIntentId === undefined
            ? "pi_ask"
            : overrides.additionalPaymentIntentId,
        additionalPaymentStatus:
          overrides.additionalPaymentStatus === undefined
            ? "PENDING"
            : overrides.additionalPaymentStatus,
      },
    });

  it("hands out the ask while it is unpaid, declined included, on a payable booking", () => {
    for (const additionalPaymentStatus of ["PENDING", "FAILED", null]) {
      expect(door({ additionalPaymentStatus })).toBe("pi_ask");
    }
    expect(door({ bookingStatus: "PAYMENT_PENDING" })).toBe("pi_ask");
  });

  it("is closed once the ask is collected, withdrawn, or the booking can no longer take it", () => {
    expect(door({ additionalPaymentStatus: "SUCCEEDED" })).toBeNull();
    expect(door({ additionalPaymentIntentId: null })).toBeNull();
    expect(door({ bookingDeletedAt: new Date() })).toBeNull();
    expect(door({ bookingStatus: "CANCELLED" })).toBeNull();
    expect(door({ bookingStatus: "BUMPED" })).toBeNull();
    expect(
      payableAdditionalPaymentIntentId({
        bookingStatus: "CONFIRMED",
        bookingDeletedAt: null,
        payment: null,
      }),
    ).toBeNull();
  });
});

/**
 * #3641, `INV-PAY-104`: the whole pay door, Stripe's half included. The route
 * hands out a secret only on `payable`; the Xero reaper retires only on `closed`.
 */
describe("resolveAdditionalPaymentDoor", () => {
  const openInput = {
    bookingStatus: "CONFIRMED",
    bookingDeletedAt: null,
    payment: {
      additionalPaymentIntentId: "pi_ask",
      additionalPaymentStatus: "FAILED",
    },
  };

  it("is payable while Stripe still lets the intent be confirmed", async () => {
    for (const status of [
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
    ]) {
      const intent = { status, client_secret: "secret" };
      await expect(
        resolveAdditionalPaymentDoor(openInput, async () => intent),
      ).resolves.toEqual({ state: "payable", intent });
    }
  });

  it("is closed for an intent Stripe cancelled, though our rows read it as a decline", async () => {
    await expect(
      resolveAdditionalPaymentDoor(openInput, async () => ({ status: "canceled" })),
    ).resolves.toEqual({ state: "closed" });
  });

  it("is closed when Stripe has no such intent, and never asks Stripe when the local door is shut", async () => {
    const missing = Object.assign(new Error("No such payment_intent"), {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
    });
    await expect(
      resolveAdditionalPaymentDoor(openInput, async () => {
        throw missing;
      }),
    ).resolves.toEqual({ state: "closed" });

    const retrieve = vi.fn();
    await expect(
      resolveAdditionalPaymentDoor(
        { ...openInput, bookingStatus: "CANCELLED" },
        retrieve,
      ),
    ).resolves.toEqual({ state: "closed" });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("reports money Stripe has taken, or is taking, that our rows have not caught up with", async () => {
    for (const status of ["succeeded", "requires_capture", "processing"]) {
      const intent = { status };
      await expect(
        resolveAdditionalPaymentDoor(openInput, async () => intent),
      ).resolves.toEqual({ state: "captured-at-provider", intent });
    }
  });

  it("lets any other Stripe failure through, so no caller mistakes an outage for an answer", async () => {
    await expect(
      resolveAdditionalPaymentDoor(openInput, async () => {
        throw new Error("stripe unavailable");
      }),
    ).rejects.toThrow("stripe unavailable");
  });
});

describe("the booking half of the door, and which captures are refunded (#3641)", () => {
  it("opens only for a live booking in a payable lifecycle", () => {
    expect(
      isAdditionalPaymentDoorOpenForBooking({ bookingStatus: "PAID", bookingDeletedAt: null }),
    ).toBe(true);
    expect(
      isAdditionalPaymentDoorOpenForBooking({ bookingStatus: "PAID", bookingDeletedAt: new Date() }),
    ).toBe(false);
    expect(
      isAdditionalPaymentDoorOpenForBooking({ bookingStatus: "BUMPED", bookingDeletedAt: null }),
    ).toBe(false);
  });

  it("refunds a capture on a CANCELLED booking only; every other closed status keeps the money", () => {
    expect(isLateCaptureRefundedBookingStatus("CANCELLED")).toBe(true);
    for (const status of ["BUMPED", "AWAITING_REVIEW", "PENDING", "WAITLISTED", "CONFIRMED", null]) {
      expect(isLateCaptureRefundedBookingStatus(status)).toBe(false);
    }
  });
});

describe("resolveAdditionalPaymentChase", () => {
  const CUTOFF = new Date("2026-08-01T00:00:00.000Z");
  const AFTER_CUTOFF = new Date(CUTOFF.getTime() + 86_400_000);

  function chase(overrides: Record<string, unknown> = {}) {
    return resolveAdditionalPaymentChase({
      now: new Date(AFTER_CUTOFF.getTime() + 5 * 86_400_000),
      today: new Date(AFTER_CUTOFF.getTime() + 5 * 86_400_000),
      checkIn: new Date(AFTER_CUTOFF.getTime() + 30 * 86_400_000),
      checkOut: new Date(AFTER_CUTOFF.getTime() + 32 * 86_400_000),
      episodeStartedAt: AFTER_CUTOFF,
      reminderSentAt: null,
      finalReminderSentAt: null,
      chaseStartsAt: CUTOFF,
      ...overrides,
    });
  }

  it("sends the day-three nudge once the extra has been owing long enough", () => {
    expect(chase()).toBe("initial");
    expect(
      chase({ now: new Date(AFTER_CUTOFF.getTime() + 86_400_000) }),
    ).toBeNull();
  });

  it("sends a credit-release request's first email at once, and only once (#4253)", () => {
    const raisedJustNow = { now: AFTER_CUTOFF, today: AFTER_CUTOFF };
    expect(chase({ ...raisedJustNow })).toBeNull();
    expect(chase({ ...raisedJustNow, askReason: CREDIT_RELEASE_ASK_REASON })).toBe("initial");
    expect(
      chase({ ...raisedJustNow, askReason: CREDIT_RELEASE_ASK_REASON, reminderSentAt: AFTER_CUTOFF }),
    ).toBeNull();
    expect(additionalPaymentFirstReminderDelayDays(CREDIT_RELEASE_ASK_REASON)).toBe(0);
    expect(additionalPaymentFirstReminderDelayDays(null)).toBe(ADDITIONAL_PAYMENT_REMINDER_DAYS);
  });

  it("prefers the last-chance nudge inside the pre-arrival window", () => {
    const today = new Date(AFTER_CUTOFF.getTime() + 29 * 86_400_000);
    expect(chase({ now: today, today })).toBe("final");
  });

  /*
    The first-deploy guard. On the day this shipped, every already-outstanding
    delta was long past the day-3 threshold, so without this the first cron pass
    would have emailed the club's whole backlog at once — quoting, for legacy
    rows with no ADDITIONAL transaction, a "requested on" date it had to invent
    from the payment row's creation.
  */
  it("never chases an obligation raised before the chase existed", () => {
    const before = new Date(CUTOFF.getTime() - 86_400_000);
    expect(chase({ episodeStartedAt: before })).toBeNull();
    // Including the last-chance one, which is checked first.
    const today = new Date(AFTER_CUTOFF.getTime() + 29 * 86_400_000);
    expect(chase({ episodeStartedAt: before, now: today, today })).toBeNull();
    // And the guard is a floor, not a window: at the instant itself, it chases.
    expect(chase({ episodeStartedAt: CUTOFF })).toBe("initial");
  });

  /*
    The manual/automatic collision the cooldown constant used to only claim to
    prevent. An admin re-sends late on the NZ day BEFORE the pre-arrival window
    opens: that writes the day-N stamp only, because the final reminder is not
    due yet. Minutes later NZ midnight rolls the date, the window opens, and the
    next three-hourly tick finds the final stamp unset. Reading the stamps alone,
    it would send the near-identical last-chance email inside the hour.
  */
  it("will not land a reminder on top of a send from the last hour", () => {
    const today = new Date(AFTER_CUTOFF.getTime() + 29 * 86_400_000);
    const now = new Date(today.getTime() + 60_000);
    const manualSendAt = new Date(now.getTime() - 10 * 60_000);

    expect(
      chase({ now, today, reminderSentAt: manualSendAt }),
    ).toBeNull();

    // An hour later the last-chance email is due again, so the guard delays the
    // reminder rather than cancelling it.
    const later = new Date(manualSendAt.getTime() + 61 * 60_000);
    expect(chase({ now: later, today, reminderSentAt: manualSendAt })).toBe(
      "final",
    );
  });
});

describe("the credit-release request's repeating chase (#4253, INV-ADDPAY-048)", () => {
  const DAY = 86_400_000;
  const start = new Date("2026-07-01T00:00:00Z");
  const at = (days: number, hours = 0) => new Date(start.getTime() + days * DAY + hours * 3_600_000);
  const chaseStartsAt = new Date("2026-01-01T00:00:00Z");
  const due = (now: Date, reminderSentAt: Date | null) =>
    resolveCreditReleaseChase({ now, episodeStartedAt: start, reminderSentAt, chaseStartsAt });

  it("is four reminders a week apart, after the request email", () => {
    expect(CREDIT_RELEASE_REMINDER_COUNT).toBe(4);
    expect(CREDIT_RELEASE_REMINDER_INTERVAL_DAYS).toBe(7);
    // The last reminder is due on day 28; a finished stay is still read for a fortnight after it.
    expect(CREDIT_RELEASE_CHASE_HORIZON_DAYS).toBe(42);
  });

  it("sends the request at once, then one reminder a week up to day 28", () => {
    expect(due(at(0, 1), null)).toBe("initial");
    expect(due(at(3), at(0, 1))).toBeNull();
    expect(due(at(7), at(0, 1))).toBe("initial");
    expect(due(at(10), at(7, 1))).toBeNull();
    expect(due(at(14), at(7, 1))).toBe("initial");
    expect(due(at(21), at(14, 1))).toBe("initial");
    // D3: the fourth REMINDER, the fifth email.
    expect(due(at(28), at(21, 1))).toBe("initial");
  });

  it("sends five emails at most over a cron that runs every three hours, the last on day 28", () => {
    let stamp: Date | null = null;
    const sentOn: number[] = [];
    for (let hour = 0; hour <= 120 * 24; hour += 3) {
      const now = at(0, hour);
      if (due(now, stamp)) {
        stamp = now;
        sentOn.push(hour / 24);
      }
    }
    expect(sentOn).toEqual([0, 7, 14, 21, 28]);
  });

  it("stops after the fourth reminder, and leaves the rest to the officers' queues", () => {
    expect(due(at(28, 2), at(28, 1))).toBeNull();
    expect(due(at(35), at(28, 1))).toBeNull();
    expect(due(at(60), at(28, 1))).toBeNull();
    expect(due(at(400), at(29))).toBeNull();
  });

  it("sends ONE catch-up, not one for every missed week", () => {
    expect(due(at(15), at(0, 1))).toBe("initial");
    expect(due(at(15, 3), at(15, 1))).toBeNull();
  });

  it("never sends two reminders back to back around a week boundary (half an interval apart at least)", () => {
    // A late catch-up for week 1 at day 13.95, then the week-2 boundary hours later.
    const catchUp = at(13, 22.8);
    expect(due(catchUp, at(0, 1))).toBe("initial");
    expect(due(at(14, 3), catchUp)).toBeNull();
    expect(due(at(17), catchUp)).toBeNull();
    expect(due(at(17, 11), catchUp)).toBe("initial");
    expect(CREDIT_RELEASE_REMINDER_MIN_GAP_MS).toBe(3.5 * DAY);
  });

  it("does not hold the request email back for a stamp from an earlier request", () => {
    // An edit's reminder went out two days ago; the release request that superseded it starts now.
    expect(due(at(0, 2), new Date(start.getTime() - 2 * DAY))).toBe("initial");
  });

  it("counts a manual re-send as that week's reminder", () => {
    expect(due(at(8), at(7, 20))).toBeNull();
    expect(due(at(14), at(7, 20))).toBe("initial");
  });

  it("does not treat a stamp from an earlier request as a reminder for this one", () => {
    expect(due(at(0, 2), new Date(start.getTime() - DAY))).toBe("initial");
  });

  it("holds back an obligation older than the first-deploy cutover, and inside the re-send cooldown", () => {
    expect(
      resolveCreditReleaseChase({
        now: at(0, 1),
        episodeStartedAt: start,
        reminderSentAt: null,
        chaseStartsAt: new Date(start.getTime() + DAY),
      }),
    ).toBeNull();
    expect(due(at(7, 0.5), at(6, 23.9))).toBeNull();
  });

  it("is not stopped by the stay ending", () => {
    // The pure rule takes no check-out at all: the edit chase's stop (`checkOut <= today`) is not part of it.
    expect(due(at(14), null)).toBe("initial");
  });

  it("words the registry's cadence line from the same two numbers", () => {
    expect(creditReleaseCadenceSummary()).toContain("a reminder every 7 days, 4 reminders after the request");
  });

  it("names the slot and the stamp boundary the claim shares", () => {
    expect(creditReleaseReminderSlot({ now: at(0), episodeStartedAt: start })).toBe(0);
    expect(creditReleaseReminderSlot({ now: at(6.9), episodeStartedAt: start })).toBe(0);
    expect(creditReleaseReminderSlot({ now: at(7), episodeStartedAt: start })).toBe(1);
    expect(creditReleaseReminderSlot({ now: at(27.9), episodeStartedAt: start })).toBe(3);
    expect(creditReleaseReminderSlot({ now: at(28), episodeStartedAt: start })).toBe(4);
    expect(creditReleaseReminderSlot({ now: at(200), episodeStartedAt: start })).toBe(4);
    // Past the request email the boundary is the slot's start or half an interval ago, the earlier.
    expect(creditReleaseStampBoundary({ now: at(15), episodeStartedAt: start })).toEqual(at(11, 12));
    expect(creditReleaseStampBoundary({ now: at(20), episodeStartedAt: start })).toEqual(at(14));
    expect(creditReleaseStampBoundary({ now: at(2), episodeStartedAt: start })).toEqual(start);
  });
});
