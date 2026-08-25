import {
  adminDuplicateCaptureRefundTemplate,
  adminLateCaptureAutoRefundTemplate,
  adminLateCaptureHandBackConflictTemplate,
  adminManualRefundTaskTemplate,
  adminManualSettlementConflictTemplate,
  adminPaymentFailureTemplate,
  adminRefundRequestTemplate,
  adminXeroRepeatedFailureTemplate,
  adminXeroSyncErrorTemplate,
} from "@/lib/email-templates/admin-finance";
import {
  adminCreditSyncDriftTemplate,
  adminXeroReconciliationReportTemplate,
  type CreditSyncDriftReportEmail,
  type XeroReconciliationReportEmail,
} from "@/lib/email-templates/admin-xero-reports";
import {
  composeOptionalEmailLine,
  duplicateCaptureRefundOutcomeParagraph,
  lateCaptureAutoRefundBookingStateLabel,
  lateCaptureAutoRefundLeadParagraph,
  lateCaptureAutoRefundOutcomeParagraph,
  lateCaptureHandBackConflictOutcomeParagraph,
  lateCaptureHandBackConflictSubjectLabel,
} from "../email-message-notes";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { applyXeroOrgShortCode } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import {
  sendToAdmins,
  sendUnmuteableAdminAlert,
} from "./admin-alerts-shared";
import { renderEmailHtml } from "@/lib/email-theme";
import {
  emailCalendarDay,
  emailCalendarDayOrUnknown,
} from "@/lib/email-templates-club-time";

/**
 * Stamp the club's Xero organisation onto an outbound deep link, at SEND time
 * (#2314, owner decision 1 Aug 2026).
 *
 * The URLs reaching these alerts are organisation-agnostic: some are read
 * straight off a `XeroSyncOperation` / `XeroObjectLink` row, which #2314
 * deliberately keeps generic so a reconnect to a different Xero organisation
 * cannot leave stored links aimed at books the club no longer owns. A screen can
 * re-render and pick the current organisation up; an email cannot. So an email
 * is the surface that most needs the organisation named, and send time is the
 * last honest moment to name it — the alert is already a point-in-time snapshot
 * of everything else it reports.
 *
 * The organisation is CONFIRMED with Xero at send time rather than read from
 * the 12-hour cache (`confirmLive`, #2314 review). The cache is per process and
 * its invalidation only reaches the process that handled a reconnect, so a cron
 * or worker process can otherwise hold the previous organisation's short code
 * for hours — and an email stamped with it is stamped forever.
 *
 * Failure degrades, never blocks: no short code (Xero disconnected, the
 * organisation read failed, or Xero reported none) leaves the generic
 * `go.xero.com` link, which is live — it may just ask a multi-organisation
 * admin which organisation they meant. It also STRIPS any organisation the
 * stored URL already carried, so an unconfirmable organisation is never the one
 * an email points at.
 */
async function stampXeroOrganisation(
  url: string | null | undefined,
): Promise<string | null> {
  if (!url) return null;
  return applyXeroOrgShortCode(url, {
    shortCode: await getXeroOrgShortCode({ confirmLive: true }),
  });
}

