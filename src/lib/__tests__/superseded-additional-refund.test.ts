import { BookingEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logAudit: vi.fn(),
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
  sendMemberEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminAlert: vi.fn().mockResolvedValue(undefined),
  findBooking: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/email/booking", () => ({
  sendSupersededPaymentRefundedEmail: mocks.sendMemberEmail,
}));
vi.mock("@/lib/email/admin-alerts-finance", () => ({
  sendAdminSupersededPaymentRefundAlert: mocks.sendAdminAlert,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: mocks.findBooking } },
}));

import { reportSupersededPaymentRefund } from "@/lib/superseded-additional-refund";
import {
  isSupersededAdditionalRefundEvent,
  SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND,
} from "@/lib/superseded-additional-refund-event";

/*
  #3340 acceptance criterion 5 — A LATE-CAPTURED SUPERSEDED INTENT THAT IS
  REFUNDED PRODUCES AN AUDIT ROW, A BOOKING EVENT, A MEMBER EMAIL AND AN ADMIN
  ALERT.

  Before this, the `REFUND_SUPERSEDED_PAYMENT` path recorded NOTHING. Stripe's own
  receipt was the only notice anybody got; the member in the live case wrote in
  asking what had happened, and that query is the only reason the money leak
  underneath was found at all.

  Frozen clock inherited; the fixtures carry fixed dates and no `Date.now()`.
*/

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/**
 * A booking whose ledger BALANCES, parameterised on the ask.
 *
 * `finalPriceCents` and the captured total move together with the ask, because
 * the figure under test is the booking's WHOLE outstanding (`INV-PAY-047`
 * rearranged) rather than the ask alone - and on a balanced ledger the two are
 * the same number, which is the property that keeps the ordinary case's member
 * email unchanged.
 */
function bookingRow(
  payment:
    | {
        additionalAmountCents: number;
        additionalPaymentStatus: string | null;
        finalPriceCents?: number;
        changeFeeCents?: number;
        amountCents?: number;
        refundedAmountCents?: number;
        creditAppliedCents?: number;
      }
    | null,
) {
  return {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    lodgeId: "lodge_1",
    // Price = captured + the uncollected ask, so the residual is zero.
    finalPriceCents:
      payment?.finalPriceCents ?? 13000 + (payment?.additionalAmountCents ?? 0),
    member: {
      id: "member_1",
      email: "member@example.test",
      firstName: "Ada",
      lastName: "Lovelace",
    },
    payment: payment
      ? {
          changeFeeCents: 0,
          amountCents: 13000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          ...payment,
        }
      : null,
  };
}

beforeEach(() => {
  mocks.logAudit.mockClear();
  mocks.recordBookingEvent.mockClear();
  mocks.sendMemberEmail.mockClear();
  mocks.sendAdminAlert.mockClear();
  mocks.findBooking.mockReset();
});

