import { createHmac, timingSafeEqual } from "crypto";
import { AccessRole, type Member, type Prisma } from "@prisma/client";
import { reconcileEmailInheritanceForMemberChange } from "@/lib/member-email-inheritance";
import {
  actorIsFullAdmin,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { hasAdminAccess } from "@/lib/access-roles";
import { buildStructuredAuditLogCreateArgs } from "@/lib/audit";
import {
  describeChildSideDepth,
  describeParentSideDepth,
  MAX_FAMILY_LINK_GENERATIONS,
  MAX_PARENT_LINK_CHAIN_LENGTH,
} from "@/lib/member-family-link-depth";
import { OPEN_DELETION_REQUEST_STATUSES } from "@/lib/deletion-request-decision";
import {
  mergeFieldValueKind,
  type MergeFieldValueKind,
} from "@/lib/member-merge-field-kinds";
import { deleteOwnedMemberPhotoBlobs } from "@/lib/member-photo";
import { memberDisplayName } from "@/lib/member-serialization";
import { prisma } from "@/lib/prisma";
import { findMemberContactChangeMergeBlocker } from "@/lib/xero-contact-create-recovery";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { lockAdultMemberHostingPolicySet } from "@/lib/adult-member-hosting-policy-set";
import { lockHostingCoverageOwners } from "@/lib/adult-member-hosting-coverage-lock";
import {
  buildMemberMergeHostingCoveragePlan,
  enqueueMemberMergeHostingCoveragePlan,
  memberMergeHostingCoveragePlanFingerprint,
} from "@/lib/adult-member-hosting-review";
import {
  HostingCoverageParticipantRetryError,
  lockMemberMergeHostingCoverageParticipants,
  proveMemberMergeHostingCoverageParticipants,
  type HostingCoverageQueueParticipantProof,
} from "@/lib/adult-member-hosting-queue-participants";
import {
  acquireMemberMergePartnerSharedLodgeLocks,
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  sweepUnbackedFutureSharedDoublesWithLocksHeld,
  UnlockedPartnerShareLodgeError,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import { sendAdminPartnerShareSweptAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { acquireMemberPartnerLinkLocks } from "@/lib/member-partner-lock";

/**
 * E11 (#1937) — additive, master-wins member profile merge.
 *
 * The whole operation runs in ONE interactive transaction guarded first by the
 * hosting policy-set lock, then — since #2595, because merge repairs future
 * shared-double bed placements it invalidates — every affected lodge capacity
 * key in sorted order (and deliberately NOT the global cohort `lock(1)`, whose
 * cost over a 120s merge is why the lodge set is derived from future
 * guest-nights instead), then the dual `member-lifecycle:{id}` advisory lock, so
 * the fixed lodge -> member order holds, and finally the two
 * `member-partner-link:{id}` keys — because merge both re-points partner links
 * and reads them to decide which future shared doubles to delete
 * (see docs/CONCURRENCY_AND_LOCKING.md).
 * The hosting drain takes the same sorted keys for its claimed owner and actor,
 * then refreshes the exact queue payload. For a queue row that already exists,
 * this handshake starts here, before any relation move. After the moves, one
 * sorted Member row-lock statement covers master, loser and the exact queue
 * owners, followed by a plan re-read and late queue-pointer sweeps. Policy and
 * config-transfer reconciliation cannot interleave because it shares the
 * policy-set lock.
 * It re-points every Member-referencing relation onto the master, additively
 * fills the master's blank scalar fields from the loser, removes any future
 * shared DOUBLE bed the merge left without a confirmed partnership behind it
 * (#2595, step 3b, alerted after commit), tidies the loser's
 * Xero links, writes one critical audit, and hard-deletes the loser. There are
 * NO Xero API calls anywhere in this module — the loser's Xero contact is left
 * for manual clean-up (surfaced as a preview warning).
 */

export type MergeDbClient = Prisma.TransactionClient | typeof prisma;

export class MemberMergeError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MemberMergeError";
  }
}

// ---------------------------------------------------------------------------
// Relation classification (the declarative FK universe)
// ---------------------------------------------------------------------------

/**
 * Every Member-referencing relation falls into exactly one bucket:
 *
 * - `move`    updateMany re-point loser -> master (history follows the person).
 *             No unique constraint on the member column, so no collision.
 * - `resolve` a unique constraint means naive re-pointing could collide; a
 *             per-model resolver dedupes (keep master / drop loser / special)
 *             then moves the survivors.
 * - `cascade` the row IS the loser's auth identity / an ephemeral token. It is
 *             never moved; `member.delete(loser)` cascade-drops it. Login,
 *             2FA and Xero identity are always the master's, never merged.
 *
 * FK-less scalar member-id columns (MemberLifecycleActionRequest.memberId,
 * MemberApplication nominator/reviewedBy, NominationToken.nominatorMemberId,
 * IssueReport.resolvedById/screenshotDeletedById, FamilyGroupJoinRequest/
 * DeletionRequest.reviewedBy, ...) are the fourth conceptual bucket, `snapshot`:
 * they carry no FK, so they are neither moved nor cascaded — they keep the
 * loser's id by design as immutable history (mirrors the delete path, which
 * also leaves these dangling). They are NOT relations, so they never appear in
 * the DMMF/schema relation walk and are documented, not classified, below.
 */
export type MemberMergeBucket = "move" | "resolve" | "cascade";

export type MemberMergeRelationSpec = {
  /** `Model.field` — the FK-owning relation field. */
  readonly key: string;
  readonly model: string;
  readonly field: string;
  /** Prisma delegate name (camelCase model). */
  readonly delegate: string;
  /** The scalar FK column that holds the Member id. */
  readonly column: string;
  readonly bucket: MemberMergeBucket;
  /**
   * For `move` relations only: when true this is a Member self-relation column,
   * so the master's own column is null-checked for a self-cycle before the
   * loser's inbound references are re-pointed.
   */
  readonly selfRelation?: boolean;
  readonly note?: string;
};

function spec(
  model: string,
  field: string,
  column: string,
  bucket: MemberMergeBucket,
  extra: { selfRelation?: boolean; note?: string } = {},
): MemberMergeRelationSpec {
  const delegate = model.charAt(0).toLowerCase() + model.slice(1);
  return { key: `${model}.${field}`, model, field, delegate, column, bucket, ...extra };
}

/**
 * The authoritative classification of all 80 Member FK-owning relations. The
 * DMMF/schema completeness test (member-merge-dmmf.test.ts) fails CI if the
 * schema grows a Member relation that is missing here (or if a key here no
 * longer exists in the schema), so a new relation cannot silently escape merge
 * handling.
 */
export const MEMBER_MERGE_RELATION_SPECS: readonly MemberMergeRelationSpec[] = [
  // --- Member self-relations (move inbound refs; null self-cycles first) ---
  spec("Member", "parent", "parentMemberId", "move", { selfRelation: true }),
  spec("Member", "secondaryParent", "secondaryParentId", "move", { selfRelation: true }),
  spec("Member", "inheritEmailFrom", "inheritEmailFromId", "move", { selfRelation: true }),
  spec("Member", "inheritEmailChoice", "inheritEmailChoiceId", "move", { selfRelation: true }),
  spec("Member", "detailsConfirmedBy", "detailsConfirmedByMemberId", "move", { selfRelation: true }),

  // --- Access roles ---
  spec("MemberAccessRole", "member", "memberId", "resolve", {
    note: "@@unique(memberId,role)+@@unique(memberId,roleDefinitionId); admin-role loser blocked by guard; gained roles warned in preview",
  }),
  spec("MemberAccessRole", "assignedBy", "assignedByMemberId", "move"),

  // --- Auth identity / ephemeral tokens (cascade with loser) ---
  spec("PasswordResetToken", "member", "memberId", "cascade"),
  spec("MagicLinkToken", "member", "memberId", "cascade"),
  spec("EmailVerificationToken", "member", "memberId", "cascade"),
  spec("EmailChangeToken", "member", "memberId", "cascade"),
  spec("TwoFactorEmailCode", "member", "memberId", "cascade"),
  spec("TwoFactorRecoveryCode", "member", "memberId", "cascade"),
  spec("TwoFactorSessionChallenge", "member", "memberId", "cascade"),
  spec("PartnerInviteToken", "createdBy", "createdById", "cascade", {
    note: "single-use invite token created by loser; low-value ephemeral, dies with loser",
  }),

  // --- Subscriptions / billing ---
  spec("MemberSubscription", "member", "memberId", "resolve", {
    note: "@@unique(memberId,seasonYear); a MEANINGFUL loser row colliding with ANY master row for the season is a blocker (payment history is never dropped); a meaningless colliding loser row is dropped, else moved",
  }),
  spec("MembershipSubscriptionCharge", "recipient", "recipientMemberId", "move"),
  spec("MembershipSubscriptionCharge", "confirmedBy", "confirmedByMemberId", "move"),
  // #2161 (D2): audit back-refs on the family "already invoiced" marker. Both are
  // nullable + SetNull actor columns with NO member unique constraint, exactly
  // mirroring MembershipSubscriptionCharge.confirmedByMemberId above (the schema
  // comment on the model calls out that mirror). Classify them the same way —
  // `move` re-points the loser's marking/release history onto the surviving
  // member (history follows the person; no collision possible without a unique).
  spec("FamilyGroupSeasonInvoiceMarker", "markedBy", "markedByMemberId", "move"),
  spec("FamilyGroupSeasonInvoiceMarker", "releasedBy", "releasedByMemberId", "move"),
  spec("MemberSubscription", "manuallyMarkedPaidBy", "manuallyMarkedPaidByMemberId", "move"),
  spec("MembershipBillingException", "member", "memberId", "move"),
  spec("SeasonalMembershipAssignment", "member", "memberId", "resolve", {
    note: "@@unique(memberId,seasonYear); keep master, move non-colliding",
  }),
  spec("SeasonalMembershipAssignment", "assignedBy", "assignedByMemberId", "move"),

  // --- Cancellation ---
  spec("MembershipCancellationRequest", "requestedBy", "requestedByMemberId", "move"),
  spec("MembershipCancellationRequest", "reviewedBy", "reviewedByMemberId", "move"),
  spec("MembershipCancellationRequestParticipant", "member", "memberId", "resolve", {
    note: "@@unique(requestId,memberId)",
  }),
  spec("MembershipCancellationRequestParticipant", "reviewedBy", "reviewedByMemberId", "move"),

  // --- Lifecycle action requests (actor back-refs; memberId itself is snapshot) ---
  spec("MemberLifecycleActionRequest", "requestedBy", "requestedByMemberId", "move"),
  spec("MemberLifecycleActionRequest", "reviewedBy", "reviewedByMemberId", "move"),

  // --- Bookings ---
  spec("Booking", "member", "memberId", "move"),
  spec("Booking", "createdBy", "createdById", "move"),
  spec("Booking", "deletedBy", "deletedById", "move"),
  spec("Booking", "adminReviewedBy", "adminReviewedById", "move"),
  // #2364: the admin who accepted an adult-member hosting exception, and the
  // reason they gave (D-R4). An actor back-reference with no member-scoped
  // unique constraint, exactly like `adminReviewedBy` above, so it `move`s —
  // the surviving member keeps the attribution and "who let this through" stays
  // answerable after a merge.
  spec(
    "Booking",
    "adultMemberHostingReviewedBy",
    "adultMemberHostingReviewedById",
    "move",
  ),
  spec("Booking", "adminCapacityHoldBy", "adminCapacityHoldByMemberId", "move"),
  spec("Booking", "capacityOverriddenBy", "capacityOverriddenByMemberId", "move"),
  spec("Booking", "wholeLodgeHoldBy", "wholeLodgeHoldByMemberId", "move"),
  // #2258: who turned the per-booking "No emails" switch on. An actor
  // back-reference exactly like the three hold columns above, so it moves
  // with the surviving member and the audit trail stays readable.
  spec("Booking", "noEmailsBy", "noEmailsByMemberId", "move"),
  spec("BookingGuest", "member", "memberId", "move"),
  // #2576: the officer who overrode a same-owner coverage refusal, and the
  // mandatory reason they gave. The same shape and the same reasoning as
  // `adultMemberHostingReviewedBy` above — an actor back-reference with no
  // member-scoped unique constraint — so it `move`s and "who let this through"
  // stays answerable after a merge.
  spec(
    "HostingCoverageIncident",
    "overriddenBy",
    "overriddenByMemberId",
    "move",
  ),
  // #2576: queued, unprocessed re-evaluation work for one booking OWNER. Moves
  // rather than cascading, and that is load-bearing: the loser's bookings move to
  // the master in the same merge, so work left pointing at the loser would find
  // no bookings and a genuinely uncovered stay would never be noticed. There is
  // no member-scoped unique constraint, so a move can never collide.
  spec("HostingCoverageReevaluation", "member", "memberId", "move"),
  spec("GroupBooking", "organiserMember", "organiserMemberId", "move"),
  spec("GroupBookingJoin", "joinerMember", "joinerMemberId", "resolve", {
    note: "@@unique(groupBookingId,joinerMemberId)",
  }),
  spec("Locker", "allocatedTo", "allocatedToMemberId", "move"),
  spec("BedAllocation", "approvedBy", "approvedByMemberId", "move"),
  spec("BookingChangeRequest", "requestedBy", "requestedByMemberId", "move"),
  spec("BookingChangeRequest", "reviewedBy", "reviewedByMemberId", "move"),
  // #2524: the new-booking policy-exception request twin of the two above. Same
  // shapes — a required Restrict `requestedBy` (the member owns the request and
  // may cancel/supersede it, so it moves to the surviving member) and a nullable
  // SetNull `reviewedBy` actor back-ref — so both `move`, exactly like
  // BookingChangeRequest.
  spec("NewBookingPolicyExceptionRequest", "requestedBy", "requestedByMemberId", "move"),
  spec("NewBookingPolicyExceptionRequest", "reviewedBy", "reviewedByMemberId", "move"),
  // #2263: who submitted an authenticated whole-lodge booking request. A
  // nullable SetNull attribution column with no member unique constraint —
  // the same shape as BookingChangeRequest.requestedByMemberId above — so it
  // `move`s: the loser's requests re-point to the surviving member, who then
  // owns them in "My requests" and may withdraw them.
  spec("BookingRequest", "requestedByMember", "requestedByMemberId", "move", {
    note:
      "#2263 member whole-lodge requests; a merge can transiently push the master past the 2-open-request cap — the cap is a creation-time guard, not an invariant, so this is accepted (documented in docs/STATE_MACHINES.md)",
  }),

  // --- Promos ---
  spec("PromoRedemption", "member", "memberId", "move"),
  spec("PromoRedemptionAllocation", "member", "memberId", "resolve", {
    note: "@@unique(promoRedemptionId,memberId)+@@unique(promoCodeId,bookingId,memberId)",
  }),
  spec("PromoCodeAssignment", "member", "memberId", "resolve", {
    note: "@@unique(promoCodeId,memberId)",
  }),

  // --- Credits / refunds ---
  spec("MemberCredit", "member", "memberId", "move"),
  spec("MemberCredit", "requestedBy", "requestedById", "move"),
  spec("MemberCredit", "approvedBy", "approvedById", "move"),
  spec("AdminCreditAdjustmentRequest", "member", "memberId", "move"),
  spec("AdminCreditAdjustmentRequest", "requestedBy", "requestedById", "move"),
  spec("AdminCreditAdjustmentRequest", "reviewedBy", "reviewedById", "move"),
  spec("RefundRequest", "member", "memberId", "move"),
  // B5 (#2262): both are nullable SetNull actor back-refs with no Member unique
  // constraint, exactly like MemberSubscription.manuallyMarkedPaidBy above —
  // who recorded a cash settlement, and who closed the hand-back task it
  // raised. `move` re-points that history onto the surviving member (history
  // follows the person; no collision is possible without a unique).
  spec("Payment", "manuallyMarkedPaidBy", "manuallyMarkedPaidByMemberId", "move"),
  spec("ManualRefundTask", "completedBy", "completedByMemberId", "move"),

  // --- Reports / lodge / hut leader ---
  spec("IssueReport", "member", "memberId", "move"),
  // #2780: the maintenance-report REPORTER. Moves to the survivor exactly like
  // IssueReport.member — a fault the member reported is their own history and
  // must follow them to the surviving record rather than orphan on the loser.
  // (The QR path stores memberId: null, so those rows have nothing to move.)
  // The "who acted on the report" columns — resolvedById, photoDeletedById — and
  // the QR-token / settings admin-action columns are FK-less scalars left as
  // immutable history in MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS below.
  spec("MaintenanceReport", "member", "memberId", "move"),
  spec("HutLeaderAssignment", "member", "memberId", "move"),
  spec("MemberLodgeAccess", "member", "memberId", "resolve", {
    note: "@@unique(memberId,lodgeId,kind)",
  }),
  spec("MemberLodgeAccess", "createdBy", "createdById", "move"),

  // --- Family ---
  spec("FamilyGroupMember", "member", "memberId", "resolve", {
    note: "@@unique(familyGroupId,memberId); master's row kept, billing membership re-pointed (#2520 removed the role MAX upgrade and then dropped the column)",
  }),
  spec("FamilyGroupJoinRequest", "invitedMember", "invitedMemberId", "move"),
  spec("FamilyGroupJoinRequest", "linkedMember", "linkedMemberId", "move"),
  spec("FamilyGroupJoinRequest", "subjectMember", "subjectMemberId", "move"),
  spec("FamilyGroupJoinRequest", "requester", "requesterId", "move"),

  // --- Partner links (canonical A<B pair, CONFIRMED partial uniques) ---
  spec("MemberPartnerLink", "memberA", "memberAId", "resolve", {
    note: "@@unique(memberAId,memberBId)+CONFIRMED partial uniques; A<B CHECK; self-pairs/dupes deleted",
  }),
  spec("MemberPartnerLink", "memberB", "memberBId", "resolve", {
    note: "paired with memberA resolver",
  }),
  spec("MemberPartnerLink", "initiatedBy", "initiatedByMemberId", "move"),
  spec("MemberPartnerLink", "confirmedBy", "confirmedByMemberId", "move"),
  spec("MemberPartnerLink", "assignedByAdmin", "assignedByAdminId", "move"),

  // --- Preferences ---
  spec("NotificationPreference", "member", "memberId", "resolve", {
    note: "memberId @unique (1-1); keep master's row, drop loser's",
  }),
  spec("DeletionRequest", "member", "memberId", "move"),

  // --- Committee ---
  spec("CommitteeAssignment", "member", "memberId", "resolve", {
    note: "@@unique(memberId,committeeRoleId)",
  }),
  spec("CommitteeAssignment", "assignedBy", "assignedByMemberId", "move"),

  // --- Inductions ---
  spec("MemberInduction", "member", "memberId", "move", {
    note: "no member unique on main (issue anchor said @@unique(inductionId,memberId); it does not exist) -> plain move",
  }),
  spec("MemberInductionSignOff", "signer", "signerMemberId", "resolve", {
    note: "@@unique(inductionId,signerMemberId); earliest signedAt wins",
  }),
  spec("MemberInductionAssignedSigner", "member", "memberId", "resolve", {
    note: "@@unique(inductionId,memberId); keep master's row",
  }),

  // --- Member notices ---
  // Notice authorship actor back-refs: nullable SetNull columns with no member
  // unique — history follows the surviving person (mirrors SiteBanner's FK-less
  // actor columns, but these are real FKs so they must be classified).
  spec("Notice", "createdBy", "createdByMemberId", "move"),
  spec("Notice", "updatedBy", "updatedByMemberId", "move"),
  // Individual audience targeting: Cascade FK, no member unique on the audience
  // table, so a loser's targeted-notice rows re-point onto the master. A
  // resulting duplicate (both members targeted on one notice) is harmless — the
  // visibility predicate OR-matches once and admin writes replace-all.
  spec("NoticeAudience", "member", "memberId", "move"),
  // Read receipts: @@unique(noticeId,memberId) — keep the master's receipt on a
  // collision, else move the loser's. Handled by the generic keyed resolver.
  spec("NoticeReadReceipt", "member", "memberId", "resolve", {
    note: "@@unique(noticeId,memberId); keep master's receipt on collision",
  }),
];

/**
 * FK-less scalar member-id columns intentionally left pointing at the (deleted)
 * loser as immutable history. Documented here so the cross-check test and
 * reviewers can see they were considered, not missed. NOT relations, so never
 * part of the DMMF/schema relation walk.
 *
 * No such column can silently land in a move/resolve bucket: the completeness
 * test asserts the spec table equals EXACTLY the set of `@relation(fields:)`
 * owner keys, so an FK-less column is structurally excluded from
 * classification (and a test asserts no documented snapshot column overlaps a
 * classified relation column).
 *
 * COVERAGE (#2243). This list used to be "illustrative, not exhaustive", which
 * meant a new FK-less member-id column could escape the relation walk AND this
 * list with nothing in CI to notice — `CalendarEvent.createdById` and
 * `CalendarEventSeries.createdById` did exactly that. It is now exhaustive for
 * the DETECTABLE class: every column `parseFkLessMemberIdColumns` finds (an
 * FK-less `String` scalar whose name is used elsewhere in the schema as a Member
 * FK column) must appear here, enforced by member-merge-dmmf.test.ts, which
 * fails on the next one.
 *
 * NOT EXHAUSTIVE FOR THE UNDETECTABLE CLASS, and deliberately says so. Columns
 * with BESPOKE names that appear nowhere in the schema as a Member FK column
 * (`MemberApplication.nominator1Id`, `RefundRequest.reviewedBy`,
 * `IntegrationCredential.updatedByUserId`, …) are invisible to the detector, so
 * the first block below is a best-effort hand-kept list that nothing in CI can
 * prove complete. Read a gap there as a documentation gap, never as evidence
 * that no such column exists: adding one is a review responsibility, and the
 * only mechanical backstop is that an FK-less column cannot land in a
 * move/resolve bucket by accident (the completeness test above).
 *
 * Layout: the FIRST block is that hand-kept remainder (bespoke names plus the
 * entries that predate the detector); the SECOND is the detectable set.
 */
export const MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS: readonly string[] = [
  "MemberLifecycleActionRequest.memberId",
  "MemberApplication.nominator1Id",
  "MemberApplication.nominator2Id",
  "MemberApplication.reviewedBy",
  "NominationToken.nominatorMemberId",
  "BookingModification.memberId",
  "IssueReport.resolvedById",
  "IssueReport.screenshotDeletedById",
  "FamilyGroupJoinRequest.reviewedBy",
  "DeletionRequest.reviewedBy",
  "MembershipSubscriptionBillingSettings.updatedByMemberId",
  "MembershipSubscriptionChargeCoverage.memberId",
  "AuditLog.actorMemberId",
  "AuditLog.subjectMemberId",
  "AuditLog.memberId",
  // MP1 (#189): FK-less member-id audit snapshots. MediaImage.uploadedByMemberId
  // carries no @relation (so a loser-uploaded image is never cascaded/moved);
  // any loser MEMBER_PHOTO blob is instead cleaned up by
  // reconcileLoserMemberPhotos. Member.photoUpdatedByMemberId records who last
  // set the photo and, like every other snapshot column, keeps the loser's id as
  // immutable history when a loser's photo group is absorbed by the master.
  "MediaImage.uploadedByMemberId",
  "Member.photoUpdatedByMemberId",
  // "+ Add Member Guest" (epic #2305, MG1 #2306). Two more FK-less member-id
  // scalars, both deliberately bare columns:
  //   * BookingGuest.consentRespondedByMemberId records WHO approved a
  //     cross-family guest — the target themselves, their delegate, or an
  //     admin. If that person is later merged away, the id stays as it was:
  //     the audit answer to "who stood behind this add" is the person who did
  //     it at the time, not whoever absorbed their record afterwards. An FK was
  //     rejected on top of that because it would put a validating constraint on
  //     the hot BookingGuest table plus a Member lock (see the schema comment).
  //   * MemberGuestSettings.updatedByMemberId is the ordinary settings-audit
  //     column, identical in kind to MembershipSubscriptionBillingSettings'.
  //
  // SEPARATE, AND NOT COVERED BY THIS LIST: BookingGuest.member is a real
  // relation and is already classified `move` above, so merging A into B
  // re-points A's guest rows onto B — INCLUDING their consent columns, so B
  // inherits the consent A gave. That is the accepted consequence of the
  // existing `move` classification; it is unreachable in this release (every
  // consentStatus is NULL) and MG2 (#2307) owns testing it once rows can carry
  // a status.
  "BookingGuest.consentRespondedByMemberId",
  "MemberGuestSettings.updatedByMemberId",

  // CT-1 (#2989): who last changed the installation's club time zone. The
  // ordinary settings-audit actor column, identical in kind to
  // MemberGuestSettings' and MembershipSubscriptionBillingSettings' above, and a
  // snapshot for the same reason: the audit answer to "who moved this club's
  // civil time" is the administrator who did it at the time, not whoever later
  // absorbed their record. The AuditLog row for CLUB_TIME_ZONE_UPDATED is the
  // full trail; this column is the settings row's own last-writer note.
  "ClubTimeSettings.updatedByMemberId",

  // ENV-SAFETY 1 (#3034): who last switched the environment-safety override.
  // The same ordinary settings-audit actor column as ClubTimeSettings' above,
  // and a snapshot for the same reason: the answer to "who put this installation
  // into copy mode" is the administrator who did it at the time, not whoever
  // later absorbed their record. The AuditLog row for
  // ENVIRONMENT_SAFETY_OVERRIDE_UPDATED is the full trail; this column is the
  // settings row's own last-writer note. NOT moving it also keeps the merge
  // incapable of touching a safety setting: this row decides whether real
  // members can be emailed, and a member merge has no business changing that.
  "EnvironmentSafetySettings.updatedByMemberId",

  // #2243 review sweep — bespoke-named FK-less member-id columns the detector
  // cannot see (their names appear nowhere in the schema as a Member FK column),
  // found by hand and previously in neither block. All eight are actor/audit
  // columns and keep the loser's id as immutable history, consistent with every
  // entry above.
  // Who triggered a backup run.
  "BackupRun.triggeredByMemberId",
  // Who performed the booking-timeline event (the audit actor of that row).
  "BookingEvent.actorMemberId",
  // Who priced a public booking request.
  "BookingRequest.pricedByMemberId",
  // Who dismissed a duplicate-family suggestion.
  "HiddenFamilySuggestion.hiddenByMemberId",
  // Who cleared a bounced/complained address off the suppression list.
  "EmailSuppression.clearedById",
  // Who reviewed a refund request.
  "RefundRequest.reviewedBy",
  // Who manually resolved a stuck Xero sync operation.
  "XeroSyncOperation.manuallyResolvedById",
  // Who last updated an integration credential. The NAME IS A MISNOMER: there is
  // no User model in this schema — the column holds a MEMBER id, written from
  // the admin session. It is an actor column like the rest; only its name says
  // otherwise.
  "IntegrationCredential.updatedByUserId",
  // Who ran an AI Diagnostics roundtrip (AID-2, #2371). `adminMemberId` is the
  // acting admin, a bare FK-less String (approved-metadata-only audit table, no
  // FKs by design). Its name appears nowhere in the schema as a Member FK, so the
  // detector cannot see it — documented here by hand. Like every actor column
  // above it keeps the loser's id as immutable history on merge.
  "DiagnosticsUsageEvent.adminMemberId",
  // #2780: three more actor columns the detector cannot see (their names appear
  // nowhere in the schema as a Member FK). Who resolved a maintenance report,
  // who deleted its photo, and who rotated a lodge's QR-sign token — each a bare
  // FK-less String written from an admin session, kept as immutable history on
  // merge exactly like IssueReport.resolvedById / screenshotDeletedById above.
  // (The report's own REPORTER, MaintenanceReport.memberId, is a real relation
  // classified `move` in the spec registry — it is NOT one of these.)
  "MaintenanceReport.resolvedById",
  "MaintenanceReport.photoDeletedById",
  "LodgeMaintenanceReportToken.rotatedById",
  //
  // A NINTH column found by the same sweep is deliberately NOT here, because it
  // is not a snapshot at all: `BookingRequest.convertedMemberId` is the identity
  // pointer to the member a request converted INTO, replayed as a LIVE member id
  // by `claimAlreadyConvertedBookingRequest` (booking-request-shared.ts). It is
  // MOVED loser -> master by `MEMBER_MERGE_FK_LESS_MOVE_COLUMNS` / `applyMoves`,
  // matching its FK twin on the same row (`requestedByMemberId`, classified
  // `move`).
  // `HostingCoverageReevaluation.actorMemberId` is the same exceptional live
  // shape: although FK-less while queued, it is promoted into the incident's
  // real `overriddenByMemberId` FK, so the move registry owns it as well.

  // -------------------------------------------------------------------------
  // #2243 — the rest of the columns `parseFkLessMemberIdColumns` detects.
  //
  // Every one is the same shape as the entries above: a bare `String` column
  // recording WHO did something (or, for the one `*.memberId` row in this block,
  // `AiAssistantUsageEvent.memberId`, WHICH member a historical usage record was
  // about — the coverage row `MembershipSubscriptionChargeCoverage.memberId` is
  // in the first block), with no FK precisely so
  // the record survives the subject leaving. They keep the loser's id on merge,
  // exactly as the hard-delete path leaves them, because the audit answer to
  // "who set this / who was this about" is the person who did it at the time,
  // not whoever absorbed their record afterwards.
  //
  // Two of them are the gap this issue found. `CalendarEvent.createdById` and
  // `CalendarEventSeries.createdById` are non-null bare columns naming the
  // member who created a club calendar event or recurring series. They are
  // write-only across `src/` today — `calendar-service.ts` sets them and nothing
  // reads them back — so a loser id left behind is latent rather than visible.
  // They are listed, not moved, to stay consistent with every other FK-less
  // actor column; if the calendar ever surfaces "created by", that is a decision
  // to revisit for the whole class at once, not for these two alone.
  "AiAssistantSettings.updatedByMemberId",
  "AiAssistantUsageEvent.memberId",
  "AnalyticsSettings.updatedByMemberId",
  "BedAllocationSettings.updatedByMemberId",
  "BookingMessageOverride.updatedByMemberId",
  "BookingRequest.reviewedByMemberId",
  "BookingRequestQuote.createdByMemberId",
  "BookingRequestSettings.updatedByMemberId",
  "CalendarEvent.createdById",
  "CalendarEventSeries.createdById",
  "ClubIdentitySettings.updatedByMemberId",
  "ClubModuleSettings.updatedByMemberId",
  // AI Diagnostics settings singleton (AID-2, #2371): records WHO last set the
  // deployment-local Diagnostics spend cap, a bare FK-less String exactly like
  // every other `*.updatedByMemberId` audit column here. Keeps the loser's id as
  // immutable history on merge. (Detectable: `updatedByMemberId` is a Member FK
  // column name elsewhere in the schema.)
  "DiagnosticsSettings.updatedByMemberId",
  "EmailMessageSetting.updatedByMemberId",
  "EmailTemplateOverride.updatedByMemberId",
  "FinanceSyncRun.requestedByMemberId",
  "IntegrationWizardProgress.updatedByMemberId",
  "InternetBankingPaymentSettings.updatedByMemberId",
  "LodgeInstruction.updatedByMemberId",
  // #2780: who minted a lodge's QR-sign token. A bare FK-less String written
  // from the admin session (createdById is a Member FK column name elsewhere, so
  // the detector sees it); kept as immutable history on merge. The sibling
  // rotatedById is undetectable and documented by hand in the block above.
  "LodgeMaintenanceReportToken.createdById",
  "LodgeSettings.updatedByMemberId",
  "LoginSecuritySetting.updatedByMemberId",
  // #2780: who last saved the maintenance-report policy singleton — the ordinary
  // settings-audit column, identical in kind to every other `*.updatedByMemberId`
  // here. Keeps the loser's id as immutable history on merge.
  "MaintenanceReportSettings.updatedByMemberId",
  "MemberFieldsSettings.updatedByMemberId",
  "MemberInduction.createdByMemberId",
  "MembershipCancellationSetting.updatedByMemberId",
  "MembershipLockoutSettings.updatedByMemberId",
  "MembershipNominationSettings.updatedByMemberId",
  "NotificationDeliveryPolicy.updatedByMemberId",
  "PageContent.updatedByMemberId",
  "PublicContentSettings.updatedByMemberId",
  // Alpine Central Server connection singleton: records WHO last set this
  // install's central-server connection, a bare FK-less String exactly like
  // every other `*.updatedByMemberId` audit column here. Keeps the loser's id as
  // immutable history on merge. (Detectable: `updatedByMemberId` is a Member FK
  // column name elsewhere in the schema.)
  "ServerNzSettings.updatedByMemberId",
  "SetupProgress.completedByMemberId",
  "SiteBanner.createdByMemberId",
  "SiteBanner.updatedByMemberId",
  "SiteContent.updatedByMemberId",
  "XeroGroupingSettings.updatedByMemberId",
  "XeroMemberGroupingDryRun.createdByMemberId",
  "XeroSyncOperation.createdByMemberId",
];

// ---------------------------------------------------------------------------
// DMMF / schema completeness (the key safety mechanism)
// ---------------------------------------------------------------------------

/**
 * Parse a prisma schema for every Member FK-owning relation field, i.e. every
 * `<field> Member[?] @relation(..., fields: [<col>], ...)` line. Returns the
 * stable `Model.field` keys. This is the authoritative universe the spec table
 * must cover exactly. (Prisma 7's runtime DMMF is trimmed and no longer exposes
 * relationFromFields, so the FK-owner side is read from the schema text; see
 * `memberRelationNamesFromDmmf` for the DMMF cross-check.)
 */
export function parseMemberRelationOwnerKeys(schemaText: string): string[] {
  const lines = schemaText.split(/\r?\n/);
  const keys: string[] = [];
  let model: string | null = null;
  const modelRe = /^model\s+(\w+)\s*\{/;
  // Any singular Member-typed field carrying attributes. The `@relation(...)`
  // is extracted from the attribute tail separately so an attribute BEFORE
  // `@relation(` (e.g. `@ignore @relation(...)`) can never silently exclude a
  // field from the universe (fail-open would let an onDelete:Cascade relation
  // die with the loser unclassified). The runtime-DMMF test additionally
  // asserts every singular Member field maps to a parsed key (fail-closed).
  const fieldRe = /^\s*(\w+)\s+Member\??\s+(@.*)$/;
  for (const line of lines) {
    const mm = line.match(modelRe);
    if (mm) {
      model = mm[1];
      continue;
    }
    if (line.trim() === "}") {
      model = null;
      continue;
    }
    const rm = line.match(fieldRe);
    if (!rm || !model) continue;
    const rel = rm[2].match(/@relation\(([^)]*)\)/);
    if (rel && /fields:\s*\[/.test(rel[1])) {
      keys.push(`${model}.${rm[1]}`);
    }
  }
  return keys;
}

export function diffRelationSpecCoverage(
  ownerKeys: readonly string[],
  specKeys: readonly string[],
): { missing: string[]; extra: string[] } {
  const specSet = new Set(specKeys);
  const ownerSet = new Set(ownerKeys);
  return {
    missing: ownerKeys.filter((k) => !specSet.has(k)).sort(),
    extra: specKeys.filter((k) => !ownerSet.has(k)).sort(),
  };
}

/**
 * Drop a prisma `//` (or `///`) line comment, ignoring `//` inside a quoted
 * string so a `@default("https://…")` survives intact.
 *
 * Comments are not decoration to a schema scanner: a trailing
 * `// was: @relation(fields: [memberId], references: [id])` on a bare column
 * registers a PHANTOM foreign key and silently removes that column from
 * `parseFkLessMemberIdColumns`' output — the exact silent escape the detector
 * exists to prevent (#2243).
 */
function stripPrismaLineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/**
 * #2243 — the FK-less member-id scalar columns a schema scan can actually FIND,
 * as sorted `Model.column` keys.
 *
 * The relation walk above is exact but structurally blind to columns that carry
 * no `@relation`: `CalendarEvent.createdById` and `CalendarEventSeries.createdById`
 * hold a Member id in a bare `String` and escaped both the walk and the
 * documented snapshot list entirely, so nothing in CI would have noticed the
 * next one either. This closes that by naming the detectable class mechanically
 * instead of by hand.
 *
 * The rule: a `String`/`String?` scalar that owns NO relation on its own model,
 * whose column NAME is used somewhere else in the schema as a Member FK column
 * (`memberId`, `createdById`, `updatedByMemberId`, ...). The repo names actor
 * columns consistently, so a new FK-less member-id column almost always reuses
 * one of those names and is caught. It is a DETECTOR, not a decision: everything
 * it returns must appear in `MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS`, which is
 * where the "keep the loser's id as immutable history" classification is
 * recorded (the test in member-merge-dmmf.test.ts enforces that).
 *
 * It is deliberately a SUBSET of the FK-less member-id universe: bespoke names
 * that appear nowhere as a Member FK column (`MemberApplication.nominator1Id`,
 * `IssueReport.resolvedById`, `FamilyGroupJoinRequest.reviewedBy`, ...) are
 * invisible to it and stay hand-documented in that list. Deriving membership
 * from a name is the only signal the schema offers for a bare column, so a
 * detector that is right about a large, self-maintaining slice beats a promise
 * of exhaustiveness nothing can enforce.
 *
 * The name rule can in principle over-reach — a future `String` column called
 * `memberId` that holds someone ELSE's member number, say. Nothing in the schema
 * today does, and the remedy when one appears is to document it here with a note
 * saying why it is not a member id, not to loosen the detector: a false positive
 * costs one line, a false negative is the bug this exists to prevent.
 *
 * KNOWN PARSE ASSUMPTIONS (all true of `prisma/schema.prisma` today; re-check
 * them if the schema's shape ever changes):
 *   * ONE FIELD PER LINE, and `@relation(...)` entirely on that line. A
 *     multi-line `@relation` attribute would not be parsed, and its FK column
 *     would be mistaken for a bare scalar (a false POSITIVE, which costs one
 *     documented line, not a silent miss). No relation in this schema wraps, and
 *     `prisma format` does not wrap attributes — but we hand-edit the schema
 *     (AGENTS.md), so this is an assumption rather than a guarantee.
 *   * `//` COMMENTS ARE STRIPPED before matching, outside quoted strings.
 *     Without that a trailing comment such as
 *     `memberId String // was: @relation(fields: [memberId], ...)` registers a
 *     PHANTOM FK and hides the column from the detector entirely — a false
 *     negative, exactly the failure mode this exists to prevent.
 *   * `String[]` COLUMNS ARE EXCLUDED. The live instance is
 *     `HiddenFamilySuggestion.memberIds`, an array of member ids identifying a
 *     dismissed family suggestion. The merge does not rewrite it, so a
 *     merged-away loser's id stays in the array; the signature it was hidden
 *     under no longer matches the surviving membership, so a hidden suggestion
 *     can reappear for an admin to dismiss again. That is cosmetic and
 *     deliberate — array rewriting is a separate decision — but it is a real
 *     consequence, not an oversight.
 *   * `view` AND `type` BLOCKS ARE SKIPPED (only `model` opens a scan). There
 *     are none in this schema today; a member-id column added inside one would
 *     be invisible here.
 */
export function parseFkLessMemberIdColumns(schemaText: string): string[] {
  type ModelScan = {
    name: string;
    scalarStrings: string[];
    /** FK column -> the model type of the relation that owns it. */
    relationFkColumns: Map<string, string>;
  };
  const models: ModelScan[] = [];
  let current: ModelScan | null = null;

  for (const rawLine of schemaText.split(/\r?\n/)) {
    const line = stripPrismaLineComment(rawLine);
    const mm = line.match(/^model\s+(\w+)\s*\{/);
    if (mm) {
      current = { name: mm[1], scalarStrings: [], relationFkColumns: new Map() };
      models.push(current);
      continue;
    }
    if (line.trim() === "}") {
      current = null;
      continue;
    }
    if (!current) continue;
    const fm = line.match(/^\s*(\w+)\s+(\w+)(\[\]|\?)?(\s.*)?$/);
    if (!fm) continue;
    const [, fieldName, fieldType, listOrOptional, tail] = fm;
    const relation = (tail ?? "").match(/@relation\(([^)]*)\)/);
    const fkFields = relation?.[1].match(/fields:\s*\[([^\]]*)\]/);
    if (fkFields) {
      for (const column of fkFields[1].split(",").map((c) => c.trim())) {
        if (column) current.relationFkColumns.set(column, fieldType);
      }
    }
    if (fieldType === "String" && listOrOptional !== "[]") {
      current.scalarStrings.push(fieldName);
    }
  }

  const memberFkColumnNames = new Set<string>();
  for (const model of models) {
    for (const [column, relatedType] of model.relationFkColumns) {
      if (relatedType === "Member") memberFkColumnNames.add(column);
    }
  }

  const found: string[] = [];
  for (const model of models) {
    for (const column of model.scalarStrings) {
      if (model.relationFkColumns.has(column)) continue;
      if (!memberFkColumnNames.has(column)) continue;
      found.push(`${model.name}.${column}`);
    }
  }
  return found.sort();
}

/** All relation names touching Member, from the trimmed runtime DMMF. */
export function memberRelationNamesFromDmmf(
  models: readonly { name: string; fields: readonly { type: string; relationName?: string }[] }[],
): Set<string> {
  const names = new Set<string>();
  for (const model of models) {
    for (const field of model.fields) {
      if (field.type === "Member" && field.relationName) {
        names.add(field.relationName);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Field-merge policy (master's populated scalars win; blanks filled from loser)
// ---------------------------------------------------------------------------

/**
 * Independent optional scalars filled from the loser only when master is blank.
 *
 * `postLoginLanding` (#2090) is intentionally NOT listed: the post-login landing
 * preference is a per-account UI choice, not shared personal data, so a losing
 * member's preference is dropped on merge and the master keeps its own (null =
 * role default). Do not add it here.
 */
const FILL_IF_BLANK_FIELDS = [
  "title",
  "gender",
  "dateOfBirth",
  "occupation",
  "lifeMemberDate",
  "comments",
  "familyGroupId",
] as const;

/** Grouped fills: the whole group comes from the loser only when master's key field is blank. */
const GROUP_FILL_SPECS: { name: string; key: string; fields: string[] }[] = [
  {
    name: "phone",
    key: "phoneNumber",
    fields: ["phoneCountryCode", "phoneAreaCode", "phoneNumber"],
  },
  {
    // Member profile photo (MP1, #189). photoImageId is an OUTBOUND scalar FK
    // (Member -> MediaImage), so it is merged here, master-wins: the master
    // keeps its own photo (and photoUpdatedAt/photoUpdatedByMemberId audit
    // snapshot); the loser's whole group is absorbed ONLY when the master has no
    // photo. The loser's now-unreferenced MEMBER_PHOTO blob is cleaned up at
    // execute time (reconcileLoserMemberPhotos) so it can never survive as a
    // dangling public asset.
    name: "photo",
    key: "photoImageId",
    fields: ["photoImageId", "photoUpdatedAt", "photoUpdatedByMemberId"],
  },
  {
    name: "streetAddress",
    key: "streetAddressLine1",
    fields: [
      "streetAddressLine1",
      "streetAddressLine2",
      "streetCity",
      "streetRegion",
      "streetPostalCode",
      "streetCountry",
    ],
  },
  {
    name: "postalAddress",
    key: "postalAddressLine1",
    fields: [
      "postalAddressLine1",
      "postalAddressLine2",
      "postalCity",
      "postalRegion",
      "postalPostalCode",
      "postalCountry",
    ],
  },
];

/** Booleans where either record's `true` wins. */
const OR_BOOLEAN_FIELDS = ["requiresInduction", "hutLeaderEligible"] as const;

/**
 * Every field `mergeMemberFields` emits on EVERY call, assembled from the lists
 * it actually loops over (#2860).
 *
 * Exported for `member-merge-field-kinds.test.ts`, which uses it to prove the
 * value-kind declaration is exhaustive WITHOUT trusting a hand-built fixture to
 * trigger each row. A hand-built fixture only tests the rows someone remembered
 * to populate; adding a field to `FILL_IF_BLANK_FIELDS` or to a group would
 * otherwise pass unclassified until someone extended the fixture too.
 *
 * The two CONDITIONAL rows (`hutLeaderEligibleAt`, `joinedDate`) are not here —
 * they are pushed by hand rather than by a loop. That test finds them by
 * scanning this file for the literal field names handed to `fieldMergeRow`,
 * which is exhaustive for the same reason the constructor exists: it is the
 * single place a diff row can be built.
 */
export const UNCONDITIONALLY_MERGED_FIELDS: readonly string[] = [
  ...FILL_IF_BLANK_FIELDS,
  ...GROUP_FILL_SPECS.flatMap((group) => group.fields),
  ...OR_BOOLEAN_FIELDS,
];

export type FieldMergeRow = {
  field: string;
  master: unknown;
  loser: unknown;
  result: unknown;
  source: "master" | "loser" | "or" | "earliest";
  /**
   * What this field's values MEAN, so the merge screen can render them without
   * inferring it from the runtime type (#2860). Declared once per field in
   * `member-merge-field-kinds.ts`, stamped here so the row and its meaning
   * travel together and the browser cannot classify a value differently from
   * the server that produced it.
   *
   * Deliberately NOT part of the preview token: `outcomeDigest` hashes only
   * `field`/`result`/`source`, so how a value is DISPLAYED can never invalidate
   * a preview an admin is holding. It does appear in the `MEMBER_MERGED` audit
   * metadata, which records the diff verbatim — an addition to that record's
   * shape, and no change to any merged value.
   */
  kind: MergeFieldValueKind;
};

export type FieldMergeOutcome = {
  patch: Record<string, unknown>;
  diff: FieldMergeRow[];
};

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function toTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value) return new Date(value).getTime();
  return null;
}

/**
 * The single constructor for a diff row, so no branch below can emit one
 * without its declared value kind (#2860).
 */
function fieldMergeRow(
  field: string,
  master: unknown,
  loser: unknown,
  result: unknown,
  source: FieldMergeRow["source"],
): FieldMergeRow {
  return {
    field,
    master,
    loser,
    result,
    source,
    kind: mergeFieldValueKind(field),
  };
}

/**
 * Pure additive field merge. Returns the write patch (only the fields that
 * actually change) plus a full diff for the preview. Auth / login / privilege /
 * Xero identity and onboarding/state fields are NEVER merged — they stay the
 * master's and are not represented in the patch.
 */
export function mergeMemberFields(
  master: Record<string, unknown>,
  loser: Record<string, unknown>,
): FieldMergeOutcome {
  const patch: Record<string, unknown> = {};
  const diff: FieldMergeRow[] = [];

  for (const field of FILL_IF_BLANK_FIELDS) {
    const m = master[field];
    const l = loser[field];
    if (isBlank(m) && !isBlank(l)) {
      patch[field] = l;
      diff.push(fieldMergeRow(field, m, l, l, "loser"));
    } else {
      diff.push(fieldMergeRow(field, m, l, m, "master"));
    }
  }

  for (const group of GROUP_FILL_SPECS) {
    const masterHasKey = !isBlank(master[group.key]);
    const loserHasKey = !isBlank(loser[group.key]);
    const takeLoser = !masterHasKey && loserHasKey;
    for (const field of group.fields) {
      const m = master[field];
      const l = loser[field];
      if (takeLoser) {
        patch[field] = l;
        diff.push(fieldMergeRow(field, m, l, l, "loser"));
      } else {
        diff.push(fieldMergeRow(field, m, l, m, "master"));
      }
    }
  }

  // OR booleans.
  for (const field of OR_BOOLEAN_FIELDS) {
    const m = Boolean(master[field]);
    const l = Boolean(loser[field]);
    const result = m || l;
    if (result !== m) patch[field] = result;
    diff.push(fieldMergeRow(field, m, l, result, "or"));
  }

  // hutLeaderEligibleAt follows hutLeaderEligible: earliest non-null when eligible.
  {
    const eligible =
      Boolean(master.hutLeaderEligible) || Boolean(loser.hutLeaderEligible);
    const mAt = toTime(master.hutLeaderEligibleAt);
    const lAt = toTime(loser.hutLeaderEligibleAt);
    if (eligible) {
      const earliest =
        mAt === null ? lAt : lAt === null ? mAt : Math.min(mAt, lAt);
      if (earliest !== null && earliest !== mAt) {
        patch.hutLeaderEligibleAt = new Date(earliest);
        diff.push(
          fieldMergeRow(
            "hutLeaderEligibleAt",
            master.hutLeaderEligibleAt,
            loser.hutLeaderEligibleAt,
            new Date(earliest),
            "earliest",
          ),
        );
      }
    }
  }

  // joinedDate: earliest membership start date.
  {
    const mAt = toTime(master.joinedDate);
    const lAt = toTime(loser.joinedDate);
    const earliest =
      mAt === null ? lAt : lAt === null ? mAt : Math.min(mAt, lAt);
    if (earliest !== null && earliest !== mAt) {
      patch.joinedDate = new Date(earliest);
    }
    diff.push(
      fieldMergeRow(
        "joinedDate",
        master.joinedDate,
        loser.joinedDate,
        earliest === null ? null : new Date(earliest),
        earliest !== null && earliest === lAt && earliest !== mAt ? "loser" : "master",
      ),
    );
  }

  return { patch, diff };
}

function samePatchValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : NaN;
    const bt = b instanceof Date ? b.getTime() : NaN;
    return at === bt;
  }
  return a === b;
}

/**
 * #2243 — the sorted field names on which two derivations of the SAME merge
 * disagree.
 *
 * `executeMemberMerge` derives the field-merge patch twice: once from the
 * transaction-opening snapshot (the derivation the preview token is verified
 * against) and once from a read of both members taken immediately before the
 * write. In an ordinary uncontended merge the two are identical and this returns
 * `[]`; a non-empty result means a writer that does NOT take the
 * `member-lifecycle` advisory lock changed a merged field mid-transaction, and
 * the merge REFUSES with a 409 (`merge_drift_in_transaction`) rather than
 * applying values the operator never previewed.
 *
 * Because it compares PATCHES rather than final stored values, it can in rare
 * cases report a field whose finally-stored value would have been identical
 * anyway (a group fill re-deciding its source, say). That is the safe direction
 * for a refusal, and it is why the 409's wording says the member's details
 * changed rather than claiming a specific value would have been wrong.
 *
 * A field is "different" when the two patches disagree on its VALUE or on
 * whether it is written at all (absent versus present-and-null are different
 * writes). Dates are compared by instant, not identity, because the two
 * derivations read the same instant into two `Date` objects.
 */
export function diffFieldMergePatches(
  previewed: Record<string, unknown>,
  applied: Record<string, unknown>,
): string[] {
  const fields = new Set([...Object.keys(previewed), ...Object.keys(applied)]);
  const drifted: string[] = [];
  for (const field of fields) {
    if (!samePatchValue(previewed[field], applied[field])) drifted.push(field);
  }
  return drifted.sort();
}

// ---------------------------------------------------------------------------
// #2437 — family-link (Member self-relation) drift, re-checked under the lock
// ---------------------------------------------------------------------------

/**
 * The Member self-relation FK columns — the family links: parent, secondary
 * parent, email inheritance, details-confirmed-by. Derived from the spec
 * table's `selfRelation` flag, which is HAND-WRITTEN — the derivation alone
 * guarantees nothing about a fifth self-relation. What enforces it is the
 * DMMF/schema test in member-merge-dmmf.test.ts, which asserts the flag in
 * both directions against the schema (every singular Member→Member FK-owning
 * relation is flagged, only those, all bucket `move`), so a new self-relation
 * added WITHOUT the flag fails CI instead of silently escaping both the
 * under-lock drift re-check in `executeMemberMerge` and #2445's
 * master-row-excluding, id-bounded sweep (#2437).
 */
export const MEMBER_SELF_RELATION_COLUMNS: readonly string[] =
  MEMBER_MERGE_RELATION_SPECS.filter((s) => s.selfRelation).map((s) => s.column);

export type FamilyLinkDrift = {
  /** The self-relation column that moved. */
  column: string;
  /**
   * Which side moved: the master's own outgoing link, the duplicate's own
   * outgoing link, or another member's row that still points AT the duplicate
   * after the moves (an inbound link written mid-merge).
   */
  where: "master" | "duplicate" | "inbound";
};

/**
 * #2437 — the family links on which the under-lock state disagrees with the
 * transaction-opening snapshot the merge plan was built from.
 *
 * The four self-relation columns are written by admin paths that take no
 * `member-lifecycle` advisory lock (`admin-members-service.ts` and the
 * dependents link route), so a link can land between the merge's opening
 * snapshot and its writes. #2445 already stopped the CORRUPTION arm of that
 * race — `applyMoves` excludes the master's own row, so the master can never
 * become its own parent. What remained was SILENT LOSS: a link pointing at the
 * duplicate that lands mid-merge survives the moves un-repointed, and the
 * duplicate's hard-delete then nulls it via `onDelete: SetNull` — no error, no
 * warning, no audit entry; the admin's just-saved link is simply gone. This
 * differ detects every such interleaving from the fresh under-lock read so the
 * merge can refuse with the same 409 the field-patch drift check uses (owner
 * decision 1 Aug 2026: detect and refuse; deliberately NOT a new advisory-lock
 * participant and NOT a DB CHECK constraint).
 *
 * "Unchanged" is measured against what the merge ITSELF has done to these
 * columns by the time of the fresh read, not against the raw snapshot:
 *
 *  - MASTER row: step 1 (`nullSelfRelationCycles`) nulls a snapshot value equal
 *    to the loser id, and `applyMoves` excludes the master's row, so the
 *    expected value is the snapshot's with that one transform applied. Step 1
 *    is VALUE-CONDITIONAL and 409s itself when the pointer moved under it, and
 *    a successful null holds the master's row lock to commit — that pairing is
 *    what makes the `null` expectation here enforceable rather than a
 *    tautology over step 1's own write (the differ still fails closed on a
 *    surviving pointer as defense-in-depth). The live master-arm detections at
 *    this step are therefore the columns step 1 did NOT touch.
 *  - DUPLICATE row: step 3 (`applyMoves`) re-points captured non-master rows
 *    whose column equals the loser id — including, degenerately, the
 *    duplicate's own.
 *  - INBOUND rows: after step 3 no OTHER row may still reference the loser in
 *    any of the four columns; one that does was written after the token
 *    re-derivation captured that column's rows (the moves are id-bounded to
 *    that capture, so a later row is deliberately NOT swept) and would be
 *    silently nulled by the hard-delete — or, had it been swept, silently
 *    absorbed onto the master without the family-graph guards ever seeing it.
 *
 * Values are normalised with `?? null` so an absent column (a narrower select,
 * a mock row) compares like a null one.
 */
export function diffSelfRelationLinkState(params: {
  masterId: string;
  loserId: string;
  masterSnapshot: Record<string, unknown>;
  loserSnapshot: Record<string, unknown>;
  masterAtWrite: Record<string, unknown>;
  loserAtWrite: Record<string, unknown>;
  /** Rows other than master/loser still referencing the loser at write time. */
  inboundAtWrite: readonly Record<string, unknown>[];
}): FamilyLinkDrift[] {
  const value = (row: Record<string, unknown>, column: string): unknown =>
    row[column] ?? null;
  const drifts: FamilyLinkDrift[] = [];
  for (const column of MEMBER_SELF_RELATION_COLUMNS) {
    const masterSnapshotValue = value(params.masterSnapshot, column);
    const masterExpected =
      masterSnapshotValue === params.loserId ? null : masterSnapshotValue;
    if (value(params.masterAtWrite, column) !== masterExpected) {
      drifts.push({ column, where: "master" });
    }

    const loserSnapshotValue = value(params.loserSnapshot, column);
    const loserExpected =
      loserSnapshotValue === params.loserId ? params.masterId : loserSnapshotValue;
    if (value(params.loserAtWrite, column) !== loserExpected) {
      drifts.push({ column, where: "duplicate" });
    }

    if (params.inboundAtWrite.some((row) => value(row, column) === params.loserId)) {
      drifts.push({ column, where: "inbound" });
    }
  }
  return drifts;
}

/**
 * Club-admin vocabulary for the four self-relation columns, matching the
 * changelog's register ("who a member's parent or second parent is, whose
 * email address they share, and who confirmed their details"). The 409 message
 * is the WHOLE admin-facing contract — the merge page renders `data.error`
 * verbatim and never reads `details` — so it must not name raw database
 * columns; the raw column stays in `details.driftFamilyLinks` for machine
 * consumers and the audit trail. Unknown columns (a future fifth
 * self-relation) fall back to the column name rather than hiding.
 */
const FAMILY_LINK_LABELS: Record<string, string> = {
  parentMemberId: "parent",
  secondaryParentId: "second parent",
  inheritEmailFromId: "shared email address",
  // #2716: the CHOICE behind the shared address, which the merge moves in step
  // with the pointer. Two labels rather than one because a drift on either is a
  // real, separately-recoverable state, and collapsing them would tell an admin
  // the addresses conflict when what conflicts is who was chosen.
  inheritEmailChoiceId: "who the shared email address was inherited from",
  detailsConfirmedByMemberId: "details confirmed by",
};

/** Plain-English rendering of one family-link drift entry for the 409 message. */
export function describeFamilyLinkDrift(drift: FamilyLinkDrift): string {
  const label = FAMILY_LINK_LABELS[drift.column] ?? drift.column;
  switch (drift.where) {
    case "master":
      return `${label} (on the surviving member)`;
    case "duplicate":
      return `${label} (on the duplicate)`;
    case "inbound":
      return `${label} (another member now links to the duplicate)`;
  }
}

/**
 * The one 409 every family-link drift arm throws (#2437): step 1's
 * value-conditional nulling when the master's pointer moved under it, and the
 * step-5 under-lock differ. Same code and message register as the #2243 field
 * drift so the route and the merge page need no new handling.
 */
function familyLinkDriftError(drifts: readonly FamilyLinkDrift[]): MemberMergeError {
  return new MemberMergeError(
    `These family links changed while the merge was running: ${drifts
      .map(describeFamilyLinkDrift)
      .join(", ")}. ` +
      "Nothing was saved. Re-run the preview and try again.",
    409,
    "merge_drift_in_transaction",
    { driftFamilyLinks: [...drifts] },
  );
}

// ---------------------------------------------------------------------------
// Partner-link merge plan (pure)
// ---------------------------------------------------------------------------

export type PartnerLinkRow = {
  id: string;
  memberAId: string;
  memberBId: string;
  status: string;
};

export type PartnerLinkPlan = {
  deleteIds: string[];
  updates: { id: string; memberAId: string; memberBId: string }[];
  warnings: string[];
};

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Re-point the loser's partner links onto the master, honouring the
 * `memberAId < memberBId` CHECK, deleting self-pairs and duplicates, and
 * keeping at most one CONFIRMED partner for the master.
 */
export function planPartnerLinkMerge(
  loserLinks: readonly PartnerLinkRow[],
  masterLinks: readonly PartnerLinkRow[],
  masterId: string,
  loserId: string,
): PartnerLinkPlan {
  const deleteIds: string[] = [];
  const updates: { id: string; memberAId: string; memberBId: string }[] = [];
  const warnings: string[] = [];

  // Track master's partners (pairs already present) and confirmed state, folding
  // in each re-pointed loser link so later loser links see the new reality.
  // The master<->loser pair itself is excluded: it becomes a self-pair and is
  // deleted, so a CONFIRMED master<->loser link must NOT count as the master's
  // confirmed partner (a loser's genuine CONFIRMED link to a third member is
  // re-pointed, not dropped).
  const masterPartners = new Set<string>();
  let masterHasConfirmed = false;
  for (const link of masterLinks) {
    const other = link.memberAId === masterId ? link.memberBId : link.memberAId;
    if (other === loserId) continue;
    masterPartners.add(other);
    if (link.status === "CONFIRMED") masterHasConfirmed = true;
  }

  for (const link of loserLinks) {
    const other = link.memberAId === loserId ? link.memberBId : link.memberAId;

    if (other === masterId) {
      // Loser <-> master link becomes a self-pair after re-point.
      deleteIds.push(link.id);
      continue;
    }

    if (masterPartners.has(other)) {
      // Master is already linked to this partner: drop loser's duplicate.
      deleteIds.push(link.id);
      if (link.status === "CONFIRMED") {
        warnings.push(
          `Duplicate partner link with the same member dropped (master already linked).`,
        );
      }
      continue;
    }

    if (link.status === "CONFIRMED" && masterHasConfirmed) {
      // Master already has its one confirmed partner; drop loser's confirmed link.
      deleteIds.push(link.id);
      warnings.push(
        `Loser's confirmed partner link dropped — the master already has a confirmed partner.`,
      );
      continue;
    }

    const [a, b] = canonicalPair(masterId, other);
    updates.push({ id: link.id, memberAId: a, memberBId: b });
    masterPartners.add(other);
    if (link.status === "CONFIRMED") masterHasConfirmed = true;
  }

  return { deleteIds, updates, warnings };
}

// ---------------------------------------------------------------------------
// Preview token (HMAC over ids + both updatedAt + outcome digest)
// ---------------------------------------------------------------------------

const PREVIEW_TOKEN_VERSION = 1;

function getPreviewSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET is required for member merge preview tokens",
    );
  }
  return "member-merge-preview-local-secret";
}

