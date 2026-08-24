import { EMAIL_FROM } from "../email-sender";
import { htmlToPlainText } from "../email-text";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  formatEmailFromAddressWithSettings,
} from "@/lib/email-message-settings";
import {
  prepareEmailMessage,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";
import {
  getActiveEmailSuppression,
  normalizeEmailAddress,
} from "@/lib/email-suppression";
import {
  resolveBookingEmailGate,
  type EmailBookingContext,
} from "@/lib/booking-email-suppression";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
import { resolveBookingEmailLink } from "@/lib/booking-email-authority";
import {
  finalizeBookingEmailHtml,
  hasBookingDetailHref,
} from "@/lib/booking-email-html";
import {
  getEmailTransporter,
  logDeliveredTransport,
  shouldPersistEmailHtml,
  type EmailAttachment,
} from "./internal";
import {
  resolveEmailEnvironmentGate,
  type EmailEnvironmentWithheldReason,
} from "./environment-gate";
// A pure string builder, and `email-message-renderer` above already pulls the
// template layer in, so this adds no failure mode to the alert that reports a
// failure (#2689).
import { adminEmailWithheldTemplate } from "@/lib/email-templates/admin-ops";
import {
  ensureEmailPaletteReady,
  renderEmailHtml,
} from "@/lib/email-theme";

export type EmailSendOutcome =
  | {
      status: "sent";
      emailLogId: string | null;
      messageId: string | null;
    }
  | {
      status: "suppressed";
      emailLogId: string | null;
      emailSuppressionId: string;
      reason: string;
    }
  // A club-internal walk-in placeholder recipient (#1935): the owner has no
  // real address, so nothing is ever sent — independent of any notify choice.
  | {
      status: "skipped_placeholder_recipient";
      emailLogId: null;
      reason: string;
    }
  // #2258 (owner decision D10): the booking this message belongs to carries the
  // per-booking "No emails" switch, so nothing was transmitted. `reason`
  // separates the deliberate case from the fail-closed one:
  //   booking_no_emails      — the switch is on (EmailLog SKIPPED_NO_EMAILS)
  //   booking_flag_unreadable — the switch could not be read, so the gate
  //                             withheld the send anyway (EmailLog FAILED, so
  //                             the retry cron re-evaluates it later)
  // Callers are NOT expected to act on this: almost every booking send is an
  // un-awaited `.catch(log)`, so the mailer records the outcome itself.
  | {
      status: "withheld_for_booking";
      emailLogId: string | null;
      bookingId: string;
      reason: "booking_no_emails" | "booking_flag_unreadable";
    }
  // #3035 (ENV-SAFETY 2): the environment-safety delivery boundary held the
  // message back. `reason` separates the two cases, which need opposite
  // treatment and must never be collapsed into one another or into the
  // booking-scoped withhold above:
  //   environment_non_production — a confirmed copy pointed at a live provider. A
  //                                terminal outcome (EmailLog
  //                                SKIPPED_NON_PRODUCTION), nothing to retry,
  //                                nothing wrong.
  //   environment_unknown        — nothing has declared which installation this
  //                                is. A FAULT: EmailLog FAILED with a
  //                                deliveryBlockReason.
  //   capture_transport_in_production — the live site declares a capture mailbox.
  //                                Also a FAULT; it clears when the transport
  //                                flags are corrected.
  // BOTH FAULTS ARE REPLAYABLE ONLY IF THE ROW HOLDS A BODY — not so for the 26
  // SENSITIVE_EMAIL_LOG_TEMPLATES or a redacted recipient, where the gate writes
  // the retry ceiling instead so it lands in the review queue for a manual
  // re-send. Reasoning: `environment-gate.ts`.
  // A copy that has DECLARED a capture mailbox never appears here: it transmits
  // into the capture and the outcome is an ordinary `sent`.
  | {
      status: "withheld_for_environment";
      emailLogId: string | null;
      reason: EmailEnvironmentWithheldReason;
    };

function assertNoCrlf(value: string, field: string) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Email header field ${field} contains CR/LF`);
  }
}

// Defense-in-depth: subject lines interpolate user-controlled member names
// (issue #323). Schema-level sanitization at API boundaries is the first line
// of defense, but a contaminated row from before the fix would still trip the
// CRLF guard on `from`/`to`. Strip CRLF from the subject before send so the
// email never silently fails — `from`/`to` keep the throw because CRLF there
// indicates a configuration/normalizer bug, not user input.
function sanitizeEmailSubject(subject: string) {
  return subject.replace(/[\r\n]+/g, " ").trim();
}


// ---------------------------------------------------------------------
// #2258 FAIL-CLOSED ALERT.
//
// A deliberate withhold is visible: it lands in the booking's withheld list.
// A fail-CLOSED withhold is not. It writes a FAILED EmailLog row so the retry
// cron can re-evaluate it — but for the sensitive, body-less templates
// (SENSITIVE_EMAIL_LOG_TEMPLATES, which includes booking-confirmed) the cron's
// query requires a retained htmlBody, so it never sees the row; attempts stays
// at 1, so it never reaches the >=3 exhausted-retry review queue either. The
// member is silently owed an email nobody knows about. Tell an operator.
//
// Sent as `admin-email-failure`, the locked system template already used for
// "this email will not be delivered and will not be retried", to every active
// admin — the same direct shape cron-email-retry uses for it. Deliberately NOT
// routed through sendToAdmins/a notification preference: this template is in
// LOCKED_DELIVERY_TEMPLATE_NAMES precisely because an admin must not be able to
// mute it, and a preference key would let them.
//
// Imported dynamically because admin-alerts-shared imports this module.
// Throttled per booking+template so a database outage — where EVERY send fails
// closed — cannot turn one fault into an alert storm.
const FAIL_CLOSED_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
// Global ceiling as well as the per-key one: a partial database fault silences
// MANY bookings at once, and the per-key throttle alone lets N bookings x M
// templates each fan out to every admin, awaited inline in the send path.
const FAIL_CLOSED_ALERT_GLOBAL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_CLOSED_ALERT_GLOBAL_MAX = 5;
const failClosedAlertSentAt = new Map<string, number>();
let failClosedAlertWindowStart = 0;
let failClosedAlertWindowCount = 0;

/** Test seam: the throttle is module state and must not leak between tests. */
export function __resetFailClosedAlertThrottle() {
  failClosedAlertSentAt.clear();
  failClosedAlertWindowStart = 0;
  failClosedAlertWindowCount = 0;
}

async function alertAdminsOfFailClosedWithhold(params: {
  bookingId: string;
  templateName: string;
  recipient: string;
}) {
  const key = `${params.bookingId}:${params.templateName}`;
  const now = Date.now();
  const last = failClosedAlertSentAt.get(key);
  if (last != null && now - last < FAIL_CLOSED_ALERT_COOLDOWN_MS) return;

  if (now - failClosedAlertWindowStart >= FAIL_CLOSED_ALERT_GLOBAL_WINDOW_MS) {
    failClosedAlertWindowStart = now;
    failClosedAlertWindowCount = 0;
  }
  if (failClosedAlertWindowCount >= FAIL_CLOSED_ALERT_GLOBAL_MAX) {
    logger.error(
      { bookingId: params.bookingId, templateName: params.templateName },
      "Suppressed a fail-closed withhold alert: the global alert ceiling for this window is reached (a broad database fault is withholding many emails)",
    );
    return;
  }

  const { getAdminEmails } = await import("./admin-alerts-shared");
  const admins = await getAdminEmails();
  const html = await renderEmailHtml(() => adminEmailWithheldTemplate({
    templateName: params.templateName,
    bookingId: params.bookingId,
  }));
  for (const admin of admins) {
    await sendEmail({
      to: admin,
      subject: "An email to a member could not be sent",
      html,
      templateName: "admin-email-failure",
      templateData: {
        originalTemplateName: params.templateName,
        bookingId: params.bookingId,
        originalRecipient: params.recipient,
        // Required by the admin-email-failure registry template. This alert is
        // raised on the FIRST fail-closed withhold, so the count is 1.
        attemptCount: 1,
      },
      // Admin audience: unsuppressible by design, and this alert exists
      // precisely because a booking-scoped send could not be evaluated.
      bookingContext: "none",
    });
  }

  // Arm the throttle only AFTER a successful send. Arming it up front meant
  // that in the very scenario this alert exists for — a database outage, where
  // getAdminEmails() is itself a failing prisma call — the first attempt threw,
  // the key stayed armed for the whole cooldown, and the operator was never
  // told about anything withheld during the outage.
  failClosedAlertSentAt.set(key, Date.now());
  failClosedAlertWindowCount += 1;
  // Bound the map: this process can see many bookings over its lifetime.
  if (failClosedAlertSentAt.size > 500) {
    const cutoff = Date.now();
    for (const [entryKey, at] of failClosedAlertSentAt) {
      if (cutoff - at >= FAIL_CLOSED_ALERT_COOLDOWN_MS) {
        failClosedAlertSentAt.delete(entryKey);
      }
    }
  }
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  templateName = "unknown",
  templateData,
  attachments,
  logRecipient,
  lodgeId,
  bookingContext,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  templateName?: string;
  templateData?: EmailTemplateData;
  attachments?: EmailAttachment[];
  logRecipient?: string;
  // Lodge whose identity this message carries (multi-lodge phase 8);
  // omitted/null resolves the club's default lodge identity.
  lodgeId?: string | null;
  // Which booking this message belongs to (#2258). REQUIRED and a discriminated
  // union on purpose: every new send site is a compile error until its author
  // states either the real booking id or the explicit `"none"`. A booking-scoped
  // message that passes `"none"` escapes the per-booking "No emails" switch, so
  // thread the real id wherever one exists.
  bookingContext: EmailBookingContext;
}): Promise<EmailSendOutcome> {
  // Backstop for the render gate (#2900). Callers build `html` inside
  // `renderEmailHtml()`, so the palette is normally loaded before this line —
  // this await then costs nothing. It still matters for the renders that happen
  // BELOW it: `prepareEmailMessage` re-renders the whole shell when a stored
  // body override applies, and `alertAdminsOfFailClosedWithhold` builds a
  // template of its own. It also means a cron retry replaying HTML rendered by
  // an older process still warms this process's palette for the next message.
  await ensureEmailPaletteReady();

  const bookingLink =
    bookingContext === "none"
      ? null
      : await resolveBookingEmailLink({
          bookingId: bookingContext.bookingId,
          templateName,
          recipient: bookingContext.recipient,
          deliveryAddress: to,
        });
  const prepared = await prepareEmailMessage({
    templateName,
    subject,
    html,
    templateData: {
      ...(templateData ?? {}),
      bookingUrl: bookingLink?.bookingUrl ?? "",
    },
    lodgeId,
  });
  prepared.html = finalizeBookingEmailHtml({
    html: prepared.html,
    bookingUrl: bookingLink?.bookingUrl ?? null,
    bookingScoped: bookingContext !== "none",
    bodyOverrideApplied: prepared.bodyOverrideApplied,
  });
  const from = formatEmailFromAddressWithSettings(
    prepared.settings,
    EMAIL_FROM,
  );
  const plainTextBody = text || htmlToPlainText(prepared.html);
  const normalizedRecipient = normalizeEmailAddress(to);

  // Walk-in placeholder owners (#1935) have a club-internal, undeliverable
  // `.invalid` address stored so `Member.email` stays non-nullable. No message
  // is ever sent to them — this short-circuits every send path (booking
  // confirmation/hold, waitlist, cron, webhooks) regardless of any per-booking
  // notify choice, and it does not create an EmailLog row (nothing was queued).
  if (isPlaceholderContactEmail(normalizedRecipient)) {
    logger.info(
      { templateName },
      "Skipped email to walk-in placeholder recipient",
    );
    return {
      status: "skipped_placeholder_recipient",
      emailLogId: null,
      reason: "placeholder_recipient",
    };
  }

  const emailLogRecipient = logRecipient?.trim() || to;
  const recipientRedactedInLogs = emailLogRecipient !== to;
  const persistHtmlBody =
    !recipientRedactedInLogs && shouldPersistEmailHtml(templateName);
  const sanitizedSubject = sanitizeEmailSubject(prepared.subject);

  assertNoCrlf(from, "from");
  assertNoCrlf(to, "to");
  assertNoCrlf(normalizedRecipient, "to");
  assertNoCrlf(emailLogRecipient, "logRecipient");

  // Create EmailLog record (fire-and-forget logging won't break email delivery)
  let emailLogId: string | null = null;
  try {
    const log = await prisma.emailLog.create({
      data: {
        to: emailLogRecipient,
        subject: sanitizedSubject,
        templateName,
        // New booking rows quarantine retryable HTML from the pre-#2362
        // worker, whose fixed query selects only legacy htmlBody. This makes a
        // later application rollback fail closed without withholding the
        // initial send. Sensitive templates remain unretained in both fields.
        htmlBody:
          bookingContext === "none" && persistHtmlBody ? prepared.html : null,
        status: "QUEUED",
        lastAttemptAt: new Date(),
        // #2258: booking attribution on every booking-scoped message, not just
        // withheld ones — the retry cron re-evaluates the switch from this
        // column before it replays a FAILED row.
        bookingId: bookingContext === "none" ? null : bookingContext.bookingId,
        // #2362: retries must repeat the current authority check from a durable
        // identity. `to` is deliberately never treated as proof of access.
        // The nullable override flag doubles as the provenance marker: null is
        // a legacy/unknown row; false/true means this context was recorded.
        ...(bookingContext === "none"
          ? {}
          : {
              bookingRecipientMemberId:
                bookingContext.recipient.kind === "member"
                  ? bookingContext.recipient.memberId
                  : null,
              bookingBodyOverrideApplied: prepared.bodyOverrideApplied,
              bookingDetailLinkIncluded: hasBookingDetailHref(prepared.html),
              bookingRetryHtmlBody: persistHtmlBody ? prepared.html : null,
            }),
      },
    });
    emailLogId = log.id;
  } catch (err) {
    logger.error({ err }, "Failed to create EmailLog record");
  }

  // ---------------------------------------------------------------------
  // Per-booking "No emails" switch (#2258, owner decision D10).
  //
  // Runs BEFORE the SES bounce check and before the dev-mode short-circuit, so
  // no code path below can transmit. Note the deliberate asymmetry with the
  // bounce check further down: THAT one fails open (`.catch(... return null)`)
  // because an unreachable suppression table must not stop the club's mail.
  // This one fails CLOSED — see booking-email-suppression.ts.
  // ---------------------------------------------------------------------
  const bookingGate = await resolveBookingEmailGate(bookingContext, templateName);
  if (bookingGate.decision !== "send") {
    const withheld = bookingGate.decision === "withhold";
    const errorMessage = withheld
      ? 'Withheld: this booking has the "No emails" switch turned on'
      : 'Withheld: the booking\'s "No emails" switch could not be read, so the send failed closed';
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            // A deliberate withhold is terminal and must never be replayed, so
            // it gets its own status and its body is dropped. An unreadable
            // switch is a transient fault: FAILED lets the retry cron pick the
            // row up again, and that cron re-checks the switch before replaying.
            status: withheld ? "SKIPPED_NO_EMAILS" : "FAILED",
            ...(withheld
              ? { htmlBody: null, bookingRetryHtmlBody: null }
              : {}),
            errorMessage,
          },
        });
      } catch (err) {
        logger.error(
          { err, to: emailLogRecipient, templateName },
          "Failed to update EmailLog for a withheld booking email",
        );
      }
    }

    logger.warn(
      {
        to: emailLogRecipient,
        templateName,
        bookingId: bookingGate.bookingId,
        failClosed: !withheld,
      },
      withheld
        ? 'Withheld email for a booking with "No emails" turned on'
        : 'Withheld email: the booking\'s "No emails" switch could not be read',
    );

    if (!withheld) {
      // Fire-and-forget: the alert must never turn a withheld send into a
      // thrown error for the caller, and most callers do not await this at all.
      await alertAdminsOfFailClosedWithhold({
        bookingId: bookingGate.bookingId,
        templateName,
        recipient: emailLogRecipient,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId: bookingGate.bookingId, templateName },
          "Failed to alert admins about a fail-closed withheld email",
        ),
      );
    }

    return {
      status: "withheld_for_booking",
      emailLogId,
      bookingId: bookingGate.bookingId,
      reason: withheld ? "booking_no_emails" : "booking_flag_unreadable",
    };
  }

  const activeSuppression = await getActiveEmailSuppression(
    normalizedRecipient,
  ).catch((err) => {
    logger.error(
      { err, to: emailLogRecipient, templateName },
      "Failed to check email suppression state",
    );
    return null;
  });

  if (activeSuppression) {
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "BOUNCED",
            htmlBody: null,
            bookingRetryHtmlBody: null,
            errorMessage: `Email suppressed after SES ${activeSuppression.reason.toLowerCase()} feedback`,
          },
        });
      } catch (err) {
        logger.error(
          { err, to: emailLogRecipient },
          "Failed to update suppressed email log",
        );
      }
    }

    logger.warn(
      {
        to: emailLogRecipient,
        templateName,
        emailSuppressionId: activeSuppression.id,
        reason: activeSuppression.reason,
      },
      "Skipped email to suppressed recipient",
    );
    return {
      status: "suppressed",
      emailLogId,
      emailSuppressionId: activeSuppression.id,
      reason: activeSuppression.reason,
    };
  }

  // Environment-safety boundary (#3035, ENV-SAFETY 2; epic #2986). LAST of the
  // four gates on purpose: the three above are facts about THIS message and
  // recipient and are true on any installation, so each stays recorded as itself
  // on a copy; this one is about the INSTALLATION and is the backstop underneath
  // them. It sits ABOVE the dev-mode short-circuit below, which is now a local
  // convenience and no longer the safety authority. Reasoning and the two
  // EmailLog shapes: `environment-gate.ts`.
  const environmentGate = await resolveEmailEnvironmentGate({
    emailLogId,
    templateName,
    logRecipient: emailLogRecipient,
    // #3035: does this row hold a body the retry cron could replay? The same
    // value the EmailLog row was created with, so the two cannot disagree.
    bodyRetainedForReplay: persistHtmlBody,
  });
  if (environmentGate.decision !== "send") {
    return {
      status: "withheld_for_environment",
      emailLogId,
      reason: environmentGate.reason,
    };
  }

  if (process.env.NODE_ENV === "development") {
    logger.info(
      { to: emailLogRecipient, subject: sanitizedSubject, templateName },
      "Email sent (dev mode)",
    );
    if (persistHtmlBody) {
      logger.debug({ html: prepared.html }, "Email HTML content");
    } else {
      logger.debug(
        { templateName },
        "Email HTML content redacted for sensitive template",
      );
    }
    // Mark as SENT in dev mode
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: { status: "SENT", sentAt: new Date() },
        });
      } catch (err) {
        logger.error(
          { err, to: emailLogRecipient, templateName },
          "Failed to update EmailLog",
        );
      }
    }
    return {
      status: "sent",
      emailLogId,
      messageId: null,
    };
  }

  try {
    const { transporter, modeLabel } = await getEmailTransporter(
      environmentGate.clearance,
    );
    const result = await transporter.sendMail({
      from,
      to,
      subject: sanitizedSubject,
      html: prepared.html,
      text: plainTextBody,
      attachments,
    });

    // Which transport carried it, at a level an operator sees when that matters
    // (#3035 review). Reasoning in `logDeliveredTransport`.
    logDeliveredTransport({
      templateName,
      to: emailLogRecipient,
      modeLabel,
    });

    // Update EmailLog to SENT
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "SENT",
            sentAt: new Date(),
            messageId: result.messageId || null,
          },
        });
      } catch (err) {
        logger.error({ err }, "Failed to update EmailLog to SENT");
      }
    }
    return {
      status: "sent",
      emailLogId,
      messageId: result.messageId || null,
    };
  } catch (err) {
    // Update EmailLog to FAILED
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "FAILED",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (logErr) {
        logger.error({ err: logErr }, "Failed to update EmailLog to FAILED");
      }
    }
    if (!persistHtmlBody) {
      logger.warn(
        { templateName },
        "Sensitive email delivery failed and cannot be automatically retried because HTML retention is disabled",
      );
    }
    throw err;
  }
}

/**
 * N-08: Check notification preferences before sending a member email.
 * Maps template categories to preference fields.
 * Admin alerts bypass preferences entirely.
 */
const CATEGORY_TO_PREFERENCE: Record<
  string,
  keyof Omit<
    import("@prisma/client").NotificationPreference,
    "id" | "memberId" | "createdAt" | "updatedAt"
  >
> = {
  bookingConfirmation: "bookingConfirmation",
  bookingReminder: "bookingReminder",
  bookingBumped: "bookingBumped",
  bookingCancelled: "bookingCancelled",
  choreRoster: "choreRoster",
  bookingWaitlist: "bookingWaitlist",
  marketingEmails: "marketingEmails",
};

// test seam
export async function shouldSendEmail(
  memberId: string,
  category: string,
): Promise<boolean> {
  const prefField = CATEGORY_TO_PREFERENCE[category];
  if (!prefField) {
    // Unknown category — default to sending
    return true;
  }

  const pref = await prisma.notificationPreference.findUnique({
    where: { memberId },
  });

  if (!pref) {
    // No preference record = defaults (all true except marketingEmails)
    return category !== "marketingEmails";
  }

  return Boolean(pref[prefField]);
}

/**
 * Resolve whether a chore-roster email should be sent to a specific booking
 * guest, honoring the "Chore Roster" notification preference.
 *
 * #1285 Option C (hybrid — owner decision). Chore rosters are delivered per
 * guest, and a dependent guest's mail is delivered to the primary member's
 * inbox (see `getEffectiveEmail`, which resolves delivery via
 * `inheritEmailFromId`). Preference resolution mirrors that delivery:
 *
 *   1. If the guest has their OWN `NotificationPreference` row, it wins — a
 *      full member with their own login controls their own chore-roster mail.
 *   2. If the guest has NO own row but inherits their email from a primary
 *      member (`inheritEmailFromId`), fall back to that primary's preference,
 *      since the roster lands in the primary's inbox.
 *   3. If neither has a row (or the guest is a non-member with no member id),
 *      default to SENDING — preserving the documented "no preference → send"
 *      contract for optional/operational mail.
 */
export async function shouldSendChoreRoster(
  memberId: string | null | undefined,
  inheritEmailFromId: string | null | undefined,
): Promise<boolean> {
  // Non-member guest: no member record, no preference to consult → send.
  if (!memberId) return true;

  // The guest's own preference row wins when it exists.
  const ownPref = await prisma.notificationPreference.findUnique({
    where: { memberId },
  });
  if (ownPref) return Boolean(ownPref.choreRoster);

  // No own row: an inherited-email dependent follows the primary whose inbox
  // actually receives the mail. `shouldSendEmail` returns the documented
  // "no preference → send" default when the primary has no row either.
  if (inheritEmailFromId) {
    return shouldSendEmail(inheritEmailFromId, "choreRoster");
  }

  // No own row and not inheriting from anyone: preserve "no preference → send".
  return true;
}
