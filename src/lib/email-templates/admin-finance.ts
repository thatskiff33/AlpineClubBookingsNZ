/**
 * Admin alerts raised by a money EVENT: a payment failure, a duplicate or late
 * capture, a settlement conflict, a hand-back that needs doing by hand, a
 * refund appeal, and the two Xero sync faults.
 *
 * The family boundary is `src/lib/email/admin-alerts-finance.ts`. The two
 * SCHEDULED reconciliation reports from the same sender live in
 * `./admin-xero-reports` — split off for size, and because a report renders a
 * whole tabular document rather than a single alert.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  formatCents,
  heading,
  infoTable,
  layout,
  paragraph,
} from "./layout";
import {
  duplicateCaptureRefundOutcomeParagraph,
  lateCaptureAutoRefundLeadParagraph,
  lateCaptureAutoRefundOutcomeParagraph,
  lateCaptureHandBackConflictOutcomeParagraph,
  lateCapturePaymentLabel,
} from "@/lib/email-message-notes";
import { emailPalette } from "@/lib/email-theme";
import {
  emailCalendarDay,
  emailCalendarDayOrUnknown,
  emailClubDateTime,
} from "@/lib/email-templates-club-time";

// ---- N-04: Admin Alert — Payment Failure ----

export function adminPaymentFailureTemplate(data: {
  memberName: string;
  /**
   * NULLABLE, and that is load-bearing rather than defensive (#3113 review).
   *
   * This is the club's general payment-anomaly alert, and three of its senders
   * reach it from a money event whose booking they could not resolve — a
   * superseded group-settlement intent, a paid settlement invoice whose group
   * detail is gone, a stalled recovery queue. Those senders already pass
   * `memberName: "Unknown group organiser"`, so the shape is established: the
   * alert still has to go out, naming what IS known.
   *
   * Before this was nullable they passed `?? new Date()` instead, which is a
   * wall-clock instant — and `emailCalendarDay` REFUSES one, correctly, because
   * a lodge night is a stored calendar day and projecting an instant onto one is
   * the defect epic #2988 exists to remove. But both callers wrap the send in a
   * `catch` that only logs, so the refusal did not surface a bad date: it
   * deleted the alert. That alert is the only notice that an organiser has been
   * charged with nothing settled, so losing it is strictly worse than printing
   * one odd field.
   *
   * `null` renders "Unknown". A caller that HAS the night keeps passing it and
   * keeps the refusal, which is the guard doing its job.
   */
  checkIn: Date | null;
  checkOut: Date | null;
  amountCents: number;
  errorMessage: string;
  /**
   * The searchable identifier for whatever raised this alert. USUALLY a Stripe
   * payment intent id — but this template is the club's general payment-anomaly
   * alert and its senders also pass a Xero invoice id, or (on the cash /
   * off-Xero mark-paid, which has neither by definition) the booking id. The
   * row is therefore labelled "Reference", not "Stripe PI": a label that names
   * the wrong system sends an officer hunting in Stripe for something that was
   * never there. The parameter keeps its historical name because every caller
   * uses it.
   */
  paymentIntentId: string;
}): string {
  return layout(`
    ${heading("Payment Failed")}
    ${alertBox("A payment has failed and may require manual attention.", "warning")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDayOrUnknown(data.checkIn) },
      { label: "Check-out", value: emailCalendarDayOrUnknown(data.checkOut) },
      { label: "Amount", value: formatCents(data.amountCents) },
      { label: "Error", value: escapeHtml(data.errorMessage) },
      { label: "Reference", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("View Payments", BASE_URL + "/admin/payments")}
  `);
}

