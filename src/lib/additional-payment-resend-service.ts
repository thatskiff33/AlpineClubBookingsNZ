import {
  ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES,
  additionalPaymentEpisodeStartedAt,
  isAdditionalOwedBookingStatus,
  isAdditionalPaymentOwed,
  isWithinAdditionalPaymentResendCooldown,
  resolveAdditionalPaymentChase,
} from "@/lib/additional-payment-chase";
import { createAuditLog } from "@/lib/audit";
import { readBookingNoEmails } from "@/lib/booking-email-suppression";
import { normalizeDateOnlyForTimeZone } from "@/lib/date-only";
import { sendAdditionalPaymentReminderEmail } from "@/lib/email";
import type { EmailSendOutcome } from "@/lib/email/core";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildAdditionalOwedPaymentWhere } from "@/lib/unpaid-finished-stays";

/**
 * Admin re-send of the "you still owe this" email (#2350).
 *
 * The automatic chase (src/lib/cron-additional-payment-reminders.ts) covers the
 * ordinary case; this is the officer on the phone who needs the member to have
 * the message in front of them now. It sends the SAME email the cron sends, so
 * an admin override of the wording applies to both.
 *
 * Four properties make it safe to give an admin a button that emails a member:
 *
 *  1. **It cannot fan out.** The stamp that suppresses the automatic reminder is
 *     also the cooldown record, and it is written by a guarded `updateMany`
 *     BEFORE the send. Two clicks in the same second leave one winner; the loser
 *     is told the message just went out.
 *  2. **Auto and manual share one clock, in both directions.** Because both
 *     write the same stamps, a cron reminder sent minutes ago blocks a re-send
 *     exactly as another re-send would — and a re-send suppresses whichever
 *     automatic nudge was coming, INCLUDING the last-chance one when that is the
 *     reminder currently due (it closes both stamps, as the cron's final branch
 *     does). Stamping only the day-N column left the guarantee one-directional.
 *  3. **Silence is honoured up front.** A booking with the "No emails" switch on
 *     is refused with an explanation rather than being handed to the mailer to
 *     withhold — the admin is standing right there, and a silent withhold looks
 *     identical to a successful send.
 *  4. **Only a send that actually went out reads as sent.** The mailer RETURNS
 *     rather than throws when it withholds (suppressed address, walk-in
 *     placeholder address, the switch flipping on after the check above), so the
 *     outcome is inspected: anything other than "sent" gives the stamps back and
 *     answers with what really happened. The single exception — an UNREADABLE
 *     switch — keeps the stamps because the mailer left a FAILED EmailLog row
 *     that the retry job replays; the reply says so rather than inviting a
 *     retry the cooldown would then refuse. Same rule, same exception, as the
 *     cron (src/lib/cron-additional-payment-reminders.ts).
 */

