import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level gating for the admin member-email choice on account-deletion
// review (#1788, mirroring #1705/#1769a): the REJECT path honours
// `notifyMember` (absent = notify, false = suppress + audited), while the
// APPROVE path always sends its final privacy receipt regardless of the flag.
const h = vi.hoisted(() => {
  const prisma = {
    deletionRequest: { findUnique: vi.fn(), updateMany: vi.fn() },
    booking: { findMany: vi.fn(), findUnique: vi.fn() },
    xeroSyncOperation: { findFirst: vi.fn() },
    xeroObjectLink: { updateMany: vi.fn() },
    // #2859: erasure DELETES the cached contact row. Nulling the one field
    // would leave a row reading as "we looked, Xero holds nothing" — which is
    // the outbound guard's permission to write — about a field Xero still
    // holds.
    xeroContactCache: { deleteMany: vi.fn() },
    // #2255: `findMany` reads who the anonymisation is about to detach and
    // `updateMany` sweeps their inheritance pointers, so club email stops being
    // aimed at the @deleted.invalid address the route has just written.
    member: {
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    familyGroupMember: { deleteMany: vi.fn() },
    bookingGuest: { updateMany: vi.fn() },
    // #2620: anonymisation revokes every outstanding credential artefact in the
    // same commit, because each of these is independently sufficient to
    // authenticate and deletion used to leave them all live.
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
    // CT-4 (#2870): the "future stay" cut-off comes from the club's PERSISTED
    // timezone. Without this delegate `loadPersistedClubTimeSettings()` returns
    // null -- fail-soft by design -- and the route silently falls back to the
    // container's `TZ`, so a suite that omits it cannot tell the two apart.
    clubTimeSettings: { findUnique: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
  return {
    requireAdmin: vi.fn(),
    logAudit: vi.fn(),
    // #2627: the release's audit row is written with the AWAITED,
    // transaction-aware writer, not the fire-and-forget one — it is the only
    // record of who held the claim the release destroys.
    createAuditLog: vi.fn(),
    isFullAdmin: vi.fn(),
    memberHoldsPrivilegedRole: vi.fn(),
    wouldRemoveLastFullAdmin: vi.fn(),
    cancelBooking: vi.fn(),
    sendAccountDeletionApprovedEmail: vi.fn(),
    sendAccountDeletionRejectedEmail: vi.fn(),
    sendAdminPartnerShareSweptAlert: vi.fn(),
    enqueueHostingCoverageReevaluationForMember: vi.fn(),
    settleHostingCoverageAfterCommit: vi.fn(),
    acquireFuturePartnerSharedAllocationLocks: vi.fn(),
    sweepFuturePartnerSharedAllocationsWithLocksHeld: vi.fn(),
    prisma,
    // The transaction client `$transaction` hands its callback: a DISTINCT
    // object identity that forwards every property to the same mocks above.
    //
    // #2627 re-review: handing the callback `prisma` itself made
    // `expect(auditCall[1]).toBe(prisma)` a proof that could not fail — an audit
    // row written on the ambient client, outside the transaction, would have
    // satisfied it too. With a separate identity, "written on the transaction
    // client" is a claim a mutation can break, while every existing assertion on
    // `h.prisma.<model>.<fn>` still sees the same call.
    tx: new Proxy(prisma, {}),
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({
  logAudit: h.logAudit,
  createAuditLog: h.createAuditLog,
}));
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: h.cancelBooking }));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember:
    h.enqueueHostingCoverageReevaluationForMember,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: h.settleHostingCoverageAfterCommit,
}));
vi.mock("@/lib/access-roles", () => ({
  isFullAdmin: h.isFullAdmin,
  memberHoldsPrivilegedRole: h.memberHoldsPrivilegedRole,
}));
vi.mock("@/lib/admin-account-guards", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin-account-guards")>(
    "@/lib/admin-account-guards",
  );
  return { ...actual, wouldRemoveLastFullAdmin: h.wouldRemoveLastFullAdmin };
});
vi.mock("@/lib/access-role-definitions", () => ({ MEMBER_ACCESS_ROLE_SELECT: {} }));
vi.mock("@/lib/email", () => ({
  sendAccountDeletionApprovedEmail: h.sendAccountDeletionApprovedEmail,
  sendAccountDeletionRejectedEmail: h.sendAccountDeletionRejectedEmail,
  sendAdminPartnerShareSweptAlert: h.sendAdminPartnerShareSweptAlert,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  describePartnerSharedSweepReason: vi.fn().mockReturnValue("reason"),
  partnerShareSweepCounterpartNames: vi.fn().mockReturnValue(""),
  partnerShareSweepNights: vi.fn().mockReturnValue(0),
  acquireFuturePartnerSharedAllocationLocks:
    h.acquireFuturePartnerSharedAllocationLocks,
  sweepFuturePartnerSharedAllocationsWithLocksHeld:
    h.sweepFuturePartnerSharedAllocationsWithLocksHeld,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/deletion-requests/[id]/route";
import { APP_TIME_ZONE } from "@/config/operational";
import { getTodayDateOnly } from "@/lib/date-only";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

const member = {
  id: "m1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  role: "MEMBER",
  financeAccessLevel: "NONE",
  active: true,
  accessRoles: [],
};

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/deletion-requests/req-1", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "req-1" });

function deletionRejectedMetadata() {
  return h.logAudit.mock.calls.find(
    (c) => c[0]?.action === "member.deletion_rejected",
  )?.[0]?.metadata;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  });
  h.prisma.deletionRequest.findUnique.mockResolvedValue({
    id: "req-1",
    status: "PENDING",
    member,
  });
  h.prisma.deletionRequest.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.booking.findMany.mockResolvedValue([]);
  h.prisma.booking.findUnique.mockResolvedValue({ status: "PENDING" });
  h.prisma.xeroSyncOperation.findFirst.mockResolvedValue(null);
  h.prisma.member.update.mockResolvedValue({});
  h.prisma.member.findUnique.mockResolvedValue({
    id: member.id,
    email: member.email,
    passwordHash: null,
    xeroContactId: null,
  });
  h.prisma.familyGroupMember.deleteMany.mockResolvedValue({ count: 0 });
  h.prisma.bookingGuest.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.xeroObjectLink.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.xeroContactCache.deleteMany.mockResolvedValue({ count: 0 });
  h.prisma.$transaction.mockImplementation(
    async (cb: (tx: typeof h.prisma) => Promise<unknown>) => cb(h.tx),
  );
  h.isFullAdmin.mockReturnValue(true);
  h.memberHoldsPrivilegedRole.mockReturnValue(false);
  h.wouldRemoveLastFullAdmin.mockResolvedValue(false);
  h.acquireFuturePartnerSharedAllocationLocks.mockResolvedValue(undefined);
  h.sweepFuturePartnerSharedAllocationsWithLocksHeld.mockResolvedValue([]);
  h.enqueueHostingCoverageReevaluationForMember.mockResolvedValue(0);
  h.settleHostingCoverageAfterCommit.mockResolvedValue({});
  h.sendAccountDeletionApprovedEmail.mockResolvedValue(undefined);
  h.sendAccountDeletionRejectedEmail.mockResolvedValue(undefined);
  h.createAuditLog.mockResolvedValue(undefined);
  h.prisma.clubTimeSettings.findUnique.mockResolvedValue({
    timeZone: "Pacific/Auckland",
    updatedByMemberId: null,
    updatedAt: new Date(0),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/admin/deletion-requests/[id] reject notify choice (#1788)", () => {
  it("emails the member and records no notify field on a default reject", async () => {
    const res = await POST(req({ action: "reject" }), { params });

    expect(res.status).toBe(200);
    expect(h.sendAccountDeletionRejectedEmail).toHaveBeenCalledTimes(1);
    expect(deletionRejectedMetadata()).toBeUndefined();
  });

  it("suppresses the email and audits the choice when notifyMember is false; rejection still applied", async () => {
    const res = await POST(req({ action: "reject", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
    expect(deletionRejectedMetadata()).toMatchObject({ notifyMember: false });
    // The request is still marked REJECTED regardless of the notify choice —
    // guarded on a PENDING row with no release marker (#2627), which is what an
    // ordinary rejection is authorised against.
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-1", status: "PENDING", reviewedAt: null },
        data: expect.objectContaining({ status: "REJECTED" }),
      }),
    );
  });

  it("emails and records no notify field when notifyMember is true", async () => {
    const res = await POST(req({ action: "reject", notifyMember: true }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.sendAccountDeletionRejectedEmail).toHaveBeenCalledTimes(1);
    expect(deletionRejectedMetadata()).toBeUndefined();
  });

  it("re-reads and reports an authoritative rejected decision without offering cleanup retry", async () => {
    h.prisma.deletionRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({ id: "req-1", status: "PENDING", member })
      .mockResolvedValueOnce({
        id: "req-1",
        status: "REJECTED",
        member,
      });

    const response = await POST(req({ action: "reject" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      decisionFinal: true,
      finalDecision: "REJECTED",
      cancelledBookings: 0,
      memberAnonymised: false,
      memberDataAnonymised: false,
      retryAllowed: false,
    });
    expect(body).not.toHaveProperty("remainingCleanupPending");
    expect(body).not.toHaveProperty("approvalReceiptSent");
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean notifyMember with 400 and does not touch the request", async () => {
    const res = await POST(req({ action: "reject", notifyMember: "false" }), {
      params,
    });

    expect(res.status).toBe(400);
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/deletion-requests/[id] approve carve-out (#1788)", () => {
  /**
   * #2597: an approve WITH future bookings to cancel takes TWO guarded
   * `deletionRequest.updateMany` calls — the durable PENDING ->
   * APPROVAL_IN_PROGRESS claim before any booking cancellation commits, then
   * APPROVAL_IN_PROGRESS -> APPROVED inside the anonymisation transaction. Tests
   * that mean "another admin won the final decision" must let the first succeed
   * and only the second lose, otherwise the approval never starts and no
   * cancellation is attempted at all.
   *
   * #2627: this helper is therefore ONLY correct for an approval that has
   * something to cancel. An approval with nothing to cancel takes no claim at
   * all and finalises straight from PENDING, so letting the PENDING-guarded
   * mutation win would be letting the approval win. Use
   * {@link everyDecisionClaimLoses} for that shape.
   */
  function finalDecisionClaimLoses() {
    h.prisma.deletionRequest.updateMany.mockImplementation(
      async ({ where }: { where: { status: string } }) =>
        where.status === "PENDING" ? { count: 1 } : { count: 0 },
    );
  }

  /** No guarded decision transition matches: another admin owns the request. */
  function everyDecisionClaimLoses() {
    h.prisma.deletionRequest.updateMany.mockResolvedValue({ count: 0 });
  }

  it("reports the winning approval and anonymisation after earlier cancellations without an unsafe retry", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockResolvedValueOnce({ status: 200, data: {} });
    finalDecisionClaimLoses();
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({ id: "req-1", status: "PENDING", member })
      .mockResolvedValueOnce({
        id: "req-1",
        status: "APPROVED",
        member: {
          ...member,
          firstName: "Deleted",
          lastName: "Member",
          email: "deleted-m1@deleted.invalid",
          active: false,
        },
      });

    const response = await POST(req({ action: "approve" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      decisionFinal: true,
      finalDecision: "APPROVED",
      cancelledBookings: 1,
      memberAnonymised: true,
      memberDataAnonymised: true,
      retryAllowed: false,
    });
    expect(body).not.toHaveProperty("remainingCleanupPending");
    expect(body).not.toHaveProperty("approvalReceiptSent");
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
  });

  it("suppresses retry when the winning decision cannot be authoritatively re-read", async () => {
    // This member has no future bookings, so (#2627) the approval takes no
    // claim and its ONE guarded transition is PENDING -> APPROVED. "Another
    // admin won" therefore means that transition matches nothing.
    everyDecisionClaimLoses();
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({ id: "req-1", status: "PENDING", member })
      .mockRejectedValueOnce(new Error("private database detail"));

    const response = await POST(req({ action: "approve" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "DELETION_REQUEST_DECISION_STATUS_UNCONFIRMED",
      error:
        "Another administrator claimed this deletion request, but its final state could not be confirmed. Reload the deletion queue; do not retry the deletion action.",
      decisionStatusUnconfirmed: true,
      cancelledBookings: 0,
      retryAllowed: false,
    });
    expect(JSON.stringify(body)).not.toContain("private database detail");
  });
  it("reports earlier cancellations truthfully when a later participant fence contends", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }, { id: "booking-2" }]);
    h.cancelBooking
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(new HostingCoverageParticipantRetryError());

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      cancelledBookings: 1,
      cancellationPending: true,
      retryBookingId: "booking-2",
      remainingCleanupPending: true,
      memberAnonymised: false,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
    expect(h.cancelBooking).toHaveBeenCalledTimes(2);
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
  });

  it("returns stable partial-cleanup facts after an ordinary later cancellation error", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }, { id: "booking-2" }]);
    h.cancelBooking
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(new Error("private database detail"));
    h.prisma.booking.findUnique.mockResolvedValue({ status: "CANCELLED" });

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "DELETION_CLEANUP_PARTIAL",
      error:
        "Account deletion cleanup is incomplete. The member was not anonymised and no approval receipt was sent. Retry only the remaining cleanup.",
      cancelledBookings: 2,
      cancellationPending: false,
      retryBookingId: null,
      cancellationPostProcessingUnconfirmed: true,
      reviewBookingId: "booking-2",
      remainingCleanupPending: true,
      memberAnonymised: false,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
    expect(h.cancelBooking).toHaveBeenCalledTimes(2);
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
  });

  it("reports status-unconfirmed instead of inventing a pending cancellation when the authoritative re-read fails", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockRejectedValueOnce(new Error("post-cancel failure"));
    h.prisma.booking.findUnique.mockRejectedValueOnce(
      new Error("authoritative read unavailable"),
    );

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "DELETION_CLEANUP_PARTIAL",
      cancelledBookings: 0,
      cancellationPending: false,
      cancellationStatusUnconfirmed: true,
      retryBookingId: null,
      reviewBookingId: "booking-1",
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
  });

  it("keeps completed cancellations when the locked last-full-admin guard later blocks anonymisation", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockResolvedValueOnce({ status: 200, data: {} });
    h.wouldRemoveLastFullAdmin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "DELETION_CLEANUP_PARTIAL",
      cancelledBookings: 1,
      cancellationPending: false,
      retryBookingId: null,
      remainingCleanupPending: true,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
      blocker: {
        code: "LAST_FULL_ADMIN_GUARD",
        message: expect.stringContaining("last Full Admin"),
        remedy: expect.stringContaining("another active account Full Admin access"),
      },
    });
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
  });

  it("always sends the approval receipt and ignores a notifyMember suppression", async () => {
    const res = await POST(req({ action: "approve", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    // The final privacy receipt sends regardless of any notify param.
    expect(h.sendAccountDeletionApprovedEmail).toHaveBeenCalledTimes(1);
    expect(h.sendAccountDeletionApprovedEmail).toHaveBeenCalledWith(
      member.email,
      member.firstName,
    );
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
    expect(h.acquireFuturePartnerSharedAllocationLocks).toHaveBeenCalledWith(
      h.prisma,
      [member.id],
      // #3123: the club's day, resolved before the transaction opened, and the
      // SAME value the sweep below receives (`INV-LOCK-004`).
      expect.any(Date),
    );
    expect(
      h.acquireFuturePartnerSharedAllocationLocks.mock.calls[0]?.[2],
    ).toEqual(
      h.sweepFuturePartnerSharedAllocationsWithLocksHeld.mock.calls[0]?.[0]
        .today,
    );
    const acquireOrder =
      h.acquireFuturePartnerSharedAllocationLocks.mock.invocationCallOrder[0];
    const memberLockOrder = h.prisma.$executeRaw.mock.invocationCallOrder[0];
    const heldSweepOrder =
      h.sweepFuturePartnerSharedAllocationsWithLocksHeld.mock.invocationCallOrder[0];
    const hostingEnqueueOrder =
      h.enqueueHostingCoverageReevaluationForMember.mock.invocationCallOrder[0];
    const anonymiseOrder = h.prisma.member.update.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(memberLockOrder);
    expect(memberLockOrder).toBeLessThan(heldSweepOrder);
    expect(heldSweepOrder).toBeLessThan(hostingEnqueueOrder);
    expect(hostingEnqueueOrder).toBeLessThan(anonymiseOrder);
    expect(h.enqueueHostingCoverageReevaluationForMember).toHaveBeenCalledWith(
      member.id,
      h.prisma,
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE", actorMemberId: "admin-1" },
    );
    const receiptOrder = h.sendAccountDeletionApprovedEmail.mock.invocationCallOrder[0];
    expect(anonymiseOrder).toBeLessThan(receiptOrder);
    expect(receiptOrder).toBeLessThan(
      h.settleHostingCoverageAfterCommit.mock.invocationCallOrder[0],
    );
  });

  it("rolls back anonymisation when the shared standing-fanout fence retries", async () => {
    // #2627: this test's subject is that finalisation is guarded on the DURABLE
    // CLAIM rather than on PENDING, so it must run the shape that actually takes
    // the claim — an approval with a future booking to cancel. It used to have
    // none, and only passed because the claim was then taken unconditionally.
    // With the claim now conditional, keeping it bookingless would have silently
    // turned this into a test of the PENDING-guarded path and stopped covering
    // the invariant it was written for.
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockResolvedValueOnce({ status: 200, data: {} });
    h.enqueueHostingCoverageReevaluationForMember.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      cancelledBookings: 1,
      cancellationPending: false,
      retryBookingId: null,
      remainingCleanupPending: true,
      memberAnonymised: false,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.prisma.bookingGuest.updateMany).not.toHaveBeenCalled();
    // #2597: finalisation is guarded on the durable claim, not on PENDING —
    // a rejection can no longer overtake an approval that has already begun.
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-1", status: "APPROVAL_IN_PROGRESS" },
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
    expect(h.settleHostingCoverageAfterCommit).not.toHaveBeenCalled();
  });

  it("owns the approval durably before the first booking cancellation commits", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockResolvedValueOnce({ status: 200, data: {} });

    const res = await POST(req({ action: "approve" }), { params });
    expect(res.status).toBe(200);

    // The claim is what makes the cleanup recoverable and un-rejectable, so it
    // must be written before any irreversible cancellation, not after.
    const claimCall = h.prisma.deletionRequest.updateMany.mock.calls.find(
      (c) => c[0]?.data?.status === "APPROVAL_IN_PROGRESS",
    );
    expect(claimCall?.[0]).toMatchObject({
      where: { id: "req-1", status: "PENDING" },
      data: { reviewedBy: "admin-1", reviewedAt: null },
    });
    const claimOrder =
      h.prisma.deletionRequest.updateMany.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(h.cancelBooking.mock.invocationCallOrder[0]);
  });

  it("refuses to start an approval a rejection already won, cancelling nothing", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    // The opening claim loses: the request is no longer PENDING.
    h.prisma.deletionRequest.updateMany.mockResolvedValue({ count: 0 });
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({ id: "req-1", status: "PENDING", member })
      .mockResolvedValueOnce({ id: "req-1", status: "REJECTED", member })
      .mockResolvedValueOnce({ id: "req-1", status: "REJECTED", member });

    const response = await POST(req({ action: "approve" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      decisionFinal: true,
      finalDecision: "REJECTED",
      cancelledBookings: 0,
      retryAllowed: false,
    });
    // The whole point of claiming first: nothing destructive happened.
    expect(h.cancelBooking).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
  });

  it("takes no approval claim when there is nothing irreversible to cancel", async () => {
    // #2627 defect 2, half one. The claim exists to stop a rejection overtaking
    // booking cancellations an approval has already committed. With no future
    // bookings there are none, everything this approval does commits in the one
    // anonymisation transaction, and taking the claim would permanently burn the
    // ability to reject in exchange for nothing — wedging the request for good
    // if that transaction then failed permanently.
    h.prisma.booking.findMany.mockResolvedValue([]);

    const res = await POST(req({ action: "approve" }), { params });
    expect(res.status).toBe(200);

    expect(h.cancelBooking).not.toHaveBeenCalled();
    // Nothing was ever moved into the intermediate state.
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVAL_IN_PROGRESS" }),
      }),
    );
    // The decision is the single guarded PENDING -> APPROVED transition, which
    // an ordinary rejection could still have won right up to the commit.
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-1", status: "PENDING" },
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
    expect(h.prisma.member.update).toHaveBeenCalled();
  });

  it("still claims before the first cancellation when there IS something to cancel", async () => {
    // The other side of the same conditional: the protection must not have been
    // traded away for the conditional.
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockResolvedValueOnce({ status: 200, data: {} });

    const res = await POST(req({ action: "approve" }), { params });
    expect(res.status).toBe(200);

    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-1", status: "PENDING" },
        data: expect.objectContaining({ status: "APPROVAL_IN_PROGRESS" }),
      }),
    );
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-1", status: "APPROVAL_IN_PROGRESS" },
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
    expect(
      h.prisma.deletionRequest.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(h.cancelBooking.mock.invocationCallOrder[0]);
  });

  it("resumes an interrupted approval instead of refusing the retry", async () => {
    // The admin returns to a request left in APPROVAL_IN_PROGRESS by a crashed
    // or disconnected earlier attempt; the remaining cleanup must complete.
    h.prisma.deletionRequest.findUnique.mockResolvedValue({
      id: "req-1",
      status: "APPROVAL_IN_PROGRESS",
      member,
    });
    h.prisma.deletionRequest.updateMany.mockImplementation(
      async ({ where }: { where: { status: string } }) =>
        // The opening claim finds no PENDING row and falls back to the
        // findUnique resume check; finalisation then wins from the claim.
        where.status === "PENDING" ? { count: 0 } : { count: 1 },
    );

    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(200);
    expect(h.prisma.member.update).toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).toHaveBeenCalledTimes(1);
  });

  // F32 (#1888): booking.checkIn is @db.Date (NZ calendar date at UTC midnight).
  // The future-paid and future-cancellable guards must key off the NZ calendar
  // date, not a raw instant, or a stay checking in today drops out of both
  // guards for the first ~13h of the NZ day.
  it("scopes the future-booking guards to the NZ calendar date, not the raw instant", async () => {
    // NZ 2026-07-16 08:00 (NZST +12); the UTC day (Jul 15) trails the NZ day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T20:00:00.000Z"));
    try {
      const res = await POST(req({ action: "approve" }), { params });
      expect(res.status).toBe(200);

      const firstWhere = h.prisma.booking.findMany.mock.calls[0][0].where;
      expect(firstWhere.checkIn.gte.toISOString()).toBe(
        "2026-07-16T00:00:00.000Z",
      );
      // The raw-instant version would have used Date.now(); the fix must not.
      expect(firstWhere.checkIn.gte.getTime()).not.toBe(Date.now());

      // Both guards share the same date-only boundary.
      const secondWhere = h.prisma.booking.findMany.mock.calls[1][0].where;
      expect(secondWhere.checkIn.gte.toISOString()).toBe(
        "2026-07-16T00:00:00.000Z",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * #2627 defect 2, half two. `APPROVAL_IN_PROGRESS` used to be a one-way door:
 * the only exit was a successful anonymisation, so a permanently blocked
 * approval wedged the request forever — and while it is open the member cannot
 * lodge a new deletion request and their duplicate cannot be merged. A Full
 * Admin can now release the claim back to PENDING; the decision itself is still
 * made through the ordinary approve/reject paths.
 */
describe("POST /api/admin/deletion-requests/[id] release a started approval (#2627)", () => {
  function claimed() {
    h.prisma.deletionRequest.findUnique.mockResolvedValue({
      id: "req-1",
      status: "APPROVAL_IN_PROGRESS",
      adminNote: "starting approval",
      reviewedBy: "admin-9",
      member,
    });
  }

  function releaseAudit() {
    return h.createAuditLog.mock.calls.find(
      (c) => c[0]?.action === "member.deletion_approval_claim_released",
    );
  }

  it("returns a wedged claim to pending, anonymising nobody and emailing no one", async () => {
    claimed();

    const res = await POST(
      req({ action: "release", note: "Xero blocker will never clear" }),
      { params },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      message: expect.stringContaining("pending again"),
    });
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: "APPROVAL_IN_PROGRESS" },
      data: {
        status: "PENDING",
        adminNote: "Xero blocker will never clear",
        reviewedBy: null,
        // The durable marker. A PENDING request with a reviewedAt and no
        // reviewer is one whose started approval was released, and that is what
        // warns the next decider that the member's stays may already be
        // cancelled. Nulling it here would restore the exact silent state this
        // fix exists to remove.
        reviewedAt: expect.any(Date),
      },
    });
    // A release decides nothing and destroys nothing.
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.cancelBooking).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });

  it("writes the only record of the destroyed claim inside the same transaction, awaited", async () => {
    // `logAudit` is fire-and-forget: a failed insert or a process death after the
    // 200 would lose the previous claim holder permanently, and this row is the
    // only place it survives. So the release and its record are one transaction.
    claimed();

    const res = await POST(req({ action: "release", note: "let it go" }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const audit = releaseAudit();
    expect(audit?.[0]).toMatchObject({
      memberId: "admin-1",
      targetId: member.id,
      category: "privacy",
      outcome: "success",
      metadata: {
        previousClaimHeldBy: "admin-9",
        previousAdminNote: "starting approval",
      },
    });
    // Written through the TRANSACTION client the release ran on, not the ambient
    // one. `$transaction` hands the callback a distinct identity from
    // `h.prisma`, so this fails if the audit row moves outside the transaction
    // (or is written on the singleton from inside it).
    expect(audit?.[1]).toBe(h.tx);
    expect(audit?.[1]).not.toBe(h.prisma);
    // Never through the fire-and-forget writer.
    expect(
      h.logAudit.mock.calls.filter(
        (c) => c[0]?.action === "member.deletion_approval_claim_released",
      ),
    ).toEqual([]);
    // Transition first, then its record — both inside the transaction.
    expect(
      h.prisma.deletionRequest.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(h.createAuditLog.mock.invocationCallOrder[0]);
  });

  it("attributes the released claim from the locked read, not from the earlier unguarded one", async () => {
    // ABA: the route's opening read is unguarded, so between it and the release a
    // claim can be released and re-taken by somebody else. Recording the holder
    // that read saw would name an admin whose claim was never displaced.
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({
        id: "req-1",
        status: "APPROVAL_IN_PROGRESS",
        adminNote: "note the operator saw",
        reviewedBy: "admin-stale",
        member,
      })
      .mockResolvedValue({
        status: "APPROVAL_IN_PROGRESS",
        adminNote: "note under the lock",
        reviewedBy: "admin-current",
      });

    const res = await POST(req({ action: "release", note: "release it" }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(releaseAudit()?.[0]).toMatchObject({
      metadata: {
        previousClaimHeldBy: "admin-current",
        previousAdminNote: "note under the lock",
      },
    });
  });

  it("does not report a release whose record could not be written", async () => {
    // Awaited inside the transaction, so a failed audit insert rolls the release
    // back: the operator is told it failed and the claim is still there to
    // release again. Reporting success with no record is the outcome this
    // forbids.
    claimed();
    h.createAuditLog.mockRejectedValue(new Error("audit insert failed"));

    const res = await POST(req({ action: "release", note: "no record" }), {
      params,
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.not.toMatchObject({
      message: expect.stringContaining("pending again"),
    });
  });

  it("gives the release a budget bigger than the transaction it has to wait behind", async () => {
    // This is the one transaction here whose FIRST statement is designed to
    // block: it takes the request row FOR UPDATE while the counterpart
    // anonymisation transaction may hold that row from its claim to its commit.
    // Prisma's 5s default would abort a legitimate wait; 15s is deliberately
    // longer than the anonymisation transaction's own (default) budget, so a
    // release loses to it on the guard rather than on the clock.
    claimed();

    const res = await POST(req({ action: "release", note: "let it go" }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({
      maxWait: 10_000,
      timeout: 15_000,
    });
  });

  it.each(["P2028", "P2034"])(
    "answers a contended release (%s) with a retry-later, not a bare 500",
    async (code) => {
      // Before the release moved into a transaction it was an auto-commit
      // `updateMany`: it blocked on the row and then returned the mapped 409. An
      // exhausted interactive-transaction wait falling through to the generic 500
      // would therefore be a regression in behaviour under contention. The whole
      // transaction rolled back, so nothing was released, nothing was recorded,
      // and the claim is still there — which is what the answer says.
      claimed();
      h.prisma.$transaction.mockRejectedValue(
        Object.assign(new Error("Transaction API error"), { code }),
      );

      const res = await POST(req({ action: "release", note: "too busy" }), {
        params,
      });

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        code: "DELETION_REQUEST_RELEASE_CONTENDED",
        error: expect.stringContaining("try again shortly"),
        retryAllowed: true,
      });
      expect(releaseAudit()).toBeUndefined();
    },
  );

  it("does not turn an ordinary release failure into a retry-later", async () => {
    // The mapping is scoped to contention codes. A real fault must keep failing
    // loudly rather than inviting a retry that will fail the same way.
    claimed();
    h.prisma.$transaction.mockRejectedValue(
      Object.assign(new Error("column does not exist"), { code: "P2022" }),
    );

    const res = await POST(req({ action: "release", note: "broken" }), {
      params,
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.not.toMatchObject({
      code: "DELETION_REQUEST_RELEASE_CONTENDED",
    });
  });

  it("refuses a scoped membership admin who is not a Full Admin", async () => {
    claimed();
    h.isFullAdmin.mockReturnValue(false);

    const res = await POST(req({ action: "release", note: "let me out" }), {
      params,
    });

    expect(res.status).toBe(403);
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
    expect(releaseAudit()).toBeUndefined();
  });

  it("requires a reason, because releasing re-opens a decision closed to rejection", async () => {
    claimed();

    for (const body of [
      { action: "release" },
      { action: "release", note: "   " },
    ]) {
      h.prisma.deletionRequest.updateMany.mockClear();
      const res = await POST(req(body), { params });
      expect(res.status).toBe(400);
      expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
    }
  });

  it("refuses a release on a request that holds no claim", async () => {
    // Still PENDING: there is nothing to release, and the refusal says so
    // rather than reporting it as already reviewed.
    const res = await POST(req({ action: "release", note: "nothing here" }), {
      params,
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "DELETION_REQUEST_CLAIM_NOT_HELD",
      retryAllowed: false,
    });
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("loses cleanly to a finalisation that was already committing", async () => {
    // The guard IS the race protection: the release's guarded updateMany blocks
    // on the row lock the committing finalisation holds, then re-evaluates its
    // `status: APPROVAL_IN_PROGRESS` predicate against the committed row and
    // matches nothing. It must never silently report success.
    claimed();
    h.prisma.deletionRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(req({ action: "release", note: "too late" }), {
      params,
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "DELETION_REQUEST_CLAIM_NOT_HELD",
      retryAllowed: false,
    });
    expect(releaseAudit()).toBeUndefined();
  });

  it("refuses a release once the request has reached a final decision", async () => {
    h.prisma.deletionRequest.findUnique.mockResolvedValue({
      id: "req-1",
      status: "APPROVED",
      member,
    });

    const res = await POST(req({ action: "release", note: "undo it" }), {
      params,
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      decisionFinal: true,
      finalDecision: "APPROVED",
      retryAllowed: false,
    });
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown action with 400 and touches nothing", async () => {
    const res = await POST(req({ action: "unclaim" }), { params });

    expect(res.status).toBe(400);
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/deletion-requests/[id] deciding a released request (#2627)", () => {
  const RELEASED_AT = new Date("2026-08-06T21:30:00.000Z");

  /**
   * A request whose started approval was released: PENDING again, with the
   * marker that says so. Rejecting it is the one rejection that can be final
   * over stays an approval already cancelled, so it carries the release's own
   * Full-Admin gate and an explicit confirmation.
   */
  function released() {
    h.prisma.deletionRequest.findUnique.mockResolvedValue({
      id: "req-1",
      status: "PENDING",
      adminNote: "Xero blocker will never clear",
      reviewedBy: null,
      reviewedAt: RELEASED_AT,
      member,
    });
  }

  function rejectAuditMetadata() {
    return h.logAudit.mock.calls.find(
      (c) => c[0]?.action === "member.deletion_rejected",
    )?.[0]?.metadata;
  }

  it("refuses a scoped membership admin, because a Full Admin re-opened this decision", async () => {
    released();
    h.isFullAdmin.mockReturnValue(false);

    const res = await POST(req({ action: "reject" }), { params });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("stay cancelled"),
    });
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed rejection WITH the disclosure, so a stale page cannot finalise one unwarned", async () => {
    released();

    const res = await POST(req({ action: "reject" }), { params });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "DELETION_REJECT_AFTER_RELEASE_CONFIRM_REQUIRED",
      error: expect.stringContaining("stay cancelled"),
      approvalReleased: true,
      approvalReleasedAt: RELEASED_AT.toISOString(),
      releaseReason: "Xero blocker will never clear",
    });
    // Nothing decided, nobody emailed: the member is not told their request was
    // declined by a refusal.
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });

  it("applies a confirmed rejection and records that it landed over a released approval", async () => {
    released();

    const res = await POST(
      req({
        action: "reject",
        note: "Resolve the blocker first",
        confirmReleasedApproval: true,
      }),
      { params },
    );

    expect(res.status).toBe(200);
    // The confirmed rejection's guard names the RELEASED flavour of pending, not
    // pending in general: the disclosure the decider was shown describes a marked
    // row, so that is the only row this decision may win.
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: "PENDING", reviewedAt: { not: null } },
      data: expect.objectContaining({ status: "REJECTED" }),
    });
    // The audit trail states the hazard in one entry rather than leaving it to be
    // reconstructed from two.
    expect(rejectAuditMetadata()).toMatchObject({
      approvalPreviouslyReleased: true,
      approvalReleasedAt: RELEASED_AT.toISOString(),
    });
  });

  it("refuses an ordinary rejection when the release marker appears between the route's read and its write", async () => {
    // The interleaving the gate above cannot see, because it is evaluated against
    // the opening read and there is latency (not a human) in the window — Prisma
    // queues on an exhausted pool. A Membership Officer POSTs `reject` on a row
    // that is genuinely unmarked; a Full Admin then claims, cancels the member's
    // stays, fails and releases. Guarded on `status: "PENDING"` alone this
    // rejection LANDS: final REJECTED over committed cancellations, with no
    // Full-Admin check and no confirmation, which is the state
    // docs/DOMAIN_INVARIANTS.md says cannot happen.
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({
        id: "req-1",
        status: "PENDING",
        adminNote: null,
        reviewedBy: null,
        reviewedAt: null,
        member,
      })
      // What the row has become by the time the write runs, and what the
      // route's re-read finds afterwards.
      .mockResolvedValue({
        status: "PENDING",
        adminNote: "Xero blocker will never clear",
        reviewedBy: null,
        reviewedAt: RELEASED_AT,
        member,
      });
    // Stands in for PostgreSQL: the row now carries a marker, so a guard naming
    // `reviewedAt: null` matches nothing — and anything laxer matches it.
    h.prisma.deletionRequest.updateMany.mockImplementation(
      async (args: { where: { reviewedAt?: unknown } }) => ({
        count: args.where.reviewedAt === null ? 0 : 1,
      }),
    );
    h.isFullAdmin.mockReturnValue(false);

    const res = await POST(req({ action: "reject", note: "unaware" }), {
      params,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "DELETION_REQUEST_APPROVAL_RELEASED",
      approvalReleased: true,
      decisionFinal: false,
      retryAllowed: false,
    });
    // The guard is what refused it, in one attempt, and the marker's absence is
    // part of it rather than of a preceding read.
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(
      h.prisma.deletionRequest.updateMany.mock.calls[0][0].where,
    ).toEqual({ id: "req-1", status: "PENDING", reviewedAt: null });
    // Nothing decided and nothing said: the member is not emailed a rejection
    // that did not happen.
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });

  it("requires a reason on a confirmed reject-after-release, because the note is all the member gets", async () => {
    // Everything else about this state is admin-facing. The member's stays are
    // what was destroyed, and this note is the only thing they are ever told, so
    // the release's own mandatory reason is mirrored onto the rejection.
    released();

    for (const body of [
      { action: "reject", confirmReleasedApproval: true },
      { action: "reject", note: "   ", confirmReleasedApproval: true },
    ]) {
      h.prisma.deletionRequest.updateMany.mockClear();
      h.sendAccountDeletionRejectedEmail.mockClear();

      const res = await POST(req(body), { params });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: "DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED",
        error: expect.stringContaining("stay cancelled"),
      });
      expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
      expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
    }
  });

  it("refuses to suppress the member's email on a confirmed reject-after-release", async () => {
    // #1788's free choice stays on every ordinary rejection, where nothing has
    // been destroyed. Here it would mean declining the request over cancelled
    // stays with no notice at all.
    released();

    const res = await POST(
      req({
        action: "reject",
        note: "Resolve the blocker first",
        notifyMember: false,
        confirmReleasedApproval: true,
      }),
      { params },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED",
      error: expect.stringContaining("stay cancelled"),
    });
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });

  it("still lets an ORDINARY rejection be reasonless and silent", async () => {
    // The two requirements above are scoped to the released path only. Widening
    // them would quietly rewrite #1788's audited notify choice for every
    // rejection.
    const res = await POST(req({ action: "reject", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not gate or confirm an APPROVAL of a released request", async () => {
    // Approving completes the deletion the member asked for. It destroys nothing
    // that the released approval had not already destroyed, so it stays an
    // ordinary membership-edit action.
    released();

    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(200);
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: "PENDING" },
      data: expect.objectContaining({ status: "APPROVED" }),
    });
  });

  it("names the release when a finalisation loses its guard to one, instead of calling the state unconfirmed", async () => {
    // The interleaving this action introduces: the release commits while an
    // approval is finalising, so the approval's guarded transition matches zero
    // rows and its transaction rolls back. The request is PENDING — a state known
    // EXACTLY. Reporting "its final state could not be confirmed … do not retry"
    // would durably disable the row over a request that is simply decidable
    // again.
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({
        id: "req-1",
        status: "PENDING",
        adminNote: null,
        reviewedBy: null,
        reviewedAt: null,
        member,
      })
      .mockResolvedValue({
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: RELEASED_AT,
        member,
      });
    h.prisma.deletionRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "DELETION_REQUEST_APPROVAL_RELEASED",
      approvalReleased: true,
      decisionFinal: false,
      retryAllowed: false,
    });
    expect(body.error).toContain("pending again");
    expect(body.decisionStatusUnconfirmed).toBeUndefined();
    // No receipt, no anonymisation: the transaction rolled back.
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
  });
});

describe("#2623 T1: the Xero fence is asked BEFORE anything irreversible", () => {
  /**
   * The blocker predicate matches an unresolved member-scoped CONTACT
   * operation. Shape it the way `memberContactChangeMergeBlockerWhere` looks
   * for — a RUNNING create — so the real predicate, not a stub, refuses.
   */
  function xeroContactOperationInFlight() {
    h.prisma.xeroSyncOperation.findFirst.mockResolvedValue({
      id: "xero-op-running",
      status: "RUNNING",
      responsePayload: null,
    });
  }

  it("refuses the approval without cancelling a single booking", async () => {
    // A member with future bookings the approval WOULD have cancelled.
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }, { id: "booking-2" }]);
    xeroContactOperationInFlight();

    const response = await POST(req({ action: "approve" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("XERO_CONTACT_CREATE_BLOCKS_DELETION");
    // #2623 T7: the refusal names the exact operation and the screen holding the
    // remedy, instead of leaving the operator to work out which of the member's
    // Xero operations refused and where to clear it.
    expect(body.xeroOperationId).toBe("xero-op-running");
    expect(body.remedy).toContain("Admin → Xero → Operations");
    expect(body.error).toContain("Admin → Xero → Operations");

    // The whole point: this used to be discovered inside the anonymisation
    // transaction, AFTER the loop below had cancelled both bookings for a
    // condition that was knowable up front.
    expect(h.cancelBooking).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();

    // And it did not take ownership of the decision either, so the request is
    // untouched rather than parked in APPROVAL_IN_PROGRESS.
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("does not block a rejection, which anonymises nothing", async () => {
    xeroContactOperationInFlight();

    const response = await POST(req({ action: "reject" }), { params });

    expect(response.status).toBe(200);
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REJECTED" }),
      }),
    );
  });

  // That the guard is not a blanket refusal — a member with no Xero operation
  // in flight still reaches the cancellations and returns 200 — is already
  // covered by "owns the approval durably before the first booking
  // cancellation commits" above, which runs the same path with the default
  // (empty) xeroSyncOperation stub.
});

