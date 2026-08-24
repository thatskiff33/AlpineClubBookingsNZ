import { prisma } from "./prisma";
import { EMAIL_FROM, formatEmailFromAddress } from "./email-sender";
import { htmlToPlainText } from "./email-text";
import logger from "@/lib/logger";
import { getEmailTransporter } from "@/lib/email/internal";
import {
  describeDeliveryDecision,
  resolveDeliveryPolicy,
} from "@/lib/environment-delivery-policy";
import { getActiveEmailSuppression } from "@/lib/email-suppression";
import {
  ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES,
  resolveBookingEmailGate,
} from "@/lib/booking-email-suppression";
import { resolveBookingEmailLink } from "@/lib/booking-email-authority";
import {
  finalizeBookingEmailHtml,
  hasBookingDetailHref,
} from "@/lib/booking-email-html";
import { adminEmailDeliveryFailedTemplate } from "@/lib/email-templates/admin-ops";
import { renderEmailHtml } from "@/lib/email-theme";

const MAX_ATTEMPTS = 3;
const RETRY_FAILURE_ALERT_TEMPLATE = "admin-email-failure";

async function retireUnverifiableBookingEmail(params: {
  emailLogId: string;
  bookingId: string;
  templateName: string;
  to: string;
  expectedAttempts: number;
  expectedHtmlBody: string | null;
  expectedBookingRetryHtmlBody: string | null;
  errorMessage: string;
  logMessage: string;
}): Promise<void> {
  const retired = await prisma.emailLog
    .updateMany({
      where: {
        id: params.emailLogId,
        status: "FAILED",
        attempts: params.expectedAttempts,
        htmlBody: params.expectedHtmlBody,
        bookingRetryHtmlBody: params.expectedBookingRetryHtmlBody,
      },
      data: {
        attempts: MAX_ATTEMPTS,
        lastAttemptAt: new Date(),
        htmlBody: null,
        bookingRetryHtmlBody: null,
        errorMessage: params.errorMessage,
        // #3035: whatever held this row back before, it is now retired for a
        // different reason and `errorMessage` says which. A stale
        // `deliveryBlockReason` would keep it inside the environment-withheld
        // count for the life of the installation.
        deliveryBlockReason: null,
      },
    })
    .catch((err) => {
      logger.error(
        { err, emailLogId: params.emailLogId, bookingId: params.bookingId },
        "Failed to retire an unverifiable booking email",
      );
      return { count: 0 };
    });
  if (retired.count !== 1) return;
  logger.warn(
    {
      emailLogId: params.emailLogId,
      bookingId: params.bookingId,
      templateName: params.templateName,
      to: params.to,
    },
    params.logMessage,
  );
}

/**
 * N-11: Retry failed emails with backoff.
 * Queries EmailLog for FAILED records with attempts < 3 and re-sends.
 * Token-bearing templates are intentionally excluded because their HTML bodies
 * are not retained in EmailLog.
 * SES/SNS bounce and complaint feedback marks undeliverable messages as
 * BOUNCED, so they are excluded from retry recovery. Suppression is
 * re-checked per row before each retry send (F26, #1885) because a FAILED
 * row can predate the suppression that SNS feedback created.
 * Each row is claimed (FAILED -> QUEUED) with a guarded update before the
 * send so an interrupted or concurrent run can never deliver the same email
 * twice (F33, #1885).
 * Runs every 30 minutes.
 */
