import type { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES } from "@/lib/booking-email-suppression";
import {
  type BookingFreshCopyTemplate,
  bookingFreshCopyHref,
  isBookingFreshCopyTemplate,
} from "@/lib/booking-fresh-email-copy-templates";
import { SENSITIVE_EMAIL_LOG_TEMPLATES } from "@/lib/email/internal";
import {
  EMAIL_RETRY_BACKOFF_MS,
  EMAIL_RETRY_MAX_ATTEMPTS,
  RETAINS_REPLAYABLE_EMAIL_BODY,
} from "@/lib/email/retry-selection";
import { prisma } from "@/lib/prisma";
import { isTokenRecoveryTemplate } from "@/lib/token-email-recovery";

const EMAIL_FAILURE_REVIEW_ACTION = "email.failure.reviewed";
const EMAIL_FAILURE_REQUEUE_ACTION = "email.failure.requeued";
const MAX_EXHAUSTED_FAILURE_SCAN = 200;

/** Every row this queue is about: failed, with no retry attempt left. */
const EXHAUSTED_EMAIL_FAILURE_WHERE = {
  status: "FAILED",
  attempts: { gte: EMAIL_RETRY_MAX_ATTEMPTS },
} satisfies Prisma.EmailLogWhereInput;

/**
 * Which exhausted rows **Try again** may hand back to the retry cron: a retained
 * body, and not a booking email with no booking. The cron retires that second
 * kind on sight (#2258: it cannot be checked against the booking's "No emails"
 * switch) and keeps its body, so a requeue would only loop it back here.
 */
const REQUEUEABLE_EMAIL_FAILURE_WHERE = {
  ...RETAINS_REPLAYABLE_EMAIL_BODY,
  NOT: {
    bookingId: null,
    templateName: { in: [...ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES] },
  },
} satisfies Prisma.EmailLogWhereInput;

/**
 * What an operator can do about one exhausted row.
 *
 * - `retry`: the row still holds a replayable body, so **Try again** hands it
 *   back to the email retry cron.
 * - `token_reissue`: one of Token Email Recovery's templates; reissue it there.
 * - `fresh_copy`: a booking email whose body is never kept, about a booking
 *   that still exists; send a fresh copy from that booking's page
 *   (`booking-fresh-email-copy-templates.ts`).
 * - `sensitive`: it carried a sign-in link, door code or payment link, so no
 *   copy was kept (`SENSITIVE_EMAIL_LOG_TEMPLATES`, INV-CONFIG-004).
 * - `retired`: Try again cannot take it for another reason - a redacted
 *   recipient, a message whose retry belongs to something else, a booking
 *   email with no booking, which the cron retires (body kept) because it cannot
 *   check it against the booking's "No emails" switch, or an email about a
 *   booking that has since been deleted.
 */
export type ExhaustedEmailFailureRecovery =
  | "retry"
  | "token_reissue"
  | "fresh_copy"
  | "sensitive"
  | "retired";

function recoveryFor(
  templateName: string,
  canRequeue: boolean,
  freshCopyHref: string | null,
): ExhaustedEmailFailureRecovery {
  if (canRequeue) return "retry";
  if (isTokenRecoveryTemplate(templateName)) return "token_reissue";
  if (freshCopyHref) return "fresh_copy";
  if (SENSITIVE_EMAIL_LOG_TEMPLATES.has(templateName)) return "sensitive";
  return "retired";
}

export class EmailFailureReviewError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "EmailFailureReviewError";
    this.status = status;
  }
}

interface ExhaustedEmailFailure {
  id: string;
  to: string;
  subject: string;
  templateName: string;
  attempts: number;
  lastAttemptAt: string;
  errorMessage: string | null;
  createdAt: string;
  // Never resolved from `to`: family members share inboxes and some recipients
  // are redacted. `bookingRecipientMemberId` is the only member identity.
  bookingId: string | null;
  bookingExists: boolean;
  bookingRecipientMemberId: string | null;
  recovery: ExhaustedEmailFailureRecovery;
  /**
   * Where an officer sends a fresh copy of this email, for a booking email
   * whose body is never kept (`booking-fresh-email-copy-templates.ts`) and
   * whose booking still exists; null for every other failure.
   */
  freshCopyHref: string | null;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewNote: string | null;
}

function trimReviewReason(reason?: string | null) {
  const trimmed = reason?.trim();
  if (!trimmed) {
    return "Reviewed and archived from operator recovery queue.";
  }

  return trimmed.slice(0, 500);
}