// N-04: Admin alert - payment failure
export async function sendAdminPaymentFailureAlert(data: {
  memberName: string;
  /**
   * Nullable for the three senders that raise this alert without a resolvable
   * booking; `adminPaymentFailureTemplate` carries the full reasoning. Both
   * arms below render a null through the same helper, so the default body and
   * an operator's override say the same word.
   */
  checkIn: Date | null;
  checkOut: Date | null;
  amountCents: number;
  errorMessage: string;
  paymentIntentId: string;
}) {
  await sendToAdmins({
    subject: `Payment Failed — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => adminPaymentFailureTemplate(data)),
    templateName: "admin-payment-failure",
    templateData: {
      ...data,
      checkIn: emailCalendarDayOrUnknown(data.checkIn),
      checkOut: emailCalendarDayOrUnknown(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
    },
    preferenceKey: "adminPaymentFailure",
  });
}

/**
 * #2761 (owner decision 10 Aug 2026): the alert for a late capture the Stripe
 * webhook refunded on its own, replacing the generic payment-failure mail this
 * path used to send.
 *
 * ITS OWN SUBJECT, because the old one was wrong. "Payment Failed" describes
 * nothing that happened here — a booking-change payment was captured after the
 * booking had gone and the money went straight back — and a subject that
 * misdescribes an event gets triaged as noise. The subject now names the money
 * movement AND which of the two populations #2760 widened this to: "booking
 * already deleted" or "booking already cancelled". That is what lets an operator
 * recognise it and, for the ordinary cancelled case, dismiss it at a glance.
 *
 * NOT GATED ON A NOTIFICATION PREFERENCE, and delivery-locked in the registry.
 * The two mute vectors are the per-member `adminPaymentFailure` checkbox and the
 * club-wide delivery mode; the owner's decision closes both, because an automatic
 * money movement should not be silenceable and the recipient set must not be able
 * to be silently empty. `sendUnmuteableAdminAlert` owns both halves.
 *
 * STILL EXACTLY ONE NOTIFICATION FOR THE EVENT (`INV-ADDPAY-037`). This is not an
 * addition — the webhook's single `sendAdminPaymentFailureAlert` call became this
 * single call. Nothing else mails on this path, and no badge or digest changed.
 *
 * The caller keeps it fire-and-forget with a `.catch` that logs: webhooks stay
 * non-blocking, and the durable record is the DISMISSED `ManualRefundTask` plus
 * the `booking.payment.refunded_after_cancellation` audit entry.
 */
export async function sendAdminLateCaptureAutoRefundAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  bookingId: string;
  bookingDeleted: boolean;
  /**
   * #2773: which of the two late-capture handlers sent this. BOTH send this alert
   * now, and the copy has to say which payment was captured — the booking's own,
   * or one for a change to it — because the two have different Xero consequences
   * and #2761's whole point is that this mail must not misdescribe the event.
   * Required rather than defaulted, so a new caller cannot silently inherit the
   * booking-change wording.
   */
  captureKind: "modification" | "primary";
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const bookingStateLabel = lateCaptureAutoRefundBookingStateLabel(
    data.bookingDeleted,
  );

  await sendUnmuteableAdminAlert({
    subject: `Payment refunded automatically — booking ${bookingStateLabel}: ${data.memberName}`,
    html: await renderEmailHtml(() => adminLateCaptureAutoRefundTemplate({ ...data, reviewUrl })),
    templateName: "admin-late-capture-auto-refund",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
      bookingId: data.bookingId,
      paymentIntentId: data.paymentIntentId,
      bookingStateLabel,
      // The same composed sentence the hand-built HTML renders, so an admin's
      // saved default cannot describe a different population from the mail.
      refundOutcomeNote: lateCaptureAutoRefundOutcomeParagraph(
        data.bookingDeleted,
      ),
      // #2773: and the same for WHICH capture it was, including the Xero
      // consequence, which differs between the two handlers.
      lateCaptureLeadNote: lateCaptureAutoRefundLeadParagraph(data.captureKind),
      reviewUrl,
    },
    // The people who reconcile the club's money own this, exactly as they own
    // every other finance alert. This is the audience rule, not a mute.
    requirement: { area: "finance", level: "edit" },
  });
}

/**
 * #2774 (the orchestrator's call on that issue's Recommended option; the owner has
 * not ruled — `INV-ADDPAY-039`'s authority line): the alert for a late capture that
 * collided with a hand-back an operator had already made.
 *
 * IT REPORTS A RECONCILIATION, NOT A REFUND, which is why it is not the alert
 * above. Either the automatic refund was WITHHELD because a `COMPLETED`
 * `ManualRefundTask` proved an operator had already paid the member back — the
 * fence, and the money bug it closes is paying the same capture back twice — or it
 * went out anyway because that completion landed inside the webhook's own Stripe
 * round trip, in which case the member has probably been paid twice. `refundSent`
 * selects the direction.
 *
 * SAME AUDIENCE, SAME UNMUTEABLE DELIVERY, SAME AUDIENCE REASONING as its sibling
 * (`INV-ADDPAY-038`): whoever can EDIT finance, through
 * `sendUnmuteableAdminAlert`, so neither the per-member `adminPaymentFailure`
 * checkbox nor the club-wide delivery mode can silence it. If anything the case for
 * locking it is stronger — this is the one mail on the path that says money may
 * have left the club twice.
 *
 * STILL ONE NOTIFICATION PER EVENT (`INV-ADDPAY-037`). This alert REPLACES the
 * auto-refund alert whenever it fires; the caller in
 * `cancelled-booking-late-capture.ts` sends exactly one of the two and never both.
 */
export async function sendAdminLateCaptureHandBackConflictAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  bookingId: string;
  bookingDeleted: boolean;
  captureKind: "modification" | "primary";
  handBackAmountCents: number | null;
  refundSent: boolean;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const handBackConflictLabel = lateCaptureHandBackConflictSubjectLabel(
    data.refundSent,
  );

  await sendUnmuteableAdminAlert({
    // Composed from the SAME source as the {{handBackConflictLabel}} token below,
    // so the sender's subject and an admin's saved override say the same direction.
    subject: `${handBackConflictLabel}: ${data.memberName}`,
    html: await renderEmailHtml(() => adminLateCaptureHandBackConflictTemplate({ ...data, reviewUrl })),
    templateName: "admin-late-capture-hand-back-conflict",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
      bookingId: data.bookingId,
      paymentIntentId: data.paymentIntentId,
      // THE DIRECTION, IN THE SUBJECT, AS A TOKEN. A stored subject override
      // replaces the sender's subject unconditionally and a subject token cannot
      // be made mandatory, so shipping one direction as literal default-subject
      // text would title every double-payment notice "refund withheld" the moment
      // any admin saved the template. The {{bookingStateLabel}} precedent (#2761),
      // applied to the mail that may be reporting money leaving the club twice.
      handBackConflictLabel,
      // The one sentence that says which way the money went, composed once and
      // shared with the hand-built HTML so an admin's saved default cannot state
      // the opposite of what happened (#2268 convention).
      handBackConflictNote: lateCaptureHandBackConflictOutcomeParagraph(
        data.refundSent,
      ),
      reviewUrl,
    },
    requirement: { area: "finance", level: "edit" },
  });
}

// #1992 / #2007: Admin alert — duplicate-capture auto-refund. A second, distinct
// Stripe capture landed on a booking already settled by another intent, so the
// duplicate charge is auto-refunded. A DEDICATED template (not the generic
// payment-anomaly alert) so the copy states the real situation on each outcome.
// `refundFailed` selects the wording (one-template-with-boolean precedent, like
// adminSplitSettlementUnpaidTemplate's parentUnpaid). Gated by the same
// adminPaymentFailure preference as its siblings; NOT delivery-locked (the
// #1994 adjudication: no direct money loss from muting — the refund already
// happened or is durably queued for the recovery cron).
export async function sendAdminDuplicateCaptureRefundAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  settledPaymentIntentId: string | null;
  operationReference: string;
  errorMessage?: string | null;
  refundFailed: boolean;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;

  await sendToAdmins({
    subject: data.refundFailed
      ? `Duplicate capture auto-refund failed — retry queued: ${data.memberName}`
      : `Duplicate capture auto-refunded: ${data.memberName}`,
    html: await renderEmailHtml(() => adminDuplicateCaptureRefundTemplate({
      memberName: data.memberName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      amountCents: data.amountCents,
      paymentIntentId: data.paymentIntentId,
      settledPaymentIntentId: data.settledPaymentIntentId,
      operationReference: data.operationReference,
      errorMessage: data.errorMessage ?? null,
      reviewUrl,
      refundFailed: data.refundFailed,
    })),
    templateName: "admin-duplicate-capture-refund",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
      paymentIntentId: data.paymentIntentId,
      operation: data.operationReference,
      errorMessage: data.errorMessage ?? "",
      // #2268: the outcome-dependent lead paragraph, built from the same
      // helper as the hand-built HTML, with the failure detail appended when
      // there is one. The flat body used to state the success wording
      // unconditionally and park the failure wording in an authoring note, so
      // an admin who saved that default was told a duplicate charge had been
      // refunded even when the refund had failed.
      refundOutcomeNote:
        duplicateCaptureRefundOutcomeParagraph(data.refundFailed) +
        (data.refundFailed && data.errorMessage
          ? " Failure detail: " + data.errorMessage
          : ""),
      reviewUrl,
      refundFailed: data.refundFailed,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

/**
 * B5 (#2262): the reciprocal fence's alert. An inbound Xero PAID landed on a
 * booking this system already recorded as settled in cash / off-Xero, so the
 * club may be holding the same money twice. Admin audience, so it is exempt
 * from the per-booking "No emails" switch (#2258 rule 2) — that switch silences
 * the MEMBER, and an operator must still hear about unreconciled money.
 *
 * Repeat sends are throttled by the caller with a cross-instance
 * AlertCooldown claim keyed on (payment, invoice), so webhook replays re-count
 * the conflict without re-spamming.
 */
export async function sendAdminManualSettlementConflictAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  bookingId: string;
  bookingStatus: string;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const xeroInvoiceUrl = await stampXeroOrganisation(data.xeroInvoiceUrl);

  await sendToAdmins({
    subject: `Cash settlement vs Xero payment — reconcile: ${data.memberName}`,
    html: await renderEmailHtml(() => adminManualSettlementConflictTemplate({
      ...data,
      xeroInvoiceUrl,
      reviewUrl,
    })),
    templateName: "admin-manual-settlement-conflict",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
      bookingId: data.bookingId,
      status: data.bookingStatus,
      xeroInvoiceNumber: data.xeroInvoiceNumber ?? "",
      xeroObjectUrl: xeroInvoiceUrl ?? "",
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

/**
 * B5 (#2262): a cash-settled booking was cancelled, so the refund has to be
 * paid back by hand. Admin audience (exempt from the #2258 switch); the durable
 * ManualRefundTask row is the record, this is the nudge.
 */
export async function sendAdminManualRefundTaskAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  refundAmountCents: number;
  bookingId: string;
  reason: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;

  await sendToAdmins({
    subject: `Manual refund needed — cash booking cancelled: ${data.memberName}`,
    html: await renderEmailHtml(() => adminManualRefundTaskTemplate({ ...data, reviewUrl })),
    templateName: "admin-manual-refund-task",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      refundAmount: formatMoneyCents(data.refundAmountCents),
      bookingId: data.bookingId,
      reason: data.reason,
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

// N-05: Admin alert - Xero sync error
export async function sendAdminXeroSyncErrorAlert(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
  timestamp: Date;
}) {
  await sendToAdmins({
    subject: `Xero Sync Error — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => adminXeroSyncErrorTemplate(data)),
    templateName: "admin-xero-sync-error",
    templateData: {
      ...data,
      timestamp: data.timestamp.toISOString(),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

export async function sendAdminXeroRepeatedFailureAlert(data: {
  subject: string;
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
}) {
  // #2314: the operation's stored `xeroObjectUrl` is organisation-agnostic, so
  // the club's organisation is stamped on here, at send time.
  const xeroObjectUrl = await stampXeroOrganisation(data.xeroObjectUrl);
  const stamped = { ...data, xeroObjectUrl };

  await sendToAdmins({
    subject: data.subject,
    html: await renderEmailHtml(() => adminXeroRepeatedFailureTemplate(stamped)),
    templateName: "admin-xero-repeated-failure",
    templateData: {
      ...stamped,
      localModel: data.localModel ?? "",
      localId: data.localId ?? "",
      latestErrorMessage: data.latestErrorMessage ?? "",
      // #2268: pre-composed optional lines. Every one of these five values is
      // nullable, and the flat body has no conditional syntax, so each whole
      // line is built here or omitted entirely — the body used to carry
      // "OR Unavailable" and bare unclickable "Open local record" labels.
      localRecordNote: composeOptionalEmailLine(
        "Local Record",
        [data.localModel, data.localId].filter(Boolean).join(" "),
        { trailing: "\n" },
      ),
      latestErrorNote: composeOptionalEmailLine(
        "Latest Error",
        data.latestErrorMessage,
        { trailing: "\n" },
      ),
      xeroLinksNote: composeOptionalEmailLine(
        null,
        composeOptionalEmailLine("Open local record", data.localUrl, {
          trailing: "\n",
        }) +
          composeOptionalEmailLine("Open Xero object", xeroObjectUrl, {
            trailing: "\n",
          }),
      ),
      timestamp: data.timestamp.toISOString(),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

/**
 * #2314: stamp the club's organisation onto every Xero link the reconciliation
 * report carries — issue items, repeated failures and unsupported partials all
 * render one, and each is either a stored (organisation-agnostic) URL or one
 * rebuilt from the object's type and id. ONE confirmed organisation read for
 * the whole report (see `stampXeroOrganisation` on why it is confirmed rather
 * than cached).
 *
 * A null short code is not an early return: `applyXeroOrgShortCode` strips in
 * that case, and a report is the surface where a legacy row still carrying a
 * previous organisation would be most durable. Every link degrades to the
 * generic form instead — live, just not organisation-scoped.
 */
async function stampXeroOrganisationOnReport(
  report: XeroReconciliationReportEmail,
): Promise<XeroReconciliationReportEmail> {
  const shortCode = await getXeroOrgShortCode({ confirmLive: true });

  const stamp = <T extends { xeroObjectUrl?: string | null }>(item: T): T => ({
    ...item,
    xeroObjectUrl: applyXeroOrgShortCode(item.xeroObjectUrl, { shortCode }),
  });

  return {
    ...report,
    issueSections: report.issueSections?.map((section) => ({
      ...section,
      items: section.items.map(stamp),
    })),
    repeatedFailures: report.repeatedFailures.map(stamp),
    unsupportedPartials: report.unsupportedPartials.map(stamp),
  };
}

export async function sendAdminXeroReconciliationReportAlert(
  reportInput: XeroReconciliationReportEmail,
) {
  const report = await stampXeroOrganisationOnReport(reportInput);
  const subject =
    report.summary.issueCategoryCount === 0
      ? "Xero Reconciliation Report - clean"
      : `Xero Reconciliation Report - action needed: ${report.summary.issueCategoryCount} categor${report.summary.issueCategoryCount === 1 ? "y" : "ies"}, ${report.summary.issueTotalCount} item${report.summary.issueTotalCount === 1 ? "" : "s"}`;

  await sendToAdmins({
    subject,
    html: await renderEmailHtml(() => adminXeroReconciliationReportTemplate(report)),
    templateName: "admin-xero-reconciliation-report",
    templateData: {
      generatedAt: report.generatedAt.toISOString(),
      lookbackHours: report.lookbackHours,
      stalePendingMinutes: report.stalePendingMinutes,
      issueCategoryCount: report.summary.issueCategoryCount,
      issueTotalCount: report.summary.issueTotalCount,
      count: report.summary.issueTotalCount,
    },
    preferenceKey: "adminXeroSyncError",
  });
}

/**
 * #2501: warn admins that BookingApp's stamped applied credit and Xero's live
 * invoice allocation have drifted, with the exact per-booking amount. The
 * checker (xero-credit-sync-checker.ts) only calls this when at least one drift
 * was found, so the content-only delivery default never suppresses a real
 * warning. The invoice deep links are org-agnostic, so stamp the club's Xero
 * organisation on at send time (#2314), one confirmed read for the whole report.
 */
export async function sendAdminCreditSyncDriftAlert(
  report: CreditSyncDriftReportEmail,
) {
  const shortCode = await getXeroOrgShortCode({ confirmLive: true });
  const stampedReport: CreditSyncDriftReportEmail = {
    ...report,
    drifts: report.drifts.map((drift) => ({
      ...drift,
      invoiceUrl: applyXeroOrgShortCode(drift.invoiceUrl, { shortCode }),
    })),
  };

  const driftCount = stampedReport.drifts.length;
  const subject = `Xero Credit Sync Drift — ${driftCount} booking${driftCount === 1 ? "" : "s"}, ${formatMoneyCents(stampedReport.totalDriftCents)} — ${CLUB_BOOKINGS_NAME}`;

  await sendToAdmins({
    subject,
    html: await renderEmailHtml(() => adminCreditSyncDriftTemplate(stampedReport)),
    templateName: "admin-credit-sync-drift",
    templateData: {
      generatedAt: stampedReport.generatedAt.toISOString(),
      scannedBookings: String(stampedReport.scannedBookings),
      checkedBookings: String(stampedReport.checkedBookings),
      deferredBookings: String(stampedReport.deferredBookings),
      driftCount: String(driftCount),
      totalDrift: formatMoneyCents(stampedReport.totalDriftCents),
      count: String(driftCount),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

export async function sendAdminRefundRequestAlert(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  reason: string;
  requestedAmountCents: number | null;
  paidAmountCents: number;
  refundedAmountCents: number;
}) {
  await sendToAdmins({
    subject: `Refund Appeal: ${data.memberName}`,
    html: await renderEmailHtml(() => adminRefundRequestTemplate(data)),
    templateName: "admin-refund-request",
    templateData: {
      ...data,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      paidAmount: formatMoneyCents(data.paidAmountCents),
      refundedAmount: formatMoneyCents(data.refundedAmountCents),
      remainingAmount: formatMoneyCents(
        data.paidAmountCents - data.refundedAmountCents,
      ),
      requestedAmount:
        data.requestedAmountCents === null
          ? ""
          : formatMoneyCents(data.requestedAmountCents),
      // #2268: pre-composed optional line — an appeal that names no amount
      // must not print a dangling "Requested:".
      requestedAmountNote: composeOptionalEmailLine(
        "Requested",
        data.requestedAmountCents === null
          ? null
          : formatMoneyCents(data.requestedAmountCents),
        { trailing: "\n" },
      ),
    },
    preferenceKey: "adminRefundRequest",
  });
}