function outcomeDigest(preview: MemberMergePreviewCore): string {
  const canonical = JSON.stringify({
    fieldMerge: preview.fieldMerge.map((r) => ({ f: r.field, r: r.result, s: r.source })),
    relationMoves: preview.relationMoves,
    collisions: preview.collisions,
    blockers: preview.blockers.map((b) => b.code),
  });
  return createHmac("sha256", getPreviewSecret()).update(canonical).digest("hex");
}

function tokenPayload(
  masterId: string,
  loserId: string,
  masterUpdatedAt: Date,
  loserUpdatedAt: Date,
  preview: MemberMergePreviewCore,
): string {
  return JSON.stringify({
    version: PREVIEW_TOKEN_VERSION,
    masterId,
    loserId,
    masterUpdatedAt: masterUpdatedAt.toISOString(),
    loserUpdatedAt: loserUpdatedAt.toISOString(),
    digest: outcomeDigest(preview),
  });
}

export function buildMemberMergePreviewToken(
  masterId: string,
  loserId: string,
  masterUpdatedAt: Date,
  loserUpdatedAt: Date,
  preview: MemberMergePreviewCore,
): string {
  return createHmac("sha256", getPreviewSecret())
    .update(tokenPayload(masterId, loserId, masterUpdatedAt, loserUpdatedAt, preview))
    .digest("hex");
}

