/**
 * The REVIEWED audit-writer census manifest (#2581).
 *
 * `audit-writer-census.ts` measures the tree. This file records what a human
 * decided about the measurement, and `src/lib/__tests__/audit-writer-census.test.ts`
 * fails when the two disagree. That is the whole mechanism: a new audit writer
 * that omits a category, an invented category value, a hand-written Prisma write
 * to `AuditLog`, or a wrapper that stops writing, all land as a named CI failure
 * instead of as a row nobody can filter for.
 *
 * WHY THE PINS ARE COUNTS AND IDENTITIES RATHER THAN A THRESHOLD. "No more than
 * 82" would let a new writer in every time an old one was fixed. The pin is the
 * exact SET of uncategorised writers, so fixing one and adding another is a
 * failure in both directions — the fix has to remove its entry here.
 *
 * IDENTITIES ARE SYMBOL-KEYED, NOT LINE-KEYED, deliberately. Line numbers in
 * this area move constantly: PR #2618 alone moved the deletion-request writers
 * from lines 131/403 to 293/649 without touching a single audit argument. An
 * identity is `<repo-relative path>::<enclosing symbol chain>#<ordinal among
 * sites sharing that symbol>`, which survives a reformat and a rebase.
 *
 * WHAT `proposedCategory` IS AND IS NOT. It is this child's reviewed
 * recommendation, carried here so the classification decisions are recorded and
 * reversible rather than rediscovered. It is NOT applied: the sweep that puts a
 * category at each of these call sites is #2581's second child, because each one
 * also changes the row's RETENTION (see the note on `UNCATEGORISED_AUDIT_WRITERS`)
 * and needs its transaction and failure semantics reviewed per writer family.
 */

/** A canonical audit category, as a plain string so this file needs no `src/` import. */
type ProposedCategory =
  | "account"
  | "booking"
  | "payment"
  | "family"
  | "admin"
  | "security"
  | "lodge"
  | "xero"
  | "communication"
  | "privacy"
  | "system"
  /** A dynamic action family whose category depends on the action (#2581 decision 6). */
  | "split";

/**
 * The measured shape of the census on this commit.
 *
 * These are the numbers #2581 argues from, and they are pinned because the issue
 * has already been argued from three stale ones: the title says 81, an earlier
 * comment says 350 total, and the Diagnostics docblock said "81 of ~350".
 */
