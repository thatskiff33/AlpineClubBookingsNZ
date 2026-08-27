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
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      // #2716: a profile or admin edit can add, change or REMOVE an address, so
      // it re-resolves email inheritance inside the same transaction — the
      // member's own pointer, then everyone who inherits from them — and both
      // halves read members with `findMany`. Defaulted to no rows: these
      // fixtures describe one member with nobody inheriting from them.
      findMany: vi.fn().mockResolvedValue([]),
    },
    booking: { findMany: vi.fn(), aggregate: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
    xeroContactCache: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn().mockImplementation((operation: unknown) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return (operation as (tx: unknown) => Promise<unknown>)({});
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
  requireAdmin: vi.fn().mockResolvedValue({
    ok: true,
    session: { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  }),
}));
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
}));
vi.mock("@/lib/email", () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
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
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import {
  isXeroConnected,
  syncManagedXeroContactGroupForMember,
  updateXeroContact,
} from "@/lib/xero";
import { PUT as updateProfile } from "@/app/api/profile/route";
import { PUT as updateMember } from "@/app/api/admin/members/[id]/route";
import { POST as register } from "@/app/api/auth/register/route";

const adminSession = { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;
const memberSession = { user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }] } } as any;

const baseMember = {
  id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
  phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115",
  dateOfBirth: new Date("1990-01-15"), role: "USER", ageTier: "ADULT",
  accessRoles: [{ role: "USER" }],
  active: true, forcePasswordChange: false, xeroContactId: null,
  joinedDate: null, createdAt: new Date("2025-01-01"), canLogin: true,
  profileCompletedAt: null,
  streetAddressLine1: "123 Main St", streetAddressLine2: null, streetCity: "Example",
  streetRegion: "Waikato", streetPostalCode: "3420", streetCountry: "NZ",
  postalAddressLine1: "PO Box 42", postalAddressLine2: null, postalCity: "Example",
  postalRegion: "Waikato", postalPostalCode: "3420", postalCountry: "NZ",
};

// ──────────────────────────────────────────────────────────────
// Profile API — structured phone + address validation
// ──────────────────────────────────────────────────────────────

