/**
 * Split-guest payment links (#1967): the mint the settlement cron calls under
 * its own lock, and the on-demand mint-and-email a member triggers from the
 * booking page. Extracted from `payment-link.ts` by responsibility (#2956);
 * token resolution and the revocation helpers stay there.
 *
 * Every mint here happens under the booking's per-lodge advisory lock
 * (`acquireLodgeCapacityLock`), which is what keeps at most one live token per
 * booking across this module, the cron and the `/pay` re-issue path.
 */
import { BookingStatus, Prisma } from "@prisma/client";
import { issueActionToken } from "@/lib/action-tokens";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  paymentLinkExpiryForCheckIn,
  type ClubTimeZone,
} from "@/lib/payment-link-expiry";
import { sendSplitGuestPaymentLinkEmail } from "@/lib/email";
import { recordWithheldBookingEmail } from "@/lib/booking-email-suppression";
import logger from "@/lib/logger";
import { revokePaymentLinkById } from "@/lib/payment-link";
import { prisma } from "@/lib/prisma";

/** A freshly minted split-guest link: the raw token (emailable exactly once)
 * plus the row id so a caller whose email fails can revoke THIS link — and
 * only this link — without touching a newer one minted concurrently.
 *
 * `expiresAt` IS THE STORED INSTANT, handed back so the email that carries the
 * token states the row's deadline rather than deriving the boundary again. */
export type MintedSplitGuestPaymentLink = {
  token: string;
  paymentLinkId: string;
  expiresAt: Date;
};

/**
 * The on-demand "re-send" affordance treats an active link minted within this
 * window as just-sent and refuses to replace it, so a double-click (or two
 * racing POSTs) cannot fan out two emails. Older active links ARE replaced —
 * revoke-and-remint is the only way to re-send, because raw tokens are never
 * stored at rest.
 */
const SPLIT_LINK_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Revoke every unused, unrevoked link for the booking and mint a fresh one.
 * MUST be called inside a transaction holding the booking's per-lodge advisory
 * lock — the revoke-then-create pair is what preserves the at-most-one-live-
 * token invariant across the cron, the on-demand button, and /pay reissue.
 */
async function mintFreshSplitGuestPaymentLink(
  tx: Prisma.TransactionClient,
  bookingId: string,
  expiresAt: Date,
  now: Date
): Promise<MintedSplitGuestPaymentLink> {
  await tx.paymentLink.updateMany({
    where: { bookingId, revokedAt: null, usedAt: null },
    data: { revokedAt: now },
  });
  const { token, tokenHash } = issueActionToken();
  const created = await tx.paymentLink.create({
    data: { bookingId, tokenHash, expiresAt },
  });
  return { token, paymentLinkId: created.id, expiresAt };
}

/**
 * Mint a tokenised PaymentLink for a split non-member child booking (#1967) IF
 * it has no active (un-revoked, un-used, un-expired) link yet, returning the
 * raw token + row id so the caller can email it and, if that email fails,
 * revoke it. Returns null when an active link already exists — that
 * absence/presence is the idempotency sentinel that stops the settlement cron
 * re-emailing the member on every extension run (only the raw token minted
 * here can be emailed; a pre-existing link's token is unrecoverable by
 * design). An EXPIRED link is deliberately NOT active (#707's expired_payable
 * convention): it is revoked and replaced, so a booking whose dates were
 * pushed out after its link lapsed gets a fresh, working link. Returns null
 * without minting when the check-in day has already ended — a link that would
 * be born expired must never be emailed.
 *
 * DB-only and safe to call inside a capacity-lock transaction; the email MUST
 * be sent by the caller OUTSIDE the transaction. The link expires at the end of
 * the check-in day in the CLUB's persisted zone, matching the #707/#740
 * request-origin convention. `clubZone` is a PARAMETER because this runs under
 * the caller's lock — `payment-link-expiry.ts` is why.
 */
