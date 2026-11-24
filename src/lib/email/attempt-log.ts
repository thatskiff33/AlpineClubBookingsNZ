import type { EmailBookingContext } from "@/lib/booking-email-contract";
import type { Prisma } from "@prisma/client";
import { confirmAlertCooldownSend } from "@/lib/alert-cooldown";
import { hasBookingDetailHref } from "@/lib/booking-email-html";
import logger from "@/lib/logger";
import { OnceEverClaimRefusedError, type OnceEverClaimHandle } from "@/lib/once-ever-claim-context";
import { prisma } from "@/lib/prisma";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

type EmailAttemptLogResult =
  | { kind: "created"; emailLogId: string | null }
  | { kind: "already_recorded"; emailLogId: string };

/**
 * The `EmailLog` id of a send that carries an event key: one row per template
 * and event, so a second send finds it (`already_recorded`). Also what a caller
 * reads to learn whether that event's email was already recorded (#5433).
 */
export function durableEmailLogId(templateName: string, idempotencyKey: string): string {
  return `email:${templateName}:${idempotencyKey}`;
}

/**
 * Persist delivery and retry provenance before a provider can receive a message.
 * Logging is best effort unless the event opts into durable idempotency; that
 * event's primary key also serializes concurrent re-drives.
 *
 * #5255 (`INV-INT-042`): an admin alert sent under a once-ever claim passes
 * `onceEverClaim`, and its row is written only together with the claim's
 * confirm, in one short transaction: a claim the sweep gave back meanwhile, or
 * any write error, records nothing and throws, so nothing is sent. Without it
 * nothing changes.
 */
export async function recordEmailAttempt(params: {
  recipient: string;
  subject: string;
  templateName: string;
  html: string;
  bookingContext: EmailBookingContext;
  bodyOverrideApplied: boolean;
  persistHtmlBody: boolean;
  hasAttachments: boolean;
  idempotencyKey?: string;
  deferDelivery?: boolean;
  onceEverClaim?: OnceEverClaimHandle;
}): Promise<EmailAttemptLogResult> {
  const { bookingContext, persistHtmlBody, deferDelivery, idempotencyKey, onceEverClaim } = params;
  if (deferDelivery && (!idempotencyKey || !persistHtmlBody || params.hasAttachments)) {
    throw new Error("Deferred email requires an event key, retained retry-safe HTML and no attachments");
  }
  if (onceEverClaim && idempotencyKey) {
    throw new Error("An email sent under a once-ever claim cannot also carry an event key");
  }
  const durableLogId = idempotencyKey
    ? durableEmailLogId(params.templateName, idempotencyKey)
    : null;
  const data = {
    ...(durableLogId ? { id: durableLogId } : {}),
    to: params.recipient,
    subject: params.subject,
    templateName: params.templateName,
    // New booking rows quarantine retryable HTML from the pre-#2362
    // worker, whose fixed query selects only legacy htmlBody. This makes a
    // later application rollback fail closed without withholding the
    // initial send. Sensitive templates remain unretained in both fields.
    htmlBody:
      bookingContext === "none" && persistHtmlBody ? params.html : null,
    // Deferred durable notices are owned exclusively by the retry worker.
    // FAILED makes an interrupted enqueue recoverable by its existing
    // 15-minute backoff; no synchronous SMTP send can race that worker.
    status: deferDelivery ? "FAILED" : "QUEUED",
    ...(deferDelivery ? { errorMessage: "Delivery pending; queued for the email retry worker" } : {}),
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
          bookingBodyOverrideApplied: params.bodyOverrideApplied,
          bookingDetailLinkIncluded: hasBookingDetailHref(params.html),
          bookingRetryHtmlBody: persistHtmlBody ? params.html : null,
        }),
  } satisfies Prisma.EmailLogUncheckedCreateInput;
  if (onceEverClaim) return recordClaimedEmailAttempt(onceEverClaim, data);
  try {
    const log = await prisma.emailLog.create({ data });
    return { kind: "created", emailLogId: log.id };
  } catch (err) {
    if (durableLogId) {
      // A P2002 on some other constraint is not evidence this notice exists.
      if (isPrismaUniqueConstraintError(err)) {
        const existing = await prisma.emailLog.findUnique({
          where: { id: durableLogId },
          select: { id: true },
        });
        if (existing) {
          return { kind: "already_recorded", emailLogId: existing.id };
        }
      }
      // The caller must retry the business operation if no durable notice was
      // recorded. Sending here would make the next re-drive send it again.
      throw err;
    }
    logger.error({ err }, "Failed to create EmailLog record");
    return { kind: "created", emailLogId: null };
  }
}

/** The row of an email sent under a once-ever claim, written only if the claim is still this sender's (#5255). */
async function recordClaimedEmailAttempt(
  claim: OnceEverClaimHandle,
  data: Prisma.EmailLogUncheckedCreateInput,
): Promise<EmailAttemptLogResult> {
  try {
    const log = await prisma.$transaction(async (tx) => {
      if (!(await confirmAlertCooldownSend({ key: claim.key, claimedAt: claim.claimedAt, store: tx }))) {
        throw new Error(`The once-ever claim ${claim.key} is no longer held; the alert email was not recorded or sent`);
      }
      return tx.emailLog.create({ data });
    });
    claim.rowWritten = true;
    return { kind: "created", emailLogId: log.id };
  } catch (err) {
    claim.rowWriteFailed = true;
    throw new OnceEverClaimRefusedError(claim.key, err);
  }
}
