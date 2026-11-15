// Regression tests for issue #1012: a scoped admin (e.g. Membership Officer
// with membership:edit) must not be able to grant or revoke privileged access
// roles — most critically ADMIN (Full Admin) and FINANCE_ADMIN (Treasurer) —
// through any member write path. requireAdmin is mocked to simulate a scoped
// admin who has already passed the path-inferred area check, which is exactly
// the state the vulnerability exploited; the route/service-level Full Admin
// gate must then return 403.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      // #2716: every admin member write now re-resolves email inheritance
      // inside its own transaction, and that reads members with `findMany`.
      // Defaulted to no rows so a fixture that says nothing about who inherits
      // from whom means exactly that, rather than crashing the reconciliation.
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    accessRoleDefinition: {
      // Empty definitions: permission resolution falls back to the legacy
      // hardcoded bundles, matching this suite's pre-definitions behavior.
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    memberAccessRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
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
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/xero-contact-groups", () => ({
  syncManagedXeroContactGroupForMember: vi.fn(),
}));
vi.mock("@/lib/xero-contacts", () => ({
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/email", () => ({ sendMemberSetupInviteEmail: vi.fn() }));
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
import { POST as bulkUpdate } from "@/app/api/admin/members/bulk-update/route";
import { POST as importMembers } from "@/app/api/admin/members/import/route";
import { POST as createMember } from "@/app/api/admin/members/route";

// A scoped admin: passes requireAdmin's path-inferred membership:edit check
// but is not a Full Admin. accessRoles use the DB-verified plain-string shape
// that requireAdmin now returns.
const scopedAdminGuard = {
  ok: true,
  session: {
    user: { id: "actor1", role: "USER", accessRoles: ["ADMIN_MEMBERSHIP"] },
  },
};
const fullAdminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

const targetMember = {
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

function jsonRequest(url: string, body: Record<string, unknown>, method = "POST") {
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
      member: {
        update: prisma.member.update,
        updateMany: prisma.member.updateMany,
        // #2716: the edit re-resolves email inheritance in the same
        // transaction — the member's own pointer first, then everyone who
        // inherits from them — and both halves read through `findMany`.
        findMany: prisma.member.findMany,
      },
      memberAccessRole: {
        createMany: prisma.memberAccessRole.createMany,
        deleteMany: prisma.memberAccessRole.deleteMany,
      },
      familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: prisma.auditLog.create },
    }),
  );
}

