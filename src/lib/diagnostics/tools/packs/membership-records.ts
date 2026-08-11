/**
 * AI Diagnostics — AID-6B booking/membership pack, part 3: PER-MEMBER STORED
 * EVIDENCE (#2376, epic #2369).
 *
 * Five entries, each taking an EXACT member id that `member_search` had to produce
 * first. There is no listing tool here, no window that returns "recent members",
 * and no argument that widens a predicate — so the pack has no shape that could be
 * walked to extract the roll.
 *
 *   diagnostics.member_diagnostic_summary     membership
 *   diagnostics.member_subscription_state     membership
 *   diagnostics.member_family_state           membership
 *   diagnostics.member_booking_summary        membership + bookings
 *   diagnostics.member_record_audit_history   membership
 *
 * PERMISSION. Four of the five require `membership:view` and nothing else: #2376's
 * owner decision is explicit that a domain tool must not also demand
 * `support:view`, and a Membership Officer looking at a member is doing their own
 * job. `member_booking_summary` is the exception and it is deliberate — it combines
 * membership evidence (WHICH member) with booking evidence (THEIR bookings), and
 * the epic's rule for a tool that spans two domains is that it requires both areas,
 * AND-ed.
 *
 * THAT COMBINATION HAS TO BE ITS OWN ENTRY RATHER THAN ONE MORE VALUE IN AN ENUM.
 * `requiredAreas` is fixed on the entry and `invoke.ts` authorizes BEFORE it parses
 * arguments, so an argument can never move a call between permission sets. A single
 * `member_detail` tool taking `include: "bookings" | "family"` would have had to
 * declare both areas (denying a Membership Officer the family half they are
 * entitled to) or one area (handing a Membership Officer without booking access a
 * member's booking history). There is no third option, so there are five tools.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PACK WIDENS, AND THE ARGUMENT FOR IT
 * ---------------------------------------------------------------------------
 *
 * This module WIDENS `Member` from the two columns AID-6C granted — `"id"` and
 * `"xeroContactId"`, for `xero_contact_linkage` — to the identity and lifecycle set
 * enumerated below. `provision-role.ts` calls that two-column grant "the narrowest
 * grant in the file and the one to scrutinise hardest on any future edit". This is
 * that edit, so here is the argument rather than a diff.
 *
 * #2376's owner decision authorises a member's NAME, EMAIL ADDRESS and CONTACT
 * DETAILS as evidence for an EXPLICITLY SELECTED record under `membership:view` —
 * the same permission that already governs Admin > Members, where the same officer
 * reads the same fields on a screen, in bulk, with a CSV export. What the widening
 * buys is that a model answering "why can this member not book" can name the member
 * instead of quoting a cuid at an operator.
 *
 * WHAT STAYS REFUSED BY THE SERVER, not by this file's good intentions. Every one
 * of these is outside the SELECT grant, so PostgreSQL refuses it (42501) to the
 * diagnostics credential in a `psql` session as readily as in a tool:
 *
 *  - CREDENTIALS AND SECURITY POSTURE: `passwordHash`, `totpSecret`, `googleSub`,
 *    every `twoFactor*` column, `forcePasswordChange`, `passwordChangedAt`,
 *    `lastLoginAt`, `emailVerified`.
 *  - THE BIRTH DATE: `dateOfBirth`. Argued in `member_diagnostic_summary` below.
 *  - THE BODY: `gender`, `title`, `occupation`, every `street*` and `postal*`
 *    address column, `photoImageId`/`photoUpdatedAt`/`photoUpdatedByMemberId`.
 *  - FREE TEXT: `comments` (`@db.Text`), `cancelledReason`, `archivedReason`,
 *    `MemberSubscription."manualPaymentNote"` and everything on
 *    `FamilyGroupJoinRequest`.
 *  - AUTHORISATION STATE THIS PACK HAS NO QUESTION FOR: `role`,
 *    `financeAccessLevel`, `postLoginLanding`.
 *  - PLUMBING WHOSE ABSENCE IS NOT A GAP: `inheritParentEmail`,
 *    `inheritEmailFromId`, `lodgeScreenPhoneOptIn`, `detailsConfirmedAt`,
 *    `detailsConfirmedByMemberId`, `onboardingConfirmedAt`, `profileCompletedAt`,
 *    `cancelledViaRequestId`, `archivedViaLifecycleActionRequestId`,
 *    `hutLeaderEligibleAt`.
 *
 * ---------------------------------------------------------------------------
 * THE EXACT COLUMN GRANT THESE FIVE STATEMENTS NEED
 * ---------------------------------------------------------------------------
 *
 * Relation by relation, with the entry that needs each. A column marked
 * [PREDICATE] is READ — in a join, a `WHERE`, or a derived boolean — and NEVER
 * projected; PostgreSQL's column privileges apply to any reference in the
 * statement, including inside `x IS NOT NULL`, so a predicate-only column still has
 * to be granted. An ungranted column is a 42501 at runtime that passes every mock.
 *
 * public."Member"  (aliases m, rm, me, p, d)
 *   PROJECTED
 *     id                    E1 memberRef; E3 relatedMemberRef + relationRef (legs B/C)
 *     firstName             E1; E3 relatedFirstName
 *     lastName              E1; E3 relatedLastName
 *     email                 E1 — the ONLY projected email address in the whole pack,
 *                           AND the erasure marker predicate behind E1
 *                           lifecycleDeleted (`deletedAccountEmailMarkerSql`).
 *                           Dropping this column from the projection would NOT free
 *                           the grant: see "erasure is defined by its markers" below.
 *     ageTier               E1; E3 relatedAgeTier
 *     active                E1 isActive; E3 relatedIsActive
 *     canLogin              E1
 *     cancelledAt           E1 instant; E3 relatedIsCancelled (bool)
 *     archivedAt            E1 instant; E3 relatedIsArchived (bool)
 *     joinedDate            E1
 *     lifeMemberDate        E1
 *     requiresInduction     E1
 *     hutLeaderEligible     E1
 *     parentMemberId        E1 parentMemberRef; E3 leg B arm 1 + leg C arm 1; E1 dependentCount
 *     secondaryParentId     E1 secondaryParentRef; E3 leg B arm 2 + leg C arm 2; E1 dependentCount
 *     familyGroupId         E1 — the DEPRECATED legacy single-group pointer
 *     billingFamilyGroupId  E1
 *     createdAt             E1
 *     updatedAt             E1
 *   [PREDICATE] NEVER PROJECTED
 *     phoneNumber           E1 hasPhone presence test. The NUMBER is never returned
 *                           by any entry in this pack; it is a `member_search`
 *                           PREDICATE an operator already holds.
 *     xeroContactId         E1 hasXeroContact presence test (already granted, AID-6C)
 *   NOT READ AT ALL — see "WHAT STAYS REFUSED BY THE SERVER" above for the list and
 *   the reason for each class.
 *
 * public."MemberSubscription"  (alias s)
 *   PROJECTED
 *     id, seasonYear, status, xeroInvoiceNumber, paidAt, manuallyMarkedPaidAt,
 *     voidGeneration, createdAt, updatedAt                         all E2
 *   [PREDICATE] NEVER PROJECTED
 *     memberId              E2 — the entry's whole `WHERE`
 *     xeroInvoiceId         E2 hasXeroInvoice presence test (the id itself is
 *                           finance evidence and belongs to the finance pack)
 *   NOT READ: `manualPaymentNote`. A `@db.VarChar(500)` operator note, and #2376
 *   refuses operator free text. An earlier revision of this module granted it as a
 *   PREDICATE ONLY, to power a `hasManualPaymentNote` boolean, on the pattern AID-6C
 *   argues for on `PaymentRecoveryOperation."idempotencyKey"`. That grant was
 *   REMOVED before this shipped, and the reasoning is worth keeping: a column
 *   privilege is not a projection: it makes every manual-payment note in the club
 *   readable to anybody holding the diagnostics credential in a `psql` session, and
 *   the boolean bought nothing — `manuallyMarkedPaidAt` already carries the fact
 *   that the row was settled by hand, which is the diagnostically useful half.
 *   `idempotencyKey` earned its grant because the CLASSIFICATION it enables exists
 *   nowhere else; "an operator wrote something down" does not clear that bar.
 *   NOT READ: `xeroOnlineInvoiceUrl` (a live Xero link is not evidence),
 *   `manuallyMarkedPaidByMemberId` (identifies the operator who acted).
 *
 * public."FamilyGroupMember"  (aliases mine, fgm)
 *   PROJECTED
 *     id                    E3 relationRef (leg A only)
 *     joinedAt              E3 joinedAtUtc (leg A only)
 *   [PREDICATE] NEVER PROJECTED
 *     familyGroupId         E3 the self-join that finds the member's groups
 *     memberId              E3 the self-join and the entry's `WHERE`
 *   There is nothing else on this relation. It has NO role column — see E3.
 *
 * public."FamilyGroup"  (alias fg)
 *   PROJECTED
 *     id                    E3 familyGroupRef (also the join key)
 *     name                  E3 familyGroupName — member-supplied free text, stripped
 *                           and bounded by `personNameOrNull`
 *   NOT READ: `createdAt`, `updatedAt`, `billingMembershipId` — the group's own
 *   lifecycle is not a member question, and the billing-membership pointer is a
 *   finance fact this pack has no entry for.
 *
 * public."Booking"  (alias b)
 *   PROJECTED
 *     id, lodgeId, status, checkIn, checkOut, finalPriceCents, deletedAt, createdAt
 *                                                                        all E4
 *   [PREDICATE] NEVER PROJECTED
 *     memberId              E4 — `= $1` on the OWNER leg, `<> $1` on the GUEST leg
 *   Every one of these is already granted for `booking_search`; E4 adds no new
 *   `Booking` column. NOT READ by E4: `notes`, `adminReviewNotes`,
 *   `memberReviewJustification`, `deletedReason`, `adultMemberHostingReview` (a
 *   frozen policy JSON blob) and every `*ById` actor column.
 *
 * public."BookingGuest"  (aliases g, gm, gp)
 *   [PREDICATE] NEVER PROJECTED — no COLUMN VALUE from this relation leaves this
 *   module. One derived BOOLEAN does (`memberOperationallyPresent`), which is a
 *   predicate's answer rather than a column, on the same terms as
 *   `booking_party_state`'s `operationallyPresent`.
 *     bookingId             E4 the party-size subquery, the GUEST-leg `EXISTS` and
 *                           the presence lateral
 *     memberId              E4 the GUEST-leg `EXISTS` and the presence lateral.
 *                           NEW: `booking_search` reads only `bookingId`, so
 *                           `memberId` is this module's one addition to the
 *                           `BookingGuest` grant.
 *     consentStatus         E4 the canonical operational-presence predicate. Already
 *                           granted for `booking_party_state`, which both projects
 *                           it and precomputes the same predicate, so this adds no
 *                           column to the allowlist — only a second reader.
 *   NOT READ: `firstName`, `lastName` (a guest's name is the booking pack's
 *   business, under `bookings:view`, not a membership answer), `ageTier`,
 *   `priceCents`, the other `consent*` columns (`consentRequestedAt`,
 *   `consentRespondedAt`, `consentRespondedByMemberId`, `consentExpiresAt`),
 *   `arrivedAt`, `departedAt`.
 *
 * public."Lodge"  (alias l)
 *   PROJECTED
 *     name                  E4 lodgeName
 *   [PREDICATE] NEVER PROJECTED
 *     id                    E4 the LEFT JOIN key (E4 projects `Booking."lodgeId"`,
 *                           not `Lodge."id"`, so the two agree by construction)
 *   Both already granted for `booking_search`.
 *
 * public."AuditLog"  (alias a)
 *   PROJECTED
 *     id, action, category, severity, outcome, entityType, createdAt      all E5
 *   [PREDICATE] NEVER PROJECTED
 *     entityId              E5 — matched against an id the caller already supplied
 *   Every one of these is already granted (AID-6A, plus `entityId` from AID-6C);
 *   E5 adds nothing. Still ungranted and still not read: `memberId`,
 *   `actorMemberId`, `subjectMemberId`, `summary`, `details`, `metadata`,
 *   `ipAddress`, `userAgent`.
 *   GRANTED BUT NOT READ, one column: `requestId`. AID-6A granted it for the five
 *   correlation entries that project it as their correlation key; E5 does not read
 *   it, so a future field here would need no grant change — and `tools/render.ts`
 *   flags it as verbatim client header text, which is why that matters.
 *
 * ---------------------------------------------------------------------------
 * TWO PROPERTIES THAT ARE PROPERTIES OF THE CODE
 * ---------------------------------------------------------------------------
 *
 * NO PATTERN LANGUAGE. Every predicate in this module is `=`, `<>`, `IS NULL`,
 * `IS NOT NULL` or `= ANY(array)`. There is no `LIKE`, no `ILIKE`, no `SIMILAR TO`,
 * no regex operator and no `starts_with` here, so a wildcard character in an
 * argument has nothing to mean — and every argument is an exact record id or a key
 * from a closed server-owned map anyway.
 *
 * ADR-004's PER-INVOCATION OPT-IN FOR PERSONAL DATA IS DECLARED BUT NOT YET
 * IMPLEMENTED. `surfacesPersonalData` is set truthfully on every entry below, and
 * it is recorded as a prerequisite on #2378. Until #2378 lands it is a DECLARATION
 * and not a control, so nothing in this module leans on it: what actually bounds
 * this pack is the AND-ed area check, the fixed statements, the column grant, the
 * per-session call ceiling and the audit row — and that is stated here so a later
 * reader does not mistake the flag for a gate.
 */

