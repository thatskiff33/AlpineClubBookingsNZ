import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  participantFindMany: vi.fn(),
  participantFindUnique: vi.fn(),
  participantUpdate: vi.fn(),
  participantUpdateMany: vi.fn(),
  requestCreate: vi.fn(),
  requestFindMany: vi.fn(),
  sendAdminRequestAlert: vi.fn(),
  sendConfirmationEmail: vi.fn(),
  sendSubmittedEmail: vi.fn(),
  issueActionToken: vi.fn(),
  hashActionToken: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const prismaClient = {
    member: {
      findUnique: mocks.memberFindUnique,
      findMany: mocks.memberFindMany,
    },
    membershipCancellationRequest: {
      create: mocks.requestCreate,
      findMany: mocks.requestFindMany,
    },
    membershipCancellationRequestParticipant: {
      findMany: mocks.participantFindMany,
      findUnique: mocks.participantFindUnique,
      update: mocks.participantUpdate,
      updateMany: mocks.participantUpdateMany,
    },
    $transaction: (
      callback: (tx: typeof prismaClient) => Promise<unknown>,
    ) => callback(prismaClient),
  };
  return { prisma: prismaClient };
});

vi.mock("@/lib/email", () => ({
  sendAdminMembershipCancellationRequestAlert: mocks.sendAdminRequestAlert,
  sendMembershipCancellationConfirmationEmail: mocks.sendConfirmationEmail,
  sendMembershipCancellationSubmittedEmail: mocks.sendSubmittedEmail,
}));

vi.mock("@/lib/action-tokens", () => ({
  issueActionToken: mocks.issueActionToken,
  hashActionToken: mocks.hashActionToken,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  MembershipCancellationRequestError,
  createMembershipCancellationRequest,
  respondToMembershipCancellationConfirmation,
} from "@/lib/membership-cancellation-requests";

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    email: "member@example.org",
    firstName: "Alice",
    lastName: "Smith",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    role: "MEMBER",
    cancelledAt: null,
    parentMemberId: null,
    secondaryParentId: null,
    familyGroupMemberships: [
      {
        familyGroupId: "family-1",
        familyGroup: { id: "family-1", name: "Smith Family" },
      },
    ],
    ...overrides,
  };
}

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: "participant-1",
    requestId: "request-1",
    memberId: "adult-login",
    status: "PENDING_CONFIRMATION",
    confirmationTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    confirmedAt: null,
    declinedAt: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    member: member({
      id: "adult-login",
      email: "adult@example.org",
      firstName: "Bob",
      canLogin: true,
    }),
    request: {
      id: "request-1",
      requestedByMemberId: "member-1",
      status: "REQUESTED",
      reason: "Moving away",
      submittedAt: new Date("2026-05-24T00:00:00.000Z"),
      reviewedAt: null,
      completedAt: null,
      requestedBy: {
        id: "member-1",
        firstName: "Alice",
        lastName: "Smith",
        email: "member@example.org",
      },
      participants: [],
    },
    ...overrides,
  };
}