export async function mintSplitGuestPaymentLinkIfAbsent(
  tx: Prisma.TransactionClient,
  booking: { id: string; checkIn: Date },
  clubZone: ClubTimeZone
): Promise<MintedSplitGuestPaymentLink | null> {
  const now = new Date();
  const expiresAt = paymentLinkExpiryForCheckIn(booking.checkIn, clubZone);
  if (expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const existing = await tx.paymentLink.findFirst({
    where: {
      bookingId: booking.id,
      revokedAt: null,
      usedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (existing) return null;

  return mintFreshSplitGuestPaymentLink(tx, booking.id, expiresAt, now);
}

/** Registry template the split-guest pay-link email ships as (#1967). The one
 * home for the name (#2956, `INV-SSOT`): `cron-confirm-pending.ts` imports it. */
export const SPLIT_GUEST_PAYMENT_LINK_TEMPLATE = "split-guest-payment-link";

export type IssueSplitGuestPaymentLinkResult =
  | { outcome: "sent" }
  | { outcome: "just_sent" }
  | { outcome: "suppressed" }
  // #2258: the booking carries the "No emails" switch, so no link was minted
  // and nothing was sent. Distinct from `suppressed` (an undeliverable address,
  // an operator problem) — this one is deliberate.
  | { outcome: "withheld" }
  // #2258: the booking's email setting could not be READ, so the send failed
  // closed. Kept apart from `suppressed` because that outcome means "this
  // address is undeliverable" — telling a member that about a transient
  // database fault is misinformation, and it points an officer at the wrong
  // diagnosis. Retryable: the next attempt sends normally.
  | { outcome: "transient_failure" }
  | { outcome: "not_payable" };

/**
 * On-demand sibling of the settlement-cron path (#1967): mint and email a
 * split non-member child's guest-portion payment link. Backs the
 * booking-detail affordance a member uses when paying their own place by
 * Internet Banking (no card on file for the later guest charge).
 *
 * This is a true send/RE-SEND: because a stored link's raw token is
 * unrecoverable, an existing active link is revoked and replaced with a fresh
 * one (revocation + mint atomically under the per-lodge advisory lock, so two
 * live tokens can never coexist). The only exception is an active link minted
 * within the last minute, which is treated as just-sent — that sentinel plus
 * the lock is the double-click guard. If the email is suppressed or the send
 * throws, the just-minted link is revoked again so no unreachable token stays
 * active. Refuses (`not_payable`) for anything that is not a genuine PENDING
 * split child (#738) — #796 group joiners are excluded by their join row — and
 * whenever a saved card exists on the child or its parent, because the
 * settlement cron will auto-charge that card and a parallel link would open a
 * second live settlement path.
 */
export async function issueSplitGuestPaymentLink(
  childBookingId: string
): Promise<IssueSplitGuestPaymentLinkResult> {
  const booking = await prisma.booking.findUnique({
    where: { id: childBookingId },
    include: {
      member: true,
      guests: { select: { id: true } },
      payment: true,
      parentBooking: { include: { payment: true } },
      groupBookingJoin: { select: { id: true } },
    },
  });

  if (
    !booking ||
    booking.deletedAt ||
    booking.status !== BookingStatus.PENDING ||
    !booking.parentBookingId ||
    // #796 group joiners share parentBookingId but always carry a join row;
    // they settle via their own join-time link or organiser settlement, never
    // via the split-guest flow.
    booking.groupBookingJoin ||
    !booking.hasNonMembers ||
    booking.finalPriceCents <= 0
  ) {
    return { outcome: "not_payable" };
  }

  // #2258: check the "No emails" switch BEFORE minting. Minting first and
  // discovering the withhold at send time would revoke-and-re-mint on every
  // attempt — unbounded PaymentLink and EmailLog churn whose repeats bury, in
  // the booking's withheld list, the very withholds an operator needs to see. A
  // withheld send is NOT a revoke-and-retry condition: nothing changes until an
  // admin clears the switch.
  //
  // Read from the row already loaded above rather than issuing a second query:
  // if that read had failed we would not be here at all, and the authoritative,
  // fail-closed gate still runs inside sendEmail at send time. The withhold is
  // recorded at most once per booking so repeat attempts stay quiet.
  if (booking.noEmails) {
    await recordWithheldBookingEmail({
      bookingId: booking.id,
      templateName: SPLIT_GUEST_PAYMENT_LINK_TEMPLATE,
      subject: "Pay for your guests to confirm their place",
      to: booking.member.email,
      detail:
        'Withheld: this booking has the "No emails" switch turned on. No payment link was created.',
      once: true,
      // Scope the once-check to THIS episode, so a re-enable records afresh.
      sinceAt: booking.noEmailsAt,
    });
    logger.warn(
      { bookingId: booking.id },
      'Did not mint a split guest payment link: the booking has "No emails" turned on',
    );
    return { outcome: "withheld" };
  }

  // #1967 FIX-5: a saved card (its own, or inherited from the parent payment)
  // means the settlement cron will auto-charge this child — issuing a manual
  // pay link alongside would create a second live settlement path.
  const hasSavedCard = Boolean(
    (booking.payment?.stripeCustomerId &&
      booking.payment.stripePaymentMethodId) ||
      (booking.parentBooking?.payment?.stripeCustomerId &&
        booking.parentBooking.payment.stripePaymentMethodId)
  );
  if (hasSavedCard) {
    return { outcome: "not_payable" };
  }

  // BEFORE the transaction, which holds the capacity lock, and ONCE, so the
  // stored instant and the emailed one cannot drift apart. `checkIn` is
  // immutable, so nothing under the lock can change this value.
  const clubZone = await readClubTimeZoneOutsideRequest();
  const expiresAt = paymentLinkExpiryForCheckIn(booking.checkIn, clubZone);

  const minted = await prisma.$transaction(
    async (
      tx
    ): Promise<
      | { kind: "not_payable" }
      | { kind: "just_sent" }
      | ({ kind: "minted" } & MintedSplitGuestPaymentLink)
    > => {
      const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);
      // Re-read status under the lock; a concurrent settle/cancel is only
      // visible here. Never mint a link for a booking that has left PENDING.
      const locked = await tx.booking.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      if (!locked || locked.status !== BookingStatus.PENDING) {
        return { kind: "not_payable" };
      }

      const now = new Date();
      if (expiresAt.getTime() <= now.getTime()) {
        // The check-in day has ended; a fresh link would be born expired.
        return { kind: "not_payable" };
      }

      const active = await tx.paymentLink.findFirst({
        where: {
          bookingId: booking.id,
          revokedAt: null,
          usedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true, createdAt: true },
      });
      if (
        active &&
        now.getTime() - active.createdAt.getTime() <
          SPLIT_LINK_RESEND_COOLDOWN_MS
      ) {
        // Just minted (double-click, or a race with the settlement cron):
        // an email carrying this link is already on its way.
        return { kind: "just_sent" };
      }

      // Revoke-and-remint: the active link's raw token is unrecoverable at
      // rest, so re-sending means replacing it. Atomic under the lodge lock.
      return {
        kind: "minted",
        ...(await mintFreshSplitGuestPaymentLink(
          tx,
          booking.id,
          expiresAt,
          now
        )),
      };
    }
  );

  if (minted.kind === "not_payable") return { outcome: "not_payable" };
  if (minted.kind === "just_sent") return { outcome: "just_sent" };

  let emailOutcome;
  try {
    emailOutcome = await sendSplitGuestPaymentLinkEmail({
      bookingContext: {
        bookingId: booking.id,
        recipientMemberId: booking.memberId,
      },
      email: booking.member.email,
      firstName: booking.member.firstName,
      token: minted.token,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      priceCents: booking.finalPriceCents,
      bookingReference: booking.id,
      expiresAt: minted.expiresAt, // the row's own instant, not a re-derivation
      lodgeId: booking.lodgeId ?? null,
    });
  } catch (err) {
    // The raw token dies with this request; clear the sentinel so a retry
    // (button or cron) re-mints instead of pointing at an unreachable link.
    await revokePaymentLinkById(minted.paymentLinkId).catch((revokeErr) =>
      logger.error(
        { err: revokeErr, bookingId: booking.id, paymentLinkId: minted.paymentLinkId },
        "Failed to revoke split guest payment link after email send error"
      )
    );
    throw err;
  }

  if (emailOutcome.status === "withheld_for_booking") {
    // The unreachable token is revoked either way, but the OUTCOME depends on
    // WHY (#2258): `booking_no_emails` is a deliberate, standing decision with
    // nothing to retry until an admin clears it, whereas
    // `booking_flag_unreadable` is a transient database fault — treating that
    // as "the switch is on" would tell an operator (and, through the route
    // above, a member) something false about a booking whose switch is OFF.
    await revokePaymentLinkById(minted.paymentLinkId).catch((revokeErr) =>
      logger.error(
        { err: revokeErr, bookingId: booking.id, paymentLinkId: minted.paymentLinkId },
        "Failed to revoke split guest payment link after an undelivered email"
      )
    );
    if (emailOutcome.reason === "booking_flag_unreadable") {
      logger.error(
        { bookingId: booking.id },
        "Split guest payment link email failed closed (the booking's email setting could not be read); link revoked so a later attempt re-mints"
      );
      // Retryable, and NOT `suppressed`: nothing is wrong with the address.
      return { outcome: "transient_failure" };
    }
    logger.warn(
      { bookingId: booking.id },
      'Split guest payment link email withheld: the booking has "No emails" turned on; link revoked'
    );
    return { outcome: "withheld" };
  }

  if (emailOutcome.status !== "sent") {
    // Nothing was delivered, so the link must not stay active suppressing every
    // future send (F25, #1885). Revoked either way; only the OUTCOME differs.
    await revokePaymentLinkById(minted.paymentLinkId).catch((revokeErr) =>
      logger.error(
        { err: revokeErr, bookingId: booking.id, paymentLinkId: minted.paymentLinkId },
        "Failed to revoke split guest payment link after an undelivered email"
      )
    );
    logger.warn(
      {
        bookingId: booking.id,
        emailStatus: emailOutcome.status,
        emailReason:
          "reason" in emailOutcome ? emailOutcome.reason : undefined,
      },
      "Split guest payment link email not delivered; link revoked so a later attempt re-mints"
    );

    /*
      AN ENVIRONMENT WITHHOLD IS NOT AN UNDELIVERABLE ADDRESS (#3035 review), and
      bucketing it as `suppressed` was wrong in the most expensive place this
      epic has. The route turns `suppressed` into a 502 reading "your email
      address is undeliverable" — shown to a MEMBER — and it does that on the
      epic's own headline case: a live club upgraded without the declaration.
      The member's address is perfectly fine, the club has just not told the
      software what it is; and the same file already states this rule twenty lines
      above for the unreadable-switch case, where it says in as many words that
      "this address is undeliverable" is misinformation that points an officer at
      the wrong diagnosis.

      So the two faults map to `transient_failure` (503, "try again shortly"),
      which is what they are — they clear the moment a person corrects the
      deployment — and the confirmed COPY maps to `withheld`, which is the
      deliberate, non-transient bucket. Neither tells a member anything untrue
      about their own mailbox.
    */
    if (emailOutcome.status === "withheld_for_environment") {
      return emailOutcome.reason === "environment_non_production"
        ? { outcome: "withheld" }
        : { outcome: "transient_failure" };
    }

    // Suppressed (or placeholder) recipient: the address really is the problem.
    return { outcome: "suppressed" };
  }

  return { outcome: "sent" };
}
