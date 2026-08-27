/**
 * The Member scalar columns a merge captures in the loser's snapshot before the
 * row is deleted.
 *
 * Split verbatim out of `member-merge.ts` (#3128). Kept apart from the relation
 * table next door because the two answer different questions -- that one is
 * "what points AT this member", this one is "what is ON the member row" -- and
 * because a merge that loses a column here loses evidence rather than a link.
 */
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
 * move/resolve bucket by accident (the completeness test over
 * `MEMBER_MERGE_RELATION_SPECS`, which #3128 moved to
 * `member-merge-relations.ts` — this said "above" while the two lists shared a
 * file).
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
  // Epic #2992: who uploaded a board image. A bare scalar with no @relation,
  // for the same reasons MediaImage.uploadedByMemberId is one -- it is the
  // audit answer to "who put this here", which a merge must not rewrite, and
  // an unclaimed upload has no post to be attributed through instead.
  "ClubPostImage.uploadedByMemberId",
  // #2999: the club message board's settings-audit column -- who last changed
  // the retention window. Identical in kind to the billing-settings column above
  // and MemberGuestSettings.updatedByMemberId below: a bare scalar with no
  // @relation, kept pointing at the loser as the immutable answer to "who set
  // this", which is the person who set it, not whoever absorbed their record.
  "ClubPostSettings.updatedByMemberId",
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
  // relation and is already classified `move` in `member-merge-relations.ts`
  // (it said "above" until #3128 split the two apart), so merging A into B
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
