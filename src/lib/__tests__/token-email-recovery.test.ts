import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockEmail,
  mockAudit,
  mockTokens,
  mockCancellation,
  MockMembershipCancellationRequestError,
} = vi.hoisted(() => {
  class MockMembershipCancellationRequestError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  return {
    mockPrisma: {
      emailLog: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      auditLog: {
        findMany: vi.fn(),
      },
      emailSuppression: {
        findFirst: vi.fn(),
      },
      member: {
        findFirst: vi.fn(),
      },
      passwordResetToken: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
      nominationToken: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      membershipCancellationRequestParticipant: {
        findFirst: vi.fn(),
      },
    },
    mockEmail: {
      sendMemberSetupInviteEmail: vi.fn(),
      sendNominationRequestEmail: vi.fn(),
    },
    mockAudit: {
      createAuditLog: vi.fn(),
      logAudit: vi.fn(),
    },
    mockTokens: {
      issueActionToken: vi.fn(),
    },
    mockCancellation: {
      reissueParticipantConfirmationToken: vi.fn(),
    },
    MockMembershipCancellationRequestError,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/email", () => mockEmail);
vi.mock("@/lib/audit", () => mockAudit);
vi.mock("@/lib/action-tokens", () => ({
  issueActionToken: mockTokens.issueActionToken,
}));
vi.mock("@/lib/membership-cancellation-requests", () => ({
  MembershipCancellationRequestError: MockMembershipCancellationRequestError,
  reissueParticipantConfirmationToken:
    mockCancellation.reissueParticipantConfirmationToken,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function emailLog(templateName: string) {
  return {
    id: "email-log-1",
    to: "member@example.org",
    subject: "Token email",
    templateName,
    htmlBody: null,
    status: "FAILED",
  };
}

describe("token email recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockPrisma.emailSuppression.findFirst.mockResolvedValue(null);
    mockPrisma.auditLog.findMany.mockResolvedValue([]);
    mockPrisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.passwordResetToken.create.mockResolvedValue({});
    mockPrisma.nominationToken.update.mockResolvedValue({});
    mockEmail.sendMemberSetupInviteEmail.mockResolvedValue(undefined);
    mockEmail.sendNominationRequestEmail.mockResolvedValue(undefined);
    mockAudit.createAuditLog.mockResolvedValue(undefined);
    mockTokens.issueActionToken.mockReturnValue({
      token: "fresh-token",
      tokenHash: "fresh-token-hash",
    });
    mockCancellation.reissueParticipantConfirmationToken.mockResolvedValue({
      request: { id: "request-1" },
      emailWarnings: [],
    });
  });

  it("decorates active and reissued token-bearing email failures", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "active-log",
        to: "nominator@example.org",
        subject: "Nomination request",
        templateName: "nomination-request",
        status: "FAILED",
        lastAttemptAt: new Date("2026-06-21T00:00:00.000Z"),
        errorMessage: "SES down",
        createdAt: new Date("2026-06-21T00:00:00.000Z"),
      },
      {
        id: "reissued-log",
        to: "setup@example.org",
        subject: "Setup invite",
        templateName: "member-setup-invite",
        status: "BOUNCED",
        lastAttemptAt: new Date("2026-06-20T00:00:00.000Z"),
        errorMessage: "Suppressed",
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
      },
    ]);
    mockPrisma.auditLog.findMany.mockResolvedValue([
      {
        targetId: "reissued-log",
        actorMemberId: "admin-1",
        memberId: "admin-1",
        createdAt: new Date("2026-06-21T02:00:00.000Z"),
        metadata: { adminMemberId: "admin-1" },
      },
    ]);

    const { getTokenEmailRecoveryQueue } = await import(
      "@/lib/token-email-recovery"
    );
    const queue = await getTokenEmailRecoveryQueue();

    expect(queue.summary).toEqual({
      activeCount: 1,
      reissuedCount: 1,
      scannedCount: 2,
    });
    expect(queue.failures.map((failure) => failure.id)).toEqual(["active-log"]);
    expect(queue.recentlyReissued[0]).toMatchObject({
      id: "reissued-log",
      reissuedById: "admin-1",
    });
  });

  it("reissues member setup invites with a fresh token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
    mockPrisma.emailLog.findUnique.mockResolvedValue(
      emailLog("member-setup-invite"),
    );
    mockPrisma.member.findFirst.mockResolvedValue({
      id: "member-1",
      email: "member@example.org",
      firstName: "Alice",
      lastName: "Smith",
    });

    const { reissueTokenBearingEmailFailure } = await import(
      "@/lib/token-email-recovery"
    );
    const result = await reissueTokenBearingEmailFailure({
      emailLogId: "email-log-1",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({
      reissued: true,
      templateName: "member-setup-invite",
      emailWarnings: [],
    });
    expect(mockPrisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mockPrisma.passwordResetToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenHash: "fresh-token-hash",
        memberId: "member-1",
      }),
    });
    expect(mockEmail.sendMemberSetupInviteEmail).toHaveBeenCalledWith(
      "member@example.org",
      "Alice",
      "fresh-token",
    );
    expect(mockAudit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "email.token_lifecycle.reissued",
        targetId: "email-log-1",
        actorMemberId: "admin-1",
      }),
    );
  });

  it("reissues nomination requests with a fresh nomination token", async () => {
    mockPrisma.emailLog.findUnique.mockResolvedValue(
      emailLog("nomination-request"),
    );
    mockPrisma.member.findFirst.mockResolvedValue({
      id: "nominator-1",
      email: "member@example.org",
      firstName: "Nina",
    });
    mockPrisma.nominationToken.findFirst.mockResolvedValue({
      id: "nomination-token-1",
      applicationId: "application-1",
      nominatorMemberId: "nominator-1",
      application: {
        applicantFirstName: "Applicant",
        applicantLastName: "Member",
        familyMembers: [{ firstName: "Child" }],
      },
    });

    const { reissueTokenBearingEmailFailure } = await import(
      "@/lib/token-email-recovery"
    );
    const result = await reissueTokenBearingEmailFailure({
      emailLogId: "email-log-1",
      adminMemberId: "admin-1",
    });

    expect(result.reissued).toBe(true);
    expect(mockPrisma.nominationToken.update).toHaveBeenCalledWith({
      where: { id: "nomination-token-1" },
      data: expect.objectContaining({
        tokenHash: "fresh-token-hash",
      }),
    });
    expect(mockEmail.sendNominationRequestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "member@example.org",
        nominatorName: "Nina",
        applicantName: "Applicant Member",
        token: "fresh-token",
        familyMemberCount: 1,
      }),
    );
    expect(mockAudit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_application.nomination_token_reissued",
        targetId: "application-1",
        actorMemberId: "admin-1",
      }),
    );
  });

  it("delegates membership cancellation confirmation reissue to the cancellation service", async () => {
    mockPrisma.emailLog.findUnique.mockResolvedValue(
      emailLog("membership-cancellation-confirmation"),
    );
    mockPrisma.membershipCancellationRequestParticipant.findFirst.mockResolvedValue({
      id: "participant-1",
      requestId: "request-1",
    });

    const { reissueTokenBearingEmailFailure } = await import(
      "@/lib/token-email-recovery"
    );
    const result = await reissueTokenBearingEmailFailure({
      emailLogId: "email-log-1",
      adminMemberId: "admin-1",
      ipAddress: "127.0.0.1",
    });

    expect(result.reissued).toBe(true);
    expect(
      mockCancellation.reissueParticipantConfirmationToken,
    ).toHaveBeenCalledWith({
      requestId: "request-1",
      participantId: "participant-1",
      adminMemberId: "admin-1",
      ipAddress: "127.0.0.1",
    });
  });

  it("blocks reissue while the recipient has an active email suppression", async () => {
    mockPrisma.emailLog.findUnique.mockResolvedValue(
      emailLog("member-setup-invite"),
    );
    mockPrisma.emailSuppression.findFirst.mockResolvedValue({
      id: "suppression-1",
      email: "member@example.org",
      suppressedAt: new Date("2026-06-21T00:00:00.000Z"),
    });

    const { reissueTokenBearingEmailFailure } = await import(
      "@/lib/token-email-recovery"
    );

    await expect(
      reissueTokenBearingEmailFailure({
        emailLogId: "email-log-1",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        "Clear the active email suppression before reissuing this token email.",
    });
    expect(mockTokens.issueActionToken).not.toHaveBeenCalled();
  });
});