/**
 * #2859. Until this release the app never WROTE a date of birth to Xero, so the
 * only local copy erasure had to reach was `Member.dateOfBirth`. Sending it to
 * the contact's NZBN field creates a second one: the next inbound contact sync
 * caches the value straight back into `XeroContactCache.companyNumber`, in
 * plaintext, for essentially every member rather than the handful that had one
 * before. Nulling the Member column while leaving that copy behind would mean an
 * honoured erasure request still left the member's birthday on this server.
 *
 * Removing the value from XERO is deliberately NOT attempted here: it conflicts
 * with the standing rule that this app never blanks that field (it cannot tell a
 * birthday it wrote from a business number an administrator typed), and it is a
 * genuine owner question tracked as #2873.
 */
describe("POST /api/admin/deletion-requests/[id] clears the cached date of birth (#2859)", () => {
  beforeEach(() => {
    // `vi.clearAllMocks()` does NOT drain a `mockResolvedValueOnce` queue, and
    // the #2623 T1 suite above queues two `booking.findMany` results while its
    // approval refuses at the Xero fence after consuming only the first. The
    // leftover leaks into whichever later test is the next to reach the
    // cancellation loop — which, before this suite existed, was none of them.
    // Draining it here is what makes "this member has no bookings to cancel"
    // true rather than merely intended.
    h.prisma.booking.findMany.mockReset();
    h.prisma.booking.findMany.mockResolvedValue([]);
  });

  it("DELETES the cached contact row in the anonymisation transaction, rather than nulling one field", async () => {
    h.prisma.member.findUnique.mockResolvedValue({
      id: member.id,
      email: member.email,
      passwordHash: null,
      xeroContactId: "contact-1",
    });

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(200);
    expect(h.prisma.xeroContactCache.deleteMany).toHaveBeenCalledWith({
      where: { contactId: "contact-1" },
    });
    // Deleting, not nulling, and this is a correctness property rather than a
    // tidiness one. `buildXeroContactCompanyNumberPatch` reads a cache row that
    // EXISTS and holds `null` as "we looked, and Xero's NZBN field is empty" —
    // its permission to write. A null-ing erasure would manufacture exactly
    // that permission about a field Xero still holds (#2873), so a later
    // namesake matched onto the same contact would have a real business number
    // overwritten by a birthday. It also leaves the erased member's cached
    // name, email, phone and address in the row.
    expect(h.prisma.xeroContactCache).not.toHaveProperty("updateMany");
    // In the SAME commit as the anonymisation, not after it: a clear that
    // landed outside the transaction would survive a rollback that put the
    // member's own row back.
    const anonymiseOrder = h.prisma.member.update.mock.invocationCallOrder[0];
    const cacheClearOrder =
      h.prisma.xeroContactCache.deleteMany.mock.invocationCallOrder[0];
    expect(anonymiseOrder).toBeLessThan(cacheClearOrder);
    const linkDeactivateOrder =
      h.prisma.xeroObjectLink.updateMany.mock.invocationCallOrder[0];
    expect(cacheClearOrder).toBeLessThan(linkDeactivateOrder);
  });

  it("touches no cache row when the member has no Xero contact", async () => {
    // The default stub already has `xeroContactId: null`. A blanket
    // `deleteMany` with an undefined contactId would wipe EVERY cached contact
    // in the organisation, so "no contact" must mean no write at all rather
    // than an unscoped one.
    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(200);
    expect(h.prisma.member.update).toHaveBeenCalled();
    expect(h.prisma.xeroContactCache.deleteMany).not.toHaveBeenCalled();
  });
});

