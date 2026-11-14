import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The officer's "send a fresh copy" action for the booking emails whose bodies
 * are never kept (`booking-confirmed`, `pre-arrival-reminder`,
 * `split-guest-payment-link`).
 *
 * What these pin: the copy goes to the booking's CURRENT owner and is rendered
 * from the booking as it is now; a send that did not go out never reads as sent
 * and writes no success audit row; superseded failures are archived only after
 * an actual send; and the payment link runs through the existing
 * revoke-and-remint workflow rather than a copy of it.
 */

const {
  mockPrisma,
  mockSendBookingConfirmedEmail,
  mockSendPreArrivalReminderEmail,
  mockReadBookingNoEmails,
  mockCreateAuditLog,
  mockLogger,
  mockArchiveSuperseded,
  mockFindUnarchived,
  mockIssueSplitGuestPaymentLink,
  mockProvisionalSummary,
} = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findUnique: vi.fn(), updateMany: vi.fn() },
    emailLog: { findFirst: vi.fn() },
  },
  mockSendBookingConfirmedEmail: vi.fn(),
  mockSendPreArrivalReminderEmail: vi.fn(),
  mockReadBookingNoEmails: vi.fn(),
  mockCreateAuditLog: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  mockArchiveSuperseded: vi.fn(),
  mockFindUnarchived: vi.fn(),
  mockIssueSplitGuestPaymentLink: vi.fn(),
  mockProvisionalSummary: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mockSendBookingConfirmedEmail,
  sendPreArrivalReminderEmail: mockSendPreArrivalReminderEmail,
}));
vi.mock("@/lib/booking-email-suppression", () => ({
  readBookingNoEmails: mockReadBookingNoEmails,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mockCreateAuditLog }));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));
vi.mock("@/lib/email-failure-review", () => ({
  EMAIL_FAILURE_MAX_ATTEMPTS: 3,
  archiveSupersededEmailFailures: mockArchiveSuperseded,
  findUnarchivedExhaustedBookingEmailFailures: mockFindUnarchived,
}));
vi.mock("@/lib/payment-link-split-guest", () => ({
  issueSplitGuestPaymentLink: mockIssueSplitGuestPaymentLink,
}));
vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary: mockProvisionalSummary,
}));
vi.mock("@/lib/club-format-server", async () => {
  const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
  return { clubFormatValues: vi.fn(async () => CLUB_FORMAT_TEST) };
});
vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: vi.fn(async () => "Pacific/Auckland"),
}));

import {
  describeUntransmittedFreshCopy,
  loadBookingFreshCopyOptions,
  sendBookingFreshEmailCopy,
} from "@/lib/booking-fresh-email-copy";

// The frozen test clock is 2026-07-01T00:00Z, which is 1 July in the club's zone;
// the daily reminder's window is therefore 1–4 July inclusive.
const ACTOR = "officer-1";

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    email: "owner@example.org",
    firstName: "Aroha",
    ...overrides,
  };
}

function confirmationBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    organisationId: null,
    organisation: null,
    member: member(),
    status: "PAID",
    deletedAt: null,
    lodgeId: "lodge-1",
    checkIn: new Date("2026-08-10T00:00:00.000Z"),
    checkOut: new Date("2026-08-12T00:00:00.000Z"),
    finalPriceCents: 24_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promoRedemptions: [],
    guests: [{ id: "g1" }, { id: "g2" }],
    payment: {
      status: "SUCCEEDED",
      source: "STRIPE",
      reference: null,
      xeroInvoiceId: null,
      changeFeeCents: null,
      additionalAmountCents: null,
      additionalPaymentStatus: null,
    },
    ...overrides,
  };
}

function reminderBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    organisationId: null,
    organisation: null,
    member: member(),
    status: "CONFIRMED",
    deletedAt: null,
    lodgeId: "lodge-1",
    checkIn: new Date("2026-07-03T00:00:00.000Z"),
    checkOut: new Date("2026-07-05T00:00:00.000Z"),
    expectedArrivalTime: null,
    preArrivalReminderSentAt: null,
    guests: [{ id: "g1" }],
    payment: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadBookingNoEmails.mockResolvedValue(false);
  mockPrisma.emailLog.findFirst.mockResolvedValue(null);
  mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
  mockArchiveSuperseded.mockResolvedValue([]);
  mockFindUnarchived.mockResolvedValue([]);
  mockProvisionalSummary.mockResolvedValue(null);
  mockCreateAuditLog.mockResolvedValue(undefined);
});

