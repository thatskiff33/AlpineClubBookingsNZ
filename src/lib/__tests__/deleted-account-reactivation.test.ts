/**
 * #2620 — an approved account deletion must leave no way back to a session.
 *
 * The defect this suite exists for was not a wrong field write anywhere. Both
 * halves were individually reasonable:
 *
 *   - deletion approval anonymises the member and sets `active: false`, leaving
 *     `canLogin`, `googleSub`, `emailVerified` and the second factor in place
 *     and stamping neither `cancelledAt` nor `archivedAt`;
 *   - bulk **Reactivate** refuses an archived or cancelled member and otherwise
 *     sets `active: true`.
 *
 * Put together they handed the erased person a working login, with their
 * retained admin roles. Unit-testing either half in isolation passes. So the
 * headline test here is the COMBINATION: it drives the real deletion-approval
 * route, captures the anonymisation payload that route actually writes, applies
 * it to a live member row, and then walks every path that could give that row a
 * session — bulk reactivate, the member edit service, password login, magic-link
 * login, Google login, and the per-request session refresh — asserting each one
 * refuses. If a future change to the anonymisation write, to a reactivation
 * guard, or to a login provider re-opens the gap, this test is what notices.
 *
 * `@/lib/auth` is deliberately NOT mocked here (the login providers are the
 * subject); `@/lib/session-guards` is mocked instead, which is the only thing
 * that pulls `auth()` into the three routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockRequireAdmin,
  mockSendAccountDeletionApprovedEmail,
  mockBcryptCompare,
  mockLoadEffectiveModuleFlags,
  mockNextAuth,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockSendAccountDeletionApprovedEmail: vi.fn().mockResolvedValue(undefined),
  // Always "the password matched", so a refusal below can only be the
  // deleted-account guard and never a wrong password.
  mockBcryptCompare: vi.fn().mockResolvedValue(true),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockNextAuth: vi.fn(() => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
    unstable_update: vi.fn(),
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    magicLinkToken: { findUnique: vi.fn(), updateMany: vi.fn() },
    // #2597 introduced the durable PENDING -> APPROVAL_IN_PROGRESS claim, which
    // is taken through `updateMany` on the outer client before the first
    // cancellation commits; the count decides whether this caller owns it.
    deletionRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // Read by the account-deletion Xero fence (#2597); no operation in flight.
    xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) },
    booking: { findMany: vi.fn() },
    bookingGuest: { updateMany: vi.fn() },
    familyGroupMember: { deleteMany: vi.fn() },
    bedAllocation: { findMany: vi.fn(), deleteMany: vi.fn() },
    accessRoleDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    memberAccessRole: { createMany: vi.fn(), deleteMany: vi.fn() },
    seasonalMembershipAssignment: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    auditLog: { create: vi.fn(), findMany: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  },
}));

// The only thing that would otherwise pull the real auth() into these routes.
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mockRequireAdmin,
  requireActiveSession: vi.fn(),
  requireActiveSessionUser: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => "test-secret"),
  getAuthTrustHost: vi.fn(() => true),
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((config) => config),
}));

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((config) => ({ id: "google", type: "oidc", ...config })),
}));

vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "CREDENTIALS_SIGNIN";
  }
  return { default: mockNextAuth, CredentialsSignin };
});

vi.mock("bcryptjs", () => ({
  default: {
    compare: mockBcryptCompare,
    hash: vi.fn().mockResolvedValue("$2b$12$hashed"),
  },
}));

// Partial: `admin-modules` re-exports other members of this module at load time.
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/module-settings")>()),
  loadEffectiveModuleFlags: mockLoadEffectiveModuleFlags,
}));

vi.mock("@/lib/two-factor", () => ({
  consumeTwoFactorSessionChallenge: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditEmailDomain: vi.fn(
    (email?: string | null) => email?.split("@")[1]?.toLowerCase() ?? null,
  ),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
}));

vi.mock("@/lib/email", () => ({
  sendAccountDeletionApprovedEmail: mockSendAccountDeletionApprovedEmail,
  sendAccountDeletionRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPartnerShareSweptAlert: vi.fn().mockResolvedValue(undefined),
  sendMemberSetupInviteEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn().mockResolvedValue({ status: 200, data: {} }),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" "),
}));

vi.mock("@/lib/xero", () => ({
  getXeroContactGroupMemberships: vi.fn().mockResolvedValue({}),
  getXeroContactIdsForGroup: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: vi.fn(async () => 0),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));

import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { authConfig } from "@/lib/auth";
import { resolveGoogleProfile } from "@/lib/google-oauth";
import { updateAdminMember } from "@/lib/admin-member-detail-service";
import { POST as bulkUpdate } from "@/app/api/admin/members/bulk-update/route";
import { POST as approveDeletionRequest } from "@/app/api/admin/deletion-requests/[id]/route";
import {
  DELETED_ACCOUNT_BULK_REACTIVATE_MESSAGE,
  DELETED_ACCOUNT_EDIT_REACTIVATE_MESSAGE,
  DELETED_ACCOUNT_PASSWORD_HASH,
  isDeletedAccountEmail,
  isDeletedAccountRecord,
} from "@/lib/deleted-account";

const mockedPrisma = vi.mocked(prisma, true);

const ADMIN_SESSION = {
  user: {
    id: "admin-1",
    email: "admin@example.com",
    role: "ADMIN",
    accessRoles: [{ role: "ADMIN" }],
    adminPermissionMatrix: undefined,
  },
} as never;

/** A perfectly ordinary, live, login-capable member — the "before" row. */
function liveMember(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    passwordHash: "$2b$12$realbcrypthashvalueforjane00000000000000000000000000",
    role: "MEMBER",
    financeAccessLevel: "NONE",
    ageTier: "ADULT",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    active: true,
    canLogin: true,
    emailVerified: true,
    forcePasswordChange: false,
    passwordChangedAt: null,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    postLoginLanding: null,
    googleSub: "google-sub-jane",
    cancelledAt: null,
    archivedAt: null,
    xeroContactId: null,
    inheritEmailFromId: null,
    inheritParentEmail: false,
    billingFamilyGroupId: null,
    parentMemberId: null,
    secondaryParentId: null,
    accessRoles: [{ role: "ADMIN", accessRoleDefinitionId: null }],
    ...overrides,
  };
}

