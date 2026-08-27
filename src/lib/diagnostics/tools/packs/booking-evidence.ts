/**
 * AI Diagnostics — AID-6B booking/membership pack, part 3: THE AUTHORITATIVE
 * CALCULATIONS (#2376, epic #2369).
 *
 * THREE `server_owned` evidence sources. The entries that read them live in
 * `booking-state.ts`; this module is the sources themselves.
 *
 *   readBookingBlockStateEvidence      → diagnostics.booking_block_state
 *   readBookingCapacityEvidence        → diagnostics.booking_capacity_by_night
 *   readMemberEligibilityEvidence      → diagnostics.member_eligibility_state
 *
 * WHY THESE ARE NOT `select_only_sql` ENTRIES, which is the question a reviewer
 * should ask first and which #2376 answers as a rule rather than a preference:
 * "Do not ask the model to recreate booking or membership rules from raw rows
 * where the application already has authoritative services, reason codes or
 * evaluators. Reuse or safely expose authoritative results."
 *
 * Every classification below already has exactly one definition in this codebase,
 * and re-deriving any of them in SQL would create a SECOND definition that can
 * drift from the screen a Booking Officer trusts:
 *
 *  - `evaluatePersistedBookingNonHostingPolicyViolations` reuses the proposal
 *    service's canonical minimum-stay and paid-up-adult rules without asking its
 *    proposal hosting path to invent a persisted booking. Hosting instead comes
 *    from `evaluatePersistedBookingAdultMemberHostingReadOnly`, the canonical
 *    persisted snapshot/evaluator used by the reconciler: sparse nights,
 *    operational consent, split siblings, subscription settlement and same-owner
 *    exclusions therefore stay identical to the booking lifecycle.
 *  - `bookingReviewReasonCodes` (`booking-review.ts`) is the ONE derivation of why
 *    a booking is in admin review, and it is deliberately derived at read time
 *    rather than stored. `isCheckinBlockedByPendingReview` is the ONE predicate
 *    for "blocked from check-in by a pending review", and it is NOT the same
 *    question — a pending ADULT-MEMBER HOSTING review deliberately does not turn a
 *    party away at the door, and this module keeps the two apart for that reason.
 *  - `checkCapacity` (`capacity.ts`) is the per-night engine every booking path
 *    uses. Its `nightDetails` already account for custodian bed holds, held
 *    policy-exception reservations and whole-lodge exclusive holds — three
 *    populations a hand-written diagnostic query would miss, and each of which
 *    makes a lodge full with no `Booking` row to show for it.
 *  - `getBookingEditPolicy` (`booking-edit-policy.ts`) is the ONE classifier of the
 *    locked-period edit window. "A booking lock" in this platform is not a table:
 *    it is this window plus the advisory locks the writers take, and the window is
 *    the only half a read can report.
 *  - `getLifecycleStatusConfig` (`admin-member-badges.ts`) is the ONE resolver of a
 *    member's lifecycle label, and it is the reason this module reads
 *    `isDeletedAccountRecord`: anonymisation sets `active: false` and stamps
 *    NEITHER `cancelledAt` NOR `archivedAt`, so a three-column read reports an
 *    ERASED member as merely "Inactive".
 *  - `resolveMemberSubscriptionSettlement` + `loadMemberSubscriptionSettlements`
 *    (`subscription-lockout-facts.ts`) are the ONE answer to "does this member owe
 *    a season subscription", and `peekSubscriptionLockoutMode`
 *    (`member-subscription-eligibility.ts`) is the club POLICY that decides what
 *    that fact costs the member. The two are deliberately separate and this module
 *    reports both, because the same unpaid fact hard-blocks at one club and merely
 *    reprices at the next.
 *  - `participantQualifiesAsHost` (`policies/adult-member-hosting.ts`) is the ONE
 *    adult-member-host predicate, and `participantIsNonMemberGuest` is its exact
 *    complement so a lapsed member cannot fall between the two.
 *
 * `peekSubscriptionLockoutModeStrict` AND NOT `resolveSubscriptionLockoutMode`, and
 * the difference is load-bearing rather than stylistic: the resolving variant
 * reseeds the global financial-year decision cache and can reach Xero. Diagnostics
 * must not mutate durable/domain or provider state and must never contact a live
 * provider. The season resolver below therefore uses only persisted override and
 * connected-tenant presence evidence, and refuses when Xero's unstored month is
 * required. A contract test pins that the resolving variant is never named here.
 *
 * THE `Strict` SUFFIXES ARE THE OTHER HALF OF THAT, and they are about EVIDENCE
 * AUTHORITY rather than about mutation. `getAgeTierSettings` swallows a database
 * failure into `AGE_TIER_DEFAULTS`; `peekSubscriptionLockoutMode` reads through two
 * functions that each turn one into a safe-looking default, composing to `NO_BLOCK`.
 * Both are correct for a product path -- a booking screen with the documented
 * defaults beats a booking screen with an error -- and both are wrong here: on a
 * cold cache, one transient failure would hand this pack the club's tier rule and
 * lockout policy as though they had been observed, and those two are the qualifiers
 * on every subscription finding it makes. The strict variants distinguish "the row
 * is genuinely absent, so the documented default is what governs this club" from
 * "the read failed", and the second becomes `evidence_unavailable` rather than an
 * authoritative-looking answer. Neither strict reader reads or writes the shared
 * cache, so a diagnostic cannot report a five-minute-old value as freshly observed
 * and cannot change what any other request in the process computes.
 *
 * AND THE STRICT AGE-TIER READ IS THREADED INTO THE RULES, not merely used beside
 * them. Calling it here was necessary and was not sufficient: the paid-up-adult rule
 * and the #2364 hosting bridge both reach the tier flag through
 * `loadMemberSubscriptionSettlements`, which read it through the CACHED reader on its
 * own. Those two rules now receive this pack's strict reader (see
 * `readAgeTierSettings` in `readBookingBlockState`), so a failed settings read
 * reaches the caller as a failure on every path that consults the club's tier policy
 * rather than on only the one this file happened to call directly.
 *
 * A `server_owned` entry is NOT a way around the substrate's gates: registry
 * lookup, loop budget, fresh AND-ed authorization, `.strict()` argument parsing
 * with the reserved-key scan, the metering breaker, the fixed projection with
 * redaction and per-field caps, the row and byte ceilings, truncation honesty and
 * the approved-metadata audit row all apply identically. The only gate it skips is
 * the SELECT-only credential check, which does not govern it.
 *
 * WHAT THAT COSTS, STATED PLAINLY, because AID-6A's pack doc requires it of any
 * server-owned source and AID-6C's review found the same residual worth naming
 * twice. These sources query application tables on the application's own
 * FULL-PRIVILEGE Prisma connection, so unlike the SQL entries there is no column
 * grant behind them and the registry projection in `booking-state.ts` is the ONLY
 * boundary. Nothing leaks today — every row is built field by field from named
 * `select` clauses — but that makes every edit to this file or to those
 * projections a security-relevant change that needs the review a grant would get.
 * Columns that sit one `select` away and must never be added: `Booking."notes"`,
 * `"adminReviewNotes"`, `"memberReviewJustification"`, `"deletedReason"`,
 * `"adultMemberHostingReview"` (a frozen JSON snapshot), `Member."comments"`,
 * `"dateOfBirth"`, `"passwordHash"` and `"totpSecret"`. The authoritative helpers
 * this module calls DO read some of those columns internally to reach their
 * verdict — that is the point of delegating to them — and none of their return
 * values carries one.
 *
 * READ ONLY, AND NO PROVIDER, AND NO LOCK. Every data call below is a Prisma
 * `findUnique`, `findFirst`, `findMany`, `count` or a read-only helper built from
 * those, and every one of them runs inside the ONE interactive transaction
 * `withBoundedReadOnlyTransaction` opens per invocation: its first command makes
 * PostgreSQL refuse writes, its second sets a server-side statement timeout, and
 * the reads follow. That seam is `../read-only-transaction.ts` since #2786, shared
 * with every other `server_owned` entry, and it owns the only two raw executions
 * on this path — so this file names the global Prisma client NOWHERE AT ALL, which
 * is stronger than the rule it carried when the helper lived here and is pinned as
 * such. There is no data write, advisory lock or HTTP request of any kind.
 *
 * THE ONE CALL THAT COULD NOT SIMPLY BE HANDED THE CLIENT, named because the claim
 * above is only as good as its hardest case. Threading works because every
 * canonical seam TAKES a client — but `getAgeTierSettings` takes none at all: it
 * dynamic-imports the global client, serves a five-minute cache and swallows a
 * failure into `AGE_TIER_DEFAULTS`, and `loadMemberSubscriptionSettlements` called
 * it. So on a `NON_MEMBER_PRICING` club one input to this row's subscription
 * findings ran outside the snapshot, outside the statement timeout and outside
 * `READ ONLY`, with nothing at any call site to pass. The loader now accepts a
 * READER as well as a client, and this pack passes one bound to its own transaction
 * (`getAgeTierSettingsStrict(tx)`, memoised per invocation); every writer omits it
 * and keeps the cached reader byte-for-byte. A collaborator with no client
 * parameter is the shape this rule cannot express, so the rule is a threading
 * CONTRACT with a named exception rather than a convention.
 *
 * THE LOCK-TAKING AND WRITE-PERFORMING SIBLINGS of several helpers used here are
 * named in the pack doc precisely so a future edit cannot reach for one by
 * accident: `evaluateBookingAdultMemberHosting` takes an advisory lock and is NOT
 * used; `reconcileAdultMemberHostingReview`,
 * `createModificationExceptionRequest`, `approveAndExecutePolicyExceptionRequest`,
 * `processWaitlistForDates`, `confirmWaitlistOffer` and
 * `replaceBedAllocationsForBooking` all write and are NOT used.
 *
 * ONE SNAPSHOT PER INVOCATION, AND NOTHING WIDER THAN THAT. Each source runs its
 * whole read graph — ordinary Prisma reads, authoritative helpers, and the SETTINGS
 * reads those helpers consult on their own way to a verdict — inside one
 * `REPEATABLE READ` read-only transaction, so the facts on one row were
 * all read at one committed instant and a row can no longer report a party
 * measured at instant A against occupancy measured at instant B. What that does
 * NOT buy: `observed_at_utc` is captured after assembly completes and is not the
 * snapshot's own timestamp; the snapshot is as old as the moment the transaction
 * took it, so the row can be stale with respect to now; and two invocations see
 * two different snapshots. The registry scope tells the model exactly that — rerun
 * before acting or reaching a definitive conclusion, and compare per-source
 * timestamps where a source supplies them.
 *
 * BOOKING DATES ARE NZ DATE-ONLY LODGE NIGHTS THROUGHOUT. Every date this module
 * emits goes through `formatDateOnly`, never `toISOString()`, so a night is a
 * calendar day and can never be narrated as a moment. Money stays in integer
 * cents; there is no division, no `toFixed` and no formatting in this file.
 */

import "server-only";

import type { AgeTier, Prisma } from "@prisma/client";