export async function retryFailedEmails(): Promise<{
  retried: number;
  succeeded: number;
  failed: number;
}> {
  /*
    Environment-safety boundary (#3035, ENV-SAFETY 2; epic #2986). INV-CONFIG-004.

    This job used to build its own nodemailer transport, which is exactly why the
    epic could not simply add a check to `sendEmail`: a replay never passed
    through that function at all. It now asks the same policy and obtains its
    transport through the same clearance-gated accessor, so there is one boundary
    rather than two.

    THE TWO NON-SEND ANSWERS ARE DIFFERENT SHAPES ON PURPOSE.

    A confirmed copy returns cleanly with nothing retried. It is not a fault — a
    copy declining to replay the club's mail is the job working — and throwing
    every thirty minutes would fill a staging copy's cron history with red runs
    that mean nothing.

    A CONFIGURATION FAULT THROWS. Both remaining answers are one: an undeclared
    installation, and a live site that has declared a capture mailbox.

    A DECLARED CAPTURE COPY REPLAYS NORMALLY, into the capture. That is the one
    case where a copy legitimately transmits, and it is what lets the browser
    suite exercise this job at all.

    NEITHER TOUCHES A ROW, and that is the part worth being careful about. The
    rows are left exactly as found, so no attempt is burned and no retained body
    is dropped: the moment the role is declared, the very next run replays them.
    Marking them instead would have been the tempting shortcut and it destroys
    information — a copy restored from the club's live database holds the live
    site's genuinely-failed rows, and rewriting those as "held back by this copy"
    would both lie about their history and inflate the withheld count that #3034's
    panel reads.
  */
  const delivery = await resolveDeliveryPolicy();
  if (delivery.kind === "suppress_non_production") {
    logger.info(
      { job: "retryFailedEmails" },
      "Skipped the email retry run: this installation is not the club's live site, so no message was replayed and no provider was contacted. Every failed row is left untouched",
    );
    return { retried: 0, succeeded: 0, failed: 0 };
  }
  if (delivery.kind !== "allow") {
    /*
      Every remaining answer is a CONFIGURATION FAULT — nothing has said what this
      installation is, or a live site has declared a capture mailbox — so it
      throws, exactly as an unusable delivery configuration already did. Something
      has to tell an operator that this installation has stopped sending mail and
      cannot say why.
    */
    throw new Error(
      `Email retry skipped: ${describeDeliveryDecision(delivery)}`,
    );
  }
  const { transporter } = await getEmailTransporter(delivery.clearance);

  // Backoff: don't retry emails until at least 15 minutes after the last attempt
  const backoffThreshold = new Date(Date.now() - 15 * 60 * 1000);

  const failedEmails = await prisma.emailLog.findMany({
    where: {
      // `FAILED` alone, which is also what keeps a safety-suppressed row out of
      // this job for good (#3035): `SKIPPED_NON_PRODUCTION` is terminal and is
      // not in this filter, and the guarded claim below re-asserts `FAILED`
      // before any send. Do not widen this to a status list.
      status: "FAILED",
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { htmlBody: { not: null } },
        { bookingRetryHtmlBody: { not: null } },
      ],
      lastAttemptAt: { not: { gte: backoffThreshold } },
    },
    orderBy: { createdAt: "asc" },
    take: 50, // Process in batches to avoid overload
  });

  let retried = 0;
  let succeeded = 0;
  let failed = 0;

  for (const emailLog of failedEmails) {
    const usesBookingRetryBody = emailLog.bookingRetryHtmlBody != null;
    // Retained HTML, rendered by whichever process first attempted this
    // message. Its colours are already baked into the stored string, so it is
    // deliberately NOT re-coloured here and needs no render gate (#2900):
    // re-theming a replay would change what the member is shown relative to
    // what the club approved at send time.
    let retryHtml = emailLog.bookingRetryHtmlBody ?? emailLog.htmlBody!;
    // F26 (#1885): a FAILED row can be created before an SNS bounce/complaint
    // suppresses the recipient (the pre-send check in core.ts passed, then the
    // SMTP send failed after the suppression landed). Re-check here so a
    // suppressed recipient is never re-delivered. Mirrors core.ts: on check
    // failure proceed (fail-open, same as the pre-send path); on an active
    // suppression mark the row BOUNCED with the same reason string and drop
    // the retained body.
    const activeSuppression = await getActiveEmailSuppression(
      emailLog.to,
    ).catch((err) => {
      logger.error(
        { err, to: emailLog.to, templateName: emailLog.templateName },
        "Failed to check email suppression state before retry",
      );
      return null;
    });

    if (activeSuppression) {
      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            status: "BOUNCED",
            htmlBody: null,
            bookingRetryHtmlBody: null,
            errorMessage: `Email suppressed after SES ${activeSuppression.reason.toLowerCase()} feedback`,
            // #3035: the recipient's address is the reason now, not the
            // environment. See the failure branch below on why the block reason
            // must not persist past the thing it described.
            deliveryBlockReason: null,
          },
        })
        .catch((err) => {
          logger.error(
            { err, emailLogId: emailLog.id },
            "Failed to update suppressed email log during retry",
          );
        });
      logger.warn(
        {
          to: emailLog.to,
          templateName: emailLog.templateName,
          emailSuppressionId: activeSuppression.id,
          reason: activeSuppression.reason,
        },
        "Skipped email retry to suppressed recipient",
      );
      // A suppressed skip is not a retry attempt.
      continue;
    }

    // #2258: this cron replays a retained body directly through the shared
    // transport rather than through `sendEmail`, so it never passes back through
    // that function's gate. (It used to build a nodemailer transport of its own;
    // since #3035 it obtains one from the single clearance-gated accessor, which
    // is why the environment check at the top of this function exists.) A FAILED row
    // can easily predate the moment an admin turned the booking's "No emails"
    // switch on — including the fail-closed FAILED row the gate itself writes
    // when it cannot read the switch — so re-evaluate the switch from the row's
    // bookingId before EVERY replay, and fail closed the same way the mailer
    // does.
    //
    // Rows with NO bookingId fall into two groups. Most are account, security,
    // membership, family and admin mail, which the switch must never touch and
    // which replay unchanged. But EmailLog.bookingId did not exist before the
    // #2258 migration, so every row queued by the previous release is NULL —
    // including booking-scoped ones. In the window after deploy such a row could
    // otherwise replay a confirmation for a booking that has since been
    // silenced. When the template is one that is ALWAYS about a booking, refuse
    // the replay and leave the row FAILED, so it stays in the operator's
    // email-failure review queue instead of going out or vanishing.
    if (!emailLog.bookingId) {
      if (ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(emailLog.templateName)) {
        // Retire the row TERMINALLY rather than leaving it as found. Leaving it
        // at attempts < 3 would have been the worst of both worlds: the row is
        // below the >=3 threshold the operator review queue reads, so it would
        // surface NOWHERE; and it stays inside this cron's selection window
        // (status FAILED, attempts < MAX, retained body) forever, so once fifty
        // such rows exist the batch of 50 is refilled with the same stuck rows
        // every run and retry dies for every newer email behind them.
        // Pushing attempts to MAX_ATTEMPTS drops it out of the query and lands
        // it in the review queue, which is what the operator needs.
        await prisma.emailLog
          .update({
            where: { id: emailLog.id },
            data: {
              attempts: MAX_ATTEMPTS,
              lastAttemptAt: new Date(),
              // #3035: retired for a #2258 attribution reason, not an
              // environment one.
              deliveryBlockReason: null,
              errorMessage:
                "Not retried: this booking email predates the per-booking \"No emails\" switch (#2258) and carries no booking, so it cannot be checked against it. Re-send it by hand if the booking still needs it.",
            },
          })
          .catch((err) => {
            logger.error(
              { err, emailLogId: emailLog.id },
              "Failed to retire an unattributable booking email",
            );
          });
        logger.warn(
          {
            emailLogId: emailLog.id,
            templateName: emailLog.templateName,
            to: emailLog.to,
            expectedAttempts: emailLog.attempts,
            expectedHtmlBody: emailLog.htmlBody,
            expectedBookingRetryHtmlBody: emailLog.bookingRetryHtmlBody,
          },
          "Retired a booking-scoped email with no recorded booking (queued before #2258); it cannot be checked against the booking's \"No emails\" switch",
        );
        // Not a retry attempt: nothing was sent.
        continue;
      }
    } else {
      const bookingGate = await resolveBookingEmailGate(
        { bookingId: emailLog.bookingId },
        emailLog.templateName,
      );
      if (bookingGate.decision === "unknown") {
        // Fail closed: leave the row FAILED and untouched so a later run (with
        // a healthy database) decides. Not a retry attempt.
        logger.error(
          { emailLogId: emailLog.id, bookingId: emailLog.bookingId },
          "Skipped email retry: the booking's \"No emails\" switch could not be read",
        );
        continue;
      }
      if (bookingGate.decision === "withhold") {
        await prisma.emailLog
          .update({
            where: { id: emailLog.id },
            data: {
              status: "SKIPPED_NO_EMAILS",
              htmlBody: null,
              bookingRetryHtmlBody: null,
              errorMessage:
                'Withheld: this booking has the "No emails" switch turned on',
              // #3035: the club's own decision is the reason now. Keeping an
              // environment block reason here would also make a business
              // withhold count as an environment-safety one, which is exactly
              // the conflation INV-CONFIG-004 forbids.
              deliveryBlockReason: null,
            },
          })
          .catch((err) => {
            logger.error(
              { err, emailLogId: emailLog.id },
              "Failed to mark a retry as withheld for a no-emails booking",
            );
          });
        logger.warn(
          {
            to: emailLog.to,
            templateName: emailLog.templateName,
            bookingId: emailLog.bookingId,
          },
          'Skipped email retry for a booking with "No emails" turned on',
        );
        // A withheld skip is not a retry attempt.
        continue;
      }

      if (ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(emailLog.templateName)) {
        // #2362: `bookingId` is not enough to repeat the privacy decision. An
        // email address is not authority, and old rows do not record the member
        // id or whether the retained body came from an admin override. Retire
        // those rows instead of replaying a previously-authorized URL blind.
        if (
          emailLog.bookingBodyOverrideApplied == null ||
          emailLog.bookingDetailLinkIncluded == null
        ) {
          await retireUnverifiableBookingEmail({
            emailLogId: emailLog.id,
            bookingId: emailLog.bookingId,
            templateName: emailLog.templateName,
            to: emailLog.to,
            expectedAttempts: emailLog.attempts,
            expectedHtmlBody: emailLog.htmlBody,
            expectedBookingRetryHtmlBody: emailLog.bookingRetryHtmlBody,
            errorMessage:
              "Not retried: this booking email predates retry-time recipient authorization context (#2362). Re-send it by hand if the recipient still needs it.",
            logMessage:
              "Retired a booking email with no durable retry-time recipient authorization context",
          });
          continue;
        }

        // The boolean was computed with the then-current application origin.
        // If configuration drift means the retained href can no longer be
        // located by the same-origin matcher, do not append a second link or
        // send an old one that cannot be safely removed.
        if (
          emailLog.bookingDetailLinkIncluded &&
          !hasBookingDetailHref(retryHtml)
        ) {
          await retireUnverifiableBookingEmail({
            emailLogId: emailLog.id,
            bookingId: emailLog.bookingId,
            templateName: emailLog.templateName,
            to: emailLog.to,
            expectedAttempts: emailLog.attempts,
            expectedHtmlBody: emailLog.htmlBody,
            expectedBookingRetryHtmlBody: emailLog.bookingRetryHtmlBody,
            errorMessage:
              "Not retried: the retained booking-detail link could not be safely located under the current application URL (#2362). Re-send it by hand after reviewing the recipient and deployment URL.",
            logMessage:
              "Retired a booking email whose retained detail link could not be safely re-finalized",
          });
          continue;
        }

        const bookingLink = await resolveBookingEmailLink({
          bookingId: emailLog.bookingId,
          templateName: emailLog.templateName,
          recipient: emailLog.bookingRecipientMemberId
            ? { kind: "member", memberId: emailLog.bookingRecipientMemberId }
            : { kind: "non-login-public-contact" },
          deliveryAddress: emailLog.to,
        });

        // This transforms only the retained/rendered delivery copy. Stored
        // override source is never written here: authorized overrides stay
        // byte-for-byte unchanged, while revoked/public recipients lose stale
        // authenticated hrefs before the guarded claim and send.
        retryHtml = finalizeBookingEmailHtml({
          html: retryHtml,
          bookingUrl: bookingLink.bookingUrl,
          bookingScoped: true,
          bodyOverrideApplied: emailLog.bookingBodyOverrideApplied,
        });
      }
    }

    const newAttempts = emailLog.attempts + 1;
    const retainedHtml =
      emailLog.bookingRetryHtmlBody ?? emailLog.htmlBody;

    // F33 (#1885): claim the row before sending. If a previous run crashed
    // after SES accepted the message but before the SENT write committed, the
    // row is no longer FAILED, the claim finds nothing, and we never
    // double-send. Two overlapping cron runs race the same guarded update and
    // only one wins.
    const claim = await prisma.emailLog.updateMany({
      where: {
        id: emailLog.id,
        status: "FAILED",
        attempts: emailLog.attempts,
        htmlBody: emailLog.htmlBody,
        bookingRetryHtmlBody: emailLog.bookingRetryHtmlBody,
      },
      data: {
        status: "QUEUED",
        attempts: newAttempts,
        lastAttemptAt: new Date(),
        ...(retryHtml !== retainedHtml
          ? usesBookingRetryBody
            ? { bookingRetryHtmlBody: retryHtml }
            : { htmlBody: retryHtml }
          : {}),
        ...(emailLog.bookingDetailLinkIncluded != null
          ? { bookingDetailLinkIncluded: hasBookingDetailHref(retryHtml) }
          : {}),
      },
    });
    if (claim.count !== 1) {
      // Already claimed (or resolved) by another run — not a retry attempt.
      continue;
    }

    retried++;

    if (process.env.NODE_ENV === "development") {
      logger.info(
        { to: emailLog.to, subject: emailLog.subject },
        "Email retry (dev mode)",
      );
      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            status: "SENT",
            sentAt: new Date(),
            errorMessage: null,
            deliveryBlockReason: null,
          },
        })
        .catch((err) => {
          logger.error(
            { err, emailLogId: emailLog.id },
            "Failed to update EmailLog to SENT after dev-mode retry",
          );
        });
      succeeded++;
      continue;
    }

    let result: Awaited<ReturnType<typeof transporter.sendMail>>;
    try {
      result = await transporter.sendMail({
        from: formatEmailFromAddress(EMAIL_FROM),
        to: emailLog.to,
        subject: emailLog.subject,
        html: retryHtml,
        text: htmlToPlainText(retryHtml),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, emailLogId: emailLog.id, attempt: newAttempts },
        "Email retry failed",
      );

      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            // Restore FAILED (the claim moved the row to QUEUED) — will
            // retry again if attempts < MAX.
            status: "FAILED",
            attempts: newAttempts,
            lastAttemptAt: new Date(),
            errorMessage,
            /*
              AND CLEAR THE ENVIRONMENT BLOCK REASON (#3035 review). This row may
              have been failed by the environment gate earlier — undeclared role,
              or a live site in capture mode — and `deliveryBlockReason` was
              written nowhere else and cleared nowhere at all. So once an operator
              repaired the configuration and the replay then hit a genuine provider
              failure, the row kept the stale block reason for the life of the
              installation: counted forever by
              `readWithheldApplicationEmail`, which selects
              `FAILED` + `deliveryBlockReason NOT NULL`. Admin -> Environment would
              go on telling a healthy live club it was holding mail back, which
              breaks owner decision 1 — the count has to DRAIN after the repair,
              because a count that never drains cannot distinguish anything.

              It also falsifies the column's own documented contract in
              `schema.prisma` ("NULL for … a genuine transport failure") and
              INV-CONFIG-004's promise that a safety block is distinguishable from a
              transport failure by more than a message string. This write is now
              exactly that: a transport failure, so the reason is NULL and the
              message string is the provider's.
            */
            deliveryBlockReason: null,
          },
        })
        .catch((updateErr) => {
          logger.error(
            { err: updateErr, emailLogId: emailLog.id },
            "Failed to update EmailLog after retry failure",
          );
        });

      // Alert admin when email exhausts retries
      if (
        newAttempts >= MAX_ATTEMPTS &&
        emailLog.templateName !== RETRY_FAILURE_ALERT_TEMPLATE
      ) {
        try {
          const { sendEmail, getAdminEmails } = await import("./email");
          // #2548: the shared resolver, so this system-failure alert reaches
          // the same audience as every other one — access-role resolved, with
          // definition-backed custom roles included — instead of re-deriving it
          // from the legacy `role: "ADMIN"` scalar.
          const admins = await getAdminEmails();
          for (const adminEmail of admins) {
            await sendEmail({
              to: adminEmail,
              subject: "Email delivery permanently failed",
              html: await renderEmailHtml(() => adminEmailDeliveryFailedTemplate({
                recipient: emailLog.to,
                templateName: emailLog.templateName,
                attemptCount: newAttempts,
              })),
              // Admin failure alert: never withheld by a booking flag (#2258).
              bookingContext: "none",
              templateName: RETRY_FAILURE_ALERT_TEMPLATE,
              templateData: {
                originalRecipient: emailLog.to,
                originalTemplateName: emailLog.templateName,
                attemptCount: newAttempts,
              },
            }).catch(() => {}); // Don't let alert failure break the cron
          }
        } catch {
          // Non-critical
        }
      }

      failed++;
      continue;
    }

    // The provider accepted the message. If this SENT write fails, leave the
    // row QUEUED (claimed) rather than restoring FAILED: a FAILED row would
    // be re-sent on the next run even though the email already went out
    // (F33, #1885). At-most-once beats a duplicate money-adjacent email.
    await prisma.emailLog
      .update({
        where: { id: emailLog.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          messageId: result.messageId || null,
          errorMessage: null,
          // #3035: the row is delivered, so nothing about it is being withheld.
          // Leaving a stale `deliveryBlockReason` here would keep a SENT message
          // inside the withheld population for good — see the failure branch
          // above for why that count must drain.
          deliveryBlockReason: null,
        },
      })
      .catch((err) => {
        logger.error(
          { err, emailLogId: emailLog.id },
          "Failed to update EmailLog to SENT after retry; leaving the row QUEUED so it is not re-sent",
        );
      });
    succeeded++;
  }

  return { retried, succeeded, failed };
}
