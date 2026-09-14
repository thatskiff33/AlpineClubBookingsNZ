import type { BookingStatus, PaymentSource } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { getWaitlistOfferEmailDeliveries } from "@/lib/waitlist-offer-email-visibility";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import {
  getBookingInvoiceSyncFault,
  type BookingInvoiceSyncFault,
} from "@/lib/booking-invoice-sync-status";
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
  | "xero-invoice-sync-failed"
  | "xero-invoice-pending"
  | "xero-credit-note-pending"
  | "waitlist-offer-email-failed";

/**
 * #3033: the id of the money-waiting-for-review warning, which is NOT a provider
 * mismatch.
 *
 * Its own union rather than a fourth member of the one above. The row SHAPE is
 * shared — label, description, href, link label is exactly what a one-line admin
 * warning with an actionable path needs, and a parallel interface carrying the
 * same four fields would be a second home for one thing (`INV-SSOT`). The set of
 * IDS is not shared, because that is not a shape: it is a claim about what each
 * function can return. Folded into one union,
 * `getBookingProviderMismatches` declared `financial-review-open` as a possible
 * result even though it can never produce one, and a caller narrowing on the id
 * was handed a case that cannot happen.
 */
type BookingFinancialReviewWarningId = "financial-review-open";

/**
 * One admin warning line: what is out of step, and the one link that leads to
 * fixing it.
 *
 * Generic over its id so the two producers below share the shape without
 * sharing the vocabulary.
 */
export interface BookingWarningRow<Id extends string = string> {
  id: Id;
  label: string;
  description: string;
  href: string;
  linkLabel: string;
}

/** Provider state disagreeing with local state (#1089). */
export type BookingProviderMismatch =
  BookingWarningRow<BookingProviderMismatchId>;

/** Money on a booking waiting for a person to decide it (#3033). */
export type BookingFinancialReviewWarning =
  BookingWarningRow<BookingFinancialReviewWarningId>;

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
  getBookingInvoiceSyncFault: typeof getBookingInvoiceSyncFault;
}

const defaultDependencies: BookingProviderMismatchDependencies = {
  db: prisma as unknown as BookingProviderMismatchDb,
  loadEffectiveModuleFlags,
  getWaitlistOfferEmailDeliveries,
  getBookingInvoiceSyncFault,
};

/**
 * #3001: what the officer looking at this booking is told about its Xero
 * invoice, and what they should do next.
 *
 * WRITTEN FOR A TREASURER, NOT FOR A LOG. Each row answers the same three
 * questions in the same order — what state this booking is in, what the club can
 * see in Xero, and what happens next — because a raw provider exception tells
 * the one person who can fix this nothing they can act on.
 *
 * THE SENTENCE THAT CHANGES MOST IS "DO NOT RAISE A SECOND INVOICE". Where the
 * invoice already reached Xero the remedy inverts, and this class of partial
 * failure has standing operator guidance across this product that says *do not
 * repeat the action* (`docs/guides/xero.md`). A warning that showed a failure
 * beside an unqualified Retry would be walking an officer toward a duplicate
 * invoice in the club's accounts.
 *
 * THE LAST SENTENCE IS THE ENGINE'S, NOT OURS. When the existing recovery path
 * refuses this operation, the refusal printed here is
 * `getXeroOperationRetryMeta`'s own prose — so the booking page and the Xero
 * operations screen can never tell an officer different things about one row,
 * and the link's label says "Resolve" rather than "Retry" when there is no retry
 * to offer.
 */
function describeBookingInvoiceSyncFault(
  fault: BookingInvoiceSyncFault,
  bookingId: string,
): BookingProviderMismatch {
  const invoice = fault.invoiceNumber
    ? `Invoice ${fault.invoiceNumber}`
    : "The invoice";

  const { label, state } = {
    INVOICE_NOT_RAISED: {
      label: "No Xero invoice for this booking",
      state:
        "Raising this booking's invoice in Xero failed, so the club's accounts hold no invoice for it and nothing is asking the member to pay. The booking itself is unchanged — it has not been cancelled, and no money has moved.",
    },
    PAYMENT_NOT_RECORDED: {
      label: "Xero has the invoice, but not the payment",
      state: `${invoice} was raised in Xero, but recording the club's payment against it did not finish. Xero still shows it as awaiting payment for money the club already holds. Do not raise a second invoice.`,
    },
    MEMBER_NOT_SENT_INVOICE: {
      label: "Xero has the invoice, but the member was not sent it",
      state: `${invoice} was raised in Xero and is correct there, but sending it to the member failed, so they may not know what they owe. Do not raise a second invoice — the member needs the one that exists.`,
    },
    PARTLY_COMPLETED: {
      label: "The Xero invoice completed only in part",
      state: `${invoice} reached Xero, but a later step of the same operation did not finish. Do not repeat the action — check the invoice in Xero first, then resolve the operation from this booking's Xero activity.`,
    },
  }[fault.kind];

  /*
    The reason is `lastErrorMessage`, which `failXeroSyncOperation` put through
    `redactSensitiveText` on the way in — the only provider text on the row that
    has been redacted, and therefore the only one that may be shown to a person
    (`INV-INT-005`). The projection supplies it for a failed row and never for a
    partial one, where it would be the previous attempt's message.
  */
  const next = fault.retrySupported
    ? "You can retry it from this booking's Xero activity."
    : fault.retryBlockedReason;

  return {
    id: "xero-invoice-sync-failed",
    label,
    description: [state, fault.reason, next].filter(Boolean).join(" "),
    href: buildXeroRecordActivityUrl("Booking", bookingId),
    linkLabel: fault.retrySupported
      ? "Retry from Xero activity"
      : "Resolve from Xero activity",
  };
}

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

  /*
    #3001: the canonical invoice-create operation for this booking, read whether
    or not a payment row survives. The operation is STORED against the payment,
    but it is found by the booking's own correlation key — a booking whose
    payment row is missing or replaced would otherwise match nothing here and the
    page would report all-clear over a failed invoice.
  */
  const invoiceSyncFault = modules.xeroIntegration
    ? await deps.getBookingInvoiceSyncFault(booking.id)
    : null;

  if (invoiceSyncFault) {
    mismatches.push(
      describeBookingInvoiceSyncFault(invoiceSyncFault, booking.id),
    );
  }

  if (modules.xeroIntegration && booking.payment) {
    /*
      #3001: SUPPRESSED while a real failure is showing. This row says the outbox
      "normally catches up on its own", which is true of a booking still waiting
      and false of one whose operation has already failed — and the two rows
      together would tell an officer both that nothing is wrong yet and that
      something is. The precise row wins.
    */
    if (booking.status === "PAID" && !invoiceSyncFault) {
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
        member: { email: bookingOwner(booking).member.email },
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
): Promise<BookingFinancialReviewWarning[]> {
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
