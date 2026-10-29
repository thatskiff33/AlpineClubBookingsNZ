// Route-level wiring tests for issue #1604. A scoped admin (Membership Officer,
// membership:edit) has already passed the path-inferred area check — exactly
// the state the gap exploited — and must now be blocked from deactivating,
// de-logging, or archiving privileged accounts; and nobody, including a Full
// Admin, may remove the last active Full Admin. requireAdmin is mocked; the
// guard helpers and access-role predicates run for real against a mocked
// Prisma so the actual query/end-state logic is exercised.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      // Read inside the mutation transactions below (deletion anonymisation's
      // family-link orphan sweep, and since #2716 the email-inheritance
      // re-resolution every member write runs). Defaulted to no rows — and
      // re-defaulted per test, since `clearAllMocks` keeps implementations —
      // so a fixture that names nobody means exactly that.
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    deletionRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    booking: { findMany: vi.fn().mockResolvedValue([]) },
    bookingGuest: { updateMany: vi.fn() },
    accessRoleDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    memberAccessRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // #1756: successful deactivations sweep future shared-double placements
    // inside the mutation transaction; empty by default so the guard tests
    // stay a no-op sweep.
    bedAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    xeroContactCache: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) },
    xeroObjectLink: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: vi.fn().mockResolvedValue(1),
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
// #2576 §8. "Membership becoming inactive, lapsed, cancelled or archived" is the FIRST
// change class the owner's decision names, and only the evaluator half of it was
// automatic — an archived or cancelled member correctly stops qualifying as an adult
// host, while nothing told the club to go and look at the bookings that had been relying
// on them. The lifecycle paths now record that obligation inside their own transaction,
// which means they read the bookings this person ATTENDS through the caller's `tx` — and
// this suite drives that transaction with a fake carrying only the lifecycle delegates.
//
// Mocked at the module boundary so the assertion here can be about the thing that
// belongs here: that the change RECORDS the re-evaluation and is never refused by it.
// What the re-evaluation then concludes is the hosting suites' subject.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: vi.fn(async () => 1),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn().mockResolvedValue({ status: 200 }),
}));
vi.mock("@/lib/email", () => ({
  sendAccountDeletionApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendAccountDeletionRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPartnerShareSweptAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditEmailDomain: vi.fn(() => null),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
  createAuditLog: vi.fn(),
  logAudit: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { PUT as updateMember } from "@/app/api/admin/members/[id]/route";
import { POST as bulkUpdate } from "@/app/api/admin/members/bulk-update/route";
import { POST as reviewDeletion } from "@/app/api/admin/deletion-requests/[id]/route";

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

const adminTarget = {
  id: "admin2",
  firstName: "Ada",
  lastName: "Admin",
  email: "ada@test.com",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: null,
  role: "ADMIN",
  financeAccessLevel: "NONE",
  accessRoles: [{ role: "ADMIN" }],
  ageTier: "ADULT",
  active: true,
  forcePasswordChange: false,
  canLogin: true,
  cancelledAt: null,
  archivedAt: null,
  xeroContactId: null,
  joinedDate: null,
  createdAt: new Date("2025-01-01"),
};

const userTarget = {
  ...adminTarget,
  id: "user2",
  firstName: "Uma",
  lastName: "User",
  email: "uma@test.com",
  role: "USER",
  accessRoles: [{ role: "USER" }],
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

function mockTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation(async (op: any) =>
    op({
      $executeRaw: prisma.$executeRaw,
      member: {
        findUnique: prisma.member.findUnique,
        update: prisma.member.update,
        updateMany: prisma.member.updateMany,
        count: prisma.member.count,
        // #2255: deletion anonymisation now reads who it is about to detach
        // (before nulling their pointers) and sweeps the inheritance aimed at
        // the anonymised member, so it would otherwise keep hard-bouncing club
        // email off the @deleted.invalid address forever.
        // #2716: the member edit reads through the same delegate, re-resolving
        // its own pointer and its dependants' inside the write's transaction.
        findMany: prisma.member.findMany,
      },
      memberAccessRole: {
        createMany: prisma.memberAccessRole.createMany,
        deleteMany: prisma.memberAccessRole.deleteMany,
      },
      familyGroupMember: { deleteMany: prisma.familyGroupMember.deleteMany },
      bookingGuest: { updateMany: prisma.bookingGuest.updateMany },
      // #2620: anonymisation revokes every outstanding credential artefact in
      // the same commit — each authenticates on its own, and deletion used to
      // leave them all live.
      magicLinkToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      passwordResetToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      emailChangeToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      twoFactorEmailCode: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      twoFactorRecoveryCode: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      twoFactorSessionChallenge: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      bedAllocation: (prisma as any).bedAllocation,
      deletionRequest: {
        update: prisma.deletionRequest.update,
        updateMany: prisma.deletionRequest.updateMany,
      },
      xeroSyncOperation: prisma.xeroSyncOperation,
      xeroObjectLink: prisma.xeroObjectLink,
      auditLog: { create: prisma.auditLog.create },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.member.count).mockResolvedValue(0);
  vi.mocked(prisma.member.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.booking.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.deletionRequest.updateMany).mockResolvedValue({ count: 1 });
  mockTransaction();
});

describe("#1604 member edit — PUT /api/admin/members/[id]", () => {
  it("privileged-target: a scoped admin cannot deactivate an admin-holding account (403)", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(adminTarget as any);
    const res = await putMember("admin2", { active: false });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Full Admin/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("privileged-target: a scoped admin cannot disable login for an admin-holding account (403)", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(adminTarget as any);
    const res = await putMember("admin2", { canLogin: false });
    expect(res.status).toBe(403);
  });

  it("privileged-target: a scoped admin CAN deactivate a plain user (200)", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(userTarget as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...userTarget,
      active: false,
    } as any);
    const res = await putMember("user2", { active: false });
    expect(res.status).toBe(200);
  });

  it("last-admin: a Full Admin cannot deactivate the final Full Admin (409)", async () => {
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(adminTarget as any);
    // target is an active Full Admin, and no other one remains
    vi.mocked(prisma.member.count).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const res = await putMember("admin2", { active: false });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/last Full Admin/);
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("last-admin: a Full Admin CAN deactivate the second-to-last Full Admin (200)", async () => {
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(adminTarget as any);
    // target is a Full Admin, but another one remains
    vi.mocked(prisma.member.count).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...adminTarget,
      active: false,
    } as any);
    const res = await putMember("admin2", { active: false });
    expect(res.status).toBe(200);
  });
});

describe("#1604 bulk update — POST /api/admin/members/bulk-update", () => {
  function bulkRequest(body: Record<string, unknown>) {
    return bulkUpdate(
      jsonRequest("http://localhost/api/admin/members/bulk-update", body),
    );
  }

  it("privileged-target: a scoped admin cannot bulk-deactivate an admin-holding account (403)", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    vi.mocked(prisma.member.findMany).mockResolvedValue([adminTarget] as any);
    const res = await bulkRequest({ ids: ["admin2"], action: "deactivate" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Full Admin/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("last-admin end-state: a bulk deactivate that removes every Full Admin fails as a whole (409)", async () => {
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.member.findMany).mockResolvedValue([adminTarget] as any);
    // 1 active Full Admin now, 0 remaining after the set
    vi.mocked(prisma.member.count).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const res = await bulkRequest({ ids: ["admin2"], action: "deactivate" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/every remaining Full Admin/);
    expect(prisma.member.updateMany).not.toHaveBeenCalled();
  });

  it("last-admin end-state: allowed when a Full Admin survives the set (200)", async () => {
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.member.findMany).mockResolvedValue([userTarget] as any);
    vi.mocked(prisma.member.count).mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 1 } as any);
    const res = await bulkRequest({ ids: ["user2"], action: "deactivate" });
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(1);
    expect(prisma.member.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["user2"] }, OR: [{ active: true }, { leavingDate: null }] },
      data: { active: false, leavingDate: expect.any(Date) },
    }));
  });
});

