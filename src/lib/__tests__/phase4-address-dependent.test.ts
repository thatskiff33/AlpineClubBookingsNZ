/**
 * Phase 4: Member Address & Dependent Management tests
 *
 * Tests:
 * - Registration with address fields
 * - postalSameAsPhysical on registration, profile, admin edit
 * - Dependent creation via admin API
 * - Dependents returned in member detail
 * - member-address.ts utility functions
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ──

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    accessRoleDefinition: {
      // Empty definitions: resolution falls back to legacy bundles.
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      // #2255: creating a member under a parent now walks the parent's own
      // family chain to check the four-generation cap. Defaulted to "no rows"
      // so a fixture that says nothing about ancestry means exactly that,
      // rather than crashing the walk on an undefined result.
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      create: vi.fn(),
    },
    booking: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]), aggregate: vi.fn().mockResolvedValue({ _sum: { finalPriceCents: 0 }, _count: 0, _max: { checkOut: null } }) },
    bookingGuest: { count: vi.fn().mockResolvedValue(0) },
    payment: { count: vi.fn().mockResolvedValue(0) },
    paymentRefund: { count: vi.fn().mockResolvedValue(0) },
    paymentRecoveryOperation: { count: vi.fn().mockResolvedValue(0) },
    memberCredit: { count: vi.fn().mockResolvedValue(0) },
    adminCreditAdjustmentRequest: { count: vi.fn().mockResolvedValue(0) },
    refundRequest: { count: vi.fn().mockResolvedValue(0) },
    memberSubscription: { count: vi.fn().mockResolvedValue(0) },
    membershipSubscriptionCharge: { count: vi.fn().mockResolvedValue(0) },
    membershipSubscriptionBillingSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    promoCodeAssignment: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    promoRedemption: { count: vi.fn().mockResolvedValue(0) },
    nominationToken: { count: vi.fn().mockResolvedValue(0) },
    memberApplication: { count: vi.fn().mockResolvedValue(0) },
    membershipCancellationRequest: { count: vi.fn().mockResolvedValue(0) },
    membershipCancellationRequestParticipant: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
    familyGroupJoinRequest: { count: vi.fn().mockResolvedValue(0) },
    familyGroup: { findMany: vi.fn().mockResolvedValue([]) },
    familyGroupMember: { count: vi.fn().mockResolvedValue(0), createMany: vi.fn() },
    hutLeaderAssignment: { count: vi.fn().mockResolvedValue(0) },
    issueReport: { count: vi.fn().mockResolvedValue(0) },
    bookingModification: { count: vi.fn().mockResolvedValue(0) },
    bookingChangeRequest: { count: vi.fn().mockResolvedValue(0) },
    deletionRequest: { count: vi.fn().mockResolvedValue(0) },
    memberLifecycleActionRequest: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) },
    passwordResetToken: { create: vi.fn() },
    $transaction: vi.fn().mockImplementation((operation: unknown) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return (operation as (tx: unknown) => Promise<unknown>)({
        member: {
          create: vi.fn().mockResolvedValue({ id: "dep1", firstName: "Child", lastName: "Smith" }),
          // #2716: a member write re-resolves email inheritance inside its own
          // transaction, reading the subjects and then their chosen sources
          // with `findMany`; no rows, so nothing is re-pointed.
          findMany: vi.fn().mockResolvedValue([]),
        },
        familyGroupMember: { createMany: vi.fn() },
      });
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  getXeroContactGroupMemberships: vi.fn().mockResolvedValue({}),
  createXeroEntranceFeeInvoice: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: vi.fn().mockResolvedValue({
    queueOperationId: null,
    message: "not queued",
  }),
  processQueuedXeroOutboxOperations: vi.fn().mockResolvedValue({
    found: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  }),
}));
vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: vi.fn().mockReturnValue({ handled: true }),
}));
vi.mock("@/lib/email", () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/verification-tokens", () => ({
  createEmailVerificationToken: vi.fn().mockResolvedValue("token123"),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { register: {} },
}));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashedpw") },
  hash: vi.fn().mockResolvedValue("hashedpw"),
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn().mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  }),
}));
vi.mock("@/lib/prisma-errors", () => ({
  isPrismaUniqueConstraintError: vi.fn().mockImplementation((err: unknown) => {
    return (err as Record<string, unknown>)?.code === "P2002";
  }),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { POST as register } from "@/app/api/auth/register/route";
import { PUT as updateProfile } from "@/app/api/profile/route";
import { POST as createMember } from "@/app/api/admin/members/route";
import { GET as getMemberDetail, PUT as updateMember } from "@/app/api/admin/members/[id]/route";
import {
  copyStreetAddressToPostal,
  postalMatchesPhysical,
  shouldDefaultPostalSameAsPhysical,
  withDefaultNzCountry,
  normalizeAddressValue,
  NZ_COUNTRY_NAME,
} from "@/lib/member-address";
import { DEPENDENT_PARENT_CREATE_ERRORS } from "@/lib/dependent-link-eligibility";
import { NO_INHERITABLE_EMAIL_SOURCE_MESSAGE } from "@/lib/member-parent-links";

const adminSession = { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;
const memberSession = { user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any;

const baseMember = {
  id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
  phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115",
  dateOfBirth: new Date("1990-01-15"), role: "MEMBER", ageTier: "ADULT",
  active: true, forcePasswordChange: false, xeroContactId: null,
  joinedDate: null, createdAt: new Date("2025-01-01"), canLogin: true,
  profileCompletedAt: null,
  parentMemberId: null, parent: null, inheritParentEmail: false, inheritEmailFromId: null,
  streetAddressLine1: "123 Main St", streetAddressLine2: null,
  streetCity: "Example", streetRegion: "Waikato",
  streetPostalCode: "3420", streetCountry: "NZ",
  postalAddressLine1: "PO Box 42", postalAddressLine2: null,
  postalCity: "Example", postalRegion: "Waikato",
  postalPostalCode: "3420", postalCountry: "NZ",
  familyGroupMemberships: [],
  subscriptions: [],
  dependents: [],
};

function mockDefaultTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation(async (operation: any) => {
    if (Array.isArray(operation)) {
      return Promise.all(operation);
    }

    return operation({
      member: {
        create: vi.fn().mockResolvedValue({ id: "dep1", firstName: "Child", lastName: "Smith" }),
        update: prisma.member.update,
        // #2716: an address edit can add, change or REMOVE the mailbox other
        // members inherit, so the write re-resolves inheritance inside its own
        // transaction — the member's own pointer, then everyone who inherits
        // from them. Its own `findMany` rather than the outer one: the outer
        // mock answers the family-link walk these fixtures set up, and the
        // transaction's question is a different one with no rows here.
        findMany: vi.fn().mockResolvedValue([]),
      },
      memberAccessRole: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: prisma.auditLog.create },
      familyGroupMember: { createMany: vi.fn() },
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// member-address.ts utility tests
// ─────────────────────────────────────────────────────────────────

describe("member-address utilities", () => {
  it("copyStreetAddressToPostal copies all street fields to postal", () => {
    const result = copyStreetAddressToPostal({
      streetAddressLine1: "123 Main",
      streetAddressLine2: "Unit 4",
      streetCity: "Example",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "NZ",
    });
    expect(result).toEqual({
      postalAddressLine1: "123 Main",
      postalAddressLine2: "Unit 4",
      postalCity: "Example",
      postalRegion: "Waikato",
      postalPostalCode: "3420",
      postalCountry: "NZ",
    });
  });

  it("postalMatchesPhysical returns true when all fields match", () => {
    expect(postalMatchesPhysical({
      streetAddressLine1: "123 Main", postalAddressLine1: "123 Main",
      streetAddressLine2: null, postalAddressLine2: null,
      streetCity: "Example", postalCity: "Example",
      streetRegion: "Waikato", postalRegion: "Waikato",
      streetPostalCode: "3420", postalPostalCode: "3420",
      streetCountry: "NZ", postalCountry: "NZ",
    })).toBe(true);
  });

  it("postalMatchesPhysical returns false when fields differ", () => {
    expect(postalMatchesPhysical({
      streetAddressLine1: "123 Main", postalAddressLine1: "PO Box 42",
      streetAddressLine2: null, postalAddressLine2: null,
      streetCity: "Example", postalCity: "Example",
      streetRegion: "Waikato", postalRegion: "Waikato",
      streetPostalCode: "3420", postalPostalCode: "3420",
      streetCountry: "NZ", postalCountry: "NZ",
    })).toBe(false);
  });

  it("postalMatchesPhysical trims whitespace before comparing", () => {
    expect(postalMatchesPhysical({
      streetAddressLine1: "123 Main ", postalAddressLine1: "123 Main",
      streetAddressLine2: "", postalAddressLine2: " ",
      streetCity: "Example", postalCity: "Example",
      streetRegion: "Waikato", postalRegion: "Waikato",
      streetPostalCode: "3420", postalPostalCode: "3420",
      streetCountry: "NZ", postalCountry: "NZ",
    })).toBe(true);
  });

  it("shouldDefaultPostalSameAsPhysical defaults on when postal fields are blank", () => {
    expect(shouldDefaultPostalSameAsPhysical({
      streetAddressLine1: "123 Main",
      streetAddressLine2: null,
      streetCity: "Example",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "NZ",
      postalAddressLine1: null,
      postalAddressLine2: null,
      postalCity: null,
      postalRegion: null,
      postalPostalCode: null,
      postalCountry: null,
    })).toBe(true);
  });

  it("shouldDefaultPostalSameAsPhysical ignores a country-only postal placeholder", () => {
    expect(shouldDefaultPostalSameAsPhysical({
      streetAddressLine1: "",
      streetAddressLine2: "",
      streetCity: "",
      streetRegion: "",
      streetPostalCode: "",
      streetCountry: "New Zealand",
      postalAddressLine1: "",
      postalAddressLine2: "",
      postalCity: "",
      postalRegion: "",
      postalPostalCode: "",
      postalCountry: "New Zealand",
    })).toBe(true);
  });

  it("shouldDefaultPostalSameAsPhysical stays off for a materially different saved postal address", () => {
    expect(shouldDefaultPostalSameAsPhysical({
      streetAddressLine1: "123 Main",
      streetAddressLine2: null,
      streetCity: "Example",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "NZ",
      postalAddressLine1: "PO Box 42",
      postalAddressLine2: null,
      postalCity: "Example",
      postalRegion: "Waikato",
      postalPostalCode: "3420",
      postalCountry: "NZ",
    })).toBe(false);
  });

  it("withDefaultNzCountry returns New Zealand for null/empty", () => {
    expect(withDefaultNzCountry(null)).toBe(NZ_COUNTRY_NAME);
    expect(withDefaultNzCountry("")).toBe(NZ_COUNTRY_NAME);
    expect(withDefaultNzCountry(undefined)).toBe(NZ_COUNTRY_NAME);
  });

  it("withDefaultNzCountry normalizes NZ codes and preserves other countries", () => {
    expect(withDefaultNzCountry("NZ")).toBe("New Zealand");
    expect(withDefaultNzCountry("NZL")).toBe("New Zealand");
    expect(withDefaultNzCountry("Australia")).toBe("Australia");
  });

  it("normalizeAddressValue handles various inputs", () => {
    expect(normalizeAddressValue("  test  ")).toBe("test");
    expect(normalizeAddressValue(null)).toBe("");
    expect(normalizeAddressValue(undefined)).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────
// Legacy self-service registration
// ─────────────────────────────────────────────────────────────────

describe("Legacy registration route", () => {
  it("returns 410 and points applicants to the membership workflow", async () => {
    const res = await register();

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("/join/apply"),
      })
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Profile update with postalSameAsPhysical
// ─────────────────────────────────────────────────────────────────

describe("Profile update with postalSameAsPhysical", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultTransaction();
  });

  function makeProfilePut(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/profile", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("copies street to postal when postalSameAsPhysical is true", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember } as any);

    const res = await updateProfile(makeProfilePut({
      firstName: "Alice", lastName: "Smith",
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "4224115",
      dateOfBirth: "1990-01-15",
      streetAddressLine1: "42 Lodge Rd",
      streetCity: "Whakapapa",
      streetRegion: "Manawatu-Wanganui",
      streetPostalCode: "3951",
      streetCountry: "NZ",
      postalSameAsPhysical: true,
    }));
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        streetAddressLine1: "42 Lodge Rd",
        postalAddressLine1: "42 Lodge Rd",
        postalCity: "Whakapapa",
      }),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────
// Admin: Create dependent member
// ─────────────────────────────────────────────────────────────────

describe("Admin: Create dependent member", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function makePostRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/admin/members", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("creates a dependent with parentMemberId and inheritEmailFromId", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "parent1",
      ageTier: "ADULT",
      active: true,
      archivedAt: null,
    } as any);

    const txMember = { id: "dep1", firstName: "Child", lastName: "Smith", email: "alice@test.com",
      role: "MEMBER", ageTier: "CHILD", active: true, canLogin: false, parentMemberId: "parent1",
      inheritParentEmail: true, inheritEmailFromId: "parent1", xeroContactId: null,
      joinedDate: null, createdAt: new Date(),
      phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115", dateOfBirth: new Date("2020-01-01"),
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        member: { create: vi.fn().mockResolvedValue(txMember) },
        familyGroupMember: { createMany: vi.fn() },
      };
      return cb(tx);
    });

    const res = await createMember(makePostRequest({
      email: "alice@test.com",
      firstName: "Child",
      lastName: "Smith",
      dateOfBirth: "2020-06-15",
      parentMemberId: "parent1",
      inheritParentEmail: true,
      inheritEmailFromId: "parent1",
      canLogin: false,
      streetAddressLine1: "123 Main St",
      streetCity: "Example",
      postalSameAsPhysical: true,
    }));
    expect(res.status).toBe(201);
  });

  // #2255: routed by the id asked for, not by call ORDER. The resolver makes
  // more than one read, and an ordered `mockResolvedValueOnce` chain both
  // answered the wrong question AND leaked its unconsumed entry into the next
  // test, which then silently passed a non-adult parent as an adult.
  function routeMemberReadsById(membersById: Record<string, any>) {
    vi.mocked(prisma.member.findUnique).mockImplementation((async ({
      where,
    }: any) => membersById[where.id] ?? null) as never);
    vi.mocked(prisma.member.findMany).mockImplementation((async ({
      where,
    }: any) =>
      (where?.id?.in ?? [])
        .map((id: string) => membersById[id])
        .filter(Boolean)) as never);
  }

  it("defaults dependent email inheritance to the DIRECT parent", async () => {
    // #2716 (owner decision on #2708, 9 Aug 2026): inheritance is ONE HOP, so
    // the default an admin gets when they tick "inherit the parent's email" is
    // the parent themselves and nobody else.
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    routeMemberReadsById({
      parent1: {
        id: "parent1",
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
        email: "parent@test.com",
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      },
    });

    const txMemberCreate = vi.fn().mockResolvedValue({
      id: "dep2",
      firstName: "Child",
      lastName: "Smith",
      email: "parent@test.com",
      role: "MEMBER",
      ageTier: "CHILD",
      active: true,
      canLogin: false,
      parentMemberId: "parent1",
      inheritParentEmail: true,
      inheritEmailFromId: "parent1",
      xeroContactId: null,
      joinedDate: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        member: { create: txMemberCreate },
        familyGroupMember: { createMany: vi.fn() },
      };
      return cb(tx);
    });

    const res = await createMember(makePostRequest({
      email: "parent@test.com",
      firstName: "Child",
      lastName: "Smith",
      dateOfBirth: "2020-06-15",
      parentMemberId: "parent1",
      inheritParentEmail: true,
      canLogin: false,
    }));

    expect(res.status).toBe(201);
    expect(txMemberCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        inheritEmailFromId: "parent1",
        // #2716: the CHOICE is written beside the pointer on every create.
        // Without it, the first time this parent's address is removed the
        // dependant's pointer clears with no record of who was chosen, and no
        // later address could ever bring it back.
        inheritEmailChoiceId: "parent1",
      }),
    }));
  });

  it("refuses the create when the chosen parent themselves inherits, instead of walking up to their source", async () => {
    // BEHAVIOUR CHANGED (#2716, owner decision on #2708, 9 Aug 2026). This test
    // used to be "defaults to the parent's existing email source": the resolver
    // walked UP the family tree from the chosen parent to the nearest ancestor
    // who could receive mail, so a dependant of `parent1` inherited
    // `lead-adult`'s mailbox. The owner narrowed inheritance to ONE HOP —
    // an address that travels an arbitrary number of hops is unpredictable to
    // the person whose address it is, and a grandparent who supplies an email
    // for one grandchild does not thereby expect mail for a branch of the
    // family they have no involvement with.
    //
    // A parent who is themselves inheriting is therefore not a source at all,
    // and the accepted cost is visible refusal rather than a silent re-route:
    // the admin is told to record an address for the parent. Mutation probe:
    // restore the walk and this create 201s with `inheritEmailFromId:
    // "lead-adult"` again.
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    routeMemberReadsById({
      parent1: {
        id: "parent1",
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
        email: "parent@test.com",
        parentMemberId: "lead-adult",
        secondaryParentId: null,
        inheritEmailFromId: "lead-adult",
        inheritEmailChoiceId: "lead-adult",
      },
      "lead-adult": {
        id: "lead-adult",
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
        email: "lead@test.com",
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      },
    });

    const txMemberCreate = vi.fn();
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        member: { create: txMemberCreate },
        familyGroupMember: { createMany: vi.fn() },
      };
      return cb(tx);
    });

    const res = await createMember(makePostRequest({
      email: "lead@test.com",
      firstName: "Child",
      lastName: "Smith",
      dateOfBirth: "2020-06-15",
      parentMemberId: "parent1",
      inheritParentEmail: true,
      canLogin: false,
    }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(NO_INHERITABLE_EMAIL_SOURCE_MESSAGE);
    expect(txMemberCreate).not.toHaveBeenCalled();
  });

  /**
   * #2282: the CREATE path's half of "parentage is recordable at any age".
   *
   * This describe previously held "rejects dependent creation under non-adult
   * parent". That refusal is the bug the owner decision reverses: a 16 or 17
   * year old can genuinely be a parent, and the club could not record it. What
   * replaces it is a pair of assertions — the record IS created, and the child's
   * club email never lands on the minor.
   *
   * #2716 changed the second half. It used to be "and mail routes to the adult
   * ABOVE the young parent", by walking up the tree; inheritance is now ONE HOP,
   * so a young parent with no usable mailbox of their own leaves the dependant
   * inheriting NOBODY. The pair is therefore now: creating the record still
   * works, and ASKING to inherit is refused in plain words rather than quietly
   * re-routed to a grandparent who never agreed to receive it.
   *
   * Mutation probes: restore `parentMember.ageTier !== "ADULT"` and the first
   * test fails; delete `!parentMember.active` and the inactive test fails;
   * delete `parentMember.archivedAt` and the archived test fails; restore the
   * upward walk in `resolveInheritedEmailSourceId` and the second test 201s
   * with `inheritEmailFromId: "gran1"` instead of refusing.
   */
  const youngParentFamily = () => ({
    youth1: {
      id: "youth1",
      ageTier: "YOUTH",
      active: true,
      archivedAt: null,
      email: "teen-parent@test.com",
      inheritEmailFromId: null,
      inheritEmailChoiceId: null,
      parentMemberId: "gran1",
      secondaryParentId: null,
    },
    gran1: {
      id: "gran1",
      ageTier: "ADULT",
      active: true,
      archivedAt: null,
      email: "gran@test.com",
      inheritEmailFromId: null,
      inheritEmailChoiceId: null,
      parentMemberId: null,
      secondaryParentId: null,
    },
  });

  it("creates a dependant under a YOUNG parent when no inheritance is asked for", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    routeMemberReadsById(youngParentFamily());

    const txMemberCreate = vi.fn().mockResolvedValue({
      id: "dep3",
      firstName: "Baby",
      lastName: "Doe",
      email: "baby@test.com",
      role: "MEMBER",
      ageTier: "INFANT",
      active: true,
      canLogin: false,
      parentMemberId: "youth1",
      inheritParentEmail: false,
      inheritEmailFromId: null,
      xeroContactId: null,
      joinedDate: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) =>
      cb({
        member: { create: txMemberCreate },
        familyGroupMember: { createMany: vi.fn() },
      }),
    );

    const res = await createMember(makePostRequest({
      email: "baby@test.com",
      firstName: "Baby",
      lastName: "Doe",
      dateOfBirth: "2025-06-15",
      parentMemberId: "youth1",
      canLogin: false,
    }));

    expect(res.status).toBe(201);
    expect(txMemberCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        // Recording the parentage is a fact about the family and is allowed at
        // any age; being the club's contact of record is a responsibility and
        // stays adult-gated, so no inheritance is stored either way.
        parentMemberId: "youth1",
        inheritParentEmail: false,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      }),
    }));
  });

  it("refuses to route a dependant's mail past a YOUNG parent to the adult above", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    routeMemberReadsById(youngParentFamily());

    const txMemberCreate = vi.fn();
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) =>
      cb({
        member: { create: txMemberCreate },
        familyGroupMember: { createMany: vi.fn() },
      }),
    );

    const res = await createMember(makePostRequest({
      email: "gran@test.com",
      firstName: "Baby",
      lastName: "Doe",
      dateOfBirth: "2025-06-15",
      parentMemberId: "youth1",
      inheritParentEmail: true,
      canLogin: false,
    }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(NO_INHERITABLE_EMAIL_SOURCE_MESSAGE);
    expect(txMemberCreate).not.toHaveBeenCalled();
  });

  it("rejects dependent creation under an inactive parent", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "lapsed1",
      active: false,
      archivedAt: null,
    } as any);

    const res = await createMember(makePostRequest({
      email: "child@test.com",
      firstName: "Child",
      lastName: "Doe",
      parentMemberId: "lapsed1",
    }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(
      DEPENDENT_PARENT_CREATE_ERRORS.INACTIVE,
    );
  });

  it("rejects dependent creation under an ORGANISATION account, by role", async () => {
    // #2282 review: the removed ADULT clause was the only thing keeping
    // organisations off the parent side. Classified by role, because
    // `NOT_APPLICABLE` is the age-EXEMPT tier and age-exempt PEOPLE carry it
    // too (#1440, #2106) — the tier below is set to prove it is not what the
    // refusal turns on.
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "school1",
      role: "SCHOOL",
      canLogin: true,
      accessRoles: [{ role: "ORG", roleDefinitionId: null }],
      ageTier: "NOT_APPLICABLE",
      active: true,
      archivedAt: null,
    } as any);

    const res = await createMember(makePostRequest({
      email: "child@test.com",
      firstName: "Child",
      lastName: "Doe",
      parentMemberId: "school1",
    }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(
      DEPENDENT_PARENT_CREATE_ERRORS.ORGANISATION,
    );
  });

  it("stores no inheritance when the caller did not ask for it", async () => {
    // #2282 review. `inheritParentEmail: data.inheritParentEmail ??
    // Boolean(data.parentMemberId)` meant a create with a parent and no
    // `inheritParentEmail` key stored `true` beside a NULL source — "inherits
    // from nobody", which `member-lifecycle-actions.ts` documents as a
    // combination no writer produces, and which the age-up cron reads as
    // "mail the parent link directly". This route was the writer producing it.
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "parent1",
      role: "USER",
      canLogin: true,
      accessRoles: [],
      active: true,
      archivedAt: null,
    } as any);
    vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);

    const txMemberCreate = vi.fn().mockResolvedValue({
      id: "dep-no-inherit",
      firstName: "Child",
      lastName: "Doe",
      email: "own@test.com",
      role: "MEMBER",
      ageTier: "CHILD",
      active: true,
      canLogin: false,
      parentMemberId: "parent1",
      inheritParentEmail: false,
      inheritEmailFromId: null,
      xeroContactId: null,
      joinedDate: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) =>
      cb({
        member: { create: txMemberCreate },
        familyGroupMember: { createMany: vi.fn() },
      }),
    );

    const res = await createMember(makePostRequest({
      email: "own@test.com",
      firstName: "Child",
      lastName: "Doe",
      dateOfBirth: "2020-06-15",
      parentMemberId: "parent1",
      canLogin: false,
    }));

    expect(res.status).toBe(201);
    expect(txMemberCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentMemberId: "parent1",
          inheritParentEmail: false,
          inheritEmailFromId: null,
        }),
      }),
    );
  });

  it("rejects dependent creation under an archived parent, and says so", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "archived1",
      active: false,
      archivedAt: new Date("2026-01-01"),
    } as any);

    const res = await createMember(makePostRequest({
      email: "child@test.com",
      firstName: "Child",
      lastName: "Doe",
      parentMemberId: "archived1",
    }));
    expect(res.status).toBe(422);
    // Archiving clears `active` too, so an order-blind check would tell the
    // admin to reactivate a record whose real problem is that it is archived.
    expect((await res.json()).error).toBe(
      DEPENDENT_PARENT_CREATE_ERRORS.ARCHIVED,
    );
  });

  /**
   * #2255 (M10). The gate this pins had no behavioural test at all: every suite
   * stubs the family-link walk to "no ancestors", so deleting the guard left
   * the whole suite green. The fixture below is the smallest one that actually
   * exercises it — a parent who is already three parent-links deep, so the new
   * member would be a fifth generation.
   */
  it("refuses creating a dependant under a parent who already fills the cap", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "parent1",
      ageTier: "ADULT",
      active: true,
      archivedAt: null,
      inheritEmailFromId: null,
    } as any);
    // gggp -> ggp -> gp -> parent1: the walk up from parent1 finds three
    // generations, so parent1 + a new child would be the fifth.
    const parentsById: Record<string, string | null> = {
      parent1: "gp",
      gp: "ggp",
      ggp: "gggp",
      gggp: null,
    };
    vi.mocked(prisma.member.findMany).mockImplementation((async ({
      where,
    }: any) =>
      (where?.id?.in ?? []).map((id: string) => ({
        parentMemberId: parentsById[id] ?? null,
        secondaryParentId: null,
      }))) as never);

    const res = await createMember(makePostRequest({
      email: "fifth@test.com",
      firstName: "Fifth",
      lastName: "Generation",
      dateOfBirth: "2020-06-15",
      parentMemberId: "parent1",
      canLogin: false,
    }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/4 generations/i);
    // The refusal happens before anything is written.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects inheritParentEmail without parentMemberId", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);

    const res = await createMember(makePostRequest({
      email: "child@test.com",
      firstName: "Child",
      lastName: "Doe",
      inheritParentEmail: true,
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("parentMemberId");
  });

  it("rejects inheritEmailFromId pointing to non-adult", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    // First findUnique call is for parentMember, but inheritEmailFromId is separate
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ id: "child2", ageTier: "CHILD" } as any);

    const res = await createMember(makePostRequest({
      email: "kid@test.com",
      firstName: "Kid",
      lastName: "Smith",
      inheritEmailFromId: "child2",
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("adult");
  });

  /**
   * #2255 (D9) replaces the assertion that used to live here: "rejects
   * inheritEmailFromId pointing to a dependent adult", i.e. the source had to be
   * a member with no parents of their own ("must point to a primary adult
   * member").
   *
   * Under a four-generation cap that rule refuses the very source the club
   * needs. A middle generation — an adult who is someone's child AND someone's
   * parent — is routinely the nearest person with a real mailbox, and barring
   * them left the generation below with no reachable contact at all. The rule is
   * gone by owner decision, so the test that pinned it goes too rather than
   * being bent to keep passing. The two guarantees that actually protect
   * delivery are pinned in its place.
   */
  it("accepts an inheritEmailFromId source who is themselves someone's dependant", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult-dependent",
      ageTier: "ADULT",
      email: "middle@test.com",
      archivedAt: null,
      parentMemberId: "primary-adult",
      inheritEmailFromId: null,
    } as any);
    const txMember = {
      id: "kid-1", firstName: "Kid", lastName: "Smith", email: "kid@test.com",
      role: "MEMBER", ageTier: "CHILD", active: true, canLogin: false,
      parentMemberId: null, inheritParentEmail: true,
      inheritEmailFromId: "adult-dependent", xeroContactId: null,
      joinedDate: null, createdAt: new Date(),
      phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115",
      dateOfBirth: new Date("2020-01-01"),
    };
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) =>
      cb({
        member: { create: vi.fn().mockResolvedValue(txMember) },
        familyGroupMember: { createMany: vi.fn() },
      }),
    );

    const res = await createMember(makePostRequest({
      email: "kid@test.com",
      firstName: "Kid",
      lastName: "Smith",
      dateOfBirth: "2020-06-15",
      inheritEmailFromId: "adult-dependent",
      canLogin: false,
      streetAddressLine1: "123 Main St",
      streetCity: "Example",
      postalSameAsPhysical: true,
    }));

    expect(res.status).toBe(201);
  });

  it("still rejects an inheritEmailFromId source who themselves inherits", async () => {
    // Stored inheritance must stay FLAT: `inheritEmailFromId` always points
    // straight at the mailbox, which is what lets every reader keep its single
    // one-hop join and stay correct at any depth.
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "middle-adult",
      ageTier: "ADULT",
      email: "middle@test.com",
      archivedAt: null,
      inheritEmailFromId: "grandparent-1",
    } as any);

    const res = await createMember(makePostRequest({
      email: "kid@test.com",
      firstName: "Kid",
      lastName: "Smith",
      inheritEmailFromId: "middle-adult",
    }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("chain through another");
  });

  it("rejects an inheritEmailFromId source with a walk-in placeholder address", async () => {
    // #2255: with the structural "no parents" clause gone, nothing else implied
    // the address was deliverable. A `@no-email.invalid` placeholder (#1935) is
    // silently dropped by sendEmail, so inheriting one would show an
    // inheritance in the admin UI while the family received nothing.
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "walk-in-adult",
      ageTier: "ADULT",
      email: "walk-in-abc@no-email.invalid",
      archivedAt: null,
      inheritEmailFromId: null,
    } as any);

    const res = await createMember(makePostRequest({
      email: "kid@test.com",
      firstName: "Kid",
      lastName: "Smith",
      inheritEmailFromId: "walk-in-adult",
    }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("real email address");
  });
});