/*
  CT-4 (#2870), epic #2988 -- WHICH day "future" is measured from, on the one
  route in this tree whose outcome is irreversible.

  `Booking.checkIn` is `@db.Date`, and approval is BLOCKED while the member
  still has a future paid stay and CANCELS their future unpaid ones. So the
  cut-off decides two things that cannot be undone: whether an officer is
  allowed to anonymise this person at all, and which of their bookings get
  cancelled on the way. A day either side of the truth moves a real stay across
  that line -- and a stay checking in TODAY has always been meant to count as
  future for the whole club day, not just its first few hours (F32, #1888).

  The authority is the persisted `ClubTimeSettings.timeZone`, never the
  container's `TZ` (INV-CONFIG-002), and the only way to show which one answered
  is to make them disagree.
*/
describe("POST /api/admin/deletion-requests/[id] -- the future-stay cut-off is the club's day (CT-4, #2870)", () => {
  it("bounds future bookings by the PERSISTED club day, not the container's", async () => {
    h.prisma.clubTimeSettings.findUnique.mockResolvedValue({
      timeZone: "America/Denver",
      updatedByMemberId: null,
      updatedAt: new Date(0),
    });

    // The premise, measured as an ANSWER rather than a zone identifier: two
    // different zone names can still name the same day (`America/Chicago` gives
    // Denver's answer at this instant), and then the bound below proves nothing.
    /*
     * `APP_TIME_ZONE` PASSED ON PURPOSE (#3123). Everywhere else an explicit
     * zone exists to get OFF the environment; here the environment IS the
     * subject of the assertion — the line measures what the environment
     * authority answers so it can prove the persisted zone answers differently.
     * A literal zone name here would assert something about that name instead,
     * and the premise would stop tracking the environment it is guarding.
     */
    expect(
      getTodayDateOnly(APP_TIME_ZONE).toISOString(),
      "INV-CONFIG-002: the environment authority now names the same day as the " +
        "persisted club zone, so this bound cannot tell the two apart.",
    ).not.toBe("2026-06-30T00:00:00.000Z");

    const response = await POST(req({ action: "approve" }), { params });
    expect(response.status).toBe(200);

    // The frozen clock is 2026-07-01T00:00:00Z: midday on 1 July in New Zealand
    // and still the evening of 30 JUNE in Denver. Every `checkIn` bound the
    // approval builds is the club's day, encoded as UTC midnight for the
    // `@db.Date` column; the environment would have said 1 July, which would
    // have let a stay checking in on 30 June through as already past.
    const checkInBounds = h.prisma.booking.findMany.mock.calls.map(
      (call) =>
        (call[0] as { where: { checkIn: { gte: Date } } }).where.checkIn.gte,
    );
    expect(checkInBounds.length).toBeGreaterThan(0);
    for (const bound of checkInBounds) {
      expect(bound.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    }
  });
});
