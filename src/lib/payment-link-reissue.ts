/**
 * The self-service "email me a fresh link" action offered on the expired-link
 * page. Extracted from `payment-link.ts` by responsibility (#2956): this is the
 * `/pay` re-issue mint, one of the three writers that mint under the booking's
 * per-lodge advisory lock so at most one live token exists per booking. Token
 * resolution and the refusal vocabulary stay in `payment-link.ts`.
 */
import { issueActionToken } from "@/lib/action-tokens";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { isBornExpired, paymentLinkExpiryForCheckIn } from "@/lib/payment-link-expiry";
import {
  sendBookingRequestApprovedEmail,
  sendSplitGuestPaymentLinkEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import {
  NOT_PAYABLE_MESSAGE,
  PaymentLinkError,
  isPayableByLink,
  loadPaymentLinkRecord,
} from "@/lib/payment-link";
import { prisma } from "@/lib/prisma";

/**
 * Re-issue a payment link for an expired-but-payable booking and email the
 * requester a fresh one (the self-service "fresh link" action offered on the
 * expired-link page). Revokes any prior unused links for the booking. The new
 * link expires at the end of the check-in day in the CLUB's persisted timezone
 * (`payment-link-expiry.ts`), which is where every one of this boundary's four
 * decisions now reads it from.
 *
 * Returns `emailed: false` when the requester's address is actively
 * suppressed (prior SES bounce/complaint) — nothing was delivered, so the UI
 * must not promise an email that will never arrive (F25, #1885).
 */
export async function reissuePaymentLinkForToken(
  token: string
): Promise<{ emailed: boolean }> {
  const link = await loadPaymentLinkRecord(token);
  const booking = link.booking;

  if (!isPayableByLink(booking.status)) {
    throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
  }

  // Zone read BEFORE the mint transaction, which holds the capacity lock.
  const clubZone = await readClubTimeZoneOutsideRequest();
  const expiresAt = paymentLinkExpiryForCheckIn(booking.checkIn, clubZone);
  if (isBornExpired(expiresAt, new Date())) {
    throw new PaymentLinkError(
      "These dates have already passed, so a new payment link can't be issued.",
      410
    );
  }

  // #2258: decide BEFORE the revoke-and-mint below. This path REPLACES the
  // member's existing link (raw tokens are unrecoverable, so re-sending means
  // minting a new one and revoking the old). Discovering the withhold only at
  // send time therefore did not merely churn — it destroyed a link that still
  // worked and left an unreachable one in its place. Read from the row already
  // loaded; the authoritative, fail-closed gate still runs inside sendEmail.
  if (booking.noEmails) {
    logger.warn(
      { bookingId: booking.id },
      'Did not re-issue a payment link: the booking has "No emails" turned on'
    );
    // The member is told only that nothing could be emailed (see the outcome
    // handling below) — never why. Their existing link is left untouched.
    return { emailed: false };
  }

  const { token: freshToken, tokenHash } = issueActionToken();

  await prisma.$transaction(async (tx) => {
    // Serialise with every other mint path (#1967): the settlement cron and
    // the on-demand split-guest flow both mint under the per-lodge advisory
    // lock, so taking it here too makes revoke-then-create atomic across all
    // three writers — at most one live token can exist for the booking.
    const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);
    await tx.paymentLink.updateMany({
      where: { bookingId: booking.id, revokedAt: null, usedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.paymentLink.create({
      data: {
        bookingId: booking.id,
        bookingRequestId: link.bookingRequestId,
        tokenHash,
        expiresAt,
      },
    });
  });

  // #1967 (FIX): a split non-member child's expired link must be re-issued
  // with the split-guest wording, not the request-origin "booking request
  // approved" template — the member never made a booking request. Group
  // joiners (#796, also parent-linked but always carrying a join row) keep
  // their pre-existing behaviour.
  const isSplitGuestLink =
    booking.parentBookingId != null &&
    !booking.groupBookingJoin &&
    !link.bookingRequestId;

  const emailParams = {
    email: booking.member.email,
    firstName: booking.member.firstName,
    lodgeId: booking.lodgeId ?? null,
    token: freshToken,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guests.length,
    priceCents: booking.finalPriceCents,
    bookingReference: booking.id,
    expiresAt,
    // The pay link is about this booking (#2258).
    bookingContext: {
      bookingId: booking.id,
      recipientMemberId: booking.memberId,
    } as const,
  };
  const emailOutcome = isSplitGuestLink
    ? await sendSplitGuestPaymentLinkEmail(emailParams)
    : await sendBookingRequestApprovedEmail(emailParams);

  if (emailOutcome.status === "suppressed") {
    // sendEmail delivered nothing (recipient is SES-suppressed after a prior
    // bounce/complaint). Report truthfully so the page can tell the requester
    // to contact the club instead of watching an inbox that stays empty.
    logger.warn(
      {
        bookingId: booking.id,
        emailSuppressionId: emailOutcome.emailSuppressionId,
        reason: emailOutcome.reason,
      },
      "Fresh payment link issued but the email was suppressed; recipient undeliverable"
    );
    return { emailed: false };
  }

  if (emailOutcome.status === "withheld_for_booking") {
    // #2258: nothing was sent. `emailed: false` is the ONLY thing the member is
    // told — the caller renders the same neutral "we couldn't email it, please
    // contact the club" wording it uses for an undeliverable address. The member
    // must never learn that a per-booking switch exists, let alone that theirs
    // is set; that is an internal club decision and surfacing it would both leak
    // an admin control and invite the member to argue with it.
    logger.warn(
      { bookingId: booking.id, reason: emailOutcome.reason },
      "Fresh payment link issued but the email was withheld by the booking's email gate"
    );
    return { emailed: false };
  }

  if (emailOutcome.status !== "sent") {
    /*
      FAIL CLOSED on anything else the mailer returns. This used to enumerate the
      untransmitted outcomes and then `return { emailed: true }`, which meant the
      environment-safety withhold added by #3035 would have reported a payment
      link as emailed when nothing left the building — and so would the next new
      outcome after it. The member is told the same neutral "we could not email
      it" as for an undeliverable address; which internal reason applied is never
      surfaced to them.
    */
    logger.warn(
      { bookingId: booking.id, emailStatus: emailOutcome.status },
      "Fresh payment link issued but the email was not transmitted"
    );
    return { emailed: false };
  }

  return { emailed: true };
}