import { evaluatePersistedBookingAdultMemberHostingReadOnly } from "@/lib/adult-member-hosting-review";
import { getLifecycleStatusConfig } from "@/lib/admin-member-badges";
import {
  getAgeTierSettingsStrict,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { evaluatePersistedBookingNonHostingPolicyViolations } from "@/lib/booking-exception-request-service";
import { findBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import {
  expandStayEnvelopeToNightKeys,
  getExplicitGuestBedNightKeys,
} from "@/lib/booking-guest-stay-ranges";
import { formatBookingReference } from "@/lib/booking-reference";
import { bookingReviewReasonCodes, isCheckinBlockedByPendingReview } from "@/lib/booking-review";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import { checkCapacity } from "@/lib/capacity";
import { formatDateOnly } from "@/lib/date-only";
import {
  DELETED_ACCOUNT_PASSWORD_HASH,
  isDeletedAccountRecord,
} from "@/lib/deleted-account";
import { getInductionStatusForMember } from "@/lib/induction";
import { asClubTimeZone } from "@/lib/club-time";
import { CLUB_TIME_SETTINGS_ID } from "@/lib/club-time-zone";
import {
  clubSeasonYear,
  seasonYearOfStoredDate,
} from "@/lib/financial-year";
import { getStoredFinancialYearResolution } from "@/lib/financial-year-server";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import { peekSubscriptionLockoutModeStrict } from "@/lib/member-subscription-eligibility";
import { resolveMembershipTypePolicyForMember } from "@/lib/membership-type-policy";
import { participantQualifiesAsHost } from "@/lib/policies/adult-member-hosting";
import {
  resolveMemberSubscriptionSettlement,
  subscriptionIsUnpaid,
} from "@/lib/subscription-lockout-facts";

import type { DiagnosticsToolRawRow } from "../define";
import { withBoundedReadOnlyTransaction } from "../read-only-transaction";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

/**
 * These sources' OWN deadline, below the executor's outer race.
 *
 * The executor's `Promise.race` does not cancel the loser and nothing propagates a
 * cancellation into Prisma, so a source that can be slow has to bound its own
 * WORK. `readBookingBlockStateEvidence` has the widest fan-out in either pack —
 * the booking, its guests and their night sets, the policy evaluation, the
 * capacity engine and the member-night conflict scan — all for exactly one
 * booking and all on indexed columns.
 *
 * IT REFUSES RATHER THAN RETURNING A PARTIAL ROW, and that is the whole reason the
 * deadline exists here rather than only in the executor. A block state assembled
 * from some of its inputs is a FABRICATED answer, not an absent one: a row that
 * reported "no policy violations" because the policy evaluation timed out would be
 * the exact failure mode this pack is designed against. `evidence_unavailable` is
 * the honest outcome and the executor's own message tells the operator so.
 *
 * IT IS THE OUTERMOST OF THREE BOUNDS and the only one this file owns. The two
 * database bounds belong to the shared seam
 * (`DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS` and
 * `DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS` in `read-only-transaction.ts`),
 * which is where they moved in #2786 so every `server_owned` entry shares one
 * definition instead of each pack keeping its own. The ordering
 * statement < transaction < this deadline is what makes PostgreSQL refuse first,
 * and it is asserted rather than assumed.
 *
 * DERIVED, NOT CHOSEN, SINCE #2804. It used to be a flat 10 000, which worked
 * only because the wait for a connection was two seconds: worst case 2 000 +
 * 7 000 = 9 000 fitted underneath with a second to spare. When the owner raised
 * the wait to twenty seconds, a hand-set 10 000 would have sat BELOW the
 * database's own worst case — so a read that queued for a connection and then ran
 * perfectly well would have been killed by this deadline and reported as "took
 * too long", which is not what happened. It now comes from the one ladder in
 * `types.ts` and cannot fall behind it again.
 */
export const AID6B_EVIDENCE_DEADLINE_MS =
  DIAGNOSTICS_TOOL_BOUNDS.serverEvidenceDeadlineMs;

/**
 * How many nights one capacity read may report. Kept in step with
 * `AID6B_NIGHT_ROW_LIMIT` by the pack's own contract test; declared here as a
 * local so this module does not import the registry-facing bounds and create a
 * cycle with `booking-state.ts`.
 */
export const AID6B_CAPACITY_NIGHT_CEILING = 31;

/**
 * Production booking creation admits at most 30 party rows, and the record pack
 * uses the same ceiling. A corrupt legacy row above it is refused, never clipped.
 */
export const AID6B_BOOKING_GUEST_CEILING = 30;

const AID6B_ALLOCATION_COUNT_CEILING =
  AID6B_BOOKING_GUEST_CEILING * AID6B_CAPACITY_NIGHT_CEILING;

/**
 * Keep the open-request population aligned with the pack's bounded history view.
 * A larger corrupt population cannot support a conclusive aggregate answer.
 */
export const AID6B_OPEN_REQUEST_CEILING = 18;

/**
 * How many SIBLING bookings the hosting evidence read may consider.
 *
 * The same generous-guard reasoning as the hosting reconciler's own same-owner
 * source limit, and the same number: a stay whose hosting answer depends on more
 * than twenty-five other bookings at one lodge over one window is a data problem,
 * not a club member. It is a diagnostics-only bound — the writer's read stays
 * unbounded, because truncating it would change the rule rather than the answer's
 * confidence — and it refuses rather than truncating.
 */
export const AID6B_HOSTING_SIBLING_CEILING = 25;

/**
 * How many SAME-OWNER coverage sources the hosting evidence read may consider.
 *
 * A SECOND ceiling, at the same number, because it bounds a second population and
 * the two say different things when they bind: the sibling bound means a #738 split
 * family has grown implausibly wide, this one means a member holds more than
 * twenty-five active bookings at ONE lodge overlapping ONE stay. Naming them apart
 * is the same discipline the reconciler applies to its own SOURCE and DEPENDENT
 * limits, which are also both twenty-five and also deliberately separate.
 *
 * IT EXISTS BECAUSE THE WRITER'S BOUND FAILS THE OTHER WAY. That read truncates at
 * twenty-five with no `orderBy`, and the reconciler argues correctly that truncating
 * is safe for a WRITER — fewer hosts means a night reads as uncovered, so the
 * booking is flagged or refused rather than quietly allowed. For EVIDENCE the same
 * direction fabricates: miss the sibling carrying the covering adult and the row
 * reports `policy_adult_member_hosting` as a live blocker on a booking that is
 * actually covered, and with no order two invocations could disagree.
 */
export const AID6B_HOSTING_SAME_OWNER_SOURCE_CEILING = 25;

const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Refuse an oversized or corrupt booking envelope BEFORE any collaborator can
 * expand it into per-night work. `Promise.race` only stops waiting for a loser;
 * it cannot cancel a `checkCapacity` query already walking an unbounded interval.
 */
/**
 * How many nights a half-open date-only envelope spans, by ARITHMETIC.
 *
 * A measurement, not an expansion, and the distinction is load-bearing: this runs
 * BEFORE anything builds a night list, so a corrupt hundred-year envelope is refused
 * rather than materialised. INV-DATE-020 governs turning a stay INTO nights and
 * `expandStayEnvelopeToNightKeys` is the one definition of that; counting the days
 * between two dates is not that operation and needs no helper of its own.
 */
function dateOnlyNightSpan(start: Date, end: Date): number {
  const startUtc = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return (endUtc - startUtc) / UTC_DAY_MS;
}

function assertCapacitySpanWithinCeiling(checkIn: Date, checkOut: Date): number {
  const nights = dateOnlyNightSpan(checkIn, checkOut);
  if (
    !Number.isSafeInteger(nights) ||
    nights < 1 ||
    nights > AID6B_CAPACITY_NIGHT_CEILING
  ) {
    throw new Error(
      `AI Diagnostics AID-6B: this booking covers ${nights} nights, outside the 1-${AID6B_CAPACITY_NIGHT_CEILING}-night ceiling for a single capacity read`,
    );
  }
  return nights;
}

function assertPopulationWithinCeiling(
  actual: number,
  ceiling: number,
  population: string,
): void {
  if (actual > ceiling) {
    throw new Error(
      `AI Diagnostics AID-6B: ${population} exceeds the ${ceiling}-row ceiling; refusing an inconclusive answer`,
    );
  }
}

/**
 * THE MEMBERSHIP SEASON A DATE FALLS IN, FROM STORED STATE ONLY.
 *
 * ONE definition for this pack, because the two entries that need a season would
 * otherwise answer one question two ways: `member_eligibility_state` asks it about
 * "now", `booking_block_state` asks it about a booking's check-in night, and both
 * must derive it identically or they contradict each other for whichever part of
 * the year the two answers straddle.
 *
 * WHY NOT THE SHARED SEASON HELPERS' DEFAULT YEAR-END. `clubSeasonYear` and
 * `seasonYearOfStoredDate` (`financial-year.ts`) default their year-end month to
 * the process-level cache in
 * that module. That cache is seeded by `refreshFinancialYearConfig()`, which
 * is called by exactly three product paths (the membership-lockout settings write,
 * the finance dashboard page, and the subscription-eligibility gate). NOTHING on a
 * diagnostics path calls it. So on a cold process the cache is still
 * `DEFAULT_FINANCIAL_YEAR_END_MONTH` — March — and a club with any other year-end
 * month gets evidence judged in the WRONG SEASON: the paid-up-adult rule and the
 * hosting subscription bridge both read `MemberSubscription` by
 * `(memberId, seasonYear)`, so the wrong season silently reports a settled member
 * as unfinancial or an unfinancial member as settled, depending on which side of
 * the real season start the date sits. Warming the cache from here would be worse
 * still: a diagnostics read would then change what every other request in the
 * process computes.
 *
 * WHY IT CAN REFUSE. `getStoredFinancialYearResolution` answers from persisted
 * state alone: a stored admin override is authoritative, and March is authoritative
 * only when persisted state proves no Xero tenant is connected. A club that FOLLOWS
 * Xero for its financial year has that month in Xero and nowhere else, and this
 * pack does not call providers. Guessing March there is the defect; the honest
 * answer is `evidence_unavailable`, which the executor renders from this rejection
 * and which the owner's result contract names explicitly. Setting the override in
 * membership settings is the operator's remedy, so the message says so.
 */
/**
 * The mode, or a refusal — the fence the season has, for the same reason.
 *
 * A future edit that un-suppresses a subscription-sensitive rule without reading
 * the mode strictly first refuses here, rather than silently letting the rule peek
 * it through the swallowing readers.
 */
function requireResolvedLockoutMode(
  mode: SubscriptionLockoutMode | null,
): SubscriptionLockoutMode {
  if (mode === null) {
    throw new Error(
      "AI Diagnostics AID-6B: a subscription-sensitive rule was reached before the club's lockout mode was read strictly; refusing rather than letting it fall back to NO_BLOCK on a failed read",
    );
  }
  return mode;
}

/**
 * ONE READ AT MOST, ON FIRST USE — the shape a strict settings read has to take to
 * be threadable into a rule that may not consult it.
 *
 * Memoises the PROMISE rather than the value, so two collaborators that reach the
 * same rule inside one invocation share one observation and one round trip even when
 * they run concurrently in the same `Promise.all`. A rejection is memoised too, and
 * deliberately: a failed evidence read must reach every consumer as the same failure
 * rather than being retried into a different answer half a row later.
 */
function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => (pending ??= read());
}

async function requireStoredYearEndMonth(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const financialYear = await getStoredFinancialYearResolution(tx);
  if (!financialYear.ok) {
    throw new Error(
      "AI Diagnostics AID-6B: this club follows its connected Xero organisation for the financial year and that year-end month is not stored locally, so the membership season for these dates cannot be resolved without a provider call. Set the financial year-end month override in membership settings to make this evidence available.",
    );
  }
  return financialYear.effectiveMonth;
}

/**
 * The season a STORED lodge night falls in.
 *
 * TAKES NO ZONE. `Booking.checkIn` is a `@db.Date` calendar day whose encoding is
 * defined in UTC (`INV-DATE-019`, `INV-DATE-026`), so the day it names is the same
 * day everywhere and projecting it through one is the defect. Until CT-4 group F1
 * this and the "now" question below went through ONE host-local helper, which read
 * this value with `date.getMonth()` — so on any host behind Greenwich a 1 April
 * check-in was judged in the previous season, and the paid-up-adult rule then read
 * `MemberSubscription` by the wrong `(memberId, seasonYear)`.
 */
async function resolveStoredNightSeasonYear(
  date: Date,
  tx: Prisma.TransactionClient,
): Promise<number> {
  return seasonYearOfStoredDate(date, await requireStoredYearEndMonth(tx));
}

/**
 * The club's persisted timezone, READ THROUGH `tx` — and that is the whole point.
 *
 * The first version of this called `readClubTimeZoneOutsideRequest()`, which was
 * wrong in four ways at once, and a correctness lens caught every one (#2870):
 *
 *  - it uses the GLOBAL Prisma client, so the read escaped the seam this pack's
 *    entry opens — `withBoundedReadOnlyTransaction`, whose own contract says "DO
 *    NOT NEST ... A sub-read that needs the database takes `tx` from its caller
 *    instead";
 *  - escaping it meant escaping `SET TRANSACTION READ ONLY`, the `RepeatableRead`
 *    snapshot and the transaction-local 5s `statement_timeout` that this pack
 *    advertises as "the one database bound, in one place";
 *  - it needed a SECOND pool connection while the seam already held one;
 *  - and `readPersistedClubTimeZoneRow` swallows every throw, so a pool timeout
 *    would have resolved the zone from the environment seed and reported a
 *    member's subscription state for a season that is not the club's, with one
 *    throttled warn line as the only evidence.
 *
 * The pack's own guard could not see it, because the global client was one import
 * away and the census matches the literal token `prisma.` — 374 tests passed while
 * the rule was broken. `read-only-transaction.test.ts` now refuses an indirect
 * reach as well.
 *
 * IT REFUSES RATHER THAN FALLING BACK, which is `requireStoredYearEndMonth`'s rule
 * three lines below and the reason the two halves are now consistent. Guessing a
 * zone for an evidence path is the same defect as guessing a year-end month: the
 * answer would look freshly measured and be about the wrong season. The executor
 * renders this rejection as `evidence_unavailable`.
 *
 * It duplicates six lines of QUERY and no judgement at all — the row id comes from
 * CT-1's shared `CLUB_TIME_SETTINGS_ID` and the validation from CT-1's
 * `asClubTimeZone` — which is the same trade `club-time-zone-runtime.ts` documents
 * for the same reason: the canonical readers cannot be handed a `tx`.
 */
async function requireStoredClubTimeZone(tx: Prisma.TransactionClient) {
  const row = await tx.clubTimeSettings.findUnique({
    where: { id: CLUB_TIME_SETTINGS_ID },
    select: { timeZone: true },
  });
  const zone = asClubTimeZone(row?.timeZone ?? null);
  if (!zone) {
    throw new Error(
      "AI Diagnostics AID-6B: the club's timezone is not stored locally as a usable named zone, so the membership season the club is currently in cannot be resolved from stored state. Set the club's timezone at /admin/club-time (or run npm run setup) to make this evidence available.",
    );
  }
  return zone;
}

/**
 * The season the club is in RIGHT NOW.
 *
 * TAKES THE CLUB'S PERSISTED ZONE (`INV-CONFIG-002`), because "now" is a club
 * business decision and the container's month is not the club's. This is the other
 * half of the split above: the two questions are not the same temporal kind, and
 * one function answering both is what made this pack's own answer host-dependent.
 * BOTH halves come from STORED state through `tx` — the year-end month and the
 * zone — so nothing here consults the process-level financial-year cache and
 * nothing escapes the seam its caller opened. See `requireStoredClubTimeZone`
 * above for why the zone half is not the canonical reader.
 */
async function resolveStoredClubSeasonYear(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const [yearEndMonth, zone] = await Promise.all([
    requireStoredYearEndMonth(tx),
    requireStoredClubTimeZone(tx),
  ]);
  return clubSeasonYear(zone, undefined, yearEndMonth);
}

/**
 * The season, or a refusal — for the two call sites that MUST NOT fall back.
 *
 * `booking_block_state` resolves the season only on a live booking, because a
 * suppressed one evaluates neither subscription-sensitive rule. This turns that
 * conditional into a fence: if a future edit ever un-suppresses those rules without
 * resolving the season first, the read REFUSES instead of quietly reverting to the
 * process-level cache this whole helper exists to avoid. A `?? undefined` in its
 * place would be exactly that silent revert.
 */
function requireResolvedSeasonYear(seasonYear: number | null): number {
  if (seasonYear === null) {
    throw new Error(
      "AI Diagnostics AID-6B: a subscription-sensitive rule was reached before the membership season was resolved from stored state; refusing rather than judging the party in whichever season this process happens to have cached",
    );
  }
  return seasonYear;
}

type GuestNightFootprint = {
  stayStart: Date;
  stayEnd: Date;
  nights: readonly { stayDate: Date }[];
};

/**
 * Every lodge night one guest holds a bed for — BOUNDED FIRST, then expanded by the
 * canonical helpers and by nothing of this module's own.
 *
 * WHY THIS IS NOT A LOCAL DAY LOOP ANY MORE. It was, and the loop was right night
 * for night — but INV-DATE-020 exists because six places once expanded a stay and
 * three of them read the envelope while a night set existed, so a guest booked on
 * nights {1, 3} was reported as occupying the 2nd. The invariant's remedy is that
 * every read surface routes at `booking-guest-stay-ranges.ts`, and its guard,
 * `guest-stay-expansion-census.test.ts`, can only see a call it recognises: a
 * hand-rolled loop is invisible to it, which the census's own header names as its
 * residue. This function fed BOTH `booking_block_state`'s party nights and
 * `booking_capacity_by_night`'s per-night demand, so the next change to the sparse
 * rule — a narrower envelope fallback, a new night representation reaching
 * `nightEntryKey`, anything at all in `getGuestBedNightKeys` — would have left these
 * two entries on the old rule with the guard green. That is #2628 re-created inside
 * the pack.
 *
 * `getExplicitGuestBedNightKeys` and `expandStayEnvelopeToNightKeys` are the two
 * halves of `getGuestBedNightKeys`, called in its own order: the night set wins, the
 * envelope is only a fallback. They are called SEPARATELY rather than through
 * `getGuestBedNightKeys` itself because the ceilings and the zero-night refusal have
 * to sit BETWEEN the two branches — a bound applied after the expansion would have
 * already materialised whatever a corrupt envelope asked for, and the canonical
 * helper returns an empty list for a zero-night envelope where this pack has already
 * decided that a persisted zero-night guest is corrupt evidence rather than an
 * absent guest.
 *
 * ONE CONSEQUENCE WORTH STATING: the keys are now the tree's canonical NZ-time-zone
 * keys (`formatDateOnlyForTimeZone`) rather than this module's `formatDateOnly`. For
 * every value that can reach here the two are identical — `BookingGuestNight.stayDate`,
 * `BookingGuest.stayStart`/`stayEnd` and `Booking.checkIn`/`checkOut` are all
 * `@db.Date`, so they arrive at UTC midnight, which is the same calendar day in
 * Pacific/Auckland. Where they could ever differ, the canonical key is the one the
 * capacity engine and the pricing surfaces use, so agreeing with them is the point.
 *
 * Explicit duplicates still count toward the read ceiling: de-duplication must never
 * turn an oversized source population into an apparently safe one.
 */
function boundedGuestNightFootprint(guest: GuestNightFootprint): string[] {
  assertPopulationWithinCeiling(
    guest.nights.length,
    AID6B_CAPACITY_NIGHT_CEILING,
    "guest-night rows",
  );
  const explicit = getExplicitGuestBedNightKeys(guest);
  if (explicit) return explicit;

  const nights = dateOnlyNightSpan(guest.stayStart, guest.stayEnd);
  if (
    !Number.isSafeInteger(nights) ||
    nights < 0 ||
    nights > AID6B_CAPACITY_NIGHT_CEILING
  ) {
    throw new Error(
      `AI Diagnostics AID-6B: guest fallback envelope covers ${nights} nights, outside the 0-${AID6B_CAPACITY_NIGHT_CEILING}-night ceiling`,
    );
  }

  // A half-open [start,end) interval with equal endpoints contains ZERO nights.
  // Persisted guest rows are required to contain at least one night, so refuse the
  // corrupt evidence instead of fabricating occupancy on the departure day. The
  // canonical expander returns an empty list here, which is right for a caller
  // asking "which nights" and wrong for one asserting "this row is sound".
  if (nights === 0) {
    throw new Error(
      "AI Diagnostics AID-6B: guest fallback envelope contains zero nights; refusing corrupt persisted stay evidence",
    );
  }
  return expandStayEnvelopeToNightKeys(guest.stayStart, guest.stayEnd);
}

/**
 * The booking statuses that make a booking TERMINAL — nothing more can be
 * collected, confirmed, allocated or reviewed against it.
 *
 * A LOCAL CONSTANT PINNED BY A TEST, not an import, and the reason is the same one
 * AID-6C gave for its recovery-attempt ceiling: the authoritative predicate
 * (`bookingAttendanceIsTerminal` in `adult-member-hosting-review.ts`) lives in the
 * hosting RECONCILER, a module full of advisory locks, queue drains and writers.
 * Importing it would drag that graph into the diagnostics import closure for a
 * two-element array. The pack's contract test asserts this list agrees with the
 * real predicate on every `BookingStatus` value, so the two cannot drift.
 *
 * `deletedAt` is the third terminal condition and is handled separately, because a
 * soft-deleted booking is a DIFFERENT answer from a cancelled one: the member sees
 * nothing at all, and the operator's next step is the deleted-bookings view rather
 * than the cancellation record.
 */
const TERMINAL_BOOKING_STATUSES: readonly string[] = ["CANCELLED", "BUMPED"];

/**
 * The statuses that mean this booking is ON THE WAITLIST rather than admitted.
 *
 * They get their own set because of the ranking trap AID-6C's review named: a
 * waitlisted booking does not fit BY DEFINITION, so reporting `capacity_exceeded`
 * as its primary problem would outrank the fact that actually explains it. On
 * these two statuses the capacity shortfall is reported as a supporting FACT and
 * never as a blocker.
 */
const WAITLIST_BOOKING_STATUSES: readonly string[] = [
  "WAITLISTED",
  "WAITLIST_OFFERED",
];

/**
 * The stable blocker codes `readBookingBlockStateEvidence` can emit, in the
 * PRIORITY ORDER an operator should act on them.
 *
 * THE ORDER IS THE PRODUCT, and getting it wrong is how a diagnostic sends an
 * officer to the wrong screen. It is asserted end to end by a test that drives a
 * booking carrying every blocker at once and requires this exact sequence, and the
 * emitting code filters this catalogue rather than sorting a list — so priority is
 * structural rather than a comparator somebody can drop.
 *
 * The reasoning, stated because a reviewer must be able to disagree with it:
 *
 *  1-2. EXISTENCE FIRST. A deleted or terminal booking makes every other question
 *       moot, and reporting a policy failure on a cancelled booking is the
 *       "confidently wrong about a healthy record" failure in its purest form —
 *       the booking is not broken, it is over. Every downstream blocker is
 *       SUPPRESSED on these two, exactly as AID-6C suppresses payment-progress
 *       blockers on a terminal booking. They are also MUTUALLY EXCLUSIVE as
 *       emitted: deletion is only reachable from `CANCELLED`, so the deleted row
 *       reports the deletion alone rather than the same fact twice. See the
 *       predicate for `booking_lifecycle_terminal` below.
 *  3.   WAITLIST NEXT, because it explains the capacity shortfall that would
 *       otherwise be reported as the primary fault.
 *  4-6. HARD STOPS. A member double-booked on a night, a party that does not fit,
 *       and a night another booking holds exclusively are all refusals no officer
 *       can talk their way past — and the whole-lodge hold is explicitly NOT
 *       bypassable by the admin over-capacity override.
 *  7.   THE CHILD-SAFETY GATE. A pending minors review blocks arrival at the door,
 *       which is more urgent than a membership rule.
 *  8.   THE HOSTING REVIEW, which deliberately does NOT block arrival.
 *  9-10. THE SOFT POLICIES that are not about a subscription, in the order
 *       `sortPolicyExceptionViolations` already puts them. Each is
 *       exception-eligible, which is what makes them softer than the hard stops.
 *  11.  THE CLUB'S OWN SUBSCRIPTION REFUSAL, immediately ABOVE the
 *       exception-eligible subscription rule it is otherwise easy to confuse with.
 *       Under `HARD_BLOCK` — the platform and database DEFAULT — an owner who owes
 *       an unpaid season subscription cannot confirm their own zero-price draft, and
 *       there is no exception request for it: the remedies are payment or an
 *       ADMINISTRATOR confirming on the member's behalf, which the route's own
 *       `!isAdmin` condition lets through. It therefore outranks
 *       `policy_paid_up_adult_member`, which has an exception door and is a
 *       `NON_MEMBER_PRICING`-only rule. The two are mutually exclusive in practice
 *       because each belongs to a different mode, and putting them adjacent is
 *       deliberate: an operator reading one must see the other's sentence beside it.
 *  12.  THE EXCEPTION-ELIGIBLE PAID-UP-ADULT RULE.
 *  13-14. THE OFFICER'S OWN QUEUE. An open exception request means the ball is with
 *       an officer, and an expiring hold means the member's beds are about to be
 *       released — urgent, but only after the reason they asked.
 *  15.  THE EDIT WINDOW, last, because it constrains HOW a fix is applied rather
 *       than whether the booking is sound.
 */
export const BOOKING_BLOCKER_CODES = [
  "booking_deleted",
  "booking_lifecycle_terminal",
  "booking_waitlisted",
  "member_night_conflict",
  "capacity_exceeded",
  "whole_lodge_held",
  "admin_review_pending",
  "hosting_review_pending",
  "policy_minimum_stay",
  "policy_adult_member_hosting",
  "subscription_unpaid_hard_block",
  "policy_paid_up_adult_member",
  "exception_request_open",
  "exception_hold_expiring",
  "edit_window_locked",
] as const;

export type BookingBlockerCode = (typeof BOOKING_BLOCKER_CODES)[number];

/**
 * The blocker codes that survive a TERMINAL or DELETED booking. There are none,
 * and saying so as a constant rather than as an `if` is deliberate: it is the one
 * place a future edit would have to argue for an exception.
 *
 * AID-6C kept its bookkeeping blockers alive on a terminal booking because a
 * refund still had to be paid and a Xero invoice still had to be corrected — money
 * outlives the booking. Nothing in THIS pack does: a cancelled booking cannot
 * exceed capacity, cannot break a minimum stay, and cannot be blocked from a
 * check-in that will never happen. Reporting any of those would be the false
 * actionable finding this pack exists to avoid.
 */
const TERMINAL_SURVIVING_BLOCKERS: readonly BookingBlockerCode[] = [];

/**
 * The stable eligibility codes `readMemberEligibilityEvidence` can emit, in
 * priority order. Same discipline as the blocker catalogue: filtered, never
 * sorted.
 *
 *  1.   ERASED. An anonymised account is not a member and is invisible to the
 *       three-column read every other surface would do.
 *  2-4. LIFECYCLE, outermost first: archived, then cancelled, then inactive. The
 *       order matches `getLifecycleStatusConfig`'s own precedence exactly, because
 *       a diagnostic that ranked them differently from the badge an officer is
 *       looking at would be describing a different member.
 *  5.   THE MEMBERSHIP TYPE BLOCKS BOOKING OUTRIGHT — a club-configured refusal
 *       that no subscription payment fixes.
 *  6.   THE SUBSCRIPTION IS UNPAID, which is a fact whose CONSEQUENCE depends on
 *       the club's lockout mode and is reported beside it.
 *  7.   NOT AN ADULT, which is why they cannot host.
 *  8.   NO LOGIN, which is why they cannot act for themselves.
 *  9.   AN INDUCTION IS REQUIRED OF THEM AND IS NOT COMPLETE. Last, and reported
 *       as a warning rather than a booking blocker, because in THIS release
 *       induction gates nomination and the member dashboard and gates NO booking
 *       path — see `readMemberEligibilityEvidence`.
 */
export const MEMBER_ELIGIBILITY_CODES = [
  "member_erased",
  "member_archived",
  "member_cancelled",
  "member_inactive",
  "membership_type_blocks_booking",
  "subscription_unpaid",
  "not_adult_age_tier",
  "cannot_log_in",
  "induction_outstanding",
] as const;

export type MemberEligibilityCode = (typeof MEMBER_ELIGIBILITY_CODES)[number];

/** Race one read against this module's own deadline, refusing rather than waiting. */
async function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `AI Diagnostics AID-6B: ${label} exceeded ${AID6B_EVIDENCE_DEADLINE_MS}ms`,
              ),
            ),
          AID6B_EVIDENCE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 1. The authoritative booking block state.
