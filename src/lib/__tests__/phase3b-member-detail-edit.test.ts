import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const hostingMocks = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue(0),
  settle: vi.fn().mockResolvedValue(undefined),
}));
const recoveryMocks = vi.hoisted(() => ({
  getMemberContactCreateRecoveryState: vi.fn().mockResolvedValue(null),
  // #2623 T7: member detail also reads the SAME blocker predicate merge and
  // account deletion refuse on, so a linked-but-blocked member cannot render as
  // reconciled.
  findMemberContactChangeMergeBlocker: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    accessRoleDefinition: {
      // Empty definitions: resolution falls back to legacy bundles.
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      // #2282: the member detail GET resolves which ADULT a dependant added
      // under this member would inherit email from, using the same bounded
      // family walk the write paths use. The walk reads "these ids" with
      // `findMany`; defaulted to no rows so a fixture that says nothing about
      // ancestry means exactly that, rather than crashing the walk.
      findMany: vi.fn().mockResolvedValue([]),
    },
    booking: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn(), aggregate: vi.fn() },
    bookingGuest: {
      count: vi.fn().mockResolvedValue(0),
      // #2106: the N/A-flip linked-guest block queries future linked-guest
      // bookings; default to none.
      findMany: vi.fn().mockResolvedValue([]),
    },
    payment: { count: vi.fn().mockResolvedValue(0) },
    paymentRefund: { count: vi.fn().mockResolvedValue(0) },
    paymentRecoveryOperation: { count: vi.fn().mockResolvedValue(0) },
    memberCredit: { count: vi.fn().mockResolvedValue(0) },
    adminCreditAdjustmentRequest: { count: vi.fn().mockResolvedValue(0) },
    refundRequest: { count: vi.fn().mockResolvedValue(0) },
    memberSubscription: { count: vi.fn().mockResolvedValue(0) },
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    membershipSubscriptionCharge: { count: vi.fn().mockResolvedValue(0) },
    membershipSubscriptionBillingSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
    promoCodeAssignment: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    promoRedemption: { count: vi.fn().mockResolvedValue(0) },
    nominationToken: { count: vi.fn().mockResolvedValue(0) },
    memberApplication: { count: vi.fn().mockResolvedValue(0) },
    membershipCancellationRequest: { count: vi.fn().mockResolvedValue(0) },
    membershipCancellationRequestParticipant: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
    familyGroupJoinRequest: { count: vi.fn().mockResolvedValue(0) },
    familyGroupMember: { count: vi.fn().mockResolvedValue(0) },
    hutLeaderAssignment: { count: vi.fn().mockResolvedValue(0) },
    issueReport: { count: vi.fn().mockResolvedValue(0) },
    bookingModification: { count: vi.fn().mockResolvedValue(0) },
    bookingChangeRequest: { count: vi.fn().mockResolvedValue(0) },
    deletionRequest: { count: vi.fn().mockResolvedValue(0) },
    memberLifecycleActionRequest: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    xeroContactCache: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn().mockImplementation((operation: unknown) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return (operation as (tx: unknown) => Promise<unknown>)({
        member: {
          update: vi.fn(),
          // #2716: the member write re-resolves email inheritance inside its
          // own transaction, reading the subjects and then their chosen
          // sources with `findMany`; no rows, so nothing is re-pointed.
          findMany: vi.fn().mockResolvedValue([]),
        },
        memberAccessRole: {
          createMany: vi.fn(),
          deleteMany: vi.fn(),
        },
        auditLog: {
          create: vi.fn(),
        },
      });
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
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
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: hostingMocks.enqueue,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: hostingMocks.settle,
}));
vi.mock("@/lib/xero-contact-create-recovery", () => ({
  getMemberContactCreateRecoveryState:
    recoveryMocks.getMemberContactCreateRecoveryState,
  findMemberContactChangeMergeBlocker:
    recoveryMocks.findMemberContactChangeMergeBlocker,
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { PUT as updateMember, GET as getMemberDetail } from "@/app/api/admin/members/[id]/route";
import {
  buildAccountEditForm,
  buildAccountPayload,
  buildContactEditForm,
  buildContactPayload,
} from "@/lib/admin-member-edit-groups";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

const mockedAuth = vi.mocked(auth);
const adminSession = { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;
const memberSession = { user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }] } } as any;

const baseMember = {
  id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
  phoneCountryCode: null, phoneAreaCode: null, phoneNumber: "021-123", dateOfBirth: new Date("1990-01-15"),
  role: "USER", ageTier: "ADULT", active: true, forcePasswordChange: false,
  financeAccessLevel: "NONE",
  accessRoles: [{ role: "USER" }],
  xeroContactId: null, joinedDate: null, createdAt: new Date("2025-01-01"),
  canLogin: true,
};

function makePutRequest(id: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/admin/members/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("Phase 3b: Member Detail Edit — PUT /api/admin/members/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recoveryMocks.getMemberContactCreateRecoveryState.mockResolvedValue(null);
    recoveryMocks.findMemberContactChangeMergeBlocker.mockResolvedValue(null);
    // #2106: reset the N/A-flip linked-guest query default so a per-test
    // override never leaks into a later test (clearAllMocks keeps implementations).
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (operation: any) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return operation({
        $executeRaw: vi.fn().mockResolvedValue(1),
        member: {
          update: prisma.member.update,
          // #1604 last-admin guard counts active Full Admins inside the
          // transaction; default (undefined) resolves to "not the last admin".
          count: prisma.member.count,
          // #2716: the edit re-resolves email inheritance in the same
          // transaction — the member's own pointer first, then everyone who
          // inherits from them — and both halves read through `findMany`.
          findMany: prisma.member.findMany,
        },
        memberAccessRole: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        // #1756: a deactivate / ADULT→minor tier change sweeps future
        // shared-double placements inside the transaction; no rows here, so
        // the sweep is a no-op.
        bedAllocation: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        auditLog: {
          create: prisma.auditLog.create,
        },
      });
    });
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
    });
  });

  // ── Auth ──

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    mockRequireAdmin.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });
    const res = await updateMember(makePutRequest("m1", { firstName: "Bob" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 401 for non-admin users", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockRequireAdmin.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });
    const res = await updateMember(makePutRequest("m1", { firstName: "Bob" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent member", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(null);
    const res = await updateMember(makePutRequest("nonexistent", { firstName: "Bob" }), { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  // ── Validation ──

  it("returns 422 for invalid email", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    const res = await updateMember(makePutRequest("m1", { email: "not-an-email" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  it("returns 422 for invalid date of birth format", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    const res = await updateMember(makePutRequest("m1", { dateOfBirth: "15/01/1990" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
  });

  it("returns 422 for firstName exceeding max length", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    const res = await updateMember(makePutRequest("m1", { firstName: "A".repeat(101) }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
  });

  // ── Email uniqueness ──

  it("returns 409 when changing to an email already in use", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "other" } as any);

    const res = await updateMember(makePutRequest("m1", { email: "taken@test.com" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
  });

  it("allows keeping the same email (no conflict check against self)", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { email: "alice@test.com" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    // findFirst for email check should not have been called since email is unchanged
    expect(prisma.member.findFirst).not.toHaveBeenCalled();
  });

  // ── #2385: enabling login claims the address as a login identity ──

  // The Account & Access form posts canLogin/active/roles and NO email
  // (buildAccountPayload), so this is the exact shape of a real "tick Can
  // Login" save: the address is unchanged, but it becomes a login identity.
  const noLoginMember = { ...baseMember, canLogin: false, accessRoles: [] };

  it("returns 409 when enabling login on an email another member already logs in with", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(noLoginMember as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "other" } as any);

    const res = await updateMember(
      makePutRequest("m1", { canLogin: true, active: true, role: "USER", accessRoles: ["USER"] }),
      { params: Promise.resolve({ id: "m1" }) }
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "A member with this email already exists",
    });
    // The member's own stored address is what gets checked — the payload carries none.
    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: { email: "alice@test.com", canLogin: true, id: { not: "m1" } },
    });
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("allows enabling login when no one else logs in with that email", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(noLoginMember as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...noLoginMember,
      canLogin: true,
      accessRoles: [{ role: "USER" }],
      xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { canLogin: true, active: true, role: "USER", accessRoles: ["USER"] }),
      { params: Promise.resolve({ id: "m1" }) }
    );

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ canLogin: true }),
    }));
  });

  it("returns the same 409 when a concurrent write claims the login email first", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(noLoginMember as any);
    // The pre-check passes: nobody holds the address when it runs.
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    // Between the check and the write, another admin enables login on the same
    // address, so the partial unique index Member_email_login_unique rejects
    // this update. This is the shape Prisma 7 raises through the pg driver
    // adapter: the SQLSTATE 23505 "Key (email)=…" detail becomes a field list,
    // and meta.target is not populated.
    vi.mocked(prisma.member.update).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), {
        code: "P2002",
      })
    );

    const res = await updateMember(
      makePutRequest("m1", { canLogin: true, active: true, role: "USER", accessRoles: ["USER"] }),
      { params: Promise.resolve({ id: "m1" }) }
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "A member with this email already exists",
    });
  });

  it("does not blame the email for a unique-constraint failure on another column", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed on the fields: (`googleSub`)"), {
        code: "P2002",
      })
    );

    const res = await updateMember(makePutRequest("m1", { firstName: "Bob" }), {
      params: Promise.resolve({ id: "m1" }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "Failed to update member",
    });
  });

  it("returns the fixed 409 when member fan-out participant fencing rolls back an account change", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      active: false,
      xeroContactId: null,
    } as any);
    hostingMocks.enqueue.mockRejectedValueOnce(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await updateMember(
      makePutRequest("m1", {
        active: false,
        canLogin: true,
        role: "USER",
        accessRoles: ["USER"],
      }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });
    expect(hostingMocks.settle).not.toHaveBeenCalled();
  });

  // Every shape a unique-constraint failure can arrive in. Which one the RAW
  // PARTIAL index Member_email_login_unique sends is settled (#2412, measured):
  // it reports its COLUMN in `meta.driverAdapterError.cause.constraint.fields`
  // exactly as a schema-level `@unique` does — the two index kinds are
  // indistinguishable, and `meta.target` is never populated under the driver
  // adapter. See docs/ARCHITECTURE.md, "Reading a unique-constraint failure".
  // The cases below keep the other shapes pinned anyway, because the backstop
  // still reads them: `meta.target` for a stack without the adapter, the
  // rendered message for a Postgres that withholds the `Key (…)` detail. The
  // live adapter shape itself is pinned in
  // prisma-unique-constraint-target.test.ts.
  const p2002 = (message: string, meta?: { target?: unknown }) =>
    Object.assign(new Error(message), {
      code: "P2002",
      ...(meta ? { meta } : {}),
    });

  const wrappedInvocationMessage = (column: string) =>
    [
      "",
      "Invalid `prisma.member.update()` invocation in",
      "/app/src/lib/admin-member-detail-service.ts:1278:44",
      "",
      "  1275 }",
      "  1276",
      "  1277 const updatedMember = await tx.member.update({",
      '→ 1278   where: { id: "m1" },',
      `Unique constraint failed on the fields: (\`${column}\`)`,
    ].join("\n");

  const backstopShapes = [
    // The meta.target cases carry a message that says the OPPOSITE, so they
    // fail if that branch is ever dropped or loses its precedence over the
    // message.
    {
      name: "meta.target as a field-name array",
      error: p2002(
        "Unique constraint failed on the constraint: `Member_googleSub_key`",
        { target: ["email"] },
      ),
      status: 409,
    },
    {
      name: "meta.target as a constraint-name string",
      error: p2002("Unique constraint failed on the fields: (`googleSub`)", {
        target: "Member_email_login_unique",
      }),
      status: 409,
    },
    {
      name: "meta.target naming a different column",
      error: p2002("Unique constraint failed on the fields: (`email`)", {
        target: ["googleSub"],
      }),
      status: 500,
    },
    {
      name: "a `constraint:` index name in the message",
      error: p2002(
        "Unique constraint failed on the constraint: `Member_email_login_unique`",
      ),
      status: 409,
    },
    {
      name: "a `constraint:` index name for a different column",
      error: p2002(
        "Unique constraint failed on the constraint: `Member_googleSub_key`",
      ),
      status: 500,
    },
    // The client wraps the sentence in an invocation preamble and a source
    // excerpt, so the field list has to be found anywhere in the message, not
    // just at the start. Both wrapped cases are pinned because only the
    // non-email one can fail if the match is ever anchored — an unfound field
    // list falls back to "unidentifiable", which is 409 either way.
    {
      name: "the wrapped invocation message the client really throws",
      error: p2002(wrappedInvocationMessage("email")),
      status: 409,
    },
    {
      name: "a wrapped invocation message naming a different column",
      error: p2002(wrappedInvocationMessage("googleSub")),
      status: 500,
    },
    {
      // Documented behaviour: this write can produce no other collision, so an
      // unidentifiable P2002 is still explained rather than left opaque.
      name: "a P2002 that names nothing identifiable",
      error: p2002("Unique constraint failed"),
      status: 409,
    },
  ];

  it.each(backstopShapes)(
    "maps a concurrent-write P2002 reported as $name to $status",
    async ({ error, status }) => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue(
        noLoginMember as any,
      );
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.member.update).mockRejectedValue(error);

      const res = await updateMember(
        makePutRequest("m1", { canLogin: true, active: true, role: "USER", accessRoles: ["USER"] }),
        { params: Promise.resolve({ id: "m1" }) }
      );

      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toMatchObject({
        error:
          status === 409
            ? "A member with this email already exists"
            : "Failed to update member",
      });
    },
  );

  // ── Successful updates ──

  it("updates firstName and lastName", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, firstName: "Bob", lastName: "Jones", xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { firstName: "Bob", lastName: "Jones" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firstName).toBe("Bob");
    expect(body.lastName).toBe("Jones");

    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "m1" },
      data: expect.objectContaining({ firstName: "Bob", lastName: "Jones" }),
    }));
  });

  it("updates role from USER to ADMIN", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, role: "ADMIN", xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { role: "ADMIN" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "ADMIN" }),
    }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "admin.member.updated",
        actorMemberId: "admin1",
        subjectMemberId: "m1",
        category: "admin",
        severity: "critical",
        metadata: expect.objectContaining({
          changedFields: expect.arrayContaining(["role", "accessRoles"]),
          accessChanges: expect.arrayContaining([
            {
              field: "role",
              before: "USER",
              after: "ADMIN",
            },
            {
              field: "accessRoles",
              before: ["USER"],
              after: ["ADMIN"],
            },
          ]),
        }),
      }),
    });
  });

  it("updates finance access level", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      financeAccessLevel: "MANAGER",
      xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { financeAccessLevel: "MANAGER" }),
      { params: Promise.resolve({ id: "m1" }) }
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ financeAccessLevel: "MANAGER" }),
      })
    );
  });

  it("syncs explicit mixed lodge finance access roles on edit", async () => {
    let createManyArgs: any;
    let deleteManyArgs: any;
    vi.mocked(prisma.$transaction).mockImplementation(async (operation: any) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return operation({
        member: {
          update: prisma.member.update,
          count: prisma.member.count,
          // #2716: as above — the access-role edit still re-resolves email
          // inheritance inside the transaction, and that reads with `findMany`.
          findMany: prisma.member.findMany,
        },
        memberAccessRole: {
          createMany: vi.fn().mockImplementation(async (args: any) => {
            createManyArgs = args;
            return { count: args.data.length };
          }),
          deleteMany: vi.fn().mockImplementation(async (args: any) => {
            deleteManyArgs = args;
            return { count: 1 };
          }),
        },
        auditLog: {
          create: prisma.auditLog.create,
        },
      });
    });
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      role: "LODGE",
      financeAccessLevel: "VIEWER",
      accessRoles: [{ role: "LODGE" }, { role: "FINANCE_USER" }],
      xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { accessRoles: ["LODGE", "FINANCE_USER"] }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1" },
        data: expect.objectContaining({
          role: "LODGE",
          financeAccessLevel: "VIEWER",
        }),
      }),
    );
    expect(deleteManyArgs).toEqual({ where: { memberId: "m1" } });
    expect(createManyArgs).toEqual({
      data: [
        {
          memberId: "m1",
          role: "LODGE",
          roleDefinitionId: null,
          assignedByMemberId: "admin1",
        },
        {
          memberId: "m1",
          role: "FINANCE_USER",
          roleDefinitionId: null,
          assignedByMemberId: "admin1",
        },
      ],
      skipDuplicates: true,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "admin.member.updated",
        actorMemberId: "admin1",
        subjectMemberId: "m1",
        metadata: expect.objectContaining({
          changedFields: expect.arrayContaining([
            "role",
            "financeAccessLevel",
            "accessRoles",
          ]),
        }),
      }),
    });
  });

  it("forces finance access to NONE when updating a LODGE member", async () => {
    const lodgeMember = {
      ...baseMember,
      id: "lodge-1",
      role: "LODGE",
      financeAccessLevel: "VIEWER",
    };
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(lodgeMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...lodgeMember,
      firstName: "Lodge",
      financeAccessLevel: "NONE",
      xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("lodge-1", {
        firstName: "Lodge",
        financeAccessLevel: "MANAGER",
      }),
      { params: Promise.resolve({ id: "lodge-1" }) }
    );

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-1" },
        data: expect.objectContaining({
          firstName: "Lodge",
          financeAccessLevel: "NONE",
        }),
      })
    );
  });

  it("sets forcePasswordChange to true", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, forcePasswordChange: true, xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { forcePasswordChange: true }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ forcePasswordChange: true }),
    }));
  });

  it("deactivates member successfully", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, active: false, xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { active: false }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    // No cascade deactivation — family group model replaces parent/dependent
    expect(prisma.member.updateMany).not.toHaveBeenCalled();
    expect(hostingMocks.enqueue).toHaveBeenCalledWith(
      "m1",
      expect.any(Object),
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE", actorMemberId: "admin1" },
    );
    expect(hostingMocks.settle).toHaveBeenCalledWith({ limit: 50 });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "admin.member.deactivated",
        actorMemberId: "admin1",
        subjectMemberId: "m1",
        metadata: expect.objectContaining({
          changedFields: ["active"],
          accessChanges: [
            {
              field: "active",
              before: true,
              after: false,
            },
          ],
        }),
      }),
    });
  });

  it("clears dateOfBirth when empty string is passed", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, dateOfBirth: null, xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { dateOfBirth: "" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dateOfBirth: null }),
    }));
  });

  it("updates dateOfBirth and recomputes ageTier", async () => {
    const { computeAgeTier } = await import("@/lib/age-tier");
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, xeroContactId: null } as any);

    await updateMember(makePutRequest("m1", { dateOfBirth: "2010-06-15" }), { params: Promise.resolve({ id: "m1" }) });

    expect(computeAgeTier).toHaveBeenCalled();
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dateOfBirth: new Date("2010-06-15"), ageTier: "ADULT" }),
    }));
  });

  it("honours an explicit age-tier pick even when a DOB change rides along (#2106 MINOR-6)", async () => {
    // computeAgeTier is mocked to ADULT; before MINOR-6 the DOB-derived ADULT
    // silently overrode the explicit YOUTH pick. Now the explicit pick wins and
    // the DOB-derived tier is only the fallback.
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, ageTier: "YOUTH", xeroContactId: null } as any);

    await updateMember(
      makePutRequest("m1", { dateOfBirth: "2010-06-15", ageTier: "YOUTH" }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dateOfBirth: new Date("2010-06-15"),
        ageTier: "YOUTH",
      }),
    }));
  });

  it("blocks flipping a member to N/A (org grant) while they hold future linked-guest bookings (#2106 MAJOR-5a)", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([
      {
        id: "bg1",
        bookingId: "b1",
        stayStart: new Date("2026-08-01"),
        stayEnd: new Date("2026-08-05"),
        booking: {
          id: "b1",
          memberId: "owner-2",
          checkIn: new Date("2026-08-01"),
          checkOut: new Date("2026-08-05"),
        },
      },
    ] as any);

    // USER -> SCHOOL is an org grant, which forces the member to N/A.
    const res = await updateMember(makePutRequest("m1", { role: "SCHOOL" }), {
      params: Promise.resolve({ id: "m1" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/linked guest/i);
    expect(body.linkedGuestBookings.count).toBe(1);
    // Blocked before the write transaction — the member row is never updated.
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("trims whitespace from firstName and lastName", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, firstName: "Bob", lastName: "Jones", xeroContactId: null } as any);

    await updateMember(makePutRequest("m1", { firstName: "  Bob  ", lastName: "  Jones  " }), { params: Promise.resolve({ id: "m1" }) });

    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ firstName: "Bob", lastName: "Jones" }),
    }));
  });

  // ── Per-group inline-edit payloads (member detail page) ──
  // The detail page saves each group with only that group's fields; these
  // pin the server-side effect of those scoped payloads.

  const contactSource = {
    title: null, firstName: "Alice", lastName: "Smith", gender: null,
    email: "alice@test.com", phoneCountryCode: null, phoneAreaCode: null,
    phoneNumber: "021-123", dateOfBirth: "1990-01-15T00:00:00.000Z",
    joinedDate: null, occupation: null, comments: null, ageTier: "ADULT",
    streetAddressLine1: null, streetAddressLine2: null, streetCity: null,
    streetRegion: null, streetPostalCode: null, streetCountry: null,
    postalAddressLine1: null, postalAddressLine2: null, postalCity: null,
    postalRegion: null, postalPostalCode: null, postalCountry: null,
  };

  it("a contact-group payload never touches access, auth, or lifeMemberDate columns", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, xeroContactId: null } as any);

    const payload = buildContactPayload(buildContactEditForm(contactSource));
    const res = await updateMember(makePutRequest("m1", payload), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);

    const updateArgs = vi.mocked(prisma.member.update).mock.calls[0][0] as { data: Record<string, unknown> };
    const dataKeys = Object.keys(updateArgs.data);
    for (const forbidden of ["role", "financeAccessLevel", "canLogin", "active", "forcePasswordChange", "requiresInduction", "inheritEmailFromId", "lifeMemberDate"]) {
      expect(dataKeys, `contact save must not write ${forbidden}`).not.toContain(forbidden);
    }
    expect(updateArgs.data.firstName).toBe("Alice");
  });

  it("an account-group payload never touches contact columns", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, xeroContactId: null } as any);

    const payload = buildAccountPayload(
      buildAccountEditForm({
        canLogin: true, active: true, forcePasswordChange: true,
        requiresInduction: false, inheritEmailFromId: null,
        accessRoles: ["USER"], role: "USER", financeAccessLevel: "NONE",
      }),
    );
    const res = await updateMember(makePutRequest("m1", payload), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);

    const updateArgs = vi.mocked(prisma.member.update).mock.calls[0][0] as { data: Record<string, unknown> };
    const dataKeys = Object.keys(updateArgs.data);
    for (const forbidden of ["email", "firstName", "lastName", "phoneNumber", "dateOfBirth", "comments", "streetAddressLine1", "lifeMemberDate"]) {
      expect(dataKeys, `account save must not write ${forbidden}`).not.toContain(forbidden);
    }
    expect(updateArgs.data.forcePasswordChange).toBe(true);
  });

  it("calls updateXeroContact when member contact fields change and Xero is connected", async () => {
    const { isXeroConnected, updateXeroContact } = await import("@/lib/xero");
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, phoneNumber: "022-456", xeroContactId: "xc1" } as any);

    await updateMember(makePutRequest("m1", { phoneNumber: "022-456" }), { params: Promise.resolve({ id: "m1" }) });

    expect(updateXeroContact).toHaveBeenCalledWith(
      "xc1",
      expect.objectContaining({ phoneNumber: "022-456" }),
      expect.objectContaining({
        localModel: "Member",
        localId: "m1",
        createdByMemberId: "admin1",
        preserveXeroName: true,
      })
    );
  });

  it("does not call updateXeroContact when only the member name changes", async () => {
    const {
      isXeroConnected,
      syncManagedXeroContactGroupForMember,
      updateXeroContact,
    } = await import("@/lib/xero");

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, xeroContactId: "xc1" } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      firstName: "Bob",
      xeroContactId: "xc1",
    } as any);

    await updateMember(makePutRequest("m1", { firstName: "Bob" }), { params: Promise.resolve({ id: "m1" }) });

    expect(isXeroConnected).not.toHaveBeenCalled();
    expect(updateXeroContact).not.toHaveBeenCalled();
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("does not call updateXeroContact when only local-only fields change", async () => {
    const {
      isXeroConnected,
      syncManagedXeroContactGroupForMember,
      updateXeroContact,
    } = await import("@/lib/xero");

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, xeroContactId: "xc1" } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      forcePasswordChange: true,
      xeroContactId: "xc1",
    } as any);

    // forcePasswordChange is a purely local field: it is neither a Xero contact
    // field nor grouping-relevant, so it must not touch Xero at all.
    await updateMember(makePutRequest("m1", { forcePasswordChange: true }), { params: Promise.resolve({ id: "m1" }) });

    expect(isXeroConnected).not.toHaveBeenCalled();
    expect(updateXeroContact).not.toHaveBeenCalled();
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("does not call updateXeroContact when Xero is not connected", async () => {
    const {
      isXeroConnected,
      syncManagedXeroContactGroupForMember,
      updateXeroContact,
    } = await import("@/lib/xero");
    vi.mocked(isXeroConnected).mockResolvedValue(false);

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, phoneNumber: "022-456", xeroContactId: "xc1" } as any);

    await updateMember(makePutRequest("m1", { phoneNumber: "022-456" }), { params: Promise.resolve({ id: "m1" }) });

    expect(updateXeroContact).not.toHaveBeenCalled();
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("syncs managed Xero contact groups when the member age tier changes", async () => {
    const { isXeroConnected, syncManagedXeroContactGroupForMember } = await import("@/lib/xero");
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
      ageTier: "CHILD",
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
      ageTier: "YOUTH",
    } as any);

    await updateMember(makePutRequest("m1", { ageTier: "YOUTH" }), {
      params: Promise.resolve({ id: "m1" }),
    });

    expect(syncManagedXeroContactGroupForMember).toHaveBeenCalledWith("m1", {
      createdByMemberId: "admin1",
    });
    expect(hostingMocks.enqueue).toHaveBeenCalledWith(
      "m1",
      expect.any(Object),
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE", actorMemberId: "admin1" },
    );
    expect(hostingMocks.settle).toHaveBeenCalledWith({ limit: 50 });
  });

  it("syncs managed Xero contact groups when a role change alters the role-default membership type", async () => {
    const { isXeroConnected, syncManagedXeroContactGroupForMember } = await import("@/lib/xero");
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
      role: "USER",
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
      role: "SCHOOL",
    } as any);

    // USER -> SCHOOL flips the role-default membership type (FULL -> SCHOOL),
    // which changes the member's effective type for grouping when they have
    // no current-season assignment (E8, #1934).
    await updateMember(makePutRequest("m1", { role: "SCHOOL" }), {
      params: Promise.resolve({ id: "m1" }),
    });

    expect(syncManagedXeroContactGroupForMember).toHaveBeenCalledWith("m1", {
      createdByMemberId: "admin1",
    });
  });

  it("does not sync contact groups when a role change leaves an explicitly-assigned member's effective type unchanged", async () => {
    const { syncManagedXeroContactGroupForMember } = await import("@/lib/xero");

    mockedAuth.mockResolvedValue(adminSession);
    // #2149: membership type resolved assignment-first is the sole grouping
    // authority. This member has an explicit current-season assignment, so the
    // role default is NOT their effective type. A USER->ADMIN role change (which
    // would flip the role-default type FULL->ADMIN for an unassigned member)
    // therefore re-groups nothing and must not trigger a contact-group sync.
    vi.mocked(prisma.seasonalMembershipAssignment.findUnique).mockResolvedValueOnce({
      membershipType: { allowedAgeTiers: [{ ageTier: "ADULT" }] },
    } as any);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, xeroContactId: "xc1", role: "USER" } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      role: "ADMIN",
      xeroContactId: "xc1",
    } as any);

    await updateMember(makePutRequest("m1", { role: "ADMIN" }), { params: Promise.resolve({ id: "m1" }) });

    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("blocks self-demotion via the API", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, id: "admin1", role: "ADMIN" } as any);

    const res = await updateMember(makePutRequest("admin1", { role: "USER" }), { params: Promise.resolve({ id: "admin1" }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/demote your own admin account/i),
    });
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("blocks self-deactivation via the API", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, id: "admin1", role: "ADMIN" } as any);

    const res = await updateMember(makePutRequest("admin1", { active: false }), { params: Promise.resolve({ id: "admin1" }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/deactivate your own account/i),
    });
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("blocks disabling login for the current admin", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, id: "admin1", role: "ADMIN", canLogin: true } as any);

    const res = await updateMember(makePutRequest("admin1", { canLogin: false }), { params: Promise.resolve({ id: "admin1" }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/disable login/i),
    });
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  // ── GET endpoint ──

  it("GET returns forcePasswordChange field", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      forcePasswordChange: true,
      subscriptions: [],
      familyGroupMemberships: [],
    } as any);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.aggregate).mockResolvedValue({
      _sum: { finalPriceCents: null }, _count: 0, _max: { checkOut: null },
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/m1");
    const res = await getMemberDetail(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forcePasswordChange).toBe(true);
  });

  it("GET propagates the authoritative Xero contact-create recovery proof", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    recoveryMocks.getMemberContactCreateRecoveryState.mockResolvedValue(
      "PROVIDER_CREATED_LINK_PENDING",
    );
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      subscriptions: [],
      familyGroupMemberships: [],
    } as any);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.aggregate).mockResolvedValue({
      _sum: { finalPriceCents: null }, _count: 0, _max: { checkOut: null },
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/m1");
    const res = await getMemberDetail(req, {
      params: Promise.resolve({ id: "m1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      xeroContactCreateRecoveryState: "PROVIDER_CREATED_LINK_PENDING",
      xeroContactCreateRecoveryPending: true,
    });
    expect(
      recoveryMocks.getMemberContactCreateRecoveryState,
    ).toHaveBeenCalledWith({
      memberId: "m1",
      xeroContactId: null,
    });
  });

  /**
   * #2623 T7. The create-recovery state deliberately reports nothing once the
   * member is linked, and it used to be the ONLY Xero signal on this payload.
   * So a member who had been recovered — link repaired, page clean — kept being
   * refused for member merge and account deletion by an operation nobody could
   * see. The payload now also carries the blocker itself, read from the same
   * predicate those refusals use.
   */
  it("GET surfaces the lifecycle blocker for a LINKED member whose create is still open", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    recoveryMocks.getMemberContactCreateRecoveryState.mockResolvedValue(null);
    recoveryMocks.findMemberContactChangeMergeBlocker.mockResolvedValue({
      operationId: "xero-op-open",
      operationType: "CREATE",
      status: "FAILED",
      providerContactId: "contact-provider",
    });
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      xeroContactId: "contact-linked",
      subscriptions: [],
      familyGroupMemberships: [],
    } as any);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.aggregate).mockResolvedValue({
      _sum: { finalPriceCents: null }, _count: 0, _max: { checkOut: null },
    } as any);

    const res = await getMemberDetail(
      new NextRequest("http://localhost/api/admin/members/m1"),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      xeroContactId: "contact-linked",
      // The old signal is still silent for a linked member...
      xeroContactCreateRecoveryState: null,
      xeroContactCreateRecoveryPending: false,
      // ...and the refusal is no longer invisible.
      xeroContactLifecycleBlocker: {
        operationId: "xero-op-open",
        operationType: "CREATE",
        status: "FAILED",
        providerContactId: "contact-provider",
      },
    });
    expect(
      recoveryMocks.findMemberContactChangeMergeBlocker,
    ).toHaveBeenCalledWith("m1");
  });

  it("GET preserves ambiguous stale-reset contact-create recovery without a provider claim", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    recoveryMocks.getMemberContactCreateRecoveryState.mockResolvedValue(
      "CREATE_IN_PROGRESS",
    );
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      subscriptions: [],
      familyGroupMemberships: [],
    } as any);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.aggregate).mockResolvedValue({
      _sum: { finalPriceCents: null }, _count: 0, _max: { checkOut: null },
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/m1");
    const res = await getMemberDetail(req, {
      params: Promise.resolve({ id: "m1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      xeroContactCreateRecoveryState: "CREATE_IN_PROGRESS",
      xeroContactCreateRecoveryPending: false,
    });
  });

  it("GET returns committee assignments as a separate member detail axis", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      subscriptions: [],
      familyGroupMemberships: [],
      committeeAssignments: [
        {
          id: "assign1",
          memberId: "m1",
          committeeRoleId: "role1",
          blurb: "Current president.",
          sortOrder: 0,
          published: false,
          showPhone: false,
          contactable: false,
          isActive: true,
          assignedByMemberId: "admin1",
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
          committeeRole: {
            id: "role1",
            key: "president",
            name: "President",
            description: "Chairs meetings.",
            isActive: true,
            sortOrder: 0,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            _count: { assignments: 1 },
          },
          member: {
            id: "m1",
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@test.com",
            phoneCountryCode: "64",
            phoneAreaCode: "21",
            phoneNumber: "123",
            role: "MEMBER",
            active: true,
          },
          assignedBy: null,
        },
      ],
    } as any);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.aggregate).mockResolvedValue({
      _sum: { finalPriceCents: null }, _count: 0, _max: { checkOut: null },
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/m1");
    const res = await getMemberDetail(req, {
      params: Promise.resolve({ id: "m1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("USER");
    expect(body.committeeAssignments[0]).toMatchObject({
      committeeRole: { name: "President" },
      published: false,
      member: { displayName: "Alice Smith" },
    });
  });
});
