import {
  adminDailyDigestTemplate,
  adminIssueReportTemplate,
  adminMaintenanceReportTemplate,
  adminServerVersionPausedTemplate,
  type AdminDigestCounts,
  type AdminDigestServerVersion,
} from "@/lib/email-templates/admin-ops";
import {
  getAdminAlertEmails,
  sendAdminAlertTo,
  sendToAdmins,
} from "./admin-alerts-shared";
import { renderEmailHtml } from "@/lib/email-theme";
import { describeServerVersionPause } from "@/lib/servernz-api-version";
import logger from "@/lib/logger";
import { shouldSendAdminSystemEmail } from "@/lib/notification-delivery-policies";

const DAILY_DIGEST_TEMPLATE = "admin-daily-digest";
const SERVER_VERSION_PAUSED_TEMPLATE = "admin-server-version-paused";

/**
 * N-13: Admin daily digest - and, since #49, the "central server version"
 * entry that rides it while syncing with the Alpine Central Server is paused.
 *
 * TWO AUDIENCES, TWO TEMPLATES (owner decision "second template"). The
 * digest's own readers (`adminDailyDigest`, Admin Overview edit) get the full
 * digest, `admin-daily-digest`: the counts and, when paused, the version entry.
 * Lodge Operations editors (`adminServerVersion`) who are NOT digest readers
 * get `admin-server-version-paused`, a separate message with its own default
 * subject and body: the counts are cross-area alert data their role does not
 * hold, so neither its HTML nor its `templateData` (what an admin override
 * renders from) carries a count key, not even a zero - and because it is its
 * own template, a club's override of the digest can neither garble it into
 * blank counts nor hide it; the club edits and mutes it on its own. A member in
 * both audiences is in the first set and gets exactly one email. When the
 * versions match the second audience is not resolved at all.
 */
export async function sendAdminDailyDigestAlert(input: {
  sections: AdminDigestCounts;
  /** Set while the central server's API version differs; null when it matches. */
  serverVersion: AdminDigestServerVersion | null;
}) {
  const { sections, serverVersion } = input;
  const delivery = await shouldSendAdminSystemEmail({
    templateName: DAILY_DIGEST_TEMPLATE,
  });
  if (!delivery.send) {
    logger.info(
      {
        templateName: DAILY_DIGEST_TEMPLATE,
        deliveryMode: delivery.mode,
        reason: delivery.reason,
      },
      "Skipped admin email by delivery policy",
    );
    return;
  }

  // The composed sentence an override renders from; empty when the versions
  // match, so a club's rewritten body says nothing on an ordinary day.
  const versionTokens = {
    serverVersionNote: serverVersion
      ? describeServerVersionPause(serverVersion.expected, serverVersion.server)
      : "",
    serverVersionExpected: serverVersion?.expected ?? "",
    serverVersionActual: serverVersion?.server ?? "",
  };

  const digestEmails = await getAdminAlertEmails("adminDailyDigest");
  await sendAdminAlertTo({
    emails: digestEmails,
    subject: `Admin Daily Digest - ${sections.totalAlerts} alert${sections.totalAlerts !== 1 ? "s" : ""} in past 24h`,
    html: await renderEmailHtml(() =>
      adminDailyDigestTemplate({
        ...sections,
        ...(serverVersion ? { serverVersion } : {}),
      }),
    ),
    templateName: DAILY_DIGEST_TEMPLATE,
    templateData: {
      ...sections,
      count: sections.totalAlerts,
      s: sections.totalAlerts === 1 ? "" : "s",
      ...versionTokens,
    },
    preferenceKey: "adminDailyDigest",
  });

  if (!serverVersion) return;

  // Its own delivery rule: a club mutes or keeps this message on its own.
  const pausedDelivery = await shouldSendAdminSystemEmail({
    templateName: SERVER_VERSION_PAUSED_TEMPLATE,
  });
  if (!pausedDelivery.send) {
    logger.info(
      {
        templateName: SERVER_VERSION_PAUSED_TEMPLATE,
        deliveryMode: pausedDelivery.mode,
        reason: pausedDelivery.reason,
      },
      "Skipped admin email by delivery policy",
    );
    return;
  }

  const alreadySent = new Set(digestEmails);
  const lodgeOnlyEmails = (await getAdminAlertEmails("adminServerVersion")).filter(
    (email) => !alreadySent.has(email),
  );
  if (lodgeOnlyEmails.length === 0) return;

  await sendAdminAlertTo({
    emails: lodgeOnlyEmails,
    // Static, purpose-written: no count and no number in the subject.
    subject: "Alpine Central Server version differs - syncing is paused",
    html: await renderEmailHtml(() => adminServerVersionPausedTemplate(serverVersion)),
    templateName: SERVER_VERSION_PAUSED_TEMPLATE,
    // Exactly the three version tokens: see the docblock.
    templateData: versionTokens,
    preferenceKey: "adminServerVersion",
  });
}

export async function sendAdminIssueReportAlert(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  issueReportUrl: string;
  hasScreenshot: boolean;
}) {
  await sendToAdmins({
    subject: `Issue Report: ${data.memberName}`,
    html: await renderEmailHtml(() => adminIssueReportTemplate({
      memberName: data.memberName,
      memberEmail: data.memberEmail,
      pageUrl: data.pageUrl,
      pageTitle: data.pageTitle,
      description: data.description,
      issueReportUrl: data.issueReportUrl,
      hasScreenshot: data.hasScreenshot,
    })),
    templateName: "admin-issue-report",
    templateData: {
      ...data,
      pageTitle: data.pageTitle ?? data.pageUrl,
    },
    preferenceKey: "adminIssueReport",
  });
}

/**
 * #2780: a maintenance report was lodged.
 *
 * WHO GETS THIS is not decided here. `sendToAdmins` resolves the audience from
 * the access-role matrix via the `adminMaintenanceReport` preference key, whose
 * requirement is `{ area: "lodge", level: "edit" }` — so "the maintenance
 * officer" is whoever the club has given Lodge Operations to, and a club with a
 * different committee shape changes a permission rather than a line of code.
 * The club-wide delivery rules at /admin/notification-rules still sit upstream
 * and can mute it entirely.
 *
 * `answersText` is the plain-text rendering of the same answers the HTML shows,
 * so an operator who has rewritten this template at /admin/email-messages gets
 * the answers too rather than a message that silently drops them.
 */
export async function sendAdminMaintenanceReportAlert(data: {
  lodgeName: string;
  reportedBy: string;
  sourceLabel: string;
  photoLabel: string;
  summary: string;
  answers: Array<{ label: string; value: string }>;
  maintenanceReportUrl: string;
}) {
  const answersText = data.answers
    .map((answer) => `${answer.label}: ${answer.value}`)
    .join("\n");

  await sendToAdmins({
    subject: `Maintenance report: ${data.lodgeName}`,
    html: await renderEmailHtml(() => adminMaintenanceReportTemplate(data)),
    templateName: "admin-maintenance-report",
    templateData: {
      lodgeName: data.lodgeName,
      reportedBy: data.reportedBy,
      sourceLabel: data.sourceLabel,
      photoLabel: data.photoLabel,
      summary: data.summary,
      answersText,
      maintenanceReportUrl: data.maintenanceReportUrl,
    },
    preferenceKey: "adminMaintenanceReport",
  });
}
