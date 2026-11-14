import { BookingStatus, PaymentSource } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { readBookingNoEmails } from "@/lib/booking-email-suppression";
import {
  BOOKING_FRESH_COPY_TEMPLATES,
  type BookingFreshCopyTemplate,
} from "@/lib/booking-fresh-email-copy-templates";
import { bookingOwner, bookingOwnerEmail } from "@/lib/booking-owner";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  bookingWorthCents,
  isCapturedPaymentStatus,
} from "@/lib/booking-payment-state";
import { bookingPromoEmailFields } from "@/lib/booking-promo-email-options";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";
import { clubFormatValues } from "@/lib/club-format-server";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";
import { sendBookingConfirmedEmail, sendPreArrivalReminderEmail } from "@/lib/email";
import type { EmailSendOutcome } from "@/lib/email/core";
import { escapeHtml } from "@/lib/email-templates/escape";
import {
  EMAIL_FAILURE_MAX_ATTEMPTS,
  archiveSupersededEmailFailures,
  findUnarchivedExhaustedBookingEmailFailures,
} from "@/lib/email-failure-review";
import logger from "@/lib/logger";
import { issueSplitGuestPaymentLink } from "@/lib/payment-link-split-guest";
import {
  PRE_ARRIVAL_REMINDER_BOOKING_INCLUDE,
  isPreArrivalReminderStatus,
  preArrivalReminderEmailParams,
  preArrivalReminderWindow,
} from "@/lib/pre-arrival-reminder-email";
import { prisma } from "@/lib/prisma";

/**
 * AN OFFICER'S FRESH COPY OF A BOOKING EMAIL THAT CANNOT BE REPLAYED.
 *
 * `booking-confirmed`, `pre-arrival-reminder` and `split-guest-payment-link`
 * carry a door code or a single-use payment link, so their rendered bodies are
 * never kept (`SENSITIVE_EMAIL_LOG_TEMPLATES`, `INV-CONFIG-004`) and a failed
 * one stays failed: the retry job has nothing to resend. This module is how an
 * officer gets the member the message anyway — not by recovering the old body,
 * which does not exist, but by rendering the message again through its own
 * sender from the booking as it is NOW.
 *
 * What the officer chooses is the template and nothing else. The recipient is
 * the booking's current owner (an organisation's contact for an organisation
 * booking; for the payment link, the split guest booking's own owner, exactly
 * as the existing workflow sends it), and every figure, date, lodge detail and
 * token is read or minted here. Every send goes through `sendEmail`, so the
 * environment gate, address suppression, the booking's "No emails" switch and
 * the recipient-authority check (#2362) all still apply.
 *
 * Only a send that actually went out reads as sent. Withheld, suppressed or
 * failed sends answer with what really happened and write NO success audit row,
 * and the exhausted failures this copy replaces are archived only once the new
 * message has gone. The old FAILED rows stay as history either way.
 */

export type BookingFreshEmailCopyResult =
  | {
      ok: true;
      template: BookingFreshCopyTemplate;
      sentTo: string;
      archivedFailureCount: number;
      /** Set when only part of the copy went out (several guest bookings). */
      warning: string | null;
    }
  | { ok: false; status: number; error: string };

