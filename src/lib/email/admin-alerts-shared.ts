import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  type AdminNotificationPreferenceKey,
  resolveEffectiveAdminNotificationPreferences,
} from "../admin-notification-preferences";
import {
  ADMIN_CAPABLE_MEMBER_WHERE,
  MEMBER_ACCESS_ROLE_SELECT,
} from "@/lib/access-role-definitions";
import {
  hasAdminAreaAccess,
  type AdminAccessRequirement,
} from "@/lib/admin-permissions";
import { CLUB_SUPPORT_EMAIL } from "@/config/club-identity";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { type EmailTemplateData } from "@/lib/email-message-renderer";
import {
  shouldSendAdminSystemEmail,
} from "@/lib/notification-delivery-policies";
import {
  recordAdminAlertDeliveryEscalation,
  type AdminAlertRecipientDeliveryOutcome,
} from "@/lib/email-admin-alert-escalation";
import { sendEmail } from "./core";
import { type EmailAttachment, shouldPersistEmailHtml } from "./internal";
import { type AdminAlertSendResult } from "./admin-alert-send-result";

/**
 * Candidate rows for any admin-audience email (#2548). The audience is decided
 * from the access-role permission matrix, so every candidate must arrive with
 * its assignment rows AND their joined definitions — a definition-backed custom
 * role has `role: null` and resolves to nothing without them, which is exactly
 * how those roles used to be dropped from every alert.
 *
 * `canLogin` is filtered in SQL (see ADMIN_CAPABLE_MEMBER_WHERE) and re-checked
 * in the matrix — a `canLogin: false` member resolves to the empty matrix — so
 * a deactivated or login-disabled account can never be mailed an operator
 * alert.
 */
const ADMIN_AUDIENCE_CANDIDATE_SELECT = {
  email: true,
  canLogin: true,
  accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
} as const;

// test seam
/**
 * Recipients for the system-level email-infrastructure alerts that are sent
 * directly rather than through a preference category — today the fail-closed
 * withhold alert in `email/core.ts`. Support & System editors own that surface
 * (`/admin/health`, `/admin/email-deliverability`), and a Full Admin holds
 * `support: edit`, so this is a superset of the Full Admins it used to resolve
 * from the legacy `role: "ADMIN"` scalar (#2548).
 */
export async function getAdminEmails(): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: ADMIN_CAPABLE_MEMBER_WHERE,
    select: ADMIN_AUDIENCE_CANDIDATE_SELECT,
  });
  return admins
    .filter((admin) =>
      hasAdminAreaAccess(admin, { area: "support", level: "edit" }),
    )
    .map((a) => a.email);
}

/**
 * Recipients of one alert category: everyone whose access-role matrix covers
 * the category's area and who has not switched that category off (#2548).
 * Categories outside a member's areas are masked off regardless of the stored
 * row, so widening the audience beyond Full Admins never leaks another area's
 * alerts to a scoped officer.
 */
async function getAdminAlertEmails(
  preferenceKey: AdminNotificationPreferenceKey,
): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: ADMIN_CAPABLE_MEMBER_WHERE,
    select: {
      ...ADMIN_AUDIENCE_CANDIDATE_SELECT,
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  return admins
    .filter(
      (admin) =>
        resolveEffectiveAdminNotificationPreferences(
          admin,
          admin.notificationPreference,
        )[preferenceKey],
    )
    .map((admin) => admin.email);
}

/**
 * Send an email to all active admins who opted into the alert category, and
 * say what happened to each recipient (`AdminAlertSendResult`). Callers that
 * do not hold a claim ignore the result.
 */
