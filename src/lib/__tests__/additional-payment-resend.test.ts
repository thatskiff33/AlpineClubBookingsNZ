import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin "Resend payment request email" action (#2350).
 *
 * This is a button that emails a member, handed to every Booking Officer, so the
 * tests here are about what stops it being abused or misread: it cannot fan out,
 * it shares one cooldown clock with the automatic chase, it refuses on a silenced
 * booking instead of silently withholding, and it gives the stamp back if the
 * send never happened.
 */

const {
  mockPrisma,
  mockSendAdditionalPaymentReminderEmail,
  mockReadBookingNoEmails,
  mockCreateAuditLog,
  mockLogger,
} = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findUnique: vi.fn() },
    payment: { updateMany: vi.fn(), findUnique: vi.fn() },
  },
  mockSendAdditionalPaymentReminderEmail: vi.fn(),
  mockReadBookingNoEmails: vi.fn(),
  mockCreateAuditLog: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/email", () => ({
  sendAdditionalPaymentReminderEmail: mockSendAdditionalPaymentReminderEmail,
}));
vi.mock("@/lib/booking-email-suppression", () => ({
  readBookingNoEmails: mockReadBookingNoEmails,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mockCreateAuditLog }));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import { resendAdditionalPaymentEmail } from "@/lib/additional-payment-resend-service";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const NOW = new Date("2026-10-10T22:00:00.000Z");
const RAISED_AT = new Date("2026-10-01T00:00:00.000Z");

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAID",
    checkIn: new Date("2026-11-01T00:00:00.000Z"),
    checkOut: new Date("2026-11-03T00:00:00.000Z"),
    deletedAt: null,
    lodgeId: "lodge-1",
    member: { email: "member@example.org", firstName: "Alice" },
    ...overrides,
    payment:
      overrides.payment === null
        ? null
        : {
            id: "payment-1",
            additionalAmountCents: 21_000,
            additionalPaymentStatus: "PENDING",
            additionalReminderSentAt: null,
            additionalFinalReminderSentAt: null,
            createdAt: new Date("2026-09-01T00:00:00.000Z"),
            transactions: [{ createdAt: RAISED_AT }],
            ...((overrides.payment as Record<string, unknown>) ?? {}),
          },
  };
}

async function resend() {
  return resendAdditionalPaymentEmail({
    bookingId: "booking-1",
    actorMemberId: "admin-1",
    now: NOW,
  });
}