type AuditRequest = {
  id?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * A recent SENT copy refuses a consecutive request within this window.
 * This is best effort: it reads the email log without reserving a send, so
 * simultaneous requests may both send. Payment links keep the existing
 * lock-backed one-minute cooldown.
 */
export const FRESH_COPY_RECENT_SEND_WINDOW_MS = 2 * 60 * 1000;

export type BookingFreshCopyOption = {
  template: BookingFreshCopyTemplate;
  /** Null when the copy can be sent; otherwise why it cannot, in plain words. */
  unavailableReason: string | null;
  /** Exhausted failures of this email for this booking not yet archived. */
  unarchivedFailureCount: number;
};

const CONFIRMATION_STATUSES: readonly BookingStatus[] = [
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
];

const NOT_SENT_FIX_AND_RETRY =
  "Nothing was sent, and this email is never retried automatically because it carries a door code or payment link. Fix the cause, then send a fresh copy again.";

/** The split guest bookings whose payment link a fresh copy would re-issue. */
async function splitGuestTargets(bookingId: string): Promise<Array<{ id: string }>> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      parentBookingId: true,
      hasNonMembers: true,
      groupBookingJoin: { select: { id: true } },
      // The same selection as the member's own "send guest payment link" route.
      linkedBookings: {
        where: {
          status: BookingStatus.PENDING,
          hasNonMembers: true,
          deletedAt: null,
          groupBookingJoin: { is: null },
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!booking) return [];
  if (
    booking.parentBookingId &&
    booking.status === BookingStatus.PENDING &&
    booking.hasNonMembers &&
    !booking.groupBookingJoin
  ) {
    return [{ id: booking.id }];
  }
  return booking.linkedBookings;
}

/**
 * Which fresh copies a booking can be sent right now, for the booking page.
 * Read-only; the send re-checks everything, so this only shapes the panel.
 */
export async function loadBookingFreshCopyOptions(
  bookingId: string,
): Promise<BookingFreshCopyOption[]> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      checkOut: true,
      memberId: true,
      member: { select: { email: true } },
      organisation: { select: { name: true, email: true } },
    },
  });
  if (!booking) return [];
  const today = dateOnlyInstantOf(clubToday(await clubTimeZone()));
  const hasAddress = bookingOwnerEmail(booking) !== null;
  const splitTargets = await splitGuestTargets(booking.id);
  const failureBookingIds = [booking.id, ...splitTargets.map((target) => target.id)];
  const failures = await findUnarchivedExhaustedBookingEmailFailures({
    bookingIds: failureBookingIds,
    templateNames: [...BOOKING_FRESH_COPY_TEMPLATES],
  });

  const ownerReason = booking.deletedAt
    ? "This booking has been deleted."
    : !hasAddress
      ? "The booking's owner has no email address."
      : null;

  return BOOKING_FRESH_COPY_TEMPLATES.map((template) => {
    let unavailableReason: string | null;
    if (template === "split-guest-payment-link") {
      unavailableReason = booking.deletedAt
        ? "This booking has been deleted."
        : splitTargets.length === 0
          ? "No guests on this booking are waiting to pay separately."
          : null;
    } else if (ownerReason) {
      unavailableReason = ownerReason;
    } else if (template === "booking-confirmed") {
      unavailableReason = CONFIRMATION_STATUSES.includes(booking.status)
        ? null
        : "Only a confirmed or paid booking has a confirmation to send.";
    } else {
      unavailableReason = !isPreArrivalReminderStatus(booking.status)
        ? "Only a confirmed or paid booking is sent a pre-arrival reminder."
        : booking.checkOut.getTime() <= today.getTime()
          ? "This stay has ended."
          : null;
    }
    return {
      template,
      unavailableReason,
      // A split guest booking's payment-link failures are counted here too; its
      // other emails belong to its own page.
      unarchivedFailureCount: failures.filter(
        (failure) =>
          failure.templateName === template &&
          (template === "split-guest-payment-link" || failure.bookingId === booking.id),
      ).length,
    };
  });
}

async function refuseUnlessEmailsAllowed(
  bookingId: string,
): Promise<BookingFreshEmailCopyResult | null> {
  let silenced: boolean;
  try {
    silenced = await readBookingNoEmails(bookingId);
  } catch (err) {
    // Fail closed: an unreadable switch is not permission to email.
    logger.error(
      { err, bookingId },
      'Could not read the booking "No emails" switch before a fresh email copy',
    );
    return {
      ok: false,
      status: 503,
      error: "We could not check this booking's email settings, so nothing was sent. Please try again.",
    };
  }
  if (silenced) {
    return {
      ok: false,
      status: 409,
      error:
        'This booking has the "No emails" switch turned on, so nothing was sent. Turn it off first if the member should hear from us.',
    };
  }
  return null;
}