export type ResendAdditionalPaymentEmailResult =
  | {
      ok: true;
      sentAt: Date;
      additionalAmountCents: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export async function resendAdditionalPaymentEmail(params: {
  bookingId: string;
  actorMemberId: string;
  auditRequest?: {
    id?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
  now?: Date;
}): Promise<ResendAdditionalPaymentEmailResult> {
  const now = params.now ?? new Date();

  const booking = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    select: {
      id: true,
      memberId: true,
      status: true,
      checkIn: true,
      checkOut: true,
      deletedAt: true,
      lodgeId: true,
      member: { select: { email: true, firstName: true } },
      payment: {
        select: {
          id: true,
          additionalAmountCents: true,
          additionalPaymentStatus: true,
          additionalReminderSentAt: true,
          additionalFinalReminderSentAt: true,
          createdAt: true,
          transactions: {
            where: { kind: "ADDITIONAL" },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  if (!booking) {
    return { ok: false, status: 404, error: "Booking not found" };
  }
  if (booking.deletedAt) {
    return {
      ok: false,
      status: 409,
      error: "This booking has been deleted, so no payment request can be sent.",
    };
  }
  const payment = booking.payment;
  if (!isAdditionalOwedBookingStatus(booking.status)) {
    // A cancelled (or bumped, or not-yet-confirmed) booking keeps its delta
    // columns untouched, so without this the button would email a member
    // "Payment Still Needed" about a booking that no longer exists for them.
    return {
      ok: false,
      status: 409,
      error:
        "This booking is not in a state where an additional payment can be collected, so nothing was sent.",
    };
  }
  if (
    !isAdditionalPaymentOwed({ bookingStatus: booking.status, payment }) ||
    !payment
  ) {
    return {
      ok: false,
      status: 409,
      error: "This booking has no outstanding additional payment.",
    };
  }

  let silenced: boolean;
  try {
    silenced = await readBookingNoEmails(booking.id);
  } catch (err) {
    // Fail closed: an unreadable switch is not permission to email.
    logger.error(
      { err, bookingId: booking.id },
      'Could not read the booking "No emails" switch before an additional-payment re-send',
    );
    return {
      ok: false,
      status: 503,
      error:
        "We could not check this booking's email settings, so nothing was sent. Please try again.",
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

  if (
    isWithinAdditionalPaymentResendCooldown({
      now,
      reminderSentAt: payment.additionalReminderSentAt,
      finalReminderSentAt: payment.additionalFinalReminderSentAt,
    })
  ) {
    return {
      ok: false,
      status: 429,
      error: `A payment request was already emailed to this member in the last ${ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES} minutes. Please wait before sending another.`,
    };
  }

  const episodeStartedAt = additionalPaymentEpisodeStartedAt({
    paymentCreatedAt: payment.createdAt,
    latestAdditionalTransactionCreatedAt:
      payment.transactions[0]?.createdAt ?? null,
  });

  /*
    Which automatic reminder is this manual send standing in for?

    Writing only the day-N stamp made the cooldown one-directional: an admin
    re-send inside the pre-arrival window was followed by the cron's near
    identical last-chance email at the next three-hourly tick, which is exactly
    what the shared-clock guarantee in this file's header promises cannot
    happen. So when the last-chance reminder is the one currently due, the
    manual send closes BOTH stamps — the same thing the cron's own final branch
    does, and for the same reason: the member has now been told inside the
    window and a second copy has nothing to add.
  */
  const standsInFor = resolveAdditionalPaymentChase({
    now,
    today: normalizeDateOnlyForTimeZone(now),
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    episodeStartedAt,
    reminderSentAt: payment.additionalReminderSentAt,
    finalReminderSentAt: payment.additionalFinalReminderSentAt,
    // The first-deploy guard is about the cron mailing a backlog in bulk. This
    // is one admin deciding to contact one member, which the guard's own
    // documentation names as the way a pre-cutover delta IS chased, so the
    // manual path is not subject to it.
    chaseStartsAt: new Date(0),
  });
  const closesFinalReminder = standsInFor === "final";
  const stamps = closesFinalReminder
    ? { additionalReminderSentAt: now, additionalFinalReminderSentAt: now }
    : { additionalReminderSentAt: now };

  // The read above is advisory; this claim is the one that decides. It re-states
  // the cooldown and the FULL owed test (booking lifecycle status included) and
  // fences the obligation it read — the exact amount, and no ADDITIONAL
  // transaction newer than this episode — so two concurrent clicks, a cron pass
  // landing in between, a cancellation, or a fresh upward change cannot produce
  // an email about the wrong obligation.
  const cooldownCutoff = new Date(
    now.getTime() - ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES * 60_000,
  );
  const claimed = await prisma.payment.updateMany({
    where: {
      id: payment.id,
      AND: [
        buildAdditionalOwedPaymentWhere(),
        { additionalAmountCents: payment.additionalAmountCents },
        {
          transactions: {
            none: { kind: "ADDITIONAL", createdAt: { gt: episodeStartedAt } },
          },
        },
        {
          OR: [
            { additionalReminderSentAt: null },
            { additionalReminderSentAt: { lte: cooldownCutoff } },
          ],
        },
        {
          OR: [
            { additionalFinalReminderSentAt: null },
            { additionalFinalReminderSentAt: { lte: cooldownCutoff } },
          ],
        },
      ],
    },
    data: stamps,
  });
  if (claimed.count === 0) {
    // A lost claim is not automatically "someone else just emailed them": the
    // amount and the episode are fenced too. Re-read and say which it was,
    // because "wait an hour" would be a lie if the delta simply moved.
    return await explainLostClaim({
      paymentId: payment.id,
      readAmountCents: payment.additionalAmountCents,
      readEpisodeStartedAt: episodeStartedAt,
    });
  }

  const restoreStamps = async (why: string) => {
    // Give the stamp(s) back so the automatic chase is not silently disarmed by
    // a send that never happened. Guarded on the values we wrote, so a reminder
    // that landed in between is not clobbered.
    await prisma.payment
      .updateMany({
        where: {
          id: payment.id,
          additionalReminderSentAt: now,
          ...(closesFinalReminder
            ? { additionalFinalReminderSentAt: now }
            : {}),
        },
        data: {
          additionalReminderSentAt: payment.additionalReminderSentAt,
          ...(closesFinalReminder
            ? {
                additionalFinalReminderSentAt:
                  payment.additionalFinalReminderSentAt,
              }
            : {}),
        },
      })
      .catch((restoreErr) =>
        logger.error(
          { err: restoreErr, bookingId: booking.id, why },
          "Failed to restore the additional-payment reminder stamp after a re-send that did not go out",
        ),
      );
  };

  let outcome;
  try {
    outcome = await sendAdditionalPaymentReminderEmail({
      bookingId: booking.id,
      recipientMemberId: booking.memberId,
      email: booking.member.email,
      firstName: booking.member.firstName,
      additionalAmountCents: payment.additionalAmountCents,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      requestedOn: episodeStartedAt,
      lodgeId: booking.lodgeId,
    });
  } catch (err) {
    await restoreStamps("transport_error");
    logger.error(
      { err, bookingId: booking.id },
      "Failed to re-send the additional-payment request email",
    );
    return {
      ok: false,
      status: 502,
      error: "We could not send the payment request email. Please try again.",
    };
  }

  if (outcome.status !== "sent") {
    /*
      The mailer RETURNS rather than throws when nothing was transmitted. An
      admin standing at the booking must never be told "emailed" in that case:
      a silent withhold looks identical to a successful send, and the stamp we
      just wrote would also have spent the hour's cooldown on nothing.

      The stamps go back for every case except an unreadable "No emails" switch,
      which leaves a FAILED EmailLog the retry cron replays — restoring there
      would risk the member getting a second copy.
    */
    const replayable =
      (outcome.status === "withheld_for_booking" &&
        outcome.reason === "booking_flag_unreadable") ||
      // #3035: every environment-safety withhold EXCEPT the confirmed-copy one
      // leaves a FAILED EmailLog the retry cron replays once the configuration is
      // fixed, so handing the stamp back here would risk the member getting two
      // copies. Written as "not the terminal one" rather than as a list of faults,
      // so a fault added later is replayable by default.
      (outcome.status === "withheld_for_environment" &&
        outcome.reason !== "environment_non_production");
    if (!replayable) {
      await restoreStamps(outcome.status);
    }
    logger.warn(
      { bookingId: booking.id, outcome: outcome.status },
      "Additional-payment re-send was not transmitted",
    );
    return {
      ok: false,
      // 503 for the one case that is our own uncertainty rather than a fact
      // about this booking or this member: the switch could not be read, so
      // trying again shortly is the right advice. 409 for the switch being on
      // (a state of the booking), 422 for an address that cannot receive mail.
      status: replayable
        ? 503
        : outcome.status === "withheld_for_booking" ||
            outcome.status === "withheld_for_environment"
          ? 409
          : 422,
      error: describeUntransmittedResend(outcome),
    };
  }

  await createAuditLog({
    action: "booking.additionalPayment.reminderResent",
    memberId: params.actorMemberId,
    actorMemberId: params.actorMemberId,
    subjectMemberId: booking.memberId,
    targetId: booking.id,
    entityType: "Booking",
    entityId: booking.id,
    category: "payment",
    severity: "info",
    outcome: "success",
    summary: "Additional payment request re-sent to the member",
    details:
      "Admin re-sent the email asking the member to pay the extra amount a booking change added. Nothing about the booking or the amount owed was changed.",
    metadata: {
      additionalAmountCents: payment.additionalAmountCents,
      additionalPaymentStatus: payment.additionalPaymentStatus,
      requestedOn: episodeStartedAt.toISOString(),
      previousReminderSentAt:
        payment.additionalReminderSentAt?.toISOString() ?? null,
      // Whether this send also closed the automatic last-chance reminder, so
      // the audit trail explains why the member never got the cron's copy.
      closedFinalReminder: closesFinalReminder,
    },
    requestId: params.auditRequest?.id,
    ipAddress: params.auditRequest?.ipAddress,
    userAgent: params.auditRequest?.userAgent,
  });

  return {
    ok: true,
    sentAt: now,
    additionalAmountCents: payment.additionalAmountCents,
  };
}

/**
 * Why did the guarded claim match nothing? Re-read and answer honestly.
 *
 * Three different things fail the same WHERE — someone else emailed the member
 * inside the cooldown, the money stopped being owed (paid, or the booking was
 * cancelled), or the obligation itself moved (a new upward change, or the member
 * retrying a failed charge, which mints a fresh ADDITIONAL transaction). Only
 * the first is a "wait an hour"; telling an admin to wait when the amount on
 * their screen is simply out of date would send them back to press the same
 * stale button.
 */
async function explainLostClaim(params: {
  paymentId: string;
  readAmountCents: number;
  readEpisodeStartedAt: Date;
}): Promise<ResendAdditionalPaymentEmailResult> {
  const fresh = await prisma.payment
    .findUnique({
      where: { id: params.paymentId },
      select: {
        additionalAmountCents: true,
        additionalPaymentStatus: true,
        createdAt: true,
        booking: { select: { status: true } },
        transactions: {
          where: { kind: "ADDITIONAL" },
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    })
    .catch((err) => {
      logger.error(
        { err, paymentId: params.paymentId },
        "Could not re-read the payment after a lost additional-payment re-send claim",
      );
      return null;
    });

  const cooldownAnswer: ResendAdditionalPaymentEmailResult = {
    ok: false,
    status: 429,
    error: `A payment request was already emailed to this member in the last ${ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES} minutes. Please wait before sending another.`,
  };

  if (!fresh) return cooldownAnswer;

  if (
    !isAdditionalPaymentOwed({
      bookingStatus: fresh.booking.status,
      payment: fresh,
    })
  ) {
    return {
      ok: false,
      status: 409,
      error:
        "This booking no longer has an outstanding additional payment, so nothing was sent. Reload the booking to see its current state.",
    };
  }

  const freshEpisodeStartedAt = additionalPaymentEpisodeStartedAt({
    paymentCreatedAt: fresh.createdAt,
    latestAdditionalTransactionCreatedAt:
      fresh.transactions[0]?.createdAt ?? null,
  });
  if (
    fresh.additionalAmountCents !== params.readAmountCents ||
    freshEpisodeStartedAt.getTime() !== params.readEpisodeStartedAt.getTime()
  ) {
    return {
      ok: false,
      status: 409,
      error:
        "The outstanding amount changed while this was being sent, so no email went out. Reload the booking and send the request again.",
    };
  }

  return cooldownAnswer;
}

/**
 * Plain English for a send the mailer withheld rather than transmitted.
 *
 * THE "IT WILL GO OUT ON ITS OWN" SENTENCES BELOW DEPEND ON ONE FACT, and it is
 * worth naming rather than leaving as a coincidence (#3035 review). A blocked
 * EmailLog row is only replayable while it still holds a rendered body, and
 * `sendEmail` persists none for the twenty-six `SENSITIVE_EMAIL_LOG_TEMPLATES`.
 * This service sends `additional-payment-reminder`, which is NOT one of them, so
 * the row keeps its body, the retry cron picks it up, and "do not re-send it by
 * hand" is correct advice — telling an admin to retry would only spend the hour's
 * cooldown on a message already on its way.
 *
 * If this service is ever pointed at a sensitive template, these sentences become
 * false in the expensive direction: the message would be gone and the admin would
 * have been told to leave it alone. The mail gate is what makes that visible —
 * such a row is written at the retry ceiling and lands in the email-failure review
 * queue — but the sentence here would still be wrong, so change it in the same
 * breath.
 */
function describeUntransmittedResend(outcome: EmailSendOutcome): string {
  switch (outcome.status) {
    case "withheld_for_booking":
      return outcome.reason === "booking_no_emails"
        ? 'This booking has the "No emails" switch turned on, so nothing was sent. Turn it off first if the member should hear from us.'
        : // Deliberately NOT "try again shortly": this is the one path that
          // keeps the reminder stamp, because the message is queued as a failed
          // send that the retry job replays by itself. Advising a retry would
          // send the admin straight into the hour's cooldown for a message that
          // is already on its way.
          "We could not confirm this booking's email settings, so the message was held back and queued to be sent automatically once they can be read. Do not re-send it by hand — that is blocked for the next hour so the member cannot receive two copies.";
    case "withheld_for_environment":
      if (outcome.reason === "environment_non_production") {
        return "This site is a test or staging copy, not the club's live site, so it does not email real members and nothing was sent. Send this from the club's live site instead.";
      }
      if (outcome.reason === "capture_transport_in_production") {
        return "This site is set up as the club's live site and as a test mail capture at the same time, so it held the message back rather than quietly throw it away. It is queued and will go out on its own once that is corrected — do not re-send it by hand.";
      }
      // Same shape as the unreadable-switch case above, and for the same reason:
      // the message is already queued and goes out by itself once somebody
      // declares what this installation is, so telling an admin to try again
      // would only spend the hour's cooldown.
      return "This site has not been told whether it is the club's live site or a copy, so it held the message back rather than risk emailing a real member. It is queued and will go out on its own once that is set — do not re-send it by hand.";
    case "suppressed":
      return "This member's email address is blocked after a bounce or spam complaint, so nothing was sent. Contact them another way, or clear the suppression first.";
    case "skipped_placeholder_recipient":
      return "This member has no real email address on file (a walk-in placeholder), so nothing was sent.";
    default:
      return "The payment request was not sent. Please try again.";
  }
}
