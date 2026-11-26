import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5249: the cancelled, bumped and modified senders carry the calendar note and
 * the cancellation file the resolver decides on. Each sender must pass the
 * file to `sendEmail`, put the sentence in BOTH the built-in HTML and the
 * `{{calendarRemovalNote}}` / `{{calendarUpdateNote}}` token (a club override
 * reads only the token), and stay silent when no entry was offered.
 *
 * MUTATION PROOF. Drop `attachments` from a sender's `sendEmail` call and its
 * "attaches" case fails; drop the token supply line and its "token" assertion
 * fails; drop the note argument to a template and its HTML assertion fails;
 * remove the date comparison from the modified sender and the "guest-only
 * change" case fails.
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ status: "sent", emailLogId: "log-1", messageId: null })),
  resolveBookingCalendarRemoval: vi.fn(),
  wasBookingCalendarEntryOffered: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/booking-calendar-removal", () => ({
  resolveBookingCalendarRemoval: mocks.resolveBookingCalendarRemoval,
  wasBookingCalendarEntryOffered: mocks.wasBookingCalendarEntryOffered,
}));

import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import { calendarRemovalNote, calendarUpdateNote } from "@/lib/email-message-notes";
import { renderTemplateString, type EmailTemplateData } from "@/lib/email-message-renderer";
import {
  sendBookingBumpedEmail,
  sendBookingCancelledEmail,
  sendBookingModifiedEmail,
} from "@/lib/email/booking";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-04T00:00:00.000Z");
const ATTACHMENT = {
  filename: "lodge-stay-cancelled-20260801.ics",
  content: Buffer.from("BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\n"),
  contentType: "text/calendar; charset=utf-8; method=CANCEL",
};
const WITH_FILE = calendarRemovalNote(true);
const WITHOUT_FILE = calendarRemovalNote(false);

interface SentEmail {
  html: string;
  templateData: EmailTemplateData;
  attachments?: unknown[];
}

function lastSent(): SentEmail {
  const calls = mocks.sendEmail.mock.calls as unknown as [[SentEmail]];
  return calls[calls.length - 1][0];
}

function defaultBody(templateName: string, data: EmailTemplateData): string {
  const defaults = EMAIL_AUDIT_DEFAULTS[templateName as keyof typeof EMAIL_AUDIT_DEFAULTS];
  return renderTemplateString(defaults.defaultBody, data);
}

async function sendCancelled() {
  await sendBookingCancelledEmail(
    { bookingId: "booking-1", recipientMemberId: "member-1" },
    "sam@example.org",
    "Sam",
    CHECK_IN,
    CHECK_OUT,
    0,
    CLUB_FORMAT_TEST,
  );
  return lastSent();
}

async function sendBumped() {
  await sendBookingBumpedEmail(
    { bookingId: "booking-1", recipientMemberId: "member-1", idempotencyKey: "bump-1" },
    "sam@example.org",
    "Sam",
    CHECK_IN,
    CHECK_OUT,
    2,
    null,
    true,
  );
  return lastSent();
}

beforeEach(() => {
  mocks.resolveBookingCalendarRemoval.mockResolvedValue({ offered: true, attachment: ATTACHMENT });
  mocks.wasBookingCalendarEntryOffered.mockResolvedValue(true);
});

