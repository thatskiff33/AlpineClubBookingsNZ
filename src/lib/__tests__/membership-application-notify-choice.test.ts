import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Service-level tests for the #1786 applicant-email notify choice on
// approveMemberApplication / rejectMemberApplication. Isolated harness (not the
// shared membership-nomination one) so induction can be *enabled* here — that is
// how we prove the always-send carve-out: suppressing the applicant notice on
// approval must NOT suppress the token-bearing induction sign-off requests to
// the nominators. Induction is enabled simply by making
// prisma.clubModuleSettings.findUnique resolve (default flag = induction on);
// the shared harness leaves that method absent, which disables induction.
const { prismaMock, emailMock, xeroMock, xeroOutboxMock, subscriptionBillingMock } = vi.hoisted(() => ({
  prismaMock: {
    member: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    memberApplication: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    passwordResetToken: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    memberInductionAssignedSigner: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    clubModuleSettings: {
      // Resolving (even to null) enables induction: normalizeClubModuleSettings
      // falls back to the default flags, and induction defaults on.
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn(),
  },
  emailMock: {
    sendInductionSignOffRequestEmail: vi.fn().mockResolvedValue(undefined),
    sendMembershipApplicationApprovedEmail: vi.fn().mockResolvedValue(undefined),
    sendMembershipApplicationRejectedEmail: vi.fn().mockResolvedValue(undefined),
  },
  xeroMock: {
    isXeroConnected: vi.fn().mockResolvedValue(true),
    findOrCreateXeroContact: vi.fn().mockResolvedValue("xc-1"),
  },
  xeroOutboxMock: {
    enqueueXeroEntranceFeeInvoiceOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_1",
      message: "queued",
    }),
    processQueuedXeroOutboxOperations: vi.fn().mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    }),
  },
  subscriptionBillingMock: {
    queueApprovedMembershipSubscriptionCharges: vi.fn().mockResolvedValue({
      chargeIds: ["charge-1"],
      exceptionCount: 0,
    }),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01T00:00:00.000Z")),
}));

vi.mock("@/lib/email", () => emailMock);
vi.mock("@/lib/xero", () => xeroMock);
vi.mock("@/lib/xero-operation-outbox", () => xeroOutboxMock);
vi.mock("@/lib/membership-subscription-billing", () => subscriptionBillingMock);

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/induction", () => ({
  createMemberInduction: vi.fn().mockResolvedValue({ id: "induction-1" }),
}));

vi.mock("server-only", () => ({}));

vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed-secret"),
}));

import { prisma } from "@/lib/prisma";
import {
  approveMemberApplication,
  rejectMemberApplication,
} from "@/lib/nomination";
import {
  sendInductionSignOffRequestEmail,
  sendMembershipApplicationApprovedEmail,
  sendMembershipApplicationRejectedEmail,
} from "@/lib/email";
import { logAudit } from "@/lib/audit";

type AuditParams = { action: string; details?: string | null };

function auditFor(action: string): AuditParams | undefined {
  return vi
    .mocked(logAudit)
    .mock.calls.map((call) => call[0] as AuditParams)
    .find((params) => params.action === action);
}

function parsedAuditDetails(action: string): Record<string, unknown> {
  const params = auditFor(action);
  expect(params).toBeDefined();
  return JSON.parse(params!.details ?? "{}") as Record<string, unknown>;
}

const APPLICATION = {
  id: "app-1",
  applicantFirstName: "Jane",
  applicantLastName: "Doe",
  applicantEmail: "jane@test.com",
  applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
  applicantPhone: null,
  applicantAddress: null,
  familyMembers: [],
  nominator1Email: "nominator1@test.com",
  nominator2Email: "nominator2@test.com",
  nominator1Id: "nom-1",
  nominator2Id: "nom-2",
  nominator1ConfirmedAt: new Date("2026-04-12T01:00:00.000Z"),
  nominator2ConfirmedAt: new Date("2026-04-12T02:00:00.000Z"),
  status: "PENDING_ADMIN",
  adminNotes: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: new Date("2026-04-12T00:00:00.000Z"),
  updatedAt: new Date("2026-04-12T00:00:00.000Z"),
};

function setupApproveFixture() {
  vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue(
    APPLICATION as never,
  );
  // Two confirmed nominators become the induction signers.
  vi.mocked(prisma.member.findMany).mockResolvedValue([
    { id: "nom-1", email: "nominator1@test.com", firstName: "Nomi" },
    { id: "nom-2", email: "nominator2@test.com", firstName: "Nomo" },
  ] as never);

  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    member: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "member-1",
        email: "jane@test.com",
        firstName: "Jane",
        lastName: "Doe",
      }),
      update: vi.fn().mockResolvedValue({ id: "member-1" }),
    },
    passwordResetToken: {
      deleteMany: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
    },
    memberApplication: {
      findUnique: vi.fn().mockResolvedValue(APPLICATION),
      update: vi.fn().mockResolvedValue({
        id: "app-1",
        status: "APPROVED",
        adminNotes: null,
        nominator1Id: "nom-1",
        nominator2Id: "nom-2",
      }),
    },
  };

  (prisma.$transaction as unknown as Mock).mockImplementation(
    (callback: (client: typeof tx) => unknown) => callback(tx),
  );
}