// ─────────────────────────────────────────────────────────────────
// Admin: Member detail returns dependents
// ─────────────────────────────────────────────────────────────────

describe("Admin: Member detail returns dependents", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("includes dependents in the response", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    const memberWithDeps = {
      ...baseMember,
      inheritEmailFrom: null,
      dependents: [
        { id: "dep1", firstName: "Child", lastName: "Smith", ageTier: "CHILD", active: true, dateOfBirth: new Date("2018-05-10"), canLogin: false },
      ],
    };
    vi.mocked(prisma.member.findUnique).mockResolvedValue(memberWithDeps as any);

    const res = await getMemberDetail(
      new NextRequest("http://localhost/api/admin/members/m1"),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dependents).toHaveLength(1);
    expect(body.dependents[0].firstName).toBe("Child");
  });

  it("includes the parent in the response", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      parentMemberId: "parent1",
      parent: {
        id: "parent1",
        firstName: "Parent",
        lastName: "Smith",
        email: "parent@test.com",
        ageTier: "ADULT",
        active: true,
        canLogin: true,
      },
      inheritEmailFrom: null,
    } as any);

    const res = await getMemberDetail(
      new NextRequest("http://localhost/api/admin/members/m1"),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parent.firstName).toBe("Parent");
    expect(body.parentMemberId).toBe("parent1");
  });
});