describe("#1604 deletion-request approval — POST /api/admin/deletion-requests/[id]", () => {
  function reviewRequest(id: string, body: Record<string, unknown>) {
    return reviewDeletion(
      jsonRequest(`http://localhost/api/admin/deletion-requests/${id}`, body),
      { params: Promise.resolve({ id }) },
    );
  }

  function pendingRequest(member: Record<string, unknown>) {
    return { id: "dr1", status: "PENDING", member } as any;
  }

  it("privileged-target: a scoped admin cannot approve deletion of an admin-holding account (403)", async () => {
    mockRequireAdmin.mockResolvedValue(scopedAdminGuard);
    vi.mocked(prisma.deletionRequest.findUnique).mockResolvedValue(
      pendingRequest(adminTarget),
    );
    const res = await reviewRequest("dr1", { action: "approve" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Full Admin/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("last-admin: a Full Admin cannot approve deletion of the final Full Admin (409) — the centerpiece case", async () => {
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.deletionRequest.findUnique).mockResolvedValue(
      pendingRequest(adminTarget),
    );
    // pre-check: target is an active Full Admin, none other remains
    vi.mocked(prisma.member.count).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const res = await reviewRequest("dr1", { action: "approve" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/last Full Admin/);
    // fails fast: no booking cleanup and no anonymise transaction ran
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows a Full Admin to approve deletion of a plain user (200)", async () => {
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.deletionRequest.findUnique).mockResolvedValue(
      pendingRequest(userTarget),
    );
    vi.mocked(prisma.member.count).mockResolvedValue(0);
    const res = await reviewRequest("dr1", { action: "approve" });
    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ active: false, leavingDate: new Date("2026-07-01T00:00:00.000Z") }),
    }));
  });
});