export const AUDIT_CENSUS_TOTALS = {
  /**
   * Row-producing production write sites across `src/`, `scripts/` and `prisma/`.
   *
   * 418 -> 419 (#2627): releasing a started deletion approval writes
   * `member.deletion_approval_claim_released` with the awaited `createAuditLog`,
   * inside the release's own transaction, because that row is the only surviving
   * record of who held the claim the transition destroys. Categorised `privacy`
   * at the site, so it does not join `UNCATEGORISED_AUDIT_WRITERS` below.
   *
   * 419 -> 420 (#2623): the waitlist-confirm route records
   * `waitlist.confirm_offer_release_failed` when its compensating offer release
   * cannot run, because that state is operator-only — no cron sweeps it and the
   * member has nothing to retry — so the audit row IS the recovery surface. It is
   * categorised `booking`, `critical` severity, and carries `entityType`/`entityId`
   * so it correlates to the booking. (#2627 and #2623 landed in the same window and
   * both claimed 419; the pin has to count BOTH, which is exactly what this file
   * exists to catch.)
   *
   * 419 -> 420 (#2352 MC-03D): deleting a page-content page writes
   * `PAGE_CONTENT_DELETED` inside the delete's own transaction, because the row
   * carries the deleted page's whole `before` snapshot and is the only record of
   * what was removed. Written with `buildStructuredAuditLogCreateArgs` through
   * `tx.auditLog.create`, matching the three sibling writes already in that
   * route rather than introducing a fourth form; categorised `admin` at the
   * site, so it does not join `UNCATEGORISED_AUDIT_WRITERS` below.
   *
   * 420 -> 421 on the MERGE, and this is the gate earning its keep for the second
   * time in one window. #2623 and this change each measured 419 -> 420 against a
   * base without the other, so both literals read `420` — byte-identical, which
   * means git resolved the VALUE silently and only the comments above collided.
   * The merged tree has both writers, so the honest number is 421. It came from
   * running the census after the merge; adding the two deltas up would have got
   * there by luck, and reading either side's literal would have shipped a pin
   * that was quietly one short.
   *
   * 421 -> 423 (#2621): both expected-arrival-time writers now record what they
   * did. They recorded NOTHING before, and since #1313 option A2 a Booking Officer
   * may set or clear the time on any member's booking — so the field had two
   * possible authors and no way to tell them apart, or to answer "who changed
   * this" at all. `booking.expected_arrival_time.set` and
   * `.cleared` both use fire-and-forget `logAudit` after the update commits (this
   * route holds no transaction), are categorised `booking` at the site, and carry
   * `entityType`/`entityId` so they correlate to the booking. The clear also
   * carries the value it destroyed, because nothing else keeps it.
   */
  writeSites: 423,
  /** Of those, sites whose event object carries no `category` key. */
  uncategorised: 82,
  /** Per-sink totals, so a shift between forms cannot cancel out in the total. */
  bySink: {
    // 238 -> 239 (#2623): the waitlist-confirm recovery marker, fire-and-forget
    // outside every transaction because its own failure must not mask the strand.
    // 239 -> 241 (#2621): the two expected-arrival-time writers, above.
    logAudit: { total: 241, uncategorised: 69 },
    // 101 -> 102 (#2627): the deletion-approval release, above.
    createAuditLog: { total: 102, uncategorised: 11 },
    createStructuredAuditLog: { total: 8, uncategorised: 0 },
    // 71 -> 72 (#2352 MC-03D): the page-content deletion, above.
    "auditLog.create": { total: 72, uncategorised: 2 },
  },
  /**
   * Literal category values written, and by how many sites. The three `membership`
   * and one `auth` values that used to appear here were invented — never in the
   * taxonomy, selectable by no reader — and are corrected in this change
   * (#2581 decisions 1 and 2), which is why `account` is 15 rather than 10 and
   * `security` is 16 rather than 15.
   *
   * `booking` is 80 rather than 79 since #2623 (the stranded waitlist-confirm
   * recovery marker above). Correlation reads of `booking` require `support` plus
   * `bookings` (`AUDIT_CORRELATION_DOMAIN_AREAS`), which the lodge administrators
   * who have to act on that row already hold — so this adds no reader who could not
   * already see the booking the row names.
   */
  categoryValues: {
    account: 15,
    // 80 -> 82 (#2621): the two expected-arrival-time rows, above. `booking` is
    // the category every other booking write on this route family already uses,
    // and a correlation read of it needs `support` plus `bookings` — which the
    // booking officers who can set this field already hold. No new reader.
    booking: 82,
    payment: 16,
    family: 27,
    // 117 -> 118 (#2352 MC-03D): `PAGE_CONTENT_DELETED`. `admin` is the same
    // category the three sibling page-content writes already use, and it is
    // readable with support:view alone — so this widens nobody's access beyond
    // what the page-content create/update rows beside it already grant.
    admin: 118,
    security: 16,
    lodge: 16,
    xero: 19,
    communication: 12,
    // 14 -> 15 (#2627): `member.deletion_approval_claim_released`. Still a
    // membership+support read, like every other deletion-decision row beside it,
    // so this widens nobody's access.
    privacy: 15,
    system: 4,
  },
} as const;

