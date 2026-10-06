/**
 * Admin operations alerts: the daily digest, member-reported issues, the
 * public website's contact form, and the two "an email did not get through"
 * alerts.
 *
 * The family boundary is `src/lib/email/admin-alerts-ops.ts`. The last three
 * arrived in #2689: they used to build their HTML at the send site, which left
 * them unpinnable by the rendered-output gate — a refactor could have changed
 * what an operator receives with nothing going red. They now use the same
 * escaped blocks and club shell as the rest of the template catalogue, and the
 * intentional output change is pinned by the render-equivalence gate.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  heading,
  infoTable,
  layout,
  multilineBlock,
  paragraph,
} from "./layout";
import { emailPalette } from "@/lib/email-theme";
import { describeServerVersionPause } from "@/lib/servernz-api-version";

// ---- N-13: Admin Daily Digest ----

/** The six alert counts and their total, as `cron-admin-digest.ts` builds them. */
export interface AdminDigestCounts {
  newBookings: number;
  paymentFailures: number;
  capacityWarnings: number;
  bookingsBumped: number;
  pendingDeadlines: number;
  xeroErrors: number;
  totalAlerts: number;
}

/**
 * The "central server version" entry (#49): present only while syncing with
 * the Alpine Central Server is paused because the versions differ. `server`
 * is the server's reported version, or "unknown" for a release that predates
 * version checks.
 */
export interface AdminDigestServerVersion {
  expected: string;
  server: string;
}

const ALPINE_SERVER_SETUP_PATH = "/admin/alpine-server/setup";

function serverVersionEntry(version: AdminDigestServerVersion): string {
  return (
    alertBox(
      "<strong>Central server version.</strong> " +
        escapeHtml(describeServerVersionPause(version.expected, version.server)),
      "warning",
    ) + button("Open Alpine Central Server setup", BASE_URL + ALPINE_SERVER_SETUP_PATH)
  );
}

/**
 * The version-only notice (#49, owner decision "second template"): what a
 * Lodge Operations editor who does NOT receive the Daily digest is sent while
 * syncing is paused. Its OWN template, so a club's override of the digest can
 * neither garble it into blank counts nor hide it; no count is rendered here,
 * because the counts are cross-area alert data that role does not hold.
 */
export function adminServerVersionPausedTemplate(
  version: AdminDigestServerVersion,
): string {
  return layout(`
    ${heading("Central Server Version")}
    ${paragraph("A daily notice while syncing with the Alpine Central Server is paused.")}
    ${serverVersionEntry(version)}
  `);
}

/**
 * The digest body: byte-identical to what shipped before #49 when
 * `serverVersion` is absent, plus the version entry after the total when it
 * is present (the digest's own readers). The version-only notice for lodge
 * editors is `adminServerVersionPausedTemplate`, deliberately not a shape of
 * this one.
 */
export function adminDailyDigestTemplate(
  sections: AdminDigestCounts & {
    serverVersion?: AdminDigestServerVersion;
  },
): string {
  const p = emailPalette();
  const rows: Array<{ label: string; value: string; link: string }> = [];

  if (sections.newBookings > 0) rows.push({ label: "New Bookings", value: String(sections.newBookings), link: "/admin/bookings" });
  if (sections.paymentFailures > 0) rows.push({ label: "Payment Failures", value: String(sections.paymentFailures), link: "/admin/payments" });
  if (sections.capacityWarnings > 0) rows.push({ label: "Capacity Warnings", value: String(sections.capacityWarnings), link: "/admin/bookings" });
  if (sections.bookingsBumped > 0) rows.push({ label: "Bookings Bumped", value: String(sections.bookingsBumped), link: "/admin/bookings" });
  if (sections.pendingDeadlines > 0) rows.push({ label: "Pending Deadlines", value: String(sections.pendingDeadlines), link: "/admin/bookings" });
  if (sections.xeroErrors > 0) rows.push({ label: "Xero Errors", value: String(sections.xeroErrors), link: "/admin/xero" });

  const tableRowsHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${r.label}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep}; font-weight: 700;">${r.value}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist};"><a href="${BASE_URL}${r.link}" style="color: ${p.gold}; text-decoration: none;">View</a></td>
    </tr>`
    )
    .join("");

  const noAlerts = rows.length === 0
    ? paragraph("No alerts were triggered in the past 24 hours. All systems running normally.")
    : "";

  return layout(`
    ${heading("Admin Daily Digest")}
    ${paragraph("Summary of admin alerts from the past 24 hours.")}
    ${noAlerts}
    ${rows.length > 0 ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Alert Type</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Count</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Action</th>
      </tr>
      ${tableRowsHtml}
    </table>` : ""}
    ${paragraph("<strong>Total alerts:</strong> " + sections.totalAlerts) + (sections.serverVersion ? serverVersionEntry(sections.serverVersion) : "")}
    ${button("Open Admin Dashboard", BASE_URL + "/admin/dashboard")}
  `);
}

export function adminIssueReportTemplate(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  issueReportUrl: string;
  hasScreenshot: boolean;
}): string {
  return layout(`
    ${heading("Issue Report Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has reported an issue from the bookings site.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
      { label: "Page", value: escapeHtml(data.pageTitle || data.pageUrl) },
      { label: "Screenshot", value: data.hasScreenshot ? "Available in admin" : "Not included" },
    ])}
    ${alertBox(escapeHtml(data.description), "info")}
    ${button("Review Issue Report", data.issueReportUrl, { sameOrigin: true })}
    ${button("Open Reported Page", data.pageUrl, { sameOrigin: true })}
  `);
}