/**
 * #1992 / #2007 — dedicated admin alert for the duplicate-capture auto-refund.
 * A SECOND, distinct Stripe capture arrived on a booking already settled by a
 * different intent (the residual #1967 split-child window), so the duplicate
 * charge is auto-refunded. This replaces the generic payment-anomaly template on
 * both outcomes so the copy states the real situation instead of reading as a
 * payment failure. `refundFailed` selects the variant (one-template-with-boolean
 * precedent, like adminSplitSettlementUnpaidTemplate's parentUnpaid):
 * - false: the duplicate charge was refunded in full inline — no action needed;
 * - true: the inline refund could not complete, a durable recovery operation is
 *   queued and the recovery cron will retry it — watch the recovery queue.
 * No bearer token, so this is not sensitive-log material.
 */

export function adminDuplicateCaptureRefundTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  settledPaymentIntentId: string | null;
  operationReference: string;
  errorMessage?: string | null;
  reviewUrl: string;
  refundFailed: boolean;
}): string {
  const settledBy = data.settledPaymentIntentId
    ? escapeHtml(data.settledPaymentIntentId)
    : "another capture";
  return layout(`
    ${heading(
      data.refundFailed
        ? "Duplicate Capture Auto-Refund Failed — Retry Queued"
        : "Duplicate Card Capture Auto-Refunded"
    )}
    ${
      data.refundFailed
        ? alertBox(
            "A duplicate card charge could not be automatically refunded. A durable retry is queued — watch the recovery queue and confirm the refund lands.",
            "warning"
          )
        : alertBox(
            "A duplicate card charge was automatically refunded in full — no action is needed.",
            "success"
          )
    }
    ${
      // Static developer-authored copy (no member data), so it is emitted raw
      // exactly as before — the shared helper only removes the duplication.
      paragraph(duplicateCaptureRefundOutcomeParagraph(data.refundFailed))
    }
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      {
        label: data.refundFailed ? "Amount to refund" : "Amount refunded",
        value: formatCents(data.amountCents),
      },
      { label: "Duplicate Stripe PI", value: escapeHtml(data.paymentIntentId) },
      { label: "Settled by", value: settledBy },
      {
        label: "Recovery operation",
        value: escapeHtml(data.operationReference),
      },
      ...(data.refundFailed && data.errorMessage
        ? [{ label: "Failure detail", value: escapeHtml(data.errorMessage) }]
        : []),
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * #2761 — the admin alert for an automatically refunded late capture.
 *
 * WHY IT IS NOT `adminPaymentFailureTemplate`. That template's heading is
 * "Payment Failed" and its alert box says a payment "has failed and may require
 * manual attention". Neither is true here: Stripe captured a booking-change
 * payment after the booking was already cancelled, and the money went straight
 * back to the member. An operator who filters or skims "Payment Failed" mail
 * triages this as noise, which is exactly what #2761 was filed about.
 *
 * IT NAMES WHICH POPULATION IT IS, because the two need different follow-up. On a
 * DELETED booking, deleting it may have been the mistake, and putting that right
 * means remaking the booking and charging the member again — the refund has gone.
 * On a booking that is merely cancelled, the refund is normally the expected
 * outcome and there is usually nothing to do at all. `bookingDeleted` selects the
 * wording (the one-template-with-boolean precedent used by
 * `adminDuplicateCaptureRefundTemplate`), so there is still exactly ONE
 * notification for this event (`INV-ADDPAY-037`).
 *
 * No bearer token and no member address, so this is not sensitive-log material.
 */
export function adminLateCaptureAutoRefundTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  bookingId: string;
  bookingDeleted: boolean;
  /**
   * #2773: which capture this was. The copy used to hard-code "a booking-change
   * payment" and "the supplementary Xero invoice", which are both false about a
   * booking's OWN payment — so routing the second late-capture handler through
   * this template unchanged would have misdescribed the event.
   */
  captureKind: "modification" | "primary";
  reviewUrl: string;
}): string {
  // #2773: sentence-initial, so the shared label is capitalised here and nowhere
  // else — the label itself stays a bare noun phrase for mid-sentence use.
  const paymentLabel = lateCapturePaymentLabel(data.captureKind);
  const capitalisedPaymentLabel =
    paymentLabel.charAt(0).toUpperCase() + paymentLabel.slice(1);
  return layout(`
    ${heading(
      data.bookingDeleted
        ? "Payment Refunded Automatically — Booking Already Deleted"
        : "Payment Refunded Automatically — Booking Already Cancelled"
    )}
    ${alertBox(
      `${capitalisedPaymentLabel} was captured after the booking had already been ${
        data.bookingDeleted ? "deleted" : "cancelled"
      }. It has been refunded in full automatically — there is nothing to pay back.`,
      "success"
    )}
    ${
      // The SAME paragraph the {{lateCaptureLeadNote}} token renders, so an
      // admin's saved default cannot describe a different capture — or a
      // different Xero consequence — from the mail (#2268 convention, #2773).
      paragraph(lateCaptureAutoRefundLeadParagraph(data.captureKind))
    }
    ${
      // The SAME sentence the {{refundOutcomeNote}} token renders in the
      // admin-editable body (#2268 convention): one source, so the hand-built
      // HTML and an admin's default can never say different things about which
      // population this was. Developer-authored copy with no member data in it,
      // so it is emitted raw exactly like its duplicate-capture sibling.
      paragraph(lateCaptureAutoRefundOutcomeParagraph(data.bookingDeleted))
    }
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Amount refunded", value: formatCents(data.amountCents) },
      {
        label: "Booking status",
        value: data.bookingDeleted
          ? "Cancelled and deleted"
          : "Cancelled, still on file",
      },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Stripe PI", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * #2774 — the alert for a late capture that collided with a hand-back an operator
 * had already made. Two directions, one template.
 *
 * WHY IT IS NOT `adminLateCaptureAutoRefundTemplate` WITH A FLAG. That template's
 * heading is "Payment Refunded Automatically" and its alert box says the money has
 * gone back and there is nothing to pay back. On the withheld arm every one of
 * those statements is false, and on the double-payment arm "there is nothing to pay
 * back" is the opposite of the truth. A boolean that has to rewrite the heading,
 * the alert box, the lead paragraph and the subject is not a variant — it is a
 * different mail wearing the same registry key, which would also mean one
 * admin-editable body having to be correct about a refund that happened AND one
 * that did not. Its own entry, for the same reason `admin-late-capture-auto-refund`
 * is not a variant of `admin-payment-failure` (`INV-ADDPAY-038`).
 *
 * WHY THE TWO DIRECTIONS *DO* SHARE ONE TEMPLATE. They are one situation — an
 * operator's hand-back and an automatic refund both claiming the same capture — and
 * the reader's job is the same on both: reconcile this capture against that
 * hand-back. `refundSent` selects the sentence that says which way the money went,
 * composed once in `lateCaptureHandBackConflictOutcomeParagraph` and shared with
 * the `{{handBackConflictNote}}` token. That is the
 * `adminDuplicateCaptureRefundTemplate` / `refundFailed` precedent applied exactly.
 *
 * `warning` on both arms rather than a new `error` colour: the shared `alertBox`
 * primitive offers info/warning/success, and adding a fourth colour for one
 * template would change a primitive every other mail depends on to carry a
 * distinction the heading, the box's own words and the outcome paragraph already
 * state in full.
 *
 * No bearer token and no member address, so this is not sensitive-log material.
 */
export function adminLateCaptureHandBackConflictTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  bookingId: string;
  bookingDeleted: boolean;
  captureKind: "modification" | "primary";
  /**
   * The amount the operator's own hand-back task recorded, in integer cents, when
   * it is known. Printed so a reader can see whether the hand-back covered the
   * whole capture — nothing here refunds a difference. `null` on the
   * double-payment arm, which is detected from the record writer's outcome after
   * the refund and does not re-read the row.
   */
  handBackAmountCents: number | null;
  refundSent: boolean;
  reviewUrl: string;
}): string {
  const paymentLabel = lateCapturePaymentLabel(data.captureKind);
  return layout(`
    ${heading(
      data.refundSent
        ? "Payment May Have Been Refunded Twice — Reconcile By Hand"
        : "Automatic Refund Withheld — Already Paid Back By Hand"
    )}
    ${alertBox(
      data.refundSent
        ? `${paymentLabel.charAt(0).toUpperCase() + paymentLabel.slice(1)} was refunded automatically at the same moment an operator recorded paying it back by hand. The member may have been paid twice — please reconcile.`
        : `${paymentLabel.charAt(0).toUpperCase() + paymentLabel.slice(1)} was captured after the booking had already been ${
            data.bookingDeleted ? "deleted" : "cancelled"
          }, and an operator had already paid it back by hand. The automatic refund was NOT sent — please confirm the hand-back.`,
      "warning"
    )}
    ${
      // The SAME sentence the {{handBackConflictNote}} token renders, so an
      // admin's saved default cannot tell an operator the money went out when it
      // did not, or the reverse (#2268 convention).
      paragraph(lateCaptureHandBackConflictOutcomeParagraph(data.refundSent))
    }
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Amount captured", value: formatCents(data.amountCents) },
      ...(data.handBackAmountCents === null
        ? []
        : [
            {
              label: "Recorded as paid back by hand",
              value: formatCents(data.handBackAmountCents),
            },
          ]),
      {
        label: "Automatic refund sent",
        value: data.refundSent ? "Yes — on top of the hand-back" : "No",
      },
      {
        label: "Booking status",
        value: data.bookingDeleted
          ? "Cancelled and deleted"
          : "Cancelled, still on file",
      },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Stripe PI", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

// ---- B5 (#2262): Admin Alert — manual settlement vs inbound Xero PAID ----
//
// The reciprocal fence. The club appears to hold BOTH a cash settlement this
// system recorded and a bank transfer Xero reports against the same booking.
// This is money that must be reconciled by a human — the pipeline deliberately
// writes nothing further, so the alert is the whole remediation path.
export function adminManualSettlementConflictTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  bookingId: string;
  bookingStatus: string;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Cash Settlement vs Xero Payment — Reconcile By Hand")}
    ${alertBox(
      "This booking looks paid TWICE: once as a cash / off-Xero settlement recorded here, and again by a payment Xero now reports against its invoice. Nothing further has been written — please reconcile.",
      "warning"
    )}
    ${paragraph(
      "An admin recorded this booking's payment manually (cash, or a bank transfer that never reached Xero). Xero has since reported the booking's invoice as PAID. The system stopped rather than settling it a second time or minting member credit, so the two records now disagree and only a person can decide which money is real."
    )}
    ${paragraph(
      "Check whether the Xero payment is genuinely separate funds — a second payment that needs refunding — or the same money reaching Xero late. Reverse the manual settlement, or refund the duplicate, whichever is true."
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Booking status", value: escapeHtml(data.bookingStatus) },
      { label: "Amount recorded as cash", value: formatCents(data.amountCents) },
      {
        label: "Xero invoice",
        value: data.xeroInvoiceNumber
          ? escapeHtml(data.xeroInvoiceNumber)
          : "unknown",
      },
    ])}
    ${
      data.xeroInvoiceUrl
        ? button("Open the invoice in Xero", data.xeroInvoiceUrl)
        : ""
    }
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

// ---- B5 (#2262): Admin Alert — manual refund task raised ----
//
// A cash-settled booking was cancelled. There is no card to refund and no Xero
// credit note to raise, so the money has to be handed back by a person. The
// task is durable; this alert is the nudge, not the record.
export function adminManualRefundTaskTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  refundAmountCents: number;
  bookingId: string;
  reason: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Manual Refund Needed — Cash Booking Cancelled")}
    ${alertBox(
      "A booking settled in cash (or by an off-Xero bank transfer) has been cancelled. The refund has to be paid back by hand — nothing was refunded automatically.",
      "warning"
    )}
    ${paragraph(
      "The member's cancellation refund has been worked out under the club's normal policy, but there is no card charge to reverse and no Xero invoice to credit, so the system has raised a hand-back task instead of pretending money moved. The member has been told the club will arrange the refund."
    )}
    ${paragraph(
      "Pay the member back, then mark the task complete on the payments board so the ledger records the refund. If the member declines it, or it was settled another way, dismiss the task with a note."
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Amount to refund", value: formatCents(data.refundAmountCents) },
      { label: "Reason", value: escapeHtml(data.reason) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

// ---- N-05: Admin Alert — Xero Sync Error ----

export function adminXeroSyncErrorTemplate(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
  timestamp: Date;
}): string {
  return layout(`
    ${heading("Xero Sync Error")}
    ${alertBox("A Xero integration error occurred and may require attention.", "warning")}
    ${infoTable([
      { label: "Error Type", value: escapeHtml(data.errorType) },
      { label: "Operation", value: escapeHtml(data.operation) },
      { label: "Error Message", value: escapeHtml(data.errorMessage) },
      { label: "Timestamp", value: emailClubDateTime(data.timestamp) },
    ])}
    ${button("View Xero Status", BASE_URL + "/admin/xero")}
  `);
}

export function adminXeroRepeatedFailureTemplate(data: {
  correlationKey: string;
  failureCount: number;
  windowHours: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectUrl: string | null;
  latestErrorMessage: string | null;
  timestamp: Date;
}): string {
  const p = emailPalette();
  const infoRows = [
    { label: "Correlation Key", value: escapeHtml(data.correlationKey) },
    {
      label: "Failures in Window",
      value: `${data.failureCount} in the last ${data.windowHours} hour${data.windowHours === 1 ? "" : "s"}`,
    },
    { label: "Entity", value: escapeHtml(data.entityType) },
    { label: "Operation", value: escapeHtml(data.operationType) },
    {
      label: "Local Record",
      value:
        data.localModel && data.localId
          ? escapeHtml(`${data.localModel} ${data.localId}`)
          : "Unavailable",
    },
    {
      label: "Latest Error",
      value: escapeHtml(data.latestErrorMessage ?? "Unavailable"),
    },
    {
      label: "Timestamp",
      value: emailClubDateTime(data.timestamp),
    },
  ];

  const links: string[] = [];
  if (data.localUrl) {
    links.push(`<a href="${escapeHtml(BASE_URL + data.localUrl)}" style="color: ${p.gold}; text-decoration: underline;">Open local record</a>`);
  }
  if (data.xeroObjectUrl) {
    links.push(`<a href="${escapeHtml(data.xeroObjectUrl)}" style="color: ${p.gold}; text-decoration: underline;">Open Xero object</a>`);
  }

  return layout(`
    ${heading("Repeated Xero Failures")}
    ${alertBox("The same Xero sync correlation key has failed repeatedly and now needs operator attention.", "warning")}
    ${infoTable(infoRows)}
    ${links.length > 0 ? paragraph(links.join(" &nbsp;|&nbsp; ")) : ""}
    ${button("Open Xero Admin", BASE_URL + "/admin/xero")}
  `);
}

export function adminRefundRequestTemplate(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  reason: string;
  requestedAmountCents: number | null;
  paidAmountCents: number;
  refundedAmountCents: number;
}): string {
  const remaining = data.paidAmountCents - data.refundedAmountCents;
  return layout(`
    ${heading("Refund Appeal Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has submitted a refund appeal.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Paid", value: "$" + (data.paidAmountCents / 100).toFixed(2) },
      { label: "Already Refunded", value: "$" + (data.refundedAmountCents / 100).toFixed(2) },
      { label: "Remaining", value: "$" + (remaining / 100).toFixed(2) },
      ...(data.requestedAmountCents ? [{ label: "Requested", value: "$" + (data.requestedAmountCents / 100).toFixed(2) }] : []),
    ])}
    ${alertBox(escapeHtml(data.reason), "info")}
    ${button("Review Appeal", BASE_URL + "/admin/refund-requests")}
  `);
}
