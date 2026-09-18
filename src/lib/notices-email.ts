import "server-only";

import { getAppBaseUrl } from "@/lib/app-url";
import { createAuditLog } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { noticePublishedTemplate } from "@/lib/email-templates/communications";
import logger from "@/lib/logger";
import {
  resolveNoticeAudienceMembers,
  type ResolvedAudienceMember,
} from "@/lib/notices";
import { prisma } from "@/lib/prisma";
import { renderEmailHtml } from "@/lib/email-theme";

// Throttling mirrors the admin bulk-communication send loop so a large audience
// never overwhelms SMTP.
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

/**
 * Email a published notice to its audience. Runs OUTSIDE any DB transaction and
 * is intended to be invoked fire-and-forget AFTER the publish transaction
 * commits and AFTER the caller has claimed the single-send guard (emailedAt).
 *
 * Preference + suppression handling mirrors the Communications bulk send:
 *  - recipients are filtered to those who opted in to `marketingEmails` (the
 *    same opt-in club-communication preference the bulk-communication path
 *    uses; no dedicated notice preference exists — see the carry-forward note);
 *  - EmailSuppression is enforced automatically inside sendEmail.
 *
 * The financialMembersOnly audience filter is already applied by
 * resolveNoticeAudienceMembers.
 *
 * Crash safety around the caller's claim-first emailedAt guard:
 *  - if the PRE-SEND phase throws (audience resolution, preference lookup,
 *    base-URL) before any email is attempted, the single-send claim is RELEASED
 *    (guarded so only a still-claimed row is cleared) so a later re-publish can
 *    retry — no email was sent, so concurrent publishes still never double-send;
 *  - a crash once the send loop has begun never releases the claim (some
 *    recipients may already have the email — releasing would double-email them);
 *  - after the batch, an audit record is written with the send counts.
 */
export async function sendNoticePublishedEmails(
  noticeId: string,
): Promise<{ sent: number; skipped: number }> {
  // --- Pre-send resolution phase: nothing is emailed here yet. ---
  let notice: { id: string; title: string; status: string } | null;
  let audience: ResolvedAudienceMember[];
  let recipients: ResolvedAudienceMember[];
  let firstNameById: Map<string, string>;
  let noticeUrl: string;
  try {
    notice = await prisma.notice.findUnique({
      where: { id: noticeId },
      select: { id: true, title: true, status: true },
    });
    if (!notice || notice.status !== "PUBLISHED") {
      return { sent: 0, skipped: 0 };
    }

    audience = await resolveNoticeAudienceMembers(noticeId);

    // Filter to members opted in to club communications (marketingEmails).
    const prefs = await prisma.member.findMany({
      where: { id: { in: audience.map((a) => a.memberId) } },
      select: {
        id: true,
        firstName: true,
        notificationPreference: { select: { marketingEmails: true } },
      },
    });
    firstNameById = new Map(prefs.map((p) => [p.id, p.firstName]));
    const optedIn = new Set(
      prefs
        .filter((p) => p.notificationPreference?.marketingEmails === true)
        .map((p) => p.id),
    );

    recipients = audience.filter((a) => optedIn.has(a.memberId));
    noticeUrl = `${getAppBaseUrl()}/notices/${noticeId}`;
  } catch (err) {
    // Crash before any email was attempted. Release the single-send claim so a
    // later publish can retry. Guarded (emailedAt not null) so a concurrent
    // successful send is never clobbered; because nothing was sent on this
    // attempt, releasing cannot cause a double-send.
    await prisma.notice
      .updateMany({
        where: { id: noticeId, emailedAt: { not: null } },
        data: { emailedAt: null },
      })
      .catch((resetErr) =>
        logger.error(
          { err: resetErr, noticeId },
          "Failed to release notice single-send claim after pre-send failure",
        ),
      );
    logger.error(
      { err, noticeId },
      "Notice email pre-send failed before any send; released single-send claim so a re-publish can retry",
    );
    return { sent: 0, skipped: 0 };
  }

  // --- Send phase: throttled; per-recipient failures are logged and skipped
  //     (mirrors the Communications bulk send). A crash here must NOT reset
  //     emailedAt, since earlier recipients in the batch already received it. ---
  let sent = 0;
  let failed = 0;
  const optedOut = audience.length - recipients.length;

  for (const [i, recipient] of recipients.entries()) {
    const firstName = firstNameById.get(recipient.memberId) ?? "there";
    try {
      const outcome = await sendEmail({
        to: recipient.email,
        subject: `New notice: ${notice.title}`,
        html: await renderEmailHtml(() => noticePublishedTemplate(firstName, notice.title, noticeUrl)),
        // Member notices are club-wide, not about any booking (#2258).
        bookingContext: "none",
        templateName: "notice-published",
        templateData: {
          firstName,
          noticeTitle: notice.title,
          noticeUrl,
        },
      });
      if (outcome.status === "sent") {
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      failed += 1;
      logger.error(
        { err, memberId: recipient.memberId, noticeId },
        "Failed to send notice-published email",
      );
    }

    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < recipients.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // Durable audit record of the send so admins have a trail (per-recipient
  // failures are already logged). Never let an audit-write failure surface.
  await createAuditLog({
    action: "notice.emailSent",
    entityType: "Notice",
    entityId: noticeId,
    category: "communication",
    severity: "info",
    outcome: "success",
    summary: "Notice published email sent to audience",
    metadata: {
      noticeId,
      audienceCount: audience.length,
      recipientCount: recipients.length,
      sentCount: sent,
      failedCount: failed,
      optedOutCount: optedOut,
    },
  }).catch((err) =>
    logger.error({ err, noticeId }, "Failed to write notice email audit log"),
  );

  return { sent, skipped: optedOut + failed };
}