function verifyPreviewToken(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Preview types
// ---------------------------------------------------------------------------

export type MergeBlocker = { code: string; label: string; count?: number };

export type MemberMergePreviewCore = {
  fieldMerge: FieldMergeRow[];
  relationMoves: { model: string; count: number }[];
  collisions: { model: string; resolution: string; count: number }[];
  blockers: MergeBlocker[];
  warnings: string[];
};

export type MemberMergePreview = MemberMergePreviewCore & {
  masterId: string;
  loserId: string;
  masterName: string;
  loserName: string;
  confirmationPhrase: string;
  previewToken: string;
};

// ---------------------------------------------------------------------------
// Guards (preview AND re-checked in-transaction)
// ---------------------------------------------------------------------------

type GuardMember = Pick<
  Member,
  "id" | "active" | "archivedAt" | "firstName" | "lastName" | "email"
> & { accessRoles: { role: AccessRole | null }[] };

/** Normalise a confirmation phrase: trim + collapse internal whitespace. */
export function normalizeConfirmationText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function memberMergeConfirmationPhrase(loserName: string): string {
  return `MERGE ${normalizeConfirmationText(loserName)}`;
}

async function countPendingLifecycleOrFamily(
  db: MergeDbClient,
  memberId: string,
): Promise<number> {
  const [lifecycle, family, deletion] = await Promise.all([
    db.memberLifecycleActionRequest.count({
      where: { memberId, status: "REQUESTED" },
    }),
    db.familyGroupJoinRequest.count({
      where: {
        status: "PENDING",
        OR: [
          { requesterId: memberId },
          { invitedMemberId: memberId },
          { linkedMemberId: memberId },
          { subjectMemberId: memberId },
        ],
      },
    }),
    // An open self-service account-deletion request must block the merge:
    // DeletionRequest.member is classified `move`, so without this guard a
    // loser's pending deletion would silently re-point to the master and a
    // later approval would anonymise/wipe the MERGED record (cross-check:
    // MEMBER_DELETE_BLOCKER_SPECS `account_deletion_requests`).
    db.deletionRequest.count({
      where: { memberId, status: { in: OPEN_DELETION_REQUEST_STATUSES } },
    }),
  ]);
  return lifecycle + family + deletion;
}

/**
 * A RUNNING member-contact CREATE is the short-lived reservation that fences its
 * provider call against merge. A provider-created contact whose local Member
 * link failed is the durable recovery form of that same identity proof.
 * `XeroSyncOperation.localId` deliberately has no Member foreign key, so refuse
 * either exact state before deleting a participant.
 */
async function evaluateContactCreateRecoveryBlockers(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<MergeBlocker[]> {
  const [masterPending, loserPending] = await Promise.all([
    findMemberContactChangeMergeBlocker(masterId, db),
    findMemberContactChangeMergeBlocker(loserId, db),
  ]);
  const blockers: MergeBlocker[] = [];
  // #2623 T7: name the exact operation and the screen that clears it. A member
  // whose link has since been repaired reads as clean everywhere else, so an
  // unexplained refusal left the operator with nothing to search for.
  const remedy = (operationId: string) =>
    `Wait for it to finish, or resolve the failed Xero operation (${operationId}) under Admin → Xero → Operations, before merging.`;
  if (masterPending) {
    blockers.push({
      code: "master_xero_contact_create_recovery_pending",
      label: `The master has a Xero contact change in progress or awaiting local-link recovery. ${remedy(masterPending.operationId)}`,
    });
  }
  if (loserPending) {
    blockers.push({
      code: "loser_xero_contact_create_recovery_pending",
      label: `The duplicate has a Xero contact change in progress or awaiting local-link recovery. ${remedy(loserPending.operationId)}`,
    });
  }
  return blockers;
}

/**
 * Full guard matrix, shared by preview and execute. Returns structured blockers
 * (non-throwing) so the preview can render them; execute throws on any blocker.
 */
export async function evaluateMemberMergeGuards(params: {
  db: MergeDbClient;
  actorMemberId: string;
  master: GuardMember | null;
  loser: GuardMember | null;
  masterId: string;
  loserId: string;
}): Promise<MergeBlocker[]> {
  const { db, actorMemberId, master, loser, masterId, loserId } = params;
  const blockers: MergeBlocker[] = [];

  if (masterId === loserId) {
    blockers.push({ code: "same_member", label: "A member cannot be merged into itself." });
    return blockers;
  }
  if (!master) {
    blockers.push({ code: "master_missing", label: "The master member was not found." });
  }
  if (!loser) {
    blockers.push({ code: "loser_missing", label: "The duplicate member was not found." });
  }
  if (!master || !loser) return blockers;

  if (!(await actorIsFullAdmin(db, actorMemberId))) {
    blockers.push({
      code: "not_full_admin",
      label: "Only a Full Admin can merge member profiles.",
    });
  }

  if (!master.active || master.archivedAt) {
    blockers.push({
      code: "master_inactive",
      label: "The master member must be active and not archived.",
    });
  }

  if (loserId === actorMemberId) {
    blockers.push({
      code: "loser_is_actor",
      label: "You cannot merge your own member record into another.",
    });
  }

  if (hasAdminAccess({ accessRoles: loser.accessRoles })) {
    blockers.push({
      code: "loser_is_admin",
      label: "The duplicate holds an admin access role. Demote it before merging.",
    });
  }
  if (await wouldRemoveLastFullAdmin(db, loserId)) {
    blockers.push({
      code: "loser_last_admin",
      label: "The duplicate is the last Full Admin and cannot be removed.",
    });
  }

  const [masterPending, loserPending] = await Promise.all([
    countPendingLifecycleOrFamily(db, masterId),
    countPendingLifecycleOrFamily(db, loserId),
  ]);
  if (masterPending > 0) {
    blockers.push({
      code: "master_pending_requests",
      label: "The master has pending lifecycle/deletion/family requests. Resolve them first.",
      count: masterPending,
    });
  }
  if (loserPending > 0) {
    blockers.push({
      code: "loser_pending_requests",
      label: "The duplicate has pending lifecycle/deletion/family requests. Resolve them first.",
      count: loserPending,
    });
  }

  // A MEANINGFUL loser subscription (invoiced / paid / charge-covered) that
  // collides with ANY master row for the same season would be dropped by the
  // keep-master resolver — deleting payment history (and a coverage-backed row
  // would surface as a late P2003, MembershipSubscriptionChargeCoverage is
  // onDelete: Restrict). Block regardless of whether the MASTER's row is
  // meaningful: a meaningless master row must never absorb a paid loser row.
  // Only a meaningless colliding loser row may be dropped by the resolver.
  const blockedSeasons = await countBlockedSubscriptionSeasons(db, masterId, loserId);
  if (blockedSeasons > 0) {
    blockers.push({
      code: "subscription_collision",
      label:
        "The duplicate has an invoiced/paid membership subscription for a season the master also has a subscription row for. Resolve the duplicate subscription before merging.",
      count: blockedSeasons,
    });
  }

  blockers.push(...(await evaluateFamilyLinkGraphBlockers(db, masterId, loserId)));
  blockers.push(
    ...(await evaluateContactCreateRecoveryBlockers(db, masterId, loserId)),
  );

  return blockers;
}

/**
 * #2255: merge is a parent-link WRITER, and until now an ungated one.
 *
 * It never creates a link by hand, which is exactly why it slipped past the
 * per-link guards: `applyMoves` re-points every inbound `parentMemberId` /
 * `secondaryParentId` from the loser onto the master, and the master keeps its
 * own outbound links. Collapsing two nodes into one therefore JOINS their
 * family chains, and two things the link-time cap forbids become reachable:
 *
 *  - DEPTH. Master four generations deep with nobody below, loser heading three
 *    generations of its own — neither breaches the cap alone, and the merged
 *    node spans six generations.
 *  - CYCLES. If master and loser are already related by parentage in either
 *    direction, the merged node becomes its own ancestor. `nullSelfRelationCycles`
 *    does not catch this: it only nulls MASTER columns whose value equals the
 *    loser id, so a loop closed through a third member (master → X, X → loser;
 *    merge loser into master and X's parent becomes master, which X is already
 *    the child of) survives it intact.
 *
 * Refusing is the right answer rather than repairing: which link to drop is a
 * statement about who is responsible for whom, and that is the admin's to make.
 *
 * The post-merge shape is simulated from the two members' own chains rather
 * than by re-implementing the mover, so the check cannot drift out of step with
 * it by being subtly more permissive. On the DESCENDANT side that simulation is
 * exact — inbound links move, so the merged node really does carry the deeper
 * of the two subtrees. On the ANCESTOR side it deliberately OVER-counts: the
 * loser's own parent columns die with the hard-deleted row, so the merged node
 * actually keeps only the MASTER's ancestors, and taking the max of the two can
 * refuse a merge that would in fact have fitted. That is the direction to err
 * in — it fails closed, and the refusal is actionable (unlink one of them
 * first), whereas an under-count would silently create the fifth generation the
 * whole cap exists to prevent.
 */
async function evaluateFamilyLinkGraphBlockers(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<MergeBlocker[]> {
  const [masterUp, masterDown, loserUp, loserDown] = await Promise.all([
    describeParentSideDepth(db, masterId),
    describeChildSideDepth(db, masterId),
    describeParentSideDepth(db, loserId),
    describeChildSideDepth(db, loserId),
  ]);

  const relatedByParentage =
    masterUp.ancestorIds.includes(loserId) ||
    masterDown.descendantIds.includes(loserId) ||
    loserUp.ancestorIds.includes(masterId) ||
    loserDown.descendantIds.includes(masterId);

  if (relatedByParentage) {
    return [
      {
        code: "family_link_cycle",
        label:
          "These two members are already recorded as relatives of each other (one is the other's parent, grandparent, or descendant). Merging them would link the family back on itself. Remove the parent link between them first.",
      },
    ];
  }

  // The merged node carries the deeper of the two chains on each side.
  const mergedAncestorGenerations = Math.max(
    masterUp.ancestorGenerations,
    loserUp.ancestorGenerations,
  );
  const mergedDescendantGenerations = Math.max(
    masterDown.descendantGenerations,
    loserDown.descendantGenerations,
  );
  if (
    mergedAncestorGenerations + mergedDescendantGenerations >
    MAX_PARENT_LINK_CHAIN_LENGTH
  ) {
    return [
      {
        code: "family_link_depth",
        label: `Merging these members would make one family chain longer than ${MAX_FAMILY_LINK_GENERATIONS} generations. Unlink one of them from their family first, then merge.`,
      },
    ];
  }

  return [];
}

const MEANINGFUL_SUBSCRIPTION_OR: Prisma.MemberSubscriptionWhereInput["OR"] = [
  { status: { in: ["UNPAID", "PAID", "OVERDUE"] } },
  { xeroInvoiceId: { not: null } },
  { xeroInvoiceNumber: { not: null } },
  { xeroOnlineInvoiceUrl: { not: null } },
  { paidAt: { not: null } },
  // #2147: chargeCoverage is now a list — ANY coverage row (active or a retained
  // released one) makes the loser subscription meaningful for merge-collision.
  { chargeCoverage: { some: {} } },
];

/**
 * Seasons where a MEANINGFUL loser subscription collides with ANY master
 * subscription row. The master side is deliberately NOT filtered on
 * meaningfulness: the keep-master resolver drops the LOSER's colliding row, so
 * the question is only whether the loser row being dropped carries payment
 * history — not whether the master's surviving row does.
 */
async function countBlockedSubscriptionSeasons(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<number> {
  const [masterAll, loserMeaningful] = await Promise.all([
    db.memberSubscription.findMany({
      where: { memberId: masterId },
      select: { seasonYear: true },
    }),
    db.memberSubscription.findMany({
      where: { memberId: loserId, OR: MEANINGFUL_SUBSCRIPTION_OR },
      select: { seasonYear: true },
    }),
  ]);
  const masterSeasons = new Set(masterAll.map((s) => s.seasonYear));
  return loserMeaningful.filter((s) => masterSeasons.has(s.seasonYear)).length;
}

// ---------------------------------------------------------------------------
// Preview builder
// ---------------------------------------------------------------------------

async function countLoserRows(
  db: MergeDbClient,
  delegate: string,
  column: string,
  loserId: string,
): Promise<number> {
  const model = (db as unknown as Record<string, { count: (args: unknown) => Promise<number> }>)[
    delegate
  ];
  return model.count({ where: { [column]: loserId } });
}

/**
 * The one predicate every self-relation MOVE derivation shares (#2437): rows
 * pointing at the duplicate, excluding the master's own row. Used by the
 * preview's move counts, the execute-time token re-derivation / id capture,
 * and the moved-id audit sample, so the three can never disagree about which
 * rows count as "moved" — the master's own pointer at the duplicate is CLEARED
 * by step 1, not moved, and is surfaced as a preview warning instead.
 */
function selfRelationMoveWhere(
  column: string,
  masterId: string,
  loserId: string,
): Record<string, unknown> {
  return { [column]: loserId, id: { not: masterId } };
}

/**
 * FK-less member-id columns the merge MOVES rather than snapshots, as
 * `{ key, delegate, column }` (#2243). They own no `@relation`, so they cannot
 * live in `MEMBER_MERGE_RELATION_SPECS` (which must equal the FK-owner universe
 * exactly) — this is where the preview counts, the token digest, and
 * `applyMoves` all read them from, so the three can never drift apart.
 *
 * `BookingRequest.convertedMemberId` is the identity pointer to the member a
 * booking request converted INTO, replayed as a live member id by
 * `claimAlreadyConvertedBookingRequest` — not an actor/audit snapshot.
 * `HostingCoverageReevaluation.actorMemberId` is live too: the drain promotes
 * it into the incident's real Member foreign key, so queued attribution must
 * follow a merged person onto the surviving profile. Merge and drain share the
 * sorted lifecycle handshake for an already-existing queue row, and the drain
 * refreshes its exact claimed row. The post-move participant fence and late
 * sweeps cover an ordinary producer that reaches this transaction after the
 * first relation sweep; policy/config-transfer reconciliation is already
 * serialised by the shared policy-set lock.
 */
export const MEMBER_MERGE_FK_LESS_MOVE_COLUMNS: readonly {
  key: string;
  delegate: string;
  column: string;
}[] = [
  {
    key: "BookingRequest.convertedMemberId",
    delegate: "bookingRequest",
    column: "convertedMemberId",
  },
  {
    key: "HostingCoverageReevaluation.actorMemberId",
    delegate: "hostingCoverageReevaluation",
    column: "actorMemberId",
  },
];

async function countFkLessMoveRows(
  db: MergeDbClient,
  loserId: string,
): Promise<{ model: string; count: number }[]> {
  const counts = await Promise.all(
    MEMBER_MERGE_FK_LESS_MOVE_COLUMNS.map((c) =>
      countLoserRows(db, c.delegate, c.column, loserId),
    ),
  );
  return MEMBER_MERGE_FK_LESS_MOVE_COLUMNS.flatMap((c, i) =>
    counts[i] > 0 ? [{ model: c.key, count: counts[i] }] : [],
  );
}

export async function buildMemberMergePreview(params: {
  masterId: string;
  loserId: string;
  actorMemberId: string;
  db?: MergeDbClient;
}): Promise<MemberMergePreview> {
  const db = params.db ?? prisma;
  const { masterId, loserId, actorMemberId } = params;

  const [masterFull, loserFull] = await Promise.all([
    db.member.findUnique({ where: { id: masterId } }),
    db.member.findUnique({ where: { id: loserId } }),
  ]);

  const guardMaster = masterFull ? toGuardMember(masterFull, await loadRoles(db, masterId)) : null;
  const guardLoser = loserFull ? toGuardMember(loserFull, await loadRoles(db, loserId)) : null;

  const blockers = await evaluateMemberMergeGuards({
    db,
    actorMemberId,
    master: guardMaster,
    loser: guardLoser,
    masterId,
    loserId,
  });

  if (!masterFull || !loserFull) {
    throw new MemberMergeError(
      "Both members must exist to preview a merge.",
      404,
      "member_missing",
      { blockers },
    );
  }

  const { diff } = mergeMemberFields(
    masterFull as unknown as Record<string, unknown>,
    loserFull as unknown as Record<string, unknown>,
  );

  const warnings: string[] = [];
  const relationMoves: { model: string; count: number }[] = [];
  const collisions: { model: string; resolution: string; count: number }[] = [];

  // Relation move counts (loser rows that will re-point). Resolve models are
  // reported as collisions with their resolution. Self-relation counts exclude
  // the master's own row — its pointer at the duplicate is CLEARED by step 1,
  // not moved, and is warned about explicitly below (#2437). The predicate is
  // shared with the execute-time token re-derivation, so the digest agrees.
  const moveSpecs = MEMBER_MERGE_RELATION_SPECS.filter((s) => s.bucket === "move");
  const moveCounts = await Promise.all(
    moveSpecs.map((s) => {
      if (!s.selfRelation) return countLoserRows(db, s.delegate, s.column, loserId);
      const delegate = (db as unknown as Record<string, {
        count: (args: unknown) => Promise<number>;
      }>)[s.delegate];
      return delegate.count({
        where: selfRelationMoveWhere(s.column, masterId, loserId),
      });
    }),
  );
  moveSpecs.forEach((s, i) => {
    if (moveCounts[i] > 0) relationMoves.push({ model: s.key, count: moveCounts[i] });
  });
  relationMoves.push(...(await countFkLessMoveRows(db, loserId)));

  // The loser's own OUTBOUND self-relation columns (parent, inheritEmailFrom,
  // ...) die with the loser: the master keeps its own values and only INBOUND
  // references to the loser are re-pointed. Surface the discard explicitly.
  const discardedSelfRefs = MEMBER_MERGE_RELATION_SPECS.filter(
    (s) => s.selfRelation,
  )
    .filter((s) => {
      const v = (loserFull as unknown as Record<string, unknown>)[s.column];
      return v != null && v !== masterId;
    })
    .map((s) => s.field);
  if (discardedSelfRefs.length > 0) {
    warnings.push(
      `The duplicate's own ${discardedSelfRefs.join(", ")} link(s) are discarded — the master keeps its own (inbound references to the duplicate are still re-pointed).`,
    );
  }

  // The MASTER's own self-relation columns pointing at the duplicate are
  // CLEARED by the merge (a surviving member cannot be linked to a record that
  // is about to be deleted, and re-pointing would link it to itself). They are
  // deliberately NOT counted as relation moves above, so without this warning
  // the clearance would be invisible in the preview (#2437).
  const clearedMasterSelfRefs = MEMBER_MERGE_RELATION_SPECS.filter(
    (s) => s.selfRelation,
  )
    .filter(
      (s) => (masterFull as unknown as Record<string, unknown>)[s.column] === loserId,
    )
    .map((s) => s.field);
  if (clearedMasterSelfRefs.length > 0) {
    warnings.push(
      `The master's own ${clearedMasterSelfRefs.join(", ")} link(s) point at the duplicate and will be CLEARED by the merge — they are not moved (a member cannot be linked to itself).`,
    );
  }

  // Collision previews per resolve model (best-effort counts).
  const resolveSummaries = await summariseResolveCollisions(db, masterId, loserId);
  collisions.push(...resolveSummaries.collisions);
  warnings.push(...resolveSummaries.warnings);

  // Access roles the master will gain (privilege surface — surface explicitly).
  const gainedRoles = await loserAccessRolesGainedByMaster(db, masterId, loserId);
  if (gainedRoles.length > 0) {
    warnings.push(`Master will gain access role(s): ${gainedRoles.join(", ")}.`);
  }

  // Xero warnings.
  const loserXero = await db.xeroObjectLink.findMany({
    where: { localModel: "Member", localId: loserId, active: true },
    select: { role: true },
  });
  if (loserFull.xeroContactId || loserXero.length > 0) {
    warnings.push(
      "Loser's Xero contact remains in Xero — archive or merge it there manually.",
    );
  }
  const loserHasEntranceFee = loserXero.some((l) => l.role === "ENTRANCE_FEE_INVOICE");
  if (loserHasEntranceFee) {
    const masterHasEntranceFee =
      (await db.xeroObjectLink.count({
        where: {
          localModel: "Member",
          localId: masterId,
          active: true,
          role: "ENTRANCE_FEE_INVOICE",
        },
      })) > 0;
    warnings.push(
      masterHasEntranceFee
        ? "Both members have a joining-fee (entrance fee) invoice link; the loser's will be deactivated (master's is kept)."
        : "The loser's joining-fee (entrance fee) invoice link will be re-pointed to the master to preserve paid-fee evidence.",
    );
  }
  warnings.push("The loser will be signed out on their next request.");

  const core: MemberMergePreviewCore = {
    fieldMerge: diff,
    relationMoves,
    collisions,
    blockers,
    warnings,
  };

  const previewToken = buildMemberMergePreviewToken(
    masterId,
    loserId,
    masterFull.updatedAt,
    loserFull.updatedAt,
    core,
  );

  return {
    ...core,
    masterId,
    loserId,
    masterName: memberDisplayName(masterFull),
    loserName: memberDisplayName(loserFull),
    confirmationPhrase: memberMergeConfirmationPhrase(memberDisplayName(loserFull)),
    previewToken,
  };
}

async function loadRoles(db: MergeDbClient, memberId: string) {
  return db.memberAccessRole.findMany({
    where: { memberId },
    select: { role: true },
  });
}

function toGuardMember(
  member: Member,
  accessRoles: { role: AccessRole | null }[],
): GuardMember {
  return {
    id: member.id,
    active: member.active,
    archivedAt: member.archivedAt,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    accessRoles,
  };
}

/**
 * Access roles the master gains from the loser, INCLUDING definition-backed
 * custom roles (rows with `role = null` and a `roleDefinitionId`), which can
 * grant finance/membership EDIT and must never be an invisible escalation.
 * Tokens mirror `accessRoleTokenFromAssignment` / the Full-Admin gate: the
 * enum value for system/seeded roles, the definition id for custom rows.
 * Returns human-readable labels for the preview warning.
 */
async function loserAccessRolesGainedByMaster(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<string[]> {
  const select = {
    role: true,
    roleDefinitionId: true,
    roleDefinition: { select: { label: true } },
  } as const;
  const [masterRoles, loserRoles] = await Promise.all([
    db.memberAccessRole.findMany({ where: { memberId: masterId }, select }),
    db.memberAccessRole.findMany({ where: { memberId: loserId }, select }),
  ]);
  const tokenOf = (r: {
    role: AccessRole | null;
    roleDefinitionId: string | null;
  }): string | null => r.role ?? r.roleDefinitionId;
  const masterTokens = new Set(
    masterRoles.map(tokenOf).filter((t): t is string => Boolean(t)),
  );
  const gained: string[] = [];
  const seen = new Set<string>();
  for (const r of loserRoles) {
    const token = tokenOf(r);
    if (!token || masterTokens.has(token) || seen.has(token)) continue;
    seen.add(token);
    gained.push(
      r.role ??
        `${r.roleDefinition?.label ?? r.roleDefinitionId} (custom role)`,
    );
  }
  return gained;
}

/**
 * Generic keep-master resolver table, shared by the execute-time resolvers and
 * the preview drop-note summariser so the two can never disagree on keys.
 */
const GENERIC_KEYED_RESOLVERS: readonly {
  spec: string;
  delegate: string;
  memberColumn: string;
  keys: string[][];
}[] = [
  { spec: "MemberAccessRole.member", delegate: "memberAccessRole", memberColumn: "memberId", keys: [["role"], ["roleDefinitionId"]] },
  { spec: "MemberSubscription.member", delegate: "memberSubscription", memberColumn: "memberId", keys: [["seasonYear"]] },
  { spec: "SeasonalMembershipAssignment.member", delegate: "seasonalMembershipAssignment", memberColumn: "memberId", keys: [["seasonYear"]] },
  { spec: "MembershipCancellationRequestParticipant.member", delegate: "membershipCancellationRequestParticipant", memberColumn: "memberId", keys: [["requestId"]] },
  { spec: "GroupBookingJoin.joinerMember", delegate: "groupBookingJoin", memberColumn: "joinerMemberId", keys: [["groupBookingId"]] },
  { spec: "PromoRedemptionAllocation.member", delegate: "promoRedemptionAllocation", memberColumn: "memberId", keys: [["promoRedemptionId"], ["promoCodeId", "bookingId"]] },
  { spec: "PromoCodeAssignment.member", delegate: "promoCodeAssignment", memberColumn: "memberId", keys: [["promoCodeId"]] },
  { spec: "MemberLodgeAccess.member", delegate: "memberLodgeAccess", memberColumn: "memberId", keys: [["lodgeId", "kind"]] },
  { spec: "CommitteeAssignment.member", delegate: "committeeAssignment", memberColumn: "memberId", keys: [["committeeRoleId"]] },
  { spec: "MemberInductionAssignedSigner.member", delegate: "memberInductionAssignedSigner", memberColumn: "memberId", keys: [["inductionId"]] },
  { spec: "NotificationPreference.member", delegate: "notificationPreference", memberColumn: "memberId", keys: [[]] },
  { spec: "NoticeReadReceipt.member", delegate: "noticeReadReceipt", memberColumn: "memberId", keys: [["noticeId"]] },
];

/**
 * Money/roster resolvers whose dropped duplicates deserve a SPECIFIC preview
 * note: a dropped PromoRedemptionAllocation removes a promo money-allocation
 * row; a dropped GroupBookingJoin removes a group-roster row.
 */
const MONEY_ROSTER_DROP_NOTES: Record<string, string> = {
  "PromoRedemptionAllocation.member":
    "duplicate promo redemption allocation row(s) will be dropped (the master already holds the same allocation) — the dropped rows' promo money history is removed.",
  "GroupBookingJoin.joinerMember":
    "duplicate group-booking join row(s) will be dropped (both members joined the same group booking) — the dropped rows leave that group's roster.",
};

/** Fetch both members' partner links and plan the merge (read-only). */
async function loadPartnerLinkPlan(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<PartnerLinkPlan> {
  const [loserLinks, masterLinks] = await Promise.all([
    db.memberPartnerLink.findMany({
      where: { OR: [{ memberAId: loserId }, { memberBId: loserId }] },
    }),
    db.memberPartnerLink.findMany({
      where: { OR: [{ memberAId: masterId }, { memberBId: masterId }] },
    }),
  ]);
  return planPartnerLinkMerge(loserLinks, masterLinks, masterId, loserId);
}

async function summariseResolveCollisions(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<{ collisions: { model: string; resolution: string; count: number }[]; warnings: string[] }> {
  const collisions: { model: string; resolution: string; count: number }[] = [];
  const warnings: string[] = [];

  const specs = MEMBER_MERGE_RELATION_SPECS.filter(
    // Both partner-link sides are summarised together via the planner below.
    (s) => s.bucket === "resolve" && s.model !== "MemberPartnerLink",
  );
  const counts = await Promise.all(
    specs.map((s) => countLoserRows(db, s.delegate, s.column, loserId)),
  );
  specs.forEach((s, i) => {
    if (counts[i] > 0) {
      collisions.push({ model: s.key, resolution: s.note ?? "dedupe on unique key", count: counts[i] });
    }
  });

  // Specific drop notes for money/roster rows (actual collisions, not just
  // loser-row counts).
  for (const g of GENERIC_KEYED_RESOLVERS) {
    const note = MONEY_ROSTER_DROP_NOTES[g.spec];
    if (!note) continue;
    const delegate = (db as unknown as Record<string, {
      findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
    }>)[g.delegate];
    const [loserRows, masterRows] = await Promise.all([
      delegate.findMany({ where: { [g.memberColumn]: loserId } }),
      delegate.findMany({ where: { [g.memberColumn]: masterId } }),
    ]);
    if (loserRows.length === 0) continue;
    const { dropIds } = partitionKeyedCollisions(loserRows, masterRows, g.keys);
    if (dropIds.length > 0) {
      warnings.push(`${dropIds.length} ${note}`);
    }
  }

  // Partner links: run the planner read-only so BOTH sides of the pair are
  // counted and CONFIRMED-drop warnings surface in the preview.
  const partnerPlan = await loadPartnerLinkPlan(db, masterId, loserId);
  const partnerTotal = partnerPlan.updates.length + partnerPlan.deleteIds.length;
  if (partnerTotal > 0) {
    collisions.push({
      model: "MemberPartnerLink.memberA/memberB",
      resolution: `re-point ${partnerPlan.updates.length}, drop ${partnerPlan.deleteIds.length} (self-pair/duplicate/confirmed)`,
      count: partnerTotal,
    });
  }
  warnings.push(...partnerPlan.warnings);

  return { collisions, warnings };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const MOVED_ID_SAMPLE_CAP = 500;

export type MemberMergeResult = {
  masterId: string;
  loserId: string;
  relationMoves: { model: string; count: number }[];
  collisions: { model: string; resolution: string; count: number }[];
  fieldsChanged: string[];
};

/**
 * #2498 — the non-PII, STRUCTURAL slice of a refusal's `details` worth keeping
 * in the refusal audit: which member fields or family links drifted, and which
 * guard codes blocked. It carries field/column NAMES and guard CODES only —
 * never member values, names, emails or identifiers — so it is a strict subset
 * of what a successful merge already records (that audit stores the loser
 * snapshot AND the field VALUES that were merged). Unknown detail shapes yield
 * `undefined` rather than echoing arbitrary payloads into the audit.
 */
function extractRefusalContext(
  details: unknown,
): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") return undefined;
  const source = details as Record<string, unknown>;
  const context: Record<string, unknown> = {};

  if (Array.isArray(source.driftFields)) {
    context.driftFields = source.driftFields.filter(
      (field): field is string => typeof field === "string",
    );
  }
  if (Array.isArray(source.driftFamilyLinks)) {
    context.driftFamilyLinks = source.driftFamilyLinks
      .filter(
        (link): link is Record<string, unknown> =>
          Boolean(link) && typeof link === "object",
      )
      .map((link) => ({ column: link.column, where: link.where }));
  }
  if (Array.isArray(source.lodgeIds)) {
    // #2595 `partner_share_lodge_drift`: the lodges that appeared for one of
    // these members after the partner-share prefix derived its set. Lodge ids
    // are structural, never member data, so they fit the non-PII contract and
    // tell an operator which board changed under the merge.
    context.unlockedLodgeIds = source.lodgeIds.filter(
      (lodgeId): lodgeId is string => typeof lodgeId === "string",
    );
  }
  if (Array.isArray(source.blockers)) {
    context.blockerCodes = source.blockers
      .map((blocker) =>
        blocker && typeof blocker === "object"
          ? (blocker as Record<string, unknown>).code
          : undefined,
      )
      .filter((code): code is string => typeof code === "string");
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * #2498 — best-effort audit of a REFUSED member merge (owner decision, 2 Aug
 * 2026: record refused attempts too, not only completed merges, so an admin
 * repeatedly attempting a merge that keeps drifting or keeps hitting a guard
 * becomes visible in the audit trail).
 *
 * Every refusal throws a `MemberMergeError` from INSIDE the transaction, which
 * rolls the whole transaction back — so the success audit written there never
 * lands, and a refused attempt used to leave no audit row at all. This is
 * called from the single refusal path in `executeMemberMerge` on the BASE
 * client (never the rolled-back `tx`), so at most ONE row lands per refusal.
 *
 * BEST-EFFORT: any failure to write is logged and swallowed, so recording a
 * refusal can never turn a clean 4xx/409 refusal into a 500. Metadata is a
 * strict, non-PII subset of the success audit — actor, both member ids, the
 * refusal code/status, and the structural drift/guard context.
 */
async function auditRefusedMemberMerge(args: {
  db: MergeDbClient;
  masterId: string;
  loserId: string;
  actorMemberId: string;
  error: MemberMergeError;
  request?: Request;
}): Promise<void> {
  try {
    await args.db.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBER_MERGE_REFUSED",
        actor: { memberId: args.actorMemberId },
        subject: { memberId: args.masterId },
        entity: { type: "Member", id: args.masterId },
        category: "admin",
        severity: "important",
        outcome: "blocked",
        summary: `Member merge refused (${args.error.code ?? "unknown"})`,
        metadata: {
          masterId: args.masterId,
          loserId: args.loserId,
          reasonCode: args.error.code ?? null,
          statusCode: args.error.statusCode,
          refusal: extractRefusalContext(args.error.details),
        },
        request: args.request ? getRequestContext(args.request) : undefined,
      }),
    );
  } catch (err) {
    logger.error({ err }, "Failed to write refused-member-merge audit");
  }
}

/**
 * #2498 — the single refusal boundary. On a `MemberMergeError` it writes one
 * best-effort refusal audit and re-throws the ORIGINAL error unchanged; any
 * other (unexpected) fault is a 500, not a refusal, so it is re-thrown
 * un-audited and left to the logs. Always rejects — the merge outcome is never
 * altered by auditing.
 */
async function refuseMergeOrRethrow(
  db: MergeDbClient,
  context: {
    masterId: string;
    loserId: string;
    actorMemberId: string;
    request?: Request;
  },
  error: unknown,
): Promise<never> {
  if (error instanceof MemberMergeError) {
    await auditRefusedMemberMerge({ db, ...context, error });
  }
  throw error;
}

export async function executeMemberMerge(params: {
  masterId: string;
  loserId: string;
  actorMemberId: string;
  previewToken: string;
  confirmationText: string;
  request?: Request;
  db?: typeof prisma;
}): Promise<MemberMergeResult> {
  const client = params.db ?? prisma;
  const { masterId, loserId, actorMemberId } = params;
  const refusalContext = {
    masterId,
    loserId,
    actorMemberId,
    request: params.request,
  };

  if (masterId === loserId) {
    // Refused before a transaction is opened, so it has no rollback to audit
    // outside of — audit it here directly, then throw the same error.
    await refuseMergeOrRethrow(
      client,
      refusalContext,
      new MemberMergeError("A member cannot be merged into itself.", 400, "same_member"),
    );
  }

  // #2595 — the future shared-double placements this merge invalidated, filled
  // in by step 3b inside the transaction and alerted on only AFTER it commits
  // (the alert sends email, which never belongs inside a transaction). Same
  // shape as the #1756 lifecycle callers.
  let sweptShares: SweptPartnerSharedAllocation[] = [];
  let sweptShareMasterName = "";

  const result = await client.$transaction(async (tx) => {
    // Policy reconciliation enumerates bookings and inserts required queue rows
    // under this key. Take it before lifecycle locks and hold it through every
    // relation move, merge-triggered queue write and loser deletion, so a policy
    // writer can only enqueue the complete pre-merge owner (which this merge
    // moves) or the surviving owner after commit. Without this first tier, a row
    // inserted after applyMoves could be cascade-dropped with the loser.
    await lockAdultMemberHostingPolicySet(tx);

    // #2595 — merge is a BED-ALLOCATION writer, because dropping the duplicate's
    // CONFIRMED partner link invalidates any future shared DOUBLE bed sitting
    // behind it, and step 3b below repairs that in this same transaction. So the
    // affected lodge capacity keys are taken HERE, in sorted order, before the
    // member-lifecycle pair and never at the point of use.
    //
    // That placement is the whole point, not a preference. The documented
    // acquisition order is global -> lodge -> member
    // (docs/CONCURRENCY_AND_LOCKING.md -> "The two-tier protocol"). Merge's own
    // lock set is member-scoped and took no lodge key before this change, so
    // reaching for the lodge tier down at the sweep — with both
    // `member-lifecycle:` keys already held — would acquire a lodge key AFTER a
    // member key and invert that order against every ordinary bed-allocation
    // writer, which takes global -> lodge and only then reaches a member tier.
    // Two such writers would then hold each other's next key: a deadlock, not a
    // style point.
    //
    // What merge deliberately does NOT take is the global cohort `lock(1)` that
    // the #1756 partner-share callers take (account-deletion approval, link
    // dissolve, deactivation, seasonal reassignment). An advisory xact lock is
    // released only at COMMIT and merge runs on a 120s budget, so holding the
    // global key for a whole merge excludes every cancel/capture/settle/refund
    // and every bed-allocation writer in the club — on their own default 5s
    // budgets, which means REJECTED with `P2028`, not merely queued. Merge is the
    // only partner-share caller long enough for that to matter, so it takes the
    // narrow lodge-only prefix and pays for it with a WIDER lodge derivation:
    // `acquireMemberMergePartnerSharedLodgeLocks` unions the lodges of the two
    // members' future allocations with the lodges of every booking they hold a
    // GUEST ROW on, so a lodge is covered even where no allocation exists there
    // yet. See docs/CONCURRENCY_AND_LOCKING.md -> "Merge joins the
    // bed-allocation cohort" for the deadlock analysis of the resulting edges.
    //
    // THAT SECOND READ CARRIES NO DATE FILTER, and #2672 is why. It used to ask
    // for FUTURE guest-nights only, which meant it filtered on
    // `BookingGuest.stayStart`/`stayEnd` and `BookingGuestNight` — all MUTABLE,
    // all rewritten by writers (the admin date override, and the in-progress
    // check-out extension that needs no override and no admin role) that hold
    // lock(1) plus their own lodge key and no member key merge holds. A lodge
    // with only PAST guest-nights at derivation time could therefore acquire
    // future ones mid-merge, in a lodge merge held no key for. Locking on the
    // guest row itself instead removes the class: no date write can make a
    // guest row stop being a guest row at that lodge.
    //
    // The one thing the derivation alone cannot promise is that its set does
    // not GROW, so step 3b re-derives it under the `Member … FOR UPDATE` taken
    // below — the point after which no INSERT or re-point of a `BookingGuest`
    // naming these members can commit, because that FK write needs
    // `FOR KEY SHARE` on the member row — and 409s if a lodge appeared. That
    // pair is what turns the argument into a fence rather than an observation.
    //
    // Deriving the lodge set here also needs BOTH identities: the helper reads
    // the two members' own future allocations and guest-nights, so it must run
    // while the loser's guest rows still name the loser.
    //
    // The returned set is carried to step 3b, which REFUSES the whole merge
    // rather than judge a bed-night in a lodge this prefix did not cover.
    const partnerShareLodgeIds = await acquireMemberMergePartnerSharedLodgeLocks(
      tx,
      [masterId, loserId],
    );

    // Dual advisory lock in sorted id order (deadlock-free) on the shared
    // member-lifecycle key space, so a merge serialises with any concurrent
    // delete/archive/merge touching either member.
    const [lockA, lockB] = [masterId, loserId].sort();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${lockA}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${lockB}`}))`;

    // #2595 — merge is a partner-link WRITER (step 2 re-points the duplicate's
    // links onto the master) and, since this change, a partner-link READER whose
    // read decides a destructive bed write (step 3b asks `mayShareDoubleBedWith`
    // which future shared doubles to delete). Both need this key, and merge did
    // not take it.
    //
    // The database cannot supply the invariant on its own: the CONFIRMED partial
    // uniques are PER SIDE (`MemberPartnerLink_memberA_confirmed_unique` on
    // `memberAId`, `..._memberB_...` on `memberBId`, see
    // `prisma/partial-unique-indexes.tsv`), so one member may hold one CONFIRMED
    // link as A and another as B without violating either index. Only this
    // advisory key enforces "at most one confirmed partner". Without it a
    // concurrent confirm of a pending request (`member-partner-link.ts`, which
    // takes this key and nothing else) can commit alongside merge's re-point:
    // each transaction reads the other's link as absent, both pass their own
    // one-confirmed-partner check, and the master ends with two. Step 3b would
    // then KEEP a share the invariant forbids — or, on the mirror interleaving,
    // delete a bed-night for a couple who are confirmed at commit time.
    //
    // Taken here, LAST, exactly as the reviewed move takes it
    // (`bed-allocation-move.ts` -> `acquireMemberLifecycleLocks` then
    // `acquireMemberPartnerLinkLocks`), so this adds no new EDGE to the wait
    // graph — only a second holder of one that already exists. It cannot cycle:
    // the partner-link service takes this key and no other tier, so a holder of
    // it never waits on anything merge holds. Sorted inside the helper.
    await acquireMemberPartnerLinkLocks(tx, [masterId, loserId]);

    const [masterFull, loserFull] = await Promise.all([
      tx.member.findUnique({ where: { id: masterId } }),
      tx.member.findUnique({ where: { id: loserId } }),
    ]);
    if (!masterFull || !loserFull) {
      throw new MemberMergeError("Both members must exist to merge.", 404, "member_missing");
    }

    const guardMaster = toGuardMember(masterFull, await loadRoles(tx, masterId));
    const guardLoser = toGuardMember(loserFull, await loadRoles(tx, loserId));
    const blockers = await evaluateMemberMergeGuards({
      db: tx,
      actorMemberId,
      master: guardMaster,
      loser: guardLoser,
      masterId,
      loserId,
    });
    if (blockers.length > 0) {
      throw new MemberMergeError(
        "This merge is blocked.",
        409,
        "merge_blocked",
        { blockers },
      );
    }

    // Confirmation phrase (authoritative loser name from the reloaded record).
    const expectedPhrase = memberMergeConfirmationPhrase(memberDisplayName(loserFull));
    if (normalizeConfirmationText(params.confirmationText) !== expectedPhrase) {
      throw new MemberMergeError(
        `Type "${expectedPhrase}" to confirm the merge.`,
        422,
        "confirmation_mismatch",
      );
    }

    // Re-verify the preview token against the CURRENT state (updatedAt of both
    // records is baked in, so any concurrent edit invalidates the token: 409).
    // This derivation is the PREVIEW's — it must stay keyed to the snapshot the
    // token was built from. The derivation that is actually WRITTEN is taken
    // fresh at step 5; see the comment there (#2243).
    const previewedFieldOutcome = mergeMemberFields(
      masterFull as unknown as Record<string, unknown>,
      loserFull as unknown as Record<string, unknown>,
    );
    const relationPreview = await previewRelationCountsForToken(tx, masterId, loserId);
    const relationMoveCountsPreview = relationPreview.counts;
    const collisionsPreview = (await summariseResolveCollisions(tx, masterId, loserId)).collisions;
    const core: MemberMergePreviewCore = {
      fieldMerge: previewedFieldOutcome.diff,
      relationMoves: relationMoveCountsPreview,
      collisions: collisionsPreview,
      blockers: [],
      warnings: [],
    };
    const expectedToken = buildMemberMergePreviewToken(
      masterId,
      loserId,
      masterFull.updatedAt,
      loserFull.updatedAt,
      core,
    );
    if (!verifyPreviewToken(expectedToken, params.previewToken)) {
      throw new MemberMergeError(
        "The member records changed since the preview. Re-run the preview and try again.",
        409,
        "preview_drift",
      );
    }

    // Collect a bounded moved-id sample BEFORE mutating.
    const movedIdSample = await collectMovedIdSample(tx, masterId, loserId);
    const loserOwnedBookingIds = (await tx.booking.findMany({
      where: { memberId: loserId },
      select: { id: true },
    })).map((booking) => booking.id);

    // 1) Null master self-relation cycles first — value-conditionally: a
    // pointer that moved since the snapshot refuses here with the family-link
    // drift 409 (#2437) instead of being overwritten. On success the master's
    // row lock is held to commit.
    const selfRelationNulls = await nullSelfRelationCycles(tx, masterFull, loserId);

    // 2) Resolve collisions.
    const resolveResults = await resolveAllCollisions(tx, masterId, loserId);

    // 3) Moves — self-relation sweeps bounded to the ids captured by the token
    // re-derivation above, so a family link that landed since then is never
    // absorbed unvetted; it stays pointing at the duplicate and the step-5
    // inbound re-check refuses the merge (#2437).
    const relationMoves = await applyMoves(
      tx,
      masterId,
      loserId,
      relationPreview.selfRelationRefs,
      loserOwnedBookingIds,
    );
    const bookingOwnerMove = relationMoves.find(
      (move) => move.model === "Booking.member",
    );
    if ((bookingOwnerMove?.count ?? 0) !== loserOwnedBookingIds.length) {
      throw new MemberMergeError(
        "Booking ownership changed while the merge was running. Nothing was saved. Re-run the preview and try again.",
        409,
        "merge_drift_in_transaction",
        { driftFields: ["Booking.member"] },
      );
    }

    // #2597: relation moves make the survivor's exact attendance and captured
    // loser-owned booking fan-out authoritative. Plan it now, then acquire ONE
    // sorted Member FOR UPDATE set containing master, loser and every ancillary
    // queue owner. A guest/booking/owner that lands while the statement waits is
    // visible to the under-lock re-plan and produces a safe 409, never a late row
    // acquisition or a queue write against an unprotected identity.
    const hostingPlan = await buildMemberMergeHostingCoveragePlan(
      {
        masterId,
        capturedLoserOwnedBookingIds: loserOwnedBookingIds,
      },
      tx,
    );
    let refreshedHostingPlan: Awaited<
      ReturnType<typeof buildMemberMergeHostingCoveragePlan>
    >;
    let hostingParticipantProof: HostingCoverageQueueParticipantProof;
    try {
      const lockedHostingParticipants =
        await lockMemberMergeHostingCoverageParticipants(tx, {
          masterId,
          loserId,
          ownerMemberIds: hostingPlan.sources.map(
            (source) => source.ownerMemberId,
          ),
        });
      refreshedHostingPlan = await buildMemberMergeHostingCoveragePlan(
        {
          masterId,
          capturedLoserOwnedBookingIds: loserOwnedBookingIds,
        },
        tx,
      );
      if (
        memberMergeHostingCoveragePlanFingerprint(hostingPlan) !==
        memberMergeHostingCoveragePlanFingerprint(refreshedHostingPlan)
      ) {
        throw new HostingCoverageParticipantRetryError();
      }
      hostingParticipantProof = proveMemberMergeHostingCoverageParticipants({
        lockedMemberIds: lockedHostingParticipants,
        plannedSources: hostingPlan.sources,
        refreshedSources: refreshedHostingPlan.sources,
      });
    } catch (error) {
      if (error instanceof HostingCoverageParticipantRetryError) {
        throw new MemberMergeError(
          "Hosting coverage participants changed while the merge was running. Nothing was saved. Re-run the preview and try again.",
          409,
          "merge_drift_in_transaction",
          { driftFields: ["hostingCoverageParticipants"] },
        );
      }
      throw error;
    }

    const residualLoserOwnedBookings = await tx.booking.findMany({
      where: { memberId: loserId },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (residualLoserOwnedBookings.length > 0) {
      throw new MemberMergeError(
        "Booking ownership changed while the merge was running. Nothing was saved. Re-run the preview and try again.",
        409,
        "merge_drift_in_transaction",
        {
          driftFields: ["Booking.member"],
          bookingIds: residualLoserOwnedBookings.map((booking) => booking.id),
        },
      );
    }

    // BookingGuest.member is an onDelete:SetNull attendance identity, so a row
    // inserted after applyMoves would otherwise disappear silently when the
    // loser is deleted. Re-read under the one sorted Member FOR UPDATE set and
    // refuse the whole merge if ANY loser-linked guest remains. This must be a
    // refusal rather than a late move: the hosting plan above was derived before
    // this row moved, and its booking/owner/coverage key may be outside the exact
    // proof. A guest inserted after the Member lock blocks on the loser's FK
    // key-share check and fails after deletion; one committed before the lock is
    // visible here, including when its booking was already a plan candidate.
    const residualLoserGuestRows = await tx.bookingGuest.findMany({
      where: { memberId: loserId },
      orderBy: { id: "asc" },
      select: { id: true, bookingId: true },
    });
    if (residualLoserGuestRows.length > 0) {
      throw new MemberMergeError(
        "Booking attendance changed while the merge was running. Nothing was saved. Re-run the preview and try again.",
        409,
        "merge_drift_in_transaction",
        {
          driftFields: ["BookingGuest.member"],
          bookingGuestIds: residualLoserGuestRows.map((guest) => guest.id),
          bookingIds: [
            ...new Set(residualLoserGuestRows.map((guest) => guest.bookingId)),
          ].sort(),
        },
      );
    }

    // Member rows precede coverage-owner keys in the #2597 order. Blocking is
    // safe here: an ordinary producer that already owns one key also holds a
    // compatible Member KEY SHARE, so the one FOR UPDATE statement above could
    // not have completed until that transaction released both.
    await lockHostingCoverageOwners(
      tx,
      refreshedHostingPlan.coverageOwnerIds,
    );

    // `XeroSyncOperation.localId` is FK-less, so it is outside the generic
    // relation moves. Re-check the strict provider-created/local-link-failed
    // proof only after the complete merge participant set is locked and
    // immediately before the final sweeps, Xero teardown and loser deletion.
    // A proof that appeared after preview therefore rolls back the whole merge;
    // no provider call and no additional lock tier belongs in this transaction.
    const contactRecoveryBlockers =
      await evaluateContactCreateRecoveryBlockers(tx, masterId, loserId);
    if (contactRecoveryBlockers.length > 0) {
      throw new MemberMergeError(
        "This merge is blocked.",
        409,
        "merge_blocked",
        { blockers: contactRecoveryBlockers },
      );
    }

    // Rows inserted after the generic relation/FK-less sweeps but before the
    // one participant lock statement are still live obligations. Sweep BOTH
    // pointers under the locked set and fold the counts into the existing model
    // rows so audit/result never contains duplicate model entries.
    await applyLateHostingCoverageMoves(
      tx,
      masterId,
      loserId,
      relationMoves,
    );

    // 3b) #2595 — reconcile the future shared DOUBLE beds this merge invalidated.
    //
    // `resolvePartnerLinks` (step 2) keeps at most one CONFIRMED partner for the
    // surviving master, so merging a duplicate that already had its own confirmed
    // partner DROPS that link; `applyMoves` (step 3) then re-points
    // `BookingGuest.memberId` onto the master and leaves every bed allocation
    // exactly where it was. Without this call the master and the duplicate's
    // ex-partner keep sharing a future double with no partnership behind it —
    // precisely what `mayShareDoubleBed` refuses to create in the first place.
    // No lifecycle sweep covers merge and no database trigger supplies the
    // invariant, so this is the only writer of it here.
    //
    // Placed after BOTH of those steps, so the guest rows name the master and the
    // surviving partnerships are final, and after every drift refusal above, so
    // no bed-night is judged against state this merge is about to 409 on. It
    // acquires nothing: the lodge prefix has been held since the top of the
    // transaction. Validity-driven rather than pair-driven, so it is idempotent
    // and writes nothing on a merge that broke no share (including the merge that
    // CARRIES the duplicate's link over to a master that had none).
    //
    // Because merge holds no global cohort key, the sweep is handed the exact
    // lodge set the prefix locked and refuses if it is not still complete — one
    // more drift refusal, in the same shape as the ones above, rather than a
    // bed-inventory write in an unserialised lodge. Two refusals, in fact
    // (#2672): the sweep first re-derives the members' whole guest-row lodge set
    // and refuses if the prefix does not cover it, which is meaningful HERE
    // precisely because the `Member … FOR UPDATE` above has already frozen that
    // set for the rest of the transaction; then it refuses on any candidate row
    // whose own room sits outside the prefix.
    try {
      sweptShares = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
        memberIds: [masterId, loserId],
        lockedLodgeIds: partnerShareLodgeIds,
        reason: "members_merged",
        db: tx,
      });
    } catch (sweepError) {
      if (sweepError instanceof UnlockedPartnerShareLodgeError) {
        throw new MemberMergeError(
          "A lodge booking for one of these members changed while the merge was running. Nothing was merged — please try again.",
          409,
          "partner_share_lodge_drift",
          { lodgeIds: sweepError.lodgeIds },
        );
      }
      throw sweepError;
    }
    if (sweptShares.length > 0) {
      // The master's name for the post-commit alert. Read from the
      // transaction-opening row on purpose: the step-5 field patch never touches
      // firstName/lastName (neither is in `FILL_IF_BLANK_FIELDS` or
      // `GROUP_FILL_SPECS`), so this is the surviving member's name either way,
      // and capturing it here keeps the alert off a post-commit re-read of a row
      // the operator may already be editing.
      sweptShareMasterName = memberDisplayName(masterFull);
    }

    // 4) Loser Xero teardown (link-role aware; NO Xero API calls).
    const xeroTeardown = await teardownLoserXero(tx, masterId, loserId);

    // 5) Field merge.
    //
    // #2243 — the patch that is WRITTEN is derived from a read of both members
    // taken HERE, not from the `masterFull`/`loserFull` snapshot the transaction
    // opened with.
    //
    // The photo upload route deliberately does NOT take the member-lifecycle
    // advisory lock (docs/CONCURRENCY_AND_LOCKING.md → "Member photo writer"), so
    // between the snapshot read (top of tx) and this write an admin can POST a
    // photo ON BEHALF OF the loser: it creates a new blob L2, repoints the loser
    // to L2, DELETES the loser's old blob L1 and commits. A patch derived from
    // the snapshot still names L1, and `Member.photoImageId` is a real FK
    // (-> MediaImage), so writing it raises Postgres 23503 / Prisma P2003 and
    // rolls the WHOLE merge back as a bare 500 — with the preview token none the
    // wiser, because it verifies against that same stale snapshot.
    //
    // The hazard is not photo-specific: it belongs to every field the patch
    // carries, because every one of them is copied from the loser. Two of them
    // are real FKs and can therefore fail the write outright — `photoImageId`
    // (-> MediaImage) and `familyGroupId` (-> FamilyGroup, whose row a club
    // admin can delete without taking the lifecycle lock); the rest are plain
    // scalars, where a stale value is silently-wrong data rather than a
    // rollback. Deriving from a fresh read fixes all of them at once.
    //
    // Locking, per side:
    //   * LOSER — its row lock has been held since `teardownLoserXero` (step 4),
    //     which ends in an unconditional `member.update` on the loser.
    //   * MASTER — locked together with loser and every hosting queue owner by
    //     #2597's single sorted `FOR UPDATE` statement above. Without that lock a
    //     concurrent on-behalf upload FOR THE MASTER can commit a new blob M2
    //     between this read and the update; the merge would then overwrite the
    //     master's pointer with the loser's absorbed value and nothing would
    //     ever sweep M2 (`reconcileLoserMemberPhotos` only sweeps the LOSER's
    //     blobs), leaving an orphaned public asset. It would also produce
    //     avoidable drift refusals below. Both ids are locked in one id-ordered
    //     statement, matching the advisory locks at the top of the transaction,
    //     so this can never deadlock against the mirror merge.
    //     A stale MASTER is not harmless, which is why it is locked rather than
    //     merely re-read: its values decide whether a blank is filled from the
    //     loser AND which of two dates is earlier (`joinedDate` and
    //     `hutLeaderEligibleAt` are `Math.min` against the master's own value),
    //     so a stale master can change what is written, not just what is kept.
    //
    // What a row lock does NOT close: it protects these two `Member` ROWS, not
    // the rows their FKs POINT AT. A concurrent `FamilyGroup` delete (club
    // admin, `DELETE /api/admin/family-groups/[id]` behind `requireAdmin`) still
    // takes no member-lifecycle lock, so it can still abort the merge — now by
    // deadlocking against this lock (Postgres 40P01) rather than by writing a
    // stale value (23503). Genuinely closing that is out of scope here.
    //
    // DRIFT IS REFUSED, NOT APPLIED. If the fresh derivation disagrees with the
    // previewed one, some writer outside the `member-lifecycle` lock changed a
    // merged field mid-transaction, and the merge stops with a 409 naming the
    // fields instead of committing values the operator never saw. That matches
    // every other preview/confirm flow in the repo (config transfer's ADR-002
    // promise that "what was previewed is exactly what is applied", and this
    // merge's own pre-transaction token check, which already 409s on drift).
    // The ORIGINAL #2243 bug still stays fixed: the drift is detected from the
    // FRESH read BEFORE the write, so a stale FK value is never handed to
    // Postgres and the operator gets a plain 409 instead of a bare 500.
    const [masterAtWrite, loserAtWrite] = await Promise.all([
      tx.member.findUnique({ where: { id: masterId } }),
      tx.member.findUnique({ where: { id: loserId } }),
    ]);
    if (!masterAtWrite || !loserAtWrite) {
      throw new MemberMergeError("Both members must exist to merge.", 404, "member_missing");
    }
    const fieldOutcome = mergeMemberFields(
      masterAtWrite as unknown as Record<string, unknown>,
      loserAtWrite as unknown as Record<string, unknown>,
    );
    const driftFields = diffFieldMergePatches(previewedFieldOutcome.patch, fieldOutcome.patch);
    if (driftFields.length > 0) {
      // `diffFieldMergePatches` compares PATCHES, so it can in rare cases flag a
      // field whose finally-stored value would have been identical. That is
      // deliberate: the message says the details changed, and claims nothing
      // about which value would have won.
      throw new MemberMergeError(
        `These member details changed while the merge was running: ${driftFields.join(", ")}. ` +
          "Nothing was saved. Re-run the preview and try again.",
        409,
        "merge_drift_in_transaction",
        { driftFields },
      );
    }

    // #2437 — the family links are re-checked under the SAME locks, in both
    // directions. The five Member self-relation columns are written by admin
    // paths outside the member-lifecycle lock (admin-members-service.ts, the
    // dependents link route), and #2445's exclusion of the master's own row
    // from the moves turned the mid-merge race from corruption into SILENT
    // LOSS: a link pointing at the duplicate that lands after the opening
    // snapshot survives the moves un-repointed and is then quietly nulled by
    // the hard-delete's `onDelete: SetNull` — no error, no audit. So: any
    // change to the four columns on either member row beyond the merge's own
    // step-1/step-3 rewrites, and any OTHER row still referencing the
    // duplicate after the moves, refuses here with the same 409 drift refusal
    // as the field check above (owner decision 1 Aug 2026: detect and refuse;
    // deliberately NOT a new advisory-lock participant and NOT a DB CHECK
    // constraint). Nothing is committed — the transaction rolls back whole —
    // and the operator's re-run previews the link from the start.
    //
    // The three checks compose with two write-side bounds to cover EVERY
    // interleaving: step 1's null is value-conditional (a master pointer that
    // moved since the snapshot 409s at step 1, and a successful null holds the
    // master's row lock to commit), and the step-3 sweeps are id-bounded to
    // the token re-derivation's capture (a link that lands later is never
    // absorbed unvetted — it stays pointing at the duplicate and the inbound
    // arm here refuses it). Interleavings after this point cannot reopen the
    // hole either: both member rows are FOR UPDATE-locked above, and an
    // inbound FK write referencing the duplicate from another row blocks (its
    // FK check takes KEY SHARE on the duplicate's row, which conflicts with
    // FOR UPDATE) and then fails loudly on the FK once the hard-delete
    // commits.
    const memberFindMany = (tx as unknown as Record<string, {
      findMany: (args: unknown) => Promise<Record<string, unknown>[]>;
    }>)["member"];
    const inboundAtWrite = await memberFindMany.findMany({
      where: {
        id: { notIn: [masterId, loserId] },
        OR: MEMBER_SELF_RELATION_COLUMNS.map((column) => ({ [column]: loserId })),
      },
      select: {
        id: true,
        ...Object.fromEntries(MEMBER_SELF_RELATION_COLUMNS.map((c) => [c, true])),
      },
    });
    const driftLinks = diffSelfRelationLinkState({
      masterId,
      loserId,
      masterSnapshot: masterFull as unknown as Record<string, unknown>,
      loserSnapshot: loserFull as unknown as Record<string, unknown>,
      masterAtWrite: masterAtWrite as unknown as Record<string, unknown>,
      loserAtWrite: loserAtWrite as unknown as Record<string, unknown>,
      inboundAtWrite,
    });
    if (driftLinks.length > 0) {
      throw familyLinkDriftError(driftLinks);
    }

    const fieldsChanged = Object.keys(fieldOutcome.patch);
    if (fieldsChanged.length > 0) {
      await tx.member.update({ where: { id: masterId }, data: fieldOutcome.patch });
    }

    // #2716: the relation moves re-pointed every inheritance pointer AND choice
    // from the loser onto the master, and nothing tested whether the master can
    // actually BE an email source. A merge is the sharpest case of a member
    // crossing that line because it deletes one outright: if the master is a
    // minor, holds a walk-in placeholder address, or themselves inherits, the
    // loser's dependants are left resolving to a mailbox `sendEmail` drops until
    // the daily sweep notices.
    //
    // HERE, and not earlier, for two reasons. Every drift guard has passed, so a
    // merge that is going to refuse with a 409 writes nothing at all — the #2243
    // contract, which the suite asserts on the write CALLS and not merely on the
    // committed state. And the master's own fields are final as of the patch
    // above, so whether the master is a usable source is now settled: reconciling
    // before it could read an ageTier or address the merge was about to change.
    await reconcileEmailInheritanceForMemberChange(tx, [masterId], {
      trigger: "member-merge",
      actorMemberId,
    });

    // 5b) Member-photo reconciliation (MP1, #189). The master's final photo is
    // its own when it had one, else the loser's absorbed one (in the patch). Any
    // OTHER loser MEMBER_PHOTO blob — the loser's discarded photo and anything it
    // uploaded — is hard-deleted so it cannot linger as a dangling public asset.
    // Lock order (deadlock-freedom): the preceding merge steps (relation moves,
    // loser Xero teardown, field merge) have already taken the master/loser
    // `Member` row locks, so this MediaImage delete takes MediaImage AFTER
    // Member — matching the photo upload writer's order. Keep this after those
    // steps. See docs/CONCURRENCY_AND_LOCKING.md → "Member photo writer".
    //
    // Both pointers come from the fresh step-5 read, never the top-of-transaction
    // snapshot: a reconcile keyed on a stale loser pointer would match neither
    // the deleted L1 nor the admin-uploaded L2 (which carries the ADMIN's
    // `uploadedByMemberId`, not the loser's), and once the loser is hard-deleted
    // L2 would orphan as a dangling public asset. Mirrors the account-deletion
    // path (member-lifecycle-actions.ts), which reads photoImageId fresh from its
    // own locking `member.update`. These are plain reads of Member rows — they
    // introduce no new MediaImage-before-Member ordering.
    const keepPhotoImageId =
      ((fieldOutcome.patch.photoImageId as string | null | undefined) ??
        masterAtWrite.photoImageId) ??
      null;
    const photoReconcile = await reconcileLoserMemberPhotos(
      tx,
      loserId,
      loserAtWrite.photoImageId,
      keepPhotoImageId,
    );

    // 6) One critical audit. Vintages are deliberate and mixed: the snapshot is
    // built from the FRESH step-5 row — the values this merge actually consumed
    // and is about to hard-delete, so `googleSub` below is genuinely "recorded
    // in the loser snapshot audited above" even when the link landed after the
    // transaction opened — EXCEPT `xeroContactId`, which is taken from the
    // transaction-opening row because this merge itself nulled it at step 4 and
    // the audit must show the contact id that was torn down. `fieldOutcome` and
    // `fieldsChanged` are likewise the fresh derivation that was written; they
    // can no longer disagree with the previewed one, because a divergence 409s
    // at step 5.
    const loserSnapshot = buildLoserSnapshot(loserAtWrite, loserFull.xeroContactId);
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBER_MERGED",
        actor: { memberId: actorMemberId },
        subject: { memberId: masterId },
        entity: { type: "Member", id: masterId },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Member profiles merged (loser hard-deleted)",
        metadata: {
          masterId,
          loserId,
          loserSnapshot,
          fieldOutcome: fieldOutcome.diff,
          fieldsChanged,
          relationMoves,
          collisions: resolveResults.collisions,
          resolutionWarnings: resolveResults.warnings,
          xeroTeardown,
          photoReconcile,
          // The master's own family links at the duplicate, CLEARED (not moved)
          // by step 1 — recorded explicitly so the audit never claims a cleared
          // link was carried over (#2437).
          selfRelationCyclesNulled: selfRelationNulls.nulledColumns,
          movedIdSample: movedIdSample.sample,
          movedIdSampleTruncated: movedIdSample.truncated,
        },
        request: params.request ? getRequestContext(params.request) : undefined,
      }),
    );

    // 7) Google OAuth identity (#2035). `Member.googleSub` is a scalar @unique,
    // so it is deliberately NOT in FILL_IF_BLANK_FIELDS/GROUP_FILL_SPECS: the
    // master NEVER inherits the loser's Google identity, because silently
    // transferring a login identity to another member is an account-takeover
    // vector. Mirroring the xeroContactId teardown, null the loser's googleSub
    // before the hard-delete (the sub is recorded in the loser snapshot audited
    // above) so the delete cannot race any unique constraint. The loser's Google
    // account is simply unlinked; re-link to the master is a deliberate,
    // profile-initiated action, never an automatic merge side effect.
    //
    // Read from the FRESH step-5 row, not the transaction-opening snapshot: a
    // Google link that landed after the snapshot would otherwise be missed here
    // and left set on a row about to be hard-deleted. `loserAtWrite` is taken
    // under the loser's row lock, so it is the committed value, and it is also
    // the value the audit above snapshots — which is what makes the promise on
    // the line above ("recorded in the loser snapshot audited above") true.
    if (loserAtWrite.googleSub) {
      await tx.member.update({
        where: { id: loserId },
        data: { googleSub: null },
      });
    }

    // Booking ownership and member-guest attendance were both repointed by the
    // generic relation move. Record exactly the under-lock plan. Merge-generated
    // SYSTEM_CHANGE rows are actorless: the critical MEMBER_MERGED audit above is
    // the authoritative Full Admin attribution.
    await enqueueMemberMergeHostingCoveragePlan(
      refreshedHostingPlan,
      hostingParticipantProof,
      tx,
    );

    // 8) Hard-delete the loser (cascade drops its auth/token rows).
    await tx.member.delete({ where: { id: loserId } });

    return {
      masterId,
      loserId,
      relationMoves,
      collisions: resolveResults.collisions,
      fieldsChanged,
    };
  }, {
    // A merge does hundreds of sequential round-trips (per-relation counts,
    // collision resolvers, moves) over 70+ relations; the 5s default would
    // P2028 exactly on the heavy members most likely to need merging. The dual
    // advisory lock serialises concurrent lifecycle writers, so a long window
    // is safe here.
    //
    // Do NOT add an `isolationLevel` here. The step-5 fresh read depends on READ
    // COMMITTED's per-statement snapshots to see a writer that committed after
    // this transaction opened; under REPEATABLE READ it would re-read the same
    // stale values and the #2243 fix would silently stop working (#2243).
    timeout: 120_000,
    maxWait: 10_000,
  }).catch((error) => refuseMergeOrRethrow(client, refusalContext, error));
  await settleHostingCoverageAfterCommit({ limit: 50 }, client);

  if (sweptShares.length > 0) {
    // #2595, post-commit and fire-and-forget — the same contract every #1756
    // caller uses. The removed second occupants are back in the
    // awaiting-allocation queue, so the board needs a human look; the audit rows
    // on both affected bookings are already committed inside the transaction, so
    // a failed alert loses a notification, never the evidence.
    sendAdminPartnerShareSweptAlert({
      memberName: sweptShareMasterName,
      partnerName: partnerShareSweepCounterpartNames(sweptShares, masterId),
      reason: describePartnerSharedSweepReason("members_merged"),
      nights: partnerShareSweepNights(sweptShares),
    }).catch((alertErr) => {
      logger.error(
        {
          err: alertErr,
          masterId,
          loserId,
          sweptCount: sweptShares.length,
        },
        "Failed to send partner share sweep alert after member merge",
      );
    });
  }

  return result;
}

function getRequestContext(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const parts = forwarded?.split(",").map((p) => p.trim()).filter(Boolean);
  return {
    id: request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
    ipAddress:
      parts?.[parts.length - 1] ?? request.headers.get("x-real-ip") ?? "unknown",
    userAgent: request.headers.get("user-agent"),
  };
}

/**
 * The audited loser snapshot. `loser` is the fresh pre-write row;
 * `xeroContactIdAtOpen` is passed separately because the merge nulls
 * `xeroContactId` itself during the Xero teardown, so the fresh row would report
 * `null` for a contact the audit needs to name (#2243).
 */
function buildLoserSnapshot(loser: Member, xeroContactIdAtOpen: string | null) {
  return {
    id: loser.id,
    firstName: loser.firstName,
    lastName: loser.lastName,
    email: loser.email,
    xeroContactId: xeroContactIdAtOpen,
    googleSub: loser.googleSub,
    joinedDate: loser.joinedDate?.toISOString() ?? null,
    createdAt: loser.createdAt.toISOString(),
  };
}

/**
 * The execute-time re-derivation the preview token is verified against, plus —
 * for the five Member self-relation columns — the ID CAPTURE the moves are
 * bounded to (#2437). Counts and captured ids come from the SAME read: the
 * self-relation counts are the length of the captured id list, so a row the
 * token check never saw can never be inside the capture. Anything that lands
 * after this read stays pointing at the duplicate (`applyMoves` sweeps only the
 * captured ids), and the step-5 inbound re-check refuses the merge — closing
 * the window where a family link written mid-transaction would be absorbed
 * onto the master without the guards or the operator ever seeing it.
 *
 * The master's own row is EXCLUDED from the self-relation counts here and in
 * `buildMemberMergePreview` together (the digest requires both derivations to
 * agree): the master's pointer at the duplicate is not moved but CLEARED by
 * step 1, so counting it as a move showed the operator a "History moved" row
 * for a link the merge in fact deletes. The preview surfaces the clearance as
 * an explicit warning instead, and master-side changes inside the transaction
 * are policed by step 1's value-conditional null and the step-5 master arm,
 * not by these counts.
 */
async function previewRelationCountsForToken(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<{
  counts: { model: string; count: number }[];
  selfRelationRefs: Record<string, string[]>;
}> {
  const out: { model: string; count: number }[] = [];
  const moveSpecs = MEMBER_MERGE_RELATION_SPECS.filter((s) => s.bucket === "move");
  const selfRelationRefs: Record<string, string[]> = {};
  const counts = await Promise.all(
    moveSpecs.map(async (s) => {
      if (!s.selfRelation) return countLoserRows(db, s.delegate, s.column, loserId);
      const delegate = (db as unknown as Record<string, {
        findMany: (args: unknown) => Promise<{ id: string }[]>;
      }>)[s.delegate];
      const rows = await delegate.findMany({
        where: selfRelationMoveWhere(s.column, masterId, loserId),
        select: { id: true },
      });
      selfRelationRefs[s.column] = rows.map((r) => r.id);
      return rows.length;
    }),
  );
  moveSpecs.forEach((s, i) => {
    if (counts[i] > 0) out.push({ model: s.key, count: counts[i] });
  });
  // Same order and same source as `buildMemberMergePreview`, so the digest the
  // token is verified against matches the one it was issued from (#2243).
  out.push(...(await countFkLessMoveRows(db, loserId)));
  return { counts: out, selfRelationRefs };
}

async function collectMovedIdSample(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<{ sample: { model: string; id: string }[]; truncated: boolean }> {
  const sample: { model: string; id: string }[] = [];
  let truncated = false;
  for (const s of MEMBER_MERGE_RELATION_SPECS) {
    if (s.bucket === "cascade") continue;
    if (sample.length >= MOVED_ID_SAMPLE_CAP) {
      truncated = true;
      break;
    }
    const delegate = (db as unknown as Record<string, {
      findMany: (args: unknown) => Promise<{ id: string }[]>;
    }>)[s.delegate];
    const remaining = MOVED_ID_SAMPLE_CAP - sample.length;
    const rows = await delegate.findMany({
      // Self-relation columns exclude the master's own row: its pointer at the
      // duplicate is CLEARED by step 1, never moved, so recording it in the
      // audit's movedIdSample was an affirmatively wrong account of an
      // irreversible change (#2437). The clearance is audited separately as
      // `selfRelationCyclesNulled`.
      where: s.selfRelation
        ? selfRelationMoveWhere(s.column, masterId, loserId)
        : { [s.column]: loserId },
      select: { id: true },
      take: remaining + 1,
    });
    for (const r of rows.slice(0, remaining)) {
      sample.push({ model: s.key, id: r.id });
    }
    if (rows.length > remaining) truncated = true;
  }
  return { sample, truncated };
}

/**
 * MP1 (#189) — member-photo cleanup on merge. `Member.photoImageId` is an
 * outbound scalar FK handled by the master-wins field merge; this deletes the
 * loser's own MEMBER_PHOTO `MediaImage` (its discarded photo) plus any blob it
 * uploaded that is now unreferenced, EXCEPT the one the master keeps — so no
 * member-photo blob survives unreferenced as a dangling public asset. It does
 * NOT delete a blob still referenced by another surviving member: an admin
 * (a possible loser) may have uploaded photos on behalf of others, which carry
 * the admin's `uploadedByMemberId` but are the *subject's* current photo. That
 * carve-out lives in the shared `deleteOwnedMemberPhotoBlobs` helper. Deleting a
 * blob the loser still points to is safe (`onDelete: SetNull`). Runs BEFORE the
 * loser hard-delete, while the loser still references its own blob.
 *
 * `loserPhotoImageId` is the loser's CURRENT photo pointer, read FRESH by the
 * caller under the loser's row lock (NOT the stale `loserFull` snapshot), so a
 * blob just repointed by a concurrent on-behalf upload is the one considered.
 */
async function reconcileLoserMemberPhotos(
  tx: Prisma.TransactionClient,
  loserId: string,
  loserPhotoImageId: string | null,
  keepPhotoImageId: string | null,
): Promise<{ deleted: number }> {
  // Delegate to the shared helper so the merge and account-deletion paths apply
  // the identical "spare blobs referenced by another surviving member" rule.
  // The loser is hard-deleted moments later (still present at this point), so
  // its own blob — referenced only by it — is still swept.
  return deleteOwnedMemberPhotoBlobs(tx, {
    memberId: loserId,
    photoImageId: loserPhotoImageId,
    keepImageId: keepPhotoImageId,
  });
}

/**
 * Step 1 — null the master's own pointers at the duplicate, VALUE-CONDITIONALLY
 * (#2437). The snapshot only decides which columns to LOOK at; each write
 * re-checks `column = loserId` in its own predicate, so under READ COMMITTED it
 * can only null the value it observed. A write that lands on the master between
 * the transaction-opening snapshot and this step (the guards, the token
 * re-derivation and the moved-id sample are dozens of round-trips) makes the
 * predicate miss — `count === 0` — and the merge refuses with the same 409 the
 * step-5 differ uses, instead of blindly overwriting the concurrent link with
 * null and then reading its own null back as "unchanged" at step 5. That
 * includes a concurrent UNLINK (loser -> null): the outcome would have been the
 * same null, but the operator previewed a different starting state, so it
 * refuses in the fail-closed direction like every other drift arm.
 *
 * A successful conditional null takes the master's exclusive row lock and holds
 * it to commit, which is what makes the step-5 master-arm expectation (`null`)
 * genuinely safe rather than tautological: nothing can re-set the column after
 * this step succeeds.
 *
 * Returns the columns actually nulled, so the audit can record the clearance
 * explicitly (they are deliberately NOT counted as relation moves).
 */
async function nullSelfRelationCycles(
  tx: Prisma.TransactionClient,
  master: Member,
  loserId: string,
): Promise<{ nulledColumns: string[] }> {
  const nulledColumns: string[] = [];
  const drifts: FamilyLinkDrift[] = [];
  for (const s of MEMBER_MERGE_RELATION_SPECS) {
    if (!s.selfRelation) continue;
    if ((master as unknown as Record<string, unknown>)[s.column] !== loserId) continue;
    const res = await tx.member.updateMany({
      where: { id: master.id, [s.column]: loserId },
      data: { [s.column]: null },
    });
    if (res.count === 0) {
      drifts.push({ column: s.column, where: "master" });
    } else {
      nulledColumns.push(s.column);
    }
  }
  if (drifts.length > 0) throw familyLinkDriftError(drifts);
  return { nulledColumns };
}

async function applyMoves(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
  selfRelationRefs: Record<string, readonly string[]>,
  loserOwnedBookingIds: readonly string[],
): Promise<{ model: string; count: number }[]> {
  const moves: { model: string; count: number }[] = [];
  for (const s of MEMBER_MERGE_RELATION_SPECS) {
    if (s.bucket !== "move") continue;
    const delegate = (tx as unknown as Record<string, {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    }>)[s.delegate];
    // Member SELF-relations (`parentMemberId`, `secondaryParentId`,
    // `inheritEmailFromId`, `detailsConfirmedByMemberId`) sweep ONLY the rows
    // captured by the token re-derivation (`selfRelationRefs`), and never the
    // MASTER's own row:
    //
    //  - The id bound (#2437) is what stops a family link written mid-merge
    //    being ABSORBED unvetted. A `X.parentMemberId = loser` that commits
    //    after the token counts were captured but before this sweep would
    //    otherwise be silently re-pointed onto the master — a link the guards
    //    (`evaluateFamilyLinkGraphBlockers`) never evaluated and the operator
    //    never previewed, capable of committing the exact family cycle / depth
    //    breach the guards exist to refuse. Bounded to the captured ids, the
    //    late row keeps pointing at the loser and the step-5 inbound re-check
    //    refuses the merge with the family-link drift 409. The value predicate
    //    (`[column]: loserId`) still re-evaluates under READ COMMITTED, so a
    //    captured row whose link was concurrently REMOVED is respected, not
    //    re-pointed.
    //  - The master exclusion (#2445) stands even if a capture ever contained
    //    the master's id: rewriting the master's own pointer to `masterId`
    //    would make it its own parent (or its own email source / details
    //    confirmer). Step 1 nulls the snapshot-visible case value-conditionally;
    //    any residual divergence on the two locked rows is refused by the
    //    step-5 differ (`diffSelfRelationLinkState`), so neither a self-cycle
    //    nor a silent null can reach the commit.
    const res = await delegate.updateMany({
      where: s.selfRelation
        ? {
            [s.column]: loserId,
            id: { in: [...(selfRelationRefs[s.column] ?? [])], not: masterId },
          }
        : s.key === "Booking.member"
          ? { [s.column]: loserId, id: { in: [...loserOwnedBookingIds] } }
          : { [s.column]: loserId },
      data: { [s.column]: masterId },
    });
    if (res.count > 0) moves.push({ model: s.key, count: res.count });
  }

  // FK-LESS member-id columns carried as MOVES rather than snapshots (#2243).
  // Both are live identities even though the schema cannot express them as
  // Member relations: one is replayed to conversion callers and the other is
  // promoted into a real incident FK by the hosting drain. The drain's shared
  // lifecycle handshake precedes this move. Merge follows it with an exact
  // post-move participant plan, one sorted Member row-lock set and a late sweep
  // before deleting the loser. Left on a hard-deleted loser, either pointer
  // would later name a member that no longer exists.
  for (const c of MEMBER_MERGE_FK_LESS_MOVE_COLUMNS) {
    const delegate = (tx as unknown as Record<string, {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    }>)[c.delegate];
    const res = await delegate.updateMany({
      where: { [c.column]: loserId },
      data: { [c.column]: masterId },
    });
    if (res.count > 0) moves.push({ model: c.key, count: res.count });
  }

  return moves;
}

function foldRelationMoveCount(
  moves: { model: string; count: number }[],
  model: string,
  count: number,
): void {
  if (count === 0) return;
  const existing = moves.find((move) => move.model === model);
  if (existing) {
    existing.count += count;
  } else {
    moves.push({ model, count });
  }
}

async function applyLateHostingCoverageMoves(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
  relationMoves: { model: string; count: number }[],
): Promise<void> {
  const owner = await tx.hostingCoverageReevaluation.updateMany({
    where: { memberId: loserId },
    data: { memberId: masterId },
  });
  foldRelationMoveCount(
    relationMoves,
    "HostingCoverageReevaluation.member",
    owner.count,
  );

  const actor = await tx.hostingCoverageReevaluation.updateMany({
    where: { actorMemberId: loserId },
    data: { actorMemberId: masterId },
  });
  foldRelationMoveCount(
    relationMoves,
    "HostingCoverageReevaluation.actorMemberId",
    actor.count,
  );
}

// ---------------------------------------------------------------------------
// Collision resolvers (execute-time)
// ---------------------------------------------------------------------------

type ResolveOutcome = {
  collisions: { model: string; resolution: string; count: number }[];
  warnings: string[];
};

async function resolveAllCollisions(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<ResolveOutcome> {
  const collisions: { model: string; resolution: string; count: number }[] = [];
  const warnings: string[] = [];

  for (const g of GENERIC_KEYED_RESOLVERS) {
    const res = await resolveKeyedCollisions(tx, {
      delegate: g.delegate,
      memberColumn: g.memberColumn,
      keySpecs: g.keys,
      masterId,
      loserId,
    });
    if (res.moved + res.dropped > 0) {
      collisions.push({
        model: g.spec,
        resolution: `moved ${res.moved}, dropped ${res.dropped} duplicate(s)`,
        count: res.moved + res.dropped,
      });
    }
  }

  // FamilyGroupMember (billing membership re-point; #2520 removed the role MAX).
  const fgm = await resolveFamilyGroupMembers(tx, masterId, loserId);
  if (fgm.moved + fgm.dropped > 0) {
    collisions.push({
      model: "FamilyGroupMember.member",
      resolution: `moved ${fgm.moved}, merged ${fgm.dropped} duplicate group(s)`,
      count: fgm.moved + fgm.dropped,
    });
  }

  // MemberInductionSignOff (earliest-wins).
  const iso = await resolveInductionSignOffs(tx, masterId, loserId);
  if (iso.moved + iso.dropped > 0) {
    collisions.push({
      model: "MemberInductionSignOff.signer",
      resolution: `moved ${iso.moved}, dropped ${iso.dropped} (earliest sign-off kept)`,
      count: iso.moved + iso.dropped,
    });
  }

  // MemberPartnerLink (canonical pair, self-pair/dupe/confirmed handling).
  const partner = await resolvePartnerLinks(tx, masterId, loserId);
  if (partner.updated + partner.deleted > 0) {
    collisions.push({
      model: "MemberPartnerLink.memberA/memberB",
      resolution: `re-pointed ${partner.updated}, dropped ${partner.deleted} (self-pair/duplicate/confirmed)`,
      count: partner.updated + partner.deleted,
    });
  }
  warnings.push(...partner.warnings);

  return { collisions, warnings };
}

async function resolveKeyedCollisions(
  tx: Prisma.TransactionClient,
  args: {
    delegate: string;
    memberColumn: string;
    keySpecs: string[][];
    masterId: string;
    loserId: string;
  },
): Promise<{ moved: number; dropped: number }> {
  const delegate = (tx as unknown as Record<string, {
    findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
    deleteMany: (a: unknown) => Promise<{ count: number }>;
    updateMany: (a: unknown) => Promise<{ count: number }>;
  }>)[args.delegate];

  const [loserRows, masterRows] = await Promise.all([
    delegate.findMany({ where: { [args.memberColumn]: args.loserId } }),
    delegate.findMany({ where: { [args.memberColumn]: args.masterId } }),
  ]);
  if (loserRows.length === 0) return { moved: 0, dropped: 0 };

  const { dropIds, moveIds } = partitionKeyedCollisions(
    loserRows,
    masterRows,
    args.keySpecs,
  );

  if (dropIds.length > 0) {
    await delegate.deleteMany({ where: { id: { in: dropIds } } });
  }
  await delegate.updateMany({
    where: { [args.memberColumn]: args.loserId },
    data: { [args.memberColumn]: args.masterId },
  });

  return { moved: moveIds.length, dropped: dropIds.length };
}

/**
 * The composite key for one unique over `fields`, or `null` when any component
 * is null/undefined. A null component means SQL treats the row as distinct on
 * that unique (NULLs never collide), so such a row is never a duplicate on that
 * key - critical for `MemberAccessRole`, whose `role`/`roleDefinitionId` are
 * both nullable (two custom-role rows both carry `role = null` yet are distinct).
 */
function keyOf(row: Record<string, unknown>, fields: readonly string[]): string | null {
  const parts: string[] = [];
  for (const f of fields) {
    const v = row[f];
    if (v === null || v === undefined) return null;
    parts.push(String(v));
  }
  return parts.join("\u0000");
}

/**
 * Pure keep-master collision partition: a loser row is dropped when it collides
 * with a master row on ANY of the model unique keys (the member column is
 * excluded from the key because it becomes the master's after re-point). Every
 * with a null component never collides (SQL NULL-distinct semantics). Every
 * other loser row is moved. Covers the collision matrix: both-have (drop),
 * loser-only (move), neither (nothing to do).
 */
export function partitionKeyedCollisions(
  loserRows: readonly Record<string, unknown>[],
  masterRows: readonly Record<string, unknown>[],
  keySpecs: readonly (readonly string[])[],
): { dropIds: string[]; moveIds: string[] } {
  const masterKeySets = keySpecs.map((fields) => {
    const set = new Set<string>();
    for (const r of masterRows) {
      const k = keyOf(r, fields);
      if (k !== null) set.add(k);
    }
    return set;
  });
  const dropIds: string[] = [];
  const moveIds: string[] = [];
  for (const row of loserRows) {
    const collides = keySpecs.some((fields, i) => {
      const k = keyOf(row, fields);
      return k !== null && masterKeySets[i].has(k);
    });
    if (collides) dropIds.push(row.id as string);
    else moveIds.push(row.id as string);
  }
  return { dropIds, moveIds };
}

async function resolveFamilyGroupMembers(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ moved: number; dropped: number }> {
  // #2520: both reads are narrowed to the two columns this resolver uses. That
  // was a blue/green precondition while the retired `role` column was still in
  // the database — Prisma names every scalar of the model in an unnarrowed find's
  // SELECT, so an unnarrowed read would have named it. The column is now dropped
  // (20260803030000) and the field is gone from the schema, so the narrowing is
  // ordinary hygiene rather than load-bearing; it stays because these two columns
  // are genuinely all this resolver reads.
  const membershipSelect = { id: true, familyGroupId: true } as const;
  const [loserRows, masterRows] = await Promise.all([
    tx.familyGroupMember.findMany({
      where: { memberId: loserId },
      select: membershipSelect,
    }),
    tx.familyGroupMember.findMany({
      where: { memberId: masterId },
      select: membershipSelect,
    }),
  ]);
  if (loserRows.length === 0) return { moved: 0, dropped: 0 };
  const masterByGroup = new Map(masterRows.map((r) => [r.familyGroupId, r]));

  const dropIds: string[] = [];
  for (const row of loserRows) {
    const masterRow = masterByGroup.get(row.familyGroupId);
    if (!masterRow) continue; // no collision -> will be moved
    // Re-point the family's billing membership if it pointed at the loser's
    // (about-to-be-dropped) row. That is the ONLY thing this collision branch
    // does now. #2520 removed the `maxFamilyRole` upgrade that also ran here —
    // it promoted the surviving row to "ADMIN" when either row held it — because
    // the column it wrote granted nothing after #2284, so the promotion changed
    // no behaviour anywhere; the column itself is now dropped (20260803030000).
    // Do not add a merge rule for a rank the join table no longer records.
    await tx.familyGroup.updateMany({
      where: { billingMembershipId: row.id },
      data: { billingMembershipId: masterRow.id },
    });
    dropIds.push(row.id);
  }

  if (dropIds.length > 0) {
    await tx.familyGroupMember.deleteMany({ where: { id: { in: dropIds } } });
  }
  const moved = await tx.familyGroupMember.updateMany({
    where: { memberId: loserId },
    data: { memberId: masterId },
  });
  return { moved: moved.count, dropped: dropIds.length };
}

async function resolveInductionSignOffs(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ moved: number; dropped: number }> {
  const [loserRows, masterRows] = await Promise.all([
    tx.memberInductionSignOff.findMany({ where: { signerMemberId: loserId } }),
    tx.memberInductionSignOff.findMany({ where: { signerMemberId: masterId } }),
  ]);
  if (loserRows.length === 0) return { moved: 0, dropped: 0 };
  const masterByInduction = new Map(masterRows.map((r) => [r.inductionId, r]));

  let dropped = 0;
  for (const row of loserRows) {
    const masterRow = masterByInduction.get(row.inductionId);
    if (!masterRow) continue;
    // Earliest sign-off wins.
    if (row.signedAt.getTime() < masterRow.signedAt.getTime()) {
      // Loser's is earlier: drop master's, keep loser's (moved below).
      await tx.memberInductionSignOff.delete({ where: { id: masterRow.id } });
      masterByInduction.delete(row.inductionId);
    } else {
      await tx.memberInductionSignOff.delete({ where: { id: row.id } });
      dropped += 1;
    }
  }
  const moved = await tx.memberInductionSignOff.updateMany({
    where: { signerMemberId: loserId },
    data: { signerMemberId: masterId },
  });
  return { moved: moved.count, dropped };
}

async function resolvePartnerLinks(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ updated: number; deleted: number; warnings: string[] }> {
  const plan = await loadPartnerLinkPlan(tx, masterId, loserId);
  if (plan.deleteIds.length > 0) {
    await tx.memberPartnerLink.deleteMany({ where: { id: { in: plan.deleteIds } } });
  }
  for (const u of plan.updates) {
    await tx.memberPartnerLink.update({
      where: { id: u.id },
      data: { memberAId: u.memberAId, memberBId: u.memberBId },
    });
  }
  return {
    updated: plan.updates.length,
    deleted: plan.deleteIds.length,
    warnings: plan.warnings,
  };
}

// ---------------------------------------------------------------------------
// Loser Xero teardown (link-role aware; NO Xero API calls)
// ---------------------------------------------------------------------------

async function teardownLoserXero(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ entranceFee: "repointed" | "deactivated" | "none"; deactivatedOther: number }> {
  const loserLinks = await tx.xeroObjectLink.findMany({
    where: { localModel: "Member", localId: loserId, active: true },
  });

  let entranceFee: "repointed" | "deactivated" | "none" = "none";
  const entranceLink = loserLinks.find((l) => l.role === "ENTRANCE_FEE_INVOICE");

  if (entranceLink) {
    const masterHasEntrance =
      (await tx.xeroObjectLink.count({
        where: {
          localModel: "Member",
          localId: masterId,
          active: true,
          role: "ENTRANCE_FEE_INVOICE",
        },
      })) > 0;

    // The (localModel,localId,xeroObjectType,xeroObjectId,role) unique means a
    // re-point could collide if the master already holds the identical link; in
    // that case (or if the master already has any active entrance-fee link) we
    // deactivate the loser's instead of re-pointing.
    const masterHasIdentical =
      (await tx.xeroObjectLink.count({
        where: {
          localModel: "Member",
          localId: masterId,
          xeroObjectType: entranceLink.xeroObjectType,
          xeroObjectId: entranceLink.xeroObjectId,
          role: "ENTRANCE_FEE_INVOICE",
        },
      })) > 0;

    if (masterHasEntrance || masterHasIdentical) {
      await tx.xeroObjectLink.update({
        where: { id: entranceLink.id },
        data: { active: false },
      });
      entranceFee = "deactivated";
    } else {
      await tx.xeroObjectLink.update({
        where: { id: entranceLink.id },
        data: { localId: masterId },
      });
      entranceFee = "repointed";
    }
  }

  // Deactivate every OTHER active contact-identity link for the loser (mirror
  // of the delete path). The entrance-fee link was handled above.
  const deactivated = await tx.xeroObjectLink.updateMany({
    where: {
      localModel: "Member",
      localId: loserId,
      active: true,
      role: { not: "ENTRANCE_FEE_INVOICE" },
    },
    data: { active: false },
  });

  // Mirror the delete path: null the loser's Xero contact id (loser is deleted
  // straight after, but keep behaviour identical and defensive).
  await tx.member.update({ where: { id: loserId }, data: { xeroContactId: null } });

  return { entranceFee, deactivatedOther: deactivated.count };
}