/**
 * Drive the REAL deletion-approval route and return the `data` payload it wrote
 * over the member row. Nothing here restates what anonymisation does — the
 * route is the authority, and the point of capturing it is that the refusal
 * assertions below are made against whatever it genuinely leaves behind.
 */
async function captureAnonymisationPayload(): Promise<Record<string, unknown>> {
  mockRequireAdmin.mockResolvedValue({ ok: true, session: ADMIN_SESSION });
  mockedPrisma.deletionRequest.findUnique.mockResolvedValue({
    id: "dr1",
    status: "PENDING",
    member: {
      id: "m1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      role: "MEMBER",
      financeAccessLevel: "NONE",
      active: true,
      accessRoles: [],
    },
  } as never);
  // wouldRemoveLastFullAdmin: the target is not an active Full Admin, so the
  // guard short-circuits without stranding the club.
  mockedPrisma.member.count.mockResolvedValue(0 as never);
  mockedPrisma.booking.findMany.mockResolvedValue([] as never);

  const memberUpdate = vi.fn().mockResolvedValue({} as never);
  // #2620 half B: every outstanding credential artefact is revoked in the same
  // commit as the anonymisation. Captured so the combination test can prove it
  // happened rather than assuming it.
  const revokedTokens = {
    magicLinkToken: vi.fn().mockResolvedValue({ count: 0 }),
    passwordResetToken: vi.fn().mockResolvedValue({ count: 0 }),
    emailChangeToken: vi.fn().mockResolvedValue({ count: 0 }),
    twoFactorEmailCode: vi.fn().mockResolvedValue({ count: 0 }),
    twoFactorRecoveryCode: vi.fn().mockResolvedValue({ count: 0 }),
    twoFactorSessionChallenge: vi.fn().mockResolvedValue({ count: 0 }),
  };
  mockedPrisma.$transaction.mockImplementation((async (
    fn: (client: unknown) => unknown,
  ) => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      member: {
        count: vi.fn().mockResolvedValue(0),
        update: memberUpdate,
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        // Read under the lock by #2597's account-deletion Xero fence. The member
        // is still live at this point in the transaction — it is this very
        // statement that is about to anonymise them — so the fence must see the
        // pre-anonymisation row and allow the write through.
        findUnique: vi.fn().mockResolvedValue(liveMember()),
      },
      familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      bookingGuest: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      // #2597 deactivates the canonical Xero CONTACT link in the same commit.
      xeroObjectLink: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      magicLinkToken: { deleteMany: revokedTokens.magicLinkToken },
      passwordResetToken: { deleteMany: revokedTokens.passwordResetToken },
      emailChangeToken: { deleteMany: revokedTokens.emailChangeToken },
      twoFactorEmailCode: { deleteMany: revokedTokens.twoFactorEmailCode },
      twoFactorRecoveryCode: {
        deleteMany: revokedTokens.twoFactorRecoveryCode,
      },
      twoFactorSessionChallenge: {
        deleteMany: revokedTokens.twoFactorSessionChallenge,
      },
      // The APPROVAL_IN_PROGRESS -> APPROVED finalisation is claimed inside the
      // transaction, guarded on still owning it.
      deletionRequest: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    return fn(tx);
  }) as never);

  const res = await approveDeletionRequest(
    new NextRequest("http://localhost/api/admin/deletion-requests/dr1", {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "dr1" }) },
  );
  // Carry the body AND the logged cause into the failure message: this route
  // answers 500 with a generic body for any unmocked dependency, and a bare
  // "expected 500 to be 200" sends the next person guessing at which one.
  const loggedCause =
    res.status === 200
      ? ""
      : ` | logged: ${JSON.stringify(
          (logger.error as unknown as { mock: { calls: unknown[][] } }).mock
            .calls.map((call) => {
              const [context] = call as [{ err?: unknown }?];
              const err = context?.err;
              return err instanceof Error ? err.message : String(err);
            }),
        )}`;
  expect(res.status, `${await res.clone().text()}${loggedCause}`).toBe(200);
  expect(memberUpdate).toHaveBeenCalledTimes(1);

  const data = (
    memberUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
  ).data;

  // #2620 half B: the write itself must strip every credential, so `active` is
  // no longer the only thing standing between an erased member and a session.
  // Asserted on the REAL route's payload, not a fixture, so it cannot drift.
  expect(data).toMatchObject({
    canLogin: false,
    googleSub: null,
    emailVerified: false,
    totpSecret: null,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    twoFactorEnrolledAt: null,
    twoFactorLockedUntil: null,
  });

  // ...and every artefact that authenticates on its own is revoked in the same
  // commit, because deletion previously left live magic links and unused
  // recovery codes behind.
  for (const [name, revoke] of Object.entries(revokedTokens)) {
    expect(revoke, `${name} revoked`).toHaveBeenCalledWith({
      where: { memberId: "m1" },
    });
  }

  return data;
}

