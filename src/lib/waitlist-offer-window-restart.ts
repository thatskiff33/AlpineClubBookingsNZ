/**
 * #5433, owner decision D2 (23 Nov 2026): "A waitlist offer whose email was
 * never sent gets a full offer window from when the email really goes, capped
 * at the check-in date" (D6: the start of the check-in date in the club's time
 * zone).
 *
 * The offer notice's sweep (`waitlist-offer-notices.ts`) calls this just
 * before it sends an offer email the first attempt never sent. It answers the
 * deadline the email must state, moving it first when the rules below allow.
 * The attempt right after the offer never calls this: its email goes out with
 * the window the offer was made with.
 *
 * - ONE RESTART PER OFFER (review C). The deadline moves only while it is still
 *   the offer's original deadline (`waitlistOfferExpiresAt(offeredAt)`), and the
 *   claim is guarded on exactly that value. A later sweep, after a send that
 *   failed again, finds the restarted deadline and sends with it as it stands.
 *   So a send that keeps failing cannot keep holding the place: the restart
 *   moves the deadline once, to at most `min(that sweep's now + window, cap)`.
 * - A FLOOR (review D). When less than `WAITLIST_NOTICE_SWEEP_AFTER_MS` would
 *   remain of the deadline in force (restarted or not), the answer is
 *   `no-window`: the expiry could run before the email's row exists, and a
 *   member would be sent an offer whose place is already offered on. The
 *   caller sends no offer email and alerts the officers instead.
 * - NO EMAIL CAN GO (review L). A booking whose "No emails" switch is on, or
 *   whose owner has no address or a placeholder one, keeps its deadline: its
 *   email would be withheld or skipped, so a restart would hold the place
 *   longer for a member who is still not told.
 * - WHAT IT CHANGES: `waitlistOfferExpiresAt` only (and `updatedAt`, which
 *   Prisma writes). `waitlistOfferedAt` is the offer's identity (the owed
 *   markers' event time, the email's event key and the "same offer" check are
 *   built from it), so a restarted offer is still the offer the member is sent
 *   once. The cross-lodge confirm's later phases treat a change of only those
 *   two columns as the same offer (`waitlist-offer-epoch.ts`, review A).
 *
 * LOCKS (`INV-LOCK-001`, `-002`, `-003`, `-006`): its own transaction, on the
 * lock(1) budget. The global key first, because every writer of a waitlist
 * offer's lifecycle takes it (the offer pass, `expireStaleOffers`, the same-lodge
 * and cross-lodge confirms, the reverts, the past-date cancel, the admin
 * force-confirm and return to the waitlist), then the booking's own lodge key
 * through `acquireLodgeCapacityLock`, the key `expireStaleOffers` and the confirm
 * take for the same offer. The lodge id is immutable, so it is read before that
 * key; everything mutable is re-read after both. The claim is one `updateMany`
 * guarded on the status, the offer's identity and its original deadline: a
 * claim that finds the offer confirmed, expired, re-offered or changed matches
 * nothing, and the caller sends nothing. No settings read (the club's timezone
 * and the sweep's clock are passed in), no provider call, no new advisory key.
 * Stated limit: the "No emails" switch is set without lock(1), so the re-read
 * can be stale by a moment; the only effect is an extended window for an email
 * that is then withheld.
 */
import { BookingStatus, Prisma } from "@prisma/client";

import { bookingOwnerEmail } from "@/lib/booking-owner";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import type { ClubTimeZone } from "@/lib/club-time";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { canReceiveEmail } from "@/lib/placeholder-contact-email";
import { prisma } from "@/lib/prisma";
import { waitlistOfferMovedOn } from "@/lib/waitlist-offer-email-state";
import {
  restartedWaitlistOfferExpiry,
  WAITLIST_NOTICE_SWEEP_AFTER_MS,
  waitlistOfferExpiresAt,
} from "@/lib/waitlist-offer-window";

export type WaitlistOfferWindowRestart =
  /** The deadline in force, and whether this call moved it (and from what). */
  | { kind: "in-force"; expiresAt: Date; restarted: false }
  | { kind: "in-force"; expiresAt: Date; restarted: true; previousExpiresAt: Date }
  /** The offer is gone, no longer offered, or a different offer: send nothing. */
  | { kind: "moved-on"; why: string }
  /** Too little of a window is left to tell the member about (the floor), or none. */
  | { kind: "no-window" };

const RESTART_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  status: true,
  waitlistOfferedAt: true,
  waitlistOfferExpiresAt: true,
  checkIn: true,
  noEmails: true,
  memberId: true,
  member: { select: { email: true } },
  organisation: { select: { name: true, email: true } },
});

export async function restartWaitlistOfferWindow({
  bookingId,
  offeredAt,
  zone,
  now,
}: {
  bookingId: string;
  /** The offer the marker records (`waitlistOfferedAt`). */
  offeredAt: Date;
  zone: ClubTimeZone;
  /** The sweep's own clock, so the restarted deadline and its stated bound use one instant. */
  now: Date;
}): Promise<WaitlistOfferWindowRestart> {
  return prisma.$transaction(async (tx): Promise<WaitlistOfferWindowRestart> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const key = await tx.booking.findUnique({ where: { id: bookingId }, select: { lodgeId: true } });
    if (!key) return { kind: "moved-on", why: "the booking is gone" };
    await acquireLodgeCapacityLock(tx, key.lodgeId);

    const offer = await tx.booking.findUnique({ where: { id: bookingId }, select: RESTART_SELECT });
    if (!offer) return { kind: "moved-on", why: "the booking is gone" };
    const movedOn = waitlistOfferMovedOn(offer, offeredAt); // the one rule (round 5, F3)
    if (movedOn !== null) return { kind: "moved-on", why: movedOn };

    const current = offer.waitlistOfferExpiresAt;
    const original = waitlistOfferExpiresAt(offeredAt);
    const emailCanGo = !offer.noEmails && canReceiveEmail(bookingOwnerEmail(offer));
    // Restart only an offer still on its original deadline, whose email can go.
    const restartable = emailCanGo && current !== null && current.getTime() === original.getTime();
    const expiresAt = restartable
      ? restartedWaitlistOfferExpiry({ sentAt: now, currentExpiresAt: current, checkIn: offer.checkIn, zone })
      : current;
    if (!expiresAt || expiresAt.getTime() - now.getTime() < WAITLIST_NOTICE_SWEEP_AFTER_MS) return { kind: "no-window" };
    if (!restartable || expiresAt.getTime() === current!.getTime()) return { kind: "in-force", expiresAt, restarted: false };

    const claimed = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: BookingStatus.WAITLIST_OFFERED,
        waitlistOfferedAt: offeredAt,
        waitlistOfferExpiresAt: original,
      },
      data: { waitlistOfferExpiresAt: expiresAt },
    });
    if (claimed.count !== 1) return { kind: "moved-on", why: "the offer changed under the claim" };
    return { kind: "in-force", expiresAt, restarted: true, previousExpiresAt: original };
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
}
