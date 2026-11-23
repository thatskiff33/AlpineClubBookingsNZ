/**
 * #5433, owner decision D2 (23 Nov 2026): "A waitlist offer whose email was
 * never sent gets a full offer window from when the email really goes, capped
 * at the check-in date."
 *
 * The offer notice's sweep (`waitlist-offer-notices.ts`) calls this just
 * before it sends an offer email the first attempt never sent. It moves the
 * offer's deadline to a full window from now, capped at the check-in date and
 * never earlier than it was (`restartedWaitlistOfferExpiry`), and returns the
 * deadline now in force, which is the one the email then states. The attempt
 * right after the offer never calls this: its email goes out with the window
 * the offer was made with.
 *
 * WHAT IT CHANGES: `waitlistOfferExpiresAt` only. `waitlistOfferedAt` is the
 * offer's identity (the owed markers' event time, the email's event key and
 * the "same offer" check are all built from it), so it is never touched, and a
 * restarted offer is still the offer the member is sent once.
 *
 * A booking whose "No emails" switch is on keeps its deadline: its email will
 * be withheld, so a restart would hold the place longer for a member who is
 * still not told.
 *
 * LOCKS (`INV-LOCK-001`, `-002`, `-003`, `-006`): its own transaction, on the
 * lock(1) budget. The global key first, because every writer of a waitlist
 * offer's lifecycle takes it (the offer pass, `expireStaleOffers`, the confirm,
 * the revert, the past-date cancel, the admin force-confirm and return to the
 * waitlist), then the booking's own lodge key through
 * `acquireLodgeCapacityLock`, the key `expireStaleOffers` and the confirm take
 * for the same offer. The lodge id is immutable, so it is read before that key;
 * everything mutable is re-read after both. The claim is one `updateMany`
 * guarded on the status, the offer's identity and the deadline it read: a
 * claim that finds the offer confirmed, expired, re-offered or changed matches
 * nothing, and the caller sends nothing. No settings read (the club's timezone
 * is passed in), no provider call, no new advisory key.
 */
import { BookingStatus } from "@prisma/client";

import { acquireLodgeCapacityLock } from "@/lib/capacity";
import type { ClubTimeZone } from "@/lib/club-time";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { prisma } from "@/lib/prisma";
import { restartedWaitlistOfferExpiry } from "@/lib/waitlist-offer-window";

export type WaitlistOfferWindowRestart =
  /** The deadline in force, and whether this call moved it. */
  | { kind: "in-force"; expiresAt: Date; restarted: boolean }
  /** The offer is gone, no longer offered, or a different offer: send nothing. */
  | { kind: "moved-on"; why: string }
  /** No window is left to give (the cap has passed and so has the deadline). */
  | { kind: "no-window" };

export async function restartWaitlistOfferWindow({
  bookingId,
  offeredAt,
  zone,
  now = new Date(),
}: {
  bookingId: string;
  /** The offer the marker records (`waitlistOfferedAt`). */
  offeredAt: Date;
  zone: ClubTimeZone;
  now?: Date;
}): Promise<WaitlistOfferWindowRestart> {
  return prisma.$transaction(async (tx): Promise<WaitlistOfferWindowRestart> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const key = await tx.booking.findUnique({ where: { id: bookingId }, select: { lodgeId: true } });
    if (!key) return { kind: "moved-on", why: "the booking is gone" };
    await acquireLodgeCapacityLock(tx, key.lodgeId);

    const offer = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { status: true, waitlistOfferedAt: true, waitlistOfferExpiresAt: true, checkIn: true, noEmails: true },
    });
    if (!offer) return { kind: "moved-on", why: "the booking is gone" };
    if (offer.status !== BookingStatus.WAITLIST_OFFERED) return { kind: "moved-on", why: `the booking is ${offer.status}` };
    if (offer.waitlistOfferedAt?.getTime() !== offeredAt.getTime()) return { kind: "moved-on", why: "a different offer" };
    if (offer.noEmails && offer.waitlistOfferExpiresAt) {
      return { kind: "in-force", expiresAt: offer.waitlistOfferExpiresAt, restarted: false };
    }

    const expiresAt = restartedWaitlistOfferExpiry({
      sentAt: now,
      currentExpiresAt: offer.waitlistOfferExpiresAt,
      checkIn: offer.checkIn,
      zone,
    });
    if (expiresAt.getTime() <= now.getTime()) return { kind: "no-window" };
    if (expiresAt.getTime() === offer.waitlistOfferExpiresAt?.getTime()) {
      return { kind: "in-force", expiresAt, restarted: false };
    }

    const claimed = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: BookingStatus.WAITLIST_OFFERED,
        waitlistOfferedAt: offeredAt,
        waitlistOfferExpiresAt: offer.waitlistOfferExpiresAt,
      },
      data: { waitlistOfferExpiresAt: expiresAt },
    });
    if (claimed.count !== 1) return { kind: "moved-on", why: "the offer changed under the claim" };
    return { kind: "in-force", expiresAt, restarted: true };
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
}
