/**
 * AI Diagnostics — provisioning SQL for the dedicated SELECT-only database role
 * (AID-5, #2374; contract in ADR-007).
 *
 * PURE ON PURPOSE. This module builds the ordered statement list and nothing
 * else: no database handle, no environment read, no `server-only` import (the
 * operator CLI `scripts/diagnostics/provision-ai-diagnostics-role.ts` runs it
 * under `tsx`). That keeps three consumers on ONE definition of the role —
 * the operator's `npm run diagnostics:provision-role`, CI's privilege-proof
 * step, and `ai-diagnostics-select-only-role.realdb.test.ts`, which proves the
 * shipped statements really do produce a role that cannot write. A test fixture
 * that re-declared its own grants would prove nothing about what operators run.
 *
 * DECLARATIVE, NOT ADDITIVE. Re-running the statements is safe and is the
 * intended way to rotate the password — but it also REVOKES every role
 * membership, and every table, sequence and routine privilege, from the role before
 * granting the declared allowlist back. That is the point: the grant allowlist lives
 * here, in public code, so "which tables — and which COLUMNS of them — can
 * Diagnostics read" is answerable by reading one file. A tool pack (AID-6A/B/C,
 * #2375-#2377) that needs a new relation adds its grant to `SELECT_GRANTS` in the
 * same pull request as the tool — and an operator re-provisions as part of that
 * upgrade. ADR-007's "deliberate friction" is exactly this.
 *
 * The revoke-then-grant ORDER is what makes a narrowing safe as well as a widening:
 * a release that removes a column from an allowlist entry has its old, wider grant
 * revoked by `REVOKE ALL PRIVILEGES ON ALL TABLES` before the narrower one is
 * granted, so re-provisioning genuinely tightens rather than accumulating.
 *
 * WHAT IT DOES *NOT* DO, deliberately:
 *  - It does not revoke `CREATE ON SCHEMA public FROM PUBLIC`. PostgreSQL 15+
 *    already denies it, so on a supported server the statement would be a no-op;
 *    on an older or hand-tuned fork it could break a non-superuser app role
 *    mid-migration. Instead the runtime self-check (`database.ts`) REFUSES to run
 *    any tool if the diagnostics role turns out to hold schema CREATE, so the
 *    anomaly is loud rather than silently patched under an operator's feet.
 *  - It does not create the database, the app role, or any view.
 *  - It never prints or logs the password.
 */

/**
 * The one collateral change this provisioning makes to shared database state,
 * called out because a reviewer must see it: `TEMPORARY` on the database is
 * granted to `PUBLIC` by default, and PUBLIC grants cannot be revoked for a
 * single role. Denying the diagnostics role TEMP therefore requires revoking it
 * from PUBLIC and granting it back to the roles that should keep it. The stock
 * Compose stack is unaffected — its app role is a SUPERUSER and bypasses
 * privilege checks entirely — but a fork whose app role is NOT a superuser must
 * be listed in `preserveTempForRoles`.
 */
export const PUBLIC_TEMP_REVOKE_NOTE =
  "REVOKE TEMPORARY ... FROM PUBLIC is database-wide; roles in preserveTempForRoles get it back.";

/**
 * Predefined roles that would defeat the table allowlist or the read-only
 * contract outright. Membership is revoked explicitly on every provision so a
 * hand-granted escalation cannot survive a re-run.
 *
 * The revoke is written per RECORDED GRANT rather than as a bare
 * `REVOKE pg_monitor FROM <role>`, because a bare REVOKE only removes the grant the
 * CURRENT role made. PostgreSQL reports "not a member by role X" as a WARNING and
 * still returns success, so the bare form looked like the harmless normal case and
 * was in fact the silent-failure case whenever anybody else had done the granting
 * (measured on postgres:16.14 for `pg_monitor` and for an ordinary role alike).
 *
 * This list is NOT the membership control — step 5 below strips membership in
 * EVERY role, and the runtime self-check gates on the total. It is kept because
 * naming the eight escalation roles in public code documents what the control is
 * for, and because a refusal that can say "a predefined escalation role" is a
 * better sentence for an operator than a bare count.
 */
export const FORBIDDEN_PREDEFINED_ROLES = [
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_execute_server_program",
  "pg_signal_backend",
  "pg_monitor",
  "pg_maintain",
] as const;

/** One entry on the SELECT allowlist. */
export interface AiDiagnosticsSelectGrant {
  schema: string;
  relation: string;
  /**
   * The COLUMNS the diagnostics role may read, or `undefined` for the whole
   * relation.
   *
   * A column list is the stronger grant and should be the default for anything but
   * a relation whose every column is appropriate diagnostics evidence: PostgreSQL
   * then refuses `SELECT "ipAddress" FROM "AuditLog"` as the diagnostics role
   * (42501), so the projection in a registry entry stops being the only thing
   * standing between this credential and a column — a future tool, a projection
   * bug, or a psql session opened with the credential all hit the server's own
   * refusal. `database.ts` verifies the granted columns against this list and
   * refuses the role if a wider grant appears.
   *
   * The tool pack that adds an entry documents which tools use it and which fields
   * they project (see `docs/ai-diagnostics/tools.md`).
   */
  columns?: readonly string[];
}