export async function sendToAdmins({
  subject,
  html,
  templateName,
  preferenceKey,
  templateData,
  attachments,
}: {
  subject: string;
  html: string;
  templateName: string;
  preferenceKey: AdminNotificationPreferenceKey;
  templateData?: EmailTemplateData;
  attachments?: EmailAttachment[];
}): Promise<AdminAlertSendResult> {
  const delivery = await shouldSendAdminSystemEmail({ templateName });
  if (!delivery.send) {
    logger.info(
      { templateName, deliveryMode: delivery.mode, reason: delivery.reason },
      "Skipped admin email by delivery policy",
    );
    return {
      deliveryAllowed: false,
      recipients: 0,
      sent: 0,
      queuedForRetry: 0,
      notDelivered: 0,
    };
  }

  // A FAILED row is replayed only when it kept its body (`core.ts`); a
  // sensitive template's does not, and goes to the review queue instead.
  const failedRowIsReplayed = shouldPersistEmailHtml(templateName);
  const emails = await getAdminAlertEmails(preferenceKey);
  const outcomes = await Promise.all(
    emails.map(async (email): Promise<
      AdminAlertRecipientDeliveryOutcome & { queuedForRetry: boolean }
    > => {
      try {
        const outcome = await sendEmail({
          to: email,
          subject,
          html,
          // Admin-audience alerts are NEVER withheld by a booking flag (#2258).
          // Belt and braces: the gate also exempts them by registry audience, so
          // even a future caller that threaded a bookingId here could not
          // silence an operator alert.
          bookingContext: "none",
          templateName,
          templateData,
          attachments,
        });

        // Admin alert recipients are real admin addresses, never walk-in
        // placeholders (#1935); fold the not-sent outcomes into "suppressed".
        // An environment FAULT (not a confirmed non-production copy) leaves a
        // FAILED row the retry cron sends once the installation is corrected.
        return {
          status: outcome.status === "sent" ? "sent" : "suppressed",
          queuedForRetry:
            outcome.status === "withheld_for_environment" &&
            outcome.reason !== "environment_non_production" &&
            failedRowIsReplayed,
        };
      } catch (err) {
        logger.error(
          { err, to: email, templateName },
          "Failed to send admin alert",
        );
        // A transport failure marks this recipient's EmailLog row FAILED for
        // the retry cron. Stated limit: a throw before that row exists (the
        // message settings unreadable) is counted the same, and its
        // undeliverable escalation below is then the only trail.
        return { status: "failed", queuedForRetry: failedRowIsReplayed };
      }
    }),
  );

  if (
    outcomes.length > 0 &&
    outcomes.every((outcome) => outcome.status !== "sent")
  ) {
    await recordAdminAlertDeliveryEscalation({
      templateName,
      preferenceKey,
      outcomes: outcomes.map(({ status }) => ({ status })),
    }).catch((err) =>
      logger.error(
        { err, templateName },
        "Failed to record undeliverable admin alert escalation",
      ),
    );
  }
  const sent = outcomes.filter((outcome) => outcome.status === "sent").length;
  const queuedForRetry = outcomes.filter(
    (outcome) => outcome.status !== "sent" && outcome.queuedForRetry,
  ).length;
  return {
    deliveryAllowed: true,
    recipients: outcomes.length,
    sent,
    queuedForRetry,
    notDelivered: outcomes.length - sent - queuedForRetry,
  };
}

/**
 * Recipients for an alert nobody may mute (#2761).
 *
 * Same audience rule as every other admin alert — whoever's access-role matrix
 * can EDIT the area that owns the work — with the per-member notification
 * preference deliberately NOT read. The permission is not a mute: it is who the
 * club has made responsible. The checkbox is a mute, and the owner's decision
 * (10 Aug 2026) is that an automatic money movement is not silenceable.
 *
 * AND IT CANNOT COME BACK EMPTY, which is the other half of that decision. A club
 * can genuinely have nobody holding an area at `edit` — a small club running on
 * one Full Admin who was just deactivated, or a custom role set that lost finance
 * edit — and `sendToAdmins` would then send zero emails and log nothing anybody
 * reads. Two fallbacks, each strictly wider than the last:
 *
 * 1. the area's own editors;
 * 2. Support & System editors (`getAdminEmails`), the audience the locked
 *    email-infrastructure alerts already use — for the built-in roles that is the
 *    Full Admins. **Note what this can widen to:** `support: edit` is a different
 *    area from the one that owns the alert, so a club whose custom role set has a
 *    tech-support editor and no finance editor mails that person a body carrying
 *    the member's name, stay, refunded amount and payment identifiers. That is a
 *    declared trade-off, recorded in `INV-ADDPAY-038` and
 *    `docs/guides/notification-recipients.md`: reaching somebody in a degraded
 *    state beats reaching nobody, and the state is logged.
 * 3. the club's own SUPPORT ADDRESS, resolved the way every other outbound mail
 *    resolves it — `EmailMessageSetting.supportEmail` (what an admin typed into
 *    `/admin/email-messages`), else `config/club.json`'s. It is deliberately NOT
 *    `CLUB_SUPPORT_EMAIL`: that constant is `SAFE_DEFAULT_CONFIG.supportEmail`,
 *    the frozen unconfigured-club literal `support@example.org`, which SES accepts
 *    and bounces asynchronously — `sendEmail` would report "sent", the
 *    undeliverable escalation below would never fire, and the alert would vanish
 *    in exactly the state this fallback exists for. The literal survives only as
 *    the last guard against a blank setting, which `getDefaultEmailMessageSettings`
 *    already makes unreachable in practice.
 *
 * The caller is told which one answered so it can log it: falling past the first
 * step means the club's own permission setup no longer names anybody for this
 * work, and that is worth seeing in the logs even though the mail went out.
 */