describe("fresh-copy eligibility", () => {
  it.each([
    ["booking-confirmed", null, 404],
    ["pre-arrival-reminder", null, 404],
    ["split-guest-payment-link", null, 404],
    ["booking-confirmed", confirmationBooking({ deletedAt: new Date() }), 409],
    ["pre-arrival-reminder", reminderBooking({ deletedAt: new Date() }), 409],
    ["split-guest-payment-link", { deletedAt: new Date() }, 409],
    ["booking-confirmed", confirmationBooking({ member: member({ email: "" }) }), 409],
    ["pre-arrival-reminder", reminderBooking({ member: member({ email: "" }) }), 409],
    ["pre-arrival-reminder", reminderBooking({ status: "CANCELLED" }), 409],
  ] as const)("refuses ineligible %s without a send or success audit", async (template, booking, status) => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(booking);
    const result = await sendBookingFreshEmailCopy({ bookingId: "booking-1", template, actorMemberId: ACTOR });
    expect(result).toMatchObject({ ok: false, status });
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(mockSendPreArrivalReminderEmail).not.toHaveBeenCalled();
    expect(mockIssueSplitGuestPaymentLink).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
    expect(mockArchiveSuperseded).not.toHaveBeenCalled();
  });
});

describe("fresh booking confirmation", () => {
  it("renders from the current booking, sends to the current owner, then archives and audits", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(confirmationBooking());
    mockSendBookingConfirmedEmail.mockResolvedValue({ status: "sent", emailLogId: "new-confirmation" });
    mockArchiveSuperseded.mockResolvedValue(["log-1", "log-2"]);

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(result).toEqual({
      ok: true,
      template: "booking-confirmed",
      sentTo: "owner@example.org",
      archivedFailureCount: 2,
      warning: null,
    });
    const [context, to, firstName, checkIn, , guestCount, worth, , options] =
      mockSendBookingConfirmedEmail.mock.calls[0];
    expect(context).toEqual({ bookingId: "booking-1", recipientMemberId: "member-1" });
    expect(to).toBe("owner@example.org");
    expect(firstName).toBe("Aroha");
    expect(checkIn).toEqual(new Date("2026-08-10T00:00:00.000Z"));
    expect(guestCount).toBe(2);
    expect(worth).toBe(24_000);
    expect(options).toEqual({ lodgeId: "lodge-1" });

    expect(mockArchiveSuperseded).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        templateName: "booking-confirmed",
        reviewedByMemberId: ACTOR,
      }),
    );
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.email.freshCopySent",
        category: "communication",
        targetId: "booking-1",
        actorMemberId: ACTOR,
        metadata: expect.objectContaining({
          templateName: "booking-confirmed",
          recipientMemberId: "member-1",
          emailLogId: "new-confirmation",
          archivedEmailFailureIds: ["log-1", "log-2"],
        }),
      }),
    );
  });

  it("reports delivery honestly when writing the audit fails after sending", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(confirmationBooking());
    mockSendBookingConfirmedEmail.mockResolvedValue({ status: "sent", emailLogId: "new-confirmation" });
    mockCreateAuditLog.mockRejectedValueOnce(new Error("audit unavailable"));

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1", template: "booking-confirmed", actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: true, sentTo: "owner@example.org" });
    expect(result.ok && result.warning).toMatch(/email was sent, but its audit record/);
    expect(mockSendBookingConfirmedEmail).toHaveBeenCalledOnce();
  });

  it("addresses an organisation booking to the organisation's contact", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(
      confirmationBooking({
        memberId: null,
        member: null,
        organisationId: "org-1",
        organisation: { name: "Tokoroa High School", email: "office@school.example" },
      }),
    );
    mockSendBookingConfirmedEmail.mockResolvedValue({ status: "sent", emailLogId: "new-confirmation" });

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: true, sentTo: "office@school.example" });
    expect(mockSendBookingConfirmedEmail.mock.calls[0][0]).toEqual({
      bookingId: "booking-1",
      recipientMemberId: null,
    });
    expect(mockSendBookingConfirmedEmail.mock.calls[0][1]).toBe("office@school.example");
  });

  it("says what is owing on a confirmed but unpaid internet-banking booking", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(
      confirmationBooking({
        status: "CONFIRMED",
        payment: {
          status: "PENDING",
          source: "INTERNET_BANKING",
          reference: "BK-<1>",
          xeroInvoiceId: "inv-1",
          changeFeeCents: null,
          additionalAmountCents: null,
          additionalPaymentStatus: null,
        },
      }),
    );
    mockSendBookingConfirmedEmail.mockResolvedValue({ status: "sent", emailLogId: "new-confirmation" });

    await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(mockSendBookingConfirmedEmail.mock.calls[0][8]).toEqual({
      lodgeId: "lodge-1",
      paymentDue: { reference: "BK-&lt;1&gt;", invoiceEmailed: true },
    });
  });

  it("offers online payment on a confirmed but unpaid card booking", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(
      confirmationBooking({ status: "CONFIRMED", payment: null }),
    );
    mockSendBookingConfirmedEmail.mockResolvedValue({ status: "sent", emailLogId: "new-confirmation" });

    await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(mockSendBookingConfirmedEmail.mock.calls[0][8]).toEqual({
      lodgeId: "lodge-1",
      paymentDue: { payOnline: true },
    });
  });

  it.each([
    [{ status: "withheld_for_booking", reason: "booking_no_emails" }, 409, /No emails/],
    [{ status: "withheld_for_environment", reason: "environment_non_production" }, 409, /not the club's live site/],
    [{ status: "suppressed" }, 422, /suppression list/],
    [{ status: "skipped_placeholder_recipient" }, 422, /no deliverable email address/],
  ])("never reads %o as sent: no audit row and nothing archived", async (outcome, status, message) => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(confirmationBooking());
    mockSendBookingConfirmedEmail.mockResolvedValue(outcome);

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: false, status });
    expect(result.ok ? "" : result.error).toMatch(message);
    expect(result.ok ? "" : result.error).not.toMatch(/\bsent to\b/i);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
    expect(mockArchiveSuperseded).not.toHaveBeenCalled();
  });

  it("refuses on a booking with No emails on, before rendering anything", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(confirmationBooking());
    mockReadBookingNoEmails.mockResolvedValue(true);

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  it("fails closed when the No emails switch cannot be read", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(confirmationBooking());
    mockReadBookingNoEmails.mockRejectedValue(new Error("db down"));

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  it("refuses a second copy sent within two minutes", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(confirmationBooking());
    mockPrisma.emailLog.findFirst.mockResolvedValue({ id: "log-recent" });

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "CANCELLED", "WAITLISTED"])(
    "refuses a %s booking: it has no confirmation to send",
    async (status) => {
      mockPrisma.booking.findUnique.mockResolvedValueOnce(confirmationBooking({ status }));

      const result = await sendBookingFreshEmailCopy({
        bookingId: "booking-1",
        template: "booking-confirmed",
        actorMemberId: ACTOR,
      });

      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
    },
  );

  it("still reports the send when archiving the old failures throws", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(confirmationBooking());
    mockSendBookingConfirmedEmail.mockResolvedValue({ status: "sent", emailLogId: "new-confirmation" });
    mockArchiveSuperseded.mockRejectedValue(new Error("audit write failed"));

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "booking-confirmed",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: true, archivedFailureCount: 0 });
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
  });
});