describe("reportSupersededPaymentRefund", () => {
  it("writes all four records, quoting one amount owing to everybody", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({ additionalAmountCents: 36500, additionalPaymentStatus: "PENDING" }),
    );

    await reportSupersededPaymentRefund({
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
    });

    const audit = mocks.logAudit.mock.calls[0][0];
    expect(audit.action).toBe("booking.payment.superseded_payment_refunded");
    expect(audit.category).toBe("payment");
    expect(JSON.parse(audit.details)).toMatchObject({
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
      amountOwingAfterRefundCents: 36500,
      refundSent: true,
    });

    const event = mocks.recordBookingEvent.mock.calls[0][0];
    expect(event.type).toBe(BookingEventType.REFUNDED);
    expect(event.amountCents).toBe(6500);
    expect(event.actorMemberId).toBeNull();
    expect(event.snapshot).toMatchObject({
      kind: SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND,
      supersededPaymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
      amountOwingAfterRefundCents: 36500,
    });

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_1",
        recipientMemberId: "member_1",
        email: "member@example.test",
        firstName: "Ada",
        refundedAmountCents: 6500,
        amountOwingCents: 36500,
      }),
    );

    expect(mocks.sendAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Ada Lovelace",
        refundedAmountCents: 6500,
        amountOwingCents: 36500,
        paymentIntentId: "pi_superseded",
        bookingId: "booking_1",
      }),
    );
  });

  it("reports nothing owing as a real answer, not as a missing one", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({ additionalAmountCents: 0, additionalPaymentStatus: null }),
    );

    await reportSupersededPaymentRefund({
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
    });

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountOwingCents: 0 }),
    );
  });

  /*
    #3340 fix round (money lens F4) - THE WHOLE OUTSTANDING, NOT JUST THE ASK.

    `REFUND_SUPERSEDED_PAYMENT` is not additional-only: the same processor
    handles the rows `queueSupersededPrimaryIntentCancellations` writes for the
    stale-tab protection (#1041 / #1161). A PAYMENT_PENDING booking edited from
    $130 to $195, whose stale tab confirms the $130 PRIMARY and has it refunded,
    carries no ask at all - and was told "Nothing further is owing on this
    booking" while the entire $195 was owed.
  */
  it("quotes the whole price when the refund was the booking's only payment", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        finalPriceCents: 19500,
        // The primary was captured and has just been refunded in full.
        amountCents: 13000,
        refundedAmountCents: 13000,
      }),
    );

    await reportSupersededPaymentRefund({
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 13000,
    });

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountOwingCents: 19500 }),
    );
    expect(mocks.sendAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ amountOwingCents: 19500 }),
    );
  });

  /*
    A policy-tiered reduction leaves the club holding more than the price
    (`INV-MOD-011`), which makes the identity's residual NEGATIVE. "The club owes
    you" is not a sentence this figure is allowed to imply - the refund it
    accompanies has its own amount - so it floors at zero.
  */
  it("never reports a negative amount owing when the club retains a slice", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        finalPriceCents: 10000,
        amountCents: 13000,
        refundedAmountCents: 0,
      }),
    );

    await reportSupersededPaymentRefund({
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
    });

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountOwingCents: 0 }),
    );
  });

  it("still records the refund, and escalates, when the booking cannot be read", async () => {
    mocks.findBooking.mockRejectedValue(new Error("database unavailable"));

    await reportSupersededPaymentRefund({
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
    });

    const actions = mocks.logAudit.mock.calls.map((call) => call[0].action);
    // The money movement is on the permanent record either way ...
    expect(actions).toContain("booking.payment.superseded_payment_refunded");
    // ... and the lost notice is its own critical row rather than a log line.
    expect(actions).toContain("booking.payment.superseded_refund_notice_failed");
    const escalation = mocks.logAudit.mock.calls.find(
      (call) => call[0].action === "booking.payment.superseded_refund_notice_failed",
    )![0];
    expect(escalation.severity).toBe("critical");
    expect(mocks.sendMemberEmail).not.toHaveBeenCalled();
  });

  it("never throws into the recovery worker when a provider fails", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({ additionalAmountCents: 0, additionalPaymentStatus: null }),
    );
    mocks.sendMemberEmail.mockRejectedValueOnce(new Error("SES is down"));
    mocks.sendAdminAlert.mockRejectedValueOnce(new Error("SES is down"));

    await expect(
      reportSupersededPaymentRefund({
        bookingId: "booking_1",
        paymentId: "payment_1",
        paymentIntentId: "pi_superseded",
        refundedAmountCents: 6500,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("the event never masquerades as a cancellation settlement", () => {
  it("is recognised by its discriminator, and an ordinary refund is not", () => {
    expect(
      isSupersededAdditionalRefundEvent({
        type: BookingEventType.REFUNDED,
        snapshot: { kind: SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND },
      }),
    ).toBe(true);
    expect(
      isSupersededAdditionalRefundEvent({
        type: BookingEventType.REFUNDED,
        snapshot: { policySummary: "50% within 7 days" },
      }),
    ).toBe(false);
    expect(
      isSupersededAdditionalRefundEvent({
        type: BookingEventType.CANCELLED,
        snapshot: { kind: SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND },
      }),
    ).toBe(false);
  });
});
