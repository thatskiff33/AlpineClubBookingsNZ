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
 * SO THE LAST SENTENCE AND THE LINK LABEL COME FROM ONE FIELD. `fault.action` is
 * decided once, in the projection, and both are read off it. Nothing here
 * appends "you can retry it" independently of the kind — which is how a row
 * could once read *do not repeat the action … you can retry it* under a button
 * labelled Retry. Where the action is RESOLVE and the recovery engine is what
 * refuses, the refusal printed is the engine's own prose, so the booking page
 * and the Xero operations screen can never tell an officer different things
 * about one row.
 */
function describeBookingInvoiceSyncFault(
  fault: BookingInvoiceSyncFault,
  bookingId: string,
): BookingProviderMismatch {
  const invoice = fault.invoiceNumber
    ? `Invoice ${fault.invoiceNumber}`
    : "The invoice";

  const { label, state } = describeFaultKind(fault, invoice);

  /*
    The reason is `lastErrorMessage`, which `failXeroSyncOperation` put through
    `redactSensitiveText` on the way in — the only provider text on the row that
    has been redacted, and therefore the only one that may be shown to a person
    (`INV-INT-005`). The projection supplies it for a failed row and never for a
    partial one, where it would be the previous attempt's message.
  */
  const next =
    fault.action.type === "RETRY"
      ? "You can retry it from this booking's Xero activity."
      : [
          "Resolve it from this booking's Xero activity once you have checked Xero.",
          fault.action.engineReason,
        ]
          .filter(Boolean)
          .join(" ");

  return {
    id: "xero-invoice-sync-failed",
    label,
    description: [state, fault.reason, next].filter(Boolean).join(" "),
    href: buildXeroRecordActivityUrl("Booking", bookingId),
    linkLabel:
      fault.action.type === "RETRY"
        ? "Retry from Xero activity"
        : "Resolve from Xero activity",
  };
}

/**
 * The two sentences that differ per kind.
 *
 * MEMBER_NOT_SENT_INVOICE is three faults wearing one name, and they want three
 * different things from an officer. The middle one is the reason this is split
 * at all: when the booking's "No emails" switch could not be READ, telling an
 * officer to send the invoice from Xero can email a booking the club silenced —
 * the conflation this codebase calls money-adjacent. The switch has to be read
 * first, and the copy says so.
 */
function describeFaultKind(
  fault: BookingInvoiceSyncFault,
  invoice: string,
): { label: string; state: string } {
  switch (fault.kind) {
    case "INVOICE_NOT_RAISED":
      return {
        label: "No Xero invoice for this booking",
        state:
          "Raising this booking's invoice in Xero failed, and the club has no invoice recorded against it, so nothing is asking the member to pay. The booking itself is unchanged — it has not been cancelled, and no money has moved.",
      };
    case "INVOICE_STATE_UNKNOWN":
      return {
        label: "Check Xero: this booking's invoice was left mid-flight",
        state:
          "This booking's invoice operation stopped part-way and never reported what happened, so the club cannot tell from here whether Xero holds an invoice for it. Check Xero for an invoice against this booking BEFORE doing anything else — if one is there, raising another would double-bill the member. An operation still stuck part-way has to be reset on the Xero operations screen before it can be retried or resolved. The booking itself is unchanged.",
      };
    case "PAYMENT_NOT_RECORDED":
      return {
        label: "Xero has the invoice, but not the payment",
        state: `${invoice} was raised in Xero, but recording the club's payment against it did not finish. Xero still shows it as awaiting payment for money the club already holds. Do not raise a second invoice.`,
      };
    case "MEMBER_NOT_SENT_INVOICE":
      return describeUnsentInvoice(fault.emailFailureCause, invoice);
    case "PARTLY_COMPLETED":
      return {
        label: "The Xero invoice completed only in part",
        state: `${invoice} reached Xero, but a later step of the same operation did not finish. Do not repeat the action — check the invoice in Xero first.`,
      };
  }
}

/** The three reasons the member never got their invoice, and their three remedies. */
function describeUnsentInvoice(
  cause: Extract<
    BookingInvoiceSyncFault,
    { kind: "MEMBER_NOT_SENT_INVOICE" }
  >["emailFailureCause"],
  invoice: string,
): { label: string; state: string } {
  const raised = `${invoice} was raised in Xero and is correct there`;

  switch (cause) {
    case "NO_EMAILS_UNREADABLE":
      return {
        label: "Xero has the invoice; whether to email it could not be decided",
        state: `${raised}, but the booking's "No emails" switch could not be read, so nothing was sent to the member. CHECK THAT SWITCH FIRST: if it is on, the club has deliberately silenced this booking and the invoice must not be emailed. Do not raise a second invoice.`,
      };
    case "ROLE_UNCONFIRMED":
      return {
        label: "Xero has the invoice; this site is not cleared to email it",
        state: `${raised}, but this installation's role is not confirmed, so nothing was transmitted to the member. Confirm the role under environment safety, then send that one invoice from Xero by hand. Do not raise a second invoice.`,
      };
    case "PROVIDER":
      return {
        label: "Xero has the invoice, but the member was not sent it",
        state: `${raised}, but Xero could not email it to the member, so they may not know what they owe. Send it from Xero by hand. Do not raise a second invoice — the member needs the one that exists.`,
      };
    case null:
      // Recorded before the writer named the cause (#3001). Say what is known
      // and no more, and do not hand out a remedy that fits only two of three.
      return {
        label: "Xero has the invoice, but the member was not sent it",
        state: `${raised}, but sending it to the member did not happen, so they may not know what they owe. Check the operation in Xero activity for what stopped it. Do not raise a second invoice — the member needs the one that exists.`,
      };
  }
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
    #3001: the canonical invoice-create operation for this booking. The operation
    is STORED against the payment, but it is found by the booking's own
    correlation key — a booking whose payment row has not been created yet would
    otherwise match nothing here and the page would report all-clear over a
    failed invoice.

    WHO SEES IT: the caller (`booking-detail-admin-tools.ts`) runs this read
    behind `isAdmin` — a FULL ADMIN, not the wider admin-tools audience. A
    booking officer sees the card without this row. That gate is inherited rather
    than introduced here: it covers every provider mismatch, and #3001 preserves
    the existing boundary rather than widening one (the issue's required
    implementation 7). The release note and the operator guide say so plainly.
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
