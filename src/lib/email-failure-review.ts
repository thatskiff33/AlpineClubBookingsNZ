import type { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES } from "@/lib/booking-email-suppression";
import { SENSITIVE_EMAIL_LOG_TEMPLATES } from "@/lib/email/internal";
import {
  EMAIL_RETRY_BACKOFF_MS,
  RETAINS_REPLAYABLE_EMAIL_BODY,
} from "@/lib/email/retry-selection";
import { prisma } from "@/lib/prisma";
import { isTokenRecoveryTemplate } from "@/lib/token-email-recovery";

const EMAIL_FAILURE_REVIEW_ACTION = "email.failure.reviewed";
const EMAIL_FAILURE_REQUEUE_ACTION = "email.failure.requeued";
const EMAIL_FAILURE_MAX_ATTEMPTS = 3;
const MAX_EXHAUSTED_FAILURE_SCAN = 200;

/** Every row this queue is about: failed, with no retry attempt left. */
const EXHAUSTED_EMAIL_FAILURE_WHERE = {
  status: "FAILED",
  attempts: { gte: EMAIL_FAILURE_MAX_ATTEMPTS },
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
 * - `sensitive`: it carried a sign-in link, door code or payment link, so no
 *   copy was kept (`SENSITIVE_EMAIL_LOG_TEMPLATES`, INV-CONFIG-004).
 * - `retired`: Try again cannot take it for another reason - a redacted
 *   recipient, a message whose retry belongs to something else, or a booking
 *   email with no booking, which the cron retires (body kept) because it cannot
 *   check it against the booking's "No emails" switch.
 */
export type ExhaustedEmailFailureRecovery =
  | "retry"
  | "token_reissue"
  | "sensitive"
  | "retired";

function recoveryFor(
  templateName: string,
  hasReplayableBody: boolean,
): ExhaustedEmailFailureRecovery {
  if (hasReplayableBody) return "retry";
  if (isTokenRecoveryTemplate(templateName)) return "token_reissue";
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
                select: { id: true },
              })
            : Promise.resolve([]),
        ])
      : [[], [], []];
  const replayableIds = new Set(replayable.map((row) => row.id));
  const existingBookingIds = new Set(existingBookings.map((booking) => booking.id));
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
      bookingExists:
        failure.bookingId !== null && existingBookingIds.has(failure.bookingId),
      bookingRecipientMemberId: failure.bookingRecipientMemberId,
      recovery: recoveryFor(failure.templateName, replayableIds.has(failure.id)),
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
      maxAttempts: EMAIL_FAILURE_MAX_ATTEMPTS,
    },
    failures: active.slice(0, boundedLimit),
    recentlyReviewed: reviewed.slice(0, 10),
  };
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
    emailLog.attempts < EMAIL_FAILURE_MAX_ATTEMPTS
  ) {
    throw new EmailFailureReviewError(
      "Only exhausted failed email records can be archived from this recovery queue.",
      409
    );
  }

  const reason = trimReviewReason(input.reason);
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
    details: `Archived exhausted ${emailLog.templateName} email failure for ${emailLog.to}.`,
    metadata: {
      reason,
      templateName: emailLog.templateName,
      attempts: emailLog.attempts,
      lastError: emailLog.errorMessage,
    },
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
 * transition touches this one `EmailLog` row only (INV-LOCK-001).
 */
export async function requeueExhaustedEmailFailure(
  emailLogId: string,
  input: { requestedByMemberId: string },
) {
  return prisma.$transaction(async (tx) => {
    const emailLog = await tx.emailLog.findUnique({
      where: { id: emailLogId },
      select: { id: true, to: true, templateName: true, attempts: true },
    });

    if (!emailLog) {
      throw new EmailFailureReviewError("Email failure not found.", 404);
    }

    const claim = await tx.emailLog.updateMany({
      where: {
        id: emailLog.id,
        ...EXHAUSTED_EMAIL_FAILURE_WHERE,
        ...REQUEUEABLE_EMAIL_FAILURE_WHERE,
      },
      data: {
        attempts: EMAIL_FAILURE_MAX_ATTEMPTS - 1,
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