function readReviewNote(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const reason = (metadata as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

export async function getExhaustedEmailFailureReviewQueue(limit = 25) {
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const [failures, totalExhaustedCount] = await Promise.all([
    prisma.emailLog.findMany({
      where: EXHAUSTED_EMAIL_FAILURE_WHERE,
      orderBy: [
        { lastAttemptAt: "desc" },
        { createdAt: "desc" },
      ],
      take: MAX_EXHAUSTED_FAILURE_SCAN,
      select: {
        id: true,
        to: true,
        subject: true,
        templateName: true,
        attempts: true,
        lastAttemptAt: true,
        errorMessage: true,
        createdAt: true,
        bookingId: true,
        bookingRecipientMemberId: true,
      },
    }),
    // The scan above is a window; this is the real total the operator is told.
    prisma.emailLog.count({ where: EXHAUSTED_EMAIL_FAILURE_WHERE }),
  ]);
  const failureIds = failures.map((failure) => failure.id);
  const bookingIds = [
    ...new Set(
      failures.flatMap((failure) => (failure.bookingId ? [failure.bookingId] : [])),
    ),
  ];
  const [reviews, replayable, existingBookings] =
    failureIds.length > 0
      ? await Promise.all([
          prisma.auditLog.findMany({
            where: {
              action: {
                in: [EMAIL_FAILURE_REVIEW_ACTION, EMAIL_FAILURE_REQUEUE_ACTION],
              },
              targetId: {
                in: failureIds,
              },
            },
            orderBy: {
              createdAt: "desc",
            },
            select: {
              action: true,
              targetId: true,
              actorMemberId: true,
              memberId: true,
              createdAt: true,
              metadata: true,
            },
          }),
          // Which rows Try again can take, asked as a filter so no body text is
          // ever read into this process, let alone returned to a browser.
          prisma.emailLog.findMany({
            where: { id: { in: failureIds }, ...REQUEUEABLE_EMAIL_FAILURE_WHERE },
            select: { id: true },
          }),
          // `EmailLog.bookingId` has no foreign key: a hard-deleted booking
          // leaves it dangling. One batched read for the whole window.
          bookingIds.length > 0
            ? prisma.booking.findMany({
                where: { id: { in: bookingIds } },
                select: { id: true, deletedAt: true },
              })
            : Promise.resolve([]),
        ])
      : [[], [], []];
  const replayableIds = new Set(replayable.map((row) => row.id));
  const existingBookingIds = new Set(existingBookings.map((booking) => booking.id));
  // A soft-deleted booking still has a row, but its page refuses every fresh
  // copy ("This booking has been deleted"), so the queue must not send the
  // officer there.
  const liveBookingIds = new Set(
    existingBookings.filter((booking) => booking.deletedAt === null).map((booking) => booking.id),
  );
  // The newest of Archive and Try again decides the row: a row requeued and
  // then exhausted again is active, even though an older archive exists. An
  // archive also counts only if it is no older than the row's last attempt:
  // one whose check passed just before a racing Try again lands after the
  // requeue's audit row, but the cron's next failure is newer still.
  const latestActionByEmailLogId = new Map<string, (typeof reviews)[number]>();

  for (const review of reviews) {
    if (review.targetId && !latestActionByEmailLogId.has(review.targetId)) {
      latestActionByEmailLogId.set(review.targetId, review);
    }
  }

  const decorated: ExhaustedEmailFailure[] = failures.map((failure) => {
    const bookingExists =
      failure.bookingId !== null && existingBookingIds.has(failure.bookingId);
    // Try again needs a retained body AND, for an email that names a booking,
    // that booking still existing (see `requeueExhaustedEmailFailure`).
    const canRequeue =
      replayableIds.has(failure.id) &&
      (failure.bookingId === null || bookingExists);
    const freshCopyHref =
      failure.bookingId && liveBookingIds.has(failure.bookingId) && isBookingFreshCopyTemplate(failure.templateName)
        ? bookingFreshCopyHref(failure.bookingId)
        : null;
    const latest = latestActionByEmailLogId.get(failure.id);
    const review =
      latest?.action === EMAIL_FAILURE_REVIEW_ACTION &&
      latest.createdAt >= failure.lastAttemptAt
        ? latest
        : undefined;

    return {
      id: failure.id,
      to: failure.to,
      subject: failure.subject,
      templateName: failure.templateName,
      attempts: failure.attempts,
      lastAttemptAt: failure.lastAttemptAt.toISOString(),
      errorMessage: failure.errorMessage,
      createdAt: failure.createdAt.toISOString(),
      bookingId: failure.bookingId,
      bookingExists,
      bookingRecipientMemberId: failure.bookingRecipientMemberId,
      recovery: recoveryFor(failure.templateName, canRequeue, freshCopyHref),
      freshCopyHref,
      reviewedAt: review?.createdAt.toISOString() ?? null,
      reviewedById: review?.actorMemberId ?? review?.memberId ?? null,
      reviewNote: readReviewNote(review?.metadata),
    };
  });
  const active = decorated.filter((failure) => !failure.reviewedAt);
  const reviewed = decorated.filter((failure) => failure.reviewedAt);

  return {
    summary: {
      activeCount: active.length,
      reviewedCount: reviewed.length,
      scannedCount: decorated.length,
      totalExhaustedCount,
      scanLimit: MAX_EXHAUSTED_FAILURE_SCAN,
      // Older exhausted rows exist beyond the window, so the active/archived
      // split above does not cover them.
      scanCapped: totalExhaustedCount > decorated.length,
      maxAttempts: EMAIL_RETRY_MAX_ATTEMPTS,
    },
    failures: active.slice(0, boundedLimit),
    recentlyReviewed: reviewed.slice(0, 10),
  };
}

/**
 * The one `email.failure.reviewed` row. The review queue decides "archived"
 * from these rows and reads the note from `metadata.reason`, so the officer's
 * Archive button and a fresh copy's supersede archive share this writer and
 * cannot drift apart in action, category, severity or metadata keys.
 */
async function writeEmailFailureReviewAudit(input: {
  emailLog: {
    id: string;
    to: string;
    templateName: string;
    attempts: number;
    errorMessage: string | null;
  };
  reviewedByMemberId: string;
  reason: string | null;
  detailsSuffix?: string;
  extraMetadata?: { bookingId: string };
}) {
  const { emailLog } = input;
  await createAuditLog({
    action: EMAIL_FAILURE_REVIEW_ACTION,
    memberId: input.reviewedByMemberId,
    actorMemberId: input.reviewedByMemberId,
    targetId: emailLog.id,
    entityType: "EmailLog",
    entityId: emailLog.id,
    category: "communication",
    severity: "important",
    outcome: "success",
    summary: "Exhausted email failure reviewed",
    details: `Archived exhausted ${emailLog.templateName} email failure for ${emailLog.to}${input.detailsSuffix ?? ""}.`,
    metadata: {
      reason: input.reason,
      templateName: emailLog.templateName,
      attempts: emailLog.attempts,
      lastError: emailLog.errorMessage,
      ...input.extraMetadata,
    },
  });
}

export async function markExhaustedEmailFailureReviewed(
  emailLogId: string,
  input: {
    reviewedByMemberId: string;
    reason?: string | null;
  }
) {
  const emailLog = await prisma.emailLog.findUnique({
    where: {
      id: emailLogId,
    },
    select: {
      id: true,
      to: true,
      subject: true,
      templateName: true,
      status: true,
      attempts: true,
      errorMessage: true,
    },
  });

  if (!emailLog) {
    throw new EmailFailureReviewError("Email failure not found.", 404);
  }

  if (
    emailLog.status !== "FAILED" ||
    emailLog.attempts < EMAIL_RETRY_MAX_ATTEMPTS
  ) {
    throw new EmailFailureReviewError(
      "Only exhausted failed email records can be archived from this recovery queue.",
      409
    );
  }

  const reason = trimReviewReason(input.reason);
  await writeEmailFailureReviewAudit({
    emailLog,
    reviewedByMemberId: input.reviewedByMemberId,
    reason,
  });

  return {
    id: emailLog.id,
    reviewed: true,
    reason,
  };
}

/**
 * **Try again** on an exhausted failure (#4963): hands the row back to the email
 * retry cron rather than sending anything. The cron then re-checks the
 * recipient's authority, the suppression list, the booking's "No emails" switch
 * and the environment gate, and claims the row with its own guard before it
 * sends, so this adds no second send path.
 *
 * ONE status-guarded write is the whole transition: only a `FAILED` row at the
 * retry ceiling that still holds a replayable body matches. A row already
 * requeued, claimed, sent, or that keeps no body matches nothing and is refused
 * with 409 and no audit row, so two operators pressing at once requeue it once.
 * The row is dated back past the cron's backoff so its next run admits it.
 * `deliveryBlockReason` is left as it is: a requeue is not terminal, and the
 * cron's next terminal write clears it (INV-CONFIG-004). No advisory lock: the
 * transition writes this one `EmailLog` row only (INV-LOCK-001). A row that
 * names a booking is also refused when that booking has been deleted; that
 * check is a read before the claim, not a second write.
 */
export async function requeueExhaustedEmailFailure(
  emailLogId: string,
  input: { requestedByMemberId: string },
) {
  return prisma.$transaction(async (tx) => {
    const emailLog = await tx.emailLog.findUnique({
      where: { id: emailLogId },
      select: {
        id: true,
        to: true,
        templateName: true,
        attempts: true,
        bookingId: true,
      },
    });

    if (!emailLog) {
      throw new EmailFailureReviewError("Email failure not found.", 404);
    }

    // `EmailLog.bookingId` has no foreign key, so a hard-deleted booking leaves
    // it dangling and the claim below cannot see that. The cron reads a missing
    // booking as "nothing suppressed" (`readBookingNoEmails`) and would send, days
    // later, a message about a booking that no longer exists. Refuse it here, in
    // the same transaction and before the claim, so no audit row is written.
    if (emailLog.bookingId) {
      const booking = await tx.booking.findUnique({
        where: { id: emailLog.bookingId },
        select: { id: true },
      });

      if (!booking) {
        throw new EmailFailureReviewError(
          "This email is about a booking that no longer exists, so it cannot be tried again. Archive it once you have checked whether the member still needs anything.",
          409,
        );
      }
    }

    const claim = await tx.emailLog.updateMany({
      where: {
        id: emailLog.id,
        ...EXHAUSTED_EMAIL_FAILURE_WHERE,
        ...REQUEUEABLE_EMAIL_FAILURE_WHERE,
      },
      data: {
        attempts: EMAIL_RETRY_MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(Date.now() - EMAIL_RETRY_BACKOFF_MS - 60_000),
      },
    });

    if (claim.count !== 1) {
      throw new EmailFailureReviewError(
        "This email can no longer be tried again: it has already been handed back to the retry job, sent, or keeps no copy of its message. Refresh the list.",
        409,
      );
    }

    await createAuditLog(
      {
        action: EMAIL_FAILURE_REQUEUE_ACTION,
        memberId: input.requestedByMemberId,
        actorMemberId: input.requestedByMemberId,
        targetId: emailLog.id,
        entityType: "EmailLog",
        entityId: emailLog.id,
        category: "communication",
        severity: "important",
        outcome: "success",
        summary: "Exhausted email failure handed back to the retry job",
        details: `Requeued exhausted ${emailLog.templateName} email for ${emailLog.to}; the email retry job sends it on its next run.`,
        metadata: {
          templateName: emailLog.templateName,
          attemptsBeforeRequeue: emailLog.attempts,
        },
      },
      tx,
    );

    return { id: emailLog.id, requeued: true };
  });
}

/**
 * Exhausted failures of these booking emails that no review has archived yet.
 * The booking page's fresh-copy panel reads this to say a copy is outstanding.
 */
export async function findUnarchivedExhaustedBookingEmailFailures(input: {
  bookingIds: string[];
  templateNames: string[];
  createdBefore?: Date;
}): Promise<
  Array<{
    id: string;
    bookingId: string | null;
    templateName: string;
    to: string;
    attempts: number;
    errorMessage: string | null;
  }>
> {
  if (input.bookingIds.length === 0 || input.templateNames.length === 0) return [];
  const failures = await prisma.emailLog.findMany({
    where: {
      bookingId: { in: input.bookingIds },
      templateName: { in: input.templateNames },
      ...EXHAUSTED_EMAIL_FAILURE_WHERE,
      ...(input.createdBefore ? { createdAt: { lt: input.createdBefore } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: MAX_EXHAUSTED_FAILURE_SCAN,
    select: {
      id: true,
      bookingId: true,
      templateName: true,
      to: true,
      attempts: true,
      errorMessage: true,
    },
  });
  if (failures.length === 0) return [];
  const reviewed = await prisma.auditLog.findMany({
    where: {
      action: EMAIL_FAILURE_REVIEW_ACTION,
      targetId: { in: failures.map((failure) => failure.id) },
    },
    select: { targetId: true },
  });
  const reviewedIds = new Set(reviewed.map((review) => review.targetId));
  return failures.filter((failure) => !reviewedIds.has(failure.id));
}

/**
 * Archive the exhausted failures a fresh copy has just replaced.
 *
 * Called ONLY after the fresh copy was actually sent: each archive says the
 * member now has a newer copy, which must never be claimed for a withheld or
 * failed send. The FAILED rows themselves are untouched and stay as history;
 * the archive is the same `email.failure.reviewed` audit row an officer's own
 * Archive button writes. Returns the ids it archived.
 */
export async function archiveSupersededEmailFailures(input: {
  bookingId: string;
  templateName: BookingFreshCopyTemplate;
  createdBefore: Date;
  reviewedByMemberId: string;
}): Promise<string[]> {
  const failures = await findUnarchivedExhaustedBookingEmailFailures({
    bookingIds: [input.bookingId],
    templateNames: [input.templateName],
    createdBefore: input.createdBefore,
  });
  for (const failure of failures) {
    await writeEmailFailureReviewAudit({
      emailLog: failure,
      reviewedByMemberId: input.reviewedByMemberId,
      reason: "Superseded by a fresh copy sent from the booking.",
      detailsSuffix: " after a fresh copy was sent from the booking",
      extraMetadata: { bookingId: input.bookingId },
    });
  }
  return failures.map((failure) => failure.id);
}
