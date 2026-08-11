/**
 * AI Diagnostics — AID-6B booking/membership pack, part 2: PER-BOOKING STORED
 * EVIDENCE (#2376, epic #2369).
 *
 * SIX ENTRIES, each taking the EXACT booking id that `booking-search.ts` had to
 * produce first. There is no listing tool here, no window that returns "recent
 * bookings", and no argument that widens a predicate — so this half of the pack
 * has no shape that could be walked to extract a guest register.
 *
 *   diagnostics.booking_diagnostic_summary          bookings
 *   diagnostics.booking_linked_state                bookings
 *   diagnostics.booking_party_state                 bookings
 *   diagnostics.booking_bed_allocation_state        bookings + membership
 *   diagnostics.booking_exception_request_state     bookings
 *   diagnostics.booking_record_audit_history        bookings
 *
 * PERMISSION. Five entries need `bookings:view` only. Bed-allocation state needs
 * BOTH `bookings:view` and `membership:view`: its double-bed verdict reads the
 * live membership eligibility and partner link of both occupants, and the other
 * occupant may belong to another booking. No entry needs `support:view`.
 * `requiredAreas` is fixed on the entry and `invoke.ts` authorizes BEFORE it
 * parses arguments, so a denied membership source is never queried or inferred.
 *
 * A GUEST NAME IS RETURNED, AND THAT IS THE ONE REAL WIDENING IN THIS MODULE.
 * `booking_party_state` projects each guest's given and family name, which #2376
 * lists as approved evidence for an explicitly selected booking — the party of
 * one booking an officer already has open, which is what the admin booking page
 * shows the same officer. Every name goes out through `personNameOrNull`
 * (control characters removed, quotes/`;`/`=` stripped, 60 characters, marked
 * when clipped), and the four entries that project a person's identifier declare
 * `surfacesPersonalData`.
 *
 * ADR-004's PER-INVOCATION OPT-IN IS DECLARED HERE, NOT IMPLEMENTED. Setting
 * `surfacesPersonalData: true` records that a row can identify a person; the
 * substrate does not yet gate such an entry behind an operator's per-invocation
 * consent. That gate is a prerequisite recorded on #2378 and it must NOT be
 * leaned on as a control while reading this module: today the only controls that
 * actually run are the fixed `bookings:view` requirement, the exact-id argument
 * shape, the column allowlist, the column GRANT, and the audit row.
 *
 * ------------------------------------------------------------------------------
 * THE COLUMN GRANT — the exhaustive list, relation by relation
 * ------------------------------------------------------------------------------
 *
 * An UNGRANTED column is a `42501` at runtime that passes every mock, so this
 * list is the contract between this module and `SELECT_GRANTS`. "(predicate)"
 * means the column is only ever compared, never projected.
 *
 * `public."Booking"` — booking_diagnostic_summary ONLY (entries 2-5 key off
 * their own relation's `bookingId` and read no `Booking` column at all):
 *   id (predicate + bookingRef + bookingReference), memberId, lodgeId, status,
 *   checkIn, checkOut, totalPriceCents, discountCents, promoAdjustmentCents,
 *   finalPriceCents, creditElectionCents, hasNonMembers, nonMemberHoldUntil,
 *   parentBookingId, draftExpiresAt, adminReviewStatus,
 *   adultMemberHostingReviewStatus, wholeLodgeHold, deletedAt, createdAt,
 *   updatedAt.
 *  NOT READ, NOT GRANTED, and each for its own reason: `notes`,
 *  `adminReviewReason`, `adminReviewNotes`, `memberReviewJustification`,
 *  `adultMemberHostingReviewReason` and `deletedReason` are member or officer
 *  FREE TEXT; `adultMemberHostingReview` is a raw Json snapshot;
 *  `createdById`, `deletedById`, `adminReviewedById`,
 *  `adultMemberHostingReviewedById`, `adminCapacityHoldByMemberId`,
 *  `capacityOverriddenByMemberId`, `wholeLodgeHoldByMemberId` and
 *  `noEmailsByMemberId` NAME PEOPLE. See "the presence-boolean trap" below for
 *  why no `hasNotes`-style boolean is projected either.
 *
 * `public."BookingGuest"`:
 *   bookingId (predicate — booking_party_state and the guest count on
 *     booking_diagnostic_summary),
 *   id, firstName, lastName, ageTier, isMember, memberId, stayStart, stayEnd,
 *   priceCents, consentStatus, consentRequestedAt, consentRespondedAt,
 *   consentRespondedByMemberId, consentExpiresAt
 *   — all booking_party_state.
 *  All five consent discriminator columns are READ BUT NEVER PROJECTED: the
 *  canonical `classifyMemberGuestConsent` helper folds them into the one
 *  `consentSubState` code; status alone also feeds the platform's canonical
 *  `operationallyPresent` predicate.
 *  NOT READ, NOT GRANTED: `rateMembershipTypeId` (a pricing snapshot that is not
 *  evidence about the guest), `arrivedAt`, `departedAt` and `createdAt` (dropped
 *  for the byte ceiling, see below). The responder id is compared only to the
 *  target id and never emitted; expiry is used only as a presence fact.
 *
 * `public."BookingGuestNight"` — booking_party_state:
 *   bookingGuestId (predicate), stayDate.
 *  NOT READ, NOT GRANTED: `id`, `priceCents`, `createdAt`. The per-night price
 *  is not needed to answer any question this entry is for, and the booking's own
 *  money is on the summary.
 *
 * `public."BedAllocation"` — booking_bed_allocation_state:
 *   bookingId (predicate), id (ORDER BY tiebreak only), bookingGuestId, roomId
 *   (predicate — the composite bed join), bedId (predicate), stayDate, bedType,
 *   isSecondOccupant.
 *  NOT READ, NOT GRANTED: `approvedByMemberId` (names the officer who approved
 *  the placement), `source`, `approvedAt` and `createdAt` (dropped for the byte
 *  ceiling), `updatedAt`.
 *
 * `public."LodgeRoom"` — booking_bed_allocation_state:
 *   id (predicate), name.
 *  NOT READ, NOT GRANTED: `notes` (officer free text), `sortOrder`, `active`,
 *  `lodgeId`, `createdAt`, `updatedAt`.
 *
 * `public."LodgeBed"` — booking_bed_allocation_state:
 *   id (predicate), roomId (predicate), name, bedType (compared, never
 *   projected — the projected type is the allocation's own copy).
 *  NOT READ, NOT GRANTED: `sortOrder`, `active` and `bunkGroup` (dropped for the
 *  byte ceiling), `createdAt`, `updatedAt`.
 *
 * `public."BookingChangeRequest"` — booking_exception_request_state:
 *   bookingId (predicate), id, kind, status, requestedByMemberId,
 *   aggregateCapacityMode, attemptCount, conflictCount, lastConflictAt,
 *   holdExpiresAt, reviewedAt, cancelledAt,
 *   supersededByRequestId, linkedModificationId, createdAt, updatedAt.
 *  NOT READ, NOT GRANTED: `reviewedByMemberId` — it names the OFFICER who
 *  decided, and AID-6C's grant policy refuses every actor id on every relation it
 *  reads for exactly that reason; `reviewedAt` already carries the fact that a
 *  decision was made, which is the half an operator can act on, and the officer
 *  queue shows who. Also `requestedChanges`, `proposalSnapshot` and
 *  `frozenEvidence` (raw Json); `reason`, `adminNotes`, `internalNotes`,
 *  `memberMessage` and `lastConflictReason` (member and officer free text —
 *  `internalNotes` is the column the schema marks NEVER member-visible);
 *  `proposalHash`, `openStateKey` and `version` (machine tokens no operator can
 *  act on).
 *
 * `public."PolicyExceptionReservationNight"` — booking_exception_request_state:
 *   changeRequestId (predicate; also what makes the `count(*)` legal).
 *  NOT READ, NOT GRANTED: `id`, `lodgeId`, `night`, `beds`, `createdAt`. The
 *  entry reports HOW MANY nights are held, never which or how many beds — the
 *  lodge-wide picture is the capacity entry's job, under the same permission.
 *
 * `public."AuditLog"` — booking_record_audit_history:
 *   entityType (predicate + projected), entityId (predicate), category
 *   (predicate + projected), id, action, severity, outcome, createdAt.
 *  NOT READ, NOT GRANTED: `memberId`, `actorMemberId`, `subjectMemberId`,
 *  `targetId` (all name people), `summary`, `details` (free text), `metadata`
 *  (arbitrary Json), `ipAddress`, `userAgent`, `retentionClass`, `expiresAt`,
 *  `archivedAt`, `incidentPreserved`.
 *  NOT READ, BUT GRANTED — one column, named separately because it is the single
 *  place on this relation where those two answers differ, and because an earlier
 *  revision of this paragraph listed it above and then contradicted itself in its
 *  own closing sentence: `requestId`. AID-6A granted it for the five correlation
 *  entries, which project it as their correlation key; these two record-audit
 *  entries simply do not read it. Two consequences a reader must not get wrong.
 *  A future entry here could project it with NO grant review and without tripping
 *  `undeclaredReadableColumns` — the grant already exists. And `tools/render.ts`
 *  identifies `requestId` as verbatim client header text, i.e. attacker-chosen
 *  free text, which is why the substrate had to add value quoting at all. Anyone
 *  tightening this allowlist must treat it as reach the role already has.
 *  So the AuditLog grant is NINE columns — AID-6A's eight plus `entityId`, which
 *  AID-6C added for the same purpose — and these two entries read eight of them.
 *  `membership-records.ts` states the same accounting for its own audit entry.
 *
 * THE PRESENCE-BOOLEAN TRAP, and it is the most important finding in this
 * module. `notes IS NOT NULL` needs the SELECT privilege on `notes`:
 * PostgreSQL's column privilege covers every reference to the column, not just a
 * projected one. So a `hasNotes` boolean cannot be had without granting the
 * SELECT-only role the ability to read every booking note in a `psql` session —
 * which would break the property this pack states plainly, that the withheld
 * columns "are not granted to the SELECT-only role at all, so PostgreSQL itself
 * refuses them (42501)". A boolean is not worth trading that for, so SIX
 * presence booleans that #2376's plan asked for are NOT projected here:
 * `hasNotes`, `hasAdminReviewNotes`, `hasMemberReviewJustification`,
 * `hasHostingReviewSnapshot` (entry 1), `hasLastConflictReason` and
 * `hasProposalSnapshot` (entry 4) — six names, and the count says six because an
 * earlier revision of this sentence said five while enumerating them all, in the
 * one place the rest of the tree redirects to. Every one of the six was dropped for
 * a GRANT reason and not for the 24-field cap: each needs SELECT on free text or
 * raw JSON (`Booking."notes"`, `"adminReviewNotes"`, `"memberReviewJustification"`,
 * `"adultMemberHostingReview"`, `BookingChangeRequest."lastConflictReason"`,
 * `"proposalSnapshot"`), so widening the cap recovers none of them.
 * Almost nothing is lost: `conflictCount > 0`
 * with `lastConflictAtUtc` already says a conflict happened, `requestKind =
 * POLICY_EXCEPTION` already implies a frozen proposal, and each entry's scope
 * line names the administration screen that shows the text itself.
 *
 * ------------------------------------------------------------------------------
 * THE 24-FIELD CAP, AND WHAT IT COST
 * ------------------------------------------------------------------------------
 *
 * `DIAGNOSTICS_TOOL_BOUNDS.maxFieldsPerRow` is 24 and it is ENFORCED, not
 * advisory: `projectRows` in `invoke.ts` throws `ProjectionContractError` on the
 * 25th field and the whole result is discarded as `redaction_failed`. `Booking`
 * carries 49 columns worth reporting. So the summary is a CHOSEN 24, and the
 * choice is written down here because a reader's first question will be why a
 * field they expected is absent.
 *
 * WHAT THE SUMMARY KEEPS, and the rule it was chosen by: a field is in if
 * leaving it out would let a model narrate something FALSE and ACTIONABLE about
 * a healthy booking.
 *   identity          bookingRef, bookingReference, ownerMemberRef, lodgeRef
 *   lifecycle         bookingStatus, deletedAtUtc, createdAtUtc, updatedAtUtc
 *   the nights        checkIn, checkOut, nightCount
 *   the party         guestCount, hasNonMembers, nonMemberHoldUntilUtc
 *   the money         totalPriceCents, discountCents, promoAdjustmentCents,
 *                     finalPriceCents, creditElectionCents
 *   the timers        draftExpiresAtUtc
 *   the links         parentBookingRef
 *   what blocks it    adminReviewStatus, hostingReviewStatus, wholeLodgeHold
 *
 * All five money columns stay TOGETHER on purpose. `total - discount - promo`
 * is what makes `final` explicable, and a model shown three of the four narrates
 * an unexplained gap as a defect. `wholeLodgeHold` stays because a booking with
 * sole occupancy changes every capacity answer for its nights, and a model that
 * cannot see it will confidently advise admitting somebody else.
 *
 * WHAT THE SUMMARY DROPPED, and where the evidence actually lives:
 *   lodgeName, waitlistPosition, requiresAdminReview, adminCapacityHoldAt,
 *   capacityOverriddenAt        → all on the `diagnostics.booking_search` row
 *                                 for the same booking (`kind: "booking_id"`),
 *                                 under the same `bookings:view` permission.
 *                                 Dropping `lodgeName` is also what makes the
 *                                 summary a PURE `Booking` read: no `Lodge`
 *                                 join, no `Lodge` grant, a smaller blast
 *                                 radius. It is the strongest reason of the set.
 *   waitlistOfferedAt, waitlistOfferExpiresAt, waitlistOfferedLodgeId,
 *   waitlistOfferedPriceCents   → dropped as a BLOCK, deliberately. A
 *                                 cross-lodge waitlist offer is an offer of a
 *                                 DIFFERENT lodge at a DIFFERENT price, so half
 *                                 the block ("the offer expires at X") would
 *                                 have a model describing an offer for the
 *                                 booking's own lodge. Half of this is worse
 *                                 than none of it; Admin > Waitlist is named in
 *                                 the scope line.
 *   expectedArrivalTime         → and the projection question is worth
 *                                 recording, because the obvious answer is
 *                                 wrong. It is a `VarChar(5)` like "18:30", and
 *                                 `stableCodeOrNull` would SENTINEL it:
 *                                 `PROJECTABLE_STABLE_CODE` is
 *                                 `/^[A-Za-z][A-Za-z0-9_.-]{0,47}$/`, which
 *                                 requires a leading LETTER. A colon is
 *                                 admitted but a leading digit is not. Had the
 *                                 field survived the cap it would have needed a
 *                                 local `/^\d{2}:\d{2}$/` validator returning
 *                                 the shared sentinel otherwise — never
 *                                 `stableCodeOrNull`, and never a bare
 *                                 pass-through, because the column is
 *                                 member-supplied and reaches the `key=value`
 *                                 evidence renderer.
 *   cancelIfGuestsBumped, organiserSettled, noEmails, preArrivalReminderSentAt,
 *   requestedRoomId, createdById → lowest-value flags and ids. Nothing else in
 *                                 the pack reads a requested room or an
 *                                 admin-creator, and the admin booking page
 *                                 shows all six.
 *   the six presence booleans   → see "the presence-boolean trap" above. Those
 *                                 are dropped for a GRANT reason, not a cap
 *                                 reason, and would stay dropped at any cap.
 *
 * A COMPOSED CODE LIST WAS CONSIDERED FOR THOSE FLAGS AND REJECTED, with the
 * measurement rather than a preference. `codeListOrNull` exists and AID-6A uses
 * one, so folding sixteen booleans into one comma-joined field was the obvious
 * way to buy the cap back. Measured: those sixteen codes join to 365 characters,
 * and `boundedScalar` in `invoke.ts` TRUNCATES a string over
 * `fieldValueMaxChars` (200) with an ellipsis rather than refusing it. A
 * truncated code list reads exactly like a complete one in which the missing
 * codes are not set — a silently FALSE and directly actionable claim about a
 * healthy booking, which is the failure this module is designed against. Every
 * shorter catalogue that carried the same facts came out between 187 and 209
 * characters, i.e. one added code away from the same defect. Named fields it is.
 *
 * ------------------------------------------------------------------------------
 * THE BYTE AND BLOCK CEILINGS, measured
 * ------------------------------------------------------------------------------
 *
 * Gate 9 REFUSES a result over the entry's `byteLimit`; it never trims one. The
 * multi-row entries here carry the pack's shared 16 384, and their row limits
 * are fixed in `booking-shared.ts`, so the only free variable is how WIDE a row
 * is — which is why two of these entries carry fewer fields than #2376's plan
 * asked for. THIS IS A MEASUREMENT, NOT AN ESTIMATE, and the measuring has to be
 * done with `canonicalStringify`, which PRETTY-PRINTS with a two-space indent:
 * every field costs its own line, so a field is worth about `key + value + 10`
 * bytes rather than `key + value`. An estimate that forgot the indentation came
 * out 30% low and would have shipped two entries whose full results gate 9
 * refuses outright.
 *
 *   entry                            fields  typical    widest  ceiling
 *   booking_diagnostic_summary        24 × 1    854 B         —   4 096
 *   booking_party_state               15 × 30  14.9 kB   18.0 kB  16 384
 *   booking_bed_allocation_state       8 × 60  wide result ceiling     24 576
 *   booking_exception_request_state    16 × 18  11.0 kB       —   16 384
 *   booking_record_audit_history        7 × 18   4.7 kB       —   16 384
 *
 * THE ALLOCATION ENTRY USES THE WIDE CEILING because its eighth field is the
 * canonical double-sharing verdict. Room and bed labels still go out through a
 * local 24-character validator instead of `personNameOrNull`'s 60; a real label
 * is "Bed 3". Gate 9 refuses rather than silently clipping an oversized result.
 *
 * THE PARTY ENTRY'S CEILING IS TYPICAL WITH A STATED BOUNDARY, because a name is
 * the evidence and capping a name the way a bed label is capped would be a worse
 * trade. Fifteen fields leave about 51 bytes a row spare, i.e. up to roughly
 * seventy characters of combined given-and-family name per guest across all
 * thirty. A party that exceeds that is REFUSED as `result_too_large` — an honest
 * refusal that names the booking page, never a silent clip — and this is why two
 * instants the plan asked for (the consent deadline and the arrival instant) are
 * not projected.
 *
 * THE RENDERED BLOCK IS A SEPARATE, SMALLER CEILING —
 * `renderedBlockMaxChars` is 8 000 — and three of these entries cannot list a
 * FULL result inside it. That is inherent to the row limits and it is handled
 * HONESTLY rather than hidden: `render.ts` drops whole rows from the tail and
 * relabels the header `rows (N of M listed — the rest did not fit this block, so
 * this listing is incomplete)`, and the evidence state becomes
 * `result_truncated`. No row is ever cut mid-field.
 *
 * Measured at typical widths, with each entry's own scope line in the block: the
 * summary lists its 1 row in 4 092 characters, the audit history lists all 18 in
 * 6 766, the allocation entry lists 23 of 60, the exception entry 7 of 18, and
 * the party entry 6 of 30. The party entry is the worst because its scope carries
 * the whole consent vocabulary, and that trade was made deliberately: a
 * `consentSubState` code the model cannot interpret is worse than three more rows
 * it can, and real parties are three to eight guests, so the clip is a
 * whole-lodge school-group phenomenon rather than the normal case. Each affected
 * scope line names the administration screen that shows the whole set.
 *
 * ------------------------------------------------------------------------------
 * TWO PLACES WHERE #2376's PLAN DISAGREED WITH THE SCHEMA
 * ------------------------------------------------------------------------------
 *
 *  1. MEMBER-GUEST CONSENT IS LIVE, NOT INERT. The plan for this module said the
 *     consent columns are inert because `MEMBER_GUEST_WIDENING_ENABLED === false`
 *     in `member-guest-consent.ts`, and that a NULL therefore always means "no
 *     consent was ever needed". THAT CONSTANT NO LONGER EXISTS. MG2 (#2307)
 *     landed: `member-guest-consent.ts` writes `consentStatus: "PENDING"` and
 *     `"CONFIRMED"` through `buildMemberGuestConsentWrite`,
 *     `member-guest-consent-service.ts` resolves them,
 *     `admin-bookings-service.ts` filters an officer queue on `PENDING`, and
 *     `cron-member-guest-consent-expiry.ts` sweeps the lapsed ones. Its own
 *     `member-guest-widening.test.ts` records that MG1's assertion of the
 *     constant "has done its job and is gone", and the widening is now a
 *     per-club module read that FAILS CLOSED per call site. The scope line
 *     therefore states the property that is actually true — NULL is the
 *     DOMINANT value forever and means "no consent was ever needed" — and never
 *     the stale claim that no row can carry a status. Writing the stale version
 *     would have been the exact failure mode this module is designed against:
 *     a confident, actionable falsehood about a healthy record. (The schema's
 *     own comment on `BookingGuest.consentStatus` is stale in the same way.)
 *
 *  2. FIVE CONSENT COLUMNS ARE FOLDED INTO TWO DERIVED FIELDS. The schema's
 *     `MEMBER_GUEST_CONSENT_SUB_STATES` table is the platform's own source of
 *     truth for which combination means what, so the projection calls its
 *     canonical classifier and emits one `consentSubState`
 *     code from a closed server-owned catalogue, interpolated into the scope line
 *     so the vocabulary actually reaches the model. Alongside it goes
 *     `operationallyPresent` — the platform's OWN predicate
 *     (`OPERATIONALLY_PRESENT_GUEST_WHERE`) evaluated server-side, so a model
 *     never has to build it and can never build it wrongly. Two fields instead
 *     of four, the eight documented shapes distinguishable from seven codes, and
 *     `consentRespondedByMemberId` is compared only to the target id and is never
 *     emitted; target and delegate approvals intentionally share one public code.
 *     The raw `consentStatus` is
 *     not projected alongside the code deliberately: the code NAMES the null case
 *     (`family_or_legacy`), so the dominant value a model is most likely to
 *     misread as "consent outstanding" is no longer a null it has to interpret.
 *
 * ------------------------------------------------------------------------------
 * PROPERTIES, STATED AS PROPERTIES OF THE CODE
 * ------------------------------------------------------------------------------
 *
 *  - EVERY ENTRY TAKES A REQUIRED EXACT BOOKING ID. `{}` does not parse for any
 *    of the five: the schema is `z.object({ bookingId: RECORD_ID }).strict()`
 *    with no optional member and no default.
 *  - NO PATTERN LANGUAGE ANYWHERE. Every predicate is `=` or `= ANY(...)`.
 *    There is no `LIKE`, no `ILIKE`, no `SIMILAR TO`, no regex operator and no
 *    wildcard character in any statement in this module, so nothing a caller can
 *    send has anything to mean beyond a literal.
 *  - ONE FIXED STATEMENT PER ENTRY, no semicolon, `public."Relation"` qualified,
 *    `pg_catalog.` functions, and `bind` returns EXACTLY the parameters the
 *    statement references. The executor appends the row cap as `$N+1` and
 *    refuses an arity mismatch before it opens a connection, because a short
 *    `bind` would silently alias the row cap onto a predicate.
 *  - TOTAL `ORDER BY` ON EVERY MULTI-ROW ENTRY, always ending in the row's own
 *    id, so identical evidence hashes identically for the audit trail.
 *  - NO JOIN CAN DROP A ROW. Every join to a lookup relation is a LEFT JOIN and
 *    the one aggregate join is a `CROSS JOIN LATERAL` over an ungrouped
 *    aggregate, which returns exactly one row for every left row. A booking's
 *    guest whose bed row had a broken foreign key would still be listed, with
 *    nulls, rather than vanishing from the answer — an omitted guest-night is
 *    the falsehood that matters here.
 *  - NULL, 0 AND ABSENT STAY DIFFERENT. `centsOrZero` is used only where the
 *    schema says `@default(0)`; `centsOrNull` everywhere else, so an amount that
 *    did not arrive as an integer is reported as unknown rather than as nothing
 *    owed. Two booleans that can be genuinely UNKNOWN — a guest with no
 *    per-night rows, and a bed row whose bed could not be read — go out through
 *    `nullableBoolOf` and stay null rather than collapsing to `false`.
 *
 * The pack doc is `docs/ai-diagnostics/tool-pack-booking-membership.md`.
 */

