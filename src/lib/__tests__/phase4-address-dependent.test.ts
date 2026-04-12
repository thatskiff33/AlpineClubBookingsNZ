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
    member: {
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    booking: { findMany: vi.fn().mockResolvedValue([]), aggregate: vi.fn().mockResolvedValue({ _sum: { finalPriceCents: 0 }, _count: 0, _max: { checkOut: null } }) },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    familyGroup: { findMany: vi.fn().mockResolvedValue([]) },
    familyGroupMember: { createMany: vi.fn() },
    passwordResetToken: { create: vi.fn() },
    $transaction: vi.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
      member: {
        create: vi.fn().mockResolvedValue({ id: "dep1", firstName: "Child", lastName: "Smith" }),
      },
      familyGroupMember: { createMany: vi.fn() },
    })),
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
  updateXeroContact: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  getXeroContactGroupMemberships: vi.fn().mockResolvedValue({}),
  createXeroEntranceFeeInvoice: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: vi.fn().mockReturnValue({ handled: true }),
}));
vi.mock("@/lib/utils", () => ({
  getSeasonYear: vi.fn().mockReturnValue(2026),
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
  withDefaultNzCountry,
  normalizeAddressValue,
  NZ_COUNTRY_CODE,
} from "@/lib/member-address";

const adminSession = { user: { id: "admin1", role: "ADMIN" } } as any;
const memberSession = { user: { id: "m1", role: "MEMBER" } } as any;

const baseMember = {
  id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
  phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115",
  dateOfBirth: new Date("1990-01-15"), role: "MEMBER", ageTier: "ADULT",
  active: true, forcePasswordChange: false, xeroContactId: null,
  joinedDate: null, createdAt: new Date("2025-01-01"), canLogin: true,
  parentMemberId: null, inheritParentEmail: false, inheritEmailFromId: null,
  streetAddressLine1: "123 Main St", streetAddressLine2: null,
  streetCity: "Tokoroa", streetRegion: "Waikato",
  streetPostalCode: "3420", streetCountry: "NZ",
  postalAddressLine1: "PO Box 42", postalAddressLine2: null,
  postalCity: "Tokoroa", postalRegion: "Waikato",
  postalPostalCode: "3420", postalCountry: "NZ",
  familyGroupMemberships: [],
  subscriptions: [],
  dependents: [],
};

// ─────────────────────────────────────────────────────────────────
// member-address.ts utility tests
// ─────────────────────────────────────────────────────────────────

describe("member-address utilities", () => {
  it("copyStreetAddressToPostal copies all street fields to postal", () => {
    const result = copyStreetAddressToPostal({
      streetAddressLine1: "123 Main",
      streetAddressLine2: "Unit 4",
      streetCity: "Tokoroa",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "NZ",
    });
    expect(result).toEqual({
      postalAddressLine1: "123 Main",
      postalAddressLine2: "Unit 4",
      postalCity: "Tokoroa",
      postalRegion: "Waikato",
      postalPostalCode: "3420",
      postalCountry: "NZ",
    });
  });

  it("postalMatchesPhysical returns true when all fields match", () => {
    expect(postalMatchesPhysical({
      streetAddressLine1: "123 Main", postalAddressLine1: "123 Main",
      streetAddressLine2: null, postalAddressLine2: null,
      streetCity: "Tokoroa", postalCity: "Tokoroa",
      streetRegion: "Waikato", postalRegion: "Waikato",
      streetPostalCode: "3420", postalPostalCode: "3420",
      streetCountry: "NZ", postalCountry: "NZ",
    })).toBe(true);
  });

  it("postalMatchesPhysical returns false when fields differ", () => {
    expect(postalMatchesPhysical({
      streetAddressLine1: "123 Main", postalAddressLine1: "PO Box 42",
      streetAddressLine2: null, postalAddressLine2: null,
      streetCity: "Tokoroa", postalCity: "Tokoroa",
      streetRegion: "Waikato", postalRegion: "Waikato",
      streetPostalCode: "3420", postalPostalCode: "3420",
      streetCountry: "NZ", postalCountry: "NZ",
    })).toBe(false);
  });

  it("postalMatchesPhysical trims whitespace before comparing", () => {
    expect(postalMatchesPhysical({
      streetAddressLine1: "123 Main ", postalAddressLine1: "123 Main",
      streetAddressLine2: "", postalAddressLine2: " ",
      streetCity: "Tokoroa", postalCity: "Tokoroa",
      streetRegion: "Waikato", postalRegion: "Waikato",
      streetPostalCode: "3420", postalPostalCode: "3420",
      streetCountry: "NZ", postalCountry: "NZ",
    })).toBe(true);
  });

  it("withDefaultNzCountry returns NZ for null/empty", () => {
    expect(withDefaultNzCountry(null)).toBe(NZ_COUNTRY_CODE);
    expect(withDefaultNzCountry("")).toBe(NZ_COUNTRY_CODE);
    expect(withDefaultNzCountry(undefined)).toBe(NZ_COUNTRY_CODE);
  });

  it("withDefaultNzCountry preserves existing value", () => {
    expect(withDefaultNzCountry("AU")).toBe("AU");
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
  beforeEach(() => { vi.clearAllMocks(); });

  function makeProfilePut(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/profile", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("copies street to postal when postalSameAsPhysical is true", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember } as any);

    const res = await updateProfile(makeProfilePut({
      firstName: "Alice", lastName: "Smith",
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
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ id: "parent1", ageTier: "ADULT" } as any);

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
      streetCity: "Tokoroa",
      postalSameAsPhysical: true,
    }));
    expect(res.status).toBe(201);
  });

  it("defaults dependent email inheritance to the parent's existing email source", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "parent1",
      ageTier: "ADULT",
      inheritEmailFromId: "lead-adult",
    } as any);

    const txMemberCreate = vi.fn().mockResolvedValue({
      id: "dep2",
      firstName: "Child",
      lastName: "Smith",
      email: "lead@test.com",
      role: "MEMBER",
      ageTier: "CHILD",
      active: true,
      canLogin: false,
      parentMemberId: "parent1",
      inheritParentEmail: true,
      inheritEmailFromId: "lead-adult",
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
      email: "lead@test.com",
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
        inheritEmailFromId: "lead-adult",
      }),
    }));
  });

  it("rejects dependent creation under non-adult parent", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ id: "youth1", ageTier: "YOUTH" } as any);

    const res = await createMember(makePostRequest({
      email: "child@test.com",
      firstName: "Child",
      lastName: "Doe",
      parentMemberId: "youth1",
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("adult");
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
});

// ─────────────────────────────────────────────────────────────────
// Admin: Member update with postalSameAsPhysical
// ─────────────────────────────────────────────────────────────────

describe("Admin: Member update with postalSameAsPhysical", () => {
  beforeEach(() => { vi.clearAllMocks(); });

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
      .mockResolvedValueOnce({ id: "parent1", ageTier: "ADULT" } as any);  // inherit target
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
});