// ---------------------------------------------------------------------------

/**
 * The columns this source reads off `Booking`. A NAMED `select`, never a bare
 * `findUnique`, because the projection in `booking-state.ts` is the only boundary
 * behind this connection and a `select`-less read would put `notes`,
 * `adminReviewNotes`, `memberReviewJustification`, `deletedReason` and the frozen
 * `adultMemberHostingReview` JSON one field-name typo away from a projected row.
 */
const BLOCK_STATE_BOOKING_SELECT = {
  id: true,
  memberId: true,
  lodgeId: true,
  status: true,
  checkIn: true,
  checkOut: true,
  deletedAt: true,
  requiresAdminReview: true,
  adminReviewStatus: true,
  adultMemberHostingReviewStatus: true,
  /**
   * THE SECOND HALF OF THE CLUB'S OWN SUBSCRIPTION GATE, and it is a predicate
   * input rather than a projected figure.
   *
   * `POST /api/bookings/[id]/confirm-draft` returns 400 ("Use the payment flow to
   * complete non-zero bookings") on any priced draft BEFORE it reaches its
   * subscription refusal, so the refusal stands in front of a ZERO-PRICE draft's
   * confirm and nothing else. Without this column the entry could not tell the two
   * drafts apart and raised the club's refusal against a priced one, which the
   * member completes through the payment flow — a fabricated blocker of exactly the
   * kind this pack exists to avoid. See
   * `subscriptionHardBlockGatesThisBooking`.
   *
   * It is deliberately NOT projected: money on this booking is a finance question
   * and `booking_summary` is where the figure belongs. The value never leaves this
   * module.
   */
  finalPriceCents: true,
  /**
   * THE OWNER'S LIVE AGE TIER, AND NOTHING ELSE OFF `Member`.
   *
   * `resolveMemberSubscriptionSettlement` takes the tier as an input and treats an
   * unresolvable one as OWING a subscription, so it has to come from the live row
   * rather than from anything cached on the booking. `confirm-draft` reads exactly
   * this field for exactly this gate (`booking.member.ageTier`).
   *
   * ONE field, because the header's rule applies with full force to a nested
   * select: `Member` is the relation carrying `comments`, `dateOfBirth`,
   * `passwordHash` and `totpSecret`, and this is the module where the named
   * `select` IS the boundary. It is a PREDICATE input and appears in no projection.
   */
  member: { select: { ageTier: true } },
} as const;

