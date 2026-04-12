import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, emailMock, xeroMock } = vi.hoisted(() => ({
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
    createXeroEntranceFeeInvoice: vi.fn().mockResolvedValue("inv-1"),
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
  sendAdminMembershipApplicationPendingEmail,
  sendMembershipApplicationApprovedEmail,
  sendNominationRequestEmail,
} from "@/lib/email";
import {
  createXeroEntranceFeeInvoice,
  findOrCreateXeroContact,
} from "@/lib/xero";

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
      memberApplication: {
        create: vi.fn().mockResolvedValue({
          id: "app-1",
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
    expect(sendNominationRequestEmail).toHaveBeenCalledTimes(2);
    expect(result.application.id).toBe("app-1");
    expect(result.emailWarnings).toEqual([]);
  });

  it("moves the application to pending admin when the second nominator confirms", async () => {
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
      token: "token-2",
      applicationId: "app-1",
      nominatorMemberId: "nom-2",
      expiresAt: new Date("2026-04-19T00:00:00.000Z"),
      confirmedAt: null,
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
      application,
    } as never);

    const tx = {
      nominationToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: "token-row",
          token: "token-2",
          applicationId: "app-1",
          nominatorMemberId: "nom-2",
          expiresAt: new Date("2026-04-19T00:00:00.000Z"),
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
        }),
      })
    );
    expect(findOrCreateXeroContact).toHaveBeenCalledTimes(2);
    expect(createXeroEntranceFeeInvoice).toHaveBeenCalledWith("member-1");
    expect(sendMembershipApplicationApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "jane@test.com",
        firstName: "Jane",
        adminNotes: "Welcome aboard",
      })
    );
    expect(result.warnings).toEqual([]);
  });
});