describe("membership cancellation request workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindUnique.mockResolvedValue(member());
    mocks.memberFindMany.mockResolvedValue([
      member(),
      member({
        id: "child-1",
        firstName: "Charlie",
        ageTier: "CHILD",
        canLogin: false,
        parentMemberId: "member-1",
        email: "member@example.org",
      }),
      member({
        id: "adult-login",
        firstName: "Bob",
        email: "adult@example.org",
        canLogin: true,
      }),
    ]);
    mocks.participantFindMany.mockResolvedValue([]);
    mocks.issueActionToken.mockReturnValue({
      token: "raw-confirmation-token",
      tokenHash: "hashed-confirmation-token",
    });
    mocks.hashActionToken.mockImplementation((token: string) => `hash:${token}`);
    mocks.sendAdminRequestAlert.mockResolvedValue(undefined);
    mocks.sendConfirmationEmail.mockResolvedValue(undefined);
    mocks.sendSubmittedEmail.mockResolvedValue(undefined);
    mocks.participantUpdateMany.mockResolvedValue({ count: 0 });
    mocks.requestCreate.mockImplementation(async (args) => ({
      id: "request-1",
      status: "REQUESTED",
      reason: args.data.reason,
      submittedAt: new Date("2026-05-24T00:00:00.000Z"),
      reviewedAt: null,
      completedAt: null,
      requestedBy: {
        id: "member-1",
        firstName: "Alice",
        lastName: "Smith",
        email: "member@example.org",
      },
      participants: args.data.participants.create.map(
        (create: Record<string, unknown>, index: number) => {
          const isOwnLoginAdult = create.memberId === "adult-login";
          return {
            id: `participant-${index + 1}`,
            memberId: create.memberId,
            status: create.status,
            confirmationTokenExpiresAt: create.confirmationTokenExpiresAt ?? null,
            confirmedAt: create.confirmedAt ?? null,
            declinedAt: null,
            createdAt: new Date("2026-05-24T00:00:00.000Z"),
            member: isOwnLoginAdult
              ? member({
                  id: "adult-login",
                  firstName: "Bob",
                  email: "adult@example.org",
                  canLogin: true,
                })
              : member({
                  id: String(create.memberId),
                  firstName:
                    create.memberId === "child-1" ? "Charlie" : "Alice",
                  email: "member@example.org",
                  canLogin: create.memberId !== "child-1",
                  ageTier: create.memberId === "child-1" ? "CHILD" : "ADULT",
                }),
          };
        },
      ),
    }));
  });

  it("creates a request and tokenizes own-login adult confirmations", async () => {
    const result = await createMembershipCancellationRequest({
      requesterMemberId: "member-1",
      participantMemberIds: ["member-1", "child-1", "adult-login"],
      reason: "Moving away",
      acknowledgedWarning: true,
      ipAddress: "203.0.113.1",
    });

    expect(result.request.participants).toHaveLength(3);
    expect(mocks.requestCreate).toHaveBeenCalledTimes(1);

    const createArgs = mocks.requestCreate.mock.calls[0][0];
    expect(createArgs.data.participants.create).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: "member-1",
          status: "REQUESTED",
          confirmationTokenHash: null,
        }),
        expect.objectContaining({
          memberId: "child-1",
          status: "REQUESTED",
          confirmationTokenHash: null,
        }),
        expect.objectContaining({
          memberId: "adult-login",
          status: "PENDING_CONFIRMATION",
          confirmationTokenHash: "hashed-confirmation-token",
        }),
      ]),
    );
    expect(JSON.stringify(createArgs)).not.toContain("raw-confirmation-token");
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "adult@example.org",
        token: "raw-confirmation-token",
        requesterName: "Alice Smith",
        participantName: "Bob Smith",
      }),
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.requested",
        entityType: "MembershipCancellationRequest",
      }),
    );
  });

  it("rejects selected members with an open cancellation participant", async () => {
    mocks.participantFindMany.mockResolvedValue([
      {
        memberId: "child-1",
        status: "REQUESTED",
        request: {
          id: "request-open",
          status: "REQUESTED",
          submittedAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      },
    ]);

    await expect(
      createMembershipCancellationRequest({
        requesterMemberId: "member-1",
        participantMemberIds: ["child-1"],
        acknowledgedWarning: true,
      }),
    ).rejects.toMatchObject({
      message:
        "One or more selected memberships are not eligible for cancellation requests",
      statusCode: 422,
    } satisfies Partial<MembershipCancellationRequestError>);
    expect(mocks.requestCreate).not.toHaveBeenCalled();
  });

  it("re-checks open participant rows inside the create transaction", async () => {
    // Candidate load sees no conflict, but a concurrent submission
    // creates an open participant before this transaction runs the
    // findMany guard. The transaction-time check should fail with 409.
    mocks.participantFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { memberId: "child-1" },
      ]);

    await expect(
      createMembershipCancellationRequest({
        requesterMemberId: "member-1",
        participantMemberIds: ["child-1"],
        acknowledgedWarning: true,
      }),
    ).rejects.toMatchObject({
      message:
        "One or more selected memberships already have an open cancellation request",
      statusCode: 409,
    } satisfies Partial<MembershipCancellationRequestError>);
    expect(mocks.requestCreate).not.toHaveBeenCalled();
  });

  it("confirms a pending participant by hashed token and clears the token hash", async () => {
    const current = participant();
    mocks.participantFindUnique.mockResolvedValue(current);
    mocks.participantUpdate.mockResolvedValue({
      ...current,
      status: "REQUESTED",
      confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
      confirmationTokenHash: null,
      confirmationTokenExpiresAt: null,
      request: {
        ...current.request,
        participants: [
          {
            ...current,
            status: "REQUESTED",
            confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
          },
        ],
      },
    });

    const response = await respondToMembershipCancellationConfirmation({
      token: "raw-confirmation-token",
      memberId: "adult-login",
      decision: "confirm",
      ipAddress: "203.0.113.1",
    });

    expect(mocks.participantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { confirmationTokenHash: "hash:raw-confirmation-token" },
      }),
    );
    expect(mocks.participantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "participant-1" },
        data: expect.objectContaining({
          status: "REQUESTED",
          confirmedAt: expect.any(Date),
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        }),
      }),
    );
    expect(response.message).toMatch(/confirmation has been recorded/i);
  });

  it("declines a pending participant without cancelling the membership", async () => {
    const current = participant();
    mocks.participantFindUnique.mockResolvedValue(current);
    mocks.participantUpdate.mockResolvedValue({
      ...current,
      status: "DECLINED",
      declinedAt: new Date("2026-05-24T01:00:00.000Z"),
      request: {
        ...current.request,
        participants: [
          {
            ...current,
            status: "DECLINED",
            declinedAt: new Date("2026-05-24T01:00:00.000Z"),
          },
        ],
      },
    });

    const response = await respondToMembershipCancellationConfirmation({
      token: "raw-confirmation-token",
      memberId: "adult-login",
      decision: "decline",
    });

    expect(mocks.participantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DECLINED",
          declinedAt: expect.any(Date),
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        }),
      }),
    );
    expect(response.message).toMatch(/membership remains active/i);
  });

  it("invalidates any other open PENDING_CONFIRMATION rows for the same member", async () => {
    const current = participant();
    mocks.participantFindUnique.mockResolvedValue(current);
    mocks.participantUpdate.mockResolvedValue({
      ...current,
      status: "REQUESTED",
      confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
      confirmationTokenHash: null,
      confirmationTokenExpiresAt: null,
      request: {
        ...current.request,
        participants: [
          {
            ...current,
            status: "REQUESTED",
            confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
          },
        ],
      },
    });
    mocks.participantUpdateMany.mockResolvedValue({ count: 1 });

    await respondToMembershipCancellationConfirmation({
      token: "raw-confirmation-token",
      memberId: "adult-login",
      decision: "confirm",
    });

    expect(mocks.participantUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId: "adult-login",
          status: "PENDING_CONFIRMATION",
          id: { not: "participant-1" },
        },
        data: {
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        },
      }),
    );
  });
});
