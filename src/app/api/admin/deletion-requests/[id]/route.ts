/**
 * F-COMP-04: Admin — Approve, Reject, or Release a Deletion Request
 * POST /api/admin/deletion-requests/[id]
 * Body: { action: "approve" | "reject" | "release", note?: string }
 *
 * `release` (#2627) is the Full-Admin way out of a started approval: it returns
 * an APPROVAL_IN_PROGRESS request to PENDING so it can be decided again, and
 * requires a reason.
 */
import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueHostingCoverageReevaluationForMember } from "@/lib/adult-member-hosting-review";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { getTodayDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { cancelBooking } from "@/lib/booking-cancel";
import { createAuditLog, logAudit } from "@/lib/audit";
import {
  EMPTY_ORPHANED_FAMILY_LINKS,
  readFamilyLinkOrphans,
} from "@/lib/member-family-link-orphans";
import { isFullAdmin, memberHoldsPrivilegedRole } from "@/lib/access-roles";
import {
  AdminAccountGuardError,
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  sendAccountDeletionApprovedEmail,
  sendAccountDeletionRejectedEmail,
  sendAdminPartnerShareSweptAlert,
} from "@/lib/email";
import {
  acquireFuturePartnerSharedAllocationLocks,
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import logger from "@/lib/logger";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import {
  claimDeletionRequestApproval,
  claimDeletionRequestDecision,
  DELETION_REJECT_AFTER_RELEASE_CONFIRM_CODE,
  DELETION_REJECT_AFTER_RELEASE_CONFIRM_MESSAGE,
  DELETION_REJECT_AFTER_RELEASE_FULL_ADMIN_MESSAGE,
  DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED_CODE,
  DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED_MESSAGE,
  DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED_CODE,
  DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED_MESSAGE,
  DELETION_REQUEST_ALREADY_REVIEWED_CODE,
  DELETION_REQUEST_APPROVAL_RELEASED_CODE,
  DELETION_REQUEST_APPROVAL_RELEASED_MESSAGE,
  DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
  DELETION_REQUEST_CLAIM_NOT_HELD_MESSAGE,
  DELETION_REQUEST_RELEASE_CONTENDED_CODE,
  DELETION_REQUEST_RELEASE_CONTENDED_MESSAGE,
  deletionApprovalWasReleased,
  DeletionRequestClaimNotHeldError,
  DeletionRequestDecisionLostError,
  isDeletionRequestTransactionContention,
  releaseDeletionRequestApprovalClaim,
  type DeletionRequestApprovalOrigin,
  type DeletionRequestRejectionOrigin,
} from "@/lib/deletion-request-decision";
import {
  assertNoMemberContactChangeBlockerForDeletion,
  DELETED_ACCOUNT_PASSWORD_HASH,
  lockMemberForAccountDeletionXeroFence,
  XERO_CONTACT_OPERATION_RESOLVE_REMEDY,
  XeroContactCreateBlocksDeletionError,
} from "@/lib/xero-contact-create-recovery";

// Route-private: a Next.js route module's export surface is its handlers.
const DELETION_CLAIM_RELEASE_FULL_ADMIN_MESSAGE =
  "Releasing a started approval needs Full Admin access, because future bookings may already have been cancelled.";
const DELETION_CLAIM_RELEASE_REASON_REQUIRED_MESSAGE =
  "A reason is required to release a started approval.";

const actionSchema = z.object({
  // #2627: `release` returns a wedged or mistaken APPROVAL_IN_PROGRESS claim to
  // PENDING so the request can be decided again. Full Admin only, and the
  // ordinary reject path still makes the actual decision.
  action: z.enum(["approve", "reject", "release"]),
  note: z.string().max(1000).optional(),
  // #2627: warn-and-confirm on the one rejection that can be finalised over
  // already-cancelled stays — a request whose started approval was released.
  // Same shape as the over-capacity confirmation: the first attempt is refused
  // with the disclosure, and only a resubmission carrying this flag proceeds. A
  // stale page therefore cannot finalise that rejection without being told.
  confirmReleasedApproval: z.boolean().optional(),
  // #1788: absent/undefined = notify (default), false = suppress the member
  // email. Only honoured on the REJECT path; the APPROVE path's final privacy
  // receipt (sendAccountDeletionApprovedEmail) always sends regardless. A
  // non-boolean value fails the parse below and returns 400.
  notifyMember: z.boolean().optional(),
});

const CANCELLABLE_DELETION_BOOKING_STATUSES = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
] as const;

function deletionCleanupRecovery(input: {
  cancelledBookings: number;
  cancellationPending: boolean;
  retryBookingId: string | null;
  cancellationStatusUnconfirmed?: boolean;
  cancellationPostProcessingUnconfirmed?: boolean;
  reviewBookingId?: string | null;
  blocker?: {
    code: string;
    message: string;
    remedy: string;
  };
}) {
  return {
    code: "DELETION_CLEANUP_PARTIAL",
    error:
      "Account deletion cleanup is incomplete. The member was not anonymised and no approval receipt was sent. Retry only the remaining cleanup.",
    cancelledBookings: input.cancelledBookings,
    cancellationPending: input.cancellationPending,
    retryBookingId: input.retryBookingId,
    ...(input.cancellationStatusUnconfirmed
      ? { cancellationStatusUnconfirmed: true }
      : {}),
    ...(input.cancellationPostProcessingUnconfirmed
      ? { cancellationPostProcessingUnconfirmed: true }
      : {}),
    ...(input.reviewBookingId
      ? { reviewBookingId: input.reviewBookingId }
      : {}),
    ...(input.blocker ? { blocker: input.blocker } : {}),
    remainingCleanupPending: true,
    memberAnonymised: false,
    memberDataAnonymised: false,
    approvalReceiptSent: false,
  };
}

function isMemberAnonymised(member: {
  firstName: string;
  lastName: string;
  email: string;
  active: boolean;
}): boolean {
  return (
    member.active === false &&
    member.firstName === "Deleted" &&
    member.lastName === "Member" &&
    member.email.startsWith("deleted-") &&
    member.email.endsWith("@deleted.invalid")
  );
}

async function readFinalDeletionDecision(
  requestId: string,
  cancelledBookings: number,
  decisionErrorCode: string,
) {
  try {
    const latest = await prisma.deletionRequest.findUnique({
      where: { id: requestId },
      select: {
        status: true,
        member: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            active: true,
          },
        },
      },
    });
    // #2627: `PENDING` is reachable here now, and only one thing produces it —
    // a release, the sole writer that moves this row backwards (the others are
    // the member's create, the claim, and the two final decisions). So a
    // decision that loses its guarded transition to a release lands on a
    // state that is perfectly well known, and must not be reported as "the final
    // state could not be confirmed": that answer durably disables the row and
    // tells the admin not to retry a decision they can and should now make. No
    // decision happened either, so this is not `decisionFinal`.
    //
    // Two losers arrive here. An approval finalising from a claim that has since
    // been released, and an UNCONFIRMED rejection whose strict guard
    // (`reviewedAt: null`) refused a row the release marker had appeared on
    // between the route's read and its write. Both are told the same true thing:
    // decide it again from the queue, where the row now carries the warning.
    if (latest?.status === "PENDING") {
      return {
        code: DELETION_REQUEST_APPROVAL_RELEASED_CODE,
        error: DELETION_REQUEST_APPROVAL_RELEASED_MESSAGE,
        approvalReleased: true as const,
        decisionFinal: false as const,
        // Whatever this attempt committed before it lost the row stays
        // committed, which is exactly what the next decider has to be told.
        cancelledBookings,
        memberAnonymised: isMemberAnonymised(latest.member),
        retryAllowed: false as const,
      };
    }
    if (
      latest &&
      (latest.status === "APPROVED" || latest.status === "REJECTED")
    ) {
      const memberAnonymised = isMemberAnonymised(latest.member);
      return {
        code: decisionErrorCode,
        error:
          latest.status === "APPROVED"
            ? "Another administrator approved this deletion request. Reload the deletion queue to see the final state."
            : "Another administrator rejected this deletion request. Reload the deletion queue to see the final state.",
        decisionFinal: true as const,
        finalDecision: latest.status,
        cancelledBookings,
        memberAnonymised,
        memberDataAnonymised: memberAnonymised,
        retryAllowed: false as const,
      };
    }
  } catch (error) {
    logger.error(
      { err: error, requestId },
      "Could not re-read a deletion request after its decision claim was lost",
    );
  }

  return {
    code: "DELETION_REQUEST_DECISION_STATUS_UNCONFIRMED",
    error:
      "Another administrator claimed this deletion request, but its final state could not be confirmed. Reload the deletion queue; do not retry the deletion action.",
    decisionStatusUnconfirmed: true as const,
    cancelledBookings,
    retryAllowed: false as const,
  };
}

