import { ApplicationStatus } from "@prisma/client";
import { issueActionToken } from "@/lib/action-tokens";
import { createAuditLog, logAudit } from "@/lib/audit";
import {
  sendMemberSetupInviteEmail,
  sendNominationRequestEmail,
} from "@/lib/email";
import { getActiveEmailSuppression } from "@/lib/email-suppression";
import logger from "@/lib/logger";
import {
  MEMBER_SETUP_INVITE_TTL_DAYS,
  getMemberSetupInviteExpiryDate,
} from "@/lib/member-setup-invite";
import {
  MembershipCancellationRequestError,
  reissueParticipantConfirmationToken,
} from "@/lib/membership-cancellation-requests";
import { prisma } from "@/lib/prisma";

export const TOKEN_EMAIL_RECOVERY_ACTION = "email.token_lifecycle.reissued";

export const TOKEN_EMAIL_RECOVERY_TEMPLATES = [
  "nomination-request",
  "member-setup-invite",
  "membership-cancellation-confirmation",
] as const;

type TokenEmailRecoveryTemplate = (typeof TOKEN_EMAIL_RECOVERY_TEMPLATES)[number];

const TOKEN_EMAIL_RECOVERY_TEMPLATE_SET = new Set<string>(
  TOKEN_EMAIL_RECOVERY_TEMPLATES,
);
const TOKEN_EMAIL_RECOVERY_SCAN_LIMIT = 200;

export class TokenEmailRecoveryError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TokenEmailRecoveryError";
    this.status = status;
  }
}

export interface TokenEmailRecoveryQueueItem {
  id: string;
  to: string;
  subject: string;
  templateName: string;
  status: string;
  lastAttemptAt: string;
  errorMessage: string | null;
  createdAt: string;
  reissuedAt: string | null;
  reissuedById: string | null;
}

function isTokenRecoveryTemplate(
  templateName: string,
): templateName is TokenEmailRecoveryTemplate {
  return TOKEN_EMAIL_RECOVERY_TEMPLATE_SET.has(templateName);
}

function readRecoveryActorId(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>).adminMemberId;
  return typeof value === "string" && value ? value : null;
}

function familyMemberCount(familyMembers: unknown) {
  return Array.isArray(familyMembers) ? familyMembers.length : 0;
}

function applicationDisplayName(application: {
  applicantFirstName: string;
  applicantLastName: string;
}) {
  return `${application.applicantFirstName} ${application.applicantLastName}`.trim();
}

async function getTokenEmailFailure(emailLogId: string) {
  const emailLog = await prisma.emailLog.findUnique({
    where: { id: emailLogId },
    select: {
      id: true,
      to: true,
      subject: true,
      templateName: true,
      htmlBody: true,
      status: true,
    },
  });

  if (!emailLog) {
    throw new TokenEmailRecoveryError("Email failure not found.", 404);
  }

  if (!isTokenRecoveryTemplate(emailLog.templateName)) {
    throw new TokenEmailRecoveryError(
      "This email template does not support token reissue recovery.",
      409,
    );
  }

  if (emailLog.status !== "FAILED" && emailLog.status !== "BOUNCED") {
    throw new TokenEmailRecoveryError(
      "Only failed or bounced token-bearing emails can be reissued.",
      409,
    );
  }

  if (emailLog.htmlBody !== null) {
    throw new TokenEmailRecoveryError(
      "Retryable email records should use the standard email retry queue.",
      409,
    );
  }

  const activeSuppression = await getActiveEmailSuppression(emailLog.to);
  if (activeSuppression) {
    throw new TokenEmailRecoveryError(
      "Clear the active email suppression before reissuing this token email.",
      409,
    );
  }

  return emailLog;
}

async function recordTokenEmailRecovery({
  emailLogId,
  templateName,
  adminMemberId,
}: {
  emailLogId: string;
  templateName: string;
  adminMemberId: string;
}) {
  await createAuditLog({
    action: TOKEN_EMAIL_RECOVERY_ACTION,
    memberId: adminMemberId,
    actorMemberId: adminMemberId,
    targetId: emailLogId,
    entityType: "EmailLog",
    entityId: emailLogId,
    category: "communication",
    severity: "important",
    outcome: "success",
    summary: "Token-bearing lifecycle email reissued",
    metadata: {
      emailLogId,
      templateName,
      adminMemberId,
    },
  });
}

