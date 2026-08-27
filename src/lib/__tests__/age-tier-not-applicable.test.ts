// #1440: AgeTier NOT_APPLICABLE is the organisation/school tier. The server
// forces it onto org-type members (ORG access role or legacy SCHOOL role) on
// every create/update, rejects it for everyone else, restores a DOB-derived
// tier when a member is reclassified away from Organisation, and keeps
// organisations out of booking-guest flows entirely.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const hostingMocks = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue(0),
  settle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      // #2716: a member write now re-resolves email inheritance inside its own
      // transaction, and that reads members with `findMany`. Defaulted to no
      // rows so a fixture that says nothing about who inherits from whom means
      // exactly that, rather than crashing the reconciliation.
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    accessRoleDefinition: {
      // Empty definitions: permission resolution falls back to the legacy
      // hardcoded bundles.
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    memberAccessRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
    // #2106: the N/A-flip linked-guest block queries future linked-guest
    // bookings; default to none.
    bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    // #2106: the update path resolves the member's current-season type exemption.
    seasonalMembershipAssignment: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    memberFieldsSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    passwordResetToken: { create: vi.fn() },
    xeroContactCache: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const mockComputeAgeTier = vi.fn();
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: (...args: unknown[]) => mockComputeAgeTier(...args),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/email", () => ({ sendMemberSetupInviteEmail: vi.fn() }));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: hostingMocks.enqueue,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: hostingMocks.settle,
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditEmailDomain: vi.fn(() => null),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
  createAuditLog: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

import { prisma } from "@/lib/prisma";
import { PUT as updateMember } from "@/app/api/admin/members/[id]/route";
import { POST as createMember } from "@/app/api/admin/members/route";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import {
  formatAgeTierName,
  getAgeTierLabel,
} from "@/lib/use-age-tier-options";
import { resolveLinkedBookingMembers } from "@/lib/booking-guests";
import {
  NOT_APPLICABLE_TYPE_REJECTION_MESSAGE,
  resolveEnforcedAgeTier,
} from "@/lib/age-tier-enforcement";

const fullAdminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

const personMember = {
  id: "m1",
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@test.com",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: null,
  role: "USER",
  financeAccessLevel: "NONE",
  accessRoles: [{ role: "USER" }],
  ageTier: "ADULT",
  active: true,
  forcePasswordChange: false,
  canLogin: true,
  xeroContactId: null,
  joinedDate: null,
  createdAt: new Date("2025-01-01"),
};

const orgMember = {
  ...personMember,
  id: "org1",
  firstName: "Springfield",
  lastName: "School",
  email: "office@school.test",
  role: "SCHOOL",
  accessRoles: [{ role: "ORG" }],
  ageTier: "NOT_APPLICABLE",
};

function jsonRequest(
  url: string,
  body: Record<string, unknown>,
  method = "POST",
) {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function putMember(id: string, body: Record<string, unknown>) {
  return updateMember(
    jsonRequest(`http://localhost/api/admin/members/${id}`, body, "PUT"),
    { params: Promise.resolve({ id }) },
  );
}

function mockUpdateTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation(async (operation: any) =>
    operation({
      $executeRaw: vi.fn().mockResolvedValue(1),
      member: {
        update: prisma.member.update,
        updateMany: prisma.member.updateMany,
        // #2716: an ORG reclassification moves the member across the line
        // between "can receive mail" and "cannot", so the edit re-resolves the
        // member's own inheritance pointer and every pointer aimed at them
        // inside the same transaction; both halves read through `findMany`.
        findMany: prisma.member.findMany,
      },
      memberAccessRole: {
        createMany: prisma.memberAccessRole.createMany,
        deleteMany: prisma.memberAccessRole.deleteMany,
      },
      familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      // #1756: an ADULT→NOT_APPLICABLE reclassification (org member) counts
      // as leaving the ADULT tier, so the shared-double sweep runs inside the
      // transaction; no rows here, so it is a no-op.
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: prisma.auditLog.create },
    }),
  );
}

