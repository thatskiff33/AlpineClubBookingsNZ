import type { BookingStatus, PaymentSource } from "@prisma/client";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { getWaitlistOfferEmailDeliveries } from "@/lib/waitlist-offer-email-visibility";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import { bookingHasOpenFinancialReview } from "@/lib/booking-financial-review-visibility";

/**
 * Issue #1089: per-booking provider-mismatch surfacing. The aggregate views
 * of these states already exist on /admin/stuck-states (xero-missing-invoices,
 * xero-refunds-missing-credit-notes, waitlist-offer-email-failures); this
 * answers the same questions for the one booking an admin is looking at, so
 * the mismatch is visible without scanning the dashboard.
 *
 * Read-only: detection mirrors the stuck-state queries and makes no provider
 * calls.
 */

type BookingProviderMismatchId =
  | "xero-invoice-pending"
  | "xero-credit-note-pending"
  | "waitlist-offer-email-failed"
  // #3033: not a provider mismatch, and it is rendered in its own block on the
  // Admin tools card rather than under "Provider state out of step". It reuses
  // this row SHAPE — label, description, href, link label — because that is
  // exactly what a one-line admin warning with an actionable path needs, and
  // inventing a parallel interface with the same four fields would be a second
  // home for one thing (`INV-SSOT`).
  | "financial-review-open";

export interface BookingProviderMismatch {
  id: BookingProviderMismatchId;
  label: string;
  description: string;
  href: string;
  linkLabel: string;
}

type MismatchBooking = {
  id: string;
  status: BookingStatus;
  deletedAt: Date | null;
  waitlistOfferedAt: Date | null;
  waitlistOfferExpiresAt: Date | null;
  // #2258: a deliberately-silenced booking is not a delivery failure — unless
  // it is sitting on a live offer, which needs the expiry to detect.
  noEmails: boolean;
  member: { email: string };
  payment: {
    id: string;
    source: PaymentSource;
    refundedAmountCents: number;
    xeroInvoiceId: string | null;
    xeroRefundCreditNoteId: string | null;
  } | null;
};

type BookingProviderMismatchDb = {
  booking: {
    findUnique(args: unknown): Promise<unknown>;
  };
  xeroSyncOperation: {
    count(args: unknown): Promise<number>;
  };
};

export interface BookingProviderMismatchDependencies {
  db: BookingProviderMismatchDb;
  loadEffectiveModuleFlags: typeof loadEffectiveModuleFlags;
  getWaitlistOfferEmailDeliveries: typeof getWaitlistOfferEmailDeliveries;
}

const defaultDependencies: BookingProviderMismatchDependencies = {
  db: prisma as unknown as BookingProviderMismatchDb,
  loadEffectiveModuleFlags,
  getWaitlistOfferEmailDeliveries,
};

export async function getBookingProviderMismatches(
  bookingId: string,
  input?: { deps?: Partial<BookingProviderMismatchDependencies> },
): Promise<BookingProviderMismatch[]> {
  const deps = { ...defaultDependencies, ...input?.deps };

  const booking = (await deps.db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      waitlistOfferedAt: true,
      waitlistOfferExpiresAt: true,
      noEmails: true,
      member: { select: { email: true } },
      payment: {
        select: {
          id: true,
          source: true,
          refundedAmountCents: true,
          xeroInvoiceId: true,
          xeroRefundCreditNoteId: true,
        },
      },
    },
  })) as MismatchBooking | null;

  if (!booking || booking.deletedAt) {
    return [];
  }

  const modules = await deps.loadEffectiveModuleFlags();
  const mismatches: BookingProviderMismatch[] = [];

  if (modules.xeroIntegration && booking.payment) {
    if (booking.status === "PAID") {
      const succeededInvoiceOperations = await deps.db.xeroSyncOperation.count({
        where: {
          entityType: "INVOICE",
          status: "SUCCEEDED",
          localModel: "Payment",
          localId: booking.payment.id,
        },
      });

      if (succeededInvoiceOperations === 0) {
        mismatches.push({
          id: "xero-invoice-pending",
          label: "Paid, Xero invoice pending",
          description:
            "The money is received, but no completed Xero invoice operation exists for this payment yet. The outbox normally catches up on its own; if it stays pending, check the operation queue for a failure.",
          href: buildXeroRecordActivityUrl("Payment", booking.payment.id),
          linkLabel: "Review Xero activity",
        });
      }
    }

    if (
      booking.payment.source === "STRIPE" &&
      booking.payment.refundedAmountCents > 0 &&
      booking.payment.xeroInvoiceId !== null &&
      booking.payment.xeroRefundCreditNoteId === null
    ) {
      mismatches.push({
        id: "xero-credit-note-pending",
        label: "Refunded, Xero credit note pending",
        description:
          "A Stripe refund has been recorded but the matching Xero credit note has not been created yet, so the accounting ledger is behind the money movement.",
        href: buildXeroRecordActivityUrl("Payment", booking.payment.id),
        linkLabel: "Review Xero activity",
      });
    }
  }

  if (modules.waitlist && booking.status === "WAITLIST_OFFERED") {
    const deliveries = await deps.getWaitlistOfferEmailDeliveries([
      {
        id: booking.id,
        status: booking.status,
        waitlistOfferedAt: booking.waitlistOfferedAt,
        waitlistOfferExpiresAt: booking.waitlistOfferExpiresAt,
        // #2258: a deliberately-silenced booking is not a delivery failure —
        // unless its offer is still live, which the expiry decides.
        noEmails: booking.noEmails,
        member: { email: booking.member.email },
      },
    ]);

    if (deliveries.get(booking.id)?.needsOperatorAction) {
      mismatches.push({
        id: "waitlist-offer-email-failed",
        label: "Waitlist offer email undelivered",
        description:
          "A place has been offered, but the offer email is missing, bounced, exhausted its retries, or was withheld because the booking is set to send no emails — the member may not know their offer is ticking down.",
        href: "/admin/waitlist",
        linkLabel: "Open waitlist queue",
      });
    }
  }

  return mismatches;
}

/**
 * #3033: the booking has money held for review, so the Admin tools card says so.
 *
 * A separate function from `getBookingProviderMismatches` above, and NOT folded
 * into its list, because that list renders under a heading that says "Provider
 * state out of step" — Xero and the waitlist mailer disagreeing with local
 * state. A financial review is not a provider disagreement: the local state is
 * exactly right and it is the club that owes a decision. Filing it under that
 * heading would misdescribe it to the one person able to resolve it.
 *
 * Returns at most one row. The card is a warning, not a queue: an admin does not
 * need to be told twice that this booking has unresolved money, and the queue
 * the link goes to is where the individual reviews live.
 *
 * NO AMOUNT AND NO EVIDENCE HERE, deliberately. The amount is the question, not
 * a fact, and repeating the evidence on a second screen would be a second home
 * for it (owner decision D3 asks for a LINK). The row is the pointer.
 */
export async function getBookingFinancialReviewWarnings(
  bookingId: string,
): Promise<BookingProviderMismatch[]> {
  if (!(await bookingHasOpenFinancialReview(bookingId))) return [];

  return [
    {
      id: "financial-review-open",
      label: "Money on this booking is waiting for review",
      description:
        "A change to this booking saved, but the refund or credit for it could not be worked out from what the booking has stored, so nothing has been refunded or credited and no amount has been assumed. The member has been told their change saved and that the club is working the adjustment out.",
      href: "/admin/payments",
      linkLabel: "Open the settlement queue",
    },
  ];
}