describe.each([
  ["booking-cancelled", sendCancelled],
  ["booking-bumped", sendBumped],
] as const)("%s", (templateName, send) => {
  it("asks the resolver about this booking, recipient and address", async () => {
    await send();
    expect(mocks.resolveBookingCalendarRemoval).toHaveBeenCalledWith({
      bookingId: "booking-1",
      recipientMemberId: "member-1",
      deliveryAddress: "sam@example.org",
      templateName,
    });
  });

  it("attaches the cancellation file and says so in the HTML and the token", async () => {
    const sent = await send();
    expect(sent.attachments).toEqual([ATTACHMENT]);
    expect(sent.html).toContain(WITH_FILE);
    expect(sent.templateData.calendarRemovalNote).toBe(WITH_FILE);
    // The shipped default body (and any override that keeps the token) shows it.
    expect(defaultBody(templateName, sent.templateData)).toContain(WITH_FILE);
  });

  it("names no attachment when the file could not be built", async () => {
    mocks.resolveBookingCalendarRemoval.mockResolvedValue({ offered: true, attachment: null });
    const sent = await send();
    expect(sent.attachments).toBeUndefined();
    expect(sent.html).toContain(WITHOUT_FILE);
    expect(sent.html).not.toContain(WITH_FILE);
    expect(sent.templateData.calendarRemovalNote).toBe(WITHOUT_FILE);
  });

  it("carries neither file nor sentence when no calendar entry was offered", async () => {
    mocks.resolveBookingCalendarRemoval.mockResolvedValue({ offered: false, attachment: null });
    const sent = await send();
    expect(sent.attachments).toBeUndefined();
    expect(sent.html).not.toContain("to your calendar");
    expect(sent.templateData.calendarRemovalNote).toBe("");
    expect(defaultBody(templateName, sent.templateData)).not.toContain("to your calendar");
  });
});

describe("booking-modified", () => {
  function modifiedParams(dates: { newCheckIn: Date; newCheckOut: Date }) {
    return {
      bookingId: "booking-1",
      recipientMemberId: "member-1",
      email: "sam@example.org",
      firstName: "Sam",
      modificationType: "DATE_CHANGE",
      oldCheckIn: CHECK_IN,
      oldCheckOut: CHECK_OUT,
      ...dates,
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 24000,
      newFinalPriceCents: 24000,
      changeFeeCents: 0,
      addedGuests: [],
      refundAmountCents: 0,
      additionalAmountCents: 0,
      financialReviewPending: false,
      refundByBankTransfer: null,
      appliedCreditGivenBackCents: 0,
      unpaidAskCancelled: false,
      refundDestination: "own" as const,
    };
  }
  const MOVED = { newCheckIn: new Date("2026-08-02T00:00:00.000Z"), newCheckOut: CHECK_OUT };
  const UNMOVED = { newCheckIn: CHECK_IN, newCheckOut: new Date(CHECK_OUT.getTime()) };

  it("tells an offered member their entry shows the old dates, with no attachment", async () => {
    await sendBookingModifiedEmail(modifiedParams(MOVED), CLUB_FORMAT_TEST);
    const sent = lastSent();
    expect(mocks.wasBookingCalendarEntryOffered).toHaveBeenCalledWith({
      bookingId: "booking-1",
      recipientMemberId: "member-1",
      deliveryAddress: "sam@example.org",
      templateName: "booking-modified",
    });
    expect(sent.attachments).toBeUndefined();
    expect(sent.html).toContain(calendarUpdateNote());
    expect(sent.templateData.calendarUpdateNote).toBe(calendarUpdateNote());
    expect(defaultBody("booking-modified", sent.templateData)).toContain(calendarUpdateNote());
  });

  it("says nothing about the calendar on a change that kept the dates", async () => {
    await sendBookingModifiedEmail(modifiedParams(UNMOVED), CLUB_FORMAT_TEST);
    const sent = lastSent();
    expect(mocks.wasBookingCalendarEntryOffered).not.toHaveBeenCalled();
    expect(sent.html).not.toContain(calendarUpdateNote());
    expect(sent.templateData.calendarUpdateNote).toBe("");
  });

  it("says nothing about the calendar to a member never offered an entry", async () => {
    mocks.wasBookingCalendarEntryOffered.mockResolvedValue(false);
    await sendBookingModifiedEmail(modifiedParams(MOVED), CLUB_FORMAT_TEST);
    const sent = lastSent();
    expect(sent.html).not.toContain(calendarUpdateNote());
    expect(sent.templateData.calendarUpdateNote).toBe("");
  });
});