describe("#1440 — server-side NOT_APPLICABLE enforcement on member writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.memberFieldsSettings.findUnique).mockResolvedValue(null);
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    mockComputeAgeTier.mockResolvedValue("ADULT");
  });

  describe("PUT /api/admin/members/[id]", () => {
    beforeEach(() => {
      mockUpdateTransaction();
    });

    it("forces NOT_APPLICABLE on an ORG-role member even when a person tier is submitted", async () => {
      vi.mocked(prisma.member.findUnique).mockResolvedValue(orgMember as any);
      vi.mocked(prisma.member.update).mockResolvedValue(orgMember as any);

      const res = await putMember("org1", { ageTier: "ADULT" });

      expect(res.status).toBe(200);
      expect(prisma.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ageTier: "NOT_APPLICABLE" }),
        }),
      );
    });

    it("forces NOT_APPLICABLE on a legacy SCHOOL member whose resolved tokens omit ORG", async () => {
      const legacySchool = {
        ...orgMember,
        accessRoles: [],
        canLogin: false,
        ageTier: "ADULT",
      };
      vi.mocked(prisma.member.findUnique).mockResolvedValue(
        legacySchool as any,
      );
      vi.mocked(prisma.member.update).mockResolvedValue(legacySchool as any);

      const res = await putMember("org1", { firstName: "Updated" });

      expect(res.status).toBe(200);
      expect(prisma.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ageTier: "NOT_APPLICABLE" }),
        }),
      );
    });

    it("rejects NOT_APPLICABLE for a non-organisation member with 422", async () => {
      vi.mocked(prisma.member.findUnique).mockResolvedValue(
        personMember as any,
      );

      const res = await putMember("m1", { ageTier: "NOT_APPLICABLE" });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/organisation/i);
      expect(prisma.member.update).not.toHaveBeenCalled();
    });

    it("restores a DOB-derived tier when a member is reclassified away from Organisation", async () => {
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        ...orgMember,
        dateOfBirth: new Date("2012-06-01"),
      } as any);
      vi.mocked(prisma.member.update).mockResolvedValue(personMember as any);
      mockComputeAgeTier.mockResolvedValue("YOUTH");

      const res = await putMember("org1", {
        role: "USER",
        accessRoles: ["USER"],
      });

      expect(res.status).toBe(200);
      expect(mockComputeAgeTier).toHaveBeenCalled();
      expect(prisma.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ageTier: "YOUTH" }),
        }),
      );
      expect(hostingMocks.enqueue).toHaveBeenCalledWith(
        "org1",
        expect.any(Object),
        // #3123: the club's day, resolved before the transaction opened.
        expect.any(Date),
        { cause: "SYSTEM_CHANGE", actorMemberId: "actor1" },
      );
      expect(hostingMocks.settle).toHaveBeenCalledWith({ limit: 50 });
    });

    it("falls back to ADULT on reclassification when the member has no date of birth", async () => {
      vi.mocked(prisma.member.findUnique).mockResolvedValue(orgMember as any);
      vi.mocked(prisma.member.update).mockResolvedValue(personMember as any);

      const res = await putMember("org1", {
        role: "USER",
        accessRoles: ["USER"],
      });

      expect(res.status).toBe(200);
      expect(mockComputeAgeTier).not.toHaveBeenCalled();
      expect(prisma.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ageTier: "ADULT" }),
        }),
      );
      expect(hostingMocks.enqueue).toHaveBeenCalledWith(
        "org1",
        expect.any(Object),
        // #3123: the club's day, resolved before the transaction opened.
        expect.any(Date),
        { cause: "SYSTEM_CHANGE", actorMemberId: "actor1" },
      );
      expect(hostingMocks.settle).toHaveBeenCalledWith({ limit: 50 });
    });
  });

  describe("POST /api/admin/members (create)", () => {
    function createRequest(body: Record<string, unknown>) {
      return createMember(
        jsonRequest("http://localhost/api/admin/members", body),
      );
    }

    it("forces NOT_APPLICABLE when creating an ORG-role member", async () => {
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      const create = vi.fn().mockResolvedValue({
        ...orgMember,
        id: "org9",
      });
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
        fn({
          member: { create },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          familyGroupMember: { createMany: vi.fn() },
          // SCHOOL-role creates seed a NOT_REQUIRED subscription row.
          memberSubscription: { upsert: vi.fn().mockResolvedValue({}) },
        }),
      );

      const res = await createRequest({
        firstName: "Springfield",
        lastName: "School",
        email: "office@school.test",
        accessRoles: ["ORG"],
        ageTier: "ADULT",
      });

      expect(res.status).toBe(201);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ageTier: "NOT_APPLICABLE" }),
        }),
      );
    });

    it("rejects NOT_APPLICABLE with 422 when creating a non-organisation member", async () => {
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

      const res = await createRequest({
        firstName: "Plain",
        lastName: "Member",
        email: "plain@example.com",
        ageTier: "NOT_APPLICABLE",
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/organisation/i);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});

describe("#1440 — bookable tier validator and display labels", () => {
  it("bookableAgeTierEnum accepts the four person tiers and rejects NOT_APPLICABLE", () => {
    for (const tier of ["INFANT", "CHILD", "YOUTH", "ADULT"]) {
      expect(bookableAgeTierEnum.safeParse(tier).success).toBe(true);
    }
    expect(bookableAgeTierEnum.safeParse("NOT_APPLICABLE").success).toBe(false);
  });

  it("formatAgeTierName renders NOT_APPLICABLE as N/A and person tiers title-cased", () => {
    expect(formatAgeTierName("NOT_APPLICABLE")).toBe("N/A");
    expect(formatAgeTierName("ADULT")).toBe("Adult");
    expect(formatAgeTierName("INFANT")).toBe("Infant");
  });

  it("getAgeTierLabel falls back to N/A for NOT_APPLICABLE, which never has a settings row", () => {
    const options = [
      { tier: "ADULT" as const, label: "Adult (18+)", sortOrder: 3 },
    ];
    expect(getAgeTierLabel(options, "ADULT")).toBe("Adult (18+)");
    expect(getAgeTierLabel(options, "NOT_APPLICABLE")).toBe("N/A");
  });
});

describe("#1440 — organisations cannot be linked as booking guests", () => {
  it("resolveLinkedBookingMembers rejects a NOT_APPLICABLE linked member", async () => {
    const db = {
      member: {
        findMany: vi.fn().mockResolvedValue([
          { id: "org1", ageTier: "NOT_APPLICABLE", active: true },
        ]),
      },
      familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    await expect(
      resolveLinkedBookingMembers(db, "booker1", ["org1"], {
        skipAuthorization: true,
      }),
    ).rejects.toThrow(/age-exempt \(N\/A\) and cannot be added/);
  });

  it("resolveLinkedBookingMembers still resolves person members", async () => {
    const db = {
      member: {
        findMany: vi.fn().mockResolvedValue([
          { id: "m1", ageTier: "ADULT", active: true },
        ]),
      },
      familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const resolved = await resolveLinkedBookingMembers(db, "booker1", ["m1"], {
      skipAuthorization: true,
    });

    expect(resolved.get("m1")).toMatchObject({ ageTier: "ADULT" });
  });
});

describe("#2106 — resolveEnforcedAgeTier precedence matrix", () => {
  const base = {
    isOrganisation: false,
    typeExemption: "DISALLOWED" as const,
    currentAgeTier: "ADULT" as const,
    restorePersonTier: "ADULT" as const,
  };

  it("org force outranks everything (even an ALLOWED type and a person pick)", () => {
    expect(
      resolveEnforcedAgeTier({
        ...base,
        isOrganisation: true,
        typeExemption: "ALLOWED",
        requestedAgeTier: "YOUTH",
      }),
    ).toEqual({ ok: true, ageTier: "NOT_APPLICABLE" });
  });

  it("a FORCED type forces N/A when the member is not an org", () => {
    expect(
      resolveEnforcedAgeTier({ ...base, typeExemption: "FORCED" }),
    ).toEqual({ ok: true, ageTier: "NOT_APPLICABLE" });
  });

  it("accepts an explicit manual N/A only on an ALLOWED type", () => {
    expect(
      resolveEnforcedAgeTier({
        ...base,
        typeExemption: "ALLOWED",
        requestedAgeTier: "NOT_APPLICABLE",
      }),
    ).toEqual({ ok: true, ageTier: "NOT_APPLICABLE" });
  });

  it("rejects an explicit manual N/A on a DISALLOWED type (and with no type)", () => {
    expect(
      resolveEnforcedAgeTier({
        ...base,
        typeExemption: "DISALLOWED",
        requestedAgeTier: "NOT_APPLICABLE",
      }),
    ).toEqual({ ok: false, error: NOT_APPLICABLE_TYPE_REJECTION_MESSAGE });
    expect(
      resolveEnforcedAgeTier({
        ...base,
        typeExemption: null,
        requestedAgeTier: "NOT_APPLICABLE",
      }),
    ).toEqual({ ok: false, error: NOT_APPLICABLE_TYPE_REJECTION_MESSAGE });
  });

  it("preserves a hand-picked N/A on an ALLOWED type when no tier is submitted", () => {
    expect(
      resolveEnforcedAgeTier({
        ...base,
        typeExemption: "ALLOWED",
        currentAgeTier: "NOT_APPLICABLE",
        restorePersonTier: "ADULT",
      }),
    ).toEqual({ ok: true, ageTier: "NOT_APPLICABLE" });
  });

  it("restores the person tier when un-forcing an N/A member onto a DISALLOWED type", () => {
    expect(
      resolveEnforcedAgeTier({
        ...base,
        typeExemption: "DISALLOWED",
        currentAgeTier: "NOT_APPLICABLE",
        restorePersonTier: "YOUTH",
      }),
    ).toEqual({ ok: true, ageTier: "YOUTH" });
  });

  it("an explicit person tier wins over the restore fallback", () => {
    expect(
      resolveEnforcedAgeTier({
        ...base,
        typeExemption: "ALLOWED",
        requestedAgeTier: "CHILD",
        restorePersonTier: "ADULT",
      }),
    ).toEqual({ ok: true, ageTier: "CHILD" });
  });
});
