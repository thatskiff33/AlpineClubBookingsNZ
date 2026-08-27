/**
 * Every Member-referencing relation a merge has to re-point, and the buckets
 * that decide how each one is treated.
 *
 * Split verbatim out of `member-merge.ts` (#3128), which was 3,814 lines and the
 * largest file in the repository. This is the declarative half: a table and the
 * one factory that builds its rows. It reads no database, holds no lock and
 * imports nothing from the merge engine, which is what made it separable --
 * `member-merge.ts` imports this module, never the other way round.
 */
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
 * the DMMF/schema relation walk and are documented, not classified, in
 * `member-merge-snapshot-columns.ts`. (That said "below" until #3128 split this
 * table out; the list is a sibling module now, not further down this file.)
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
 * The authoritative classification of every Member FK-owning relation. The
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
  // immutable history in MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS, which #3128 moved
  // to `member-merge-snapshot-columns.ts`. If you are here adding an actor column
  // to one of these models, that sibling module is where it goes.
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

  // --- Club message board (#2993, epic #2992) ---
  // Authorship: nullable SetNull, no member unique -- the surviving person keeps
  // their posts, mirroring Notice.createdBy above. The denormalised authorName
  // on the row is deliberately NOT rewritten: it is what the board displayed at
  // the time, and a merge is not a licence to restate who said something.
  spec("ClubPost", "author", "authorMemberId", "move"),
  // Reports: @@unique(postId,reporterMemberId), so if BOTH members reported the
  // same post a naive move collides. Keep the master's report and drop the
  // loser's, via the generic keyed resolver.
  //
  // ClubPost.reportCount is a cached count of non-dismissed reports, recomputed
  // on report and dismissal rather than incremented. Dropping a duplicate here
  // does not trigger that recompute, so a post can sit one report over its true
  // distinct-reporter count until the next report or dismissal touches it. That
  // is a moderation signal reading slightly high on an already-visible post, not
  // a gate anyone passes through, and an admin can unhide.
  spec("ClubPostReport", "reporter", "reporterMemberId", "resolve", {
    note: "@@unique(postId,reporterMemberId); keep master's report on collision",
  }),
];