describe("fresh pre-arrival reminder", () => {
  it("inside the daily window, stamps the reminder so the job does not send a second", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(reminderBooking());
    mockSendPreArrivalReminderEmail.mockResolvedValue({ status: "sent" });

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "pre-arrival-reminder",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: true, sentTo: "owner@example.org" });
    expect(mockSendPreArrivalReminderEmail.mock.calls[0][0]).toMatchObject({
      bookingId: "booking-1",
      recipientMemberId: "member-1",
      email: "owner@example.org",
      guestCount: 1,
      lodgeId: "lodge-1",
    });
    expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", preArrivalReminderSentAt: null },
      data: { preArrivalReminderSentAt: expect.any(Date) },
    });
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
  });

  it("outside the window, leaves the stamp so the job still reminds them later", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(
      reminderBooking({
        checkIn: new Date("2026-08-10T00:00:00.000Z"),
        checkOut: new Date("2026-08-12T00:00:00.000Z"),
      }),
    );
    mockSendPreArrivalReminderEmail.mockResolvedValue({ status: "sent" });

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "pre-arrival-reminder",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: true });
    expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it("writes no stamp and no audit row when the reminder was withheld", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(reminderBooking());
    mockSendPreArrivalReminderEmail.mockResolvedValue({
      status: "withheld_for_environment",
      reason: "environment_transport_unconfigured",
    });

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "pre-arrival-reminder",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
    expect(mockArchiveSuperseded).not.toHaveBeenCalled();
  });

  it("refuses once the stay has ended", async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(
      reminderBooking({
        checkIn: new Date("2026-06-28T00:00:00.000Z"),
        checkOut: new Date("2026-07-01T00:00:00.000Z"),
      }),
    );

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "pre-arrival-reminder",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockSendPreArrivalReminderEmail).not.toHaveBeenCalled();
  });
});

