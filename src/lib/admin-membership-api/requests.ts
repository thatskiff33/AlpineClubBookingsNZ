/**
 * The request schemas of the membership application queue and the archive,
 * cancellation and deletion request routes, shared with the AI app actions
 * that call them (ALP-720, `INV-SSOT`): the app is described exactly the
 * fields each route enforces.
 */
import {
  ApplicationStatus,
  DeletionRequestStatus,
  MemberLifecycleAction,
  MemberLifecycleActionRequestStatus,
  MembershipCancellationRequestStatus,
} from "@prisma/client";
import { z } from "zod";

import { adminListPageQueryFields } from "@/lib/admin-list-page";
import type { NominatorSlot } from "@/lib/nomination-slots";
import { recordIdParamsSchema } from "@/lib/route-id-params";

// ---------------------------------------------------------------------------
// Membership applications
// ---------------------------------------------------------------------------

/** `GET /api/admin/member-applications`: every status when `status` is left out. */
export const memberApplicationListQuerySchema = z.object({
  status: z.enum(ApplicationStatus).optional(),
  ...adminListPageQueryFields,
});

const NOMINATOR_SLOTS = ["nominator1", "nominator2"] as const satisfies readonly NominatorSlot[];

// Compile-time guard: the tuple names every slot `NominatorSlot` has, so the
// route cannot refuse a slot the nomination service accepts.
type MissingNominatorSlot = Exclude<NominatorSlot, (typeof NOMINATOR_SLOTS)[number]>;
const everyNominatorSlotListed: [MissingNominatorSlot] extends [never] ? true : never = true;
void everyNominatorSlotListed;

/** The address of `POST /api/admin/member-applications/[id]/nominators/[slot]/replace`. */
export const replaceNominatorParamsSchema = recordIdParamsSchema.extend({
  slot: z.enum(NOMINATOR_SLOTS),
});

/** `POST /api/admin/member-applications/[id]/nominators/[slot]/replace`. */
export const replaceNominatorSchema = z.object({
  memberId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Archive and membership cancellation requests an officer raises
// ---------------------------------------------------------------------------

/** The reason an officer gives for a request a second officer decides. */
const officerRequestReason = z.string().trim().min(1).max(1000);

/** `POST /api/admin/members/[id]/lifecycle/archive`. */
export const memberArchiveRequestSchema = z.object({
  reason: officerRequestReason,
});

/** `POST /api/admin/members/[id]/membership-cancellation`. */
export const adminMembershipCancellationRequestSchema = z.object({
  reason: officerRequestReason,
});

// ---------------------------------------------------------------------------
// Request queues
// ---------------------------------------------------------------------------

/**
 * `GET /api/admin/member-lifecycle-action-requests`. ARCHIVE feeds the
 * membership-cancellations page; DELETE feeds the admin-initiated section on
 * /admin/deletion-requests (#1938). The action defaults to ARCHIVE for
 * back-compat (pinned by test).
 *
 * The deletion-requests page filter speaks the self-service vocabulary
 * (PENDING|APPROVED|REJECTED); lifecycle requests use REQUESTED for the
 * pending state. PENDING is accepted and the route maps it to REQUESTED at
 * the boundary (#1938), so `?action=DELETE&status=PENDING` does not 400.
 */
export const memberLifecycleRequestListQuerySchema = z.object({
  action: z
    .enum([MemberLifecycleAction.ARCHIVE, MemberLifecycleAction.DELETE])
    .optional()
    .default(MemberLifecycleAction.ARCHIVE),
  status: z
    .enum([
      "PENDING",
      MemberLifecycleActionRequestStatus.REQUESTED,
      MemberLifecycleActionRequestStatus.APPROVED,
      MemberLifecycleActionRequestStatus.REJECTED,
      "ALL",
    ])
    .optional()
    .default(MemberLifecycleActionRequestStatus.REQUESTED),
  ...adminListPageQueryFields,
});

/** `GET /api/admin/membership-cancellation-requests`: REQUESTED when `status` is left out. */
export const membershipCancellationRequestListQuerySchema = z.object({
  status: z
    .enum([
      MembershipCancellationRequestStatus.REQUESTED,
      MembershipCancellationRequestStatus.APPROVED,
      MembershipCancellationRequestStatus.REJECTED,
      MembershipCancellationRequestStatus.WITHDRAWN,
      MembershipCancellationRequestStatus.COMPLETED,
      "ALL",
    ])
    .optional()
    .default(MembershipCancellationRequestStatus.REQUESTED),
  ...adminListPageQueryFields,
});

/** The address of one participant of a membership cancellation request. */
export const membershipCancellationParticipantParamsSchema = z.object({
  requestId: z.string().min(1),
  participantId: z.string().min(1),
});

/**
 * `GET /api/admin/deletion-requests`: PENDING, the open queue, when `status`
 * is left out. PENDING also lists APPROVAL_IN_PROGRESS, so that status is not
 * a filter of its own.
 */
export const deletionRequestListQuerySchema = z.object({
  status: z
    .enum([DeletionRequestStatus.PENDING, DeletionRequestStatus.APPROVED, DeletionRequestStatus.REJECTED, "ALL"])
    .optional()
    .default(DeletionRequestStatus.PENDING),
  ...adminListPageQueryFields,
});