import "server-only";

import { z } from "zod";

import { auditCategoriesForCorrelationDomain } from "@/lib/audit-categories";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";
import {
  AID6B_BYTE_LIMIT,
  AID6B_DESCRIPTION_TAIL,
  AID6B_HISTORY_ROW_LIMIT,
  AID6B_SCOPE_TAIL,
  AID6B_SINGLE_ROW_BYTE_LIMIT,
  AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE,
  aid6bRecordAuditReaderAreas,
  dateOnly,
  dateOnlyOrNull,
  deletedAccountEmailMarkerSql,
  emailOrNull,
  nullableBoolOf,
  personNameOrNull,
} from "./booking-shared";
import {
  RECORD_ID,
  boolOf,
  centsOrZero,
  countOf,
  instantOrNull,
  providerRefOrNull,
  recordRefOrNull,
  stableCodeOrNull,
  utcInstant,
} from "./finance-shared";

export const DIAGNOSTICS_MEMBER_SUMMARY_TOOL_ID =
  "diagnostics.member_diagnostic_summary";
export const DIAGNOSTICS_MEMBER_SUBSCRIPTION_STATE_TOOL_ID =
  "diagnostics.member_subscription_state";
export const DIAGNOSTICS_MEMBER_FAMILY_STATE_TOOL_ID =
  "diagnostics.member_family_state";
export const DIAGNOSTICS_MEMBER_BOOKING_SUMMARY_TOOL_ID =
  "diagnostics.member_booking_summary";
export const DIAGNOSTICS_MEMBER_AUDIT_HISTORY_TOOL_ID =
  "diagnostics.member_record_audit_history";

/**
 * One member id, and nothing else. The shape four of these five entries take, and
 * `{}` does not parse for any of them: every entry in this pack requires its
 * argument, so there is no blank call that lists records.
 */
const memberIdArgsSchema = z.object({ memberId: RECORD_ID }).strict();
type MemberIdArgs = z.infer<typeof memberIdArgsSchema>;

const memberIdInputSchema = {
  type: "object" as const,
  properties: {
    memberId: {
      type: "string",
      description:
        "The EXACT member record id, as returned by diagnostics.member_search. Not an email address, not a name, and not a Xero contact id.",
    },
  },
  required: ["memberId"],
  additionalProperties: false as const,
};

// ---------------------------------------------------------------------------
// 1. The member's own stored identity and lifecycle state.
// ---------------------------------------------------------------------------