/**
 * Every production audit write that records NO category, with the category this
 * child recommends for it.
 *
 * THE RETENTION CONSEQUENCE, measured rather than assumed, because it is the
 * reason this is not a metadata-only sweep. All of these also pass no `severity`
 * and no `retentionClass`, and `buildAuditLogCreateData` derives retention only
 * when one of category/severity/retentionClass is present — so every one of these
 * rows is written today with `retentionClass = NULL` and `expiresAt = NULL`, i.e.
 * kept forever and never archived. Adding a category makes
 * `classifyAuditRetention` run, and it falls through to `critical` for all of
 * these actions, which is a seven-year expiry. One site changes class depending on
 * the answer: `family-group.login-holder-swapped` normalises to a string
 * containing "login", so classifying it `security` or `admin` would make it
 * `sensitive_access` at 24 months instead. It is proposed `family`, so it does
 * not.
 *
 * THE ENTITY-IDENTIFIER CONSEQUENCE. Only the nine lodge-display sites pass an
 * `entityType` or `entityId`; the other 73 pass neither, so a categorised row from
 * them still cannot be correlated to a specific record. That is the "missing
 * entity identifiers that prevent bounded correlation" case the owner named as
 * in-scope, and it belongs to the sweep rather than to this manifest.
 */
export const UNCATEGORISED_AUDIT_WRITERS: Readonly<
  Record<string, { action: string; proposedCategory: ProposedCategory }>