/**
 * The SELECT allowlist. EMPTY in AID-5 — the substrate's readiness probe reads no
 * relation at all — and extended by each tool pack, in the same pull request as
 * the tool that needs it, NEVER as a blanket `ALL TABLES IN SCHEMA` grant.
 * Secret-bearing relations (credentials, tokens, password/2FA, sessions) and raw
 * provider-payload stores are permanently out of scope (ADR-007 §1).
 *
 * AID-6A (#2375) adds exactly ONE relation, by COLUMN:
 *
 *  - `AuditLog`, for the five audit-correlation tools
 *    (`diagnostics.{system,booking,membership,finance,lodge}_event_correlation`).
 *    The eight columns granted are the ones those tools project: the row's own id
 *    (the evidence reference, and the tiebreaker that makes the ordering total),
 *    the stable `action`, `category`, `severity` and `outcome` codes, `entityType`
 *    (WHAT kind of record, never WHICH one), `requestId` (the correlation key), and
 *    `createdAt`.
 *
 *    Everything else on that table is deliberately absent, and each omission is a
 *    thing this credential must not be able to read: `ipAddress` and `userAgent`
 *    (network and device identifiers), `memberId`, `actorMemberId`,
 *    `subjectMemberId` and `targetId` (people), `entityId` (often a member id —
 *    per-record evidence is AID-6B/#2376 and AID-6C/#2377 work under their own area
 *    permission and privacy review), `summary` and `details` (free text), `metadata`
 *    (arbitrary JSON), and the retention bookkeeping columns, which are of no
 *    diagnostic use.
 *
 * AID-6A's other four tools — readiness, deployment evidence, budget/usage health
 * and background-job health — need NO grant: they read fixed first-party
 * calculations the application already owns (`packs/support-evidence.ts`), which is
 * also the only way readiness can report on the diagnostics credential itself.
 *
 * AID-6C (#2377) adds TWELVE relations, all BY COLUMN, and one column to
 * `AuditLog`. Every one of them is argued in
 * `docs/ai-diagnostics/tool-pack-finance.md` with the exact tool that needs it and
 * the exact fields it projects; the short version, and the four classes of column
 * that are deliberately absent from ALL of them, are below.
 *
 * WHAT IS NEVER GRANTED, and therefore refused by PostgreSQL itself (42501) rather
 * than merely unprojected:
 *
 *  - RAW PROVIDER PAYLOADS: `XeroInboundEvent."payload"` (the only raw webhook body
 *    in this schema), `XeroSyncOperation."requestPayload"`/`"responsePayload"`.
 *  - RAW ERROR TEXT: `PaymentRecoveryOperation."lastError"`,
 *    `XeroSyncOperation."lastErrorMessage"`, `XeroInboundEvent."errorMessage"`,
 *    `WebhookLog."error"`.
 *  - FREE TEXT: `Payment."manualPaymentNote"`, `PaymentTransaction."reason"`,
 *    `PaymentRefund."reason"`, `ManualRefundTask."reason"`/`"note"`,
 *    `RefundRequest."reason"`/`"adminNotes"`,
 *    `XeroSyncOperation."manuallyResolvedReason"`, `XeroObjectLink."metadata"`.
 *  - PEOPLE AND INSTRUMENTS: every `*MemberId`/`*ById` column on these relations,
 *    `RefundRequest."memberId"`, `Payment."stripeCustomerId"`,
 *    `"stripePaymentMethodId"`, `"stripeSetupIntentId"`,
 *    `PaymentTransaction."paymentMethodId"`, and — on the two relations that carry
 *    them — every column of `Member` except the two named below.
 *
 * The credential-bearing relations stay permanently out of scope (ADR-007 §1) and
 * are named here so a future reader can see they were considered:
 * `IntegrationCredential` (encrypted provider secrets) and `XeroToken` (PLAINTEXT
 * OAuth access and refresh tokens) are not granted, not readable, and not
 * grantable by any tool pack.
 *
 * The twelve, and the tool that argues for each:
 *
 *  - `Payment` — the pack's spine. Searched by `finance_payment_search` and
 *    `finance_payment_amount_search`, returned in full by
 *    `payment_diagnostic_summary`, and joined by `payment_refund_state`.
 *  - `PaymentTransaction` — charge attempts (`payment_attempt_ledger`), and the
 *    INDEXED internet-banking reference the reference search uses.
 *  - `PaymentRefund` — refunds Stripe actually made (`payment_refund_state`), and
 *    the Stripe charge/refund ids the reference search accepts.
 *  - `PaymentRecoveryOperation` — the platform's own queued refund/cancel debt
 *    (`payment_attempt_ledger`, `payment_refund_state`). `"idempotencyKey"` is
 *    granted so the STATEMENT can classify the refund scenario from its prefix;
 *    the key itself is never projected.
 *  - `ManualRefundTask`, `RefundRequest` — the two non-Stripe refund records
 *    (`payment_refund_state`).
 *  - `ProcessedWebhookEvent`, `WebhookLog`, `XeroInboundEvent` — webhook receipt,
 *    delivery and Xero inbound evidence (`finance_webhook_timeline`).
 *  - `XeroObjectLink`, `XeroSyncOperation` — Xero linkage and sync state
 *    (`xero_invoice_linkage`, `xero_contact_linkage`).
 *  - `Member` — TWO columns, `"id"` and `"xeroContactId"`, and nothing else, for
 *    `xero_contact_linkage` (which requires `finance:view` AND `membership:view`).
 *    As the diagnostics role, `SELECT "email" FROM "Member"` and `SELECT *` are
 *    both refused. This is the narrowest grant in the file and the one to scrutinise
 *    hardest on any future edit.
 *
 * AID-6B (#2376) adds THIRTEEN MORE relations, all BY COLUMN, and WIDENS `Member`.
 * The widening is the most scrutinised change this file has had, and the argument
 * for every column of it is on the `Member` entry itself below; the thirteen are
 * `Booking`, `Lodge`, `BookingGuest`, `MemberPartnerLink`, `BookingGuestNight`, `BedAllocation`,
 * `LodgeRoom`, `LodgeBed`, `BookingChangeRequest`,
 * `PolicyExceptionReservationNight`, `MemberSubscription`, `FamilyGroupMember` and
 * `FamilyGroup`, each argued on its own entry and in
 * `docs/ai-diagnostics/tool-pack-booking-membership.md`.
 *
 * THE FINDING FROM THAT PACK THAT EVERY FUTURE PACK SHOULD INHERIT: a PRESENCE
 * BOOLEAN IS NOT A CHEAPER GRANT. PostgreSQL's column privilege covers every
 * reference to a column, `notes IS NOT NULL` included, so a `hasNotes` flag costs
 * exactly the same grant as returning the note — and this file's whole claim is that
 * a withheld column is refused by the server (42501) rather than merely unprojected.
 * Six presence booleans over free text and raw JSON were dropped from AID-6B for
 * that reason rather than for any field-count one, and `MemberSubscription.`
 * `"manualPaymentNote"` was removed from this allowlist during review on the same
 * grounds. The one place the pattern IS used is where the classification it enables
 * exists nowhere else — `PaymentRecoveryOperation."idempotencyKey"`, and
 * `Payment."xeroInvoiceId"`-style presence tests over columns another pack already
 * projects under its own permission.
 *
 * And one column added to an existing entry: `AuditLog."entityId"`, for
 * `finance_record_audit_history`. AID-6A withheld it explicitly and recorded that
 * per-record evidence was AID-6B/6C work "under their own area permission and their
 * own privacy review". This is that review: `entityId` is used as a PREDICATE
 * against an id the caller already holds, is never projected, and the three
 * member-identifying columns beside it stay ungranted.
 *
 * AND SEVEN COLUMNS REMOVED FROM THE PRE-EXISTING FINANCE GRANTS, none of them
 * AID-6B's: `PaymentTransaction."xeroInvoiceId"`,
 * `PaymentRefund."paymentTransactionId"`, `PaymentRefund."stripePaymentIntentId"`,
 * `PaymentRecoveryOperation."bookingId"`, `ManualRefundTask."bookingId"`,
 * `XeroInboundEvent."source"` and `XeroSyncOperation."entityType"`. No statement in
 * any pack reads one of them under its own relation's alias, so each was reach
 * nobody argued for — and two of them stopped being harmless in this very release:
 * the two `"bookingId"` grants were opaque cuids while `Booking` was ungranted, and
 * AID-6B grants `Booking`, so leaving them would have handed this credential a join
 * from a refund task straight onto a booking's dates, prices and owner that no tool
 * performs. They survived two releases because the test that was supposed to catch
 * them never ran: `finance-pack.test.ts` built a correctly-keyed set of granted
 * columns and never passed it to an assertion. `provision-role.test.ts` now
 * reconciles this allowlist against every registered statement in BOTH directions,
 * with `alias -> relation` resolved per statement.
 */