/**
 * ONE ROW: who this member is and what state their membership is in.
 *
 * THIS IS THE ONE PLACE IN THE WHOLE PACK THAT RETURNS AN EMAIL ADDRESS. #2376
 * authorises it by name as evidence for an explicitly SELECTED record, so it is
 * returned for exactly one member the operator already identified — and a SEARCH
 * returns only whether an address is on file (`member_search`'s `hasEmail`), never
 * the value, so a harvested page of search rows is a list of names and never a list
 * of contactable addresses. `emailOrNull` re-validates the column on the way out
 * rather than trusting it: `Member."email"` is stored as entered, nothing
 * normalises it, and a value carrying `;` or `=` would forge a field in the
 * rendered evidence block. It is deliberately NOT lower-cased — an operator
 * comparing the stored address against what the member told them needs the stored
 * form, and case-folding it would hide the mismatch that is sometimes the answer.
 *
 * THE PHONE NUMBER IS A BOOLEAN, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
 * `hasPhone` says whether a number is on file; the number itself is granted as a
 * `member_search` PREDICATE — the operator typed it in, so they already hold it —
 * and is projected by nothing. THE REJECTED ALTERNATIVE was to project it here
 * alongside the email, on the reasoning that #2376 authorises "contact details" and
 * one selected record cannot be harvested. It was rejected because the email
 * address is what an officer needs to answer the questions this pack exists for
 * ("the member says they never got the confirmation", "which account did they log
 * in as") and the phone number answers none of them, so the number is cost with no
 * diagnostic benefit. `hasPhone` uses `phoneNumber IS NOT NULL AND <> ''` — the
 * SAME test as `member_search`'s `has_phone` and as the application's own
 * `formatMemberPhone`, which returns null on a missing `phoneNumber` — so the
 * search and the summary can never disagree about whether a member is reachable.
 *
 * NO DATE OF BIRTH IS PROJECTED AND NONE IS GRANTED. Age-based eligibility in this
 * platform is decided on `ageTier`, not on an age computed from a birth date:
 * `AgeTierSetting` keys `subscriptionRequiredForBooking` on the tier,
 * `BookingGuest` stores the tier on the guest row, and
 * `participantQualifiesAsHost` (`src/lib/policies/adult-member-hosting.ts`) reads
 * the tier. So the TIER is the authoritative fact, and the birth date is not needed
 * to report eligibility or to explain a refusal.
 * `admin-family-group-member-search.ts` sets the same precedent already: it returns
 * a calculated age LABEL to an administrator and never the date. A model handed a
 * birth date would also volunteer an age, which is a second, derived claim this
 * pack has no need to make.
 *
 * THERE IS NO MEMBER NUMBER IN THIS SCHEMA, so no such field is reported. `Member`
 * carries a cuid `id`, an `email` and a `xeroContactId`; a grep of the whole tree
 * for `memberNumber`/`membershipNumber` finds no column, only one comment in
 * `member-merge.ts`. A member who quotes "their membership number" is quoting
 * something else — a Xero contact number or an invoice number, both finance
 * records — and the scope line says so, because a tool that invented the field
 * would have a model tell an officer to read a number off a card the club has never
 * issued.
 *
 * `lifecycle_deleted` IS THE MOST IMPORTANT DERIVED COLUMN HERE, and the reason is
 * specific. An ANONYMISED (erased) account is `active = false` with `cancelledAt`
 * NULL and `archivedAt` NULL, because erasure stamps NEITHER instant — so a naive
 * three-column read reports an erased member as merely "Inactive", and a model shown
 * that will tell an officer to reactivate an account that no longer has a person
 * behind it. The flag exists to close that.
 *
 * IT WAS THAT THREE-COLUMN SHAPE ITSELF UNTIL #2679's REVIEW, and that was the same
 * error pointing the other way. Ordinary bulk DEACTIVATION is `active = false` with
 * neither instant too — it is reversible and routine — so a shape test reported
 * every deactivated member as possibly erased. Both mistakes send an officer to the
 * wrong action; erasure is defined by its MARKERS, never by the absence of other
 * markers. The column now runs `deletedAccountEmailMarkerSql`, the SQL half of the
 * platform's own `isDeletedAccountRecord` (`INV-LIFE-013`), keyed on the anonymised
 * address the deletion writes.
 *
 * SO `Member."email"` IS NOW A PREDICATE AS WELL AS A PROJECTION, and the grant
 * table above says so on its own row rather than leaving it to this paragraph.
 * `active`, `cancelledAt` and `archivedAt` no longer contribute to
 * `lifecycleDeleted` at all — they are read for their own projected fields and
 * nothing else. The reason to state it twice is a concrete trap: a later privacy
 * tightening that drops the email ADDRESS from this entry's projection (plausible —
 * `member_search` already refuses to project it) would look at a table attributing
 * the erasure marker to the three lifecycle columns, drop the `email` grant with the
 * field, and turn the marker into a runtime 42501 on the one entry whose whole point
 * is that erasure is not inferred from inactivity.
 * `diagnostics.member_eligibility_state` is the entry
 * that tests BOTH markers — it compares the sentinel password hash inside
 * PostgreSQL, a column this role is not granted — and gives the platform's own
 * authoritative lifecycle label.
 *
 * A BOOLEAN RATHER THAN THE XERO CONTACT ID, on purpose. `hasXeroContact` says a
 * link exists; the id itself is FINANCE evidence, and
 * `diagnostics.xero_contact_linkage` already returns it — under `finance:view` AND
 * `membership:view`, which is the pair of permissions a Xero identifier should cost.
 * Projecting it here would hand it to a `membership:view`-only officer and quietly
 * make that entry's second area check decorative.
 *
 * `legacy_family_group_ref` IS THE DEPRECATED COLUMN AND IS LABELLED AS SUCH.
 * `Member."familyGroupId"` is the legacy single-group pointer; `FamilyGroupMember`
 * is authoritative and a member may belong to more than one group, which is why
 * `Member."billingFamilyGroupId"` exists at all. It is projected because a stale or
 * disagreeing legacy pointer is a real cause of a real class of confusion, and the
 * scope line names `member_family_state` as the authority.
 *
 * `dependent_count` IS A `count(*)`, SO 0 MEANS "no member row points at this
 * member as a parent" and never "unknown". It counts BOTH parent links —
 * `parentMemberId = m."id" OR secondaryParentId = m."id"` — because a split family
 * records the second parent in the second column, and a count over the first alone
 * would report a co-parent as having no children.
 */
const MEMBER_SUMMARY_SQL = `SELECT
  m."id" AS member_ref,
  m."firstName" AS first_name,
  m."lastName" AS last_name,
  m."email" AS email_address,
  (m."phoneNumber" IS NOT NULL AND m."phoneNumber" <> '') AS has_phone,
  m."ageTier"::text AS age_tier,
  m."active" AS is_active,
  m."canLogin" AS can_login,
  ${utcInstant('m."cancelledAt"')} AS cancelled_at_utc,
  ${utcInstant('m."archivedAt"')} AS archived_at_utc,
  ${deletedAccountEmailMarkerSql('m."email"')} AS lifecycle_deleted,
  ${dateOnly('m."joinedDate"')} AS joined_date,
  ${dateOnly('m."lifeMemberDate"')} AS life_member_date,
  m."requiresInduction" AS requires_induction,
  m."hutLeaderEligible" AS hut_leader_eligible,
  (m."xeroContactId" IS NOT NULL) AS has_xero_contact,
  m."parentMemberId" AS parent_member_ref,
  m."secondaryParentId" AS secondary_parent_ref,
  m."familyGroupId" AS legacy_family_group_ref,
  m."billingFamilyGroupId" AS billing_family_group_ref,
  (SELECT pg_catalog.count(*)::int
     FROM public."Member" d
    WHERE d."parentMemberId" = m."id" OR d."secondaryParentId" = m."id") AS dependent_count,
  ${utcInstant('m."createdAt"')} AS created_at_utc,
  ${utcInstant('m."updatedAt"')} AS updated_at_utc
FROM public."Member" m
WHERE m."id" = $1::text`;