describe("Profile API: structured phone and address fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.member.count).mockResolvedValue(1);
    vi.mocked(prisma.$transaction).mockImplementation(async (operation: any) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return operation({
        member: {
          update: prisma.member.update,
          // #1604 last-admin guard counts active Full Admins inside the tx.
          count: prisma.member.count,
          // #2716: the same transaction re-resolves email inheritance, which
          // reads the subjects and then their chosen sources with `findMany`.
          findMany: prisma.member.findMany,
        },
        memberAccessRole: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        auditLog: {
          create: prisma.auditLog.create,
        },
      });
    });
  });

  function makeProfilePut(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/profile", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  const validProfileBody = {
    firstName: "Alice", lastName: "Smith",
    phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115",
    dateOfBirth: "1990-01-15",
    streetAddressLine1: "123 Main St",
    streetCity: "Example",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "NZ",
    postalAddressLine1: "PO Box 42",
    postalCity: "Example",
    postalRegion: "Waikato",
    postalPostalCode: "3420",
    postalCountry: "NZ",
  };

  it("accepts structured phone fields", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember } as any);

    const res = await updateProfile(makeProfilePut(validProfileBody));
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "4224115",
      }),
    }));
  });

  it("persists the lodge-screen phone opt-in when supplied (#126 / #37)", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      lodgeScreenPhoneOptIn: false,
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      lodgeScreenPhoneOptIn: true,
    } as any);

    const res = await updateProfile(
      makeProfilePut({ ...validProfileBody, lodgeScreenPhoneOptIn: true }),
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lodgeScreenPhoneOptIn: true }),
      }),
    );
  });

  it("leaves the opt-in untouched when the field is omitted (#126)", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      lodgeScreenPhoneOptIn: true,
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember } as any);

    const res = await updateProfile(makeProfilePut(validProfileBody));
    expect(res.status).toBe(200);
    const call = vi.mocked(prisma.member.update).mock.calls[0][0] as any;
    expect(call.data).not.toHaveProperty("lodgeScreenPhoneOptIn");
  });

  it("returns 403 for deactivated members", async () => {
    mockRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.mocked(auth).mockResolvedValue(memberSession);

    const res = await updateProfile(makeProfilePut(validProfileBody));
    expect(res.status).toBe(403);
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("accepts address fields", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember } as any);

    const res = await updateProfile(makeProfilePut({
      ...validProfileBody,
      streetAddressLine1: "123 Main St",
      streetCity: "Example",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "NZ",
      postalAddressLine1: "PO Box 42",
      postalCity: "Example",
    }));
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        streetAddressLine1: "123 Main St",
        streetCity: "Example",
        postalAddressLine1: "PO Box 42",
      }),
    }));
  });

  it("writes structured audit metadata for profile field changes", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      firstName: "Alicia",
      streetCity: "Whakapapa",
    } as any);

    const res = await updateProfile(
      makeProfilePut({
        ...validProfileBody,
        firstName: "Alicia",
        streetCity: "Whakapapa",
      })
    );

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "member.profile.updated",
        actorMemberId: "m1",
        subjectMemberId: "m1",
        category: "account",
        metadata: expect.objectContaining({
          changedFields: expect.arrayContaining(["firstName", "streetCity"]),
          fieldGroups: expect.objectContaining({
            name: true,
            address: true,
          }),
        }),
      }),
    });
  });

  it("rejects phoneCountryCode exceeding max length", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    const res = await updateProfile(makeProfilePut({
      ...validProfileBody,
      phoneCountryCode: "123456", // max 5
    }));
    expect(res.status).toBe(422);
  });

  it("rejects phoneNumber exceeding max length", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    const res = await updateProfile(makeProfilePut({
      ...validProfileBody,
      phoneNumber: "1234567890123456", // max 15
    }));
    expect(res.status).toBe(422);
  });

  it("syncs to Xero when member has xeroContactId and Xero is connected", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember, phoneNumber: "9999999", xeroContactId: "xc1",
    } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    await updateProfile(makeProfilePut({ ...validProfileBody, phoneNumber: "9999999" }));

    expect(updateXeroContact).toHaveBeenCalledWith(
      "xc1",
      expect.objectContaining({
        phoneCountryCode: "64",
        phoneNumber: "9999999",
      }),
      expect.objectContaining({
        localModel: "Member",
        localId: "m1",
        createdByMemberId: "m1",
        preserveXeroName: true,
      })
    );
  });

  it("does not sync to Xero when only the member name changes", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      firstName: "Alicia",
      xeroContactId: "xc1",
    } as any);

    await updateProfile(makeProfilePut({ ...validProfileBody, firstName: "Alicia" }));

    expect(isXeroConnected).not.toHaveBeenCalled();
    expect(updateXeroContact).not.toHaveBeenCalled();
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("does not sync to Xero when Xero-mapped fields are unchanged", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
    } as any);

    await updateProfile(makeProfilePut(validProfileBody));

    expect(isXeroConnected).not.toHaveBeenCalled();
    expect(updateXeroContact).not.toHaveBeenCalled();
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("does not sync to Xero when not connected", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember, xeroContactId: "xc1",
    } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(false);

    await updateProfile(makeProfilePut(validProfileBody));

    expect(updateXeroContact).not.toHaveBeenCalled();
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("syncs managed Xero contact groups when the profile age tier changes", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      ageTier: "CHILD",
      xeroContactId: "xc1",
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      ageTier: "YOUTH",
      xeroContactId: "xc1",
      dateOfBirth: new Date("2010-06-15"),
    } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    await updateProfile(
      makeProfilePut({
        ...validProfileBody,
        dateOfBirth: "2010-06-15",
      })
    );

    expect(syncManagedXeroContactGroupForMember).toHaveBeenCalledWith("m1", {
      createdByMemberId: "m1",
    });
  });

  it("rejects empty required phone fields", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);

    const res = await updateProfile(makeProfilePut({
      ...validProfileBody,
      phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "",
    }));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        missingFields: expect.arrayContaining([
          "phoneCountryCode",
          "phoneAreaCode",
          "phoneNumber",
        ]),
      })
    );
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("rejects incomplete required profile fields", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);

    const res = await updateProfile(makeProfilePut({
      firstName: "Alice",
      lastName: "Smith",
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "4224115",
      dateOfBirth: "1990-01-15",
    }));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        missingFields: expect.arrayContaining([
          "streetAddressLine1",
          "streetCity",
          "postalAddressLine1",
        ]),
      })
    );
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("does not enforce first-login profile completeness for admin accounts", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      id: "admin1",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
      profileCompletedAt: null,
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      id: "admin1",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
      firstName: "Admin",
      lastName: "User",
    } as any);

    const res = await updateProfile(makeProfilePut({
      firstName: "Admin",
      lastName: "User",
    }));

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({
        profileCompletedAt: expect.any(Date),
      }),
    }));
  });

  it("rejects a future date of birth", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);

    const futureYear = new Date().getFullYear() + 1;
    const res = await updateProfile(makeProfilePut({
      ...validProfileBody,
      dateOfBirth: `${futureYear}-01-01`,
    }));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        error: "Date of birth cannot be in the future",
      })
    );
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("sets profileCompletedAt when required fields are complete", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      profileCompletedAt: null,
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      profileCompletedAt: new Date("2026-05-10T00:00:00.000Z"),
    } as any);

    const res = await updateProfile(makeProfilePut(validProfileBody));

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        profileCompletedAt: expect.any(Date),
      }),
    }));
  });
});