/**
 * NINE COLUMNS WERE REMOVED FROM THE SELECT ABOVE, and the reason is the docblock
 * two paragraphs up rather than tidiness. `adminReviewedAt`,
 * `adultMemberHostingReviewedAt`, `waitlistPosition`, `waitlistOfferExpiresAt`,
 * `wholeLodgeHold`, `adminCapacityHoldAt`, `capacityOverriddenAt`,
 * `parentBookingId` and `draftExpiresAt` were selected and read by nothing.
 *
 * On a `select_only_sql` entry an unused column is a grant somebody has to argue
 * for. Here there is no grant: this source runs on the application's own
 * full-privilege connection, and the named `select` IS the boundary. So an unused
 * column is the same defect with none of the friction — nine fields one typo away
 * from a projection, in a file whose header says the select is the only thing
 * standing between this tool and `notes`, `adminReviewNotes`,
 * `memberReviewJustification`, `deletedReason` and the frozen hosting-review JSON.
 *
 * Every remaining column has a named consumer: `id`, `memberId` and `lodgeId` are
 * the projection and the three subsystem calls; `status` and `deletedAt` decide
 * suppression; `checkIn`/`checkOut` are the capacity window and the edit policy;
 * `requiresAdminReview`, `adminReviewStatus` and
 * `adultMemberHostingReviewStatus` are the three fields the platform's own review
 * predicates are called with, field by field; `finalPriceCents` and
 * `member.ageTier` are the two inputs the club's own subscription refusal needs —
 * which door the booking's confirm actually uses, and what the owner's tier owes.
 * Neither of those two is projected.
 */

/**
 * THE STATUS THE CLUB'S SUBSCRIPTION REFUSAL ACTUALLY GATES.
 *
 * `HARD_BLOCK` refuses an unfinancial member at two doors: creating a booking, and
 * confirming a draft they already saved (`POST /api/bookings/[id]/confirm-draft`,
 * which 400s on any status but `DRAFT` before it reaches the subscription gate).
 * Creation is not a persisted booking and cannot be diagnosed. So the one door this
 * entry can honestly report on is the draft's own confirm.
 *
 * A NARROW LIST ON PURPOSE. Raising the code on a `CONFIRMED` or `PAID` booking
 * would be a fabricated blocker: nothing about that booking is waiting on the
 * owner's subscription, and the pack's whole discipline is that a blocker is
 * something with a real next step. `member_eligibility_state` is where the
 * member-level fact belongs, and it reports `subscription_unpaid` with the mode
 * beside it regardless of any booking.
 *
 * If a future release adds a member-facing confirm on another status, this constant
 * is the one place that has to change, and the blocker's own sentence names the
 * route so the two cannot drift silently.
 */
const SUBSCRIPTION_HARD_BLOCK_GATED_STATUSES: readonly string[] = ["DRAFT"];

/**
 * DOES THE GATED DOOR BELONG TO THIS BOOKING AT ALL — status AND price.
 *
 * The status list above is necessary and was not sufficient, and the missing half
 * cost this entry a fabricated refusal. `confirm-draft` is a TWO-CONDITION door:
 * it 400s on any status but `DRAFT`, and then, at
 * `confirm-draft/route.ts` ("Use the payment flow to complete non-zero
 * bookings"), it 400s again on any draft whose `finalPriceCents` is not zero —
 * BEFORE the subscription refusal below it. A priced draft is completed through
 * `POST /api/payments/create-payment-intent`, which takes it `DRAFT ->
 * PAYMENT_PENDING -> PAID`; the booking page renders the confirm button only for a
 * zero-price draft and the Stripe component for every other one.
 *
 * So the club's flat refusal stands in front of exactly one member-facing step: the
 * FREE confirm. Raising the code on a priced draft told an officer the club had
 * refused a booking the member then paid for and confirmed — the same class of
 * false actionable finding as raising it on a `CONFIRMED` booking, and forbidden by
 * this entry's own contract in the same words.
 *
 * WHAT THIS DOES NOT CLAIM. Nothing about whether the club's policy OUGHT to reach
 * the payment flow. This entry reports the enforcement the platform has, and where
 * it has none it says nothing rather than inventing a refusal;
 * `member_eligibility_state` still reports the member-level `subscription_unpaid`
 * fact with the mode beside it, on any status and any price.
 */
function subscriptionHardBlockGatesThisBooking(booking: {
  status: string;
  finalPriceCents: number;
}): boolean {
  return (
    SUBSCRIPTION_HARD_BLOCK_GATED_STATUSES.includes(booking.status) &&
    booking.finalPriceCents === 0
  );
}

/**
 * Does the club's own `HARD_BLOCK` refusal stand against this booking's OWNER?
 *
 * WHY THIS EXISTS AT ALL. `booking_block_state` used to be able to answer
 * "nothing is blocking this booking" — `blockerCodes: null`, `blockerCount: 0` —
 * about a draft the club will refuse outright, on the platform's DEFAULT lockout
 * mode. The paid-up-adult rule cannot cover it: `evaluateNonMemberPricingRequirements`
 * short-circuits to `null` unless the mode is `NON_MEMBER_PRICING`, by design, so
 * under `HARD_BLOCK` no policy violation is produced and the row was silent. The
 * member then hits a 403 from the confirm route, and the entry's own scope had told
 * the model that an absent blocker list means nothing is blocking.
 *
 * WHY IT IS NOT A SECOND IMPLEMENTATION OF THE RULE. Three of the four inputs are
 * the canonical ones and the fourth is a status list:
 *
 *  - the FACT comes from `resolveMemberSubscriptionSettlement`, which is the single
 *    definition #2543 created precisely so the owner gate, the member-guest gate and
 *    the reprice cannot drift — its own docblock forbids a caller adding a condition;
 *  - `subscriptionIsUnpaid` is the same predicate `member_eligibility_state` reads,
 *    so the two entries in this pack now answer one question one way;
 *  - the MODE is the strictly-read club setting already in hand, so a failed
 *    settings read stays `evidence_unavailable` rather than becoming `NO_BLOCK`;
 *  - the SEASON is the stored one keyed on the booking's check-in night.
 *
 * WHAT IT DELIBERATELY DOES NOT USE. `requiresPaidSubscriptionForMemberForBooking`
 * is the function the routes call, and it would have been the obvious reuse — but it
 * reaches `requiresPaidSubscriptionForBooking`, which calls
 * `resolveSubscriptionLockoutMode()` and the CACHED age-tier settings reader, and
 * both turn a database failure into a confident default. That is the exact defect
 * the strict seams exist to keep out of an evidence path. What it computes is the
 * same three branches this composition does, minus those two swallowing reads: a
 * `NOT_REQUIRED` type owes nothing, a `BASED_ON_AGE_TIER` type with a `NOT_REQUIRED`
 * season row owes nothing, otherwise the per-tier flag decides. The Xero-off bypass
 * that function also carries is covered here by the mode itself, because the strict
 * mode reader already answers `NO_BLOCK` when the Xero module is effectively off.
 */
async function readOwnerSubscriptionHardBlock(
  tx: Prisma.TransactionClient,
  input: {
    memberId: string;
    seasonYear: number;
    ageTier: AgeTier | null;
    /**
     * The row's ONE strict, transaction-bound age-tier observation, shared with the
     * policy evaluator and the hosting bridge so all three subscription rules on a
     * row are judged against the same club policy. See its declaration in
     * `readBookingBlockState`.
     */
    readAgeTierSettings: () => Promise<AgeTierSettingData[]>;
  },
): Promise<boolean> {
  const [typePolicy, subscription, ageTierSettings] = await Promise.all([
    resolveMembershipTypePolicyForMember(tx, {
      memberId: input.memberId,
      seasonYear: input.seasonYear,
    }),
    tx.memberSubscription.findUnique({
      where: {
        memberId_seasonYear: {
          memberId: input.memberId,
          seasonYear: input.seasonYear,
        },
      },
      select: { status: true },
    }),
    input.readAgeTierSettings(),
  ]);
  return subscriptionIsUnpaid(
    resolveMemberSubscriptionSettlement({
      subscriptionBehavior: typePolicy?.subscriptionBehavior ?? null,
      subscriptionStatus: subscription?.status ?? null,
      ageTier: input.ageTier,
      ageTierSettings,
    }),
  );
}