export const SELECT_GRANTS: readonly AiDiagnosticsSelectGrant[] = [
  {
    schema: "public",
    relation: "AuditLog",
    columns: [
      "id",
      "action",
      "category",
      "severity",
      "outcome",
      "entityType",
      // AID-6C (#2377): the predicate for per-record finance audit history. Never
      // projected — the row's own `id` is the evidence reference.
      "entityId",
      "requestId",
      "createdAt",
    ],
  },
  {
    schema: "public",
    relation: "Payment",
    columns: [
      "id",
      "bookingId",
      "status",
      "source",
      "amountCents",
      "refundedAmountCents",
      "changeFeeCents",
      "additionalAmountCents",
      "creditAppliedCents",
      "additionalPaymentStatus",
      "reference",
      "stripePaymentIntentId",
      "additionalPaymentIntentId",
      "xeroInvoiceId",
      "xeroInvoiceNumber",
      "xeroRefundCreditNoteId",
      "internetBankingHoldSlots",
      "internetBankingHoldUntil",
      "internetBankingHoldReleasedAt",
      "manuallyMarkedPaidAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    schema: "public",
    relation: "PaymentTransaction",
    columns: [
      "id",
      "paymentId",
      "kind",
      "source",
      "status",
      "amountCents",
      "refundedAmountCents",
      "reference",
      "stripePaymentIntentId",
      "xeroInvoiceNumber",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    schema: "public",
    relation: "PaymentRefund",
    columns: [
      "id",
      "paymentId",
      "status",
      "amountCents",
      "currency",
      "stripeRefundId",
      "stripeChargeId",
      "xeroRefundCreditNoteId",
      "stripeCreatedAt",
      "createdAt",
    ],
  },
  {
    schema: "public",
    relation: "PaymentRecoveryOperation",
    columns: [
      "id",
      "type",
      "status",
      "paymentId",
      "amountCents",
      "attempts",
      // The scenario marker. Classified in SQL against a closed list of
      // server-written prefixes; the value itself never reaches a projected row.
      "idempotencyKey",
      "succeededAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    schema: "public",
    relation: "ManualRefundTask",
    columns: [
      "id",
      "paymentId",
      "amountCents",
      "status",
      "completedAt",
      "createdAt",
    ],
  },
  {
    schema: "public",
    relation: "RefundRequest",
    columns: [
      "id",
      "bookingId",
      "status",
      "requestedAmountCents",
      "approvedAmountCents",
      "reviewedAt",
      "createdAt",
    ],
  },
  {
    schema: "public",
    relation: "ProcessedWebhookEvent",
    // Its surrogate `"id"` is deliberately NOT granted. The lease row's identity is
    // `(source, eventId)` — a unique constraint — which is what the webhook timeline
    // projects as its entry reference, so the surrogate key adds nothing a diagnostic
    // needs and every column-granted relation in this allowlist stays strictly
    // narrower than its table.
    columns: [
      "eventId",
      "source",
      "eventType",
      "status",
      "processingStartedAt",
      "processedAt",
    ],
  },
  {
    schema: "public",
    relation: "WebhookLog",
    columns: ["id", "source", "eventType", "eventId", "status", "durationMs", "createdAt"],
  },
  {
    schema: "public",
    relation: "XeroInboundEvent",
    columns: [
      "id",
      "eventCategory",
      "eventType",
      "resourceId",
      "correlationKey",
      "status",
      "eventCreatedAt",
      "processedAt",
      "createdAt",
    ],
  },
  {
    schema: "public",
    relation: "XeroObjectLink",
    columns: [
      "id",
      "localModel",
      "localId",
      "xeroObjectType",
      "xeroObjectId",
      "xeroObjectNumber",
      "role",
      "active",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    schema: "public",
    relation: "XeroSyncOperation",
    columns: [
      "id",
      "direction",
      "operationType",
      "localModel",
      "localId",
      "status",
      "attemptCount",
      "replayable",
      "lastErrorCode",
      "xeroObjectType",
      "xeroObjectId",
      "xeroObjectNumber",
      "manuallyResolvedAt",
      "startedAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    schema: "public",
    relation: "Member",
    /**
     * AID-6B (#2376) WIDENS THIS FROM THE TWO COLUMNS AID-6C GRANTED, and this file's
     * own header calls it "the narrowest grant in the file and the one to scrutinise
     * hardest on any future edit". This is that edit, so here is the argument.
     *
     * #2376's owner decision authorises a member's NAME, EMAIL ADDRESS and CONTACT
     * DETAILS as evidence for an EXPLICITLY SELECTED record under `membership:view` —
     * the same permission that already governs Admin > Members, where the same
     * officer reads the same fields on a screen, in bulk, with a CSV export. What it
     * buys is a diagnostic that can name the member instead of quoting a cuid.
     *
     * FOUR SEARCH COLUMNS NEED AN EXPLICIT PROJECTION ACCOUNTING. Granting a
     * predicate column still makes it readable to the role, so each is named here:
     *  - `email` is the `member_search` email PREDICATE (an operator pastes in an
     *    address they already hold) and the erasure test's input. It IS projected,
     *    once, by `member_diagnostic_summary`, for one selected member.
     *  - `phoneCountryCode`, `phoneAreaCode` and `phoneNumber` are the
     *    `member_search` mobile PREDICATE and NOTHING ELSE. No entry in either pack
     *    returns a phone number: the summary reports only whether one is on file.
     *    A diagnostic never needs to read a number back to an operator who has the
     *    member's admin page one click away.
     *
     * WHAT STAYS REFUSED BY THE SERVER (42501), not by a projection's good
     * intentions, and each class for its own reason:
     *  - CREDENTIALS: `passwordHash`, `totpSecret`, `googleSub`. The password hash IS
     *    compared by `member_eligibility_state`'s erasure test — inside PostgreSQL,
     *    as a `count` on an equality against the server-written sentinel, on the
     *    APPLICATION connection, which is a `server_owned` read this grant does not
     *    govern. No SQL entry names it and this credential cannot read it.
     *  - SECURITY POSTURE: every `twoFactor*` column, `forcePasswordChange`,
     *    `passwordChangedAt`, `lastLoginAt`, `emailVerified`. `twoFactorEnabled` and
     *    `twoFactorLockedUntil` are INDEXED, so a leak there is also efficiently
     *    queryable — "list every administrator without two-factor" is the query this
     *    omission refuses.
     *  - THE BIRTH DATE: `dateOfBirth`. Age-based eligibility in this platform is
     *    decided on `ageTier` — `AgeTierSetting` keys the subscription rule on it,
     *    `BookingGuest` stores it, `participantQualifiesAsHost` reads it — so the
     *    tier is the authoritative fact and the date is not needed to report
     *    eligibility. `admin-family-group-member-search.ts` sets the same precedent,
     *    returning a calculated age label and never the date.
     *  - THE BODY AND THE ADDRESS: `gender`, `title`, `occupation`, every `street*`
     *    and `postal*` column, `photoImageId`/`photoUpdatedAt`/
     *    `photoUpdatedByMemberId`.
     *  - FREE TEXT: `comments` (`@db.Text`), `cancelledReason`, `archivedReason`.
     *  - AUTHORISATION STATE: `role`, `financeAccessLevel`, `postLoginLanding`.
     *  - PLUMBING WHOSE ABSENCE IS NOT A GAP: `inheritParentEmail`,
     *    `inheritEmailFromId`, `lodgeScreenPhoneOptIn`, `detailsConfirmedAt`,
     *    `detailsConfirmedByMemberId`, `onboardingConfirmedAt`,
     *    `profileCompletedAt`, `cancelledViaRequestId`,
     *    `archivedViaLifecycleActionRequestId`, `hutLeaderEligibleAt`,
     *    No other phone field.
     */
    columns: [
      "id",
      "email",
      "firstName",
      "lastName",
      "ageTier",
      "active",
      "canLogin",
      "cancelledAt",
      "archivedAt",
      "joinedDate",
      "lifeMemberDate",
      "requiresInduction",
      "hutLeaderEligible",
      "parentMemberId",
      "secondaryParentId",
      "familyGroupId",
      "billingFamilyGroupId",
      // Predicate-only: the `member_search` mobile arm. Never projected.
      "phoneAreaCode",
      "phoneNumber",
      "phoneCountryCode",
      "xeroContactId",
      "createdAt",
      "updatedAt",
    ],
  },
  // -------------------------------------------------------------------------
  // AID-6B (#2376): the booking and membership relations. See the file header
  // and `docs/ai-diagnostics/tool-pack-booking-membership.md` for the entry that
  // argues each one.
  // -------------------------------------------------------------------------
  {
    schema: "public",
    relation: "Booking",
    /**
     * The pack's booking spine: searched by `booking_search` and returned in full by
     * `booking_diagnostic_summary`.
     *
     * NO FREE TEXT AND NO ACTOR. `notes`, `adminReviewReason`, `adminReviewNotes`,
     * `memberReviewJustification`, `adultMemberHostingReviewReason` and
     * `deletedReason` are member or officer free text; `adultMemberHostingReview` is
     * a raw JSON policy snapshot; and every `*ById`/`*ByMemberId` column names a
     * person. None is granted.
     *
     * NOT EVEN FOR A PRESENCE BOOLEAN, which is the finding worth carrying forward
     * from this pack: PostgreSQL's column privilege covers EVERY reference to a
     * column, `notes IS NOT NULL` included. So a `hasNotes` flag cannot be had
     * without making every booking note in the club readable to anybody holding this
     * credential in a `psql` session — and a boolean is not worth trading that
     * property for. The six presence booleans #2376's plan asked for were dropped
     * for exactly this reason, not for a field-count one.
     */
    columns: [
      "id",
      "memberId",
      "lodgeId",
      "status",
      "checkIn",
      "checkOut",
      "totalPriceCents",
      "discountCents",
      "promoAdjustmentCents",
      "finalPriceCents",
      "creditElectionCents",
      "hasNonMembers",
      "nonMemberHoldUntil",
      "parentBookingId",
      "draftExpiresAt",
      "requiresAdminReview",
      "adminReviewStatus",
      "adultMemberHostingReviewStatus",
      "waitlistPosition",
      "wholeLodgeHold",
      "adminCapacityHoldAt",
      "capacityOverriddenAt",
      "deletedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    schema: "public",
    relation: "Lodge",
    // TWO columns, for the lodge NAME beside a booking. Everything else about a
    // lodge — its capacity numbers, its settings, its instructions, its door codes —
    // is lodge configuration this pack has no question for.
    columns: ["id", "name"],
  },
  {
    schema: "public",
    relation: "BookingGuest",
    /**
     * The party, for `booking_party_state`, plus the guest COUNT on
     * `booking_diagnostic_summary` and the GUEST leg of `member_booking_summary`.
     *
     * A GUEST'S NAME IS GRANTED, and it is booking evidence rather than membership
     * evidence: `bookings:view` already governs the admin booking page, which lists
     * exactly these names. All five consent discriminator columns are read and
     * NEVER projected; the canonical classifier folds them into one stable code.
     *
     * The responder id is compared only to the target id, and expiry only by
     * presence; neither raw value is projected. NOT GRANTED:
     * `rateMembershipTypeId` (a pricing snapshot, not evidence about the guest),
     * `arrivedAt`, `departedAt` and `createdAt`.
     *
     * Some columns were granted in an earlier revision and are not now; the
     * reason is worth recording because it is a property of this allowlist rather
     * than an oversight: `arrivedAt` here, `BedAllocation."source"` and
     * `LodgeBed."active"` on their own entries were dropped from the
     * projections when their entries' byte ceilings were measured against the real
     * serialiser — and a grant whose column no statement reads is reach nobody
     * reviewed. The pack's contract test asserts the allowlist in BOTH directions for
     * exactly this (`provision-role.test.ts`, "the SELECT-only grant allowlist
     * matches what the statements read"), so a projection trim that leaves its grant
     * behind fails.
     */
    columns: [
      "id",
      "bookingId",
      "firstName",
      "lastName",
      "ageTier",
      "isMember",
      "memberId",
      "stayStart",
      "stayEnd",
      "priceCents",
      "consentStatus",
      "consentRequestedAt",
      "consentRespondedAt",
      "consentRespondedByMemberId",
      "consentExpiresAt",
    ],
  },
  {
    schema: "public",
    relation: "MemberPartnerLink",
    // Predicate-only input to the canonical double-bed sharing classifier. The
    // pair ids and status are never projected; the tool emits one stable verdict.
    columns: ["memberAId", "memberBId", "status"],
  },
  {
    schema: "public",
    relation: "BookingGuestNight",
    // TWO columns, for `booking_party_state`'s per-night footprint. A guest may stay
    // NON-CONTIGUOUS nights inside one booking, so these rows — not the
    // `stayStart`/`stayEnd` envelope — are the authoritative presence, and the
    // envelope alone would invent nights the guest is not staying. The per-night
    // price is not granted: the booking's money is on the summary.
    columns: ["bookingGuestId", "stayDate"],
  },
  {
    schema: "public",
    relation: "BedAllocation",
    // `booking_bed_allocation_state`. `bedType` is the DENORMALISED copy the partial
    // unique index actually enforces on, and it is COMPARED against `LodgeBed`'s live
    // one so a divergence between the two is visible rather than hidden.
    // `approvedByMemberId` names the officer who placed the guest and is not granted;
    // `source`, `approvedAt`, `createdAt` and `updatedAt` are not read.
    columns: [
      "id",
      "bookingId",
      "bookingGuestId",
      "roomId",
      "bedId",
      "stayDate",
      "bedType",
      "isSecondOccupant",
    ],
  },
  {
    schema: "public",
    relation: "LodgeRoom",
    // TWO columns, for the room label on an allocation row. `notes` is officer free
    // text and is not granted.
    columns: ["id", "name"],
  },
  {
    schema: "public",
    relation: "LodgeBed",
    // The bed label and its live type — enough to say "Bunk 3, a DOUBLE" about an
    // allocation, and enough to compare the live type against the denormalised copy
    // on the allocation row. `bunkGroup` is a free label, `active` is not read, and
    // neither is granted.
    columns: ["id", "roomId", "name", "bedType"],
  },
  {
    schema: "public",
    relation: "BookingChangeRequest",
    /**
     * `booking_exception_request_state`: the locked-period and policy-exception
     * requests against one booking.
     *
     * NOT GRANTED, and this is the relation with the most free text in the pack:
     * `requestedChanges`, `proposalSnapshot` and `frozenEvidence` (raw JSON);
     * `reason`, `adminNotes`, `memberMessage` and `lastConflictReason` (member and
     * officer free text); `internalNotes`, which the schema marks NEVER
     * member-visible and which is therefore the single column on this relation it
     * would be worst to leak; `reviewedByMemberId` (names the officer who decided);
     * and `proposalHash`, `openStateKey` and `version` (machine tokens no operator
     * can act on).
     */
    columns: [
      "id",
      "bookingId",
      "kind",
      "status",
      "requestedByMemberId",
      "aggregateCapacityMode",
      "attemptCount",
      "conflictCount",
      "lastConflictAt",
      "holdExpiresAt",
      "reviewedAt",
      "cancelledAt",
      "supersededByRequestId",
      "linkedModificationId",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    schema: "public",
    relation: "PolicyExceptionReservationNight",
    /**
     * ONE column, and it is the narrowest grant in this pack. A row exists IFF the
     * request is CURRENTLY holding that night's beds — there is deliberately no
     * "active" flag — so counting these rows is the ONLY reliable test of whether an
     * open exception request is holding capacity. The schema warns in as many words
     * against inferring it from `holdExpiresAt IS NOT NULL`, because a row written
     * before that column existed can be holding beds with a NULL deadline.
     *
     * `night` and `beds` are NOT granted: the entry reports how many nights are held,
     * never which or how many beds. The lodge-wide picture is
     * `booking_capacity_by_night`'s job, and its figures already include these
     * reservations.
     */
    columns: ["changeRequestId"],
  },
  {
    schema: "public",
    relation: "MemberSubscription",
    // `member_subscription_state`. `xeroInvoiceId` is granted as a PRESENCE test only
    // — the id itself is finance evidence with a finance tool of its own.
    // `manualPaymentNote` is NOT granted: it is a `VarChar(500)` operator note, #2376
    // refuses operator free text, and a column privilege that exists only to power a
    // boolean still makes every note in the club readable. `manuallyMarkedPaidAt`
    // carries the diagnostically useful half. `xeroOnlineInvoiceUrl` and
    // `manuallyMarkedPaidByMemberId` are not granted either.
    columns: [
      "id",
      "memberId",
      "seasonYear",
      "status",
      "xeroInvoiceId",
      "xeroInvoiceNumber",
      "paidAt",
      "manuallyMarkedPaidAt",
      "voidGeneration",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    schema: "public",
    relation: "FamilyGroupMember",
    // `member_family_state`. These four named columns happen to be the whole current
    // relation, but this remains a COLUMN grant: the runtime explicitly refuses a
    // table-wide SELECT so a future schema column cannot become readable by drift.
    // The current relation has NO `role` column. One was physically dropped by migration
    // `20260803030000_contract_drop_family_group_member_role`, because family-group
    // membership carries no rank and every adult login co-member of a group is equal.
    // A diagnostic reporting a "role in the family group" would be reporting a field
    // that does not exist.
    columns: ["id", "familyGroupId", "memberId", "joinedAt"],
  },
  {
    schema: "public",
    relation: "FamilyGroup",
    // TWO columns, for the group's name beside a co-member. The name is
    // member-supplied text and is stripped and bounded on the way out. Nothing on
    // `FamilyGroupJoinRequest` is granted at all: it carries requester free text and
    // children's dates of birth.
    columns: ["id", "name"],
  },
];

export interface AiDiagnosticsRoleProvisionInput {
  /** The dedicated role to create/repair. Lowercase identifier. */
  roleName: string;
  /** The role's password. Quoted as a SQL literal; never logged. */
  password: string;
  /** The database the role may CONNECT to. */
  databaseName: string;
  /**
   * Roles that must keep `TEMPORARY` on the database after it is revoked from
   * PUBLIC — the app/owner role and whoever runs migrations. A SUPERUSER does
   * not need listing (it bypasses checks) but listing it is harmless.
   */
  preserveTempForRoles: readonly string[];
  /** Statement timeout baked into the role itself, as a second line of defence. */
  statementTimeoutMs: number;
  /** `CONNECTION LIMIT` for the role, bounding the blast radius of a leak. */
  connectionLimit: number;
  /**
   * TEST SEAM ONLY — defaults to the shipped `SELECT_GRANTS`, which is what the
   * operator CLI and CI both use.
   *
   * It exists because the shipped allowlist is EMPTY in AID-5, and the property
   * that matters most about this builder — that a re-provision revokes everything
   * BEFORE it grants the allowlist back — is untestable against an empty list. Left
   * untestable, the first tool pack to add a grant would be the first thing to
   * discover a reversed order, by silently stripping the grant it just added. This
   * is a pure string builder with no runtime authority: the privileges a role
   * actually holds are re-verified against the server on every tool call, so an
   * override here cannot widen anything.
   */
  selectGrants?: readonly AiDiagnosticsSelectGrant[];
}

/**
 * A PostgreSQL identifier we are willing to interpolate. Mixed case is allowed
 * because this schema's relations are PascalCase (`"IntegrationCredential"`) and
 * every identifier here is emitted double-quoted, so case is preserved exactly.
 *
 * `$` is deliberately EXCLUDED even though PostgreSQL permits it in an identifier.
 * Role and relation names also travel through `quoteLiteral` into the body of a
 * dollar-quoted `DO $$ ... $$` block below, so a name containing `$$` would
 * terminate that body early and the whole provisioning run would fail on a syntax
 * error. Nothing in this schema needs `$`, and refusing it here is cheaper than
 * carrying a tagged-quote scheme for a character no deployment wants.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * The plain-English description of what that pattern accepts, so the operator CLI
 * and the deployment guide say the same thing this file enforces.
 */
export const SUPPORTED_IDENTIFIER_DESCRIPTION =
  "letters, digits and underscores only, starting with a letter or underscore, at most 63 characters (no '-', '.', '@' or '$')";

/**
 * True when this builder will accept `value` as a role or relation name.
 *
 * Exported so the operator CLI can refuse a bad name with its own actionable
 * message, naming the environment variable that carried it, instead of letting a
 * thrown `Error` reach the operator as a ten-frame Node stack trace. The
 * restriction is real and documented: a managed-provider role name like `tac-app`
 * or `user@server` is legal in PostgreSQL when quoted, and this builder refuses it
 * rather than carrying a tagged-quote scheme for the dollar-quoted `DO $$ … $$`
 * blocks below.
 */
export function isSupportedProvisionIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

/**
 * Quote a validated identifier. The strict pattern above is the real control —
 * quoting is the belt. Anything outside the pattern throws rather than being
 * escaped, because a diagnostics role called `"; DROP …` is a configuration
 * mistake to refuse, not a string to sanitise.
 */
export function quoteIdentifier(value: string): string {
  if (!isSupportedProvisionIdentifier(value)) {
    throw new Error(
      `Refusing to build provisioning SQL for identifier ${JSON.stringify(value)}: use ${SUPPORTED_IDENTIFIER_DESCRIPTION}.`,
    );
  }
  return `"${value}"`;
}

/**
 * Quote a SQL string literal by doubling single quotes. Safe under
 * `standard_conforming_strings = on` (PostgreSQL's default since 9.1), which is
 * why backslashes need no special handling. Control characters and NULs are
 * REFUSED rather than escaped: a password containing one is almost certainly a
 * copy-paste accident, and refusing is the safer failure.
 */
export function quoteLiteral(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        "Refusing to build provisioning SQL for a value containing control characters.",
      );
    }
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The ordered, idempotent statement list that provisions the role. Every
 * statement is safe to re-run, and the ORDER is load-bearing: create/repair the
 * role, strip everything, then grant back only the (currently empty) allowlist.
 * Running the list is what makes the role's shape a database fact rather than an
 * operator's good intentions.
 */
export function buildAiDiagnosticsRoleSql(
  input: AiDiagnosticsRoleProvisionInput,
): string[] {
  const role = quoteIdentifier(input.roleName);
  const database = quoteIdentifier(input.databaseName);
  const roleLiteral = quoteLiteral(input.roleName);
  const passwordLiteral = quoteLiteral(input.password);

  if (!Number.isInteger(input.statementTimeoutMs) || input.statementTimeoutMs <= 0) {
    throw new Error("statementTimeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(input.connectionLimit) || input.connectionLimit <= 0) {
    throw new Error("connectionLimit must be a positive integer.");
  }

  const statements: string[] = [
    // 1. Create the role if it is absent. `DO` rather than `CREATE ROLE IF NOT
    //    EXISTS` because PostgreSQL has no such form, and a plain CREATE would
    //    make re-provisioning (the password-rotation path) fail.
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${roleLiteral}) THEN
    EXECUTE format('CREATE ROLE %I LOGIN', ${roleLiteral});
  END IF;
END
$$;`,

    // 2. Pin every role ATTRIBUTE, whether the role was just created or already
    //    existed with drifted attributes. This is the line that makes
    //    "non-superuser" a fact: NOSUPERUSER, no DDL-adjacent attribute, no
    //    replication, and NOBYPASSRLS so row-level security still applies.
    //    NOINHERIT means a future accidental role grant does not silently take
    //    effect. The password is (re)set here, which is the rotation path.
    `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${input.connectionLimit} PASSWORD ${passwordLiteral};`,

    // 3. Server-side defaults, so the restrictions hold even for a connection
    //    that forgets to open a READ ONLY transaction (a psql session an
    //    operator opens with this credential, for instance). The application
    //    ALSO sets all of these per transaction — see `database.ts`.
    `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
    `ALTER ROLE ${role} SET statement_timeout = ${quoteLiteral(`${input.statementTimeoutMs}ms`)};`,
    `ALTER ROLE ${role} SET lock_timeout = ${quoteLiteral(`${input.statementTimeoutMs}ms`)};`,
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = ${quoteLiteral(`${input.statementTimeoutMs * 2}ms`)};`,
    `ALTER ROLE ${role} SET search_path = 'public';`,
  ];

  // 4. Strip any membership in a predefined role that would bypass the
  //    allowlist or the read-only contract.
  //
  //    REVOKE IS SCOPED TO THE GRANTOR, which is the whole reason this is written as
  //    a loop over `pg_auth_members` rather than as a bare
  //    `REVOKE pg_monitor FROM <role>`. A membership is recorded per grantor, and
  //    `REVOKE ... FROM ...` without `GRANTED BY` revokes only the CURRENT role's own
  //    grant — even for a superuser. Measured on postgres:16.14: a membership granted
  //    by a separate deployer role survived a superuser's bare REVOKE, which reported
  //    `REVOKE ROLE` and emitted nothing but
  //    `WARNING: role "…" has not been granted membership in role "…" by role
  //    "postgres"`, while `pg_has_role(…, 'MEMBER')` stayed true. Adding
  //    `GRANTED BY <grantor>` revoked it (measured: the row went, and the predicate
  //    went false).
  //
  //    Looping over the rows also removes the need for the old existence guard: the
  //    set of predefined roles grows with the server version (`pg_maintain` is
  //    PostgreSQL 17+), and a role that does not exist on this server simply
  //    contributes no rows.
  //
  //    And it stops the noise that would have buried the signal. The bare form warned
  //    once per predefined role on EVERY provision, whether or not anything was
  //    granted — measured, seven WARNINGs on a clean run against postgres:16 — so the
  //    one warning that mattered arrived in a crowd. Driven by recorded rows, a clean
  //    run is silent, which is what makes the operator CLI's notice output worth
  //    reading.
  for (const predefined of FORBIDDEN_PREDEFINED_ROLES) {
    statements.push(`DO $$
DECLARE
  grantor_name text;
BEGIN
  FOR grantor_name IN
    SELECT grantor.rolname
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor
    WHERE granted.rolname = ${quoteLiteral(predefined)}
      AND member.rolname = ${roleLiteral}
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', ${quoteLiteral(predefined)}, ${roleLiteral}, grantor_name);
  END LOOP;
END
$$;`);
  }

  // 5. Strip membership in EVERY role, not only the eight named above. This is
  //    the membership control; step 4 is documentation with a revoke attached.
  //
  //    A diagnostics role that is a member of anything is one `SET ROLE` away from
  //    that role's privileges, and because this role is NOINHERIT the membership is
  //    invisible to every ordinary privilege check — measured on postgres:16.14,
  //    `GRANT "tac_app" TO "ai_diagnostics_ro"` left `rolsuper`,
  //    `has_table_privilege`, `has_function_privilege` and
  //    `pg_has_role(…, 'USAGE')` all reporting nothing, while `SET ROLE "tac_app"`
  //    read `IntegrationCredential` and inserted a `Booking`. So provisioning
  //    revokes the lot rather than enumerating the ways an operator might have
  //    granted one.
  //
  //    Revoking the DIRECT grants is sufficient and complete: `SET ROLE`
  //    reachability is transitive, but every chain starts at a direct edge from this
  //    role, so removing all of those removes the closure.
  //
  //    ONE ROW PER GRANTOR, AND `GRANTED BY` ON EVERY REVOKE. `pg_auth_members` holds
  //    a row per (granted role, member, grantor), and a REVOKE without `GRANTED BY`
  //    touches only the current role's own grant — so the earlier `SELECT DISTINCT`
  //    over role names alone was the bug, not an optimisation: it discarded exactly
  //    the column the REVOKE needs. It is not idempotent-and-therefore-harmless
  //    either. Measured on postgres:16.14, a membership granted by a deployer role
  //    survived a superuser's bare REVOKE with only a WARNING, the DO block committed,
  //    and the role stayed one `SET ROLE` from the app role's privileges while
  //    readiness reported `over_privileged` forever and this repair path claimed
  //    success.
  //
  //    THEN RE-CHECK AND RAISE. A warning is not a failure in PostgreSQL, and this
  //    statement list runs in one transaction whose only reason to exist is that a
  //    partial run must not commit. So the block re-reads `pg_auth_members` after the
  //    loop and raises if anything survived, which turns silent survival into the
  //    rollback the operator guide already promises. It also covers the credential
  //    case: a provisioner that may not revoke another role's grant fails loudly
  //    instead (measured: `permission denied to revoke privileges granted by role
  //    "…"`, `DETAIL: Only roles with privileges of role "…" may revoke privileges
  //    granted by this role`).
  //
  //    The re-check reads `pg_auth_members` and NOT `pg_has_role`, deliberately.
  //    `pg_database_owner` confers an implicit membership on whoever owns the current
  //    database, with no row in `pg_auth_members` and nothing to revoke — so a
  //    `pg_has_role` re-check would make provisioning impossible for a deployment
  //    whose diagnostics role owns its database, rather than merely refused at
  //    runtime. That case is documented in `deployment.md` as the one refusal
  //    re-provisioning cannot repair; the remedy is not to make the diagnostics role a
  //    database owner.
  statements.push(`DO $$
DECLARE
  membership record;
  surviving text;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, grantor.rolname AS grantor
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor
    WHERE member.rolname = ${roleLiteral}
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', membership.granted_role, ${roleLiteral}, membership.grantor);
  END LOOP;

  SELECT string_agg(DISTINCT granted.rolname, ', ')
    INTO surviving
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    WHERE member.rolname = ${roleLiteral};

  IF surviving IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to provision %: it is still a member of % after revoking every recorded membership. Revoke it with the grantor that granted it, then re-run.', ${roleLiteral}, surviving;
  END IF;
END
$$;`);

  // 6. Database-level privileges: CONNECT only. TEMP has to be revoked from
  //    PUBLIC to be denied to this role at all (see PUBLIC_TEMP_REVOKE_NOTE),
  //    and is granted straight back to the roles that legitimately need it.
  statements.push(
    `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${role};`,
    `REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC;`,
  );
  for (const preserved of input.preserveTempForRoles) {
    statements.push(
      `GRANT TEMPORARY ON DATABASE ${database} TO ${quoteIdentifier(preserved)};`,
    );
  }
  statements.push(`GRANT CONNECT ON DATABASE ${database} TO ${role};`);

  // 7. Schema-level: USAGE (needed to name a relation at all), never CREATE.
  statements.push(
    `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};`,
    `GRANT USAGE ON SCHEMA public TO ${role};`,
  );

  // 8. Object-level: revoke EVERYTHING, then grant back the allowlist. The
  //    revokes run on every provision so a hand-added grant cannot outlive the
  //    file that is supposed to declare it, and the default-privilege revoke
  //    stops a future table inheriting a grant automatically.
  //
  //    The ROUTINES revoke is not the control it looks like, and the docs say so:
  //    PostgreSQL grants EXECUTE on every new function to PUBLIC by default, and a
  //    PUBLIC grant cannot be revoked for one role. Revoking role-specific
  //    privileges (of which there are normally none) therefore leaves the role with
  //    EXECUTE on every function in schema `public` — measured on the migrated
  //    schema: 233 routines, all executable by the freshly provisioned role, before
  //    and after this statement. It is kept because it does strip a hand-added
  //    role-specific grant; what actually contains the residue is the READ ONLY
  //    transaction plus the runtime self-check, which counts the
  //    `SECURITY DEFINER` routines the role may execute and refuses on any (a
  //    `SECURITY DEFINER` function runs as its owner, so it is the one shape that
  //    could write). Revoking EXECUTE from PUBLIC is deliberately NOT done: it is
  //    database-wide collateral that would break the application's own functions,
  //    the same reasoning as `CREATE ON SCHEMA public` above.
  statements.push(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role};`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role};`,
    `REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM ${role};`,
  );
  // The table revoke above also clears COLUMN privileges — PostgreSQL's REVOKE
  // reference states it explicitly ("when revoking privileges on a table, the
  // corresponding column privileges (if any) are automatically revoked on each
  // column of the table, as well"), and the real-PostgreSQL proof asserts it by
  // hand-granting an extra column and re-provisioning. That is what lets an
  // allowlist entry be NARROWED in a later release rather than only widened.
  for (const grant of input.selectGrants ?? SELECT_GRANTS) {
    const target = `${quoteIdentifier(grant.schema)}.${quoteIdentifier(grant.relation)}`;
    if (grant.columns === undefined) {
      statements.push(`GRANT SELECT ON ${target} TO ${role};`);
      continue;
    }
    // A COLUMN grant, and the empty list is a REFUSAL rather than a silent
    // widening: `GRANT SELECT () ON …` is not valid SQL, and quietly emitting the
    // whole-relation form for `columns: []` would turn a mistake in the allowlist
    // into exactly the blanket grant that allowlist exists to prevent.
    if (grant.columns.length === 0) {
      throw new Error(
        `Refusing to build provisioning SQL for ${grant.schema}.${grant.relation}: a column allowlist must name at least one column, or be omitted for a whole-relation grant.`,
      );
    }
    const columns = grant.columns.map(quoteIdentifier).join(", ");
    statements.push(`GRANT SELECT (${columns}) ON ${target} TO ${role};`);
  }

  return statements;
}

/** Default role name. Deployments may override; the shape is what matters. */
export const DEFAULT_AI_DIAGNOSTICS_ROLE_NAME = "ai_diagnostics_ro";