/** The exact post-anonymisation row: a live member with the route's write applied. */
function deletedMemberRow(
  anonymisation: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return { ...liveMember(), ...anonymisation, ...overrides };
}

/** A hand-built equivalent for the focused tests, pinned by the combination test. */
function deletedMemberFixture(overrides: Record<string, unknown> = {}) {
  return liveMember({
    firstName: "Deleted",
    lastName: "Member",
    email: "deleted-m1abcdef@deleted.invalid",
    passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
    active: false,
    ...overrides,
  });
}

function bulkReactivateRequest(ids: string[]) {
  return new NextRequest("http://localhost/api/admin/members/bulk-update", {
    method: "POST",
    body: JSON.stringify({ ids, action: "reactivate" }),
    headers: { "Content-Type": "application/json" },
  });
}

function editRequest() {
  return new NextRequest("http://localhost/api/admin/members/m1", {
    method: "PUT",
  });
}

type Authorizer = {
  authorize: (
    credentials: Record<string, unknown>,
    request?: unknown,
  ) => Promise<unknown>;
};

function passwordProvider(): Authorizer {
  return authConfig.providers[0] as unknown as Authorizer;
}

function magicLinkProvider(): Authorizer {
  return authConfig.providers[1] as unknown as Authorizer;
}

async function runJwtRefresh() {
  const jwt = authConfig.callbacks?.jwt;
  if (!jwt) throw new Error("authConfig has no jwt callback");
  return (
    jwt as unknown as (args: {
      token: Record<string, unknown>;
      user?: unknown;
      trigger?: unknown;
      session?: unknown;
    }) => Promise<Record<string, unknown>>
  )({ token: { id: "m1", sessionIssuedAt: Date.now() } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBcryptCompare.mockResolvedValue(true);
  mockLoadEffectiveModuleFlags.mockResolvedValue({
    magicLink: true,
    googleLogin: true,
    twoFactor: false,
  } as never);
  mockedPrisma.accessRoleDefinition.findMany.mockResolvedValue([] as never);
  mockedPrisma.seasonalMembershipAssignment.findUnique.mockResolvedValue(
    null as never,
  );
  mockRequireAdmin.mockResolvedValue({ ok: true, session: ADMIN_SESSION });
});

describe("#2620 the combination: anonymise, then try every way back in", () => {
  it("refuses reactivation and every login path for the row deletion actually leaves behind", async () => {
    // ── 1. Anonymise for real, and take the route's own word for what it wrote.
    const anonymisation = await captureAnonymisationPayload();

    // The two markers the shared predicate keys on are genuinely there…
    expect(anonymisation.passwordHash).toBe(DELETED_ACCOUNT_PASSWORD_HASH);
    expect(isDeletedAccountEmail(anonymisation.email as string)).toBe(true);
    expect(anonymisation.active).toBe(false);
    // …and the row is recognised as deleted from the live "before" state plus
    // that write alone. This is the anchor: if anonymisation ever stops writing
    // a marker the predicate reads, this fails rather than the protection
    // silently evaporating.
    const deleted = deletedMemberRow(anonymisation);
    expect(isDeletedAccountRecord(deleted)).toBe(true);

    // Half B: the write now strips the credentials themselves, so `active` is no
    // longer the only barrier. (`captureAnonymisationPayload` asserts the full
    // field set and the token revocations; these three are repeated on the
    // COMPOSED row because that is what every refusal below is handed.)
    expect(deleted.canLogin).toBe(false);
    expect(deleted.googleSub).toBeNull();
    expect(deleted.emailVerified).toBe(false);

    // Still deliberately unstamped. Deletion is its own terminal state, and the
    // refusals below key on the deletion markers rather than borrowing
    // `cancelledAt`/`archivedAt` — which is why they hold even though these two
    // stay empty, and why changing that is a separate decision, not a fix.
    expect(anonymisation.cancelledAt).toBeUndefined();
    expect(anonymisation.archivedAt).toBeUndefined();

    // Defence in depth is the point of everything below: even handed a row whose
    // credentials had NOT been stripped — a pre-#2620 deletion, or a restore
    // from an older backup — every path must still refuse on the deletion
    // markers alone.
    const legacyDeleted = deletedMemberRow(anonymisation, {
      canLogin: true,
      googleSub: "google-sub-jane",
      emailVerified: true,
    });
    expect(isDeletedAccountRecord(legacyDeleted)).toBe(true);

    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ ok: true, session: ADMIN_SESSION });
    mockLoadEffectiveModuleFlags.mockResolvedValue({
      magicLink: true,
      googleLogin: true,
      twoFactor: false,
    } as never);
    mockedPrisma.accessRoleDefinition.findMany.mockResolvedValue([] as never);
    mockedPrisma.seasonalMembershipAssignment.findUnique.mockResolvedValue(
      null as never,
    );

    // ── 2. Bulk Reactivate — the path the defect was reached through.
    mockedPrisma.member.findMany.mockResolvedValue([deleted] as never);
    const bulkRes = await bulkUpdate(bulkReactivateRequest(["m1"]));
    expect(bulkRes.status).toBe(409);
    expect((await bulkRes.json()).error).toBe(
      DELETED_ACCOUNT_BULK_REACTIVATE_MESSAGE,
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();

    // ── 3. The member edit service.
    mockedPrisma.member.findUnique.mockResolvedValue(deleted as never);
    const editRes = await updateAdminMember({
      id: "m1",
      currentAdminMemberId: "admin-1",
      currentAdminAccessRoles: ["ADMIN"],
      request: editRequest(),
      data: { active: true } as never,
    });
    expect(editRes.init?.status).toBe(409);
    expect((editRes.body as { error: string }).error).toBe(
      DELETED_ACCOUNT_EDIT_REACTIVATE_MESSAGE,
    );

    // ── 4. Now suppose `active` had been flipped back anyway — straight in the
    // database, or by a path nobody has written yet. No session may follow.
    const reactivated = deletedMemberRow(anonymisation, { active: true });

    // Password login, with the correct password (bcrypt.compare returns true).
    mockedPrisma.member.findFirst.mockResolvedValue(reactivated as never);
    await expect(
      passwordProvider().authorize({
        email: reactivated.email as string,
        password: "the-right-password",
      }),
    ).resolves.toBeNull();

    // Magic link, with a live, unclaimed, unexpired token.
    mockedPrisma.magicLinkToken.findUnique.mockResolvedValue({
      id: "tok1",
      memberId: "m1",
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as never);
    mockedPrisma.magicLinkToken.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    await expect(
      magicLinkProvider().authorize({ token: "a".repeat(64) }),
    ).resolves.toBeNull();

    // Google — resolved on the surviving googleSub, never on the
    // @deleted.invalid address, which is why this is the sharpest edge.
    const googleResult = await resolveGoogleProfile({
      sub: "google-sub-jane",
      email: "jane@example.com",
    });
    expect(googleResult.googleLoginStatus).toBe("refused");
    expect(googleResult.id).toBe("google-oauth:google-sub-jane");

    // And any session the row still carries dies on its next request.
    mockedPrisma.member.findUnique.mockResolvedValue(reactivated as never);
    const token = await runJwtRefresh();
    expect(token.sessionInvalidated).toBe(true);

    // No login path minted anything, and nothing wrote a lastLoginAt.
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
  });
});

describe("#2620 reactivation refusals, one path at a time", () => {
  it("bulk update answers 409 with the deleted-account message", async () => {
    mockedPrisma.member.findMany.mockResolvedValue([
      deletedMemberFixture(),
    ] as never);
    const res = await bulkUpdate(bulkReactivateRequest(["m1"]));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      DELETED_ACCOUNT_BULK_REACTIVATE_MESSAGE,
    );
  });

  it("bulk update refuses the whole set when one selected member is deleted", async () => {
    // The Inactive-list scenario: an officer reversing a mistaken bulk
    // deactivate sweeps a deleted account up with genuinely deactivated ones.
    mockedPrisma.member.findMany.mockResolvedValue([
      liveMember({ id: "m2", active: false, email: "bob@example.com" }),
      deletedMemberFixture(),
    ] as never);
    const res = await bulkUpdate(bulkReactivateRequest(["m2", "m1"]));
    expect(res.status).toBe(409);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("bulk update keeps its distinct archived and cancelled messages", async () => {
    mockedPrisma.member.findMany.mockResolvedValue([
      liveMember({ active: false, archivedAt: new Date() }),
    ] as never);
    const archivedRes = await bulkUpdate(bulkReactivateRequest(["m1"]));
    expect(archivedRes.status).toBe(409);
    expect((await archivedRes.json()).error).toBe(
      "Archived members cannot be reactivated from bulk update",
    );

    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ ok: true, session: ADMIN_SESSION });
    mockedPrisma.accessRoleDefinition.findMany.mockResolvedValue([] as never);
    mockedPrisma.member.findMany.mockResolvedValue([
      liveMember({ active: false, cancelledAt: new Date() }),
    ] as never);
    const cancelledRes = await bulkUpdate(bulkReactivateRequest(["m1"]));
    expect(cancelledRes.status).toBe(409);
    expect((await cancelledRes.json()).error).toBe(
      "Cancelled members cannot be reactivated from bulk update",
    );
  });

  it("bulk update still reactivates an ordinary deactivated member", async () => {
    mockedPrisma.member.findMany.mockResolvedValue([
      liveMember({ active: false }),
    ] as never);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockedPrisma.$transaction.mockImplementation((async (
      fn: (client: unknown) => unknown,
    ) =>
      fn({
        $executeRaw: vi.fn().mockResolvedValue(1),
        member: { updateMany, count: vi.fn().mockResolvedValue(2) },
        familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        bedAllocation: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })) as never);

    const res = await bulkUpdate(bulkReactivateRequest(["m1"]));
    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: true } }),
    );
  });

  it("the member edit service answers 409 on active:true for a deleted account", async () => {
    mockedPrisma.member.findUnique.mockResolvedValue(
      deletedMemberFixture() as never,
    );
    const res = await updateAdminMember({
      id: "m1",
      currentAdminMemberId: "admin-1",
      currentAdminAccessRoles: ["ADMIN"],
      request: editRequest(),
      data: { active: true } as never,
    });
    expect(res.init?.status).toBe(409);
    expect((res.body as { error: string }).error).toBe(
      DELETED_ACCOUNT_EDIT_REACTIVATE_MESSAGE,
    );
  });

  it("the member edit service answers 409 on re-enabling login for a deleted account", async () => {
    // Half B will clear canLogin during anonymisation; once it does, an attempt
    // to switch login back on is a genuine transition and is refused here.
    mockedPrisma.member.findUnique.mockResolvedValue(
      deletedMemberFixture({ canLogin: false }) as never,
    );
    const res = await updateAdminMember({
      id: "m1",
      currentAdminMemberId: "admin-1",
      currentAdminAccessRoles: ["ADMIN"],
      request: editRequest(),
      data: { canLogin: true } as never,
    });
    expect(res.init?.status).toBe(409);
    expect((res.body as { error: string }).error).toBe(
      DELETED_ACCOUNT_EDIT_REACTIVATE_MESSAGE,
    );
  });

  it("the member edit service does not refuse the dialog's no-op echo", async () => {
    // The edit dialog re-submits the current active/canLogin on every save, so
    // the guard keys on a real transition. A deleted row carries canLogin:true
    // today; echoing it changes nothing and must not 409, or ordinary upkeep on
    // an anonymised record becomes impossible.
    mockedPrisma.member.findUnique.mockResolvedValue(
      deletedMemberFixture() as never,
    );
    const res = await updateAdminMember({
      id: "m1",
      currentAdminMemberId: "admin-1",
      currentAdminAccessRoles: ["ADMIN"],
      request: editRequest(),
      data: { active: false, canLogin: true } as never,
    });
    expect(res.init?.status).not.toBe(409);
  });
});