type CancellationFailureFact =
  | { state: "CANCELLED" }
  | { state: "PENDING" }
  | { state: "STATUS_UNCONFIRMED" };

async function recheckCancellationFailure(
  bookingId: string,
): Promise<CancellationFailureFact> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });
    if (booking?.status === "CANCELLED") {
      return { state: "CANCELLED" };
    }
    if (
      booking &&
      CANCELLABLE_DELETION_BOOKING_STATUSES.some(
        (status) => status === booking.status,
      )
    ) {
      return { state: "PENDING" };
    }
    return { state: "STATUS_UNCONFIRMED" };
  } catch (error) {
    logger.error(
      { err: error, bookingId },
      "Could not authoritatively recheck booking after deletion cleanup failure",
    );
    return { state: "STATUS_UNCONFIRMED" };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  let body: {
    action: "approve" | "reject" | "release";
    note?: string;
    notifyMember?: boolean;
    confirmReleasedApproval?: boolean;
  };
  try {
    const raw = await request.json();
    body = actionSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  let completedBookingCancellations = 0;
  let memberAnonymised = false;

  try {
    const deletionRequest = await prisma.deletionRequest.findUnique({
      where: { id },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            financeAccessLevel: true,
            active: true,
            accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
          },
        },
      },
    });

    if (!deletionRequest) {
      return NextResponse.json({ error: "Deletion request not found" }, { status: 404 });
    }

    const claimIsHeld = deletionRequest.status === "APPROVAL_IN_PROGRESS";
    const approvalCanResume = body.action === "approve" && claimIsHeld;
    // #2627: a release acts ON the claim, so the claimed state is the only one
    // it can run from. A release aimed at a PENDING request falls through to the
    // dedicated 409 below rather than this "already reviewed" one.
    const releaseCanRun = body.action === "release" && claimIsHeld;
    if (
      deletionRequest.status !== "PENDING" &&
      !approvalCanResume &&
      !releaseCanRun
    ) {
      return NextResponse.json(
        await readFinalDeletionDecision(
          id,
          completedBookingCancellations,
          DELETION_REQUEST_ALREADY_REVIEWED_CODE,
        ),
        { status: 409 }
      );
    }

    const member = deletionRequest.member;

    // --- RELEASE a started approval (#2627) ---
    //
    // The claim exists so a rejection cannot overtake booking cancellations an
    // approval already committed. That protection must not become a trap: a
    // permanently blocked approval would otherwise leave the request open
    // forever, and while it is open the member cannot lodge a new deletion
    // request and their duplicate cannot be merged.
    //
    // Full Admin only, and the reason is mandatory, because on the path where
    // cancellations DID commit this deliberately re-opens a decision that had
    // been closed to rejection. Releasing anonymises nobody and sends the
    // member nothing; it returns the request to PENDING so the ordinary
    // approve/reject paths — with their own guards, audit entries and notify
    // choice — can decide it again.
    if (body.action === "release") {
      if (!isFullAdmin(session.user)) {
        return NextResponse.json(
          { error: DELETION_CLAIM_RELEASE_FULL_ADMIN_MESSAGE },
          { status: 403 },
        );
      }
      // Only a PENDING request can reach here without holding the claim (the
      // status gate above already refused a decided one). Say that plainly
      // before asking for a reason to do something there is nothing to do.
      if (!claimIsHeld) {
        return NextResponse.json(
          {
            code: DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
            error: DELETION_REQUEST_CLAIM_NOT_HELD_MESSAGE,
            retryAllowed: false,
          },
          { status: 409 },
        );
      }
      const releaseReason = body.note?.trim();
      if (!releaseReason) {
        return NextResponse.json(
          { error: DELETION_CLAIM_RELEASE_REASON_REQUIRED_MESSAGE },
          { status: 400 },
        );
      }

      // One transaction, so the record and the transition cannot part company.
      // The release destroys the claim's attribution, which makes this audit row
      // the only surviving record of who held it — and `logAudit` is
      // fire-and-forget, so a failed insert or a process death right after the
      // 200 would have lost that permanently. Awaited inside the transaction
      // that performs the transition, an audit failure rolls the release back:
      // the operator sees an error and the claim is still there to release
      // again. The attribution itself comes from the release's own locked read
      // rather than the unguarded read above, so an ABA interleaving cannot
      // record a holder that was never displaced.
      //
      // Explicit timings, and a mapped answer for an exhausted wait. This is the
      // one transaction here whose FIRST statement is designed to block: it takes
      // the request row `FOR UPDATE` while the counterpart anonymisation
      // transaction may hold that same row from its claim to its commit. Prisma's
      // 5s default would abort a legitimate wait with P2028 — and before this
      // action existed the release was an auto-commit `updateMany`, which blocked
      // and then returned the mapped 409, so a bare 500 here would be a
      // regression under contention. 15s is deliberately longer than the
      // anonymisation transaction's own (default 5s) budget, so a release loses
      // to it on the guard rather than on the clock; 10s `maxWait` covers a
      // saturated pool. An exhausted wait is mapped to 503 below, following
      // `src/app/api/admin/site-style/route.ts` and
      // `docs/CONCURRENCY_AND_LOCKING.md`.
      let release: Awaited<
        ReturnType<typeof releaseDeletionRequestApprovalClaim>
      >;
      try {
        release = await prisma.$transaction(
          async (tx) => {
            const released = await releaseDeletionRequestApprovalClaim(tx, {
              id,
              adminNote: releaseReason,
            });

            await createAuditLog(
              {
                action: "member.deletion_approval_claim_released",
                memberId: session.user.id,
                targetId: member.id,
                details: `Started approval released back to pending. Reason: ${releaseReason}`,
                ipAddress: ip,
                category: "privacy",
                severity: "important",
                outcome: "success",
                metadata: {
                  previousClaimHeldBy: released.previousClaimHeldBy,
                  previousAdminNote: released.previousAdminNote,
                  releasedAt: released.releasedAt.toISOString(),
                },
              },
              tx,
            );

            return released;
          },
          { maxWait: 10_000, timeout: 15_000 },
        );
      } catch (releaseError) {
        // Contention, not a fault: the whole transaction rolled back, so nothing
        // was released, nothing was recorded, and the claim is still there. Say
        // that and invite a retry, rather than reporting a failure the operator
        // cannot act on. Scoped to this branch on purpose — the approval's own
        // transaction reports contention through its partial-cleanup contract,
        // which must not be replaced by a bare retry-later.
        if (isDeletionRequestTransactionContention(releaseError)) {
          logger.warn(
            { err: releaseError, requestId: id },
            "Deletion approval release contended with a committing decision",
          );
          return NextResponse.json(
            {
              code: DELETION_REQUEST_RELEASE_CONTENDED_CODE,
              error: DELETION_REQUEST_RELEASE_CONTENDED_MESSAGE,
              retryAllowed: true,
            },
            { status: 503 },
          );
        }
        throw releaseError;
      }

      return NextResponse.json({
        message:
          "Approval released. The request is pending again and can be approved or rejected. Any future bookings already cancelled by the started approval stay cancelled, and the request now says so to whoever decides it next.",
        releasedAt: release.releasedAt.toISOString(),
      });
    }

    if (body.action === "reject") {
      // #2627: the ONE rejection that can be finalised over stays a started
      // approval already cancelled — a request whose claim was released. The
      // release itself is gated and reasoned, but the release is not the harmful
      // step; this is. So the gate and the disclosure are repeated here, on the
      // step that does the harm:
      //
      //  - Full Admin, matching the release that produced this state. A
      //    Membership Officer who meets one escalates instead of declining a
      //    request whose consequences they cannot see.
      //  - an explicit confirmation, because a page loaded before the
      //    release renders an ordinary Pending row with no warning on it. The
      //    first attempt is refused WITH the disclosure, so no rejection can be
      //    finalised here without the decider having been told.
      //  - and, mirroring the release, a mandatory reason that the member is
      //    actually sent. Everything above is admin-facing; these two are the
      //    only things the MEMBER gets, and without them a Full Admin could
      //    confirm, leave the note empty, suppress the email, and decline them
      //    over cancelled stays with nothing said at all.
      //
      // The gate is evaluated against the opening read, which is not the
      // serialised point — so it decides only what to REFUSE. What the rejection
      // is allowed to WIN is carried into the guarded transition itself as
      // `rejectFrom`: an unconfirmed rejection can take only a row with no
      // release marker, so a release committing between that read and this write
      // makes it lose rather than silently converting it into an unwarned
      // reject-after-release.
      const rejectingAfterRelease =
        deletionApprovalWasReleased(deletionRequest);
      const rejectFrom: DeletionRequestRejectionOrigin = rejectingAfterRelease
        ? "PENDING_RELEASED"
        : "PENDING";
      if (rejectingAfterRelease) {
        if (!isFullAdmin(session.user)) {
          return NextResponse.json(
            { error: DELETION_REJECT_AFTER_RELEASE_FULL_ADMIN_MESSAGE },
            { status: 403 },
          );
        }
        if (body.confirmReleasedApproval !== true) {
          return NextResponse.json(
            {
              code: DELETION_REJECT_AFTER_RELEASE_CONFIRM_CODE,
              error: DELETION_REJECT_AFTER_RELEASE_CONFIRM_MESSAGE,
              approvalReleased: true,
              approvalReleasedAt: deletionRequest.reviewedAt?.toISOString(),
              releaseReason: deletionRequest.adminNote,
              retryAllowed: false,
            },
            { status: 409 },
          );
        }
        if (!body.note?.trim()) {
          return NextResponse.json(
            {
              code: DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED_CODE,
              error: DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED_MESSAGE,
            },
            { status: 400 },
          );
        }
        if (body.notifyMember === false) {
          return NextResponse.json(
            {
              code: DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED_CODE,
              error: DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED_MESSAGE,
            },
            { status: 400 },
          );
        }
      }

      await claimDeletionRequestDecision(prisma, {
        id,
        decision: "REJECTED",
        adminNote: body.note ?? null,
        reviewedBy: session.user.id,
        rejectFrom,
      });

      // #1788 honesty rule — record the suppression in the audit ONLY on a path
      // that truly would have sent. The member is emailed unless they have no
      // address on file (member.email is a required field, so in practice this
      // is always present) or the admin opted out.
      //
      // #2627: a rejection finalised over a released approval is the one that may
      // leave the member declined with their stays already cancelled, so the
      // audit trail says so rather than leaving it to be reconstructed from two
      // separate entries.
      const rejectAuditMetadata = {
        ...(member.email && body.notifyMember === false
          ? { notifyMember: false }
          : {}),
        ...(rejectingAfterRelease
          ? {
              approvalPreviouslyReleased: true,
              approvalReleasedAt: deletionRequest.reviewedAt?.toISOString(),
            }
          : {}),
      };

      logAudit({
        action: "member.deletion_rejected",
        // `privacy`, matching the four categorised deletion writers already in
        // this route (#2581). `privacy` is in the MEMBERSHIP correlation domain,
        // so the row is readable two ways and they are not the same permission:
        // AI Diagnostics' membership CORRELATION entry needs `support:view` plus
        // `membership:view` (a domain-wide window of recent events), while its
        // record-scoped membership audit history needs `membership:view` alone
        // (one exact record id, fewer columns) — see
        // `aid6bRecordAuditReaderAreas`. Admin > Audit Log is unaffected.
        // `entityId` deliberately repeats `targetId`, so the subject the Admin
        // timeline resolves is byte-identical to today — the entity fields add
        // a type to the correlation projection, they do not move the row.
        category: "privacy",
        memberId: session.user.id,
        targetId: member.id,
        entityType: "Member",
        entityId: member.id,
        details: body.note ? `Note: ${body.note}` : "No note",
        ipAddress: ip,
        ...(Object.keys(rejectAuditMetadata).length > 0
          ? { metadata: rejectAuditMetadata }
          : {}),
      });

      // #1788: email the member unless the admin opted out (default = notify).
      if (body.notifyMember !== false) {
        sendAccountDeletionRejectedEmail(
          member.email,
          member.firstName,
          body.note ?? ""
        ).catch((err) =>
          logger.error({ err, memberId: member.id }, "Failed to send deletion rejected email")
        );
      }

      return NextResponse.json({ message: "Deletion request rejected." });
    }

    // --- APPROVE ---

    // Admin-account guards (issue #1604). Approving a deletion request
    // anonymises the member and sets active=false, so it is a deactivate of
    // the target. A member cannot self-request deletion while holding admin
    // access, but a request made before promotion could later target an
    // admin, so re-check at this execution point. Fail fast here (before any
    // booking cancellation) on the actor-permission and invariant; the
    // last-admin check is repeated inside the anonymise transaction below for
    // race-safety.
    if (!isFullAdmin(session.user) && memberHoldsPrivilegedRole(member)) {
      return NextResponse.json(
        { error: PRIVILEGED_TARGET_GUARD_MESSAGE },
        { status: 403 },
      );
    }
    if (await wouldRemoveLastFullAdmin(prisma, member.id)) {
      return NextResponse.json(
        { error: LAST_FULL_ADMIN_GUARD_MESSAGE },
        { status: 409 },
      );
    }

    // A Xero contact operation in flight blocks the anonymisation below, and
    // that check used to happen only inside the anonymise transaction — after
    // the loop had already cancelled every future booking. So an approval could
    // destroy a member's stays and then stop, for a condition that was knowable
    // before any of them was touched.
    //
    // Ask the same question here, unlocked, as a fail-fast alongside the other
    // guards. This is advisory only: the AUTHORITATIVE check is still
    // lockMemberForAccountDeletionXeroFence inside the anonymise transaction,
    // which holds the Member row through commit. It must stay there — hoisting
    // the LOCK to wrap the cancellation loop would hold a row lock across
    // separately committed transactions and provider work. A reservation that
    // starts between this check and that one is still caught, and the approval
    // is then recoverable rather than final (#2623 T1).
    try {
      await assertNoMemberContactChangeBlockerForDeletion(member.id, prisma);
    } catch (err) {
      if (err instanceof XeroContactCreateBlocksDeletionError) {
        return NextResponse.json(
          {
            error: err.message,
            code: err.code,
            // #2623 T7: name the operation and where the remedy lives, so the
            // refusal is actionable instead of an unexplained 409.
            ...(err.operationId
              ? {
                  xeroOperationId: err.operationId,
                  remedy: XERO_CONTACT_OPERATION_RESOLVE_REMEDY,
                }
              : {}),
          },
          { status: err.statusCode },
        );
      }
      throw err;
    }

    // checkIn is @db.Date (NZ calendar date at UTC midnight). Use the date-only
    // "today" rather than a raw instant so a stay checking in today still counts
    // as future for the whole NZ day, not just the first ~13h (F32, #1888).
    const today = getTodayDateOnly();

    // 1. Block approval while future paid stays still need financial/lodge follow-up.
    const futurePaidBookings = await prisma.booking.findMany({
      where: {
        memberId: member.id,
        status: "PAID",
        checkIn: { gte: today },
      },
      select: { id: true },
    });

    if (futurePaidBookings.length > 0) {
      const paidBookingIds = futurePaidBookings.map((booking) => booking.id);
      logger.warn(
        { memberId: member.id, paidBookingIds },
        "Blocked account deletion approval because future paid bookings remain active"
      );
      logAudit({
        action: "member.deletion_approval_blocked",
        memberId: session.user.id,
        targetId: member.id,
        details: `Future paid bookings must be resolved before anonymisation: ${paidBookingIds.join(", ")}`,
        ipAddress: ip,
        category: "privacy",
        severity: "important",
        outcome: "blocked",
      });

      return NextResponse.json(
        {
          error:
            "Account deletion cannot be approved while this member has future paid bookings. Cancel or refund the paid bookings first.",
          paidBookingIds,
        },
        { status: 409 }
      );
    }

    // 2. Cancel all future unpaid/hold bookings for the member.
    const futureBookings = await prisma.booking.findMany({
      where: {
        memberId: member.id,
        status: { in: [...CANCELLABLE_DELETION_BOOKING_STATUSES] },
        checkIn: { gte: today },
      },
      select: { id: true },
    });

    // The cleanup below commits one booking cancellation at a time. Own the
    // approval decision durably before the first such commit, so rejection can
    // only win while the request is still PENDING and no approval cleanup has
    // begun. A retry resumes this same intermediate claim.
    //
    // #2627: only when there is genuinely something irreversible to protect.
    // With no future bookings to cancel, this approval commits everything it
    // does in the single anonymisation transaction below, so claiming would
    // consume the ability to reject in exchange for nothing — and a permanent
    // failure inside that transaction would then wedge a request that nobody
    // had done anything to. A claim that already exists is still resumed (and
    // re-validated) here, because the earlier attempt may well have cancelled
    // bookings before it stopped.
    let approvalOrigin: DeletionRequestApprovalOrigin = "PENDING";
    if (futureBookings.length > 0 || approvalCanResume) {
      await claimDeletionRequestApproval(prisma, {
        id,
        adminNote: body.note ?? null,
        reviewedBy: session.user.id,
      });
      approvalOrigin = "APPROVAL_IN_PROGRESS";
    }

    const cancelledBookingIds: string[] = [];
    for (const booking of futureBookings) {
      let result;
      try {
        result = await cancelBooking(
          booking.id,
          session.user.id,
          "ADMIN",
          ip,
        );
      } catch (err) {
        const cancellationFact = await recheckCancellationFailure(booking.id);
        if (
          cancellationFact.state === "CANCELLED" &&
          !cancelledBookingIds.includes(booking.id)
        ) {
          cancelledBookingIds.push(booking.id);
          completedBookingCancellations = cancelledBookingIds.length;
        }
        const recovery = deletionCleanupRecovery({
          cancelledBookings: cancelledBookingIds.length,
          cancellationPending: cancellationFact.state === "PENDING",
          retryBookingId:
            cancellationFact.state === "PENDING" ? booking.id : null,
          cancellationStatusUnconfirmed:
            cancellationFact.state === "STATUS_UNCONFIRMED",
          cancellationPostProcessingUnconfirmed:
            cancellationFact.state === "CANCELLED",
          reviewBookingId:
            cancellationFact.state === "PENDING" ? null : booking.id,
        });
        const hostingRetry = hostingCoverageParticipantRetryResponse(err, recovery);
        if (hostingRetry) return hostingRetry;
        logger.error(
          { err, memberId: member.id, bookingId: booking.id },
          "Account deletion cleanup stopped after a booking cancellation error",
        );
        return NextResponse.json(recovery, { status: 500 });
      }
      if (result.status === 200) {
        cancelledBookingIds.push(booking.id);
        completedBookingCancellations = cancelledBookingIds.length;
      } else {
        const cancellationFact = await recheckCancellationFailure(booking.id);
        if (cancellationFact.state === "CANCELLED") {
          if (!cancelledBookingIds.includes(booking.id)) {
            cancelledBookingIds.push(booking.id);
            completedBookingCancellations = cancelledBookingIds.length;
          }
          continue;
        }
        logger.warn(
          { bookingId: booking.id, memberId: member.id, result },
          "Failed to cancel booking during account deletion"
        );
        logAudit({
          action: "member.deletion_cleanup_failed",
          memberId: session.user.id,
          targetId: member.id,
          details: `Account deletion approval stopped; failed to cancel future booking: ${booking.id}`,
          ipAddress: ip,
          category: "privacy",
          severity: "critical",
          outcome: "failure",
        });
        return NextResponse.json(
          deletionCleanupRecovery({
            cancelledBookings: cancelledBookingIds.length,
            cancellationPending: cancellationFact.state === "PENDING",
            retryBookingId:
              cancellationFact.state === "PENDING" ? booking.id : null,
            cancellationStatusUnconfirmed:
              cancellationFact.state === "STATUS_UNCONFIRMED",
            reviewBookingId:
              cancellationFact.state === "PENDING" ? null : booking.id,
          }),
          { status: 409 },
        );
      }
    }

    // Capture the destination before anonymisation, but send only after commit.
    // A participant retry must not send a false approval receipt, and provider
    // calls must remain outside lifecycle/participant lock transactions.
    const approvalReceipt = { email: member.email, firstName: member.firstName };

    // 4-7: Anonymise atomically in a single transaction
    const anonymisedEmail = `deleted-${member.id.substring(0, 8)}@deleted.invalid`;
    let sweptShares: SweptPartnerSharedAllocation[] = [];
    // #2255: who was still pointed at this member when we anonymised them.
    let detachedFamilyLinks = EMPTY_ORPHANED_FAMILY_LINKS;
    await prisma.$transaction(async (tx) => {
      await acquireFuturePartnerSharedAllocationLocks(tx, [member.id]);
      await acquireMemberLifecycleLocks(tx, [member.id]);
      // Race-safe re-check of the last-admin invariant inside the mutation
      // transaction (issue #1604): the fail-fast check above ran before the
      // booking cleanup, so re-count against this transaction's read view.
      if (await wouldRemoveLastFullAdmin(tx, member.id)) {
        throw new AdminAccountGuardError(LAST_FULL_ADMIN_GUARD_MESSAGE);
      }

      // Final approval is deliberately inside the anonymisation transaction so
      // any later failure restores the state it started from and sends no
      // receipt. Where that state is the durable claim, rejection cannot take
      // it, and a later approval may safely resume only the remaining cleanup.
      // Where no claim was needed (#2627 — nothing to cancel), it is still
      // PENDING, an ordinary rejection can still win, and exactly one of the two
      // guarded transitions succeeds.
      await claimDeletionRequestDecision(tx, {
        id,
        decision: "APPROVED",
        adminNote: body.note ?? null,
        reviewedBy: session.user.id,
        approvalFrom: approvalOrigin,
      });

      // #1756: anonymisation deactivates the member and unlinks their guest
      // rows, breaking the double-bed sharing precondition. Sweep their future
      // shared-double placements now, while bookingGuest.memberId (nulled in
      // step 5 below) still identifies them. Second-occupant appearances on
      // OTHER members' bookings survive the own-booking cancellation above, so
      // this is not vacuously empty.
      sweptShares = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
        memberId: member.id,
        reason: "member_deactivated",
        db: tx,
      });

      // Record the exact bounded fan-out before deactivation and guest unlinking
      // remove the evidence. It commits or rolls back with anonymisation.
      await enqueueHostingCoverageReevaluationForMember(member.id, tx, {
        cause: "SYSTEM_CHANGE",
        actorMemberId: session.user.id,
      });

      // The standing fan-out above holds this exact Member row FOR UPDATE.
      // Re-check the complete contact-create recovery set while that fence is
      // held so deletion cannot anonymise a member whose PII may already be in
      // flight to Xero or whose provider-created contact still needs linking.
      await lockMemberForAccountDeletionXeroFence(tx, member.id);

      // 3. Anonymise the member record
      await tx.member.update({
        where: { id: member.id },
        data: {
          firstName: "Deleted",
          lastName: "Member",
          email: anonymisedEmail,
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          dateOfBirth: null,
          streetAddressLine1: null,
          streetAddressLine2: null,
          streetCity: null,
          streetRegion: null,
          streetPostalCode: null,
          streetCountry: null,
          postalAddressLine1: null,
          postalAddressLine2: null,
          postalCity: null,
          postalRegion: null,
          postalPostalCode: null,
          postalCountry: null,
          passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
          active: false,
          // #2620: anonymisation used to leave every credential usable, so
          // `active: false` was the only thing between an erased member and a
          // working session — and Reactivate flips exactly that. Google sign-in
          // resolves on `googleSub` and never on email, so the placeholder
          // address stopped nothing. Clear the credentials themselves, so no
          // path that reaches `active` can produce a login. Dropping `canLogin`
          // also takes the row out of the partial unique index on (email) WHERE
          // canLogin, which removes the collision between two anonymised
          // members whose ids share the truncated prefix in `anonymisedEmail`.
          canLogin: false,
          googleSub: null,
          emailVerified: false,
          totpSecret: null,
          twoFactorEnabled: false,
          twoFactorMethod: null,
          twoFactorEnrolledAt: null,
          twoFactorFailedAttempts: 0,
          twoFactorLockedUntil: null,
          xeroContactId: null,
          inheritEmailFromId: null,
          // Billing-family removal sweep (#1932, E6): the member is leaving all
          // families here, so clear any billing-family selection they hold.
          billingFamilyGroupId: null,
        },
      });

      // #2620: the credentials cleared above are not the only ones. Every
      // outstanding token and second-factor artefact is independently sufficient
      // to authenticate, and deletion revoked none of them — a live magic link
      // or an unused recovery code still worked. Revoke them in the same commit,
      // so the erased account holds nothing that can be presented later.
      await Promise.all([
        tx.magicLinkToken.deleteMany({ where: { memberId: member.id } }),
        tx.passwordResetToken.deleteMany({ where: { memberId: member.id } }),
        tx.emailChangeToken.deleteMany({ where: { memberId: member.id } }),
        tx.twoFactorEmailCode.deleteMany({ where: { memberId: member.id } }),
        tx.twoFactorRecoveryCode.deleteMany({ where: { memberId: member.id } }),
        tx.twoFactorSessionChallenge.deleteMany({
          where: { memberId: member.id },
        }),
      ]);

      // The pointer and canonical ledger are one privacy boundary. A contact
      // update that completed before this transaction may have refreshed the
      // active link; deactivate it in the same commit that anonymises Member.
      await tx.xeroObjectLink.updateMany({
        where: {
          localModel: "Member",
          localId: member.id,
          xeroObjectType: "CONTACT",
          active: true,
        },
        data: { active: false },
      });

      // 4. Remove from all family groups
      await tx.familyGroupMember.deleteMany({
        where: { memberId: member.id },
      });

      // #2255: anonymisation nulled this member's OWN inheritance pointer but
      // left every pointer aimed AT them untouched, so their dependants — and,
      // at four generations, their grandchildren — kept resolving club email to
      // the `@deleted.invalid` address this route had just written. That is a
      // hard bounce on every send, forever, with nothing on any screen saying
      // so. The lifecycle paths (cancellation, archive) already sweep those
      // pointers; this one now does too, and names who it detached in the audit
      // rather than only counting them.
      //
      // The parent LINKS are deliberately left in place: anonymisation keeps
      // the member row for history, so the family structure is still true even
      // though the person's details are gone. It is only the mailbox that has
      // to stop being used.
      detachedFamilyLinks = await readFamilyLinkOrphans(tx, member.id);
      await tx.member.updateMany({
        where: { inheritEmailFromId: member.id },
        data: { inheritEmailFromId: null, inheritParentEmail: false },
      });

      // 5. Anonymise BookingGuest names for this member's guest appearances
      await tx.bookingGuest.updateMany({
        where: { memberId: member.id },
        data: {
          firstName: "Deleted",
          lastName: "Member",
          memberId: null,
        },
      });

    });
    memberAnonymised = true;

    try {
      await sendAccountDeletionApprovedEmail(
        approvalReceipt.email,
        approvalReceipt.firstName,
      );
    } catch (err) {
      logger.error({ err, memberId: member.id }, "Failed to send deletion approved email");
      // Continue — email failure should not undo the committed deletion.
    }
    await settleHostingCoverageAfterCommit({ limit: 25 });

    if (sweptShares.length > 0) {
      // Post-commit, fire-and-forget (#1756). Uses the pre-anonymisation name
      // captured above — admins keep an actionable reference, consistent with
      // the audit trail this route already retains.
      sendAdminPartnerShareSweptAlert({
        memberName: `${member.firstName} ${member.lastName}`.trim(),
        partnerName: partnerShareSweepCounterpartNames(sweptShares, member.id),
        reason: describePartnerSharedSweepReason("member_deactivated"),
        nights: partnerShareSweepNights(sweptShares),
      }).catch((alertErr) => {
        logger.error(
          { err: alertErr, memberId: member.id, sweptCount: sweptShares.length },
          "Failed to send partner share sweep alert"
        );
      });
    }

    logAudit({
      action: "member.deletion_approved",
      // `privacy`, as above. Its retention moves from "no expiry at all" to
      // `critical`, a seven-year expiry, in this change. That is the longest
      // class available and the deliberate answer for a deletion decision.
      //
      // Stated because it is the half that is easy to miss: `critical` is NOT in
      // `ARCHIVABLE_RETENTION_CLASSES`, so this row is never copied to the audit
      // archive. At seven years `pruneExpiredAuditLogs` deletes it outright and
      // there is no second copy.
      //
      // WHAT THAT PRUNE ACTUALLY DESTROYS, scoped — this row is NOT the only
      // surviving evidence of the erasure, and treating it as such overstates
      // the case. The `DeletionRequest` survives: approval anonymises the
      // `Member` IN PLACE (see the transaction above) and never deletes it, so
      // the relation's `onDelete: Cascade` never fires here; no production path
      // deletes a `DeletionRequest`; and the row carries no expiry of its own.
      // So `memberId`, `status: APPROVED`, `createdAt` and `reviewedAt` — that
      // an erasure was approved, against whom, and when — outlive this audit
      // row. What only this row holds is the acting administrator's IP address,
      // the number of future bookings the erasure cancelled, and the
      // `detachedEmailInheritorIds`/`dependantIds` in `metadata` below.
      //
      // Add WHO approved it whenever the approval took no durable claim: with
      // nothing to cancel (#2627) the finalisation runs from `PENDING`, and
      // `claimDeletionRequestDecision`'s APPROVED branch writes only `status`
      // and `reviewedAt` — `DeletionRequest.reviewedBy` and `adminNote` stay as
      // they were, which on a never-claimed request is NULL. In that case this
      // row is the only attribution. (A later member hard delete would cascade
      // the request row away as well, but that is a separate act with its own
      // audit entry.)
      //
      // `buildAuditLogCreateData` accepts an explicit `expiresAt: null`
      // alongside a category, which would keep the row forever while still
      // making it readable by Diagnostics — deliberately NOT used here, because
      // "keep one class of row about a person forever" is the club's retention
      // decision to make, not this change's. #2581 child 3 carries it.
      category: "privacy",
      memberId: session.user.id,
      targetId: member.id,
      entityType: "Member",
      entityId: member.id,
      details: `Account anonymised. Cancelled ${cancelledBookingIds.length} future bookings.${body.note ? ` Note: ${body.note}` : ""}`,
      ipAddress: ip,
      metadata: {
        detachedEmailInheritorIds: detachedFamilyLinks.emailInheritors.map(
          (inheritor) => inheritor.id,
        ),
        dependantIds: detachedFamilyLinks.dependants.map(
          (dependant) => dependant.id,
        ),
      },
    });

    return NextResponse.json({
      message: "Account deletion approved. Member data has been anonymised.",
      cancelledBookings: cancelledBookingIds.length,
      orphanedLinks: detachedFamilyLinks,
    });
  } catch (err) {
    const recovery = deletionCleanupRecovery({
      cancelledBookings: completedBookingCancellations,
      cancellationPending: false,
      retryBookingId: null,
    });
    const hostingRetry = hostingCoverageParticipantRetryResponse(err, recovery);
    if (hostingRetry) return hostingRetry;
    if (err instanceof AdminAccountGuardError) {
      if (completedBookingCancellations > 0 && !memberAnonymised) {
        return NextResponse.json(
          deletionCleanupRecovery({
            cancelledBookings: completedBookingCancellations,
            cancellationPending: false,
            retryBookingId: null,
            blocker: {
              code: "LAST_FULL_ADMIN_GUARD",
              message: err.message,
              remedy:
                "Give another active account Full Admin access, then retry only the remaining deletion cleanup.",
            },
          }),
          { status: err.statusCode },
        );
      }
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }
    if (err instanceof DeletionRequestDecisionLostError) {
      return NextResponse.json(
        await readFinalDeletionDecision(
          id,
          completedBookingCancellations,
          err.code,
        ),
        { status: err.statusCode },
      );
    }
    // #2627: the release lost the row to a finalisation that was already
    // committing (or to another release). Name the cause; do not retry.
    if (err instanceof DeletionRequestClaimNotHeldError) {
      return NextResponse.json(
        { code: err.code, error: err.message, retryAllowed: false },
        { status: err.statusCode },
      );
    }
    if (err instanceof XeroContactCreateBlocksDeletionError) {
      const xeroRecovery = deletionCleanupRecovery({
        cancelledBookings: completedBookingCancellations,
        cancellationPending: false,
        retryBookingId: null,
        blocker: {
          code: err.code,
          message: err.message,
          remedy: `Wait for or resolve the current Xero contact operation${
            err.operationId ? ` (${err.operationId})` : ""
          } under Admin → Xero → Operations, then retry only the remaining deletion cleanup.`,
        },
      });
      return NextResponse.json(
        {
          ...xeroRecovery,
          code: err.code,
          error: err.message,
          ...(err.operationId ? { xeroOperationId: err.operationId } : {}),
        },
        { status: err.statusCode },
      );
    }
    logger.error({ err, requestId: id }, "Failed to process deletion request");
    if (completedBookingCancellations > 0 && !memberAnonymised) {
      return NextResponse.json(recovery, { status: 500 });
    }
    return NextResponse.json({ error: "Failed to process deletion request" }, { status: 500 });
  }
}