/**
 * `admin-maintenance-report` (#2780): somebody reported a physical fault at a
 * lodge, from the members' portal or from the QR code on the wall.
 *
 * EVERY DYNAMIC VALUE HERE CAN COME FROM AN UNAUTHENTICATED STRANGER — the
 * summary, the answers, and the self-declared name and contact on the QR path —
 * so every one of them is escaped, and the answers are rendered through the
 * shared `infoTable`/`multilineBlock` blocks rather than concatenated into
 * markup. The only URL in the message is one this application built
 * (`sameOrigin`), never anything the reporter supplied: a report is not allowed
 * to put a link of its choosing in front of an officer.
 */
export function adminMaintenanceReportTemplate(data: {
  lodgeName: string;
  reportedBy: string;
  sourceLabel: string;
  photoLabel: string;
  summary: string;
  answers: Array<{ label: string; value: string }>;
  maintenanceReportUrl: string;
}): string {
  return layout(`
    ${heading("Maintenance Report Lodged")}
    ${paragraph("Something needs attention at " + escapeHtml(data.lodgeName) + ".")}
    ${infoTable([
      { label: "Lodge", value: escapeHtml(data.lodgeName) },
      { label: "Reported by", value: escapeHtml(data.reportedBy) },
      { label: "How it was sent", value: escapeHtml(data.sourceLabel) },
      { label: "Photo", value: escapeHtml(data.photoLabel) },
    ])}
    ${alertBox(escapeHtml(data.summary), "info")}
    ${
      data.answers.length > 0
        ? infoTable(
            data.answers.map((answer) => ({
              label: escapeHtml(answer.label),
              value: escapeHtml(answer.value),
            })),
          )
        : paragraph("No further answers were given.")
    }
    ${button("Review Maintenance Report", data.maintenanceReportUrl, { sameOrigin: true })}
  `);
}

/**
 * The public website's contact form, delivered to whoever the committee
 * assignment routes it to.
 *
 * Moved out of `src/app/api/contact/route.ts` (#2689). The public values stay
 * escaped at the rendering edge, and the message now uses the shared club shell
 * and standard content blocks instead of a one-off unbranded table.
 */
export function websiteContactTemplate(data: {
  name: string;
  email: string;
  message: string;
}): string {
  const email = escapeHtml(data.email);
  return layout(`
    ${heading("New Contact Form Submission")}
    ${infoTable([
      { label: "Name", value: escapeHtml(data.name) },
      { label: "Email", value: `<a href="mailto:${email}">${email}</a>` },
    ])}
    ${paragraph("<strong>Message:</strong>")}
    ${multilineBlock(escapeHtml(data.message))}
  `);
}

/**
 * `admin-email-failure`, as the retry cron sends it: a member's email has now
 * failed MAX_ATTEMPTS times and will not be tried again.
 *
 * This is the shape the registry's default body describes, which is why it is
 * the one `REGISTRY_KEY_RENDERERS` maps the key to. Moved out of
 * `src/lib/cron-email-retry.ts` (#2689), with every dynamic value escaped and
 * the standard club shell applied before the alert is sent.
 */
export function adminEmailDeliveryFailedTemplate(data: {
  recipient: string;
  templateName: string;
  attemptCount: number;
}): string {
  return layout(`
    ${heading("Email Delivery Permanently Failed")}
    ${paragraph(
      `Email to ${escapeHtml(data.recipient)} (template: ${escapeHtml(data.templateName)}) has failed after ${data.attemptCount} attempts and will not be retried.`,
    )}
  `);
}

/**
 * `admin-email-failure`, as the FAIL-CLOSED path sends it: a booking's
 * "No emails" flag could not be read, so the message was withheld rather than
 * risk sending one that was meant to be held back (#2258).
 *
 * A second body under the same registry key, which is pre-existing: the key
 * has always carried two different messages. It has no `REGISTRY_KEY_RENDERERS`
 * row of its own because that map is one renderer per key; the render gate
 * still pins it, because the gate walks every exported function in this module.
 *
 * Moved out of `src/lib/email/core.ts` (#2689). That module already
 * reaches this layer — `core.ts` imports `email-message-renderer`, which
 * imports `email-templates/layout` — so importing a template module here adds
 * no dependency the alert did not already have, and this function is a pure,
 * synchronous string builder with no database, network or provider call in it.
 * That matters more than usual: this is the email that reports an email
 * failure, so it must not be able to fail the same way. Dynamic identifiers
 * are escaped and the body uses the shared club shell.
 */
export function adminEmailWithheldTemplate(data: {
  templateName: string;
  bookingId: string;
}): string {
  return layout(`
    ${heading("Email Withheld")}
    ${paragraph(
      "An email to a member was NOT sent and will NOT be retried automatically.",
    )}
    ${infoTable([
      { label: "Template", value: escapeHtml(data.templateName) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
    ])}
    ${paragraph(
      `The booking's "No emails" setting could not be read, so the system withheld the message rather than risk sending one that was meant to be held back. ` +
        "The setting itself may well be off — check the booking, then re-send the message if it is.",
    )}
  `);
}