describe("#2620 login refusals, one path at a time", () => {
  it("password login refuses a deleted account that has been switched back on", async () => {
    mockedPrisma.member.findFirst.mockResolvedValue(
      deletedMemberFixture({ active: true }) as never,
    );
    await expect(
      passwordProvider().authorize({
        email: "deleted-m1abcdef@deleted.invalid",
        password: "anything",
      }),
    ).resolves.toBeNull();
    // Still burns the timing-equalising compare, so the refusal is
    // indistinguishable from an unknown email.
    expect(mockBcryptCompare).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
  });

  it("magic-link login refuses a deleted account holding a live token", async () => {
    mockedPrisma.magicLinkToken.findUnique.mockResolvedValue({
      id: "tok1",
      memberId: "m1",
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as never);
    mockedPrisma.magicLinkToken.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.member.findFirst.mockResolvedValue(
      deletedMemberFixture({ active: true }) as never,
    );

    await expect(
      magicLinkProvider().authorize({ token: "b".repeat(64) }),
    ).resolves.toBeNull();
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
  });

  it("resolveGoogleProfile refuses on the surviving googleSub", async () => {
    mockedPrisma.member.findFirst.mockResolvedValue(
      deletedMemberFixture({ active: true, emailVerified: true }) as never,
    );
    const result = await resolveGoogleProfile({
      sub: "google-sub-jane",
      email: "jane@example.com",
    });
    expect(result.googleLoginStatus).toBe("refused");
    // Sentinel id, never the member id — nothing downstream can resolve a row.
    expect(result.id).toBe("google-oauth:google-sub-jane");
  });

  it("resolveGoogleProfile still admits an ordinary linked member", async () => {
    mockedPrisma.member.findFirst.mockResolvedValue(liveMember() as never);
    const result = await resolveGoogleProfile({
      sub: "google-sub-jane",
      email: "jane@example.com",
    });
    expect(result.googleLoginStatus).toBe("ok");
    expect(result.id).toBe("m1");
  });

  it("the session refresh invalidates a live session held by a deleted account", async () => {
    mockedPrisma.member.findUnique.mockResolvedValue(
      deletedMemberFixture({ active: true }) as never,
    );
    const token = await runJwtRefresh();
    expect(token.sessionInvalidated).toBe(true);
  });

  it("the session refresh leaves an ordinary member's session alone", async () => {
    mockedPrisma.member.findUnique.mockResolvedValue(liveMember() as never);
    const token = await runJwtRefresh();
    expect(token.sessionInvalidated).toBe(false);
  });
});

describe("isDeletedAccountRecord", () => {
  it("recognises either marker on its own", () => {
    expect(
      isDeletedAccountRecord({ passwordHash: DELETED_ACCOUNT_PASSWORD_HASH }),
    ).toBe(true);
    expect(
      isDeletedAccountRecord({ email: "deleted-abcdef12@deleted.invalid" }),
    ).toBe(true);
    // Fails closed on a partial row: a narrow select still gets a verdict from
    // whichever marker it did read.
    expect(
      isDeletedAccountRecord({
        email: "deleted-abcdef12@deleted.invalid",
        passwordHash: null,
      }),
    ).toBe(true);
  });

  it("is case- and whitespace-insensitive on the address", () => {
    expect(
      isDeletedAccountEmail("  Deleted-ABCDEF12@Deleted.Invalid  "),
    ).toBe(true);
  });

  it("does not fire on a live member, a walk-in placeholder, or nothing at all", () => {
    expect(isDeletedAccountRecord(liveMember())).toBe(false);
    // A walk-in contact is an ordinary member record, not an erased one.
    expect(
      isDeletedAccountRecord({
        email: "walk-in-2f1c@no-email.invalid",
        passwordHash: "$2b$12$whatever",
      }),
    ).toBe(false);
    expect(isDeletedAccountRecord(null)).toBe(false);
    expect(isDeletedAccountRecord({})).toBe(false);
    expect(isDeletedAccountEmail(null)).toBe(false);
    // Not a suffix match on the bare word — only the reserved domain counts.
    expect(isDeletedAccountEmail("someone@notdeleted.invalid.example")).toBe(
      false,
    );
  });
});