import "server-only";

import type {
  BookingChangeRequestKind,
  BookingChangeRequestStatus,
} from "@prisma/client";
import { z } from "zod";

import { auditCategoriesForCorrelationDomain } from "@/lib/audit-categories";
import { classifyDoubleBedSharingFacts } from "@/lib/double-bed-sharing";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";
import {
  AID6B_ALLOCATION_ROW_LIMIT,
  AID6B_BYTE_LIMIT,
  AID6B_DESCRIPTION_TAIL,
  AID6B_HISTORY_ROW_LIMIT,
  AID6B_PARTY_ROW_LIMIT,
  AID6B_SCOPE_TAIL,
  AID6B_SINGLE_ROW_BYTE_LIMIT,
  AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE,
  AID6B_WIDE_BYTE_LIMIT,
  aid6bRecordAuditReaderAreas,
  dateOnly,
  dateOnlyOrNull,
  nullableBoolOf,
  personNameOrNull,
} from "./booking-shared";
import {
  RECORD_ID,
  boolOf,
  centsOrNull,
  centsOrZero,
  countOf,
  instantOrNull,
  recordRefOrNull,
  stableCodeOrNull,
  utcInstant,
} from "./finance-shared";

export const DIAGNOSTICS_BOOKING_SUMMARY_TOOL_ID =
  "diagnostics.booking_diagnostic_summary";