async function refuseIfJustSent(
  bookingId: string,
  template: BookingFreshCopyTemplate,
  now: Date,
): Promise<BookingFreshEmailCopyResult | null> {
  const recent = await prisma.emailLog.findFirst({
    where: {
      bookingId,
      templateName: template,
      status: "SENT",
      sentAt: { gt: new Date(now.getTime() - FRESH_COPY_RECENT_SEND_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (!recent) return null;
  return {
    ok: false,
    status: 429,
    error: "This email was sent for this booking in the last two minutes. Please wait before sending another copy.",
  };
}

/** What an untransmitted send means, in words that never claim it went out. */
export function describeUntransmittedFreshCopy(outcome: EmailSendOutcome): {
  status: number;
  error: string;
} {
  switch (outcome.status) {
    case "withheld_for_booking":
      return outcome.reason === "booking_no_emails"
        ? {
            status: 409,
            error:
              'This booking has the "No emails" switch turned on, so nothing was sent. Turn it off first if the member should hear from us.',
          }
        : {
            status: 503,
            error: `We could not check this booking's email settings at the moment of sending. ${NOT_SENT_FIX_AND_RETRY}`,
          };
    case "withheld_for_environment":
      return outcome.reason === "environment_non_production"
        ? {
            status: 409,
            error: "This installation is not the club's live site, so it does not email members. Nothing was sent.",
          }
        : {
            status: 503,
            error: `This installation's email settings are not complete, so the message was held back. ${NOT_SENT_FIX_AND_RETRY}`,
          };
    case "suppressed":
      return {
        status: 422,
        error: `The owner's email address is on the bounce or complaint suppression list. ${NOT_SENT_FIX_AND_RETRY}`,
      };
    case "skipped_placeholder_recipient":
    case "skipped_no_recipient":
      return {
        status: 422,
        error: `The booking's owner has no deliverable email address. ${NOT_SENT_FIX_AND_RETRY}`,
      };
    default:
      return { status: 502, error: NOT_SENT_FIX_AND_RETRY };
  }
}

async function recordSentCopy(params: {
  template: BookingFreshCopyTemplate;
  bookingId: string;
  subjectMemberId: string | null;
  recipientMemberId: string | null;
  actorMemberId: string;
  sendStartedAt: Date;
  emailLogId: string | null;
  auditRequest?: AuditRequest;
}): Promise<{ archivedFailureCount: number; warning: string | null }> {
  let warning: string | null = null;
  // Archive only what this copy replaces: exhausted failures of the same email
  // for the same booking that were already failed before this send began.
  let archivedEmailFailureIds: string[] = [];
  try {
    archivedEmailFailureIds = await archiveSupersededEmailFailures({
      bookingId: params.bookingId,
      templateName: params.template,
      createdBefore: params.sendStartedAt,
      reviewedByMemberId: params.actorMemberId,
    });
  } catch (err) {
    warning = "The email was sent, but earlier failures could not all be archived. Review them in Email Deliverability.";
    // The member HAS the email; a failed archive only leaves the old rows in
    // the queue for an officer to archive by hand.
    logger.error(
      { err, bookingId: params.bookingId, template: params.template },
      "Fresh email copy was sent but its superseded failures could not be archived",
    );
  }
  try {
    await createAuditLog({
      action: "booking.email.freshCopySent",
      memberId: params.actorMemberId,
      actorMemberId: params.actorMemberId,
      subjectMemberId: params.subjectMemberId,
      targetId: params.bookingId,
      entityType: "Booking",
      entityId: params.bookingId,
      category: "communication",
      severity: "info",
      outcome: "success",
      summary: "Fresh copy of a booking email sent",
      details:
        "An officer sent a newly rendered copy of a booking email to its current recipient.",
      metadata: {
        templateName: params.template,
        recipientMemberId: params.recipientMemberId,
        emailLogId: params.emailLogId,
        archivedEmailFailureIds,
        maxAttempts: EMAIL_FAILURE_MAX_ATTEMPTS,
      },
      requestId: params.auditRequest?.id,
      ipAddress: params.auditRequest?.ipAddress,
      userAgent: params.auditRequest?.userAgent,
    });
  } catch (err) {
    logger.error(
      { err, bookingId: params.bookingId, template: params.template, emailLogId: params.emailLogId },
      "Fresh email copy was sent but its audit record could not be written",
    );
    warning = [warning, "The email was sent, but its audit record could not be written. Check the delivery log before sending again."].filter(Boolean).join(" ");
  }
  return { archivedFailureCount: archivedEmailFailureIds.length, warning };
}

async function sendFreshConfirmation(
  bookingId: string,
  params: { actorMemberId: string; auditRequest?: AuditRequest; now: Date },
): Promise<BookingFreshEmailCopyResult> {
  const format = await clubFormatValues();
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      member: true,
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
      guests: { select: { id: true } },
      promoRedemptions: { include: { promoCode: true } },
      payment: {
        select: {
          status: true,
          source: true,
          reference: true,
          xeroInvoiceId: true,
          changeFeeCents: true,
          additionalAmountCents: true,
          additionalPaymentStatus: true,
        },
      },
    },
  });
  if (!booking) return { ok: false, status: 404, error: "Booking not found" };
  if (booking.deletedAt) {
    return { ok: false, status: 409, error: "This booking has been deleted, so nothing was sent." };
  }
  if (!CONFIRMATION_STATUSES.includes(booking.status)) {
    return {
      ok: false,
      status: 409,
      error: "Only a confirmed or paid booking has a confirmation to send, so nothing was sent.",
    };
  }
  const email = bookingOwnerEmail(booking);
  if (!email) {
    return { ok: false, status: 409, error: "The booking's owner has no email address, so nothing was sent." };
  }
  const refusal =
    (await refuseUnlessEmailsAllowed(booking.id)) ??
    (await refuseIfJustSent(booking.id, "booking-confirmed", params.now));
  if (refusal) return refusal;

  const owner = bookingOwner(booking);
  const worthCents = bookingWorthCents({
    finalPriceCents: booking.finalPriceCents,
    changeFeeCents: booking.payment?.changeFeeCents ?? null,
  });
  const provisionalGuests = await getProvisionalNonMemberChildSummary({
    id: booking.id,
    memberId: owner.memberId,
  });
  const captured = booking.payment ? isCapturedPaymentStatus(booking.payment.status) : false;
  // A CONFIRMED booking with nothing captured is confirmed but unpaid, and its
  // confirmation must say what is owing rather than "payment processed" (#2263):
  // the internet-banking receivable's reference when it has one, otherwise the
  // booking page where the member chooses how to pay.
  const paymentDue =
    booking.status === BookingStatus.CONFIRMED && !captured
      ? booking.payment?.source === PaymentSource.INTERNET_BANKING
        ? {
            reference: escapeHtml(
              booking.payment.reference ?? buildInternetBankingPaymentReference(booking.id),
            ),
            invoiceEmailed: Boolean(booking.payment.xeroInvoiceId),
          }
        : { payOnline: true as const }
      : null;
  // A settled booking with an uncollected upward change says so (#2397). Not
  // payable online: the club's own chase sends the member to the right door, so
  // this copy under-promises rather than naming one that may not open.
  const outstandingBalance =
    !paymentDue &&
    isAdditionalPaymentOwed({ bookingStatus: booking.status, payment: booking.payment })
      ? { amountCents: booking.payment?.additionalAmountCents ?? 0, payableOnline: false }
      : null;

  const sendStartedAt = new Date();
  const outcome = await sendBookingConfirmedEmail(
    { bookingId: booking.id, recipientMemberId: owner.memberId },
    email,
    owner.member.firstName,
    booking.checkIn,
    booking.checkOut,
    booking.guests.length,
    worthCents,
    format,
    {
      lodgeId: booking.lodgeId,
      ...(provisionalGuests ? { provisionalGuests } : {}),
      ...(paymentDue ? { paymentDue } : {}),
      ...(outstandingBalance && outstandingBalance.amountCents > 0 ? { outstandingBalance } : {}),
      ...bookingPromoEmailFields(booking),
    },
  );
  if (outcome.status !== "sent") {
    logger.warn(
      { bookingId: booking.id, outcome: outcome.status },
      "Fresh booking confirmation was not transmitted",
    );
    return { ok: false, ...describeUntransmittedFreshCopy(outcome) };
  }
  const recorded = await recordSentCopy({
    template: "booking-confirmed",
    bookingId: booking.id,
    subjectMemberId: owner.memberId,
    recipientMemberId: owner.memberId,
    actorMemberId: params.actorMemberId,
    sendStartedAt,
    emailLogId: outcome.emailLogId,
    auditRequest: params.auditRequest,
  });
  return { ok: true, template: "booking-confirmed", sentTo: email, ...recorded };
}

async function sendFreshPreArrivalReminder(
  bookingId: string,
  params: { actorMemberId: string; auditRequest?: AuditRequest; now: Date },
): Promise<BookingFreshEmailCopyResult> {
  const format = await clubFormatValues();
  const clubDay = clubToday(await clubTimeZone());
  const today = dateOnlyInstantOf(clubDay);
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: PRE_ARRIVAL_REMINDER_BOOKING_INCLUDE,
  });
  if (!booking) return { ok: false, status: 404, error: "Booking not found" };
  if (booking.deletedAt) {
    return { ok: false, status: 409, error: "This booking has been deleted, so nothing was sent." };
  }
  if (!isPreArrivalReminderStatus(booking.status)) {
    return {
      ok: false,
      status: 409,
      error: "Only a confirmed or paid booking is sent a pre-arrival reminder, so nothing was sent.",
    };
  }
  if (booking.checkOut.getTime() <= today.getTime()) {
    return { ok: false, status: 409, error: "This stay has ended, so nothing was sent." };
  }
  if (!bookingOwnerEmail(booking)) {
    return { ok: false, status: 409, error: "The booking's owner has no email address, so nothing was sent." };
  }
  const refusal =
    (await refuseUnlessEmailsAllowed(booking.id)) ??
    (await refuseIfJustSent(booking.id, "pre-arrival-reminder", params.now));
  if (refusal) return refusal;

  // The same arguments the daily reminder builds, so the copy carries the
  // lodge's door code and arrival details as they are today.
  const emailParams = preArrivalReminderEmailParams(booking);
  const sendStartedAt = new Date();
  const outcome = await sendPreArrivalReminderEmail(emailParams, format);
  if (outcome.status !== "sent") {
    logger.warn(
      { bookingId: booking.id, outcome: outcome.status },
      "Fresh pre-arrival reminder was not transmitted",
    );
    return { ok: false, ...describeUntransmittedFreshCopy(outcome) };
  }

  // Inside the daily reminder's window, the member now has the reminder, so the
  // job must not send a second one. Outside it the stamp is left alone: the job
  // still reminds them when the stay comes into range, as it would have.
  const { windowStart, windowEndExclusive } = preArrivalReminderWindow(clubDay);
  if (
    booking.checkIn.getTime() >= windowStart.getTime() &&
    booking.checkIn.getTime() < windowEndExclusive.getTime()
  ) {
    await prisma.booking
      .updateMany({
        where: { id: booking.id, preArrivalReminderSentAt: null },
        data: { preArrivalReminderSentAt: sendStartedAt },
      })
      .catch((err) =>
        logger.error(
          { err, bookingId: booking.id },
          "Fresh pre-arrival reminder was sent but the reminder stamp could not be written; the daily job may send another",
        ),
      );
  }

  const recorded = await recordSentCopy({
    template: "pre-arrival-reminder",
    bookingId: booking.id,
    subjectMemberId: emailParams.recipientMemberId,
    recipientMemberId: emailParams.recipientMemberId,
    actorMemberId: params.actorMemberId,
    sendStartedAt,
    emailLogId: outcome.emailLogId,
    auditRequest: params.auditRequest,
  });
  return {
    ok: true,
    template: "pre-arrival-reminder",
    sentTo: emailParams.email,
    ...recorded,
  };
}