async function resolveUnmuteableAdminAlertRecipients(
  requirement: AdminAccessRequirement,
): Promise<{ emails: string[]; source: "area" | "support" | "club-support" }> {
  const admins = await prisma.member.findMany({
    where: ADMIN_CAPABLE_MEMBER_WHERE,
    select: ADMIN_AUDIENCE_CANDIDATE_SELECT,
  });
  const areaEditors = admins
    .filter((admin) => hasAdminAreaAccess(admin, requirement))
    .map((admin) => admin.email);
  if (areaEditors.length > 0) {
    return { emails: areaEditors, source: "area" };
  }

  const supportEditors = await getAdminEmails();
  if (supportEditors.length > 0) {
    return { emails: supportEditors, source: "support" };
  }

  return {
    emails: [await resolveClubSupportMailbox()],
    source: "club-support",
  };
}

/**
 * The club's real support mailbox, for the last rung of the ladder above.
 *
 * DB-first through the same loader every outbound email already uses, so the
 * address is whatever the club typed into `/admin/email-messages` — and
 * `config/club.json`'s when nothing is stored. Wrapped because this runs in the
 * state where things are already going wrong: a settings read that throws must not
 * turn "nobody holds finance edit" into "no mail at all", so it degrades to the
 * frozen literal and says so.
 */
async function resolveClubSupportMailbox(): Promise<string> {
  try {
    const settings = await loadEmailMessageSettings();
    const configured = settings.supportEmail?.trim();
    if (configured) return configured;
  } catch (err) {
    logger.error(
      { err },
      "Could not read the club's support address for an unmuteable admin alert; falling back to the bootstrap default",
    );
  }
  return CLUB_SUPPORT_EMAIL;
}

/**
 * Send an admin alert that no notification preference can silence (#2761).
 *
 * The difference from `sendToAdmins` is exactly two things: no per-member
 * preference is read, and the recipient set cannot be empty (see above). Everything
 * else is deliberately identical — the same audience-by-permission rule, the same
 * per-recipient error isolation, and the same undeliverable escalation when not one
 * recipient received it.
 *
 * IT DOES NOT CONSULT THE CLUB-WIDE DELIVERY POLICY EITHER, and that is not an
 * oversight. Every template sent through here is in
 * `LOCKED_DELIVERY_TEMPLATE_NAMES`, so `/admin/notification-delivery-policies`
 * refuses to change its mode — but `shouldSendAdminSystemEmail` reads whatever row
 * is in the table regardless of the lock, so consulting it would leave one more
 * way for a stray row to mute an automatic money movement. The fail-closed
 * withhold alert in `email/core.ts` takes the same direct route for the same
 * reason.
 */
export async function sendUnmuteableAdminAlert({
  subject,
  html,
  templateName,
  templateData,
  requirement,
}: {
  subject: string;
  html: string;
  templateName: string;
  templateData?: EmailTemplateData;
  /** The area whose editors own the work this alert reports. */
  requirement: AdminAccessRequirement;
}) {
  const { emails, source } = await resolveUnmuteableAdminAlertRecipients(
    requirement,
  );
  if (source !== "area") {
    logger.warn(
      { templateName, recipientSource: source, recipientCount: emails.length },
      "Sent an unmuteable admin alert to a fallback audience: nobody holds edit access to the area that owns it",
    );
  }

  const outcomes = await Promise.all(
    emails.map(async (email): Promise<AdminAlertRecipientDeliveryOutcome> => {
      try {
        const outcome = await sendEmail({
          to: email,
          subject,
          html,
          // Admin-audience alerts are NEVER withheld by a booking flag (#2258).
          bookingContext: "none",
          templateName,
          templateData,
        });
        return { status: outcome.status === "sent" ? "sent" : "suppressed" };
      } catch (err) {
        logger.error(
          { err, to: email, templateName },
          "Failed to send unmuteable admin alert",
        );
        return { status: "failed" };
      }
    }),
  );

  if (outcomes.every((outcome) => outcome.status !== "sent")) {
    // No `outcomes.length > 0` guard, unlike sendToAdmins: an empty set is
    // impossible here by construction, so if one ever appears it is a defect and
    // must escalate rather than pass as "nothing to do".
    await recordAdminAlertDeliveryEscalation({
      templateName,
      // There is no preference key — that is the point of this path — and the
      // escalation record says so rather than naming one that does not gate it.
      preferenceKey: "none (delivery-locked)",
      outcomes,
    }).catch((err) =>
      logger.error(
        { err, templateName },
        "Failed to record undeliverable unmuteable admin alert escalation",
      ),
    );
  }
}

export async function shouldSendDirectAdminSystemEmail(templateName: string) {
  const delivery = await shouldSendAdminSystemEmail({ templateName });
  if (!delivery.send) {
    logger.info(
      { templateName, deliveryMode: delivery.mode, reason: delivery.reason },
      "Skipped direct admin email by delivery policy",
    );
    return false;
  }
  return true;
}