export const DIAGNOSTICS_BOOKING_LINKED_STATE_TOOL_ID =
  "diagnostics.booking_linked_state";
export const DIAGNOSTICS_BOOKING_PARTY_TOOL_ID =
  "diagnostics.booking_party_state";
export const DIAGNOSTICS_BOOKING_BED_ALLOCATION_TOOL_ID =
  "diagnostics.booking_bed_allocation_state";
export const DIAGNOSTICS_BOOKING_EXCEPTION_REQUEST_TOOL_ID =
  "diagnostics.booking_exception_request_state";
export const DIAGNOSTICS_BOOKING_AUDIT_HISTORY_TOOL_ID =
  "diagnostics.booking_record_audit_history";

// ---------------------------------------------------------------------------
// 0. The one argument shape, and the two projection helpers this module owns.
// ---------------------------------------------------------------------------

/**
 * One booking id, and nothing else. The shape ALL FIVE entries take.
 *
 * `.strict()` so an unknown key is a rejection rather than something ignored,
 * and `RECORD_ID` is required with no default, so `{}` does not parse for any
 * entry in this module. There is no "recent bookings" arm to fall back to,
 * which is what makes "an operator must select a record first" a property of the
 * argument type rather than a promise about usage.
 */
const bookingIdArgsSchema = z.object({ bookingId: RECORD_ID }).strict();
type BookingIdArgs = z.infer<typeof bookingIdArgsSchema>;

const bookingIdInputSchema = {
  type: "object" as const,
  properties: {
    bookingId: {
      type: "string",
      description:
        "The EXACT booking record id, as returned by diagnostics.booking_search. NOT the eight-character booking reference a member reads off their confirmation, and not a member id.",
    },
  },
  required: ["bookingId"],
  additionalProperties: false as const,
};

/**
 * The hard cap on a ROOM or BED label on the way out.
 *
 * 24 rather than `personNameOrNull`'s 60, and it is a MEASUREMENT rather than a
 * preference — see the byte-ceiling note in the module docblock. Both columns
 * are `VarChar(100)`; at the wider cap, sixty allocation rows can serialise past
 * the entry's 16 384-byte ceiling and gate 9 refuses the WHOLE result for a long
 * stay. At 24 the worst case the schema can produce still fits, so the ceiling
 * is provable rather than typical. A real label is "Bunk Room" or "Bed 3".
 */
const LODGE_LABEL_MAX_CHARS = 24;

/**
 * Project a room or bed label: control characters removed, whitespace collapsed,
 * quotes, angle brackets, `;` and `=` removed, hard-capped and marked when
 * clipped.
 *
 * Stripped rather than sentinelled, on the same reasoning as `personNameOrNull`:
 * this is authored text an administrator typed into the lodge configuration, so
 * an unusual character is a naming choice rather than evidence the column holds
 * the wrong kind of thing. The `;` and `=` strip matters because the evidence
 * renderer's row format is `key=value` pairs joined by `"; "`, and because this
 * value also reaches the audit `resultHash`, which no renderer touches.
 *
 * Returns null for an absent or blank label and never an empty string: "this
 * allocation's bed row could not be read" and "the bed has a blank name" are
 * both "there is no label here", and neither of them is a label.
 */
function lodgeLabelOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value)
    // Stripping control characters is the point: nothing here is source code, so
    // the strip costs no fidelity, and a control character in a durable audit hash
    // input is worth removing at the source.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/["<>;=]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length <= LODGE_LABEL_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, LODGE_LABEL_MAX_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// 1. The booking's own stored state.
// ---------------------------------------------------------------------------

/**
 * ONE ROW: the twenty-four facts about one booking that were chosen over the
 * other twenty-five. The choice, the rule it was made by, and where every
 * dropped field's evidence lives are all in the module docblock, because a
 * reader's first question about this entry is why a field they expected is not
 * here.
 *
 * A PURE `Booking` READ, plus one scalar subquery for the party size. There is
 * no `Lodge` join — `lodgeName` was dropped, and that is what keeps this
 * statement's grant to a single relation.
 *
 * `nightCount` IS A DATE SUBTRACTION AND THAT IS EXACTLY RIGHT.
 * `checkOut - checkIn` on two `date` columns is an `integer` number of days, and
 * because `checkOut` is the departure day rather than a night, that integer IS
 * the number of lodge nights: the 14th to the 17th is three nights. It is
 * computed in SQL rather than in the projection for the reason this pack refuses
 * to touch a lodge night in JavaScript at all — the moment a `@db.Date` becomes
 * a `Date` object it acquires a timezone it did not have, and a night that
 * shifts by twelve hours is a different night.
 *
 * `creditElectionCents` HAS THREE STATES AND KEEPS THEM. The schema is explicit:
 * NULL means no election is outstanding (never made, or already consumed), 0
 * means the member explicitly chose to use NONE, and a positive value is the
 * amount they asked to apply. It goes out through `centsOrNull`, so a NULL never
 * becomes a 0 — a model shown 0 says "none", which is a different and more
 * confident claim than "nothing is recorded". It is NOT a record of credit
 * already applied; the applied total lives in the `MemberCredit` ledger, which
 * is finance evidence this pack cannot read, and the scope line says so.
 *
 * `totalPriceCents` and `finalPriceCents` use `centsOrNull` rather than
 * `centsOrZero`, DELIBERATELY DIVERGING from the two LISTING entries that project
 * the same column — `booking_search` (`booking-search.ts`) and
 * `member_booking_summary` (`membership-records.ts`) — both of which coerce
 * `finalPriceCents` to zero. Three entries, two helpers, and the split is by the
 * kind of answer rather than by module.
 *
 * Both columns are `Int` NOT NULL with no `@default`, so an absent value is
 * impossible either way and the divergence is unreachable on real data. It is
 * about which wrong answer is safer if it ever becomes reachable. THIS entry is
 * the per-booking money answer an officer acts on, so an unexpected read must say
 * "unknown": reporting a booking as costing nothing is worse in every direction.
 * The listing entries exist for RECOGNITION — pick the right booking out of ten —
 * where a `null` in a price column beside nine numbers reads as a data fault in
 * the tool and sends the reader to the wrong question; they hold a number, and the
 * entry an operator drills into carries the honest absence.
 */