/**
 * THE authoritative answer to "what is actually blocking this booking".
 *
 * Returns exactly ONE row, or REFUSES. It never returns a partial row: the
 * executor reports a rejection as `evidence_unavailable`, and an operator told
 * "the evidence could not be gathered" is strictly better served than one told
 * "no policy violations" by a calculation that did not run.
 */
export async function readBookingBlockStateEvidence(args: {
  bookingId: string;
}): Promise<readonly DiagnosticsToolRawRow[]> {
  // #3123 review — the CLUB's day, resolved BEFORE the bounded read-only
  // transaction opens. `withBoundedReadOnlyTransaction` runs at RepeatableRead
  // under a statement timeout, and `clubTodayDateOnlyInstant()` reads through
  // the MODULE client, not `tx` — so calling it from inside would take a second
  // pooled connection for the length of that query while this transaction's is
  // held, which is the shape `INV-LOCK-004` forbids and which the pack's own
  // `requireStoredClubTimeZone` docblock already reasons about from the other
  // direction. Resolved once and threaded, so the edit policy and the
  // person-night scan below report the same day.
  const todayAtClub = await clubTodayDateOnlyInstant();
  return withDeadline(
    withBoundedReadOnlyTransaction((tx) =>
      readBookingBlockState(args.bookingId, tx, todayAtClub),
    ),
    "booking block state",
  );
}