// ──────────────────────────────────────────────────────────────
// Admin Member Edit API — structured phone + address
// ──────────────────────────────────────────────────────────────

describe("Admin Member Edit: structured phone and address", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.member.count).mockResolvedValue(1);
  });

  function makePutRequest(id: string, body: Record<string, unknown>) {
    return new NextRequest(`http://localhost/api/admin/members/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("updates structured phone fields via admin", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember, phoneCountryCode: "61", phoneAreaCode: "2", phoneNumber: "1234567", xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { phoneCountryCode: "61", phoneAreaCode: "2", phoneNumber: "1234567" }),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phoneCountryCode: "61",
        phoneAreaCode: "2",
        phoneNumber: "1234567",
      }),
    }));
  });

  it("updates address fields via admin", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      streetAddressLine1: "42 Lodge Rd",
      streetCity: "Whakapapa",
      xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { streetAddressLine1: "42 Lodge Rd", streetCity: "Whakapapa" }),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        streetAddressLine1: "42 Lodge Rd",
        streetCity: "Whakapapa",
      }),
    }));
  });

  it("passes structured phone + address to Xero on admin edit", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
      streetAddressLine1: "42 Lodge Rd",
    } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    await updateMember(
      makePutRequest("m1", { streetAddressLine1: "42 Lodge Rd" }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(updateXeroContact).toHaveBeenCalledWith(
      "xc1",
      expect.objectContaining({
        streetAddressLine1: "42 Lodge Rd",
      }),
      expect.objectContaining({
        localModel: "Member",
        localId: "m1",
        createdByMemberId: "admin1",
        preserveXeroName: true,
      }),
    );
  });

  it("returns 409 when admin member update hits a unique email constraint", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockRejectedValueOnce({ code: "P2002" });

    const res = await updateMember(
      makePutRequest("m1", { email: "new@test.com" }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(res.status).toBe(409);
  });

  it("allows shared email when demoting a member to non-login", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "other-login" } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      email: "shared@test.com",
      canLogin: false,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { email: "shared@test.com", canLogin: false }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(res.status).toBe(200);
    expect(prisma.member.findFirst).not.toHaveBeenCalled();
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: "shared@test.com",
        canLogin: false,
      }),
    }));
  });
});

// ──────────────────────────────────────────────────────────────
// Legacy self-service registration
// ──────────────────────────────────────────────────────────────

describe("Legacy registration route", () => {
  it("returns 410 and directs applicants to /join/apply", async () => {
    const res = await register();

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("/join/apply"),
      })
    );
  });
});