describe("issue #1012 — Full Admin gate on access-role writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.memberFieldsSettings.findUnique).mockResolvedValue(null);
  });

  describe("PUT /api/admin/members/[id]", () => {
    beforeEach(() => {
      vi.mocked(prisma.member.findUnique).mockResolvedValue(targetMember as any);
      mockUpdateTransaction();
    });

    it("returns 403 when a scoped admin grants the ADMIN access role", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await putMember("m1", { accessRoles: ["ADMIN"] });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Full Admin/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 403 when a scoped admin grants the FINANCE_ADMIN access role", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await putMember("m1", { accessRoles: ["USER", "FINANCE_ADMIN"] });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Full Admin/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 403 when a scoped admin grants ADMIN via the legacy role field", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await putMember("m1", { role: "ADMIN" });
      expect(res.status).toBe(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 403 when a scoped admin grants finance access via financeAccessLevel", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await putMember("m1", { financeAccessLevel: "MANAGER" });
      expect(res.status).toBe(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 403 when a scoped admin activates a dormant ADMIN role by enabling login", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        ...targetMember,
        role: "ADMIN",
        canLogin: false,
        accessRoles: [],
      } as any);
      const res = await putMember("m1", { canLogin: true });
      expect(res.status).toBe(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("allows a scoped admin to edit contact details without touching roles", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      vi.mocked(prisma.member.update).mockResolvedValue({
        ...targetMember,
        firstName: "Robin",
      } as any);
      const res = await putMember("m1", { firstName: "Robin" });
      expect(res.status).toBe(200);
    });

    it("allows a scoped admin to resubmit unchanged access roles", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      vi.mocked(prisma.member.update).mockResolvedValue(targetMember as any);
      const res = await putMember("m1", { accessRoles: ["USER"] });
      expect(res.status).toBe(200);
    });

    it("allows a Full Admin to grant the ADMIN access role", async () => {
      mockRequireAdmin.mockResolvedValue(fullAdminGuard);
      vi.mocked(prisma.member.update).mockResolvedValue({
        ...targetMember,
        role: "ADMIN",
        accessRoles: [{ role: "ADMIN" }],
      } as any);
      const res = await putMember("m1", { accessRoles: ["ADMIN"] });
      expect(res.status).toBe(200);
    });

    // Regression tests for the false 403 flagged on PR #1025: the edit
    // dialog echoes role/accessRoles/financeAccessLevel/canLogin back even
    // for contact-only edits, and archive/cancellation clear canLogin but
    // not role/financeAccessLevel — so a non-login member can carry a stale
    // privileged legacy role the scoped admin never touched.
    describe("dormant privileged legacy roles on non-login members", () => {
      const dormantAdminMember = {
        ...targetMember,
        role: "ADMIN",
        financeAccessLevel: "NONE",
        canLogin: false,
        accessRoles: [],
      };
      // What the edit dialog sends for this member when only a contact
      // field changes: raw legacy fields echoed as-is, accessRoles echoed
      // as the (empty) effective set.
      const dialogEcho = {
        role: "ADMIN",
        accessRoles: [],
        financeAccessLevel: "NONE",
        canLogin: false,
        active: true,
      };

      beforeEach(() => {
        vi.mocked(prisma.member.findUnique).mockResolvedValue(
          dormantAdminMember as any,
        );
      });

      it("allows a scoped admin to edit contact details and preserves the dormant role", async () => {
        mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
        vi.mocked(prisma.member.update).mockResolvedValue({
          ...dormantAdminMember,
          firstName: "Robin",
        } as any);
        const res = await putMember("m1", { ...dialogEcho, firstName: "Robin" });
        expect(res.status).toBe(200);
        const updateArgs = vi.mocked(prisma.member.update).mock.calls[0][0];
        expect(updateArgs.data).not.toHaveProperty("role");
        expect(updateArgs.data).not.toHaveProperty("financeAccessLevel");
        expect(prisma.memberAccessRole.deleteMany).not.toHaveBeenCalled();
        expect(prisma.memberAccessRole.createMany).not.toHaveBeenCalled();
      });

      it("allows a scoped admin to edit contact details of a member with dormant finance access", async () => {
        mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
        const dormantTreasurer = {
          ...dormantAdminMember,
          role: "USER",
          financeAccessLevel: "MANAGER",
        };
        vi.mocked(prisma.member.findUnique).mockResolvedValue(
          dormantTreasurer as any,
        );
        vi.mocked(prisma.member.update).mockResolvedValue(
          dormantTreasurer as any,
        );
        const res = await putMember("m1", {
          ...dialogEcho,
          role: "USER",
          financeAccessLevel: "MANAGER",
          phoneNumber: "0215551234",
        });
        expect(res.status).toBe(200);
        const updateArgs = vi.mocked(prisma.member.update).mock.calls[0][0];
        expect(updateArgs.data).not.toHaveProperty("role");
        expect(updateArgs.data).not.toHaveProperty("financeAccessLevel");
        expect(prisma.memberAccessRole.deleteMany).not.toHaveBeenCalled();
      });

      it("still returns 403 when a scoped admin enables login even with an unchanged role echo", async () => {
        mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
        const res = await putMember("m1", { ...dialogEcho, canLogin: true });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toMatch(/Full Admin/);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it("still returns 403 when a scoped admin clears the dormant legacy role", async () => {
        mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
        const res = await putMember("m1", { role: "USER" });
        expect(res.status).toBe(403);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });
  });

  describe("POST /api/admin/members/bulk-update", () => {
    const victim = {
      id: "v1",
      firstName: "Bob",
      lastName: "Jones",
      email: "bob@test.com",
      role: "USER",
      financeAccessLevel: "NONE",
      canLogin: true,
      cancelledAt: null,
      archivedAt: null,
      accessRoles: [{ role: "USER" }],
    };

    function bulkRequest(body: Record<string, unknown>) {
      return bulkUpdate(
        jsonRequest("http://localhost/api/admin/members/bulk-update", body),
      );
    }

    beforeEach(() => {
      vi.mocked(prisma.member.findMany).mockResolvedValue([victim] as any);
      mockUpdateTransaction();
    });

    it("returns 403 when a scoped admin bulk-assigns the ADMIN access role", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await bulkRequest({
        ids: ["v1"],
        action: "set-role",
        accessRoles: ["ADMIN"],
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Full Admin/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 403 when a scoped admin bulk-assigns the FINANCE_ADMIN access role", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await bulkRequest({
        ids: ["v1"],
        action: "set-role",
        accessRoles: ["USER", "FINANCE_ADMIN"],
      });
      expect(res.status).toBe(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 403 when a scoped admin bulk-sets the legacy ADMIN role", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await bulkRequest({
        ids: ["v1"],
        action: "set-role",
        role: "ADMIN",
      });
      expect(res.status).toBe(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("allows a scoped admin bulk set-role that changes no privileged access", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await bulkRequest({
        ids: ["v1"],
        action: "set-role",
        accessRoles: ["USER"],
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/admin/members/import", () => {
    function importRequest(body: Record<string, unknown>) {
      return importMembers(
        jsonRequest("http://localhost/api/admin/members/import", body),
      );
    }

    it("returns 403 when a scoped admin imports a row with role ADMIN", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await importRequest({
        rows: [
          {
            firstName: "Eve",
            lastName: "Adams",
            email: "eve@example.com",
            role: "ADMIN",
          },
        ],
        sendInvites: true,
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Full Admin/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("allows a scoped admin to import ordinary USER rows", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
        fn({
          member: {
            create: vi.fn(async ({ data }: any) => ({
              id: "new-1",
              email: data.email,
              firstName: data.firstName,
              lastName: data.lastName,
              canLogin: data.canLogin,
            })),
          },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        }),
      );
      const res = await importRequest({
        rows: [
          {
            firstName: "Ann",
            lastName: "Ordinary",
            email: "ann@example.com",
            role: "USER",
          },
        ],
        sendInvites: false,
      });
      expect(res.status).toBe(200);
      expect((await res.json()).created).toBe(1);
    });

    it("allows a Full Admin to import a row with role ADMIN", async () => {
      mockRequireAdmin.mockResolvedValue(fullAdminGuard);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
        fn({
          member: {
            create: vi.fn(async ({ data }: any) => ({
              id: "new-admin",
              email: data.email,
              firstName: data.firstName,
              lastName: data.lastName,
              canLogin: data.canLogin,
            })),
          },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        }),
      );
      const res = await importRequest({
        rows: [
          {
            firstName: "Frank",
            lastName: "Founder",
            email: "frank@example.com",
            role: "ADMIN",
          },
        ],
        sendInvites: false,
      });
      expect(res.status).toBe(200);
      expect((await res.json()).created).toBe(1);
    });
  });

  describe("POST /api/admin/members (create)", () => {
    function createRequest(body: Record<string, unknown>) {
      return createMember(
        jsonRequest("http://localhost/api/admin/members", body),
      );
    }

    it("returns 403 when a scoped admin creates a member with the ADMIN access role", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await createRequest({
        firstName: "New",
        lastName: "Admin",
        email: "newadmin@example.com",
        accessRoles: ["ADMIN"],
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Full Admin/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 403 when a scoped admin creates a member with finance manager access", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      const res = await createRequest({
        firstName: "New",
        lastName: "Treasurer",
        email: "newtreasurer@example.com",
        financeAccessLevel: "MANAGER",
      });
      expect(res.status).toBe(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("allows a scoped admin to create an ordinary USER member", async () => {
      mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
        fn({
          member: {
            create: vi.fn().mockResolvedValue({
              id: "m9",
              firstName: "Plain",
              lastName: "Member",
              email: "plain@example.com",
              phoneCountryCode: null,
              phoneAreaCode: null,
              phoneNumber: null,
              dateOfBirth: null,
              role: "USER",
              ageTier: "ADULT",
              active: true,
              canLogin: true,
              xeroContactId: null,
              joinedDate: null,
              createdAt: new Date("2026-04-11"),
            }),
          },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          familyGroupMember: { createMany: vi.fn() },
        }),
      );
      const res = await createRequest({
        firstName: "Plain",
        lastName: "Member",
        email: "plain@example.com",
      });
      expect(res.status).toBe(201);
    });
  });
});

// Issue #1026: the #1012 gate covers only role-field writes, so a scoped
// admin could change a privileged account's EMAIL, then capture a public
// forgot-password reset at the new address and log in with the victim's
// roles. Email changes on members holding privileged effective roles must be
// Full-Admin-only; self-edits and ordinary members stay unaffected.
describe("issue #1026 — Full Admin gate on privileged-member email changes", () => {
  const fullAdminTarget = {
    ...targetMember,
    role: "ADMIN",
    accessRoles: [{ role: "ADMIN" }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.memberFieldsSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      fullAdminTarget as any,
    );
    mockUpdateTransaction();
  });

  it("returns 403 when a scoped admin changes a Full Admin's email", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    const res = await putMember("m1", { email: "attacker@evil.com" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Full Admin/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 403 when a scoped admin changes a peer scoped admin's email", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...targetMember,
      accessRoles: [{ role: "ADMIN_MEMBERSHIP" }],
    } as any);
    const res = await putMember("m1", { email: "attacker@evil.com" });
    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows a scoped admin to edit a Full Admin's contact details when the echoed email is unchanged", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    vi.mocked(prisma.member.update).mockResolvedValue(fullAdminTarget as any);
    const res = await putMember("m1", {
      email: targetMember.email,
      firstName: "Robin",
    });
    expect(res.status).toBe(200);
  });

  it("allows a scoped admin to change an ordinary member's email", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      targetMember as any,
    );
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...targetMember,
      email: "new@example.com",
    } as any);
    const res = await putMember("m1", { email: "new@example.com" });
    expect(res.status).toBe(200);
  });

  it("allows a scoped admin to change their own email", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    const self = {
      ...targetMember,
      id: "actor1",
      accessRoles: [{ role: "ADMIN_MEMBERSHIP" }],
    };
    vi.mocked(prisma.member.findUnique).mockResolvedValue(self as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...self,
      email: "me@example.com",
    } as any);
    const res = await putMember("actor1", { email: "me@example.com" });
    expect(res.status).toBe(200);
  });

  it("allows a scoped admin to change the email of a non-login member with a dormant legacy role", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    const dormant = {
      ...targetMember,
      role: "ADMIN",
      canLogin: false,
      accessRoles: [],
    };
    vi.mocked(prisma.member.findUnique).mockResolvedValue(dormant as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...dormant,
      email: "archive@example.com",
    } as any);
    const res = await putMember("m1", { email: "archive@example.com" });
    expect(res.status).toBe(200);
  });

  it("allows a Full Admin to change another Full Admin's email", async () => {
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...fullAdminTarget,
      email: "renamed@example.com",
    } as any);
    const res = await putMember("m1", { email: "renamed@example.com" });
    expect(res.status).toBe(200);
  });
});
