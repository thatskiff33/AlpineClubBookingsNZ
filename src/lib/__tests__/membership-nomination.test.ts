import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, emailMock, xeroMock, xeroOutboxMock, subscriptionBillingMock } = vi.hoisted(() => ({
  prismaMock: {
    member: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    memberApplication: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    nominationToken: {
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
    sendInductionSignOffRequestEmail: vi.fn().mockResolvedValue(undefined),
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
  subscriptionBillingMock: {
    queueApprovedMembershipSubscriptionCharges: vi.fn().mockResolvedValue({ chargeIds: ["charge-1"], exceptionCount: 0 }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

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
  confirmNomination,
  createMemberApplication,
  refreshMemberApplicationNominations,
  rejectMemberApplication,
  replaceMemberApplicationNominator,
  sendDueNominationReminders,
} from "@/lib/nomination";
import {
  assertLinkedBookingMembersCanBeBooked,
  type LinkedBookingMember,
} from "@/lib/booking-guests";
import {
  sendAdminMembershipApplicationPendingEmail,
  sendMembershipApplicationApprovedEmail,
  sendMembershipApplicationRejectedEmail,
  sendNominationRequestEmail,
} from "@/lib/email";
import {
  findOrCreateXeroContact,
} from "@/lib/xero";
import {
  enqueueXeroEntranceFeeInvoiceOperation,
} from "@/lib/xero-operation-outbox";
import { logAudit } from "@/lib/audit";
import { hashActionToken } from "@/lib/action-tokens";
import { FAMILY_LINK_GENERATION_LIMIT_ERROR } from "@/lib/member-family-link-depth";

describe("membership nomination workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionBillingMock.queueApprovedMembershipSubscriptionCharges.mockResolvedValue({
      chargeIds: ["charge-1"],
      exceptionCount: 0,
    });
    vi.mocked(prisma.memberApplication.update).mockResolvedValue({} as never);
    vi.mocked(prisma.nominationToken.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.nominationToken.updateMany).mockResolvedValue({
      count: 0,
    } as never);
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
        // #2255: creating a family dependant under the applicant checks the
        // applicant's own ancestry against the four-generation cap. The
        // applicant here is a new member with no parents, so the walk stops
        // immediately.
        findMany: vi.fn().mockResolvedValue([]),
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
    expect(createdTokens[0]).toEqual(
      expect.objectContaining({
        reminderCount: 0,
        lastSentAt: expect.any(Date),
      })
    );
    expect(createdTokens[1]).toEqual(
      expect.objectContaining({
        reminderCount: 0,
        lastSentAt: expect.any(Date),
      })
    );
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
        // #2255: creating a family dependant under the applicant checks the
        // applicant's own ancestry against the four-generation cap. The
        // applicant here is a new member with no parents, so the walk stops
        // immediately.
        findMany: vi.fn().mockResolvedValue([]),
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

  it("rejects a nomination link for a nominator who has been replaced", async () => {
    vi.mocked(prisma.nominationToken.findUnique).mockResolvedValueOnce({
      id: "token-row",
      tokenHash: hashActionToken("old-token"),
      applicationId: "app-1",
      nominatorMemberId: "old-nom",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      confirmedAt: null,
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
      application: {
        id: "app-1",
        nominator1Id: "nom-1",
        nominator2Id: "nom-2",
        nominator1ConfirmedAt: null,
        nominator2ConfirmedAt: null,
        status: "PENDING_NOMINATORS",
      },
    } as never);

    await expect(confirmNomination("old-token", "old-nom")).rejects.toMatchObject({
      message: "This nomination link has been replaced",
      status: 409,
    });
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
        // #2255: the resolved source is validated before it is stored, which
        // reads the source row back on the same client.
        //
        // #2716: this same read now DECIDES the mailbox — the walk up the
        // family is gone, so `resolveInheritedEmailSourceId` reads the chosen
        // parent here and asks `isUsableEmailSource`, which disqualifies anyone
        // with a non-NULL `inheritEmailChoiceId` as well as a non-NULL pointer.
        // The column is part of `EMAIL_SOURCE_SELECT`, so a real row always has
        // it; leaving it off the fixture made it `undefined`, which is not
        // `null`, and the applicant read as somebody else's dependant.
        findUnique: vi.fn(async ({ where }: any) => ({
          id: where.id,
          email: "jane@test.com",
          ageTier: "ADULT",
          archivedAt: null,
          inheritEmailFromId: null,
          inheritEmailChoiceId: null,
        })),
        // #2255: each family dependant created under the applicant is checked
        // against the four-generation cap — a walk UP from the applicant, which
        // #2716 left untouched because the cap governs LINKS, not the address
        // hop. The applicant is created in this same transaction and has no
        // parents, so the walk stops immediately.
        findMany: vi.fn(async ({ where }: any) =>
          where?.id?.in
            ? where.id.in.map((id: string) => ({
                id,
                email: "jane@test.com",
                ageTier: "ADULT",
                archivedAt: null,
                inheritEmailFromId: null,
                parentMemberId: null,
                secondaryParentId: null,
              }))
            : []
        ),
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
          // #2716: the create records WHO WAS CHOSEN beside the mailbox that
          // choice resolves to. One hop means both name the applicant — this
          // dependant's direct parent — and nobody further up.
          inheritEmailChoiceId: "member-1",
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
        bookingDb as unknown as Parameters<typeof assertLinkedBookingMembersCanBeBooked>[0],
        linkedMembers,
        "member-1"
      )
    ).resolves.toBeUndefined();
    expect(findOrCreateXeroContact).toHaveBeenCalledTimes(2);
    // `seasonYear` is REQUIRED alongside `store` (#2870, correctness review): the
    // joining-fee chain under this enqueue would otherwise read the club's zone on
    // the global client while the approval transaction holds the application and
    // member-lifecycle advisory locks, and that season picks the fee amount written
    // onto an immutable invoice. Asserted by value, not `objectContaining`, so a
    // future edit that drops the threading fails here.
    // #3123 adds `asOf` on the same rule and for the same reason: it is the day
    // `getEffectiveJoiningFee` evaluates the schedule window on, it used to be
    // defaulted from the ENVIRONMENT's zone, and it selects the amount that
    // lands on that immutable invoice. It comes from the SAME pre-transaction
    // zone read the season does, so under the frozen clock both are that read's
    // answer for one club day.
    expect(enqueueXeroEntranceFeeInvoiceOperation).toHaveBeenCalledWith("member-1", {
      createdByMemberId: "admin-1",
      seasonYear: 2026,
      asOf: new Date("2026-07-01T00:00:00.000Z"),
      store: tx,
    });
    expect(sendMembershipApplicationApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "jane@test.com",
        firstName: "Jane",
        adminNotes: "Welcome aboard",
      })
    );
    expect(result.warnings).toEqual([]);
    expect(subscriptionBillingMock.queueApprovedMembershipSubscriptionCharges).toHaveBeenCalledWith({
      memberIds: ["member-1", "member-2"],
      approvedByMemberId: "admin-1",
    });
  });

  /**
   * #2255 (M10). Application approval creates family dependants under the
   * applicant, which is a parent-link write, and this path never saw the old
   * rule at all. Nothing exercised the new gate either — the stub above reports
   * "no ancestors", so deleting the guard left the suite green. Here the
   * applicant is MAPPED onto an existing member who already sits three
   * parent-links deep, so their new dependant would be a fifth generation.
   */
  it("refuses creating a family dependant under an applicant who already fills the cap", async () => {
    const deepApplication = {
      id: "app-deep",
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantEmail: "jane@test.com",
      applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
      applicantPhone: "64 21 5551234",
      applicantAddress: null,
      familyMembers: [
        { firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" },
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
    };
    vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue(
      deepApplication as never
    );
    vi.mocked(prisma.memberApplication.findFirst).mockResolvedValue(null as never);

    // gggp -> ggp -> gp -> member-1 (the applicant created below).
    const parentsById: Record<string, string | null> = {
      "member-1": "gp",
      gp: "ggp",
      ggp: "gggp",
      gggp: null,
    };
    const memberCreate = vi
      .fn()
      .mockResolvedValueOnce({
        id: "member-1",
        email: "jane@test.com",
        firstName: "Jane",
        lastName: "Doe",
      });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      member: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(async ({ where }: any) =>
          where?.id?.in
            ? where.id.in.map((id: string) => ({
                id,
                email: `${id}@test.com`,
                ageTier: "ADULT",
                archivedAt: null,
                inheritEmailFromId: null,
                parentMemberId: parentsById[id] ?? null,
                secondaryParentId: null,
              }))
            : []
        ),
        // #2716: `inheritEmailChoiceId` belongs on every fixture standing in
        // for an `EMAIL_SOURCE_SELECT` row. This test's subject is the DEPTH
        // CAP, which fires before the mailbox is resolved, so the omission did
        // not fail it — but it would have made the applicant look like an
        // inheritor, and the 422 could then have come from the inheritance
        // refusal instead of the cap. The assertion below names the cap's own
        // message for the same reason.
        findUnique: vi.fn(async ({ where }: any) => ({
          id: where.id,
          email: `${where.id}@test.com`,
          ageTier: "ADULT",
          archivedAt: null,
          inheritEmailFromId: null,
          inheritEmailChoiceId: null,
        })),
        create: memberCreate,
        update: vi.fn().mockResolvedValue({ id: "member-1" }),
      },
      familyGroup: { create: vi.fn().mockResolvedValue({ id: "fg-1" }) },
      familyGroupMember: { create: vi.fn().mockResolvedValue(undefined) },
      passwordResetToken: { deleteMany: vi.fn(), create: vi.fn() },
      memberApplication: {
        findFirst: vi.fn().mockResolvedValue(null),
        // The re-read INSIDE the transaction: the same row, not a stub of it —
        // the approval re-validates against this copy, so trimming it here
        // would fail the approval for reasons unrelated to the depth cap.
        findUnique: vi.fn().mockResolvedValue(deepApplication),
        update: vi.fn().mockResolvedValue({ id: "app-deep", status: "APPROVED" }),
      },
      xeroOperationOutbox: { create: vi.fn().mockResolvedValue({ id: "op-1" }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback(tx)
    );

    await expect(
      approveMemberApplication("app-deep", "admin-1", "Welcome aboard")
    ).rejects.toMatchObject({
      status: 422,
      // #2716: pin the REASON, not just the status. Since the one-hop rule a
      // parent with no usable address is also a 422, so a bare status check
      // would let this test go on passing while the depth cap it exists to
      // prove had stopped firing.
      message: FAMILY_LINK_GENERATION_LIMIT_ERROR,
    });

    // The applicant was created; the fifth-generation dependant was not.
    expect(memberCreate).toHaveBeenCalledTimes(1);
  });

  it("enqueues the entrance-fee outbox row inside the approval transaction and kicks the worker only after commit (#1886, F22)", async () => {
    const application = {
      id: "app-atomic",
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantEmail: "jane@test.com",
      applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
      applicantPhone: "64 21 5551234",
      applicantAddress: null,
      familyMembers: [],
      nominator1Email: "nominator1@test.com",
      nominator2Email: "nominator2@test.com",
      nominator1Id: null,
      nominator2Id: null,
      nominator1ConfirmedAt: new Date("2026-04-12T01:00:00.000Z"),
      nominator2ConfirmedAt: new Date("2026-04-12T02:00:00.000Z"),
      status: "PENDING_ADMIN",
      adminNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
      updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    };
    vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue(
      application as never
    );

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
      familyGroup: { create: vi.fn() },
      familyGroupMember: { create: vi.fn() },
      passwordResetToken: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
      },
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue(application),
        update: vi.fn().mockResolvedValue({ id: "app-atomic", status: "APPROVED" }),
      },
    };

    // Snapshot the mock call counts at the moment the transaction callback
    // finishes — i.e. at the commit point. The durable outbox enqueue must
    // already have happened by then (atomic with the approval), while the
    // worker kick (the live Xero dispatch) must not have.
    let enqueueCallsAtCommit = -1;
    let workerKicksAtCommit = -1;
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
      const result = await callback(tx);
      enqueueCallsAtCommit =
        xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation.mock.calls.length;
      workerKicksAtCommit =
        xeroOutboxMock.processQueuedXeroOutboxOperations.mock.calls.length;
      return result;
    });

    await approveMemberApplication("app-atomic", "admin-1");

    // The outbox row write joins the approval transaction: it is called with
    // the SAME transaction client the approval writes use (store: tx), before
    // the transaction commits — a crash now rolls back approval + fee
    // together instead of committing the approval and losing the fee.
    expect(enqueueXeroEntranceFeeInvoiceOperation).toHaveBeenCalledTimes(1);
    expect(enqueueXeroEntranceFeeInvoiceOperation).toHaveBeenCalledWith(
      "member-1",
      expect.objectContaining({
        createdByMemberId: "admin-1",
        // Resolved BEFORE the transaction opened — see the note on the sibling
        // assertion above.
        seasonYear: 2026,
        store: tx,
      })
    );
    expect(enqueueCallsAtCommit).toBe(1);

    // The worker kick that performs the live Xero call stays post-commit.
    expect(workerKicksAtCommit).toBe(0);
    expect(xeroOutboxMock.processQueuedXeroOutboxOperations).toHaveBeenCalledTimes(1);
  });

  it("persists post-approval side-effect warnings for admin recovery visibility", async () => {
    vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue({
      id: "app-warn",
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantEmail: "jane@test.com",
      applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
      applicantPhone: "64 21 5551234",
      applicantAddress: null,
      familyMembers: [],
      nominator1Email: "nominator1@test.com",
      nominator2Email: "nominator2@test.com",
      nominator1Id: null,
      nominator2Id: null,
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
        create: vi.fn().mockResolvedValue({
          id: "member-1",
          email: "jane@test.com",
          firstName: "Jane",
          lastName: "Doe",
        }),
        update: vi.fn().mockResolvedValue({ id: "member-1" }),
      },
      familyGroup: {
        create: vi.fn(),
      },
      familyGroupMember: {
        create: vi.fn(),
      },
      passwordResetToken: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
      },
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue({
          id: "app-warn",
          applicantFirstName: "Jane",
          applicantLastName: "Doe",
          applicantEmail: "jane@test.com",
          applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
          applicantPhone: "64 21 5551234",
          applicantAddress: null,
          familyMembers: [],
          nominator1Email: "nominator1@test.com",
          nominator2Email: "nominator2@test.com",
          nominator1Id: null,
          nominator2Id: null,
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
          id: "app-warn",
          status: "APPROVED",
          adminNotes: "Committee approved",
          nominator1Id: null,
          nominator2Id: null,
        }),
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => callback(tx));
    vi.mocked(findOrCreateXeroContact).mockRejectedValue(new Error("xero down"));
    vi.mocked(enqueueXeroEntranceFeeInvoiceOperation).mockRejectedValue(
      new Error("queue down")
    );
    vi.mocked(sendMembershipApplicationApprovedEmail).mockRejectedValue(
      new Error("smtp down")
    );
    subscriptionBillingMock.queueApprovedMembershipSubscriptionCharges.mockResolvedValue({
      chargeIds: [],
      exceptionCount: 1,
    });

    const result = await approveMemberApplication(
      "app-warn",
      "admin-1",
      "Committee approved"
    );

    expect(result.warnings).toEqual([
      "Xero contact sync failed for member member-1",
      "1 membership subscription billing exception requires Finance review",
      "Joining fee invoice could not be queued automatically",
      "The approval email could not be sent automatically",
    ]);
    expect(prisma.memberApplication.update).toHaveBeenCalledWith({
      where: { id: "app-warn" },
      data: {
        adminNotes:
          "Committee approved\n\nPost-approval follow-up warnings:\n- Xero contact sync failed for member member-1\n- 1 membership subscription billing exception requires Finance review\n- Joining fee invoice could not be queued automatically\n- The approval email could not be sent automatically",
      },
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MEMBERSHIP_APPLICATION_APPROVED",
        details: JSON.stringify({
          applicantMemberId: "member-1",
          createdMemberCount: 1,
          postApprovalWarnings: result.warnings,
        }),
      })
    );

    subscriptionBillingMock.queueApprovedMembershipSubscriptionCharges.mockRejectedValue(
      new Error("billing queue down")
    );
    const retryResult = await approveMemberApplication(
      "app-warn",
      "admin-1",
      "Committee approved"
    );
    expect(retryResult.application.status).toBe("APPROVED");
    expect(retryResult.warnings).toContain(
      "Membership subscription billing could not be queued automatically"
    );
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

  it("sends weekly nomination reminders with a fresh one-week link", async () => {
    const now = new Date("2026-06-08T08:15:00.000Z");
    const application = {
      id: "app-reminder",
      applicantFirstName: "Rae",
      applicantLastName: "Applicant",
      applicantEmail: "rae@test.com",
      familyMembers: [],
      nominator1Id: "nom-1",
      nominator2Id: "nom-2",
      nominator1ConfirmedAt: null,
      nominator2ConfirmedAt: null,
      status: "PENDING_NOMINATORS",
    };
    vi.mocked(prisma.nominationToken.findMany).mockResolvedValue([
      {
        id: "token-1",
        tokenHash: "old-hash",
        applicationId: "app-reminder",
        nominatorMemberId: "nom-1",
        expiresAt: new Date("2026-06-08T00:00:00.000Z"),
        confirmedAt: null,
        reminderCount: 2,
        lastSentAt: new Date("2026-06-01T00:00:00.000Z"),
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        application,
      },
    ] as never);
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        id: "nom-1",
        email: "nom1@test.com",
        firstName: "Nora",
        lastName: "One",
      },
    ] as never);
    vi.mocked(prisma.nominationToken.updateMany).mockResolvedValue({
      count: 1,
    } as never);

    const result = await sendDueNominationReminders({ now });

    expect(result).toEqual({ scanned: 1, sent: 1, skipped: 0, failed: 0 });
    expect(prisma.nominationToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "token-1",
          reminderCount: 2,
        }),
        data: expect.objectContaining({
          expiresAt: new Date("2026-06-15T08:15:00.000Z"),
          reminderCount: { increment: 1 },
          lastSentAt: now,
        }),
      })
    );
    expect(sendNominationRequestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "nom1@test.com",
        applicantName: "Rae Applicant",
        expiresAt: new Date("2026-06-15T08:15:00.000Z"),
      })
    );
  });

  it("does not send automatic reminders after the fourth reminder", async () => {
    await sendDueNominationReminders({
      now: new Date("2026-06-08T08:15:00.000Z"),
    });

    expect(prisma.nominationToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reminderCount: { lt: 4 },
        }),
      })
    );
    expect(sendNominationRequestEmail).not.toHaveBeenCalled();
  });

  it("lets an admin refresh pending nomination workflow links and reset reminder counts", async () => {
    const application = {
      id: "app-refresh",
      applicantFirstName: "Refresh",
      applicantLastName: "Applicant",
      applicantEmail: "refresh@test.com",
      familyMembers: [],
      nominator1Email: "nom1@test.com",
      nominator2Email: "nom2@test.com",
      nominator1Id: "nom-1",
      nominator2Id: "nom-2",
      nominator1ConfirmedAt: new Date("2026-06-01T00:00:00.000Z"),
      nominator2ConfirmedAt: null,
      status: "PENDING_NOMINATORS",
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue(application),
      },
      member: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "nom-2",
            email: "nom2@test.com",
            firstName: "Noel",
            lastName: "Two",
          },
        ]),
      },
      nominationToken: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ id: "new-token" }),
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback(tx)
    );

    const result = await refreshMemberApplicationNominations(
      "app-refresh",
      "admin-1"
    );

    expect(result.refreshedCount).toBe(1);
    expect(tx.nominationToken.deleteMany).toHaveBeenCalledWith({
      where: {
        applicationId: "app-refresh",
        nominatorMemberId: "nom-2",
        confirmedAt: null,
      },
    });
    expect(tx.nominationToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationId: "app-refresh",
          nominatorMemberId: "nom-2",
          reminderCount: 0,
          lastSentAt: expect.any(Date),
        }),
      })
    );
    expect(sendNominationRequestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "nom2@test.com",
        applicantName: "Refresh Applicant",
      })
    );
  });

  it("lets an admin replace an unconfirmed nominator and sends the replacement a fresh link", async () => {
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce({
        id: "nom-3",
        email: "nom3@test.com",
      } as never)
      .mockResolvedValueOnce({
        id: "nom-3",
        email: "nom3@test.com",
        firstName: "Nina",
        lastName: "Three",
        joinedDate: null,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        subscriptions: [{ id: "sub-3" }],
      } as never);
    const application = {
      id: "app-replace",
      applicantFirstName: "Replace",
      applicantLastName: "Applicant",
      applicantEmail: "replace@test.com",
      familyMembers: [],
      nominator1Email: "old@test.com",
      nominator2Email: "nom2@test.com",
      nominator1Id: "old-nom",
      nominator2Id: "nom-2",
      nominator1ConfirmedAt: null,
      nominator2ConfirmedAt: new Date("2026-06-01T00:00:00.000Z"),
      status: "PENDING_NOMINATORS",
    };
    const updatedApplication = {
      ...application,
      nominator1Email: "nom3@test.com",
      nominator1Id: "nom-3",
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue(application),
        update: vi.fn().mockResolvedValue(updatedApplication),
      },
      nominationToken: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ id: "new-token" }),
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback(tx)
    );

    const result = await replaceMemberApplicationNominator({
      applicationId: "app-replace",
      slot: "nominator1",
      replacementMemberId: "nom-3",
      adminMemberId: "admin-1",
    });

    expect(result.replacementNominatorId).toBe("nom-3");
    expect(tx.nominationToken.deleteMany).toHaveBeenCalledWith({
      where: {
        applicationId: "app-replace",
        nominatorMemberId: "old-nom",
        confirmedAt: null,
      },
    });
    expect(tx.memberApplication.update).toHaveBeenCalledWith({
      where: { id: "app-replace" },
      data: {
        nominator1Id: "nom-3",
        nominator1Email: "nom3@test.com",
        nominator1ConfirmedAt: null,
      },
    });
    expect(sendNominationRequestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "nom3@test.com",
        applicantName: "Replace Applicant",
      })
    );
  });

  it("does not let an admin replace a confirmed nominator", async () => {
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce({
        id: "nom-3",
        email: "nom3@test.com",
      } as never)
      .mockResolvedValueOnce({
        id: "nom-3",
        email: "nom3@test.com",
        firstName: "Nina",
        lastName: "Three",
        joinedDate: null,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        subscriptions: [{ id: "sub-3" }],
      } as never);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue({
          id: "app-replace",
          applicantEmail: "replace@test.com",
          nominator1Id: "nom-1",
          nominator2Id: "nom-2",
          nominator1ConfirmedAt: new Date("2026-06-01T00:00:00.000Z"),
          nominator2ConfirmedAt: null,
          status: "PENDING_NOMINATORS",
        }),
      },
      nominationToken: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback(tx)
    );

    await expect(
      replaceMemberApplicationNominator({
        applicationId: "app-replace",
        slot: "nominator1",
        replacementMemberId: "nom-3",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({
      message: "Confirmed nominators cannot be replaced",
      status: 409,
    });
    expect(tx.nominationToken.deleteMany).not.toHaveBeenCalled();
  });

  // Issue #817: a PENDING_NOMINATORS application whose nomination tokens have
  // expired must be recoverable. An admin reject sets REJECTED, which the
  // duplicate-application check excludes, so a fresh application can be filed.
  it("lets an admin reject a stuck PENDING_NOMINATORS application", async () => {
    vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue({
      id: "app-nom",
      applicantEmail: "stuck@test.com",
      applicantFirstName: "Stuck",
      status: "PENDING_NOMINATORS",
    } as never);

    const txUpdate = vi.fn().mockResolvedValue({
      id: "app-nom",
      applicantEmail: "stuck@test.com",
      applicantFirstName: "Stuck",
      status: "REJECTED",
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue({
          id: "app-nom",
          applicantEmail: "stuck@test.com",
          applicantFirstName: "Stuck",
          status: "PENDING_NOMINATORS",
        }),
        update: txUpdate,
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: any) => callback(tx)
    );

    const result = await rejectMemberApplication(
      "app-nom",
      "admin-1",
      "Nomination window lapsed"
    );

    expect(result.status).toBe("REJECTED");
    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "app-nom" },
        data: expect.objectContaining({ status: "REJECTED" }),
      })
    );
    expect(sendMembershipApplicationRejectedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "stuck@test.com" })
    );
  });

  it("refuses to reject an application that is already approved", async () => {
    vi.mocked(prisma.memberApplication.findUnique).mockResolvedValue({
      id: "app-approved",
      applicantEmail: "done@test.com",
      status: "APPROVED",
    } as never);

    await expect(
      rejectMemberApplication("app-approved", "admin-1")
    ).rejects.toMatchObject({
      message: "Only pending applications can be rejected",
      status: 409,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
