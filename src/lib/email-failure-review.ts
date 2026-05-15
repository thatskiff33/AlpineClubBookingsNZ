import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

export const EMAIL_FAILURE_REVIEW_ACTION = "email.failure.reviewed";
const EMAIL_FAILURE_MAX_ATTEMPTS = 3;
const MAX_EXHAUSTED_FAILURE_SCAN = 200;

export class EmailFailureReviewError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "EmailFailureReviewError";
    this.status = status;
  }
}

export interface ExhaustedEmailFailure {
  id: string;
  to: string;
  subject: string;
  templateName: string;
  attempts: number;
  lastAttemptAt: string;
  errorMessage: string | null;
  createdAt: string;
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
  const failures = await prisma.emailLog.findMany({
    where: {
      status: "FAILED",
      attempts: {
        gte: EMAIL_FAILURE_MAX_ATTEMPTS,
      },
    },
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
    },
  });
  const failureIds = failures.map((failure) => failure.id);
  const reviews =
    failureIds.length > 0
      ? await prisma.auditLog.findMany({
          where: {
            action: EMAIL_FAILURE_REVIEW_ACTION,
            targetId: {
              in: failureIds,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            targetId: true,
            actorMemberId: true,
            memberId: true,
            createdAt: true,
            metadata: true,
          },
        })
      : [];
  const latestReviewByEmailLogId = new Map<string, (typeof reviews)[number]>();

  for (const review of reviews) {
    if (review.targetId && !latestReviewByEmailLogId.has(review.targetId)) {
      latestReviewByEmailLogId.set(review.targetId, review);
    }
  }

  const decorated: ExhaustedEmailFailure[] = failures.map((failure) => {
    const review = latestReviewByEmailLogId.get(failure.id);

    return {
      id: failure.id,
      to: failure.to,
      subject: failure.subject,
      templateName: failure.templateName,
      attempts: failure.attempts,
      lastAttemptAt: failure.lastAttemptAt.toISOString(),
      errorMessage: failure.errorMessage,
      createdAt: failure.createdAt.toISOString(),
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
