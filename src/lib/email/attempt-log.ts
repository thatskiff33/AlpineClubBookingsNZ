import type { EmailBookingContext } from "@/lib/booking-email-contract";
import { hasBookingDetailHref } from "@/lib/booking-email-html";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

type EmailAttemptLogResult =
  | { kind: "created"; emailLogId: string | null }
  | { kind: "already_recorded"; emailLogId: string };

/**
 * Persist delivery and retry provenance before a provider can receive a message.
 * Logging is best effort unless the event opts into durable idempotency; that
 * event's primary key also serializes concurrent re-drives.
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
}): Promise<EmailAttemptLogResult> {
  const { bookingContext, persistHtmlBody, deferDelivery, idempotencyKey } = params;
  if (deferDelivery && (!idempotencyKey || !persistHtmlBody || params.hasAttachments)) {
    throw new Error("Deferred email requires an event key, retained retry-safe HTML and no attachments");
  }
  const durableLogId = idempotencyKey
    ? `email:${params.templateName}:${idempotencyKey}`
    : null;
  try {
    const log = await prisma.emailLog.create({
      data: {
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
      },
    });
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