// ─────────────────────────────────────────────────────────────────
// Admin: Member update with postalSameAsPhysical
// ─────────────────────────────────────────────────────────────────

describe("Admin: Member update with postalSameAsPhysical", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultTransaction();
  });

  function makePutRequest(id: string, body: Record<string, unknown>) {
    return new NextRequest(`http://localhost/api/admin/members/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("copies street to postal when postalSameAsPhysical is true", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, xeroContactId: null } as any);

    const res = await updateMember(
      makePutRequest("m1", {
        streetAddressLine1: "New St 1",
        streetCity: "Hamilton",
        postalSameAsPhysical: true,
      }),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        streetAddressLine1: "New St 1",
        postalAddressLine1: "New St 1",
        postalCity: "Hamilton",
      }),
    }));
  });

  it("updates inheritEmailFromId", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique)
      .mockResolvedValueOnce(baseMember as any)  // existing member
      .mockResolvedValueOnce({
        id: "parent1",
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
        parentMemberId: null,
        inheritEmailFromId: null,
      } as any);  // inherit target
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, inheritEmailFromId: "parent1" } as any);

    const res = await updateMember(
      makePutRequest("m1", { inheritEmailFromId: "parent1" }),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        inheritEmailFromId: "parent1",
      }),
    }));
  });

  it("rejects inheritEmailFromId pointing to the same member", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique)
      .mockResolvedValueOnce({ ...baseMember, ageTier: "ADULT" } as any)
      .mockResolvedValueOnce({
        id: "m1",
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
        parentMemberId: null,
        inheritEmailFromId: null,
      } as any);

    const res = await updateMember(
      makePutRequest("m1", { inheritEmailFromId: "m1" }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("same member"),
      }),
    );
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("rejects inheritEmailFromId pointing to a chained source", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique)
      .mockResolvedValueOnce(baseMember as any)
      .mockResolvedValueOnce({
        id: "parent1",
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
        parentMemberId: null,
        inheritEmailFromId: "lead-adult",
      } as any);

    const res = await updateMember(
      makePutRequest("m1", { inheritEmailFromId: "parent1" }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("cannot chain"),
      }),
    );
    expect(prisma.member.update).not.toHaveBeenCalled();
  });
});
