import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, emailMock, xeroMock, xeroOutboxMock } = vi.hoisted(() => ({
  prismaMock: {
    member: {
      findFirst: vi.fn(),
    },
    memberApplication: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    nominationToken: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    familyGroup: {
      create: vi.fn(),
    },
    familyGroupMember: {
      create: vi.fn(),
    },
    passwordResetToken: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  emailMock: {
    sendNominationRequestEmail: vi.fn().mockResolvedValue(undefined),
    sendAdminMembershipApplicationPendingEmail: vi.fn().mockResolvedValue(
      undefined
    ),
    sendMembershipApplicationApprovedEmail: vi.fn().mockResolvedValue(
      undefined
    ),
    sendMembershipApplicationRejectedEmail: vi.fn().mockResolvedValue(
      undefined
    ),
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
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01T00:00:00.000Z")),
}));

vi.mock("@/lib/utils", () => ({
  getSeasonYear: vi.fn().mockReturnValue(2026),
}));

vi.mock("@/lib/email", () => emailMock);

vi.mock("@/lib/xero", () => xeroMock);

vi.mock("@/lib/xero-operation-outbox", () => xeroOutboxMock);

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

// @ts-expect-error Vitest supports virtual mocks for modules that only exist in Next.js runtime.
vi.mock("server-only", () => ({}), { virtual: true });

vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed-secret"),
}));

import { prisma } from "@/lib/prisma";
import {
  approveMemberApplication,
  confirmNomination,
  createMemberApplication,
} from "@/lib/nomination";
import {
  assertLinkedBookingMembersCanBeBooked,
  type LinkedBookingMember,
} from "@/lib/booking-guests";
import {
  sendAdminMembershipApplicationPendingEmail,
  sendMembershipApplicationApprovedEmail,
  sendNominationRequestEmail,
} from "@/lib/email";
import {
  findOrCreateXeroContact,
} from "@/lib/xero";
import {
  enqueueXeroEntranceFeeInvoiceOperation,
} from "@/lib/xero-operation-outbox";
import { hashActionToken } from "@/lib/action-tokens";