async function reissueMemberSetupInvite({
  emailLogId,
  recipientEmail,
  adminMemberId,
}: {
  emailLogId: string;
  recipientEmail: string;
  adminMemberId: string;
}) {
  const member = await prisma.member.findFirst({
    where: {
      email: { equals: recipientEmail, mode: "insensitive" },
      active: true,
      canLogin: true,
    },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  if (!member) {
    throw new TokenEmailRecoveryError(
      "No active login-capable member matches this setup invite recipient.",
      404,
    );
  }

  const issued = issueActionToken();
  const expiresAt = getMemberSetupInviteExpiryDate();

  await prisma.passwordResetToken.deleteMany({
    where: { memberId: member.id },
  });
  await prisma.passwordResetToken.create({
    data: {
      tokenHash: issued.tokenHash,
      memberId: member.id,
      expiresAt,
    },
  });

  try {
    await sendMemberSetupInviteEmail(member.email, member.firstName, issued.token);
  } catch (err) {
    logger.error(
      { err, emailLogId, memberId: member.id },
      "Failed to resend member setup invite during token email recovery",
    );
    return {
      emailWarnings: [`Setup invite could not be sent to ${member.email}`],
    };
  }

  logAudit({
    action: "member.setup-invite-reissued",
    memberId: adminMemberId,
    actorMemberId: adminMemberId,
    targetId: member.id,
    entityType: "Member",
    entityId: member.id,
    category: "communication",
    severity: "important",
    outcome: "success",
    summary: "Member setup invite reissued",
    metadata: {
      emailLogId,
      expiryLabel: `${MEMBER_SETUP_INVITE_TTL_DAYS} days`,
    },
  });

  return { emailWarnings: [] };
}

async function reissueNominationRequest({
  emailLogId,
  recipientEmail,
  adminMemberId,
}: {
  emailLogId: string;
  recipientEmail: string;
  adminMemberId: string;
}) {
  const nominator = await prisma.member.findFirst({
    where: {
      email: { equals: recipientEmail, mode: "insensitive" },
      active: true,
    },
    select: { id: true, email: true, firstName: true },
  });

  if (!nominator) {
    throw new TokenEmailRecoveryError(
      "No active nominator member matches this nomination email recipient.",
      404,
    );
  }

  const nominationToken = await prisma.nominationToken.findFirst({
    where: {
      nominatorMemberId: nominator.id,
      confirmedAt: null,
      application: { status: ApplicationStatus.PENDING_NOMINATORS },
    },
    orderBy: { createdAt: "desc" },
    include: { application: true },
  });

  if (!nominationToken) {
    throw new TokenEmailRecoveryError(
      "No pending nomination token is available for this recipient.",
      404,
    );
  }

  const issued = issueActionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.nominationToken.update({
    where: { id: nominationToken.id },
    data: {
      tokenHash: issued.tokenHash,
      expiresAt,
    },
  });

  const applicantName = applicationDisplayName(nominationToken.application);
  try {
    await sendNominationRequestEmail({
      email: nominator.email,
      nominatorName: nominator.firstName,
      applicantName,
      token: issued.token,
      familyMemberCount: familyMemberCount(
        nominationToken.application.familyMembers,
      ),
      expiresAt,
    });
  } catch (err) {
    logger.error(
      {
        err,
        emailLogId,
        applicationId: nominationToken.applicationId,
        nominatorId: nominator.id,
      },
      "Failed to resend nomination request during token email recovery",
    );
    return {
      emailWarnings: [`Nomination request could not be sent to ${nominator.email}`],
    };
  }

  logAudit({
    action: "membership_application.nomination_token_reissued",
    memberId: adminMemberId,
    actorMemberId: adminMemberId,
    subjectMemberId: nominator.id,
    targetId: nominationToken.applicationId,
    entityType: "NominationToken",
    entityId: nominationToken.id,
    category: "communication",
    severity: "important",
    outcome: "success",
    summary: "Membership nomination token reissued",
    metadata: {
      emailLogId,
      applicationId: nominationToken.applicationId,
      nominatorMemberId: nominator.id,
    },
  });

  return { emailWarnings: [] };
}

async function reissueMembershipCancellationConfirmation({
  recipientEmail,
  adminMemberId,
  ipAddress,
}: {
  recipientEmail: string;
  adminMemberId: string;
  ipAddress?: string | null;
}) {
  const participant =
    await prisma.membershipCancellationRequestParticipant.findFirst({
      where: {
        status: "PENDING_CONFIRMATION",
        member: {
          email: { equals: recipientEmail, mode: "insensitive" },
        },
        request: { status: "REQUESTED" },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        requestId: true,
      },
    });

  if (!participant) {
    throw new TokenEmailRecoveryError(
      "No open membership cancellation participant is awaiting confirmation for this recipient.",
      404,
    );
  }

  try {
    const result = await reissueParticipantConfirmationToken({
      requestId: participant.requestId,
      participantId: participant.id,
      adminMemberId,
      ipAddress,
    });
    return { emailWarnings: result.emailWarnings };
  } catch (err) {
    if (err instanceof MembershipCancellationRequestError) {
      throw new TokenEmailRecoveryError(err.message, err.statusCode);
    }
    throw err;
  }
}

export async function getTokenEmailRecoveryQueue(limit = 25) {
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const failures = await prisma.emailLog.findMany({
    where: {
      templateName: { in: [...TOKEN_EMAIL_RECOVERY_TEMPLATES] },
      status: { in: ["FAILED", "BOUNCED"] },
      htmlBody: null,
    },
    orderBy: [
      { lastAttemptAt: "desc" },
      { createdAt: "desc" },
    ],
    take: TOKEN_EMAIL_RECOVERY_SCAN_LIMIT,
    select: {
      id: true,
      to: true,
      subject: true,
      templateName: true,
      status: true,
      lastAttemptAt: true,
      errorMessage: true,
      createdAt: true,
    },
  });
  const failureIds = failures.map((failure) => failure.id);
  const recoveries =
    failureIds.length > 0
      ? await prisma.auditLog.findMany({
          where: {
            action: TOKEN_EMAIL_RECOVERY_ACTION,
            targetId: { in: failureIds },
          },
          orderBy: { createdAt: "desc" },
          select: {
            targetId: true,
            actorMemberId: true,
            memberId: true,
            createdAt: true,
            metadata: true,
          },
        })
      : [];
  const latestRecoveryByEmailLogId = new Map<string, (typeof recoveries)[number]>();

  for (const recovery of recoveries) {
    if (recovery.targetId && !latestRecoveryByEmailLogId.has(recovery.targetId)) {
      latestRecoveryByEmailLogId.set(recovery.targetId, recovery);
    }
  }

  const decorated: TokenEmailRecoveryQueueItem[] = failures.map((failure) => {
    const recovery = latestRecoveryByEmailLogId.get(failure.id);
    return {
      id: failure.id,
      to: failure.to,
      subject: failure.subject,
      templateName: failure.templateName,
      status: failure.status,
      lastAttemptAt: failure.lastAttemptAt.toISOString(),
      errorMessage: failure.errorMessage,
      createdAt: failure.createdAt.toISOString(),
      reissuedAt: recovery?.createdAt.toISOString() ?? null,
      reissuedById:
        recovery?.actorMemberId ??
        recovery?.memberId ??
        readRecoveryActorId(recovery?.metadata),
    };
  });
  const active = decorated.filter((failure) => !failure.reissuedAt);
  const reissued = decorated.filter((failure) => failure.reissuedAt);

  return {
    summary: {
      activeCount: active.length,
      reissuedCount: reissued.length,
      scannedCount: decorated.length,
    },
    failures: active.slice(0, boundedLimit),
    recentlyReissued: reissued.slice(0, 10),
  };
}

export async function reissueTokenBearingEmailFailure({
  emailLogId,
  adminMemberId,
  ipAddress,
}: {
  emailLogId: string;
  adminMemberId: string;
  ipAddress?: string | null;
}) {
  const emailLog = await getTokenEmailFailure(emailLogId);
  let result: { emailWarnings: string[] };

  if (emailLog.templateName === "member-setup-invite") {
    result = await reissueMemberSetupInvite({
      emailLogId,
      recipientEmail: emailLog.to,
      adminMemberId,
    });
  } else if (emailLog.templateName === "nomination-request") {
    result = await reissueNominationRequest({
      emailLogId,
      recipientEmail: emailLog.to,
      adminMemberId,
    });
  } else {
    result = await reissueMembershipCancellationConfirmation({
      recipientEmail: emailLog.to,
      adminMemberId,
      ipAddress,
    });
  }

  const reissued = result.emailWarnings.length === 0;
  if (reissued) {
    await recordTokenEmailRecovery({
      emailLogId,
      templateName: emailLog.templateName,
      adminMemberId,
    });
  }

  return {
    reissued,
    templateName: emailLog.templateName,
    emailWarnings: result.emailWarnings,
  };
}
