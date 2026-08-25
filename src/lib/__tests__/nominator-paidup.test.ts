import { beforeEach, describe, expect, it, vi } from "vitest";

// E14 (#1944), Part 1: verifyNominator honours membership-type NOT_REQUIRED.
// These tests drive createMemberApplication (the only public caller of the
// private verifyNominator) and assert the paid-up decision aligns with the
// booking side while the identity gates and error copy stay unchanged.

const { prismaMock, emailMock, xeroMock, xeroOutboxMock, subscriptionBillingMock, policyMock, eligibilityMock } =
  vi.hoisted(() => ({
    prismaMock: {
      member: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      memberApplication: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      nominationToken: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: vi.fn(),
    },
    emailMock: {
      sendNominationRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendInductionSignOffRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendAdminMembershipApplicationPendingEmail: vi.fn().mockResolvedValue(undefined),
      sendMembershipApplicationApprovedEmail: vi.fn().mockResolvedValue(undefined),
      sendMembershipApplicationRejectedEmail: vi.fn().mockResolvedValue(undefined),
    },
    xeroMock: {
      isXeroConnected: vi.fn().mockResolvedValue(false),
      findOrCreateXeroContact: vi.fn().mockResolvedValue("xc-1"),
    },
    xeroOutboxMock: {
      enqueueXeroEntranceFeeInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: null, message: "" }),
      processQueuedXeroOutboxOperations: vi.fn().mockResolvedValue({}),
    },
    subscriptionBillingMock: {
      queueApprovedMembershipSubscriptionCharges: vi.fn().mockResolvedValue({ chargeIds: [], exceptionCount: 0 }),
    },
    policyMock: {
      resolveMembershipTypePolicyForMember: vi.fn(),
    },
    eligibilityMock: {
      checkNominatorEligibility: vi.fn().mockResolvedValue({ eligible: true, reasons: [] }),
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
vi.mock("@/lib/membership-type-policy", () => policyMock);
vi.mock("@/lib/nominator-eligibility", () => eligibilityMock);
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/induction", () => ({ createMemberInduction: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed-secret") }));

import { prisma } from "@/lib/prisma";
import { resolveMembershipTypePolicyForMember } from "@/lib/membership-type-policy";
import { createMemberApplication } from "@/lib/nomination";

const baseInput = {
  applicantFirstName: "Jane",
  applicantLastName: "Doe",
  applicantEmail: "jane@test.com",
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
  familyMembers: [] as { firstName: string; lastName: string; dateOfBirth: string }[],
  nominator1Email: "nominator1@test.com",
  nominator2Email: "nominator2@test.com",
};

function policyFor(behavior: "REQUIRED" | "NOT_REQUIRED") {
  return {
    subscriptionBehavior: behavior,
    membershipType: { key: "life", name: "Life" },
  } as never;
}

function mockTransaction() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    member: { findFirst: vi.fn().mockResolvedValue(null) },
    memberApplication: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "app-1",
        applicantFirstName: "Jane",
        applicantLastName: "Doe",
        applicantEmail: "jane@test.com",
        familyMembers: [],
        nominator1Id: "nom-1",
        nominator2Id: "nom-2",
      }),
    },
    nominationToken: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx));
  return tx;
}

describe("verifyNominator paid-up semantics (#1944)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.member.findMany.mockResolvedValue([]);
    prismaMock.memberApplication.findFirst.mockResolvedValue(null);
    eligibilityMock.checkNominatorEligibility.mockResolvedValue({ eligible: true, reasons: [] });
  });

  it("accepts a NOT_REQUIRED-type (Life) nominator with no PAID subscription", async () => {
    // applicant-existence check → null, then two nominators, both with NO
    // current-season PAID subscription row.
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "nom-1", email: "nominator1@test.com", firstName: "Nora", lastName: "One",
        joinedDate: null, createdAt: new Date("2020-01-01"), subscriptions: [],
      } as never)
      .mockResolvedValueOnce({
        id: "nom-2", email: "nominator2@test.com", firstName: "Noel", lastName: "Two",
        joinedDate: null, createdAt: new Date("2020-01-01"), subscriptions: [],
      } as never);
    vi.mocked(resolveMembershipTypePolicyForMember).mockResolvedValue(policyFor("NOT_REQUIRED"));
    const tx = mockTransaction();

    const result = await createMemberApplication({ ...baseInput });

    expect(result.application.id).toBe("app-1");
    expect(tx.memberApplication.create).toHaveBeenCalledTimes(1);
  });

  it("accepts a REQUIRED-type nominator that has a PAID subscription (regression)", async () => {
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "nom-1", email: "nominator1@test.com", firstName: "Nora", lastName: "One",
        joinedDate: null, createdAt: new Date("2020-01-01"), subscriptions: [{ id: "sub-1" }],
      } as never)
      .mockResolvedValueOnce({
        id: "nom-2", email: "nominator2@test.com", firstName: "Noel", lastName: "Two",
        joinedDate: null, createdAt: new Date("2020-01-01"), subscriptions: [{ id: "sub-2" }],
      } as never);
    vi.mocked(resolveMembershipTypePolicyForMember).mockResolvedValue(policyFor("REQUIRED"));
    const tx = mockTransaction();

    const result = await createMemberApplication({ ...baseInput });

    expect(result.application.id).toBe("app-1");
    expect(tx.memberApplication.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a REQUIRED-type nominator with no PAID subscription, error copy unchanged", async () => {
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "nom-1", email: "nominator1@test.com", firstName: "Nora", lastName: "One",
        joinedDate: null, createdAt: new Date("2020-01-01"), subscriptions: [],
      } as never)
      .mockResolvedValueOnce({
        id: "nom-2", email: "nominator2@test.com", firstName: "Noel", lastName: "Two",
        joinedDate: null, createdAt: new Date("2020-01-01"), subscriptions: [],
      } as never);
    vi.mocked(resolveMembershipTypePolicyForMember).mockResolvedValue(policyFor("REQUIRED"));

    await expect(createMemberApplication({ ...baseInput })).rejects.toMatchObject({
      message: expect.stringMatching(
        /^nominator1@test\.com is not an active, paid-up .+ member$/,
      ),
      status: 422,
    });
  });

  it("rejects an inactive / non-login candidate regardless of NOT_REQUIRED policy", async () => {
    // The active/canLogin/role gates live in the findFirst WHERE clause, so an
    // ineligible identity resolves to null and is rejected before the policy is
    // ever consulted — even when the membership type would be NOT_REQUIRED.
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce(null) // applicant existence check
      .mockResolvedValueOnce(null); // nominator1 filtered out by identity gates
    vi.mocked(resolveMembershipTypePolicyForMember).mockResolvedValue(policyFor("NOT_REQUIRED"));

    await expect(createMemberApplication({ ...baseInput })).rejects.toMatchObject({
      message: expect.stringMatching(
        /^nominator1@test\.com is not an active, paid-up .+ member$/,
      ),
      status: 422,
    });
    expect(resolveMembershipTypePolicyForMember).not.toHaveBeenCalled();
  });
});