function setupRejectFixture() {
  vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue({
    id: "app-1",
    applicantEmail: "jane@test.com",
    applicantFirstName: "Jane",
    status: "PENDING_ADMIN",
  } as never);

  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    memberApplication: {
      findUnique: vi.fn().mockResolvedValue({
        id: "app-1",
        applicantEmail: "jane@test.com",
        applicantFirstName: "Jane",
        status: "PENDING_ADMIN",
      }),
      update: vi.fn().mockResolvedValue({
        id: "app-1",
        applicantEmail: "jane@test.com",
        applicantFirstName: "Jane",
        status: "REJECTED",
      }),
    },
  };

  (prisma.$transaction as unknown as Mock).mockImplementation(
    (callback: (client: typeof tx) => unknown) => callback(tx),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  subscriptionBillingMock.queueApprovedMembershipSubscriptionCharges.mockResolvedValue({
    chargeIds: ["charge-1"],
    exceptionCount: 0,
  });
  prismaMock.memberApplication.update.mockResolvedValue({} as never);
  xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation.mockResolvedValue({
    queueOperationId: "queue_1",
    message: "queued",
  });
});

describe("approveMemberApplication notify choice (#1786)", () => {
  it("suppresses the applicant email and audits notifyMember:false, while the state change and induction sign-off requests still happen", async () => {
    setupApproveFixture();

    const result = await approveMemberApplication(
      "app-1",
      "admin-1",
      "Welcome aboard",
      null,
      false,
    );

    // State change still applied.
    expect(result.application.status).toBe("APPROVED");
    // Applicant approval notice suppressed.
    expect(sendMembershipApplicationApprovedEmail).not.toHaveBeenCalled();
    // Always-send carve-out: induction sign-off requests still fire to signers.
    expect(sendInductionSignOffRequestEmail).toHaveBeenCalledTimes(2);
    // Honesty rule: the suppression is recorded in the audit details.
    expect(parsedAuditDetails("MEMBERSHIP_APPLICATION_APPROVED")).toMatchObject({
      notifyMember: false,
    });
  });

  it("emails the applicant and records no notify field when notifyMember is true", async () => {
    setupApproveFixture();

    await approveMemberApplication("app-1", "admin-1", "Welcome aboard", null, true);

    expect(sendMembershipApplicationApprovedEmail).toHaveBeenCalledTimes(1);
    expect(sendInductionSignOffRequestEmail).toHaveBeenCalledTimes(2);
    expect(
      parsedAuditDetails("MEMBERSHIP_APPLICATION_APPROVED"),
    ).not.toHaveProperty("notifyMember");
  });

  it("emails the applicant and records no notify field when the flag is omitted (default = notify)", async () => {
    setupApproveFixture();

    await approveMemberApplication("app-1", "admin-1", "Welcome aboard", null);

    expect(sendMembershipApplicationApprovedEmail).toHaveBeenCalledTimes(1);
    expect(
      parsedAuditDetails("MEMBERSHIP_APPLICATION_APPROVED"),
    ).not.toHaveProperty("notifyMember");
  });
});

describe("rejectMemberApplication notify choice (#1786)", () => {
  it("suppresses the applicant email and audits notifyMember:false, while the state change still happens", async () => {
    setupRejectFixture();

    const result = await rejectMemberApplication(
      "app-1",
      "admin-1",
      "Not eligible",
      false,
    );

    expect(result.status).toBe("REJECTED");
    expect(sendMembershipApplicationRejectedEmail).not.toHaveBeenCalled();
    expect(parsedAuditDetails("MEMBERSHIP_APPLICATION_REJECTED")).toMatchObject({
      notifyMember: false,
    });
  });

  it("emails the applicant and records no notify field when notifyMember is true", async () => {
    setupRejectFixture();

    await rejectMemberApplication("app-1", "admin-1", "Not eligible", true);

    expect(sendMembershipApplicationRejectedEmail).toHaveBeenCalledTimes(1);
    expect(
      parsedAuditDetails("MEMBERSHIP_APPLICATION_REJECTED"),
    ).not.toHaveProperty("notifyMember");
  });

  it("emails the applicant and records no notify field when the flag is omitted (default = notify)", async () => {
    setupRejectFixture();

    await rejectMemberApplication("app-1", "admin-1", "Not eligible");

    expect(sendMembershipApplicationRejectedEmail).toHaveBeenCalledTimes(1);
    expect(
      parsedAuditDetails("MEMBERSHIP_APPLICATION_REJECTED"),
    ).not.toHaveProperty("notifyMember");
  });
});