async function readBookingBlockState(
  bookingId: string,
  tx: Prisma.TransactionClient,
  /** The club's today, resolved outside this transaction (`INV-LOCK-004`). */
  todayAtClub: Date,
): Promise<readonly DiagnosticsToolRawRow[]> {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: BLOCK_STATE_BOOKING_SELECT,
  });
  // An absent booking is an EMPTY result, not a refusal. The executor's
  // `not_found` state plus the entry's scope sentence is the honest answer, and a
  // rejection here would tell an operator the evidence was unavailable when in
  // fact it was conclusive.
  if (!booking) return [];

  const deleted = booking.deletedAt !== null;
  const terminal = TERMINAL_BOOKING_STATUSES.includes(booking.status);
  const waitlisted = WAITLIST_BOOKING_STATUSES.includes(booking.status);
  // Bound the booking before status-based suppression. A deleted or terminal row
  // is still followed by guest/request reads, and corrupt intervals must never
  // bypass the same fail-closed population fence.
  assertCapacitySpanWithinCeiling(booking.checkIn, booking.checkOut);

  const guests = await tx.bookingGuest.findMany({
    where: { bookingId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      isMember: true,
      memberId: true,
      stayStart: true,
      stayEnd: true,
      consentStatus: true,
      nights: {
        select: { stayDate: true },
        orderBy: { stayDate: "asc" },
        take: AID6B_CAPACITY_NIGHT_CEILING + 1,
      },
    },
    orderBy: [{ stayStart: "asc" }, { id: "asc" }],
    take: AID6B_BOOKING_GUEST_CEILING + 1,
  });
  assertPopulationWithinCeiling(
    guests.length,
    AID6B_BOOKING_GUEST_CEILING,
    "booking guests",
  );

  /**
   * The live per-guest night footprint, from the `BookingGuestNight` rows where
   * they exist and from the envelope where they do not.
   *
   * BOTH ARMS ARE NECESSARY AND THE ORDER MATTERS. A guest may occupy
   * NON-CONTIGUOUS nights inside one booking, in which case `stayStart`/`stayEnd`
   * are only the derived min/max envelope and expanding them would invent nights
   * the guest is not staying — which would then be reported as capacity demand and
   * as hosting coverage that does not exist. Where a guest has no night rows at
   * all (a booking written before #713) the envelope IS the footprint, and
   * refusing to expand it would report a party of zero nights.
   */
  const guestNights = new Map<string, string[]>();
  for (const guest of guests) {
    guestNights.set(guest.id, boundedGuestNightFootprint(guest));
  }

  const checkInDay = formatDateOnly(booking.checkIn);
  const checkOutDay = formatDateOnly(booking.checkOut);

  /**
   * The season the two subscription-sensitive rules will be judged in, resolved
   * from STORED state and keyed on the CHECK-IN night — a stay is judged in the
   * season it falls in, not the season the diagnostic is run in.
   *
   * RESOLVED ONLY WHEN IT WILL BE USED. A deleted or terminal booking runs neither
   * rule (see the five suppressed calls below), so asking for the season there
   * would let a club that follows Xero for its financial year lose ALL block-state
   * evidence about a cancelled booking over a question that booking never asks.
   * `null` on those rows is "not needed", and it is never passed anywhere.
   */
  const seasonYear =
    deleted || terminal
      ? null
      : await resolveStoredNightSeasonYear(booking.checkIn, tx);

  /**
   * The club's subscription-lockout mode, read ONCE and STRICTLY, then handed to
   * both rules below.
   *
   * TWO REASONS, and the second is the one a reviewer should check.
   *
   * AUTHORITY. Left to themselves, the paid-up-adult rule and the hosting
   * subscription bridge each peek the mode through readers that turn a database
   * failure into "every optional module off" — which composes to `NO_BLOCK`, "this
   * club does not block unfinancial members". For a booking write that is a safe
   * direction to fail; for evidence it is a fabricated statement about the club's
   * own policy, and the mode is the qualifier on every subscription finding this row
   * makes. The strict reader lets the failure through and the executor reports
   * `evidence_unavailable`.
   *
   * CONSISTENCY. Two independent reads in one invocation can disagree if an
   * administrator saves the settings panel between them, and this row would then
   * report a policy violation judged under one regime beside a hosting answer judged
   * under another. One read, handed to both, cannot.
   *
   * Resolved only for a live booking, on exactly the same reasoning as the season
   * above: a suppressed booking runs neither rule.
   */
  const subscriptionLockoutMode =
    deleted || terminal ? null : await peekSubscriptionLockoutModeStrict(tx);

  /**
   * HOW EVERY SUBSCRIPTION RULE ON THIS ROW READS THE CLUB'S AGE-TIER SETTINGS —
   * once, strictly, and inside this transaction.
   *
   * THE HOLE THIS CLOSES. The per-tier `subscriptionRequiredForBooking` flag is what
   * decides whether a named member owes a subscription, and three rules on this row
   * consult it: the club's own `HARD_BLOCK` refusal below, the `NON_MEMBER_PRICING`
   * paid-up-adult rule inside the policy evaluator, and the #2364 hosting bridge.
   * The first read it strictly already. The other two reach it through
   * `loadMemberSubscriptionSettlements`, which called `getAgeTierSettings()` — a
   * reader with NO client parameter at all, dynamic-importing the global Prisma
   * client, serving a five-minute cache, and CATCHING every database error to return
   * `AGE_TIER_DEFAULTS`. So on a `NON_MEMBER_PRICING` club one input to this row's
   * subscription findings ran outside the snapshot, outside the statement timeout and
   * outside `READ ONLY`, and a transient failure of that one read produced
   * `policy_paid_up_adult_member` — and, through the bridge,
   * `policy_adult_member_hosting` — against a named member on the strength of the
   * PLATFORM's default tier rule rather than the club's. A fabricated financial
   * accusation, and the exact reader this file's own header cites as its reason for
   * refusing `requiresPaidSubscriptionForMemberForBooking`.
   *
   * A READER, NOT AN ARRAY, and that is the whole reason this can be threaded at all.
   * Both rules consult the tier rule only under `NON_MEMBER_PRICING` and only for a
   * non-empty member set; the refusal consults it only on a gated draft under
   * `HARD_BLOCK`. Reading the settings eagerly here would pay for a read most
   * invocations do not need and — much worse — would make a failed read REFUSE a row
   * that had no subscription finding in it. `readOnce` therefore reads on FIRST USE
   * and memoises the promise, so a row that consults the rule twice (evaluator and
   * bridge) observes one set of settings, and a row that never consults it never
   * reads.
   *
   * The same value also serves the `HARD_BLOCK` refusal below, so all three rules on
   * one row are judged against ONE observation of the club's tier policy — the same
   * consistency argument as the single mode read above.
   */
  const readAgeTierSettings = readOnce(() => getAgeTierSettingsStrict(tx));

  /** The open exception requests, and whether any of them is actually holding beds. */
  const openRequests = await tx.bookingChangeRequest.findMany({
    where: { bookingId, status: "REQUESTED" },
    select: {
      id: true,
      kind: true,
      holdExpiresAt: true,
      createdAt: true,
      _count: { select: { reservationNights: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: AID6B_OPEN_REQUEST_CEILING + 1,
  });
  assertPopulationWithinCeiling(
    openRequests.length,
    AID6B_OPEN_REQUEST_CEILING,
    "open booking requests",
  );

  /**
   * The party as the policy evaluator wants it. Built from the LIVE rows, so the
   * violations reported are the violations the booking currently carries — not the
   * ones frozen into whatever request an officer last looked at.
   */
  const party = {
    checkIn: checkInDay,
    checkOut: checkOutDay,
    guests: guests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: String(guest.ageTier),
      isMember: guest.isMember,
      memberId: guest.memberId,
      nights: guestNights.get(guest.id) ?? [],
    })),
  };

  /**
   * The three reads that can each fail independently, run together so one slow
   * one does not serialise behind the others — and awaited as a set, because a
   * row missing any of them is not a row this source may return.
   *
   * `checkCapacity` is called with a guest count of ZERO and this booking
   * EXCLUDED. That is not a shortcut: `nightDetails` is what the tool reports, and
   * with the booking excluded each night's `occupiedBeds` and `availableBeds` are
   * the room the rest of the lodge leaves for it. The party's own demand is
   * computed separately from `guestNights`, so "does it fit" is a comparison the
   * row shows its working for rather than a boolean the engine returns for a
   * headcount that ignores non-contiguous stays.
   */
  const [
    nonHostingViolations,
    hostingEvaluation,
    capacity,
    conflicts,
    ownerSubscriptionHardBlocked,
  ] =
    await Promise.all([
    // Terminal and deleted bookings skip the policy evaluation entirely. It is not
    // an optimisation: evaluating a cancelled booking's party would produce
    // violations that are true of the rows and false of the world, and the
    // suppression below would then have to be trusted to drop every one of them.
    deleted || terminal
      ? Promise.resolve([])
      : evaluatePersistedBookingNonHostingPolicyViolations(
          tx,
          booking.lodgeId,
          party,
          {
          requestedByMemberId: booking.memberId,
          bookingId: booking.id,
          },
          {
            // The paid-up-adult rule reads `MemberSubscription` by
            // `(memberId, seasonYear)`. Left to itself it would take the season from
            // the process-level financial-year cache no diagnostics path seeds, and
            // the mode from a reader that swallows a failure into `NO_BLOCK`.
            seasonYear: requireResolvedSeasonYear(seasonYear),
            subscriptionLockoutMode: requireResolvedLockoutMode(
              subscriptionLockoutMode,
            ),
            // And the third swallowing read the rule would otherwise reach on its
            // own: the CACHED age-tier settings inside
            // `loadMemberSubscriptionSettlements`. See the declaration above.
            readAgeTierSettings,
          },
        ),
    deleted || terminal
      ? Promise.resolve(null)
      : evaluatePersistedBookingAdultMemberHostingReadOnly(booking.id, tx, {
          // Same two reasons, for #2543's subscription bridge inside the hosting
          // rule — and the same single mode value, so the two rules cannot disagree.
          seasonYear: requireResolvedSeasonYear(seasonYear),
          /**
           * THE WIDEST FAN-OUT IN EITHER PACK, given a deterministic ceiling.
           *
           * The sibling read is unbounded for a writer, and must be: its answer has
           * to see every booking that could cover a night. Each sibling arrives with
           * its guests and their night rows, so for a diagnostic it is also the read
           * most able to turn one invocation into a large one. An evidence caller
           * must either answer or say it could not, so it passes a ceiling and gets
           * a refusal rather than a quietly short host list.
           */
          siblingCeiling: AID6B_HOSTING_SIBLING_CEILING,
          /**
           * AND THE OTHER HOST POPULATION, which the sibling ceiling did not cover.
           *
           * `loadSameBookingOwnerHosts` is reached whenever the lodge has the
           * same-booking-owner host scope on, and its writer bound TRUNCATES with no
           * order. For a writer that errs towards flagging; here it would drop the
           * sibling carrying the covering adult and report
           * `policy_adult_member_hosting` as a live blocker on a covered booking,
           * non-deterministically. Two ceilings, because they bound two populations
           * whose bindings mean different things to an operator.
           */
          sameOwnerSourceCeiling: AID6B_HOSTING_SAME_OWNER_SOURCE_CEILING,
          subscriptionLockoutMode: requireResolvedLockoutMode(
            subscriptionLockoutMode,
          ),
          // Same third reader, for the #2543 bridge inside the hosting rule: the
          // bridge reaches the same settlement loader, so without this it read the
          // club's tier rule through the cache that answers a failed read with the
          // platform's defaults.
          readAgeTierSettings,
        }),
    deleted || terminal
      ? Promise.resolve(null)
      : checkCapacity(
          booking.lodgeId,
          booking.checkIn,
          booking.checkOut,
          0,
          booking.id,
          // The capacity engine reads three populations no `Booking` query would
          // find; every one of them belongs inside this snapshot and under this
          // statement timeout, or the widest read in the entry is the one read the
          // database cannot cancel.
          tx,
        ),
    deleted || terminal
      ? Promise.resolve([])
      : findBookingMemberNightConflicts(tx, {
          // The ACTING identity here is the booking's own owner, not the
          // administrator running the diagnostic. The conflict scan's privileged
          // fields are gated on the actor's role, and passing a real admin role
          // would put another member's booking reference into a refusal payload
          // this tool then projects. `"USER"` is the least-privileged answer and
          // the tool reports only counts and nights, never the counterpart
          // booking.
          actorMemberId: booking.memberId,
          actorRole: "USER",
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          // Resolved outside this transaction and threaded in (`INV-LOCK-004`).
          today: todayAtClub,
          guests: guests.map((guest) => ({
            memberId: guest.memberId,
            stayStart: guest.stayStart,
            stayEnd: guest.stayEnd,
            nights: (guestNights.get(guest.id) ?? []).map(
              (night) => new Date(`${night}T00:00:00.000Z`),
            ),
          })),
          excludeBookingId: booking.id,
        }),
    /**
     * THE CLUB'S OWN `HARD_BLOCK` REFUSAL, and the one gate in this list that is
     * skipped for a reason other than suppression.
     *
     * Three conditions, all of them the enforcement site's own: the gated door is
     * this booking's own next step — a zero-price draft, both halves of what
     * `confirm-draft` checks before its refusal, see
     * `subscriptionHardBlockGatesThisBooking` — the club's strictly-read mode is
     * `HARD_BLOCK`, and only then is the owner's settlement read at all. The routes
     * short-circuit in exactly that order — `subscriptionLockoutMode ===
     * "HARD_BLOCK" && await requiresPaidSubscriptionForMemberForBooking(...)` — so
     * a `NO_BLOCK` or `NON_MEMBER_PRICING` club pays for no extra read and gets no
     * finding, which is correct: under those modes the club does not refuse.
     */
    deleted ||
    terminal ||
    !subscriptionHardBlockGatesThisBooking(booking) ||
    requireResolvedLockoutMode(subscriptionLockoutMode) !== "HARD_BLOCK"
      ? Promise.resolve(false)
      : readOwnerSubscriptionHardBlock(tx, {
          memberId: booking.memberId,
          seasonYear: requireResolvedSeasonYear(seasonYear),
          ageTier: booking.member?.ageTier ?? null,
          readAgeTierSettings,
        }),
    ]);

  if (!deleted && !terminal && hostingEvaluation === null) {
    throw new Error(
      "AI Diagnostics AID-6B: booking disappeared while persisted hosting evidence was being assembled",
    );
  }
  const violations = [
    ...nonHostingViolations,
    ...(hostingEvaluation?.violation ? [hostingEvaluation.violation] : []),
  ];

  const heldNightCount = openRequests.reduce(
    (total, request) => total + request._count.reservationNights,
    0,
  );
  /**
   * The earliest hold deadline among the requests that are ACTUALLY holding beds.
   *
   * The reservation-night COUNT is the test, never `holdExpiresAt IS NOT NULL`.
   * The schema states the trap in as many words: a row written before that column
   * existed can be holding beds with a NULL deadline, so filtering a capacity
   * question on the deadline would report "no beds held" about beds that are held.
   */
  const holdDeadlines = openRequests
    .filter((request) => request._count.reservationNights > 0)
    .map((request) => request.holdExpiresAt)
    .filter((deadline): deadline is Date => deadline !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  const nextHoldExpiresAt = holdDeadlines[0] ?? null;

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    // The BOOKING OWNER's role, deliberately, and not the administrator's. This
    // field answers "can the member fix this themselves, or does it need an
    // officer", which is one of the two next-step questions #2376 asks for; the
    // admin answer is always yes-with-an-override and would tell an operator
    // nothing.
    role: "USER",
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    // #3123 — the CLUB's day, from its persisted zone. A diagnostic that reported
    // a booking as locked on the environment's day would be describing a state
    // the member never saw. Resolved by this entry point BEFORE it opened the
    // bounded read-only transaction, and shared with the person-night scan above
    // so the two halves of one snapshot cannot disagree (`INV-LOCK-004`).
    today: todayAtClub,
  });

  const reviewCodes = bookingReviewReasonCodes({
    requiresAdminReview: booking.requiresAdminReview,
    adminReviewStatus: booking.adminReviewStatus,
    adultMemberHostingReviewStatus: booking.adultMemberHostingReviewStatus,
  });

  /**
   * A pending review, keyed on the STATUS and not on the flag.
   *
   * `requiresAdminReview === true` with `adminReviewStatus === "APPROVED"` is a
   * booking an officer has already cleared. Reporting it as blocked would be the
   * exact defect AID-6C's review found in its sibling — a predicate reading the
   * wrong one of two columns that usually agree — and the platform's own
   * `isCheckinBlockedByPendingReview` is the conjunction, so this delegates to it
   * rather than restating it.
   */
  const adminReviewPending = isCheckinBlockedByPendingReview({
    requiresAdminReview: booking.requiresAdminReview,
    adminReviewStatus: booking.adminReviewStatus,
    // The predicate ignores the reason; passing null keeps this call from needing
    // a column the projection must never carry.
    adminReviewReason: null,
  });
  const hostingReviewPending = booking.adultMemberHostingReviewStatus === "PENDING";

  const reasonCodes = new Set(violations.map((violation) => violation.reasonCode));

  /** Per-night demand from the live footprint, and the tightest night. */
  const demandByNight = new Map<string, number>();
  for (const nights of guestNights.values()) {
    for (const night of nights) {
      demandByNight.set(night, (demandByNight.get(night) ?? 0) + 1);
    }
  }
  const nightDetails = capacity?.nightDetails ?? [];
  let shortfallNights = 0;
  let wholeLodgeHeldNights = 0;
  let tightestSpareBeds: number | null = null;
  for (const detail of nightDetails) {
    const night = formatDateOnly(detail.date);
    const demand = demandByNight.get(night) ?? 0;

    /**
     * An exclusive hold is a POLICY refusal, not a numeric capacity shortfall.
     * `checkCapacity` pins `availableBeds` to zero for that refusal regardless of
     * occupancy or this booking's demand. Subtracting demand from that pin would
     * manufacture a negative spare figure, raise `capacity_exceeded` beside the
     * authoritative `whole_lodge_held` reason, and suggest that an admin
     * over-capacity confirmation could admit the booking when that path expressly
     * cannot bypass an exclusive hold.
     *
     * Count the hold, then withhold ordinary spare/shortfall arithmetic for this
     * night. If every night is held, `tightestSpareBeds` remains honestly absent:
     * there was no ordinary capacity measurement from which to derive it.
     */
    if (detail.wholeLodgeHeld === true) {
      wholeLodgeHeldNights += 1;
      continue;
    }

    const spare = detail.availableBeds - demand;
    if (tightestSpareBeds === null || spare < tightestSpareBeds) {
      tightestSpareBeds = spare;
    }
    if (spare < 0) shortfallNights += 1;
  }

  /**
   * Which blockers are TRUE of this booking, as a predicate per code. Filtered
   * against the catalogue below so the emitted order is the declared order — the
   * dead `sort` AID-6C's review removed cannot come back here, because there is no
   * comparator to drop.
   */
  const raised: Record<BookingBlockerCode, boolean> = {
    booking_deleted: deleted,
    /**
     * TERMINAL ONLY WHEN IT IS NOT THE DELETION SAYING SO.
     *
     * Every deleted booking is already CANCELLED. `deleteBooking` in
     * `src/lib/booking-delete.ts` refuses any other status (it 400s unless the row
     * is `CANCELLED`), it is the only writer of `Booking.deletedAt` in the tree,
     * and there is no restore path — so `deleted === true` implies
     * `terminal === true` for every row this source can read.
     *
     * Raising both therefore reported ONE fact twice, as two separate blockers,
     * with `blocker_count` inflated to match: an operator reading
     * "booking_deleted, booking_lifecycle_terminal" is told to go to the
     * deleted-bookings view AND to read a cancellation record, when the second is
     * only the mechanical precondition of the first. The deletion is the wider
     * fact and it is the one whose next step is real, so it is the only one
     * emitted — the same reason `booking_lifecycle_state` reports `deleted` rather
     * than `terminal` on the same row.
     *
     * `terminal` itself is NOT narrowed: it still drives `suppressed` below, so a
     * deleted booking keeps suppressing every downstream blocker exactly as
     * before. This is about what gets REPORTED, not about what gets evaluated.
     */
    booking_lifecycle_terminal: terminal && !deleted,
    booking_waitlisted: waitlisted,
    member_night_conflict: conflicts.length > 0,
    // A waitlisted booking does not fit BY DEFINITION. Reporting the shortfall as
    // a blocker would outrank the status that explains it, so the shortfall stays
    // a reported FACT (`shortfallNightCount`) on those two statuses.
    capacity_exceeded: shortfallNights > 0 && !waitlisted,
    whole_lodge_held: wholeLodgeHeldNights > 0,
    admin_review_pending: adminReviewPending,
    hosting_review_pending: hostingReviewPending,
    policy_minimum_stay: reasonCodes.has("MINIMUM_STAY"),
    policy_adult_member_hosting: reasonCodes.has("ADULT_MEMBER_HOSTING_REQUIRED"),
    /**
     * THE ONE BLOCKER THE POLICY EVALUATOR STRUCTURALLY CANNOT PRODUCE.
     *
     * Every other `policy_*` code above comes from a violation the soft-policy
     * evaluator returned. This one cannot: `evaluateNonMemberPricingRequirements`
     * returns `null` unless the club chose `NON_MEMBER_PRICING`, so under the
     * DEFAULT `HARD_BLOCK` the evaluator is silent by design — the refusal there is
     * a flat 403 at the route, not an exception-eligible violation. Reading that
     * silence as "nothing is blocking" is what this entry did before.
     */
    subscription_unpaid_hard_block: ownerSubscriptionHardBlocked,
    policy_paid_up_adult_member: reasonCodes.has("PAID_UP_ADULT_MEMBER_REQUIRED"),
    exception_request_open: openRequests.length > 0,
    exception_hold_expiring: nextHoldExpiresAt !== null,
    edit_window_locked: !editPolicy.canModify,
  };

  const suppressed = deleted || terminal;
  const blockers = BOOKING_BLOCKER_CODES.filter((code) => {
    if (!raised[code]) return false;
    if (!suppressed) return true;
    return (
      code === "booking_deleted" ||
      code === "booking_lifecycle_terminal" ||
      TERMINAL_SURVIVING_BLOCKERS.includes(code)
    );
  });

  return [
    {
      booking_id: booking.id,
      booking_reference: formatBookingReference(booking.id),
      owner_member_ref: booking.memberId,
      lodge_ref: booking.lodgeId,
      booking_status: booking.status,
      check_in: checkInDay,
      check_out: checkOutDay,
      guest_count: guests.length,
      /**
       * ONE field for three states, and not two booleans, because the substrate
       * caps a row at 24 fields and because two booleans are misreadable in
       * combination — a reader who sees `deleted: true, terminal: true` has to
       * work out which of the two is the fact and which is its precondition.
       *
       * `deleted` wins over `terminal` because it is the wider fact and the
       * operator's next step differs: a cancelled booking has a cancellation record
       * to read, a deleted one is in the deleted-bookings view. Deletion is only
       * reachable FROM `CANCELLED` (`deleteBooking` refuses any other status and is
       * the only writer of `deletedAt`), so every deleted booking is terminal too
       * and this ordering is what makes the field answer the operator's question
       * rather than the schema's. The blocker list is narrowed on exactly the same
       * ground: `booking_lifecycle_terminal` is not raised beside
       * `booking_deleted`.
       */
      booking_lifecycle_state: deleted ? "deleted" : terminal ? "terminal" : "live",
      // The ADMIN review gate, as the platform's own check-in predicate answers it.
      admin_review_pending: adminReviewPending,
      hosting_review_pending: hostingReviewPending,
      review_reason_codes: reviewCodes.length > 0 ? reviewCodes.join(",") : null,
      policy_violation_codes:
        violations.length > 0
          ? [...new Set(violations.map((violation) => violation.reasonCode))]
              .sort()
              .join(",")
          : null,
      // The HOLD-if-any-HOLD aggregate over the live violations. It decides whether
      // an exception request would reserve real beds while it waits, which is the
      // difference between a member keeping their place and losing it.
      policy_capacity_mode: violations.some(
        (violation) => violation.capacityMode === "HOLD",
      )
        ? "HOLD"
        : violations.length > 0
          ? "NO_HOLD"
          : null,
      /**
       * THE THREE COUNTS THAT ARE ONLY A NUMBER IF THE CALCULATION RAN.
       *
       * On a terminal or deleted booking this source suppresses the conflict scan
       * and the capacity read entirely, so there is no count to report — and a `0`
       * is not the honest way to say so. `0 member-night conflicts` and
       * `0 nights short` read as measurements, and an operator acting on them
       * concludes the booking is fine when nothing was ever measured. That is the
       * same conflation `tightestSpareBeds` already refused on the line below, and
       * the earlier revision of this row refused it for ONE field out of four.
       *
       * `null` here means "not measured", exactly as it does two lines down, and
       * the entry's scope line says so in as many words.
       */
      member_night_conflict_count: deleted || terminal ? null : conflicts.length,
      shortfall_night_count: capacity === null ? null : shortfallNights,
      whole_lodge_held_night_count:
        capacity === null ? null : wholeLodgeHeldNights,
      // `null` and not `0` when the capacity engine did not run: on a terminal or
      // deleted booking there is no shortfall to report, and a zero would read as
      // "it fits", which is a claim about a booking that no longer exists.
      //
      // THIS GUARD IS DELIBERATELY REDUNDANT and no mutation can detect it: the
      // accumulator is initialised to `null` and only assigned inside a loop over
      // `capacity?.nightDetails ?? []`, so a null capacity already yields null.
      // It is kept because the three fields above it are the same claim and are
      // NOT redundant, and a reader comparing the four should not have to
      // reconstruct which one leans on an initialiser to be correct. Removing it
      // would make this field's correctness depend on a declaration eighty lines
      // away rather than on the line itself.
      tightest_spare_beds: capacity === null ? null : tightestSpareBeds,
      open_exception_request_count: openRequests.length,
      exception_held_night_count: heldNightCount,
      exception_hold_expires_at_utc: nextHoldExpiresAt?.toISOString() ?? null,
      member_can_modify: editPolicy.canModify,
      edit_window_mode: editPolicy.mode,
      blocker_codes: blockers.length > 0 ? blockers.join(",") : null,
      blocker_count: blockers.length,
      observed_at_utc: new Date().toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// 2. Per-night capacity, as the booking engine computes it.
// ---------------------------------------------------------------------------

async function readBoundedAllocationCounts(args: {
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  /**
   * The CALLER's transaction, and not one opened here.
   *
   * This read used to open its own bounded read-only transaction, which was the
   * first place in the pack to put PostgreSQL's own cancellation behind a
   * diagnostics read. Now that the whole entry runs inside one
   * (`withBoundedReadOnlyTransaction`), opening a second would be a NESTED
   * interactive transaction on a second pool connection — a second snapshot, a
   * second timeout, and the pool-starvation shape `docs/CONCURRENCY_AND_LOCKING.md`
   * forbids. It joins the caller's instead, so the bound is unchanged and the rows
   * agree with the capacity figures they sit beside.
   */
  tx: Prisma.TransactionClient;
}): Promise<Map<string, number>> {
  const allocations = await args.tx.bedAllocation.findMany({
    where: {
      bookingId: args.bookingId,
      stayDate: { gte: args.checkIn, lt: args.checkOut },
      // A corrupt allocation whose guest belongs to another booking is not
      // evidence about this selected booking. Keep it out structurally rather
      // than counting it and later trying to explain the inconsistency away.
      bookingGuest: { is: { bookingId: args.bookingId } },
    },
    select: { stayDate: true },
    orderBy: [{ stayDate: "asc" }, { id: "asc" }],
    take: AID6B_ALLOCATION_COUNT_CEILING + 1,
  });
  assertPopulationWithinCeiling(
    allocations.length,
    AID6B_ALLOCATION_COUNT_CEILING,
    "in-envelope booking bed allocations",
  );

  const byNight = new Map<string, number>();
  for (const allocation of allocations) {
    const night = formatDateOnly(allocation.stayDate);
    byNight.set(night, (byNight.get(night) ?? 0) + 1);
  }
  return byNight;
}

/**
 * One row per lodge night of a booking's stay: what the rest of the lodge occupies
 * that night, what is left, whether the night is exclusively held, and what this
 * booking's own party demands of it.
 *
 * WHY `checkCapacity` AND NOT A QUERY. Its occupancy figure already includes three
 * populations no `Booking` query would find: custodian bed holds (a
 * `HutLeaderAssignment` with a `bedId`, which has no booking and no allocation
 * row), held policy-exception reservations, and the whole-lodge exclusive hold that
 * pins `availableBeds` to zero regardless of headcount. A diagnostic that reported
 * "eight beds free" on a night a custodian has taken four of them would send an
 * officer to confirm a booking the engine will then refuse.
 */
export async function readBookingCapacityEvidence(args: {
  bookingId: string;
}): Promise<readonly DiagnosticsToolRawRow[]> {
  return withDeadline(
    withBoundedReadOnlyTransaction((tx) => readBookingCapacity(args.bookingId, tx)),
    "booking capacity",
  );
}

async function readBookingCapacity(
  bookingId: string,
  tx: Prisma.TransactionClient,
): Promise<readonly DiagnosticsToolRawRow[]> {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      lodgeId: true,
      status: true,
      checkIn: true,
      checkOut: true,
      deletedAt: true,
      wholeLodgeHold: true,
      adminCapacityHoldAt: true,
      originBookingRequest: { select: { id: true } },
      capacityOverriddenAt: true,
    },
  });
  if (!booking) return [];

  // This MUST precede the guest-envelope expansion below and `checkCapacity`.
  // The executor deadline cannot cancel either once started.
  assertCapacitySpanWithinCeiling(booking.checkIn, booking.checkOut);

  const guests = await tx.bookingGuest.findMany({
    where: { bookingId },
    select: {
      id: true,
      stayStart: true,
      stayEnd: true,
      nights: {
        select: { stayDate: true },
        orderBy: { stayDate: "asc" },
        take: AID6B_CAPACITY_NIGHT_CEILING + 1,
      },
    },
    orderBy: { id: "asc" },
    take: AID6B_BOOKING_GUEST_CEILING + 1,
  });
  assertPopulationWithinCeiling(
    guests.length,
    AID6B_BOOKING_GUEST_CEILING,
    "booking guests",
  );

  const demandByNight = new Map<string, number>();
  for (const guest of guests) {
    const nights = boundedGuestNightFootprint(guest);
    for (const night of nights) {
      demandByNight.set(night, (demandByNight.get(night) ?? 0) + 1);
    }
  }

  const capacity = await checkCapacity(
    booking.lodgeId,
    booking.checkIn,
    booking.checkOut,
    0,
    booking.id,
    tx,
  );

  const allocatedByNight = await readBoundedAllocationCounts({
    bookingId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    tx,
  });

  const observedAt = new Date().toISOString();
  /**
   * THE BOOKING'S OWN LIFECYCLE, ON EVERY NIGHT ROW.
   *
   * `status` and `deletedAt` were selected here and read by nothing, and the
   * consequence was not a dead read. This entry has no lifecycle suppression — the
   * capacity engine's answer about the LODGE is true whether or not this booking
   * is still live — so a CANCELLED or soft-deleted booking produced perfectly
   * healthy-looking rows saying `fitsThisNight: true`, with nothing anywhere on the
   * row to say the booking is over. An operator reading "it fits" about a booking
   * whose next step is a confirmation has been told the opposite of what matters.
   *
   * Suppressing the rows would be the wrong fix: "what room was there on those
   * nights" is a legitimate and answerable question about a cancelled booking, and
   * it is one an officer asks precisely BECAUSE the booking is cancelled. So the
   * figures stand and the row carries the fact that qualifies them, in the same
   * three-valued shape and with the same precedence (`deleted` beats `terminal`)
   * that `booking_block_state` uses, so a consumer learns one vocabulary.
   */
  const lifecycleState =
    booking.deletedAt !== null
      ? "deleted"
      : TERMINAL_BOOKING_STATUSES.includes(booking.status)
        ? "terminal"
         : "live";
  const rawWholeLodgeHold = booking.wholeLodgeHold;
  const effectiveWholeLodgeHold =
    booking.deletedAt === null &&
    rawWholeLodgeHold &&
    bookingHoldsCapacity({
      status: booking.status,
      isRequestConverted: booking.originBookingRequest !== null,
      hasAdminCapacityHold: booking.adminCapacityHoldAt !== null,
    });
  return capacity.nightDetails.map((detail) => {
    const night = formatDateOnly(detail.date);
    const demand = demandByNight.get(night) ?? 0;
    const wholeLodgeHeld = detail.wholeLodgeHeld === true;
    return {
      booking_id: booking.id,
      booking_reference: formatBookingReference(booking.id),
      lodge_ref: booking.lodgeId,
      booking_lifecycle_state: lifecycleState,
      night,
      /**
       * Excluding THIS booking, which is what makes the spare figure answerable —
       * and `null` on a WHOLE-LODGE-HELD night, which is not a rounding of the
       * engine's answer but a refusal to pass off a presentation pin as a count.
       *
       * `checkCapacity` deliberately PINS `occupiedBeds` to the lodge's full
       * capacity on a held night (ADR-001 decision 6, #118) so that a member
       * reading the public availability payload cannot distinguish a held night
       * from a genuinely full one. That is right for a member and WRONG for a
       * diagnostic: an operator handed "occupied 20 of 20" would conclude the lodge
       * is full when in fact one booking has reserved sole occupancy and the beds
       * are empty — and their next step (chase the other bookings, or over-capacity
       * confirm) would be the wrong one twice over, because an admin override
       * cannot punch into a held night at all.
       *
       * `availableBeds` is the engine's authoritative 0 on a held night: there is
       * no room another booking may use. But subtracting this booking's demand
       * from that policy pin would manufacture an ordinary negative shortfall,
       * and zero demand would manufacture `fits: true`. Therefore the derived
       * spare figure is absent and `fits` is false regardless of demand; the hold
       * fact is the only reason an operator should act on.
       */
      occupied_beds_excluding_this_booking: wholeLodgeHeld
        ? null
        : detail.occupiedBeds,
      available_beds_excluding_this_booking: detail.availableBeds,
      party_beds_this_night: demand,
      spare_beds_after_this_booking: wholeLodgeHeld
        ? null
        : detail.availableBeds - demand,
      fits_this_night:
        !wholeLodgeHeld && detail.availableBeds - demand >= 0,
      whole_lodge_held_by_another_booking: wholeLodgeHeld,
      this_booking_effectively_holds_whole_lodge: effectiveWholeLodgeHold,
      this_booking_has_whole_lodge_hold_flag: rawWholeLodgeHold,
      capacity_overridden: booking.capacityOverriddenAt !== null,
      allocated_bed_nights: allocatedByNight.get(night) ?? 0,
      observed_at_utc: observedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. The authoritative member eligibility state.
// ---------------------------------------------------------------------------

/**
 * THE authoritative answer to "why is this member blocked, or charged non-member
 * rates".
 *
 * It composes six independent authorities and reports each one's answer beside the
 * others, because they answer different questions and collapsing them is how a
 * membership diagnostic becomes wrong:
 *
 *  - the LIFECYCLE label, from the platform's own resolver, with erasure detected
 *    rather than inferred;
 *  - the MEMBERSHIP TYPE for the season, resolved through
 *    `SeasonalMembershipAssignment` with the documented role-default fallback, and
 *    the booking and subscription BEHAVIOURS it carries;
 *  - the SUBSCRIPTION SETTLEMENT fact, from the pure rule every gate shares;
 *  - the club's LOCKOUT MODE, which decides what that fact costs;
 *  - the ADULT-MEMBER-HOST predicate, unchanged from the hosting policy's own;
 *  - the INDUCTION state, reported as a warning and NOT as a booking blocker.
 *
 * INDUCTION DOES NOT GATE A BOOKING IN THIS RELEASE, and saying so is the most
 * useful sentence this tool carries. #2376 lists induction among the conditions
 * that block a booking. It does not: `MemberInduction` is read by the nomination
 * gate, the member dashboard card and the induction sign-off surfaces, and no
 * booking-create, booking-modify or capacity path reads it at all.
 * `Member."requiresInduction"` is an administrator's flag, not an enforcement.
 * Reporting an outstanding induction as a booking blocker would send an officer to
 * complete an induction that will not change the answer.
 */
export async function readMemberEligibilityEvidence(args: {
  memberId: string;
}): Promise<readonly DiagnosticsToolRawRow[]> {
  return withDeadline(
    withBoundedReadOnlyTransaction((tx) =>
      readMemberEligibility(args.memberId, tx),
    ),
    "member eligibility",
  );
}

async function readMemberEligibility(
  memberId: string,
  tx: Prisma.TransactionClient,
): Promise<readonly DiagnosticsToolRawRow[]> {
  /**
   * THE SEASON YEAR IS NOT THE CALENDAR YEAR, and this entry computed it as if it
   * were until #2679's review.
   *
   * `clubSeasonYear` (`financial-year.ts`) is the platform's ONE derivation for
   * this question and every call site shares it, including the admin member detail
   * screen this entry mirrors. A
   * season starts on the first of the month AFTER the club's financial year-end —
   * April by default (the NZ 31-March convention) and club-configurable through
   * `financialYearEndMonth` — so from 1 January until the season starts, the
   * season year is the PREVIOUS calendar year. `new Date().getUTCFullYear()` was
   * right for nine months and wrong for three, and the three were not a rounding
   * error: `resolveMembershipTypePolicyForMember` found no assignment for a season
   * that had not started (so `membershipTypeSource` fell back to a default, which
   * this entry's scope line tells the model means NO assignment exists), the
   * `memberId_seasonYear` lookup missed the row entirely (so `subscriptionStatus`
   * went null, which the same scope line calls "no season row exists at all"), and
   * the settlement rule then raised `subscription_unpaid` — and with it
   * `qualifiesAsAdultMemberHost: false` — against a fully paid-up adult member.
   *
   * IT ALSO MADE TWO ENTRIES IN THIS PACK CONTRADICT EACH OTHER.
   * `booking_block_state` reaches the same question through the paid-up-adult rule
   * and the hosting subscription bridge, both keyed on the BOOKING's check-in
   * night, because a stay is judged in the season it falls in. This entry is
   * MEMBER-scoped with no booking to key on, so "now" is the right instant here —
   * but the RULE has to be the same one, or the two entries answer one question two
   * ways for a quarter of every year.
   *
   * THEY ARE STILL NOT THE SAME FUNCTION, and CT-4 group F1 (#2870) is why. A
   * booking's check-in is a stored calendar day and takes NO zone; "now" is an
   * instant and takes the club's PERSISTED zone. One helper answering both had to
   * read a `Date`'s host-local components, which made this pack's own answer depend
   * on where the container ran. So the pair is
   * `resolveStoredNightSeasonYear` / `resolveStoredClubSeasonYear`, sharing one
   * year-end resolution (`requireStoredYearEndMonth`) — which is what keeps the two
   * entries agreeing, and what keeps neither depending on the process-level
   * financial-year cache.
   */
  const seasonYear = await resolveStoredClubSeasonYear(tx);

  const member = await tx.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      // SELECTED AND NEVER PROJECTED. It is an input to the erasure test below —
      // an approved deletion rewrites the address to an anonymised one — and this
      // entry's projection has no field for it. The one entry that DOES return an
      // email address is `member_diagnostic_summary`, under the same permission,
      // for one selected member.
      email: true,
      ageTier: true,
      active: true,
      canLogin: true,
      cancelledAt: true,
      archivedAt: true,
      requiresInduction: true,
      hutLeaderEligible: true,
      joinedDate: true,
    },
  });
  if (!member) return [];

  const [typePolicy, subscription, ageTierSettings, lockoutMode, inductionStatus] =
    await Promise.all([
      resolveMembershipTypePolicyForMember(tx, { memberId, seasonYear }),
      tx.memberSubscription.findUnique({
        where: { memberId_seasonYear: { memberId, seasonYear } },
        select: { status: true, paidAt: true, manuallyMarkedPaidAt: true },
      }),
      /**
       * THE STRICT READERS, and this is an evidence path's whole difference from a
       * product path. `getAgeTierSettings` swallows a database failure into
       * `AGE_TIER_DEFAULTS`, and `peekSubscriptionLockoutMode` reads through two
       * functions that each turn one into a safe-looking default -- composed,
       * `NO_BLOCK`. Both are right for a booking screen and wrong here: on a cold
       * cache one transient failure would report a club's own configured tier rule
       * and lockout policy as observed when nothing observed them, and those two are
       * the qualifiers on every subscription finding this row makes. The strict
       * variants let the rejection through so the executor says
       * `evidence_unavailable`; a genuinely absent row still resolves to the
       * platform's documented default, which is what actually governs such a club.
       */
      getAgeTierSettingsStrict(tx),
      peekSubscriptionLockoutModeStrict(tx),
      /**
       * THE NARROW READ, and not `getInductionForMember`, which is the wide one.
       *
       * Both return the newest `MemberInduction` for the member by `createdAt`,
       * across every `InductionKind`. The difference is what comes back with it:
       * `getInductionForMember` is built for the member's own induction page and
       * its `include` materialises `finalComments`, `voidedReason`, every
       * sign-off's `comments` and `signerName`, the template's `competencyPrompt`,
       * `notesPrompt` and `legacySourceText`, the assigned signers' names and the
       * inductee's own name — health, safety and competency text, pulled into this
       * process on the application's FULL-PRIVILEGE connection, in the one module
       * whose header says the named `select` clauses ARE the boundary.
       *
       * Nothing ever leaked: only `.status` is read, twice, and the projection has
       * no field for any of the rest. But an unread wide read is the same defect
       * with none of the friction, exactly as the nine dropped columns on
       * `BLOCK_STATE_BOOKING_SELECT` were — one field name away from a projected
       * row, in a file where that distance is the whole control.
       */
      getInductionStatusForMember(memberId, tx),
    ]);

  const settlement = resolveMemberSubscriptionSettlement({
    subscriptionBehavior: typePolicy?.subscriptionBehavior ?? null,
    subscriptionStatus: subscription?.status ?? null,
    ageTier: member.ageTier,
    ageTierSettings,
  });
  const unpaid = subscriptionIsUnpaid(settlement);

  /**
   * The lifecycle label, from the resolver every admin badge uses — and
   * `deletedAccount` computed rather than left `false`.
   *
   * Erasure sets `active: false` and stamps NEITHER `cancelledAt` NOR
   * `archivedAt`, so a caller that omits this flag gets "Inactive" for an
   * anonymised account. That is not a cosmetic difference: an officer told a member
   * is merely inactive will try to reactivate them.
   *
   * THE PASSWORD HASH IS A PREDICATE, NOT A PROJECTION, and this is the one place
   * in either tool pack where that pattern is applied to a credential column.
   * `isDeletedAccountRecord` is the single definition of the erasure test and it is
   * a disjunction: the anonymised email address OR the sentinel password hash.
   * Reading a real password hash into a diagnostics module — even to compare it —
   * is not something this pack will do, and reading only the email half would make
   * the test silently incomplete for an account erased before the address was
   * rewritten. So the hash comparison happens INSIDE PostgreSQL as a `count` on an
   * equality against the server-written sentinel; only the boolean crosses the
   * boundary, and the sentinel constant is then handed back to the authoritative
   * predicate so the disjunction keeps exactly one definition. No member's real
   * hash is ever loaded, logged, hashed into an audit row or projected.
   */
  const erasedPasswordHash =
    (await tx.member.count({
      where: { id: memberId, passwordHash: DELETED_ACCOUNT_PASSWORD_HASH },
    })) > 0;
  const erased = isDeletedAccountRecord({
    email: member.email,
    passwordHash: erasedPasswordHash ? DELETED_ACCOUNT_PASSWORD_HASH : null,
  });
  const lifecycle = getLifecycleStatusConfig({
    deletedAccount: erased,
    active: member.active,
    cancelledAt: member.cancelledAt,
    archivedAt: member.archivedAt,
  });

  /**
   * The host predicate, called with exactly the facts it reads and with the two
   * optional inputs supplied EXPLICITLY.
   *
   * `operationallyPresent` and `subscriptionSettled` are both `!== false` tests
   * inside the predicate, so leaving them undefined would silently answer
   * "present and settled" for a member whose subscription is unpaid — the
   * false-positive shape this pack exists to avoid. `operationallyPresent` is
   * `true` here because the question is member-scoped rather than booking-scoped:
   * whether they are on a particular night is what `booking_block_state` answers.
   */
  const qualifiesAsHost = participantQualifiesAsHost({
    member: {
      id: member.id,
      ageTier: member.ageTier,
      active: member.active,
      cancelledAt: member.cancelledAt,
      archivedAt: member.archivedAt,
    },
    operationallyPresent: true,
    // The canonical predicate treats an ABSENT settlement fact as settled on
    // purpose. Production supplies the fact only under NON_MEMBER_PRICING,
    // because that is the sole mode in which an unpaid member is being charged
    // as a non-member and therefore stops qualifying as the responsible host.
    // NO_BLOCK and HARD_BLOCK preserve ordinary host qualification.
    ...(lockoutMode === "NON_MEMBER_PRICING"
      ? { subscriptionSettled: !unpaid }
      : {}),
  });

  const inductionComplete = inductionStatus === "COMPLETED";

  const raised: Record<MemberEligibilityCode, boolean> = {
    member_erased: erased,
    member_archived: member.archivedAt !== null,
    member_cancelled: member.cancelledAt !== null,
    // Only when nothing more specific explains it: an archived or cancelled member
    // is also inactive, and reporting both would make the list read as two
    // problems where there is one.
    member_inactive:
      !member.active &&
      !erased &&
      member.archivedAt === null &&
      member.cancelledAt === null,
    membership_type_blocks_booking: typePolicy?.bookingBehavior === "BLOCK_BOOKING",
    subscription_unpaid: unpaid,
    not_adult_age_tier: member.ageTier !== "ADULT",
    cannot_log_in: !member.canLogin,
    induction_outstanding: member.requiresInduction && !inductionComplete,
  };

  const codes = MEMBER_ELIGIBILITY_CODES.filter((code) => raised[code]);

  return [
    {
      member_id: member.id,
      lifecycle_label: lifecycle.label,
      member_erased: erased,
      is_active: member.active,
      can_login: member.canLogin,
      age_tier: String(member.ageTier),
      season_year: seasonYear,
      membership_type_key: typePolicy?.membershipType?.key ?? null,
      membership_type_source: typePolicy?.source ?? null,
      membership_booking_behavior: typePolicy?.bookingBehavior ?? null,
      membership_subscription_behavior: typePolicy?.subscriptionBehavior ?? null,
      // `null` and not a status string when no row exists: NOT_INVOICED is a real
      // stored state meaning "nobody has billed them", and a member with no row at
      // all is a different fact.
      subscription_status: subscription?.status ?? null,
      subscription_paid_at_utc: subscription?.paidAt?.toISOString() ?? null,
      subscription_manually_marked_paid:
        (subscription?.manuallyMarkedPaidAt ?? null) !== null,
      subscription_required: settlement.subscriptionRequired,
      subscription_paid: settlement.subscriptionPaid,
      subscription_unpaid: unpaid,
      subscription_lockout_mode: lockoutMode,
      qualifies_as_adult_member_host: qualifiesAsHost,
      requires_induction: member.requiresInduction,
      induction_status: inductionStatus,
      induction_complete: inductionComplete,
      // Stated on the row itself, not only in the scope line, because this is the
      // field most likely to be read as a booking blocker.
      induction_gates_booking: false,
      hut_leader_eligible: member.hutLeaderEligible,
      joined_date: member.joinedDate ? formatDateOnly(member.joinedDate) : null,
      eligibility_codes: codes.length > 0 ? codes.join(",") : null,
      eligibility_code_count: codes.length,
      observed_at_utc: new Date().toISOString(),
    },
  ];
}
