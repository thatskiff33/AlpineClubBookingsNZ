import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { BookingStatus, type Prisma } from "@prisma/client";

/**
 * Server-side setter for the per-booking "No emails" switch (#2258).
 *
 * Kept out of `booking-email-suppression.ts` on purpose: that module is imported
 * by the mailer itself, and the mailer has no business pulling in the audit
 * writer. The read path (the gate) and the write path (this) stay separate.
 *
 * Owner decision D10 makes the acknowledgement mandatory, not advisory: turning
 * the switch ON requires the caller to state that it understood the consequence.
 * That is enforced HERE as well as at the API boundary, so no future caller can
 * enable the switch without one.
 */

/**
 * Whether a booking is sitting on a LIVE (made, unexpired) waitlist offer.
 *
 * Exported so #2259's acknowledgement dialog can warn about the outstanding
 * offer BEFORE the admin confirms, without re-deriving the rule: the booking
 * page evaluates the same predicate the setter below evaluates, so the dialog's
 * warning and the response flag can never disagree about what "live" means.
 */
export function bookingHasLiveWaitlistOffer(booking: {
  status: BookingStatus;
  waitlistOfferExpiresAt: Date | null;
}): boolean {
  return (
    booking.status === BookingStatus.WAITLIST_OFFERED &&
    booking.waitlistOfferExpiresAt != null &&
    booking.waitlistOfferExpiresAt.getTime() > Date.now()
  );
}

export type SetBookingNoEmailsResult =
  | {
      ok: true;
      noEmails: boolean;
      noEmailsAt: Date | null;
      noEmailsByMemberId: string | null;
      changed: boolean;
      // #2258: true when the booking is sitting on a LIVE (unexpired) waitlist
      // offer. Turning the switch on here does NOT retract that offer — the
      // clock keeps running and the member will never be told — so #2259's
      // dialog warns the admin before they confirm. Candidacy exclusion only
      // prevents FUTURE offers; it cannot undo one already made.
      hasLiveWaitlistOffer: boolean;
    }
  | { ok: false; status: 400 | 404; error: string };

export async function setBookingNoEmails(params: {
  bookingId: string;
  noEmails: boolean;
  // Required to ENABLE. Ignored when clearing: turning mail back on needs no
  // acknowledgement, and a stuck switch must always be clearable.
  acknowledged: boolean;
  actorMemberId: string;
  // Matches the nullable shape getAuditRequestContext() returns, so a route can
  // hand it straight through.
  auditRequest?: {
    id?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
}): Promise<SetBookingNoEmailsResult> {
  if (params.noEmails && params.acknowledged !== true) {
    return {
      ok: false,
      status: 400,
      error:
        'Turning off all emails for a booking requires an explicit acknowledgement that the member will not be told about confirmations, changes, payments, reminders or cancellations.',
    };
  }

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<SetBookingNoEmailsResult> => {
      const booking = await tx.booking.findUnique({
        where: { id: params.bookingId },
        select: {
          id: true,
          memberId: true,
          status: true,
          deletedAt: true,
          noEmails: true,
          noEmailsAt: true,
          noEmailsByMemberId: true,
          waitlistOfferExpiresAt: true,
        },
      });
      if (!booking || booking.deletedAt) {
        return { ok: false, status: 404, error: "Booking not found" };
      }

      const hasLiveWaitlistOffer = bookingHasLiveWaitlistOffer(booking);

      // Idempotent: setting the switch to the value it already has is a no-op
      // that reports success without rewriting the audit columns, so the
      // "who turned this on, and when" record is never overwritten by a repeat
      // click or a retried request.
      if (booking.noEmails === params.noEmails) {
        return {
          ok: true,
          noEmails: booking.noEmails,
          noEmailsAt: booking.noEmailsAt,
          noEmailsByMemberId: booking.noEmailsByMemberId,
          changed: false,
          hasLiveWaitlistOffer,
        };
      }

      const setAt = new Date();
      await tx.booking.update({
        where: { id: booking.id },
        data: params.noEmails
          ? {
              noEmails: true,
              noEmailsAt: setAt,
              noEmailsByMemberId: params.actorMemberId,
            }
          : {
              noEmails: false,
              noEmailsAt: null,
              noEmailsByMemberId: null,
            },
      });

      await createAuditLog(
        {
          action: params.noEmails
            ? "booking.noEmails.set"
            : "booking.noEmails.cleared",
          memberId: params.actorMemberId,
          actorMemberId: params.actorMemberId,
          subjectMemberId: bookingOwner(booking).memberId,
          targetId: booking.id,
          entityType: "Booking",
          entityId: booking.id,
          category: "booking",
          severity: "important",
          outcome: "success",
          summary: params.noEmails
            ? "No emails turned on for a booking"
            : "No emails turned off for a booking",
          details: params.noEmails
            ? "Admin turned off every member-facing email for this booking: confirmations, changes, payments, reminders, arrival information, cancellations, waitlist offers, chore rosters and the Xero invoice email are all withheld until it is turned back on."
            : "Admin turned member-facing emails back on for this booking. Messages withheld while the switch was on are not re-sent.",
          metadata: {
            bookingStatus: booking.status,
            noEmails: params.noEmails,
            acknowledged: params.noEmails ? true : null,
            ...(params.noEmails
              ? {}
              : {
                  previouslySetAt: booking.noEmailsAt?.toISOString() ?? null,
                  previouslySetByMemberId: booking.noEmailsByMemberId,
                }),
          },
          requestId: params.auditRequest?.id,
          ipAddress: params.auditRequest?.ipAddress,
          userAgent: params.auditRequest?.userAgent,
        },
        tx,
      );

      return {
        ok: true,
        noEmails: params.noEmails,
        noEmailsAt: params.noEmails ? setAt : null,
        noEmailsByMemberId: params.noEmails ? params.actorMemberId : null,
        changed: true,
        hasLiveWaitlistOffer,
      };
    },
  );
}