describe("resendAdditionalPaymentEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.booking.findUnique.mockResolvedValue(booking());
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    // What a lost claim re-reads: unchanged unless a test says otherwise, so the
    // default explanation for a lost claim is "someone just emailed them".
    mockPrisma.payment.findUnique.mockResolvedValue({
      additionalAmountCents: 21_000,
      additionalPaymentStatus: "PENDING",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      booking: { status: "PAID" },
      transactions: [{ createdAt: RAISED_AT }],
    });
    mockReadBookingNoEmails.mockResolvedValue(false);
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "sent",
      emailLogId: "log-1",
      messageId: "msg-1",
    });
  });

  it("sends the same email the cron sends, stamps it, and audits the action", async () => {
    const result = await resend();

    expect(result).toMatchObject({ ok: true, additionalAmountCents: 21_000 });
    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledWith({
      bookingId: "booking-1",
      recipientMemberId: "member-1",
      email: "member@example.org",
      firstName: "Alice",
      additionalAmountCents: 21_000,
      checkIn: new Date("2026-11-01T00:00:00.000Z"),
      checkOut: new Date("2026-11-03T00:00:00.000Z"),
      requestedOn: RAISED_AT,
      lodgeId: "lodge-1",
    }, CLUB_FORMAT_TEST);
    // Writes the SAME stamp the automatic day-three nudge writes, which is what
    // stops the two arriving one after the other.
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { additionalReminderSentAt: NOW } }),
    );
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.additionalPayment.reminderResent",
        entityId: "booking-1",
        subjectMemberId: "member-1",
        outcome: "success",
      }),
    );
  });

  it("refuses when nothing is owed", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({ payment: { additionalPaymentStatus: "SUCCEEDED" } }),
    );

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  it("refuses on a booking with no payment row at all", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(booking({ payment: null }));

    expect(await resend()).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses on a deleted booking", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({ deletedAt: new Date("2026-10-02T00:00:00.000Z") }),
    );

    expect(await resend()).toMatchObject({ ok: false, status: 409 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  it("404s on an unknown booking", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(null);

    expect(await resend()).toMatchObject({ ok: false, status: 404 });
  });

  it("chases a FAILED charge just as it chases a pending one", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({ payment: { additionalPaymentStatus: "FAILED" } }),
    );

    expect(await resend()).toMatchObject({ ok: true });
  });

  it("refuses, rather than silently withholding, on a silenced booking", async () => {
    mockReadBookingNoEmails.mockResolvedValue(true);

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(
      result.ok === false ? result.error : "",
    ).toContain("No emails");
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when the no-emails switch cannot be read", async () => {
    mockReadBookingNoEmails.mockRejectedValue(new Error("database unavailable"));

    expect(await resend()).toMatchObject({ ok: false, status: 503 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  it("rate-limits a second send inside the cooldown", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalReminderSentAt: new Date("2026-10-10T21:30:00.000Z"),
        },
      }),
    );

    expect(await resend()).toMatchObject({ ok: false, status: 429 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("counts the automatic last-chance reminder against the same cooldown", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalFinalReminderSentAt: new Date("2026-10-10T21:30:00.000Z"),
        },
      }),
    );

    expect(await resend()).toMatchObject({ ok: false, status: 429 });
  });

  it("allows a re-send once the cooldown has passed", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalReminderSentAt: new Date("2026-10-10T20:30:00.000Z"),
        },
      }),
    );

    expect(await resend()).toMatchObject({ ok: true });
  });

  it("lets only one of two simultaneous clicks through", async () => {
    // The read said nothing had been sent; the guarded write disagrees, which is
    // exactly the race the claim exists to lose safely.
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    expect(await resend()).toMatchObject({ ok: false, status: 429 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  /*
    #2350 F1. Cancelling a booking leaves `additionalAmountCents` and a
    PENDING/FAILED status exactly where they were, so without the lifecycle half
    of the owed test this button would email a member "Payment Still Needed"
    about a booking they cancelled — the worst thing in the whole feature.
  */
  it("refuses to chase a member for a booking that is no longer live", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        status: "CANCELLED",
        payment: { additionalPaymentStatus: "FAILED" },
      }),
    );

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("re-states the whole owed test, the amount and the episode in the claim", async () => {
    await resend();

    const where = mockPrisma.payment.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe("payment-1");
    expect(where.AND).toContainEqual({
      additionalAmountCents: { gt: 0 },
      OR: [
        { additionalPaymentStatus: null },
        { additionalPaymentStatus: { not: "SUCCEEDED" } },
      ],
      booking: { is: { status: { in: ["CONFIRMED", "PAID", "COMPLETED"] } } },
    });
    expect(where.AND).toContainEqual({ additionalAmountCents: 21_000 });
    expect(where.AND).toContainEqual({
      transactions: {
        none: { kind: "ADDITIONAL", createdAt: { gt: RAISED_AT } },
      },
    });
  });

  /*
    #2350 F2. A lost claim is not automatically "wait an hour": the amount and
    the episode are fenced too. Telling an admin to wait when the figure on
    their screen is simply out of date sends them back to the same stale button.
  */
  it("says the amount changed, not to wait, when the delta moved under it", async () => {
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.payment.findUnique.mockResolvedValue({
      additionalAmountCents: 34_000,
      additionalPaymentStatus: "PENDING",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      booking: { status: "PAID" },
      transactions: [{ createdAt: new Date("2026-10-08T00:00:00.000Z") }],
    });

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false ? result.error : "").toContain(
      "outstanding amount changed",
    );
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  it("says nothing is owed when the money arrived during the send", async () => {
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.payment.findUnique.mockResolvedValue({
      additionalAmountCents: 21_000,
      additionalPaymentStatus: "SUCCEEDED",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      booking: { status: "PAID" },
      transactions: [{ createdAt: RAISED_AT }],
    });

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false ? result.error : "").toContain(
      "no longer has an outstanding additional payment",
    );
  });

  /*
    #2350 F3. Writing only the day-N stamp made the shared clock
    one-directional: an admin re-send inside the pre-arrival window was followed
    by the cron's near-identical last-chance email at the next three-hourly tick.
    A manual send now closes whichever reminder it stands in for.
  */
  it("closes the last-chance reminder too when that is the one now due", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        // Check-in is inside the two-day pre-arrival window for NOW.
        checkIn: new Date("2026-10-12T00:00:00.000Z"),
        checkOut: new Date("2026-10-14T00:00:00.000Z"),
      }),
    );

    expect(await resend()).toMatchObject({ ok: true });
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          additionalReminderSentAt: NOW,
          additionalFinalReminderSentAt: NOW,
        },
      }),
    );
  });

  it("leaves the last-chance reminder alone when it is not yet due", async () => {
    await resend();

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { additionalReminderSentAt: NOW } }),
    );
  });

  /*
    #2350: the mailer RETURNS rather than throws when it withholds a message.
    Reporting that as sent would spend the hour's cooldown on nothing and leave
    an admin believing a member was told.
  */
  it("does not report a withheld message as sent, and gives the stamp back", async () => {
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "withheld_for_booking",
      emailLogId: "log-1",
      bookingId: "booking-1",
      reason: "booking_no_emails",
    });

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false ? result.error : "").toContain("No emails");
    expect(mockPrisma.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: "payment-1", additionalReminderSentAt: NOW },
      data: { additionalReminderSentAt: null },
    });
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("explains a suppressed address rather than claiming a send", async () => {
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "suppressed",
      emailLogId: "log-1",
      emailSuppressionId: "sup-1",
      reason: "BOUNCE",
    });

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(result.ok === false ? result.error : "").toContain("bounce");
    // The admin is not rate-limited over a send that never happened.
    expect(mockPrisma.payment.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { additionalReminderSentAt: null },
      }),
    );
  });

  /*
    #2350 round 2. This is the ONE outcome that keeps the stamps, because the
    mailer left a FAILED EmailLog row the retry cron replays. The reply used to
    end "Please try again shortly" — advice the very next click would answer with
    a 429 for the rest of the hour, for a message that was already on its way. The
    copy and the behaviour have to say the same thing.
  */
  it("tells the admin the held-back message is queued rather than inviting a retry", async () => {
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "withheld_for_booking",
      emailLogId: "log-1",
      bookingId: "booking-1",
      reason: "booking_flag_unreadable",
    });

    const result = await resend();
    const error = result.ok === false ? result.error : "";

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(error).toContain("automatically");
    expect(error).not.toContain("try again");
    // One write only: the claim. The stamps deliberately stay spent.
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledTimes(1);
  });

  it("gives the stamp back when the send fails, so the automatic chase survives", async () => {
    mockSendAdditionalPaymentReminderEmail.mockRejectedValue(
      new Error("SES unavailable"),
    );

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(mockPrisma.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: "payment-1", additionalReminderSentAt: NOW },
      data: { additionalReminderSentAt: null },
    });
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});