> = {
  // ─── Booking policy, booking periods and age tiers → `booking` ──────────────
  // Booking-eligibility and booking-price rules. `booking` is read with
  // `support:view` plus `bookings:view`.
  "src/app/api/admin/age-tier-settings/route.ts::PUT#0": {
    action: "AGE_TIER_SETTINGS_UPDATED",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/adult-member-hosting/route.ts::PUT#0": {
    action: "adult-member-hosting-policy.update",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/cancellation/route.ts::PUT#0": {
    action: "cancellation-policy.update",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/group-discount/route.ts::PUT#0": {
    action: "group-discount.update",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/minimum-stay/[id]/route.ts::DELETE#0": {
    action: "minimum-stay-policy.delete",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/minimum-stay/[id]/route.ts::PUT#0": {
    action: "minimum-stay-policy.update",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/minimum-stay/route.ts::POST#0": {
    action: "minimum-stay-policy.create",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/periods/[id]/route.ts::DELETE#0": {
    action: "booking-period.delete",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/periods/[id]/route.ts::PUT#0": {
    action: "booking-period.update",
    proposedCategory: "booking",
  },
  "src/app/api/admin/booking-policies/periods/route.ts::POST#0": {
    action: "booking-period.create",
    proposedCategory: "booking",
  },

  // ─── Seasons and promotional codes → `booking` (#2581 decision 4) ───────────
  // A season and a promotional code are booking-eligibility rules, so they follow
  // the booking domain. The trade-off recorded on the decision: a promotional code
  // carries a discount amount, so price-affecting evidence sits behind
  // `bookings:view` rather than `finance:view`.
  "src/app/api/admin/seasons/[id]/route.ts::DELETE#0": {
    action: "season.delete",
    proposedCategory: "booking",
  },
  "src/app/api/admin/seasons/[id]/route.ts::PUT#0": {
    action: "season.update",
    proposedCategory: "booking",
  },
  "src/app/api/admin/seasons/route.ts::POST#0": {
    action: "season.create",
    proposedCategory: "booking",
  },
  "src/app/api/admin/promo-codes/[id]/route.ts::DELETE#0": {
    action: "promo.archive",
    proposedCategory: "booking",
  },
  "src/app/api/admin/promo-codes/[id]/route.ts::DELETE#1": {
    action: "promo.delete",
    proposedCategory: "booking",
  },
  "src/app/api/admin/promo-codes/[id]/route.ts::PATCH#0": {
    action: "promo.restore",
    proposedCategory: "booking",
  },
  "src/app/api/admin/promo-codes/[id]/route.ts::PUT#0": {
    action: "promo.update",
    proposedCategory: "booking",
  },
  "src/app/api/admin/promo-codes/route.ts::POST#0": {
    action: "promo.create",
    proposedCategory: "booking",
  },

  // ─── Money: subscription billing, member credit, fees, card payments → `payment`
  // Charges, credits, fees and card results. `payment` is read with `support:view`
  // plus `finance:view`, which is the narrowest genuine gate for money evidence.
  "src/app/api/admin/subscription-billing/route.ts::POST#0": {
    action: "membership-subscription-billing.settings.update",
    proposedCategory: "payment",
  },
  "src/app/api/admin/subscription-billing/route.ts::POST#1": {
    action: "membership-subscription-billing.retry",
    proposedCategory: "payment",
  },
  "src/app/api/admin/subscription-billing/route.ts::POST#2": {
    action: "membership-subscription-billing.mark-family",
    proposedCategory: "payment",
  },
  "src/app/api/admin/subscription-billing/route.ts::POST#3": {
    action: "membership-subscription-billing.unmark-family",
    proposedCategory: "payment",
  },
  "src/app/api/admin/subscription-billing/route.ts::POST#4": {
    action: "membership-subscription-billing.reconcile",
    proposedCategory: "payment",
  },
  "src/lib/membership-subscription-billing.ts::confirmSubscriptionBillingPreview#0": {
    action: "membership-subscription-billing.confirm",
    proposedCategory: "payment",
  },
  "src/lib/member-credit.ts::createAdminAdjustmentRequest.request#0": {
    action: "member.credit.adjustment.request",
    proposedCategory: "payment",
  },
  "src/lib/member-credit.ts::reviewAdminAdjustmentRequest.result#0": {
    action: "member.credit.adjustment.reject",
    proposedCategory: "payment",
  },
  "src/lib/member-credit.ts::reviewAdminAdjustmentRequest.result#1": {
    action: "member.credit.adjustment.approve",
    proposedCategory: "payment",
  },
  "src/app/api/admin/fee-configuration/route.ts::POST#0": {
    action: "fee-configuration.${action} (dynamic, bounded by the route's enum)",
    proposedCategory: "payment",
  },
  "src/app/api/payments/charge-saved-method/route.ts::POST#0": {
    action: "booking.payment.confirmed",
    proposedCategory: "payment",
  },
  "src/app/api/payments/charge-saved-method/route.ts::POST#1": {
    action: "booking.payment.failed",
    proposedCategory: "payment",
  },
  "src/lib/stripe-webhook-service.ts::handleCancelledBookingPaymentSucceeded#0": {
    action: "booking.payment.refunded_after_cancellation",
    proposedCategory: "payment",
  },
  "src/lib/stripe-webhook-service.ts::handleCancelledBookingAdditionalPaymentSucceeded#0": {
    action: "booking.payment.refunded_after_cancellation",
    proposedCategory: "payment",
  },
  "src/lib/stripe-webhook-service.ts::handlePaymentIntentCanceled#0": {
    action: "booking(.modification)?.payment.canceled (dynamic, two literals)",
    proposedCategory: "payment",
  },
  "src/lib/stripe-webhook-service.ts::handlePaymentIntentFailed#0": {
    action: "booking(.modification)?.payment.failed (dynamic, two literals)",
    proposedCategory: "payment",
  },
  "src/lib/stripe-webhook-service.ts::refundSupersededGroupSettlementIntent#0": {
    action: "group.settlement.superseded_intent_refunded",
    proposedCategory: "payment",
  },

  // ─── Xero settings, mappings, retry/replay and maintenance → `xero` ─────────
  "src/app/api/admin/xero/account-mappings/route.ts::PUT#0": {
    action: "xero_account_mappings_updated",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/item-code-mappings/route.ts::PUT#0": {
    action: "xero_item_code_mappings_updated",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/link-maintenance/route.ts::POST#0": {
    action: "XERO_LINK_LEDGER_MAINTENANCE",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/inbound-events/[id]/replay/route.ts::POST#0": {
    action: "XERO_INBOUND_EVENT_REPLAY",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/member-grouping/route.ts::POST#0": {
    action: "XERO_GROUPING_MODE_UPDATED",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/member-grouping/route.ts::POST#1": {
    action: "XERO_GROUPING_RULE_CREATED",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/member-grouping/route.ts::POST#2": {
    action: "XERO_GROUPING_RULE_UPDATED",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/member-grouping/route.ts::POST#3": {
    action: "XERO_GROUPING_RULE_TOGGLED",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/member-grouping/route.ts::POST#4": {
    action: "XERO_GROUPING_RULE_DELETED",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/member-grouping/route.ts::POST#5": {
    action: "XERO_GROUPING_BULK_RESYNC_REJECTED",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/member-grouping/route.ts::POST#6": {
    action: "XERO_GROUPING_BULK_RESYNC",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/operations/[id]/requeue/route.ts::POST#0": {
    action: "XERO_OPERATION_REQUEUED",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/operations/[id]/retry/route.ts::POST#0": {
    action: "XERO_OPERATION_RETRY",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/operations/reset-stale-running/route.ts::POST#0": {
    action: "XERO_OPERATIONS_RESET_STALE_RUNNING",
    proposedCategory: "xero",
  },
  "src/app/api/admin/xero/operations/retry-all/route.ts::POST#0": {
    action: "XERO_OPERATION_RETRY_ALL",
    proposedCategory: "xero",
  },

  // ─── Lodge display configuration and lodge accounts → `lodge` ───────────────
  // The nine display sites are the only members of the 82 that already pass an
  // entity identifier, so they are the cheapest group for the sweep to finish.
  "src/app/api/admin/display/devices/[id]/revoke/route.ts::POST#0": {
    action: "LODGE_DISPLAY_DEVICE_REVOKED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/display/devices/[id]/route.ts::PATCH#0": {
    action: "DISPLAY_DEVICE_TEMPLATE_ASSIGNED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/display/devices/[id]/route.ts::PATCH#1": {
    action: "DISPLAY_DEVICE_POLL_INTERVAL_SET",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/display/layouts/[id]/route.ts::DELETE#0": {
    action: "DISPLAY_LAYOUT_DELETED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/display/layouts/[id]/route.ts::PUT#0": {
    action: "DISPLAY_LAYOUT_UPDATED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/display/layouts/route.ts::POST#0": {
    action: "DISPLAY_LAYOUT_CREATED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/display/templates/[id]/route.ts::DELETE#0": {
    action: "DISPLAY_TEMPLATE_DELETED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/display/templates/[id]/route.ts::PUT#0": {
    action: "DISPLAY_TEMPLATE_UPDATED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/display/templates/route.ts::POST#0": {
    action: "DISPLAY_TEMPLATE_CREATED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/lodge/route.ts::GET#0": {
    action: "LODGE_ACCOUNT_CREATED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/lodge/route.ts::POST#0": {
    action: "LODGE_ACCOUNT_CREATED",
    proposedCategory: "lodge",
  },
  "src/app/api/admin/lodge/route.ts::PUT#0": {
    action: "LODGE_ACCOUNT_UPDATED",
    proposedCategory: "lodge",
  },

  // ─── Family groups, login holder and dependents → `family` ─────────────────
  // `family` becomes readable through the membership correlation entry in this
  // change, so these land in a set that exists rather than in one that does not.
  // The two dependents writers are hand-built Prisma `data` literals that bypass
  // `buildAuditLogCreateData` entirely, so they get no sanitisation and no
  // retention derivation; the sweep has to route them through the boundary rather
  // than just adding a key.
  "src/app/api/admin/family-groups/route.ts::POST#0": {
    action: "FAMILY_GROUP_CREATED",
    proposedCategory: "family",
  },
  "src/app/api/admin/family-groups/[id]/route.ts::PUT#0": {
    action: "FAMILY_GROUP_UPDATED",
    proposedCategory: "family",
  },
  "src/app/api/admin/family-groups/[id]/route.ts::DELETE#0": {
    action: "FAMILY_GROUP_DELETED",
    proposedCategory: "family",
  },
  "src/app/api/admin/family-groups/[id]/login-holder/route.ts::POST.result#0": {
    action: "family-group.login-holder-swapped",
    proposedCategory: "family",
  },
  "src/app/api/admin/family-suggestions/route.ts::POST#0": {
    action: "FAMILY_GROUP_CREATED_FROM_SUGGESTION",
    proposedCategory: "family",
  },
  "src/app/api/admin/members/[id]/dependents/[dependentId]/route.ts::DELETE.result#0": {
    action: "member.dependent.unlink",
    proposedCategory: "family",
  },
  "src/app/api/admin/members/[id]/dependents/link/route.ts::POST.linkedMember#0": {
    action: "member.dependent.link",
    proposedCategory: "family",
  },

  // ─── Membership applications and nomination → `account` ────────────────────
  // Same destination as the three nomination writers this change corrects off the
  // invented `membership` value, so the whole family ends up consistent.
  "src/lib/nomination.ts::createMemberApplication#0": {
    action: "MEMBERSHIP_APPLICATION_CREATED",
    proposedCategory: "account",
  },
  "src/lib/nomination.ts::confirmNomination#0": {
    action: "MEMBERSHIP_APPLICATION_NOMINATION_CONFIRMED",
    proposedCategory: "account",
  },
  "src/lib/nomination.ts::approveMemberApplication#2": {
    action: "MEMBERSHIP_APPLICATION_APPROVED",
    proposedCategory: "account",
  },
  "src/lib/nomination.ts::rejectMemberApplication#0": {
    action: "MEMBERSHIP_APPLICATION_REJECTED",
    proposedCategory: "account",
  },

  // ─── Credential delivery → `security` (#2581 decision 3) ───────────────────
  // The affected domain is the CREDENTIAL, not the mailing: these two actions
  // hand somebody a way to take over an account. `security` is read with
  // `support:view` alone, which is the same gate Admin > Audit Log already needs
  // for these rows, so it is not a weakening — but it is the wider of the two
  // readings and the reason this was a decision rather than an inference.
  "src/app/api/admin/members/send-password-reset/route.ts::POST#0": {
    action: "member.password-reset-sent",
    proposedCategory: "security",
  },
  "src/app/api/admin/members/send-setup-invite/route.ts::POST.batchResults#0": {
    action: "member.setup-invite-sent",
    proposedCategory: "security",
  },

  // ─── Member bulk lifecycle → SPLIT by action (#2581 decision 6) ────────────
  // One call site, several affected domains: `member.bulk-${action}` where the
  // action decides. `security` for role changes, `account` for activate and
  // deactivate. The sweep has to declare this as a dynamic action family rather
  // than pick one category for the site.
  "src/app/api/admin/members/bulk-update/route.ts::POST#0": {
    action: "member.bulk-${action} (dynamic family)",
    proposedCategory: "split",
  },

  // ─── Privacy decisions → `privacy` ─────────────────────────────────────────
  // Ordinals moved by one (#2627): the categorised release writer is now the
  // first audit site in this `POST`, so the rejection is #1 and the approval #4.
  // Exactly the ordinal drift this manifest's header warns about — the identity
  // survives a reformat, not a new site earlier in the same symbol.
  "src/app/api/admin/deletion-requests/[id]/route.ts::POST#1": {
    action: "member.deletion_rejected",
    proposedCategory: "privacy",
  },
  "src/app/api/admin/deletion-requests/[id]/route.ts::POST#4": {
    action: "member.deletion_approved",
    proposedCategory: "privacy",
  },
  "src/app/api/member/request-deletion/route.ts::POST#0": {
    action: "member.deletion_requested",
    proposedCategory: "privacy",
  },

  // ─── Issue reports → `privacy`, deliberately NOT `admin` (#2581 decision 5) ─
  // `/admin/issue-reports` is a `support` surface and the sibling admin
  // issue-report events are already `privacy`, so matching the surface would mean
  // moving them to `admin` — which would WIDEN them from `support` plus
  // `membership` to `support` alone. The mismatch stays, and it is disclosed.
  "src/app/api/issue-reports/route.ts::POST#0": {
    action: "issue.reported",
    proposedCategory: "privacy",
  },

  // ─── Communication → `communication` ───────────────────────────────────────
  // Safe to place here only BECAUSE this change moves `communication` out of the
  // support-only system correlation entry into the membership one (#2581 decision
  // 7). Under the old map, `BULK_COMMUNICATION_SENT` would have put bulk-email
  // evidence — whose sibling payloads carry recipient addresses — behind
  // `support:view` alone.
  "src/app/api/admin/communications/send/route.ts::POST#0": {
    action: "BULK_COMMUNICATION_SENT",
    proposedCategory: "communication",
  },
  "src/app/api/admin/email-suppressions/[id]/clear/route.ts::POST#0": {
    action: "EMAIL_SUPPRESSION_CLEARED",
    proposedCategory: "communication",
  },
};

/**
 * Functions that write an audit row on a caller's behalf.
 *
 * Why they need declaring at all: a wrapper is one syntactic write site standing
 * for many logical events, so the site-level census under-counts them, and a
 * wrapper that quietly stopped passing a category would take every caller with
 * it. Pinning the wrapper's own category evidence means a change to it is a diff
 * in this file.
 *
 * `recordAgeUpParentEmailHandoffAudit` is the awkward one and the reason the list
 * is fourteen rather than thirteen: it is a hand-built Prisma `create` rather than
 * a helper call, so it bypasses `buildAuditLogCreateData`'s sanitisation and
 * retention derivation while still writing `communication` — and its metadata
 * carries a recipient email address.
 */
export const AUDIT_WRITER_WRAPPERS: Readonly<
  Record<string, { sink: string; category: string }>
> = {
  "src/lib/booking-cancel.ts::logBookingCancellationAudit#0": {
    sink: "logAudit",
    category: "booking",
  },
  "src/lib/booking-cancel.ts::logBookingCancellationAudit#1": {
    sink: "logAudit",
    category: "booking",
  },
  "src/lib/admin-bed-allocation.ts::recordRangeAssignAudit#0": {
    sink: "createAuditLog",
    category: "admin",
  },
  "src/lib/admin-bed-allocation.ts::recordRangeAssignAudit#1": {
    sink: "createAuditLog",
    category: "admin",
  },
  "src/lib/adult-member-hosting-coverage-incidents.ts::recordIncidentAudit#0": {
    sink: "createAuditLog",
    category: "booking",
  },
  "src/lib/bed-allocation-lifecycle.ts::recordPartnerPromotionAudit#0": {
    sink: "createAuditLog",
    category: "lodge",
  },
  "src/lib/bed-allocation-lifecycle.ts::recordBedDisplacementAudit#0": {
    sink: "createAuditLog",
    category: "lodge",
  },
  "src/lib/bed-allocation-lifecycle.ts::recordPartnerShareSweepAudits#0": {
    sink: "createAuditLog",
    category: "lodge",
  },
  "src/lib/cron-policy-exception-hold-reaper.ts::recordExpiryAudit#0": {
    sink: "createAuditLog",
    category: "booking",
  },
  "src/lib/google-oauth.ts::auditGoogleLink#0": {
    sink: "auditLog.create",
    category: "forwarded:buildStructuredAuditLogCreateArgs(event)",
  },
  "src/lib/member-guest-find-service.ts::auditMemberGuestResolve#0": {
    sink: "createStructuredAuditLog",
    category: "privacy",
  },
  "src/lib/member-guest-find-service.ts::auditMemberGuestSearch#0": {
    sink: "createStructuredAuditLog",
    category: "privacy",
  },
  "src/lib/diagnostics/tools/audit.ts::recordDiagnosticsToolAudit#0": {
    sink: "createStructuredAuditLog",
    category: "security",
  },
  "src/lib/xero-inbound/audit.ts::writeXeroInboundAuditLogs#0": {
    sink: "createAuditLog",
    category: "xero",
  },
  "src/lib/xero-bulk-contact-sync.ts::writeXeroContactSyncAudit#0": {
    sink: "createAuditLog",
    category: "xero",
  },
  "src/lib/cron-age-up.ts::recordAgeUpParentEmailHandoffAudit#0": {
    sink: "auditLog.create",
    category: "communication",
  },
};

/**
 * `auditLog` statements that do not produce a row, and are therefore approved
 * NOT to carry a category.
 *
 * Today these are the three retention statements only: the archive `updateMany`,
 * the prune `deleteMany`, and the request-data anonymisation `updateMany`. They
 * mutate or remove rows that already have whatever category they were written
 * with, so "why does this not set a category" has an answer, and the answer is
 * recorded here rather than assumed by a scan that skips non-`create` methods.
 *
 * A new entry here is a hand-written mutation of the platform's audit trail and
 * needs the same scrutiny as a new writer.
 */
export const APPROVED_NON_PRODUCING_AUDIT_DML: Readonly<Record<string, string>> = {
  "src/lib/audit-retention.ts::archiveEligibleAuditLogs#0":
    "Retention archive: stamps `archivedAt` on rows past their archive threshold.",
  "src/lib/audit-retention.ts::pruneExpiredAuditLogs#0":
    "Retention prune: deletes rows past `expiresAt` that are not incident-preserved.",
  "src/lib/audit-retention.ts::anonymizeExpiredAuditRequestData#0":
    "Retention anonymisation: clears `ipAddress`/`userAgent` on rows past the request-data window.",
};

/**
 * Raw-SQL DML against `"AuditLog"` inside committed migrations.
 *
 * WHY THIS LIST EXISTS RATHER THAN AN ASSERTION THAT `prisma/` IS CLEAN. It is
 * not clean, and a TypeScript-only census would have said it was: two migrations
 * write the audit table directly, bypassing `audit.ts` and everything it
 * guarantees — no `sanitizeAuditMetadata`, no retention derivation, no closed
 * category type. Both are legitimate and both are reviewed; the point is that a
 * THIRD one has to be reviewed too, and a census that could not see them would
 * have let it through while reporting a clean tree.
 *
 * An `INSERT` here is a row-producing write and its column list is checked for
 * `"category"` — the email-override migration names it and passes `'admin'`.
 * `UPDATE` and `DELETE` mutate rows that already carry whatever category they were
 * written with, so they are the SQL counterpart of
 * `APPROVED_NON_PRODUCING_AUDIT_DML`.
 *
 * Committed migrations are immutable, so this list only ever grows, and every
 * addition is a deliberate change to the club's audit history.
 */
export const APPROVED_MIGRATION_AUDIT_SQL: Readonly<Record<string, string>> = {
  "prisma/migrations/20260710000100_redact_audit_log_door_codes/migration.sql::update#0":
    "Door-code redaction (#2115): removes leaked lodge door codes from historical audit summaries.",
  "prisma/migrations/20260710000100_redact_audit_log_door_codes/migration.sql::update#1":
    "Door-code redaction: the same sweep over `details`.",
  "prisma/migrations/20260710000100_redact_audit_log_door_codes/migration.sql::update#2":
    "Door-code redaction: the same sweep over `metadata`.",
  "prisma/migrations/20260710000100_redact_audit_log_door_codes/migration.sql::update#3":
    "Door-code redaction: the final sweep pass.",
  "prisma/migrations/20260801150000_strip_email_override_bracket_annotations/migration.sql::insert#0":
    "Email-override cleanup: records one EMAIL_TEMPLATE_OVERRIDE_UPDATED row per template the upgrade rewrote. Names `\"category\"` and writes `admin`, plus an explicit severity, retentionClass and expiresAt.",
};

/**
 * Row-producing sites whose category is decided somewhere other than the call.
 *
 * Exactly one today, and it is safe for a specific reason rather than by
 * convention: `auditGoogleLink` takes a whole `StructuredAuditEvent` and forwards
 * it, and `StructuredAuditEvent.category` is REQUIRED and closed, so every one of
 * its five callers must supply a canonical value (all five supply `security`).
 * A new entry here is a wrapper that can smuggle a missing or invented category
 * past the type system, which is why the list is pinned rather than tolerated.
 */
export const APPROVED_FORWARDED_CATEGORY_SITES: Readonly<Record<string, string>> = {
  "src/lib/google-oauth.ts::auditGoogleLink#0":
    "Forwards a caller-supplied StructuredAuditEvent, whose `category` is required and closed; all five callers pass `security`.",
};
