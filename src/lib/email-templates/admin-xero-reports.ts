/**
 * The two scheduled finance reports: the Xero reconciliation report and the
 * credit-sync drift report.
 *
 * Same sender family as `./admin-finance` (`src/lib/email/admin-alerts-finance.ts`).
 * Separated because these two are documents rather than alerts: they carry
 * their own row/section/severity renderers and the shapes those read, which is
 * most of the code and none of it shared with the event alerts.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  heading,
  infoTable,
  layout,
  paragraph,
  WHITE,
} from "./layout";
import { sanitizeEmailHref } from "@/lib/app-url";
import { emailPalette } from "@/lib/email-theme";
import { emailClubDateTime } from "@/lib/email-templates-club-time";
import { formatCents as formatMoneyCents } from "@/lib/utils";

type XeroReconciliationIssueSeverityEmail = "critical" | "warning" | "info";

interface XeroReconciliationIssueItemEmail {
  label: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  operationId: string | null;
  operationStatus: string | null;
  operationType: string | null;
  correlationKey: string | null;
  detail: string | null;
  latestErrorMessage: string | null;
  createdAt: Date | null;
}

interface XeroReconciliationIssueSectionEmail {
  id: string;
  title: string;
  severity: XeroReconciliationIssueSeverityEmail;
  count: number;
  whatWentWrong: string;
  howToFix: string;
  items: XeroReconciliationIssueItemEmail[];
}

export interface XeroReconciliationReportEmail {
  generatedAt: Date;
  lookbackHours: number;
  stalePendingMinutes: number;
  summary: {
    missingMemberContactLinks: number;
    missingPaymentInvoiceLinks: number;
    missingPaymentRefundCreditNoteLinks: number;
    missingSubscriptionInvoiceLinks: number;
    mismatchedCanonicalLinks: number;
    staleCanonicalLinks: number;
    duplicateActiveCanonicalLinks: number;
    overCoveredStripeRefundPayments: number;
    stalePendingOperations: number;
    recentFailedOperations: number;
    recentPartialOperations: number;
    unsupportedPartialOperations: number;
    repeatedFailureCorrelations: number;
    failedInboundEvents: number;
    issueCategoryCount: number;
    issueTotalCount: number;
  };
  issueSections?: XeroReconciliationIssueSectionEmail[];
  repeatedFailures: Array<{
    correlationKey: string;
    failureCount: number;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    latestErrorMessage: string | null;
    latestOperationId?: string;
    latestOperationStatus?: string;
    latestOperationCreatedAt?: Date;
    xeroObjectType?: string | null;
    xeroObjectId?: string | null;
    xeroObjectNumber?: string | null;
    xeroObjectUrl?: string | null;
  }>;
  unsupportedPartials: Array<{
    operationId: string;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    xeroObjectType?: string | null;
    xeroObjectId?: string | null;
    xeroObjectNumber?: string | null;
    xeroObjectUrl?: string | null;
    reason: string;
    createdAt: Date;
  }>;
}

function formatEmailDateTime(value: Date | null): string {
  if (!value) {
    return "";
  }

  return emailClubDateTime(value);
}

function formatXeroObjectLabel(item: {
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
}): string | null {
  if (!item.xeroObjectId) {
    return null;
  }

  return `${item.xeroObjectType ?? "Xero"} ${item.xeroObjectNumber ?? item.xeroObjectId}`;
}

function issueSeverityStyle(severity: XeroReconciliationIssueSeverityEmail) {
  const p = emailPalette();
  switch (severity) {
    case "critical":
      return { bg: "#fef2f2", border: "#fecaca", text: "#991b1b", label: "Action needed" };
    case "warning":
      return { bg: "#fffbeb", border: "#fcd34d", text: "#92400e", label: "Review" };
    case "info":
      return { bg: "#eff6ff", border: "#bfdbfe", text: "#1e40af", label: "Context" };
    default:
      return { bg: "#f8fafc", border: p.mist, text: p.deep, label: "Review" };
  }
}

function issueLink(text: string, url: string, sameOrigin = false): string {
  const p = emailPalette();
  const safeUrl = sanitizeEmailHref(url, {
    baseUrl: BASE_URL,
    sameOrigin,
  });

  return `<a href="${escapeHtml(safeUrl)}" target="_blank" style="color: ${p.charcoal}; font-weight: 700; text-decoration: underline;">${escapeHtml(text)}</a>`;
}

function renderIssueItem(item: XeroReconciliationIssueItemEmail): string {
  const p = emailPalette();
  const recordLink = item.localUrl
    ? issueLink("Open booking record", item.localUrl, true)
    : null;
  const xeroLabel = formatXeroObjectLabel(item);
  const xeroLink = item.xeroObjectUrl
    ? issueLink(xeroLabel ?? "Open Xero", item.xeroObjectUrl)
    : null;
  const links = [recordLink, xeroLink].filter((value): value is string => Boolean(value));
  const metadata = [
    item.operationId ? `Operation ${item.operationId}` : null,
    item.operationStatus ? `Status ${item.operationStatus}` : null,
    item.operationType,
    item.correlationKey ? `Correlation ${item.correlationKey}` : null,
    formatEmailDateTime(item.createdAt),
  ].filter((value): value is string => Boolean(value));
  const detailRows = [
    item.detail,
    item.latestErrorMessage ? `Latest error: ${item.latestErrorMessage}` : null,
  ].filter((value): value is string => Boolean(value));

  return `
    <div style="border: 1px solid ${p.mist}; border-radius: 6px; padding: 12px; margin: 10px 0; background-color: ${WHITE};">
      <p style="margin: 0 0 6px 0; color: ${p.deep}; font-size: 14px; font-weight: 700;">${escapeHtml(item.label)}</p>
      ${
        metadata.length > 0
          ? `<p style="margin: 0 0 6px 0; color: ${p.ridge}; font-size: 12px; line-height: 1.5;">${metadata.map(escapeHtml).join(" &bull; ")}</p>`
          : ""
      }
      ${
        detailRows.length > 0
          ? `<p style="margin: 0 0 8px 0; color: ${p.deep}; font-size: 13px; line-height: 1.5;">${detailRows.map(escapeHtml).join("<br>")}</p>`
          : ""
      }
      ${
        links.length > 0
          ? `<p style="margin: 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">${links.join(" &nbsp; ")}</p>`
          : ""
      }
    </div>`;
}

function renderIssueSection(section: XeroReconciliationIssueSectionEmail): string {
  const p = emailPalette();
  const style = issueSeverityStyle(section.severity);
  const itemHtml = section.items.length > 0
    ? section.items.map(renderIssueItem).join("")
    : `<p style="margin: 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">Open the Xero admin area to review the affected records.</p>`;

  return `
    <div style="background-color: ${style.bg}; border: 1px solid ${style.border}; border-radius: 8px; padding: 16px; margin: 18px 0;">
      <p style="margin: 0 0 8px 0; color: ${style.text}; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;">${escapeHtml(style.label)} &bull; ${section.count}</p>
      <h3 style="margin: 0 0 10px 0; color: ${p.deep}; font-size: 17px; line-height: 1.35;">${escapeHtml(section.title)}</h3>
      <p style="margin: 0 0 8px 0; color: ${p.deep}; font-size: 14px; line-height: 1.5;"><strong>What went wrong:</strong> ${escapeHtml(section.whatWentWrong)}</p>
      <p style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 14px; line-height: 1.5;"><strong>How to fix:</strong> ${escapeHtml(section.howToFix)}</p>
      ${itemHtml}
    </div>`;
}

export function adminXeroReconciliationReportTemplate(report: XeroReconciliationReportEmail): string {
  const p = emailPalette();
  const summaryRows = [
    { label: "Generated", value: emailClubDateTime(report.generatedAt) },
    { label: "Lookback Window", value: `${report.lookbackHours} hour${report.lookbackHours === 1 ? "" : "s"}` },
    { label: "Stale Pending Threshold", value: `${report.stalePendingMinutes} minute${report.stalePendingMinutes === 1 ? "" : "s"}` },
    { label: "Issue Categories", value: String(report.summary.issueCategoryCount) },
    { label: "Total Issue Count", value: String(report.summary.issueTotalCount) },
  ];

  const categoryRows = [
    { label: "Missing member contact links", value: String(report.summary.missingMemberContactLinks) },
    { label: "Missing payment invoice links", value: String(report.summary.missingPaymentInvoiceLinks) },
    { label: "Missing refund credit note links", value: String(report.summary.missingPaymentRefundCreditNoteLinks) },
    { label: "Missing subscription invoice links", value: String(report.summary.missingSubscriptionInvoiceLinks) },
    { label: "Mismatched canonical links", value: String(report.summary.mismatchedCanonicalLinks) },
    { label: "Stale canonical links", value: String(report.summary.staleCanonicalLinks) },
    { label: "Duplicate active canonical links", value: String(report.summary.duplicateActiveCanonicalLinks) },
    { label: "Stripe refunds over-covered by credit notes", value: String(report.summary.overCoveredStripeRefundPayments) },
    { label: "Stale pending/running operations", value: String(report.summary.stalePendingOperations) },
    { label: "Recent failed operations", value: String(report.summary.recentFailedOperations) },
    { label: "Recent partial operations", value: String(report.summary.recentPartialOperations) },
    { label: "Unsupported partial operations", value: String(report.summary.unsupportedPartialOperations) },
    { label: "Repeated-failure correlations", value: String(report.summary.repeatedFailureCorrelations) },
    { label: "Persistently failing inbound events", value: String(report.summary.failedInboundEvents) },
  ];

  const issueSections = report.issueSections ?? [];
  const issueSectionHtml = issueSections.map(renderIssueSection).join("");
  const repeatedFailureRows = report.repeatedFailures
    .map((failure) => `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(failure.correlationKey)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${failure.failureCount}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(failure.entityType)} ${escapeHtml(failure.operationType)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${
          failure.localModel && failure.localId
            ? escapeHtml(`${failure.localModel} ${failure.localId}`)
            : "Unavailable"
        }</td>
      </tr>`)
    .join("");

  const unsupportedPartialRows = report.unsupportedPartials
    .map((partial) => `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.operationId)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.entityType)} ${escapeHtml(partial.operationType)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${
          partial.localModel && partial.localId
            ? escapeHtml(`${partial.localModel} ${partial.localId}`)
            : "Unavailable"
        }</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.reason)}</td>
      </tr>`)
    .join("");

  return layout(`
    ${heading("Xero Reconciliation Report")}
    ${
      report.summary.issueCategoryCount === 0
        ? alertBox("No open reconciliation gaps were detected in this report window.", "success")
        : alertBox("Reconciliation gaps were detected. Start with the action sections below, then use the diagnostic totals for context.", "warning")
    }
    ${infoTable(summaryRows)}
    ${
      issueSections.length > 0
        ? issueSectionHtml
        : ""
    }
    ${
      issueSections.length === 0 && report.repeatedFailures.length > 0
        ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Correlation Key</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Failures</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Local Record</th>
      </tr>
      ${repeatedFailureRows}
    </table>`
        : ""
    }
    ${
      issueSections.length === 0 && report.unsupportedPartials.length > 0
        ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation ID</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Local Record</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Repair Gap</th>
      </tr>
      ${unsupportedPartialRows}
    </table>`
        : ""
    }
    ${
      report.summary.issueCategoryCount > 0
        ? `${paragraph("Diagnostic totals")}${infoTable(categoryRows)}`
        : ""
    }
    ${button("Open Xero Admin", BASE_URL + "/admin/xero")}
  `);
}

// ---- #2501: Admin Alert — Xero credit-sync drift ----

/**
 * One booking whose BookingApp stamped applied credit does not match Xero's
 * live invoice allocation. `localCents` is BookingApp's known credit (the net
 * `BOOKING_APPLIED` sum), `xeroCents` is Xero's live allocation of the member's
 * OWN stamped credit notes to the invoice (the sum of those notes'
 * `appliedAmount` — NOT `invoice.amountCredited`, which folds in other
 * credit-note classes such as modification reprice notes), and `deltaCents` is
 * the exact (positive) drift between them. `notes` lists exactly those stamped
 * member credit notes, so their applied amounts reconcile to `xeroCents`.
 */