describe("fresh split guest payment link", () => {
  function parentWithChildren(childIds: string[]) {
    return {
      id: "booking-1",
      status: "CONFIRMED",
      parentBookingId: null,
      hasNonMembers: false,
      groupBookingJoin: null,
      linkedBookings: childIds.map((id) => ({ id })),
    };
  }

  it("re-issues through the existing workflow and audits against the guest booking", async () => {
    mockPrisma.booking.findUnique
      .mockResolvedValueOnce({ deletedAt: null })
      .mockResolvedValueOnce(parentWithChildren(["child-1"]));
    mockIssueSplitGuestPaymentLink.mockResolvedValue({ outcome: "sent", emailLogId: "new-link", recipientMemberId: "member-1", sentTo: "owner@example.org" });
    mockArchiveSuperseded.mockResolvedValue(["log-9"]);

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "split-guest-payment-link",
      actorMemberId: ACTOR,
    });

    expect(result).toEqual({
      ok: true,
      template: "split-guest-payment-link",
      sentTo: "owner@example.org",
      archivedFailureCount: 1,
      warning: null,
    });
    // No owner re-read after delivery: a later ownership change must not
    // change the recipient recorded for the email that already went out.
    expect(mockPrisma.booking.findUnique).toHaveBeenCalledTimes(2);
    expect(mockIssueSplitGuestPaymentLink).toHaveBeenCalledWith("child-1", expect.anything());
    expect(mockArchiveSuperseded).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "child-1", templateName: "split-guest-payment-link" }),
    );
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "child-1",
        action: "booking.email.freshCopySent",
        subjectMemberId: "member-1",
        metadata: expect.objectContaining({ emailLogId: "new-link", recipientMemberId: "member-1" }),
      }),
    );
  });

  it("reports the workflow's refusal and audits nothing when no link went out", async () => {
    mockPrisma.booking.findUnique
      .mockResolvedValueOnce({ deletedAt: null })
      .mockResolvedValueOnce(parentWithChildren(["child-1"]));
    mockIssueSplitGuestPaymentLink.mockResolvedValue({ outcome: "just_sent" });

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "split-guest-payment-link",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
    expect(mockArchiveSuperseded).not.toHaveBeenCalled();
  });

  it("says plainly when only some guest bookings were sent a link", async () => {
    mockPrisma.booking.findUnique
      .mockResolvedValueOnce({ deletedAt: null })
      .mockResolvedValueOnce(parentWithChildren(["child-1", "child-2"]));
    mockIssueSplitGuestPaymentLink
      .mockResolvedValueOnce({ outcome: "sent", emailLogId: "new-link", recipientMemberId: "member-1", sentTo: "owner@example.org" })
      .mockResolvedValueOnce({ outcome: "suppressed" });

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "split-guest-payment-link",
      actorMemberId: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.warning).toMatch(/^1 of 2 guest bookings were not sent a link/);
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
  });

  it("refuses when no guests are waiting to pay separately", async () => {
    mockPrisma.booking.findUnique
      .mockResolvedValueOnce({ deletedAt: null })
      .mockResolvedValueOnce(parentWithChildren([]));

    const result = await sendBookingFreshEmailCopy({
      bookingId: "booking-1",
      template: "split-guest-payment-link",
      actorMemberId: ACTOR,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockIssueSplitGuestPaymentLink).not.toHaveBeenCalled();
  });
});

describe("loadBookingFreshCopyOptions", () => {
  it("explains what is unavailable and counts unarchived failures per email", async () => {
    mockPrisma.booking.findUnique
      .mockResolvedValueOnce({
        id: "booking-1",
        status: "PAID",
        deletedAt: null,
        checkOut: new Date("2026-08-12T00:00:00.000Z"),
        memberId: "member-1",
        organisationId: null,
        member: { email: "owner@example.org" },
        organisation: null,
      })
      .mockResolvedValueOnce({
        id: "booking-1",
        status: "PAID",
        parentBookingId: null,
        hasNonMembers: false,
        groupBookingJoin: null,
        linkedBookings: [],
      });
    mockFindUnarchived.mockResolvedValue([
      { id: "a", bookingId: "booking-1", templateName: "booking-confirmed" },
      { id: "b", bookingId: "booking-1", templateName: "booking-confirmed" },
      { id: "c", bookingId: "other", templateName: "pre-arrival-reminder" },
    ]);

    const options = await loadBookingFreshCopyOptions("booking-1");

    expect(options).toEqual([
      { template: "booking-confirmed", unavailableReason: null, unarchivedFailureCount: 2 },
      { template: "pre-arrival-reminder", unavailableReason: null, unarchivedFailureCount: 0 },
      {
        template: "split-guest-payment-link",
        unavailableReason: "No guests on this booking are waiting to pay separately.",
        unarchivedFailureCount: 0,
      },
    ]);
  });
});

describe("describeUntransmittedFreshCopy", () => {
  it("never words a non-send as a send", () => {
    for (const outcome of [
      { status: "withheld_for_booking", reason: "booking_flag_unreadable" },
      { status: "withheld_for_environment", reason: "environment_role_undeclared" },
      { status: "skipped_no_recipient" },
    ] as const) {
      const { error } = describeUntransmittedFreshCopy(outcome as never);
      expect(error).toMatch(/nothing was sent|held back/i);
    }
  });
});