const BOOKING_SUMMARY_SQL = `SELECT
  b."id" AS booking_ref,
  pg_catalog.upper(pg_catalog.left(b."id", 8)) AS booking_reference,
  b."memberId" AS owner_member_ref,
  b."lodgeId" AS lodge_ref,
  b."status"::text AS booking_status,
  ${dateOnly('b."checkIn"')} AS check_in,
  ${dateOnly('b."checkOut"')} AS check_out,
  (b."checkOut" - b."checkIn")::int AS night_count,
  (SELECT pg_catalog.count(*)::int FROM public."BookingGuest" g WHERE g."bookingId" = b."id") AS guest_count,
  b."totalPriceCents" AS total_price_cents,
  b."discountCents" AS discount_cents,
  b."promoAdjustmentCents" AS promo_adjustment_cents,
  b."finalPriceCents" AS final_price_cents,
  b."creditElectionCents" AS credit_election_cents,
  b."hasNonMembers" AS has_non_members,
  ${utcInstant('b."nonMemberHoldUntil"')} AS non_member_hold_until_utc,
  b."parentBookingId" AS parent_booking_ref,
  ${utcInstant('b."draftExpiresAt"')} AS draft_expires_at_utc,
  b."adminReviewStatus"::text AS admin_review_status,
  b."adultMemberHostingReviewStatus"::text AS hosting_review_status,
  b."wholeLodgeHold" AS whole_lodge_hold_flag_stored,
  ${utcInstant('b."deletedAt"')} AS deleted_at_utc,
  ${utcInstant('b."createdAt"')} AS created_at_utc,
  ${utcInstant('b."updatedAt"')} AS updated_at_utc
FROM public."Booking" b
WHERE b."id" = $1::text`;