async function sendFreshSplitGuestPaymentLink(
  bookingId: string,
  params: { actorMemberId: string; auditRequest?: AuditRequest },
): Promise<BookingFreshEmailCopyResult> {
  const exists = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { deletedAt: true },
  });
  if (!exists) return { ok: false, status: 404, error: "Booking not found" };
  if (exists.deletedAt) {
    return { ok: false, status: 409, error: "This booking has been deleted, so nothing was sent." };
  }
  const targets = await splitGuestTargets(bookingId);
  if (targets.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "No guests on this booking are waiting to pay separately, so there is no payment link to send.",
    };
  }

  const format = await clubFormatValues();
  const sent: Array<{ email: string; archived: number; warning: string | null }> = [];
  const failures: string[] = [];
  let worstStatus = 0;
  for (const target of targets) {
    const sendStartedAt = new Date();
    let issued: Awaited<ReturnType<typeof issueSplitGuestPaymentLink>>;
    try {
      // The existing workflow end to end: revoke-and-remint under the lodge
      // lock, its one-minute cooldown, and revocation when the email fails.
      issued = await issueSplitGuestPaymentLink(target.id, format);
    } catch (err) {
      logger.error({ err, bookingId: target.id }, "Fresh split guest payment link failed to send");
      failures.push("The email could not be sent and the new link was revoked. Please try again.");
      worstStatus = Math.max(worstStatus, 502);
      continue;
    }
    switch (issued.outcome) {
      case "sent": {
        const archived = await recordSentCopy({
          template: "split-guest-payment-link",
          bookingId: target.id,
          subjectMemberId: issued.recipientMemberId,
          recipientMemberId: issued.recipientMemberId,
          actorMemberId: params.actorMemberId,
          sendStartedAt,
          emailLogId: issued.emailLogId,
          auditRequest: params.auditRequest,
        });
        sent.push({ email: issued.sentTo, archived: archived.archivedFailureCount, warning: archived.warning });
        break;
      }
      case "just_sent":
        failures.push("A payment link was emailed in the last minute. Please wait before sending another.");
        worstStatus = Math.max(worstStatus, 429);
        break;
      case "withheld":
        failures.push(
          'Nothing was sent: the guest booking has the "No emails" switch on, or this installation does not email members.',
        );
        worstStatus = Math.max(worstStatus, 409);
        break;
      case "transient_failure":
        failures.push(
          `The email was held back because a setting could not be read or is incomplete, and the new link was revoked. ${NOT_SENT_FIX_AND_RETRY}`,
        );
        worstStatus = Math.max(worstStatus, 503);
        break;
      case "suppressed":
        failures.push(
          `The guest booking's owner has no deliverable email address, so the new link was revoked. ${NOT_SENT_FIX_AND_RETRY}`,
        );
        worstStatus = Math.max(worstStatus, 422);
        break;
      case "not_payable":
        failures.push(
          "No payment link can be sent: nothing is owed, the stay has started, or a saved card will be charged automatically.",
        );
        worstStatus = Math.max(worstStatus, 409);
        break;
    }
  }

  if (sent.length === 0) {
    return { ok: false, status: worstStatus || 409, error: [...new Set(failures)].join(" ") };
  }
  if (failures.length > 0) {
    logger.warn(
      { bookingId, sent: sent.length, notSent: failures.length },
      "Fresh split guest payment link sent for some guest bookings only",
    );
  }
  return {
    ok: true,
    template: "split-guest-payment-link",
    sentTo: [...new Set(sent.map((entry) => entry.email).filter(Boolean))].join(", "),
    archivedFailureCount: sent.reduce((total, entry) => total + entry.archived, 0),
    // Partly sent: say both halves rather than reading as a clean success.
    warning: [
      failures.length > 0
        ? `${failures.length} of ${targets.length} guest bookings were not sent a link. ${[...new Set(failures)].join(" ")}`
        : null,
      ...sent.map((entry) => entry.warning),
    ].filter(Boolean).join(" ") || null,
  };
}

/** Send a fresh copy of one booking email. The template is the only input. */
export async function sendBookingFreshEmailCopy(params: {
  bookingId: string;
  template: BookingFreshCopyTemplate;
  actorMemberId: string;
  auditRequest?: AuditRequest;
  now?: Date;
}): Promise<BookingFreshEmailCopyResult> {
  const now = params.now ?? new Date();
  switch (params.template) {
    case "booking-confirmed":
      return sendFreshConfirmation(params.bookingId, { ...params, now });
    case "pre-arrival-reminder":
      return sendFreshPreArrivalReminder(params.bookingId, { ...params, now });
    case "split-guest-payment-link":
      return sendFreshSplitGuestPaymentLink(params.bookingId, params);
  }
}