export interface CreditSyncDriftItemEmail {
  kind: "missing_in_xero" | "excess_in_xero" | "no_invoice";
  bookingId: string;
  memberName: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Org-agnostic Xero invoice URL (the sender stamps the club org onto it). */
  invoiceUrl: string | null;
  localCents: number;
  xeroCents: number;
  deltaCents: number;
  notes: Array<{
    creditNoteId: string | null;
    creditNoteNumber: string | null;
    appliedCents: number;
  }>;
}

export interface CreditSyncDriftReportEmail {
  generatedAt: Date;
  scannedBookings: number;
  checkedBookings: number;
  deferredBookings: number;
  totalDriftCents: number;
  drifts: CreditSyncDriftItemEmail[];
}

function creditSyncDriftDirectionLabel(kind: CreditSyncDriftItemEmail["kind"]): string {
  switch (kind) {
    case "missing_in_xero":
      return "Applied in BookingApp, not fully allocated in Xero";
    case "excess_in_xero":
      return "Xero has more credit allocated than BookingApp recorded";
    case "no_invoice":
      return "Applied credit stamped, but no linked Xero invoice";
  }
}

export function adminCreditSyncDriftTemplate(report: CreditSyncDriftReportEmail): string {
  const p = emailPalette();
  const driftCount = report.drifts.length;

  const summaryRows = [
    { label: "Generated", value: emailClubDateTime(report.generatedAt) },
    { label: "Bookings scanned", value: String(report.scannedBookings) },
    { label: "Bookings checked", value: String(report.checkedBookings) },
    { label: "Bookings deferred", value: String(report.deferredBookings) },
    { label: "Bookings with drift", value: String(driftCount) },
    { label: "Total drift", value: formatMoneyCents(report.totalDriftCents) },
  ];

  const driftRows = report.drifts
    .map((drift) => {
      const noteDetail =
        drift.notes.length > 0
          ? drift.notes
              .map(
                (note) =>
                  `${escapeHtml(note.creditNoteNumber ?? "credit note")}: ${formatMoneyCents(note.appliedCents)}`
              )
              .join("; ")
          : "None allocated";
      const invoiceCell = drift.invoiceUrl
        ? `<a href="${escapeHtml(drift.invoiceUrl)}" style="color: ${p.gold}; text-decoration: underline;">${escapeHtml(drift.invoiceNumber ?? "Invoice")}</a>`
        : escapeHtml(drift.invoiceNumber ?? "No invoice");
      return `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(drift.memberName)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(drift.bookingId.slice(0, 8))}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(creditSyncDriftDirectionLabel(drift.kind))}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatMoneyCents(drift.localCents)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatMoneyCents(drift.xeroCents)}</td>
        <td style="padding: 8px 12px; font-size: 13px; font-weight: 700; border-bottom: 1px solid ${p.mist}; color: #dc2626;">${formatMoneyCents(drift.deltaCents)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${invoiceCell}<br><span style="color: ${p.ridge}; font-size: 12px;">${noteDetail}</span></td>
      </tr>`;
    })
    .join("");

  return layout(`
    ${heading("Xero Credit Sync Drift")}
    ${alertBox(
      `${driftCount} booking${driftCount === 1 ? "" : "s"} have applied account credit that does not match Xero's live invoice allocation (total drift ${formatMoneyCents(report.totalDriftCents)}). BookingApp uses its own known credit to net member emails (#2483); each row below shows exactly where its ledger and Xero disagree. Nothing has been changed — review and reconcile in Xero.`,
      "warning"
    )}
    ${infoTable(summaryRows)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Member</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Booking</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Drift type</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">BookingApp credit</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Xero credit</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Drift</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Invoice / Xero notes</th>
      </tr>
      ${driftRows}
    </table>
    ${button("Open Xero Admin", BASE_URL + "/admin/xero")}
  `);
}