const memberSummary = defineDiagnosticsTool<MemberIdArgs>({
  id: DIAGNOSTICS_MEMBER_SUMMARY_TOOL_ID,
  source: "select_only_sql",
  label: "Member diagnostic summary",
  description: `Returns everything this platform has stored about ONE member's identity and membership lifecycle: the record id, the given and family name, the email address, whether a phone number is on file, the age tier, whether the account is active and can log in, the cancellation and archival instants, whether the row has the shape of an ERASED account, the joined and life-member dates, whether an induction is required of them, whether they are hut-leader eligible, whether a Xero contact is linked, the parent and secondary-parent record ids, the legacy and billing family-group ids, how many dependents point at them, and when the record was created and last changed. Use it after finding a member. It returns NO date of birth, NO address, NO phone number, NO gender or occupation, NO password, two-factor or login-history state, NO private comments and NO cancellation or archival reason: none of those is granted to the diagnostics database role, so the database itself refuses them. There is NO member number in this platform — the record id, the email address and the Xero contact link are the identifiers it has. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["membership"],
  evidenceScope: `The stored identity and lifecycle state of ONE member record. The email address is returned here and NOWHERE else in these tools, because this member was explicitly selected; a member SEARCH reports only whether an address is on file. The phone number is never returned by any of these tools at all — only whether one is recorded. No date of birth is stored in the evidence returned and none can be read: age-based eligibility in this platform is decided on the AGE TIER, which is reported, so answer age questions from the tier and never from an age you calculated. This platform records NO member number, so a member quoting one is quoting a Xero contact number or an invoice number, which are finance records these tools do not search. lifecycleDeleted is TRUE only when this record carries the anonymisation marker an approved deletion writes, so it means the account was ERASED: there is no longer a person behind it, and you must never suggest reactivating or contacting them. It is NOT an inference from inactivity, and an inactive, cancelled or archived member is a reversible administrative state for which lifecycleDeleted is FALSE — read isActive, cancelledAtUtc and archivedAtUtc for those. diagnostics.member_eligibility_state tests both deletion markers and gives the platform's own authoritative lifecycle label. legacyFamilyGroupRef is the DEPRECATED single-group pointer on the member row: diagnostics.member_family_state is authoritative for family membership, and the two disagreeing is itself a finding. hasXeroContact says only that a link exists; the Xero contact id is finance evidence and needs diagnostics.xero_contact_linkage, which requires finance access as well. joinedDate and lifeMemberDate are calendar days taken from stored timestamps, not lodge nights. updatedAtUtc is when ANY column on this row last changed and is NOT when anything was verified. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: memberIdArgsSchema,
  inputSchema: memberIdInputSchema,
  sql: MEMBER_SUMMARY_SQL,
  bind: (args) => [args.memberId],
  project: (row) => ({
    memberRef: recordRefOrNull(row.member_ref) ?? "",
    firstName: personNameOrNull(row.first_name),
    lastName: personNameOrNull(row.last_name),
    email: emailOrNull(row.email_address),
    hasPhone: boolOf(row.has_phone),
    ageTier: stableCodeOrNull(row.age_tier),
    isActive: boolOf(row.is_active),
    canLogin: boolOf(row.can_login),
    cancelledAtUtc: instantOrNull(row.cancelled_at_utc),
    archivedAtUtc: instantOrNull(row.archived_at_utc),
    lifecycleDeleted: boolOf(row.lifecycle_deleted),
    joinedDate: dateOnlyOrNull(row.joined_date),
    lifeMemberDate: dateOnlyOrNull(row.life_member_date),
    requiresInduction: boolOf(row.requires_induction),
    hutLeaderEligible: boolOf(row.hut_leader_eligible),
    hasXeroContact: boolOf(row.has_xero_contact),
    parentMemberRef: recordRefOrNull(row.parent_member_ref),
    secondaryParentRef: recordRefOrNull(row.secondary_parent_ref),
    familyGroupRef: recordRefOrNull(row.legacy_family_group_ref),
    billingFamilyGroupRef: recordRefOrNull(row.billing_family_group_ref),
    dependentCount: countOf(row.dependent_count),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  }),
  rowLimit: 1,
  byteLimit: AID6B_SINGLE_ROW_BYTE_LIMIT,
  // Twenty-three fields, one under the substrate's 24-field per-row cap
  // (`DIAGNOSTICS_TOOL_BOUNDS.maxFieldsPerRow`, enforced by `projectRows` in
  // `invoke.ts`, which throws and discards the WHOLE result on the 25th). Nothing
  // may be added here without something being removed; the next field to go would
  // be `hutLeaderEligible`, which has its own answer in the lodge tools.
  //
  // A name, an email address and a member id. ADR-004's per-invocation opt-in
  // applies — DECLARED, not yet implemented (#2378).
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 2. The member's stored subscription rows, newest season first.
// ---------------------------------------------------------------------------

/**
 * Six seasons. `MemberSubscription` is `@@unique([memberId, seasonYear])`, so a row
 * IS a season and six rows are six seasons — the current one plus five back, which
 * covers every "have they paid, and since when" question an officer asks while
 * keeping the entry small enough that a truncation means something.
 */
const MEMBER_SUBSCRIPTION_ROW_LIMIT = 6;

/**
 * ONE ROW PER SEASON: the STORED subscription record, and nothing derived.
 *
 * `has_xero_invoice` is a BOOLEAN over a column granted so it can be TESTED and
 * never returned: the Xero invoice id is finance evidence and
 * `diagnostics.payment_diagnostic_summary` returns it under `finance:view`. The
 * operator's manual-payment NOTE is not granted at all and no flag reports whether
 * one exists — #2376 refuses operator free text, and a column privilege that exists
 * only to power a boolean still makes every note in the club readable to anybody
 * holding the credential. `manuallyMarkedPaidAtUtc` already carries the
 * diagnostically useful half: this row was settled by hand.
 *
 * `void_generation` is #2147's monotonic re-bill discriminator. It is projected
 * because a non-zero value is the only stored evidence that this season's Xero
 * invoice was VOIDED or DELETED and the coverage claim released — which is the
 * actual explanation for the "they were invoiced twice" question — and 0 means
 * "never voided", not "unknown", because the column is `Int @default(0)` and NOT
 * NULL.
 *
 * `ORDER BY s."seasonYear" DESC, s."id" ASC` is total: the unique index on
 * `(memberId, seasonYear)` makes the season unique within one member's rows
 * already, and the id tiebreaker is there so the order stays total if that
 * constraint is ever relaxed rather than depending on it.
 */
const MEMBER_SUBSCRIPTION_STATE_SQL = `SELECT
  s."id" AS subscription_ref,
  s."seasonYear" AS season_year,
  s."status"::text AS subscription_status,
  s."xeroInvoiceNumber" AS xero_invoice_number,
  (s."xeroInvoiceId" IS NOT NULL) AS has_xero_invoice,
  ${utcInstant('s."paidAt"')} AS paid_at_utc,
  ${utcInstant('s."manuallyMarkedPaidAt"')} AS manually_marked_paid_at_utc,
  s."voidGeneration" AS void_generation,
  ${utcInstant('s."createdAt"')} AS created_at_utc,
  ${utcInstant('s."updatedAt"')} AS updated_at_utc
FROM public."MemberSubscription" s
WHERE s."memberId" = $1::text
ORDER BY s."seasonYear" DESC, s."id" ASC`;

const memberSubscriptionState = defineDiagnosticsTool<MemberIdArgs>({
  id: DIAGNOSTICS_MEMBER_SUBSCRIPTION_STATE_TOOL_ID,
  source: "select_only_sql",
  label: "Member subscription rows by season",
  description: `Returns ONE member's stored membership-subscription rows, newest season first, at most ${MEMBER_SUBSCRIPTION_ROW_LIMIT}. Each row carries the subscription record id, the season year, the stored status (NOT_INVOICED, NOT_REQUIRED, UNPAID, PAID or OVERDUE), the Xero invoice NUMBER, whether a Xero invoice is linked at all, when it was paid, when it was manually marked paid, the void generation, and when the row was created and last changed. This is the STORED ROW and not the platform's verdict on whether the member owes a subscription: use diagnostics.member_eligibility_state for that. NOT_INVOICED means nobody has billed them yet, which is NOT the same as unpaid; NOT_REQUIRED and PAID both mean settled but for entirely different reasons. It returns no online invoice link, no manual-payment note text and nobody's name. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["membership"],
  evidenceScope: `The STORED subscription rows for ONE member, at most ${MEMBER_SUBSCRIPTION_ROW_LIMIT} seasons, newest first. This is NOT the authoritative answer to "does this member owe a subscription". That answer is a conjunction of three things: this row's status, the member's membership TYPE for that season (SeasonalMembershipAssignment resolving to MembershipType.subscriptionBehavior, which can make a subscription REQUIRED, NOT_REQUIRED or covered by a family) and the age-tier rule (AgeTierSetting.subscriptionRequiredForBooking) — and diagnostics.member_eligibility_state returns the platform's own computed verdict over all three. Report this row as the stored record and defer the verdict to that tool. The status values are not interchangeable: NOT_INVOICED means nobody has billed this member for that season yet, which is NOT unpaid and NOT a debt; NOT_REQUIRED and PAID both mean "settled", but one means "the rule never asked" and the other means "money arrived", and telling an officer the wrong one sends them to the wrong screen. A subscription with manuallyMarkedPaidAtUtc set was settled OUTSIDE the Xero pipeline — cash, or a bank transfer reconciled by hand — so it has no Xero payment to look up and nothing to reverse in Xero. Whether an operator wrote down WHY is not reported: the note is operator free text and the diagnostics credential cannot read it. A non-zero voidGeneration means this season's Xero invoice was voided or deleted at least once and the coverage claim released, which is the usual explanation for an apparent double invoice. A member with no rows at all has never had a subscription record created, which is a different fact from having an unpaid one. Subscription MONEY — invoices, payments, credit — is finance evidence and needs the finance tools. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: memberIdArgsSchema,
  inputSchema: memberIdInputSchema,
  sql: MEMBER_SUBSCRIPTION_STATE_SQL,
  bind: (args) => [args.memberId],
  project: (row) => ({
    subscriptionRef: recordRefOrNull(row.subscription_ref) ?? "",
    // `countOf` is the pack's non-negative-integer projector. A season year is not
    // a count, but it is exactly that shape, and using the shared helper keeps a
    // `bigint`-as-string or a non-finite value from reaching the model as a year.
    seasonYear: countOf(row.season_year),
    subscriptionStatus: stableCodeOrNull(row.subscription_status),
    xeroInvoiceNumber: providerRefOrNull(row.xero_invoice_number),
    hasXeroInvoice: boolOf(row.has_xero_invoice),
    paidAtUtc: instantOrNull(row.paid_at_utc),
    manuallyMarkedPaidAtUtc: instantOrNull(row.manually_marked_paid_at_utc),
    voidGeneration: countOf(row.void_generation),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  }),
  rowLimit: MEMBER_SUBSCRIPTION_ROW_LIMIT,
  byteLimit: AID6B_BYTE_LIMIT,
  // TEN fields. No name, no email address, no operator identity and no free
  // text — but the entry is keyed on a member id the caller supplied, and a
  // subscription row is a fact about a person's membership standing, so the
  // declaration is true and the opt-in applies (DECLARED, not yet implemented,
  // #2378).
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 3. The member's family relationships, as one uniform row shape.
// ---------------------------------------------------------------------------

/**
 * Twenty rows of family relationship. A real family group is a couple plus their
 * children; twenty covers a blended household with two groups and every dependent
 * either parent has, and a member whose relationships exceed it is reported as
 * truncated with Admin > Family Groups named as the next step.
 */
const MEMBER_FAMILY_ROW_LIMIT = 20;

/**
 * THREE KINDS OF FAMILY RELATIONSHIP IN ONE UNIFORM ROW SHAPE, because they answer
 * one question and a model handed three differently-shaped results will compare
 * them wrongly.
 *
 *   FAMILY_GROUP_CO_MEMBER  every OTHER member of every group this member is in
 *   PARENT                  this member's parentMemberId / secondaryParentId
 *   DEPENDENT               every member whose parent link points HERE
 *
 * FIVE `UNION ALL` ARMS, NOT THREE, and the extra two are a correctness fix rather
 * than a style. The PARENT and DEPENDENT legs are each split into a primary-link
 * arm and a secondary-link arm so `is_secondary_parent` says WHICH column carried
 * the link. A single arm joined on `p."id" = me."parentMemberId" OR p."id" =
 * me."secondaryParentId"` collapses to ONE row when both columns name the same
 * member, and any expression computing the flag from that row has to pick a lie.
 * Two arms report the two facts.
 *
 * `relation_ref` MEANS DIFFERENT THINGS PER LEG, and that is stated on the entry
 * rather than hidden. For FAMILY_GROUP_CO_MEMBER it is the `FamilyGroupMember` join
 * row's own id — so the same co-member shared through two groups is two
 * distinguishable rows. For PARENT and DEPENDENT there is no join row at all (the
 * link is a column on `Member`), so it is the related member's own id and equals
 * `related_member_ref`. It is an EVIDENCE REFERENCE — the stable identity of this
 * row for the audit hash and for an operator quoting it back — and never a join key
 * to hand to another tool. The tool to hand a member id to is
 * `related_member_ref`.
 *
 * THE LEG-A SELF-JOIN CANNOT DUPLICATE A ROW, and the reason is a database
 * constraint rather than an argument: `FamilyGroupMember` is
 * `@@unique([familyGroupId, memberId])`, so `mine` matches at most one row per
 * group and the join fans out only over the group's OTHER members.
 *
 * THE `ORDER BY` IS TOTAL ACROSS THE UNION, and it needs six keys to be. The four
 * #2376 asks for — kind, family name, given name, related member id — are NOT total
 * on their own: leg A can return the same co-member twice (two shared groups) and
 * legs B and C can return the same member twice (both parent columns), and both
 * pairs tie on all four. Adding `is_secondary_parent` then `relation_ref` makes
 * `(relation_kind, is_secondary_parent, relation_ref)` unique across the whole
 * union, so identical evidence hashes identically for the audit trail. The
 * ordering keys are OUTPUT COLUMN NAMES because a set operation's `ORDER BY` cannot
 * see the input relations. `related_last_name` and `related_first_name` are NOT
 * NULL on `Member`, so no null-ordering rule is load-bearing.
 */
const MEMBER_FAMILY_STATE_SQL = `SELECT
  fgm."id" AS relation_ref,
  'FAMILY_GROUP_CO_MEMBER'::text AS relation_kind,
  rm."id" AS related_member_ref,
  rm."firstName" AS related_first_name,
  rm."lastName" AS related_last_name,
  rm."ageTier"::text AS related_age_tier,
  rm."active" AS related_is_active,
  (rm."cancelledAt" IS NOT NULL) AS related_is_cancelled,
  (rm."archivedAt" IS NOT NULL) AS related_is_archived,
  fg."id" AS family_group_ref,
  fg."name" AS family_group_name,
  ${utcInstant('fgm."joinedAt"')} AS joined_at_utc,
  NULL::boolean AS is_secondary_parent
FROM public."FamilyGroupMember" mine
JOIN public."FamilyGroupMember" fgm ON fgm."familyGroupId" = mine."familyGroupId"
JOIN public."FamilyGroup" fg ON fg."id" = fgm."familyGroupId"
JOIN public."Member" rm ON rm."id" = fgm."memberId"
WHERE mine."memberId" = $1::text AND fgm."memberId" <> $1::text
UNION ALL
SELECT
  p."id" AS relation_ref,
  'PARENT'::text AS relation_kind,
  p."id" AS related_member_ref,
  p."firstName" AS related_first_name,
  p."lastName" AS related_last_name,
  p."ageTier"::text AS related_age_tier,
  p."active" AS related_is_active,
  (p."cancelledAt" IS NOT NULL) AS related_is_cancelled,
  (p."archivedAt" IS NOT NULL) AS related_is_archived,
  NULL::text AS family_group_ref,
  NULL::text AS family_group_name,
  NULL::text AS joined_at_utc,
  false AS is_secondary_parent
FROM public."Member" me
JOIN public."Member" p ON p."id" = me."parentMemberId"
WHERE me."id" = $1::text
UNION ALL
SELECT
  p2."id" AS relation_ref,
  'PARENT'::text AS relation_kind,
  p2."id" AS related_member_ref,
  p2."firstName" AS related_first_name,
  p2."lastName" AS related_last_name,
  p2."ageTier"::text AS related_age_tier,
  p2."active" AS related_is_active,
  (p2."cancelledAt" IS NOT NULL) AS related_is_cancelled,
  (p2."archivedAt" IS NOT NULL) AS related_is_archived,
  NULL::text AS family_group_ref,
  NULL::text AS family_group_name,
  NULL::text AS joined_at_utc,
  true AS is_secondary_parent
FROM public."Member" me2
JOIN public."Member" p2 ON p2."id" = me2."secondaryParentId"
WHERE me2."id" = $1::text
UNION ALL
SELECT
  d."id" AS relation_ref,
  'DEPENDENT'::text AS relation_kind,
  d."id" AS related_member_ref,
  d."firstName" AS related_first_name,
  d."lastName" AS related_last_name,
  d."ageTier"::text AS related_age_tier,
  d."active" AS related_is_active,
  (d."cancelledAt" IS NOT NULL) AS related_is_cancelled,
  (d."archivedAt" IS NOT NULL) AS related_is_archived,
  NULL::text AS family_group_ref,
  NULL::text AS family_group_name,
  NULL::text AS joined_at_utc,
  false AS is_secondary_parent
FROM public."Member" d
WHERE d."parentMemberId" = $1::text
UNION ALL
SELECT
  d2."id" AS relation_ref,
  'DEPENDENT'::text AS relation_kind,
  d2."id" AS related_member_ref,
  d2."firstName" AS related_first_name,
  d2."lastName" AS related_last_name,
  d2."ageTier"::text AS related_age_tier,
  d2."active" AS related_is_active,
  (d2."cancelledAt" IS NOT NULL) AS related_is_cancelled,
  (d2."archivedAt" IS NOT NULL) AS related_is_archived,
  NULL::text AS family_group_ref,
  NULL::text AS family_group_name,
  NULL::text AS joined_at_utc,
  true AS is_secondary_parent
FROM public."Member" d2
WHERE d2."secondaryParentId" = $1::text
ORDER BY "relation_kind" ASC, "related_last_name" ASC, "related_first_name" ASC, "related_member_ref" ASC, "is_secondary_parent" ASC, "relation_ref" ASC`;

const memberFamilyState = defineDiagnosticsTool<MemberIdArgs>({
  id: DIAGNOSTICS_MEMBER_FAMILY_STATE_TOOL_ID,
  source: "select_only_sql",
  label: "Member family relationships",
  description: `Returns ONE member's family relationships as a single list, at most ${MEMBER_FAMILY_ROW_LIMIT} rows. Every row carries the same fields, with relationKind saying which kind it is: FAMILY_GROUP_CO_MEMBER (another member of a family group this member belongs to), PARENT (a member this member's parent link points at) or DEPENDENT (a member whose parent link points at this member). Each row carries an evidence reference, the related member's record id, given and family name, age tier and whether they are active, cancelled or archived; family-group rows also carry the group id, the group name and when the related member joined it; parent and dependent rows carry whether the link is the SECONDARY parent column. There is NO "role in the family group" to report: the join table has no role column, so every adult login co-member of a group is equal. Use it to see who is connected to a member and how. It returns nothing from family JOIN REQUESTS — no requester messages and no children's dates of birth. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["membership"],
  evidenceScope: `ONE member's family relationships — family-group co-members, their parents, and their dependents — at most ${MEMBER_FAMILY_ROW_LIMIT} rows in one uniform shape. FamilyGroupMember has NO role column: in the schema's own words, "NO role FIELD, AND NO role COLUMN. Membership in a group is the only fact this table records: family-group membership carries no rank, and every adult login co-member of a group is equal." The column was physically dropped by the contract migration 20260803030000_contract_drop_family_group_member_role, so do NOT report a "role in the family group", a "head of family" or a "primary member" of a group — there is not one, and inventing one would misdescribe who may act for whom. Member.familyGroupId is a DEPRECATED legacy single-group pointer; this join table is authoritative, and a member may belong to MORE THAN ONE group, which is why Member.billingFamilyGroupId exists to pick which family's fee covers them. The parent link permits at most TWO parents (a primary and a secondary column on the member row), so a member with two PARENT rows has both columns set and a third parent cannot exist. The authoritative answer to "may X be a guest on Y's booking as family" is the booker PLUS every co-member of all the booker's family groups (computeMemberGuestBoundary in src/lib/booking-guests.ts, over getAllowedGuestMemberIds) — a parent or dependent link is NOT itself that boundary. These rows let you compute that set; they do not decide it, so present it as evidence and name the booking screen for the decision. relationRef means different things per row kind: for a family-group row it is the join row's id, and for a parent or dependent row it is the related member's own id. It is an evidence reference for quoting this row, never a key to pass to another tool — pass relatedMemberRef. Nothing here comes from FamilyGroupJoinRequest, and nothing there is readable by any of these tools: those rows carry requester free text and children's dates of birth, so a question about a pending family request has to go to Admin > Family Groups. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: memberIdArgsSchema,
  inputSchema: memberIdInputSchema,
  sql: MEMBER_FAMILY_STATE_SQL,
  // ONE parameter, referenced by all five arms. `readSqlPlaceholderNumbers`
  // collects the SET of placeholders, so referencing `$1` seven times is still an
  // arity of one — and the executor appends the row cap as `$2`, which is why this
  // must never grow a second parameter without the SQL growing a `$2` of its own.
  bind: (args) => [args.memberId],
  project: (row) => ({
    relationRef: recordRefOrNull(row.relation_ref) ?? "",
    relationKind: stableCodeOrNull(row.relation_kind) ?? "",
    relatedMemberRef: recordRefOrNull(row.related_member_ref) ?? "",
    relatedFirstName: personNameOrNull(row.related_first_name),
    relatedLastName: personNameOrNull(row.related_last_name),
    relatedAgeTier: stableCodeOrNull(row.related_age_tier),
    relatedIsActive: boolOf(row.related_is_active),
    relatedIsCancelled: boolOf(row.related_is_cancelled),
    relatedIsArchived: boolOf(row.related_is_archived),
    familyGroupRef: recordRefOrNull(row.family_group_ref),
    familyGroupName: personNameOrNull(row.family_group_name),
    joinedAtUtc: instantOrNull(row.joined_at_utc),
    // `boolOf` returns FALSE for a null, and here that would be a lie: a
    // family-group row has no parent link, so "not the secondary parent" is not a
    // fact about it. Null stays null, and the field's shape is still fixed across
    // every row because the key is always present.
    isSecondaryParent:
      row.is_secondary_parent === null || row.is_secondary_parent === undefined
        ? null
        : boolOf(row.is_secondary_parent),
  }),
  rowLimit: MEMBER_FAMILY_ROW_LIMIT,
  byteLimit: AID6B_BYTE_LIMIT,
  // Names, member ids and a member-supplied family-group name on every row.
  // ADR-004's per-invocation opt-in applies (DECLARED, not yet implemented, #2378).
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 4. The member's recent booking involvement. BOTH areas, AND-ed.
// ---------------------------------------------------------------------------

/**
 * THE ONE ENTRY IN THIS MODULE THAT SPANS TWO DOMAINS, and therefore the one that
 * requires two areas.
 *
 * It combines membership evidence (which member) with booking evidence (their
 * bookings), which is exactly the combination the epic says requires every relevant
 * area, AND-ed — so `requiredAreas` is `["membership", "bookings"]` and the executor
 * re-reads both on every invocation. `xero_contact_linkage` in the finance pack is
 * the same shape for the same reason.
 *
 * IT IS A SEPARATE ENTRY RATHER THAN ONE MORE VALUE IN AN ENUM ON ENTRY 1, and that
 * is forced rather than chosen: `requiredAreas` is fixed on the entry and
 * `invoke.ts` authorizes BEFORE it parses arguments, so an argument can never move a
 * call between permission sets. A `member_diagnostic_summary` with an
 * `include: "bookings"` option would have to declare both areas always — locking a
 * Membership Officer out of the identity half they are entitled to — or one area,
 * which would hand a member's booking history to an officer with no booking access.
 *
 * TWO `UNION ALL` LEGS, DISJOINT BY CONSTRUCTION. The OWNER leg is
 * `Booking."memberId" = $1`; the GUEST leg is `Booking."memberId" <> $1` plus an
 * `EXISTS` over a `BookingGuest` row naming this member. `Booking."memberId"` is NOT
 * NULL in this schema, so `<>` cannot silently drop a row to three-valued logic, and
 * the two predicates partition the relation — which is what makes `booking_ref` a
 * total tiebreaker across the whole union.
 *
 * `guest_count` IS THE WHOLE PARTY, not this member's rows in it. It is a
 * `count(*)` over every `BookingGuest` row on the booking, so 0 means the booking
 * has no guest rows at all rather than "unknown", and it is the same subquery
 * `booking_search` uses so the two entries can never disagree about a party size.
 *
 * NO `BookingGuest` COLUMN VALUE IS PROJECTED. Its three granted columns are read
 * as predicates only. A guest's name is booking-pack evidence under
 * `bookings:view`, and returning the party here would make this entry a second,
 * drifting answer to the party question `diagnostics.booking_party_state` owns.
 *
 * `member_operationally_present` IS THE ONE THING THAT CROSSES, and it is a
 * predicate's ANSWER rather than a column. The entry used to report `involvement:
 * 'GUEST'` from a bare `EXISTS` over `BookingGuest`, with nothing on the row and
 * nothing in the scope line about consent — so a member who was invited as a
 * cross-family member guest and DECLINED was reported as a guest on that booking.
 * Those rows survive: `member-guest-consent.ts` states in as many words that a
 * PENDING row "holds a bed (D-4) and nothing else" and that a DECLINED or EXPIRED
 * row which survived its removal attempt "is not an occupant either", and
 * `MEMBER_GUEST_CONSENT_SUB_STATES` enumerates both as reachable persisted states.
 * An officer asking "why is this member on that booking" or "were they there" was
 * being told they were a guest on it.
 *
 * The predicate is the platform's own, in SQL:
 * `OPERATIONALLY_PRESENT_GUEST_WHERE` is `consentStatus IS NULL OR consentStatus =
 * 'CONFIRMED'`, the same text `booking_party_state` precomputes, and NULL is the
 * dominant value forever — every non-member guest, every family-scope guest and
 * every pre-feature row carries one — so the naive `consentStatus <> 'PENDING'`
 * would be UNKNOWN for those rows and silently drop every ordinary guest.
 *
 * IT IS THREE-VALUED, on the same discipline as `booking_party_state`'s
 * `nightsAreContiguous`. NULL means this member holds NO guest row on the booking
 * at all, which is the ordinary shape of an OWNER who booked for other people — and
 * a `false` there would be a specific claim ("they are on the booking but not
 * present") that is simply untrue. The ROW SET is unchanged: a declined invitation
 * is still returned, because "why is this booking in their list" is exactly the
 * question being asked, and it is now answerable.
 */
const MEMBER_BOOKING_SUMMARY_SQL = `SELECT
  b."id" AS booking_ref,
  pg_catalog.upper(pg_catalog.left(b."id", 8)) AS booking_reference,
  'OWNER'::text AS involvement,
  b."lodgeId" AS lodge_ref,
  l."name" AS lodge_name,
  b."status"::text AS booking_status,
  ${dateOnly('b."checkIn"')} AS check_in,
  ${dateOnly('b."checkOut"')} AS check_out,
  (SELECT pg_catalog.count(*)::int
     FROM public."BookingGuest" g
    WHERE g."bookingId" = b."id") AS guest_count,
  b."finalPriceCents" AS final_price_cents,
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM public."BookingGuest" gp
       WHERE gp."bookingId" = b."id" AND gp."memberId" = $1::text
    ) THEN NULL::boolean
    ELSE EXISTS (
      SELECT 1 FROM public."BookingGuest" gp
       WHERE gp."bookingId" = b."id" AND gp."memberId" = $1::text
         AND (gp."consentStatus" IS NULL OR gp."consentStatus" = 'CONFIRMED')
    )
  END AS member_operationally_present,
  ${utcInstant('b."deletedAt"')} AS deleted_at_utc,
  ${utcInstant('b."createdAt"')} AS created_at_utc
FROM public."Booking" b
LEFT JOIN public."Lodge" l ON l."id" = b."lodgeId"
WHERE b."memberId" = $1::text
UNION ALL
SELECT
  b2."id" AS booking_ref,
  pg_catalog.upper(pg_catalog.left(b2."id", 8)) AS booking_reference,
  'GUEST'::text AS involvement,
  b2."lodgeId" AS lodge_ref,
  l2."name" AS lodge_name,
  b2."status"::text AS booking_status,
  ${dateOnly('b2."checkIn"')} AS check_in,
  ${dateOnly('b2."checkOut"')} AS check_out,
  (SELECT pg_catalog.count(*)::int
     FROM public."BookingGuest" g2
    WHERE g2."bookingId" = b2."id") AS guest_count,
  b2."finalPriceCents" AS final_price_cents,
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM public."BookingGuest" gp
       WHERE gp."bookingId" = b2."id" AND gp."memberId" = $1::text
    ) THEN NULL::boolean
    ELSE EXISTS (
      SELECT 1 FROM public."BookingGuest" gp
       WHERE gp."bookingId" = b2."id" AND gp."memberId" = $1::text
         AND (gp."consentStatus" IS NULL OR gp."consentStatus" = 'CONFIRMED')
    )
  END AS member_operationally_present,
  ${utcInstant('b2."deletedAt"')} AS deleted_at_utc,
  ${utcInstant('b2."createdAt"')} AS created_at_utc
FROM public."Booking" b2
LEFT JOIN public."Lodge" l2 ON l2."id" = b2."lodgeId"
WHERE b2."memberId" <> $1::text
  AND EXISTS (
    SELECT 1
      FROM public."BookingGuest" gm
     WHERE gm."bookingId" = b2."id" AND gm."memberId" = $1::text
  )
ORDER BY "check_in" DESC, "booking_ref" ASC`;

const memberBookingSummary = defineDiagnosticsTool<MemberIdArgs>({
  id: DIAGNOSTICS_MEMBER_BOOKING_SUMMARY_TOOL_ID,
  source: "select_only_sql",
  label: "Member recent booking involvement",
  description: `Returns the most recent bookings ONE member is involved in — at most ${AID6B_HISTORY_ROW_LIMIT}, LATEST NIGHTS FIRST — as either the OWNER of the booking or a GUEST on somebody else's. Each row carries the booking id and the eight-character booking reference, which involvement it is, the lodge id and name, the booking status, the check-in and check-out New Zealand nights, how many guests are on the booking in total, the final price in integer cents, whether this member is OPERATIONALLY PRESENT on it as a guest, and when the booking was deleted and created. Requires BOTH membership and booking access, because it joins who the member is to what they booked. It is a RECENT-INVOLVEMENT SUMMARY and NOT a complete history: never answer "how many bookings has this member had" from it, and never present its count as a total. For the booking's own detail — the party, the beds, the review state — use the booking tools with the booking id from here. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["membership", "bookings"],
  evidenceScope: `At most ${AID6B_HISTORY_ROW_LIMIT} bookings this member is involved in, LATEST NIGHTS FIRST. It is a recent-involvement summary and NOT a complete history: a member with more bookings than the cap has the older ones silently outside this result, which the truncation flag reports, so NEVER answer "how many bookings has this member had", "when did they first stay" or "have they ever stayed at X" from these rows — the count here is the number of rows returned and nothing more. A member appears as GUEST on somebody else's booking and as OWNER on their own, so the same person can legitimately appear in both involvements, and the same STAY can produce TWO rows when a split member/non-member party was stored as a parent booking plus a child booking. Soft-deleted bookings ARE included, with their deletion instant, because "the booking has vanished" is usually a question about exactly those rows — never describe a booking with a deletion instant as active. finalPriceCents is the booking's stored price in integer cents and says NOTHING about whether it was paid: an unpaid booking looks identical here to a paid one, and payment evidence needs finance access and the finance tools. guestCount is the size of the WHOLE party on that booking, not this member's part of it. INVOLVEMENT IS NOT ATTENDANCE, and memberOperationallyPresent is what settles it: involvement GUEST means only that a guest row on that booking names this member, and a member invited as a cross-family MEMBER GUEST who DECLINED, or who has not answered, or whose invitation EXPIRED, still has that row. memberOperationallyPresent is the platform's own presence predicate for this member's rows on that booking — true means at least one of their rows counts them as an occupant, false means none does (they were invited and are not coming, though a pending invitation may still be holding a bed), and null means they hold no guest row on that booking at all, which is the ordinary shape of an OWNER who booked for other people. So NEVER answer "was this member at the lodge" or "who was on this booking" from involvement alone: a false there means they did not accept, and reporting them as a guest on the booking would be wrong. Why the declined row is still returned: "why is this booking in their list" is exactly the question being asked, and the answer is on the row. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: memberIdArgsSchema,
  inputSchema: memberIdInputSchema,
  sql: MEMBER_BOOKING_SUMMARY_SQL,
  bind: (args) => [args.memberId],
  project: (row) => ({
    bookingRef: recordRefOrNull(row.booking_ref) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    involvement: stableCodeOrNull(row.involvement) ?? "",
    lodgeRef: recordRefOrNull(row.lodge_ref) ?? "",
    lodgeName: personNameOrNull(row.lodge_name),
    bookingStatus: stableCodeOrNull(row.booking_status),
    checkIn: dateOnlyOrNull(row.check_in) ?? "",
    checkOut: dateOnlyOrNull(row.check_out) ?? "",
    guestCount: countOf(row.guest_count),
    finalPriceCents: centsOrZero(row.final_price_cents),
    // THREE-VALUED, so `boolOrNull` and never `boolOf`: `boolOf` maps NULL to
    // `false`, which would turn "this member holds no guest row on this booking"
    // into the specific and untrue claim "they are on it but not present".
    memberOperationallyPresent: nullableBoolOf(row.member_operationally_present),
    deletedAtUtc: instantOrNull(row.deleted_at_utc),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
  }),
  rowLimit: AID6B_HISTORY_ROW_LIMIT,
  byteLimit: AID6B_BYTE_LIMIT,
  // No person's name is projected — a lodge name is club-set text — but the entry
  // is keyed on a member id and every row is a fact about where that person slept.
  // ADR-004's per-invocation opt-in applies (DECLARED, not yet implemented, #2378).
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 5. Per-record membership audit history.
// ---------------------------------------------------------------------------

/**
 * The closed map from a FRIENDLY SUBJECT to the `AuditLog."entityType"` values it
 * covers. Modelled on `finance-records.ts`'s `FINANCE_AUDIT_SUBJECTS`: the model
 * picks a word, the entry closes over the server-owned array of column values that
 * word means, so the model cannot name a column value at all and the mapping is
 * reviewable in one place.
 *
 * FOUR SUBJECTS WERE PROPOSED AND DROPPED, and the reason is the finding rather
 * than an omission. AID-6C's review caught three subjects that could never match,
 * and its conclusion applies here in full: an empty result from a tool whose own
 * scope line says "nothing in THOSE categories matched" reads as evidence of
 * absence, so a subject that cannot match is worse than no subject. This predicate
 * is `entityType = ANY(...) AND entityId = ... AND category = ANY(membership
 * categories)`, so a subject only works if some production writer pairs that
 * entity type with a category in the MEMBERSHIP correlation domain — `account`,
 * `family`, `communication` and `privacy`, per
 * `AUDIT_CATEGORY_CORRELATION_DOMAIN`. Every literal below was verified at a real
 * write site, and so was the category each of those sites writes:
 *
 *  - DROPPED `induction` → `["MemberInduction"]`. The literal is real — five write
 *    sites in `src/lib/induction.ts` — but every one of them writes
 *    `category: "lodge"`, and `lodge` maps to the LODGE correlation domain, not the
 *    membership one. So the subject could only ever return zero rows. #2376
 *    suspected this and asked for it to be verified; it is true, and the subject is
 *    gone rather than shipped with a caveat, because a caveat in a scope line does
 *    not stop a model from calling the tool and narrating the emptiness. Induction
 *    events are readable through the LODGE correlation entry, and the scope line
 *    says so.
 *  - DROPPED `subscription` → `["MemberSubscription"]`. Both write sites
 *    (`src/lib/manual-subscription-payment.ts`) write `category: "payment"`, which
 *    is the FINANCE domain. It already has a working home:
 *    `diagnostics.finance_record_audit_history` carries the subject
 *    `membership_subscription` over exactly this entity type under the finance
 *    categories. Duplicating it here under a filter that cannot match would be a
 *    second answer that is always empty.
 *  - DROPPED `lifecycle_request` → `["MemberLifecycleActionRequest"]`. All six
 *    write sites in `src/lib/member-lifecycle-actions.ts` write
 *    `category: "admin"`, which maps to the SYSTEM domain and needs `support:view`.
 *    Readable through the system correlation entry, not here.
 *  - `member_number` was never proposed: there is no such column (see entry 1).
 *
 * THE FOUR THAT SURVIVE, each verified at a write site with a membership-domain
 * category:
 *
 *  - `member` → `["Member"]`. `account` at `members/[id]/photo/route.ts` and
 *    `nomination.ts`, `family` at `members/family/[memberId]/details/route.ts`,
 *    `communication` at `cron-age-up.ts` and `token-email-recovery.ts`. Note that
 *    MANY `Member` events are written under `xero`, `admin`, `lodge` or `booking`
 *    and will NOT appear here; the scope line says so.
 *  - `family_request` → `["FamilyGroupJoinRequest"]`. `family`, at thirteen write
 *    sites — five in `admin-family-group-requests-service.ts` and eight across the
 *    seven `api/members/family/*` routes. The AUDIT ROW is readable; the request record
 *    itself is not granted (it carries requester free text and children's dates of
 *    birth), and this entry projects only codes and an instant either way.
 *  - `partner_link` → `["MemberPartnerLink"]`. `family`, at eight write sites in
 *    `member-partner-link.ts` and `partner-invite-token.ts`.
 *  - `cancellation_request` → `["MembershipCancellationRequest"]`. `account`, at
 *    six write sites in `membership-cancellation-requests.ts` and
 *    `membership-cancellation-admin.ts`.
 */
const MEMBERSHIP_AUDIT_SUBJECTS = {
  member: ["Member"],
  family_request: ["FamilyGroupJoinRequest"],
  partner_link: ["MemberPartnerLink"],
  cancellation_request: ["MembershipCancellationRequest"],
} as const;

type MembershipAuditSubject = keyof typeof MEMBERSHIP_AUDIT_SUBJECTS;

const MEMBERSHIP_AUDIT_SUBJECT_KEYS = Object.keys(
  MEMBERSHIP_AUDIT_SUBJECTS,
) as [MembershipAuditSubject, ...MembershipAuditSubject[]];

/**
 * The audit categories this entry may read — DERIVED from `audit-categories.ts`
 * rather than written out, exactly as AID-6A's correlation entries and AID-6C's
 * audit entry derive theirs.
 *
 * That keeps this tool in lockstep with #2581's canonical taxonomy: if a category
 * is reclassified into or out of the membership domain, this tool follows without
 * an edit, and it can never read a category the membership domain does not own. It
 * is `account`, `family`, `communication` and `privacy` today. The category filter
 * IS the permission boundary here — it is the reason a `membership:view` officer
 * cannot reach a `security` or `admin` event through this entry — so writing the
 * list out by hand would be duplicating an authorization decision.
 */
const MEMBERSHIP_AUDIT_CATEGORIES =
  auditCategoriesForCorrelationDomain("membership");

const membershipAuditArgsSchema = z
  .object({
    subject: z.enum(MEMBERSHIP_AUDIT_SUBJECT_KEYS),
    recordId: RECORD_ID,
  })
  .strict();

type MembershipAuditArgs = z.infer<typeof membershipAuditArgsSchema>;

/**
 * PER-RECORD membership audit history. Codes and an instant, and nothing else.
 *
 * `entityId` is a PREDICATE against an id the caller already supplied, so the entry
 * discloses which events touched a record the operator is already looking at and
 * never enumerates. It is NOT projected: the row carries the audit row's own id as
 * its evidence reference, and echoing the caller's own argument back on every row
 * would only spend the byte ceiling.
 *
 * The three member-identifying columns (`memberId`, `actorMemberId`,
 * `subjectMemberId`), the free text (`summary`, `details`), the arbitrary
 * `metadata` JSON and `ipAddress`/`userAgent` all stay ungranted, exactly as AID-6A
 * left them. So this entry can say that a family-link event occurred on this
 * member, at this instant, with this outcome — and cannot say who did it, from
 * where, or what they typed. That is why it is the ONE entry in this module with
 * `surfacesPersonalData: false`.
 */
const MEMBERSHIP_AUDIT_SQL = `SELECT
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

const memberAuditHistory = defineDiagnosticsTool<MembershipAuditArgs>({
  id: DIAGNOSTICS_MEMBER_AUDIT_HISTORY_TOOL_ID,
  source: "select_only_sql",
  label: "Membership audit history for a record",
  description: `Returns the platform's own membership audit events for ONE record — a member, a family join request, a partner link or a membership cancellation request — newest first, at most ${AID6B_HISTORY_ROW_LIMIT}. Each row carries only stable codes and an instant: the event reference, the action code, the audit category, severity and outcome, what kind of record it concerned, and when it happened in UTC. Use it to see what the platform recorded happening to this record and in what order. It searches ONLY the membership audit categories (${MEMBERSHIP_AUDIT_CATEGORIES.join(", ")}), so many real events on the same record are outside it: a member's Xero sync is recorded under "xero", an administrator's member import under "admin", a lodge PIN login under "lodge", a membership INDUCTION under "lodge", a subscription payment under "payment", and a lifecycle (archive or erase) request under "admin" — none of those can appear here. It never returns who did it, event descriptions, stored metadata, IP addresses or error text. ${AID6B_DESCRIPTION_TAIL}`,
  // DERIVED from the platform's correlation lattice minus the one named carve-out,
  // never written out here. See `aid6bRecordAuditReaderAreas` for why a
  // record-scoped audit entry does not require `support` and the pack's contract
  // test for the assertion that reconciles the two.
  requiredAreas: aid6bRecordAuditReaderAreas("membership"),
  evidenceScope: `Audit events recorded against ONE record, in the membership categories ${MEMBERSHIP_AUDIT_CATEGORIES.join(", ")} only, at most ${AID6B_HISTORY_ROW_LIMIT}, newest first. Nothing matching means nothing in THOSE categories matched — not that nothing happened — and there are three structural reasons an empty result is not evidence of absence. First, the audit category is OPTIONAL on the row, and a row written with NO category at all is matched by no diagnostics tool anywhere, so a real event can exist and be invisible to every one of these tools. Second, several kinds of event on these very records are deliberately filed in OTHER domains and cannot be read here whatever the subject: INDUCTION events are recorded under the "lodge" category, which is not in the membership correlation domain, so induction sign-off, expiry and reminder events will NOT appear here at all and need the lodge tools; subscription events are recorded under "payment" and need the finance tools; member archive and erase LIFECYCLE requests are recorded under "admin" and need the system tools; and Xero contact sync on a member is recorded under "xero". Third, the same member record is written by paths in four different domains, so a member's history is genuinely split across tools. Never report that something did not happen on the strength of an empty result here: say that no categorised membership audit event matched, name the domain the event would be filed under, and point at Admin > Audit Log, which lists uncategorised rows and every category together. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: membershipAuditArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        enum: [...MEMBERSHIP_AUDIT_SUBJECT_KEYS],
        description:
          "Which kind of record the id belongs to. There is no induction, subscription or lifecycle-request subject: those events are filed in the lodge, finance and system domains and are read with those tools.",
      },
      recordId: {
        type: "string",
        description: "The EXACT id of that record.",
      },
    },
    required: ["subject", "recordId"],
    additionalProperties: false,
  },
  sql: MEMBERSHIP_AUDIT_SQL,
  // Three parameters, always: the entity-type values this subject covers (a module
  // constant closed over here, never an argument), the record id, and the
  // membership categories (derived from the canonical taxonomy, never an argument).
  bind: (args) => [
    [...MEMBERSHIP_AUDIT_SUBJECTS[args.subject]],
    args.recordId,
    [...MEMBERSHIP_AUDIT_CATEGORIES],
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
  // Stable codes and an instant. No person, no free text, no identifier beyond the
  // audit row's own — the caller's `recordId` is a predicate and is never echoed
  // back into a row.
  surfacesPersonalData: false,
});

/** The AID-6B per-member half, in presentation order. */
export const DIAGNOSTICS_AID6B_MEMBERSHIP_RECORD_TOOLS: readonly DiagnosticsToolEntry[] =
  [
    memberSummary,
    memberSubscriptionState,
    memberFamilyState,
    memberBookingSummary,
    memberAuditHistory,
  ];