describe("membership nomination workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an application and sends nomination emails to two verified nominators", async () => {
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "nom-1",
        email: "nominator1@test.com",
        firstName: "Nora",
        lastName: "One",
        subscriptions: [{ id: "sub-1" }],
      } as never)
      .mockResolvedValueOnce({
        id: "nom-2",
        email: "nominator2@test.com",
        firstName: "Noel",
        lastName: "Two",
        subscriptions: [{ id: "sub-2" }],
      } as never);
    vi.mocked(prisma.memberApplication.findFirst).mockResolvedValue(null as never);

    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      member: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      memberApplication: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "app-1",
          applicantFirstName: "Jane",
          applicantLastName: "Doe",
          applicantEmail: "jane@test.com",
          applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
          applicantPhone: "64 21 5551234",
          applicantAddress: null,
          familyMembers: [],
          nominator1Email: "nominator1@test.com",
          nominator2Email: "nominator2@test.com",
          nominator1Id: "nom-1",
          nominator2Id: "nom-2",
          nominator1ConfirmedAt: null,
          nominator2ConfirmedAt: null,
          status: "PENDING_NOMINATORS",
          adminNotes: null,
          reviewedBy: null,
          reviewedAt: null,
          createdAt: new Date("2026-04-12T00:00:00.000Z"),
          updatedAt: new Date("2026-04-12T00:00:00.000Z"),
        }),
      },
      nominationToken: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => callback(tx));

    const result = await createMemberApplication({
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantEmail: "Jane@Test.com",
      applicantDateOfBirth: "1990-05-01",
      phoneCountryCode: "64",
      phoneAreaCode: "21",
      phoneNumber: "5551234",
      address: {
        streetAddressLine1: "42 Lodge Road",
        streetAddressLine2: null,
        streetCity: "Whakapapa",
        streetRegion: "Ruapehu",
        streetPostalCode: "3951",
        streetCountry: "NZ",
        postalAddressLine1: null,
        postalAddressLine2: null,
        postalCity: null,
        postalRegion: null,
        postalPostalCode: null,
        postalCountry: null,
        postalSameAsPhysical: true,
      },
      familyMembers: [
        {
          firstName: "Sam",
          lastName: "Doe",
          dateOfBirth: "2018-06-01",
        },
      ],
      nominator1Email: "nominator1@test.com",
      nominator2Email: "nominator2@test.com",
    });

    expect(tx.memberApplication.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicantEmail: "jane@test.com",
          nominator1Id: "nom-1",
          nominator2Id: "nom-2",
          familyMembers: [
            {
              firstName: "Sam",
              lastName: "Doe",
              dateOfBirth: "2018-06-01",
            },
          ],
        }),
      })
    );
    expect(tx.nominationToken.createMany).toHaveBeenCalledTimes(1);
    const createdTokens = tx.nominationToken.createMany.mock.calls[0][0].data;
    expect(createdTokens).toHaveLength(2);
    expect(createdTokens[0]).not.toHaveProperty("token");
    expect(createdTokens[1]).not.toHaveProperty("token");
    expect(createdTokens[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createdTokens[1].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sendNominationRequestEmail).toHaveBeenCalledTimes(2);
    const sentTokens = vi
      .mocked(sendNominationRequestEmail)
      .mock.calls.map(([args]) => args.token);
    expect(createdTokens.map((tokenRow: { tokenHash: string }) => tokenRow.tokenHash)).toEqual(
      sentTokens.map(hashActionToken)
    );
    expect(result.application.id).toBe("app-1");
    expect(result.emailWarnings).toEqual([]);
  });

  it("rejects applications without an applicant date of birth", async () => {
    await expect(
      createMemberApplication({
        applicantFirstName: "Jane",
        applicantLastName: "Doe",
        applicantEmail: "jane@test.com",
        applicantDateOfBirth: null,
        phoneCountryCode: "64",
        phoneAreaCode: "21",
        phoneNumber: "5551234",
        address: {
          streetAddressLine1: "42 Lodge Road",
          streetAddressLine2: null,
          streetCity: "Whakapapa",
          streetRegion: "Ruapehu",
          streetPostalCode: "3951",
          streetCountry: "NZ",
          postalAddressLine1: null,
          postalAddressLine2: null,
          postalCity: null,
          postalRegion: null,
          postalPostalCode: null,
          postalCountry: null,
          postalSameAsPhysical: true,
        },
        familyMembers: [],
        nominator1Email: "nominator1@test.com",
        nominator2Email: "nominator2@test.com",
      })
    ).rejects.toMatchObject({
      message: "Applicant date of birth is required",
      status: 422,
    });
  });

  it("rechecks for pending duplicate applications after locking the applicant email", async () => {
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "nom-1",
        email: "nominator1@test.com",
        firstName: "Nora",
        lastName: "One",
        subscriptions: [{ id: "sub-1" }],
      } as never)
      .mockResolvedValueOnce({
        id: "nom-2",
        email: "nominator2@test.com",
        firstName: "Noel",
        lastName: "Two",
        subscriptions: [{ id: "sub-2" }],
      } as never);
    vi.mocked(prisma.memberApplication.findFirst).mockResolvedValue(null as never);

    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      member: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      memberApplication: {
        findFirst: vi.fn().mockResolvedValue({ id: "app-existing" }),
        create: vi.fn(),
      },
      nominationToken: {
        createMany: vi.fn(),
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => callback(tx));

    await expect(
      createMemberApplication({
        applicantFirstName: "Jane",
        applicantLastName: "Doe",
        applicantEmail: "Jane@Test.com",
        applicantDateOfBirth: "1990-05-01",
        phoneCountryCode: "64",
        phoneAreaCode: "21",
        phoneNumber: "5551234",
        address: {
          streetAddressLine1: "42 Lodge Road",
          streetAddressLine2: null,
          streetCity: "Whakapapa",
          streetRegion: "Ruapehu",
          streetPostalCode: "3951",
          streetCountry: "NZ",
          postalAddressLine1: null,
          postalAddressLine2: null,
          postalCity: null,
          postalRegion: null,
          postalPostalCode: null,
          postalCountry: null,
          postalSameAsPhysical: true,
        },
        familyMembers: [],
        nominator1Email: "nominator1@test.com",
        nominator2Email: "nominator2@test.com",
      })
    ).rejects.toMatchObject({
      message: "There is already a membership application pending for this email address",
      status: 409,
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.memberApplication.create).not.toHaveBeenCalled();
    expect(sendNominationRequestEmail).not.toHaveBeenCalled();
  });

  it("moves the application to pending admin when the second nominator confirms", async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const application = {
      id: "app-1",
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantEmail: "jane@test.com",
      applicantDateOfBirth: null,
      applicantPhone: null,
      applicantAddress: null,
      familyMembers: [{ firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" }],
      nominator1Email: "nominator1@test.com",
      nominator2Email: "nominator2@test.com",
      nominator1Id: "nom-1",
      nominator2Id: "nom-2",
      nominator1ConfirmedAt: new Date("2026-04-12T01:00:00.000Z"),
      nominator2ConfirmedAt: null,
      status: "PENDING_NOMINATORS",
      adminNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
      updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    };

    vi.mocked(prisma.nominationToken.findUnique).mockResolvedValueOnce({
      id: "token-row",
      tokenHash: hashActionToken("token-2"),
      applicationId: "app-1",
      nominatorMemberId: "nom-2",
      expiresAt: futureExpiry,
      confirmedAt: null,
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
      application,
    } as never);

    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      nominationToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: "token-row",
          tokenHash: hashActionToken("token-2"),
          applicationId: "app-1",
          nominatorMemberId: "nom-2",
          expiresAt: futureExpiry,
          confirmedAt: null,
          createdAt: new Date("2026-04-12T00:00:00.000Z"),
          application,
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      memberApplication: {
        update: vi.fn().mockResolvedValue({
          ...application,
          status: "PENDING_ADMIN",
          nominator2ConfirmedAt: new Date("2026-04-12T02:00:00.000Z"),
        }),
      },
    };

    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => callback(tx));

    const result = await confirmNomination("token-2", "nom-2");

    expect(prisma.nominationToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashActionToken("token-2") },
      })
    );
    expect(tx.nominationToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashActionToken("token-2") },
      })
    );
    expect(tx.nominationToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          confirmedAt: expect.any(Date),
        }),
      })
    );
    expect(tx.memberApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PENDING_ADMIN",
          nominator2ConfirmedAt: expect.any(Date),
        }),
      })
    );
    expect(sendAdminMembershipApplicationPendingEmail).toHaveBeenCalledTimes(1);
    expect(result.movedToAdmin).toBe(true);
    expect(result.application.status).toBe("PENDING_ADMIN");
  });

  it("rejects a nomination token for a different nominator account", async () => {
    vi.mocked(prisma.nominationToken.findUnique).mockResolvedValueOnce({
      id: "token-row",
      tokenHash: hashActionToken("token-2"),
      applicationId: "app-1",
      nominatorMemberId: "nom-2",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      confirmedAt: null,
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
      application: { status: "PENDING_NOMINATORS" },
    } as never);

    await expect(confirmNomination("token-2", "nom-1")).rejects.toMatchObject({
      message: "This nomination link is for a different member",
      status: 403,
    });
    expect(prisma.nominationToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashActionToken("token-2") },
      })
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an expired nomination token after hashed lookup", async () => {
    vi.mocked(prisma.nominationToken.findUnique).mockResolvedValueOnce({
      id: "token-row",
      tokenHash: hashActionToken("token-2"),
      applicationId: "app-1",
      nominatorMemberId: "nom-2",
      expiresAt: new Date(Date.now() - 60 * 1000),
      confirmedAt: null,
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
      application: { status: "PENDING_NOMINATORS" },
    } as never);

    await expect(confirmNomination("token-2", "nom-2")).rejects.toMatchObject({
      message: "This nomination link has expired",
      status: 410,
    });
    expect(prisma.nominationToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashActionToken("token-2") },
      })
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("approves the application, creates members, and triggers account setup + Xero actions", async () => {
    vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue({
      id: "app-1",
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantEmail: "jane@test.com",
      applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
      applicantPhone: "64 21 5551234",
      applicantAddress: {
        streetAddressLine1: "42 Lodge Road",
        streetAddressLine2: null,
        streetCity: "Whakapapa",
        streetRegion: "Ruapehu",
        streetPostalCode: "3951",
        streetCountry: "NZ",
        postalAddressLine1: "42 Lodge Road",
        postalAddressLine2: null,
        postalCity: "Whakapapa",
        postalRegion: "Ruapehu",
        postalPostalCode: "3951",
        postalCountry: "NZ",
        postalSameAsPhysical: true,
      },
      familyMembers: [
        {
          firstName: "Sam",
          lastName: "Doe",
          dateOfBirth: "2018-06-01",
        },
      ],
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
    } as never);

    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      member: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi
          .fn()
          .mockResolvedValueOnce({
            id: "member-1",
            email: "jane@test.com",
            firstName: "Jane",
            lastName: "Doe",
          })
          .mockResolvedValueOnce({
            id: "member-2",
          }),
        update: vi.fn().mockResolvedValue({ id: "member-1" }),
      },
      familyGroup: {
        create: vi.fn().mockResolvedValue({ id: "fg-1" }),
      },
      familyGroupMember: {
        create: vi.fn().mockResolvedValue(undefined),
      },
      passwordResetToken: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
      },
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue({
          id: "app-1",
          applicantFirstName: "Jane",
          applicantLastName: "Doe",
          applicantEmail: "jane@test.com",
          applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
          applicantPhone: "64 21 5551234",
          applicantAddress: {
            streetAddressLine1: "42 Lodge Road",
            streetAddressLine2: null,
            streetCity: "Whakapapa",
            streetRegion: "Ruapehu",
            streetPostalCode: "3951",
            streetCountry: "NZ",
            postalAddressLine1: "42 Lodge Road",
            postalAddressLine2: null,
            postalCity: "Whakapapa",
            postalRegion: "Ruapehu",
            postalPostalCode: "3951",
            postalCountry: "NZ",
            postalSameAsPhysical: true,
          },
          familyMembers: [
            {
              firstName: "Sam",
              lastName: "Doe",
              dateOfBirth: "2018-06-01",
            },
          ],
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
        }),
        update: vi.fn().mockResolvedValue({
          id: "app-1",
          status: "APPROVED",
        }),
      },
    };

    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => callback(tx));

    const result = await approveMemberApplication("app-1", "admin-1", "Welcome aboard");

    expect(tx.member.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          email: "jane@test.com",
          canLogin: true,
          emailVerified: true,
          profileCompletedAt: expect.any(Date),
          detailsConfirmedAt: expect.any(Date),
          onboardingConfirmedAt: expect.any(Date),
        }),
      })
    );
    expect(tx.member.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          email: "jane@test.com",
          canLogin: false,
          parentMemberId: "member-1",
          inheritEmailFromId: "member-1",
          phoneCountryCode: "64",
          phoneAreaCode: "21",
          phoneNumber: "5551234",
          profileCompletedAt: expect.any(Date),
          detailsConfirmedAt: expect.any(Date),
          detailsConfirmedByMemberId: "member-1",
          onboardingConfirmedAt: expect.any(Date),
        }),
      })
    );
    expect(tx.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: {
        detailsConfirmedByMemberId: "member-1",
      },
    });

    const applicantData = tx.member.create.mock.calls[0][0].data;
    const dependentData = tx.member.create.mock.calls[1][0].data;
    expect(dependentData.profileCompletedAt).toBe(applicantData.profileCompletedAt);
    expect(dependentData.detailsConfirmedAt).toBe(applicantData.detailsConfirmedAt);
    expect(dependentData.onboardingConfirmedAt).toBe(applicantData.onboardingConfirmedAt);

    const bookingDb = {
      familyGroupMember: {
        findMany: vi.fn().mockResolvedValue([
          { memberId: "member-1", familyGroupId: "fg-1" },
          { memberId: "member-2", familyGroupId: "fg-1" },
        ]),
      },
      member: {
        findMany: vi.fn().mockResolvedValue([
          { id: "member-1", active: true, canLogin: true, ageTier: "ADULT" },
        ]),
      },
    };
    const linkedMembers = new Map<string, LinkedBookingMember>([
      [
        "member-1",
        {
          ...applicantData,
          id: "member-1",
          active: true,
          canLogin: true,
          detailsConfirmedByMemberId: "member-1",
        } as LinkedBookingMember,
      ],
      [
        "member-2",
        {
          ...dependentData,
          id: "member-2",
          active: true,
          canLogin: false,
        } as LinkedBookingMember,
      ],
    ]);

    await expect(
      assertLinkedBookingMembersCanBeBooked(
        bookingDb as Parameters<typeof assertLinkedBookingMembersCanBeBooked>[0],
        linkedMembers,
        "member-1"
      )
    ).resolves.toBeUndefined();
    expect(findOrCreateXeroContact).toHaveBeenCalledTimes(2);
    expect(enqueueXeroEntranceFeeInvoiceOperation).toHaveBeenCalledWith("member-1", {
      createdByMemberId: "admin-1",
    });
    expect(sendMembershipApplicationApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "jane@test.com",
        firstName: "Jane",
        adminNotes: "Welcome aboard",
      })
    );
    expect(result.warnings).toEqual([]);
  });

  it("blocks approval of legacy applications that are missing the applicant date of birth", async () => {
    vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue({
      id: "app-legacy",
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantEmail: "jane@test.com",
      applicantDateOfBirth: null,
      applicantPhone: "64 21 5551234",
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
    } as never);

    await expect(
      approveMemberApplication("app-legacy", "admin-1", "Need DOB")
    ).rejects.toMatchObject({
      message: "Applicant date of birth is required before approval",
      status: 409,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