const bookingSummary = defineDiagnosticsTool<BookingIdArgs>({
  id: DIAGNOSTICS_BOOKING_SUMMARY_TOOL_ID,
  source: "select_only_sql",
  label: "Booking diagnostic summary",
  description: `Returns the core stored state of ONE booking: its record id and the eight-character reference a member sees, the owner's member id, the lodge id, the status, the check-in and check-out New Zealand nights and how many nights that is, how many guests are on it, the prices in integer cents (total, discount, promotional adjustment, final) and the stored account-credit election, whether the party includes non-members and when their hold runs out, the parent booking id if it is a linked child, when a draft expires, the admin-review and adult-member-hosting-review statuses, the STORED whole-lodge-hold flag as it was requested (not whether the hold is in effect now — diagnostics.booking_capacity_by_night answers that), and when it was deleted, created and last changed. Use it after finding a booking. It returns NO booking notes, no review notes, no member review justification, no hosting-review snapshot, no cancellation reason and no member names — the party names are on diagnostics.booking_party_state. For the waitlist position, the admin-capacity-hold and capacity-override flags and the lodge NAME, read the diagnostics.booking_search row for the same booking id. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["bookings"],
  evidenceScope: `The stored state of ONE booking record, as twenty-four fields chosen from the forty-nine the row carries — the substrate caps a row at twenty-four, so this is a deliberate subset and not everything known about the booking. nightCount is checkOut minus checkIn, which is the number of lodge NIGHTS because checkOut is the departure day. creditElectionCents has THREE meanings and they are different answers: null means no credit election is outstanding, 0 means the member explicitly chose to use none, and a positive value is the amount they asked to apply — it is NOT credit already applied, which lives in the member credit ledger and needs finance access. Not reported here, and not readable by any tool in this pack: the booking's notes, the admin-review notes and reason, the member's review justification, the hosting-review snapshot and the deletion reason — those are Admin > Booking detail. Not reported here but available under the same permission: the waitlist POSITION, the admin-capacity-hold and capacity-override flags and the lodge name, all on the diagnostics.booking_search row for this same booking id. wholeLodgeHoldFlagStored IS reported here, and it is the STORED REQUEST rather than a current effect: a cancelled, bumped or deleted booking can carry the flag and hold nothing, so never call it an active exclusive hold. Whether a hold is in effect on a given night is diagnostics.booking_capacity_by_night, which reports the effective figure. The waitlist OFFER detail — when it was made, when it expires, and whether it is an offer of a DIFFERENT lodge at a DIFFERENT price — is deliberately absent in full rather than in part, because half of it would have you describing an offer for this booking's own lodge; that is Admin > Waitlist. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingIdArgsSchema,
  inputSchema: bookingIdInputSchema,
  sql: BOOKING_SUMMARY_SQL,
  // ONE parameter, and the statement references exactly `$1`.
  bind: (args) => [args.bookingId],
  project: (row) => ({
    bookingRef: recordRefOrNull(row.booking_ref) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    ownerMemberRef: recordRefOrNull(row.owner_member_ref) ?? "",
    lodgeRef: recordRefOrNull(row.lodge_ref) ?? "",
    bookingStatus: stableCodeOrNull(row.booking_status),
    checkIn: dateOnlyOrNull(row.check_in) ?? "",
    checkOut: dateOnlyOrNull(row.check_out) ?? "",
    nightCount: countOf(row.night_count),
    guestCount: countOf(row.guest_count),
    totalPriceCents: centsOrNull(row.total_price_cents),
    discountCents: centsOrZero(row.discount_cents),
    promoAdjustmentCents: centsOrZero(row.promo_adjustment_cents),
    finalPriceCents: centsOrNull(row.final_price_cents),
    creditElectionCents: centsOrNull(row.credit_election_cents),
    hasNonMembers: boolOf(row.has_non_members),
    nonMemberHoldUntilUtc: instantOrNull(row.non_member_hold_until_utc),
    parentBookingRef: recordRefOrNull(row.parent_booking_ref),
    draftExpiresAtUtc: instantOrNull(row.draft_expires_at_utc),
    adminReviewStatus: stableCodeOrNull(row.admin_review_status),
    hostingReviewStatus: stableCodeOrNull(row.hosting_review_status),
    wholeLodgeHoldFlagStored: boolOf(row.whole_lodge_hold_flag_stored),
    deletedAtUtc: instantOrNull(row.deleted_at_utc),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  }),
  rowLimit: 1,
  byteLimit: AID6B_SINGLE_ROW_BYTE_LIMIT,
  // No name is projected, but `ownerMemberRef` identifies a person to anyone who
  // can resolve it. ADR-004's per-invocation opt-in is DECLARED by this flag and
  // is not yet implemented (prerequisite on #2378), so it is not a control.
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 1b. The bounded linkage around the selected booking.
// ---------------------------------------------------------------------------

const BOOKING_LINKED_STATE_SQL = `SELECT
  CASE
    WHEN related."id" = selected."parentBookingId" THEN 'parent'
    ELSE 'child'
  END AS relation_type,
  related."id" AS booking_ref,
  pg_catalog.upper(pg_catalog.left(related."id", 8)) AS booking_reference,
  related."status"::text AS booking_status,
  ${dateOnly('related."checkIn"')} AS check_in,
  ${dateOnly('related."checkOut"')} AS check_out,
  related."wholeLodgeHold" AS whole_lodge_hold_flag_stored,
  (related."deletedAt" IS NOT NULL) AS is_deleted
FROM public."Booking" selected
JOIN public."Booking" related
  ON related."id" = selected."parentBookingId"
  OR related."parentBookingId" = selected."id"
WHERE selected."id" = $1::text
ORDER BY
  CASE WHEN related."id" = selected."parentBookingId" THEN 0 ELSE 1 END ASC,
  related."createdAt" ASC,
  related."id" ASC`;

const bookingLinkedState = defineDiagnosticsTool<BookingIdArgs>({
  id: DIAGNOSTICS_BOOKING_LINKED_STATE_TOOL_ID,
  source: "select_only_sql",
  label: "Booking linked-record state",
  description: `Lists the records directly linked to ONE selected booking, at most ${AID6B_HISTORY_ROW_LIMIT}: its parent when it is a child, and its direct children when it is a parent. Each safe summary carries only the relation direction, record id and eight-character reference, status, lodge-night dates, the STORED whole-lodge-hold flag as requested (never a current effect) and deletion flag. It does not walk grandchildren or siblings and returns no names, prices, notes or actor ids. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["bookings"],
  evidenceScope: `The direct linkage around ONE selected booking, at most ${AID6B_HISTORY_ROW_LIMIT} rows: a parent record and/or direct child records only. The ordering is parent first, then children by creation order. A clipped result is incomplete and must not be described as the complete child set. This is linkage evidence, not proof that linked bookings share guests, payment, capacity or lifecycle; inspect a returned booking explicitly before making a claim about it. wholeLodgeHoldFlagStored is the STORED REQUEST on the linked record and never a current effect — a cancelled, bumped or deleted booking can carry the flag and hold nothing, so never call it an active exclusive hold; diagnostics.booking_capacity_by_night reports the effective figure. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingIdArgsSchema,
  inputSchema: bookingIdInputSchema,
  sql: BOOKING_LINKED_STATE_SQL,
  bind: (args) => [args.bookingId],
  project: (row) => ({
    relationType: stableCodeOrNull(row.relation_type),
    bookingRef: recordRefOrNull(row.booking_ref) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    bookingStatus: stableCodeOrNull(row.booking_status),
    checkIn: dateOnlyOrNull(row.check_in) ?? "",
    checkOut: dateOnlyOrNull(row.check_out) ?? "",
    wholeLodgeHoldFlagStored: boolOf(row.whole_lodge_hold_flag_stored),
    isDeleted: boolOf(row.is_deleted),
  }),
  rowLimit: AID6B_HISTORY_ROW_LIMIT,
  byteLimit: AID6B_BYTE_LIMIT,
  // A booking reference plus lodge nights is still personal data even without a
  // name. ADR-004's declaration must describe the evidence actually returned.
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 2. The party: who is on the booking, for which nights, and on what footing.
// ---------------------------------------------------------------------------

/**
 * The closed, server-owned catalogue that turns a `BookingGuest`'s five consent
 * columns into ONE stable code — and the sentences that tell a model what each
 * code means, interpolated into the entry's own `evidenceScope` so the
 * vocabulary actually reaches the consumer.
 *
 * AID-6C's review found a catalogue in the finance pack that existed and was
 * read only by its own test. A code the model cannot interpret is worse than no
 * code: it invites a guess. So this object is the single source of both the SQL
 * literals and the model-facing explanation, and neither can drift from the
 * other because the statement is built from these keys.
 *
 * THE SHAPES ARE THE PLATFORM'S OWN, NOT THIS MODULE'S INVENTION. The schema
 * comment on `BookingGuest.consentStatus` carries an eight-row discriminator
 * table generated from `MEMBER_GUEST_CONSENT_SUB_STATES` in
 * `member-guest-consent.ts`, and `member-guest-consent.test.ts` fails unless the
 * comment matches it verbatim. Seven codes cover the eight shapes: TARGET_APPROVED
 * and DELEGATE_APPROVED are told apart only by whether `consentRespondedByMemberId`
 * is the guest themself, and that column names a person, so the two share
 * `approved_on_request` and this catalogue says so rather than picking one.
 *
 * THE COLUMN IS GRANTED AND READ — say so, because an earlier revision of this
 * sentence said it was "NOT granted" and that is a trap in both directions. It is
 * in the `BookingGuest` allowlist in `provision-role.ts`, this module's own grant
 * table lists it among the five consent discriminators "READ BUT NEVER PROJECTED",
 * `BOOKING_PARTY_SQL` selects it, and `consentSubStateOf` passes it into
 * `classifyMemberGuestConsent` — which cannot classify a CONFIRMED row without it
 * (it returns null, mapped to `unrecognised_consent_shape`, when the responder is
 * absent). A reader who believed the "NOT granted" line and tightened the
 * allowlist would take the grant away and break `booking_party_state` with a 42501
 * for EVERY booking, because a column privilege covers a SELECT-list reference. A
 * reader going the other way would think reporting WHICH of the two approved it
 * needs a fresh grant, and widen disclosure on a false premise. What withholds the
 * responder is the PROJECTION, not the server: the id is compared to the target id
 * and never emitted — the same thing this module says correctly in its grant table.
 */
export const BOOKING_GUEST_CONSENT_SUB_STATES = {
  family_or_legacy:
    'family_or_legacy: no consent was ever needed. The guest is inside the booker\'s family group, or is not a member, or the row predates the feature. This is the DOMINANT state and it is not an outstanding request — never describe it as "awaiting consent".',
  awaiting_target:
    "awaiting_target: the guest is a member outside the booker's family who has been asked and has not answered. The row holds a bed while it waits and an expiry exists, but this tool does not return the exact deadline. Use Admin > Booking detail and its consent surface to see when the hold lapses.",
  approved_on_request:
    "approved_on_request: the guest was asked and the request was approved — either by the guest themself or by a delegate acting for them. Which of the two is not reported, because it would need a column that names a person.",
  notify_only_auto_confirmed:
    "notify_only_auto_confirmed: this club does not require approval for a member guest, so the guest was told rather than asked and the row was confirmed automatically. Nobody approved anything.",
  admin_assigned:
    "admin_assigned: an administrator (or the booking-request pipeline) placed this member guest and stood behind it, so no approval was solicited.",
  declined:
    "declined: the member refused to be a guest on this booking. The row is not an occupant and should not appear on an arrival list.",
  consent_expired:
    "consent_expired: nobody answered before the deadline and the expiry sweep closed the request. The row is not an occupant.",
  unrecognised_consent_shape:
    "unrecognised_consent_shape: the five consent columns are in a combination the platform's own discriminator table does not describe. Report it as a data defect and do not infer a state from it.",
} as const;

type BookingGuestConsentSubStateCode =
  keyof typeof BOOKING_GUEST_CONSENT_SUB_STATES;

/**
 * A sub-state code as a SQL literal, typed so a code that is not in the
 * catalogue is a compile error rather than a value the model cannot interpret.
 */
function consentSubStateOf(row: Record<string, unknown>): BookingGuestConsentSubStateCode {
  const rawStatus = row.consent_status;
  const status =
    rawStatus === null ||
    rawStatus === "PENDING" ||
    rawStatus === "CONFIRMED" ||
    rawStatus === "DECLINED" ||
    rawStatus === "EXPIRED"
      ? rawStatus
      : undefined;
  if (status === undefined) return "unrecognised_consent_shape";
  const presentDate = (value: unknown): Date | null =>
    value === null || value === undefined ? null : new Date(0);
  const memberId =
    typeof row.guest_member_ref === "string" ? row.guest_member_ref : null;
  const responder =
    typeof row.consent_responded_by_member_ref === "string"
      ? row.consent_responded_by_member_ref
      : null;
  const classified = classifyMemberGuestConsent(
    {
      consentStatus: status,
      consentRequestedAt: presentDate(row.consent_requested_at),
      consentRespondedAt: presentDate(row.consent_responded_at),
      consentRespondedByMemberId: responder,
      consentExpiresAt: presentDate(row.consent_expires_at),
    },
    memberId,
  );
  switch (classified) {
    case "FAMILY_OR_LEGACY":
      return "family_or_legacy";
    case "AWAITING_TARGET":
      return "awaiting_target";
    case "TARGET_APPROVED":
    case "DELEGATE_APPROVED":
      return "approved_on_request";
    case "NOTIFY_ONLY_AUTO_CONFIRMED":
      return "notify_only_auto_confirmed";
    case "ADMIN_ASSIGNED":
      return "admin_assigned";
    case "DECLINED":
      return "declined";
    case "EXPIRED":
      return "consent_expired";
    default:
      return "unrecognised_consent_shape";
  }
}

/**
 * ONE ROW PER GUEST on the booking, with the per-night facts that make the
 * envelope explicable.
 *
 * `stayStart`/`stayEnd` ARE THE HALF-OPEN ENVELOPE: stayStart is inclusive and
 * stayEnd is the exclusive departure day, NEVER the last occupied night.
 * `firstNight`/`lastNight` ARE THE EXPLICIT NIGHT FACTS, and both representations
 * are projected because either alone is a trap. A guest may stay
 * NON-CONTIGUOUS nights within one booking (issue #713): each included night is
 * a `BookingGuestNight` row and the envelope is only the min/max of that set,
 * kept in sync on every write. So the envelope alone would have a model
 * narrating a gap-free stay over a gap. The per-night rows alone would be worse
 * for the opposite reason: a guest with NO per-night rows would report
 * `nightCount = 0` with null first and last nights, and a model would say the
 * guest is staying no nights — while the envelope says the 14th to the 17th.
 * Both, plus an explicit contiguity flag, is the only combination that cannot
 * produce a confident falsehood.
 *
 * `nightsAreContiguous` IS THREE-VALUED, and it is computed from the per-night
 * rows rather than from the envelope. True means the night count equals the span
 * from first to last night inclusive, so there is no gap. False means there IS a
 * gap. NULL means there are no per-night rows at all, so contiguity is not
 * established — which is a different answer from "there are gaps", and a
 * `false` there would be a specific and possibly untrue claim.
 *
 * `operationallyPresent` IS THE PLATFORM'S OWN PREDICATE, evaluated in SQL.
 * `OPERATIONALLY_PRESENT_GUEST_WHERE` in `member-guest-consent.ts` is
 * `consentStatus IS NULL OR consentStatus = 'CONFIRMED'`, and it is what the
 * kiosk, the chore roster, bed allocation, the arrival emails and the lodge
 * board all filter on. Precomputing it means a model never has to assemble it —
 * and cannot assemble it wrongly. The wrong way is spelled out in the schema and
 * in `member-guest-consent.ts` as a trap: `consentStatus <> 'PENDING'` is
 * UNKNOWN for a NULL row, and NULL is the dominant value forever, so that filter
 * silently drops every ordinary guest.
 *
 * The `CROSS JOIN LATERAL` cannot drop a guest: an aggregate query with no
 * `GROUP BY` returns exactly one row, so the derived table is total over the
 * left side even for a guest with no per-night rows.
 *
 * FIFTEEN FIELDS, and the two that #2376's plan asked for and did not get are the
 * consent deadline and the arrival instant — both instants, both about 45 bytes a
 * row, and together the difference between a full party of thirty fitting the
 * entry's byte ceiling and gate 9 refusing the whole result. The arithmetic is in
 * the module docblock. The consent deadline is one hop away on the booking page,
 * and kiosk arrival is lodge-operations evidence rather than booking-record
 * evidence; the scope line says both.
 */
const BOOKING_PARTY_SQL = `SELECT
  g."id" AS guest_ref,
  g."firstName" AS first_name,
  g."lastName" AS last_name,
  g."ageTier"::text AS age_tier,
  g."isMember" AS is_member,
  g."memberId" AS guest_member_ref,
  ${dateOnly('g."stayStart"')} AS stay_start,
  ${dateOnly('g."stayEnd"')} AS stay_end,
  n."night_count" AS night_count,
  CASE
    WHEN n."night_count" = 0 THEN NULL::boolean
    ELSE (n."night_count" = (n."last_night" - n."first_night" + 1))
  END AS nights_are_contiguous,
  ${dateOnly('n."first_night"')} AS first_night,
  ${dateOnly('n."last_night"')} AS last_night,
  g."priceCents" AS price_cents,
  (g."consentStatus" IS NULL OR g."consentStatus" = 'CONFIRMED') AS operationally_present,
  g."consentStatus"::text AS consent_status,
  g."consentRequestedAt" AS consent_requested_at,
  g."consentRespondedAt" AS consent_responded_at,
  g."consentRespondedByMemberId" AS consent_responded_by_member_ref,
  g."consentExpiresAt" AS consent_expires_at
FROM public."BookingGuest" g
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.count(*)::int AS night_count,
    pg_catalog.min(gn."stayDate") AS first_night,
    pg_catalog.max(gn."stayDate") AS last_night
  FROM public."BookingGuestNight" gn
  WHERE gn."bookingGuestId" = g."id"
) n
WHERE g."bookingId" = $1::text
ORDER BY g."stayStart" ASC, g."lastName" ASC, g."id" ASC`;

/** The consent vocabulary as one paragraph, for the entry's scope line. */
const CONSENT_SUB_STATE_SENTENCES = Object.values(
  BOOKING_GUEST_CONSENT_SUB_STATES,
).join(" ");

const bookingPartyState = defineDiagnosticsTool<BookingIdArgs>({
  id: DIAGNOSTICS_BOOKING_PARTY_TOOL_ID,
  source: "select_only_sql",
  label: "Booking party state",
  description: `Lists the guests on ONE booking, at most ${AID6B_PARTY_ROW_LIMIT}, earliest stay first then family name. Each row carries the guest record id, the given and family name, the age tier, whether they are a member and their member id if so, the half-open stay envelope (inclusive start and exclusive departure day), how many nights they actually have per-night records for, whether those nights are CONTIGUOUS, the earliest and latest of those nights, that guest's price in integer cents, whether the platform treats them as operationally present, and a single code for their member-guest consent shape. A guest whose nights are NOT contiguous has GAPS — the envelope is not the stay, so never describe the range between first and last night as nights they are here. It returns no date of birth, no contact details, no per-night prices, no arrival or departure instants, no consent deadline and no record of who approved a consent. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["bookings"],
  evidenceScope: `The guests on ONE booking with their per-night stay facts, at most ${AID6B_PARTY_ROW_LIMIT} rows. THE ENVELOPE IS NOT THE STAY: stayStart is inclusive and stayEnd is the EXCLUSIVE departure day, never the last occupied night. A guest may stay NON-CONTIGUOUS nights within one booking, and nightsAreContiguous is what settles it — true means no gap, false means there IS a gap, and null means the guest has NO per-night records at all, so contiguity is not established and the half-open envelope is the only evidence there is. Equal stayStart/stayEnd contains zero nights and is corrupt persisted evidence, never a one-night stay. firstNight and lastNight are the authoritative explicit per-night facts when present. MEMBER-GUEST CONSENT IS LIVE IN THIS RELEASE, and the shape of the columns is reported as one consentSubState code: ${CONSENT_SUB_STATE_SENTENCES} A NULL consent status is the DOMINANT value and always will be — every non-member guest, every family-scope guest and every row written before the feature existed carries one — so it means "no consent was ever needed" and NEVER "consent is outstanding". Never reason with "consentStatus is not PENDING": in SQL that test is UNKNOWN for a NULL row, so it silently drops every ordinary guest, which is why the platform's own predicate is "consentStatus IS NULL OR consentStatus = CONFIRMED" and why this tool precomputes it as operationallyPresent. A guest who is not operationally present may still be holding a bed while their request is pending; WHEN that hold lapses is not reported here — Admin > Booking detail shows the deadline. Who approved a consent is not reported and is not readable by any tool here. Nor is whether the guest arrived or left: kiosk arrival is lodge-operations evidence rather than booking-record evidence, and it is on the kiosk and lodge board. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingIdArgsSchema,
  inputSchema: bookingIdInputSchema,
  sql: BOOKING_PARTY_SQL,
  // ONE parameter, and the statement references exactly `$1`.
  bind: (args) => [args.bookingId],
  project: (row) => ({
    guestRef: recordRefOrNull(row.guest_ref) ?? "",
    firstName: personNameOrNull(row.first_name),
    lastName: personNameOrNull(row.last_name),
    ageTier: stableCodeOrNull(row.age_tier),
    isMember: boolOf(row.is_member),
    guestMemberRef: recordRefOrNull(row.guest_member_ref),
    stayStart: dateOnlyOrNull(row.stay_start) ?? "",
    stayEnd: dateOnlyOrNull(row.stay_end) ?? "",
    nightCount: countOf(row.night_count),
    nightsAreContiguous: nullableBoolOf(row.nights_are_contiguous),
    firstNight: dateOnlyOrNull(row.first_night),
    lastNight: dateOnlyOrNull(row.last_night),
    priceCents: centsOrNull(row.price_cents),
    operationallyPresent: boolOf(row.operationally_present),
    consentSubState: consentSubStateOf(row),
  }),
  rowLimit: AID6B_PARTY_ROW_LIMIT,
  // Measured, not chosen: see `AID6B_WIDE_BYTE_LIMIT`. Thirty guests each carrying
  // a given AND a family name at the projection's cap do not fit under the pack's
  // ordinary ceiling, and gate 9 REFUSES rather than trims.
  byteLimit: AID6B_WIDE_BYTE_LIMIT,
  // Every row carries a person's given and family name, and a member guest's
  // row carries their member id. ADR-004's per-invocation opt-in is DECLARED by
  // this flag and is not yet implemented (prerequisite on #2378), so it is not a
  // control — the controls that run are the `bookings:view` requirement, the
  // exact booking id, the column allowlist and the column grant.
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 3. Bed allocation: which guest is in which bed on which night.
// ---------------------------------------------------------------------------

/**
 * ONE ROW PER `BedAllocation` — one guest, one bed, one night — for THIS booking
 * only.
 *
 * EIGHT FIELDS. A guest-night is a row, so this is a party times a stay: six
 * guests over ten nights is sixty rows. The eighth is a stable verdict from the
 * canonical double-sharing rule, and the entry therefore uses the pack's 24 576
 * byte wide ceiling. Labels remain capped at 24 characters and gate 9 refuses an
 * oversized full result rather than silently trimming it.
 * Dropped to get here, in the order they were given up: the allocation's own id
 * (the row has a natural key — see below), the room and bed ids, the live bed
 * type (the comparison carries it), the bunk group, the approval instant, the
 * created instant, the allocation source and the bed's active flag. Each is named
 * in the scope line with the board that shows it.
 *
 * NO EVIDENCE REFERENCE IS PROJECTED, AND IT IS NOT NEEDED. Every other
 * per-record entry in both packs projects the row's own id, and dropping it here
 * bought forty bytes a row on the tightest entry in the pack. It costs nothing
 * because the row has a NATURAL key that IS projected: the schema's
 * `@@unique([bookingGuestId, stayDate])` means one guest has at most one
 * allocation per night, so guest plus night identifies the row exactly. The id
 * is still the final `ORDER BY` term, so the ordering stays total and the audit
 * `resultHash` stays stable.
 *
 * BOTH BED TYPES ARE COMPARED AND ONE IS REPORTED, which is the resolution of a
 * real conflict. `BedAllocation."bedType"` is a DENORMALISED copy of
 * `LodgeBed."bedType"`, taken at allocation time, and it is the copy the
 * partial unique index actually enforces on: the index predicate cannot join to
 * `LodgeBed`, so the "non-double beds are capped at one occupant a night" guard
 * reads the row's own column. A mismatch between the two is therefore a real
 * defect with real consequences, and reporting only one of them would hide it.
 * `bedType` is the denormalised copy — the one the index guard uses — and
 * `bedTypeMatchesBed` is the comparison. The live type is not projected
 * separately, but it IS the authoritative input to `doubleBedSharingState`: a
 * stale allocation copy must never decide current sharing eligibility. When the
 * values match they are the same; when they do not, the mismatch plus the live
 * verdict is the finding and the bed-allocation board shows the current bed.
 * The comparison is NULL when the bed row could not be read at all, and the
 * sharing verdict then says `live_bed_missing` rather than inventing a type.
 *
 * EVERY JOIN IS A LEFT JOIN so a broken foreign key cannot silently remove a
 * guest-night from the answer. The room and bed relations are `Restrict` with
 * NOT NULL columns, so a null room or bed label is itself a finding rather than
 * an ordinary absence — and an inner join would have turned that finding into a
 * missing row, which is the falsehood that matters here. The bed join uses BOTH
 * columns of the composite foreign key (`[bedId, roomId]` → `[id, roomId]`),
 * exactly as the schema declares it.
 *
 * `bedType` IS STILL PROJECTED EVEN THOUGH THE BED IS ONLY REACHED FOR ITS NAME
 * AND THE COMPARISON, and that is not redundancy: the projected value is the
 * ALLOCATION's own copy, which is the one the guard reads, so it is the value
 * that explains why a second occupant was accepted or refused.
 */
export const DOUBLE_BED_SHARING_STATE_MEANINGS = {
  live_bed_missing:
    "live_bed_missing: the current LodgeBed row could not be read, so sharing eligibility is unavailable and must not be inferred from the allocation's copied bed type.",
  not_double_bed: "not_double_bed: this allocation is not on a DOUBLE bed.",
  single_occupant: "single_occupant: the DOUBLE currently has no other occupant.",
  corrupt_occupant_cardinality:
    "corrupt_occupant_cardinality: more than one other allocation occupies the same bed-night; report a data defect.",
  ineligible_guest_not_member:
    "ineligible_guest_not_member: at least one occupant is not linked to a member.",
  ineligible_same_member:
    "ineligible_same_member: both guest rows resolve to the same member; report a data defect.",
  ineligible_member_missing:
    "ineligible_member_missing: at least one linked member row cannot be read.",
  ineligible_member_inactive:
    "ineligible_member_inactive: at least one occupant is not currently active.",
  ineligible_not_adult:
    "ineligible_not_adult: at least one occupant is not currently in the ADULT age tier.",
  eligible_confirmed_partners:
    "eligible_confirmed_partners: two distinct active ADULT members have a CONFIRMED partner link and may share.",
  ineligible_partner_link_pending:
    "ineligible_partner_link_pending: the current partner link is PENDING, which grants no sharing eligibility.",
  ineligible_partner_link_absent:
    "ineligible_partner_link_absent: no partner link exists for the pair.",
  ineligible_partner_link_unrecognised:
    "ineligible_partner_link_unrecognised: the link has an unknown status; report a data defect.",
} as const;

const DOUBLE_BED_SHARING_STATE_SENTENCES = Object.values(
  DOUBLE_BED_SHARING_STATE_MEANINGS,
).join(" ");

const BOOKING_BED_ALLOCATION_SQL = `SELECT
  ${dateOnly('a."stayDate"')} AS stay_date,
  a."bookingGuestId" AS guest_ref,
  r."name" AS room_name,
  bd."name" AS bed_name,
  a."bedType"::text AS bed_type,
  bd."bedType"::text AS live_bed_type,
  (a."bedType" = bd."bedType") AS bed_type_matches_bed,
  a."isSecondOccupant" AS is_second_occupant,
  co."other_occupant_count",
  g."memberId" AS member_a_ref,
  og."memberId" AS member_b_ref,
  (ma."id" IS NOT NULL) AS member_a_exists,
  (mb."id" IS NOT NULL) AS member_b_exists,
  ma."active" AS member_a_active,
  mb."active" AS member_b_active,
  ma."ageTier"::text AS member_a_age_tier,
  mb."ageTier"::text AS member_b_age_tier,
  pl."status"::text AS partner_link_status
FROM public."BedAllocation" a
LEFT JOIN public."LodgeRoom" r ON r."id" = a."roomId"
LEFT JOIN public."LodgeBed" bd ON bd."id" = a."bedId" AND bd."roomId" = a."roomId"
LEFT JOIN public."BookingGuest" g
  ON g."id" = a."bookingGuestId" AND g."bookingId" = a."bookingId"
LEFT JOIN LATERAL (
  SELECT
    pg_catalog.count(*)::int AS other_occupant_count,
    pg_catalog.min(other."bookingGuestId") AS other_guest_ref
  FROM public."BedAllocation" other
  WHERE other."roomId" = a."roomId"
    AND other."bedId" = a."bedId"
    AND other."stayDate" = a."stayDate"
    AND other."id" <> a."id"
) co ON true
LEFT JOIN public."BookingGuest" og ON og."id" = co."other_guest_ref"
LEFT JOIN public."Member" ma ON ma."id" = g."memberId"
LEFT JOIN public."Member" mb ON mb."id" = og."memberId"
LEFT JOIN public."MemberPartnerLink" pl
  ON g."memberId" IS NOT NULL
  AND og."memberId" IS NOT NULL
  AND g."memberId" <> og."memberId"
  AND pl."memberAId" = CASE
    WHEN g."memberId" < og."memberId" THEN g."memberId" ELSE og."memberId"
  END
  AND pl."memberBId" = CASE
    WHEN g."memberId" < og."memberId" THEN og."memberId" ELSE g."memberId"
  END
WHERE a."bookingId" = $1::text
ORDER BY a."stayDate" ASC, r."name" ASC, bd."name" ASC, a."id" ASC`;

const bookingBedAllocationState = defineDiagnosticsTool<BookingIdArgs>({
  id: DIAGNOSTICS_BOOKING_BED_ALLOCATION_TOOL_ID,
  source: "select_only_sql",
  label: "Booking bed allocation state",
  description: `Lists the bed allocations THIS booking holds, one row per guest per night, at most ${AID6B_ALLOCATION_ROW_LIMIT}, earliest night first then room then bed. Each row carries the night, booking-guest record id, room and bed names, the allocation's stored bed type, whether that copy still matches the live LodgeBed, whether the guest is the SECOND occupant, and the platform's current double-bed-sharing verdict derived from the LIVE bed type. A live DOUBLE may hold two occupants only when they are distinct active ADULT members with a CONFIRMED partner link; pending, absent, missing-bed and corrupt link or member facts are reported as ineligible or unavailable evidence, not guessed. That verdict reads live membership and partner-link facts for BOTH occupants, so this combined tool requires both Bookings and Membership view access. This is THIS booking's allocation only, never the lodge's whole board. It returns no other occupant id, member id, approver identity, room notes, placement source or active-bed flag. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["bookings", "membership"],
  evidenceScope: `The bed allocations belonging to ONE explicitly selected booking, one row per guest per night, at most ${AID6B_ALLOCATION_ROW_LIMIT} rows. The LIVE LodgeBed type governs current sharing eligibility; bedType is the allocation's denormalised copy and may be stale. Every live non-DOUBLE bed is single-occupancy. A live DOUBLE may hold a primary plus one second occupant only when the platform's canonical rule says they are two distinct, existing, active ADULT members with a CONFIRMED partner link. doubleBedSharingState means: ${DOUBLE_BED_SHARING_STATE_SENTENCES} The other occupant may belong to a different booking. Their member id, guest id and booking id are predicate/classifier inputs only and are NEVER projected; membership evidence is not queried at all unless the authenticated actor holds membership:view as well as bookings:view. bedTypeMatchesBed false is a real data defect and null means the bed row could not be read; a missing bed makes sharing evidence unavailable rather than non-double. AN UNALLOCATED GUEST-NIGHT IS NOT PROOF THE LODGE WAS FULL. Custodian bed holds have no allocation or booking row and are absent here. THIS TOOL REPORTS ONE BOOKING'S OWN ALLOCATION, NEVER THE WHOLE BOARD, so never conclude lodge occupancy or availability from it; use Admin > Bed Allocation. Eight fields a row use the pack's wide result ceiling. Placement source, active-bed state, approval instant, bunk pairing, approver identity and room notes are not reported. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingIdArgsSchema,
  inputSchema: bookingIdInputSchema,
  sql: BOOKING_BED_ALLOCATION_SQL,
  // ONE parameter, and the statement references exactly `$1`.
  bind: (args) => [args.bookingId],
  project: (row) => ({
    stayDate: dateOnlyOrNull(row.stay_date) ?? "",
    guestRef: recordRefOrNull(row.guest_ref) ?? "",
    roomName: lodgeLabelOrNull(row.room_name),
    bedName: lodgeLabelOrNull(row.bed_name),
    bedType: stableCodeOrNull(row.bed_type),
    bedTypeMatchesBed: nullableBoolOf(row.bed_type_matches_bed),
    isSecondOccupant: boolOf(row.is_second_occupant),
    doubleBedSharingState: classifyDoubleBedSharingFacts({
      bedType: typeof row.live_bed_type === "string" ? row.live_bed_type : null,
      otherOccupantCount: countOf(row.other_occupant_count),
      memberIdA: typeof row.member_a_ref === "string" ? row.member_a_ref : null,
      memberIdB: typeof row.member_b_ref === "string" ? row.member_b_ref : null,
      memberAExists: row.member_a_exists === true,
      memberBExists: row.member_b_exists === true,
      memberAActive: nullableBoolOf(row.member_a_active),
      memberBActive: nullableBoolOf(row.member_b_active),
      memberAAgeTier:
        typeof row.member_a_age_tier === "string" ? row.member_a_age_tier : null,
      memberBAgeTier:
        typeof row.member_b_age_tier === "string" ? row.member_b_age_tier : null,
      partnerLinkStatus:
        typeof row.partner_link_status === "string"
          ? row.partner_link_status
          : null,
    }),
  }),
  rowLimit: AID6B_ALLOCATION_ROW_LIMIT,
  byteLimit: AID6B_WIDE_BYTE_LIMIT,
  // No name and no member id — but a booking-guest id resolves to a named person
  // through `booking_party_state`, so the flag is
  // set conservatively. ADR-004's per-invocation opt-in is DECLARED by it and is
  // not yet implemented (prerequisite on #2378), so it is not a control.
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 4. Exception and locked-period change requests raised on the booking.
// ---------------------------------------------------------------------------

/**
 * What each `BookingChangeRequestStatus` MEANS to an operator, as a server-owned
 * catalogue interpolated into the entry's `evidenceScope`.
 *
 * TYPED AGAINST THE PRISMA ENUM on purpose: a value added to
 * `BookingChangeRequestStatus` fails to compile until it is explained here, so
 * the vocabulary cannot fall behind the schema. And it is INTERPOLATED, not
 * merely declared — AID-6C's review found a catalogue in the finance pack that
 * existed and was read only by its own test, which is a catalogue that never
 * reaches the model and therefore does no work.
 *
 * The three #2365 outcomes are spelled out rather than paraphrased because each
 * one is a different answer to "so did the member get their exception?", and
 * three of them look like a refusal without being one. CANCELLED is the member
 * withdrawing. SUPERSEDED is a newer proposal replacing this one. EXPIRED is the
 * hold reaper releasing the beds because nobody decided in time. A model that
 * flattens those three into "rejected" tells a Booking Officer that a decision
 * was made against a member when none was.
 */
export const BOOKING_CHANGE_REQUEST_STATUS_MEANINGS: Record<
  BookingChangeRequestStatus,
  string
> = {
  REQUESTED:
    "REQUESTED is the ONLY non-terminal status: nobody has decided yet and the request is still live.",
  APPROVED:
    "APPROVED means an officer allowed the change. Terminal. It does not by itself prove the change was executed.",
  REJECTED: "REJECTED means an officer refused the change. Terminal.",
  CANCELLED:
    "CANCELLED means the MEMBER withdrew the request before anyone decided. Terminal, and nobody refused anything — do not report it as a refusal.",
  SUPERSEDED:
    "SUPERSEDED means a newer proposal replaced this one. Terminal, and the newer request is the live one — look for it in this same result.",
  EXPIRED:
    "EXPIRED means the hold reaper released the beds and closed the request because nobody decided before its deadline. Terminal, and no officer refused it.",
};

/**
 * What each `BookingChangeRequestKind` means. Same typing and the same reason:
 * the two kinds share a table and a queue but never the evidence columns, and
 * they are different member experiences.
 */
export const BOOKING_CHANGE_REQUEST_KIND_MEANINGS: Record<
  BookingChangeRequestKind,
  string
> = {
  LOCKED_PERIOD:
    "LOCKED_PERIOD is a change to a night that is today or already past, which the member cannot apply themselves and needs an officer's hands for.",
  POLICY_EXCEPTION:
    "POLICY_EXCEPTION is a member asking an officer to allow a soft booking-policy failure — a minimum stay, or adult-member hosting — on a proposal frozen at the moment they submitted it.",
};

/**
 * The change requests raised on ONE booking, newest first.
 *
 * `heldNightCount` IS THE ONLY RELIABLE TEST OF WHETHER BEDS ARE HELD, and the
 * obvious alternative is a documented trap. `PolicyExceptionReservationNight`
 * rows exist IFF the request is CURRENTLY holding that night's beds — there is
 * deliberately no "active" flag, because every terminal transition and every
 * successful approval DELETES the rows in the same transaction that writes the
 * outcome, so the canonical capacity calculation counts held reservations simply
 * by summing the rows that still exist. `holdExpiresAt IS NOT NULL` is NOT a
 * safe proxy, and the schema says so in as many words: "NULL is NOT a safe proxy
 * for 'holds no capacity': never filter a capacity question on `holdExpiresAt IS
 * NOT NULL`; the PolicyExceptionReservationNight rows are the only reliable
 * test." A row written before that column existed was deliberately not
 * backfilled, so it can be holding beds with a NULL deadline; the reaper handles
 * that population by deriving the deadline from `createdAt` and the first held
 * night. Both fields are projected, and the scope line says which one to
 * believe.
 *
 * SIXTEEN FIELDS, and four of #2376's plan are absent for a GRANT reason rather
 * than a size one. `hasLastConflictReason` and `hasProposalSnapshot` would each
 * need the SELECT privilege on a free-text or raw-Json column just to test it for
 * null (see "the presence-boolean trap" in the module docblock);
 * `reviewedByMemberRef` names the OFFICER who decided, and no actor id on any
 * relation is granted anywhere in this pack. `reviewedAtUtc` carries the half an
 * operator can act on — that a decision was made, and when — and the officer
 * queue shows who made it. `proposalHash` is a 64-hex drift token no operator can
 * act on which cost eighty bytes on every row, and `version` is an
 * optimistic-concurrency token; both are likewise absent.
 */
const BOOKING_EXCEPTION_REQUEST_SQL = `SELECT
  r."id" AS request_ref,
  r."kind"::text AS request_kind,
  r."status"::text AS request_status,
  r."requestedByMemberId" AS requested_by_member_ref,
  r."aggregateCapacityMode"::text AS aggregate_capacity_mode,
  r."attemptCount" AS attempt_count,
  r."conflictCount" AS conflict_count,
  ${utcInstant('r."lastConflictAt"')} AS last_conflict_at_utc,
  (SELECT pg_catalog.count(*)::int FROM public."PolicyExceptionReservationNight" n WHERE n."changeRequestId" = r."id") AS held_night_count,
  ${utcInstant('r."holdExpiresAt"')} AS hold_expires_at_utc,
  ${utcInstant('r."reviewedAt"')} AS reviewed_at_utc,
  ${utcInstant('r."cancelledAt"')} AS cancelled_at_utc,
  r."supersededByRequestId" AS superseded_by_request_ref,
  r."linkedModificationId" AS linked_modification_ref,
  ${utcInstant('r."createdAt"')} AS created_at_utc,
  ${utcInstant('r."updatedAt"')} AS updated_at_utc
FROM public."BookingChangeRequest" r
WHERE r."bookingId" = $1::text
ORDER BY r."createdAt" DESC, r."id" ASC`;

/** The two catalogues as one paragraph, for the entry's scope line. */
const CHANGE_REQUEST_VOCABULARY = [
  ...Object.values(BOOKING_CHANGE_REQUEST_KIND_MEANINGS),
  ...Object.values(BOOKING_CHANGE_REQUEST_STATUS_MEANINGS),
].join(" ");

const bookingExceptionRequestState = defineDiagnosticsTool<BookingIdArgs>({
  id: DIAGNOSTICS_BOOKING_EXCEPTION_REQUEST_TOOL_ID,
  source: "select_only_sql",
  label: "Booking change and exception requests",
  description: `Lists the change requests raised on ONE booking — locked-period edits and policy-exception requests alike — newest first, at most ${AID6B_HISTORY_ROW_LIMIT}. Each row carries the request id, its kind and status, the member who asked, the capacity mode of the frozen policy evidence, how many times it has been submitted and how many capacity conflicts it has hit and when the last one was, HOW MANY NIGHTS OF BEDS IT IS HOLDING RIGHT NOW, when any hold runs out, when it was reviewed (never by whom — that is the officer queue), when the member cancelled it, which newer request superseded it, which booking modification it produced, and when it was created and last changed. heldNightCount above zero is the only reliable sign that beds are currently held — a null hold deadline does NOT mean no beds are held. It returns no requested changes, no member message, no reason, no admin notes, no internal notes and no frozen proposal or evidence. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["bookings"],
  evidenceScope: `The change requests recorded against ONE booking, at most ${AID6B_HISTORY_ROW_LIMIT}, newest first. ${CHANGE_REQUEST_VOCABULARY} WHETHER BEDS ARE HELD IS ANSWERED BY heldNightCount AND BY NOTHING ELSE. A per-night reservation row exists if and only if the request is holding that night's beds right now — there is deliberately no active flag, because approving, rejecting, cancelling or superseding a request deletes those rows in the same transaction that records the outcome. holdExpiresAtUtc is NOT a safe proxy: the schema warns that a null deadline is two different populations, one of which is a row written before the column existed that IS holding beds, so never answer a capacity question from the deadline. A NEW-BOOKING policy-exception request is NOT in this result at all: it lives in a separate table because it has no booking id until it is converted, so an empty result here does not mean the member never asked for an exception — Admin > Exception Requests lists both kinds together. What a member wrote, what an officer wrote back, the officer's private internal notes, the requested changes, the frozen proposal and the frozen policy evidence are all outside this pack and not readable by any tool in it; Admin > Exception Requests shows them. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingIdArgsSchema,
  inputSchema: bookingIdInputSchema,
  sql: BOOKING_EXCEPTION_REQUEST_SQL,
  // ONE parameter, and the statement references exactly `$1`.
  bind: (args) => [args.bookingId],
  project: (row) => ({
    requestRef: recordRefOrNull(row.request_ref) ?? "",
    requestKind: stableCodeOrNull(row.request_kind),
    requestStatus: stableCodeOrNull(row.request_status),
    requestedByMemberRef: recordRefOrNull(row.requested_by_member_ref) ?? "",
    aggregateCapacityMode: stableCodeOrNull(row.aggregate_capacity_mode),
    attemptCount: countOf(row.attempt_count),
    conflictCount: countOf(row.conflict_count),
    lastConflictAtUtc: instantOrNull(row.last_conflict_at_utc),
    heldNightCount: countOf(row.held_night_count),
    holdExpiresAtUtc: instantOrNull(row.hold_expires_at_utc),
    reviewedAtUtc: instantOrNull(row.reviewed_at_utc),
    cancelledAtUtc: instantOrNull(row.cancelled_at_utc),
    supersededByRequestRef: recordRefOrNull(row.superseded_by_request_ref),
    linkedModificationRef: recordRefOrNull(row.linked_modification_ref),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  }),
  rowLimit: AID6B_HISTORY_ROW_LIMIT,
  byteLimit: AID6B_BYTE_LIMIT,
  // ONE member id per row: `requestedByMemberRef`, who asked. Who DECIDED is not
  // projected and `reviewedByMemberId` is not granted — the docblock above gives the
  // reason, and this comment said "two member ids" from a draft in which it was.
  // ADR-004's per-invocation opt-in is DECLARED by this flag and is not yet
  // implemented (prerequisite on #2378), so it is not a control.
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 5. The platform's own audit events for the booking record.
// ---------------------------------------------------------------------------

/**
 * The entity type this entry may read. A module constant closed over by `bind`,
 * never an argument, so the predicate is fixed at review time.
 *
 * `Booking` AND NOTHING ELSE, which is a real limit rather than a formality. An
 * event recorded against the booking's PAYMENT, its bed allocation or its change
 * request carries that record's own `entityType` and `entityId`, so it is not in
 * this result — and the scope line says so, because "no audit event touched this
 * booking" and "no audit event was recorded against the booking ROW" are
 * different claims and only the second one is true here.
 */
export const BOOKING_AUDIT_ENTITY_TYPES = ["Booking"] as const;

/**
 * The audit categories this entry may read — DERIVED from `audit-categories.ts`
 * rather than written out, exactly as AID-6A's correlation entries and AID-6C's
 * audit entry derive theirs.
 *
 * That keeps the tool in lockstep with #2581's canonical taxonomy: if a category
 * is reclassified into or out of the booking domain the tool follows without an
 * edit, and it can never read a category the booking domain does not own.
 */
const BOOKING_AUDIT_CATEGORIES =
  auditCategoriesForCorrelationDomain("booking");

/**
 * Modelled on `financeAuditHistory` deliberately, down to the predicate shape,
 * so a consumer reads ONE convention for "the platform's own recorded events
 * for this record, newest first, stable codes only".
 *
 * `entityId` is used as a PREDICATE against an id the caller already supplied
 * and is never projected: the row carries the audit row's own id as its evidence
 * reference, and echoing the caller's own argument back on every row would only
 * spend the entry's byte ceiling. The three member-identifying columns, the free
 * text, the arbitrary metadata Json and the network fields all stay ungranted,
 * so this entry can say that an event of this kind occurred on this booking at
 * this instant with this outcome — and cannot say who did it, from where, or
 * what they typed. That is why it is the one entry here that does not surface
 * personal data.
 */
const BOOKING_AUDIT_SQL = `SELECT
  a."id" AS event_ref,
  a."action" AS action_code,
  a."category" AS category_code,
  a."severity" AS severity_code,
  a."outcome" AS outcome_code,
  a."entityType" AS entity_type,
  ${utcInstant('a."createdAt"')} AS occurred_at_utc
FROM public."AuditLog" a
WHERE a."entityType" = ANY ($1::text[])
  AND a."entityId" = $2::text
  AND a."category" = ANY ($3::text[])
ORDER BY a."createdAt" DESC, a."id" ASC`;

const bookingRecordAuditHistory = defineDiagnosticsTool<BookingIdArgs>({
  id: DIAGNOSTICS_BOOKING_AUDIT_HISTORY_TOOL_ID,
  source: "select_only_sql",
  label: "Booking audit history for a record",
  description: `Returns the platform's own booking audit events for ONE booking, newest first, at most ${AID6B_HISTORY_ROW_LIMIT}. Each row carries only stable codes and an instant: the event reference, the action code, the audit category, severity and outcome, the kind of record it concerned, and when it happened in UTC. Use it to see what the platform recorded happening to this booking and in what order. It searches ONLY the booking audit categories (${BOOKING_AUDIT_CATEGORIES.join(", ")}) and only events recorded against the BOOKING record itself — a payment, bed-allocation or change-request event is recorded against that record instead. It never returns who did it, event descriptions, stored metadata, IP addresses or error text. ${AID6B_DESCRIPTION_TAIL}`,
  // DERIVED from the platform's correlation lattice minus the one named carve-out,
  // never written out here. See `aid6bRecordAuditReaderAreas` for why a
  // record-scoped audit entry does not require `support` and the pack's contract
  // test for the assertion that reconciles the two.
  requiredAreas: aid6bRecordAuditReaderAreas("booking"),
  evidenceScope: `Audit events recorded against ONE booking record, in the booking categories ${BOOKING_AUDIT_CATEGORIES.join(" and ")} only, at most ${AID6B_HISTORY_ROW_LIMIT}, newest first. AN EMPTY RESULT IS NOT EVIDENCE THAT NOTHING HAPPENED, and there are two structural reasons rather than one. First, the audit category is OPTIONAL for historical compatibility. The exact-head census has 429 row-producing current production writer sites and zero uncategorised sites: no current writer omits category, but historical rows written before categorisation was deployed may lack it and are matched by no diagnostics tool anywhere. Second, "Booking" is the ONLY entity type read here: an event recorded against this booking's PAYMENT, its bed allocation, its change request or the member is filed under that record's own type and id, and is not in this result. Never report that something did not happen on the strength of an empty result; say that no categorised booking audit event matched the booking record, and point at Admin > Audit Log, which lists historical uncategorised rows and every entity type as well. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingIdArgsSchema,
  inputSchema: bookingIdInputSchema,
  sql: BOOKING_AUDIT_SQL,
  // THREE parameters, always, and the statement references exactly `$1..$3`: the
  // entity types this entry covers (a module constant closed over here, never an
  // argument), the booking id, and the booking categories (derived from the
  // canonical taxonomy, never an argument).
  bind: (args) => [
    [...BOOKING_AUDIT_ENTITY_TYPES],
    args.bookingId,
    [...BOOKING_AUDIT_CATEGORIES],
  ],
  project: (row) => ({
    eventRef: recordRefOrNull(row.event_ref) ?? "",
    action: stableCodeOrNull(row.action_code),
    categoryCode: stableCodeOrNull(row.category_code),
    severityCode: stableCodeOrNull(row.severity_code),
    outcomeCode: stableCodeOrNull(row.outcome_code),
    entityType: stableCodeOrNull(row.entity_type),
    occurredAtUtc: instantOrNull(row.occurred_at_utc) ?? "",
  }),
  rowLimit: AID6B_HISTORY_ROW_LIMIT,
  byteLimit: AID6B_BYTE_LIMIT,
  // Stable codes and an instant. No person, no free text, no identifier beyond
  // the audit row's own — the caller's booking id is a predicate, not a column.
  surfacesPersonalData: false,
});

/** The AID-6B per-booking half, in presentation order. */
export const DIAGNOSTICS_AID6B_BOOKING_RECORD_TOOLS: readonly DiagnosticsToolEntry[] =
  [
    bookingSummary,
    bookingLinkedState,
    bookingPartyState,
    bookingBedAllocationState,
    bookingExceptionRequestState,
    bookingRecordAuditHistory,
  ];
