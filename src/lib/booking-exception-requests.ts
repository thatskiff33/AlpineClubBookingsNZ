import { createHash } from "node:crypto";

import { parseCalendarDate, startOfClubDay } from "@/lib/club-time";
import type { ClubTimeZone } from "@/lib/club-time";
import {
  aggregatePolicyExceptionViolations,
  sortPolicyExceptionViolations,
  isPolicyExceptionReasonCode,
  type AggregatedPolicyExceptions,
  type PolicyExceptionCapacityMode,
  type PolicyExceptionReasonCode,
  type PolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";

/**
 * The durable member-request + admin-decision workflow that sits ON TOP of the
 * #2363 exception foundation (#2365).
 *
 * #2363 owns the frozen VIOLATION shape and the HOLD-if-any-HOLD aggregate;
 * #2364 owns the two evaluators. This module owns the WORKFLOW facts a request
 * freezes and an approval re-checks, and it is deliberately PURE: no Prisma, no
 * clock, no I/O. Everything here is a deterministic function of its inputs, so
 * the proposal hash, the reservation footprint and the drift classification are
 * byte-reproducible and directly unit-testable. The transaction-aware execution
 * seam that loads live facts and calls the canonical booking service composes
 * these functions; it does not reimplement them.
 *
 * Two request flavours share this vocabulary:
 *
 *  - a **new-booking** request freezes the WHOLE proposed booking and, while
 *    held, reserves the FULL proposal's per-night beds;
 *  - a **modification** request freezes the live booking's base footprint AND
 *    the full proposed result, and while held reserves ONLY the incremental
 *    per-night beds beyond the unchanged live booking.
 */

/** The request lifecycle #2365 adds, mirroring BookingChangeRequestStatus. */
export const POLICY_EXCEPTION_REQUEST_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "SUPERSEDED",
  // #2553: the provisional hold ran out before anybody decided the request.
  "EXPIRED",
] as const;

export type PolicyExceptionRequestStatus =
  (typeof POLICY_EXCEPTION_REQUEST_STATUSES)[number];

/**
 * The four statuses that release a held request's provisional reservation and
 * admit no further transition. APPROVED is deliberately NOT terminal here: an
 * approval releases its reservation by turning it into the executed booking's
 * own beds INSIDE the same transaction, which is a different discipline from the
 * plain release the rejected/withdrawn/replaced/expired outcomes perform.
 */
export const TERMINAL_RELEASING_STATUSES = [
  "REJECTED",
  "CANCELLED",
  "SUPERSEDED",
  // #2553: the reaper's release runs the SAME atomic path as the other three
  // (guarded version CAS then request-scoped delete, under global -> lodge).
  "EXPIRED",
] as const satisfies readonly PolicyExceptionRequestStatus[];

export function isTerminalReleasingStatus(
  status: PolicyExceptionRequestStatus,
): status is (typeof TERMINAL_RELEASING_STATUSES)[number] {
  return (TERMINAL_RELEASING_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether a request in `status` may still be moved to `next` by the workflow.
 * REQUESTED is the only non-terminal state; every terminal state is a dead end.
 * A guarded `updateMany` enforces this at the database, but the predicate is
 * shared so the route, the service and the tests cannot disagree about it.
 */
export function isPolicyExceptionTransitionAllowed(
  from: PolicyExceptionRequestStatus,
  to: PolicyExceptionRequestStatus,
): boolean {
  if (from !== "REQUESTED") return false;
  return (
    to === "APPROVED" ||
    to === "REJECTED" ||
    to === "CANCELLED" ||
    to === "SUPERSEDED" ||
    to === "EXPIRED"
  );
}

// ---------------------------------------------------------------------------
// Provisional-hold time to live (#2553)
// ---------------------------------------------------------------------------

/**
 * How long a HOLD-mode policy-exception request may keep the beds it reserved
 * before the reaper releases them (#2553).
 *
 * Seven days is the officer-review window the club actually works to: long
 * enough that a request raised on a Friday survives a whole week of Booking
 * Officer availability, short enough that an abandoned request cannot phantom-
 * block a lodge for a season. It is a CONSTANT rather than a setting on purpose:
 * the deadline is stamped onto each request at creation and never rewritten, so
 * a hold's expiry is a stable, auditable fact rather than something a later
 * settings edit can move under a member.
 */
export const POLICY_EXCEPTION_HOLD_TTL_DAYS = 7;

/**
 * The floor on that window. A request raised the day before (or during) the
 * nights it wants is capped at the first held night by the rule below, which on
 * its own could produce a deadline in the PAST — the very next cron run would
 * then reap a request nobody has had a chance to look at. Every request gets at
 * least this long, whatever its lead time.
 */
export const POLICY_EXCEPTION_HOLD_MIN_TTL_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The moment a request's provisional hold runs out — pure, deterministic, and
 * the single definition both the request-creation path and the reaper use.
 *
 * Three rules, in plain English: a hold lasts {@link POLICY_EXCEPTION_HOLD_TTL_DAYS}
 * days; it never outlives the start of the first night it is holding (past that
 * point the stay has begun and an unactioned request is moot, so the beds should
 * go back into the pool); and it always lasts at least
 * {@link POLICY_EXCEPTION_HOLD_MIN_TTL_HOURS}, so a late request still gets a
 * real review window.
 *
 * `firstHeldNight` is a date-only lodge night (`YYYY-MM-DD`) — the earliest
 * night in the reservation footprint. Absent, or not a real calendar date (a
 * HOLD aggregate whose footprint did not grow, or the reaper's fallback for a
 * row written before the column existed) the cap simply does not apply.
 *
 * `zone` is REQUIRED and is the club's PERSISTED timezone (`INV-CONFIG-002`,
 * #3123). Turning a lodge night into the instant that night starts is the one
 * thing here that cannot be answered without a zone, and it used to be answered
 * from `APP_TIME_ZONE` — the environment's claim — so a club configured behind
 * its container's zone capped the hold on the wrong day. The parameter is
 * required rather than defaulted, and this function stays SYNCHRONOUS and PURE,
 * because both callers loop: the reaper walks every candidate row and the
 * request path is inside a creation flow, so a zone read in here would be one
 * uncached `ClubTimeSettings` query per row. Each caller resolves the club's
 * zone ONCE and passes it in.
 */
export function computePolicyExceptionHoldExpiry(input: {
  createdAt: Date;
  firstHeldNight?: string | null;
  ttlDays?: number;
  zone: ClubTimeZone;
}): Date {
  const ttlDays = input.ttlDays ?? POLICY_EXCEPTION_HOLD_TTL_DAYS;
  const createdMs = input.createdAt.getTime();
  const ttlDeadline = createdMs + ttlDays * DAY_MS;
  const floor = createdMs + POLICY_EXCEPTION_HOLD_MIN_TTL_HOURS * HOUR_MS;

  let deadline = ttlDeadline;
  if (input.firstHeldNight) {
    // A lodge night is a CALENDAR DAY (`YYYY-MM-DD`), and the value wanted here
    // is the INSTANT that day begins at the club — so the zone is genuinely
    // required, unlike a stored `@db.Date` comparison which takes none
    // (`INV-DATE-026`). An unparseable night keeps the pre-#3123 contract of
    // "the cap simply does not apply": the old adapter returned `new Date(NaN)`
    // and the `Number.isNaN` guard skipped it, and `parseCalendarDate`
    // returning null skips it here for the same reason.
    const night = parseCalendarDate(input.firstHeldNight);
    if (night !== null) {
      deadline = Math.min(deadline, startOfClubDay(night, input.zone).getTime());
    }
  }

  return new Date(Math.max(deadline, floor));
}

/**
 * The earliest night in a reservation footprint, as a `YYYY-MM-DD` string, or
 * null when the footprint reserves nothing. `computeProposalReservation` already
 * returns its nights sorted, but this does not assume that.
 */
export function firstReservedNight(
  reservation: readonly NightReservation[],
): string | null {
  let earliest: string | null = null;
  for (const entry of reservation) {
    if (entry.beds <= 0) continue;
    if (earliest === null || entry.night < earliest) earliest = entry.night;
  }
  return earliest;
}

// ---------------------------------------------------------------------------
// Request age (officer queue)
// ---------------------------------------------------------------------------

/**
 * How long a request has been waiting, in plain English (#2526 acceptance:
 * "queue shows request age").
 *
 * Age, not a timestamp, because the decision the officer is making is partly
 * "how long has this member been waiting?" — a date makes them do the
 * subtraction. Pure and clock-injected so it is unit-testable and renders
 * identically on the server and the client.
 */
export function formatPolicyExceptionRequestAge(
  createdAt: Date,
  now: Date = new Date(),
): string {
  const minutes = Math.floor((now.getTime() - createdAt.getTime()) / 60_000);
  // A clock skew (or a row created a moment ago) reads as "just now" rather
  // than a negative age.
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return days === 1 ? "1 day ago" : `${days} days ago`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}

// ---------------------------------------------------------------------------
// Member message
// ---------------------------------------------------------------------------

export const MEMBER_MESSAGE_MAX_LENGTH = 1000;

export class PolicyExceptionMemberMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyExceptionMemberMessageError";
  }
}

/**
 * The member's message is REQUIRED, trimmed, and capped at 1000 characters. It
 * is normalised once, at the request boundary, so the stored value is exactly
 * what every later surface renders. An empty-after-trim message is refused
 * rather than silently stored, because "explain why" with nothing to show an
 * admin is not a request anybody can decide.
 */
export function normalizeMemberMessage(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    throw new PolicyExceptionMemberMessageError(
      "A message for the Booking Officers is required.",
    );
  }
  if (trimmed.length > MEMBER_MESSAGE_MAX_LENGTH) {
    throw new PolicyExceptionMemberMessageError(
      `Your message must be ${MEMBER_MESSAGE_MAX_LENGTH} characters or fewer.`,
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// One-open-request slot keys (#2524)
// ---------------------------------------------------------------------------

/**
 * The DB-enforced one-open-request slot value a HELD request writes into its
 * `openStateKey` column, and every terminal transition NULLs. A NULL-distinct
 * unique index on that column then caps the subject at ONE open request
 * race-safely — a losing concurrent create races into a unique violation, never
 * a second open row. The value is deterministic so the same subject always maps
 * to the same slot, and namespaced so the two request tables can never collide
 * even though the modification slot lives on the shared BookingChangeRequest
 * table alongside locked-period rows (which never set it).
 *
 * New-booking slot: one open request per (member, identical proposal). Two
 * genuinely different proposals are two subjects; the SAME proposal resubmitted
 * while one is open is the collision the slot refuses.
 */
export function newBookingExceptionOpenStateKey(
  requestedByMemberId: string,
  proposalHash: string,
): string {
  return `nbpe:${requestedByMemberId}:${proposalHash}`;
}

/**
 * Modification slot: one open POLICY_EXCEPTION request per (booking, member).
 * Distinct namespace from both the new-booking slot above and the locked-period
 * rows on the same table, which leave `openStateKey` NULL.
 */
export function modificationExceptionOpenStateKey(
  bookingId: string,
  requestedByMemberId: string,
): string {
  return `pe:${bookingId}:${requestedByMemberId}`;
}

// ---------------------------------------------------------------------------
// The immutable proposal snapshot
// ---------------------------------------------------------------------------

/**
 * One guest as frozen into a proposal. `nights` is the SPARSE per-guest-night
 * footprint (the #713 representation), sorted and de-duplicated so two freezes
 * of the same party are byte-identical. `memberId` is the link that decides
 * hosting, not the `isMember` snapshot.
 */
export interface ProposalGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId: string | null;
  /** Sorted, unique NZ lodge nights (YYYY-MM-DD) this guest occupies. */
  nights: string[];
}

export interface ProposalParty {
  /** Booking envelope, YYYY-MM-DD; the min/max of the guest nights. */
  checkIn: string;
  checkOut: string;
  guests: ProposalGuest[];
}

export type NewBookingProposalSnapshot = {
  kind: "NEW_BOOKING";
  lodgeId: string;
  proposed: ProposalParty;
};

export type ModificationProposalSnapshot = {
  kind: "MODIFICATION";
  lodgeId: string;
  bookingId: string;
  /**
   * The live booking footprint the proposal was computed against. Frozen so
   * approval can prove the live booking has not drifted (someone else modifying
   * it changes this, which changes the hash and forces a resubmission).
   */
  base: ProposalParty;
  /** The full proposed result — a snapshot, never a delta, so nothing is
   * ambiguous about what an approval will execute. */
  proposed: ProposalParty;
};

export type ExceptionProposalSnapshot =
  | NewBookingProposalSnapshot
  | ModificationProposalSnapshot;

/** Sort + de-duplicate a night list so a snapshot is canonical. */
function canonicalNights(nights: readonly string[]): string[] {
  return [...new Set(nights)].sort();
}

/** Canonicalise a party so two freezes of the same facts are byte-identical. */
export function canonicalizeProposalParty(party: ProposalParty): ProposalParty {
  const guests = party.guests
    .map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId ?? null,
      nights: canonicalNights(guest.nights),
    }))
    // Stable, content-derived order: two parties with the same guests in a
    // different input order must hash identically.
    .sort(
      (a, b) =>
        a.lastName.localeCompare(b.lastName) ||
        a.firstName.localeCompare(b.firstName) ||
        (a.memberId ?? "").localeCompare(b.memberId ?? "") ||
        a.nights.join(",").localeCompare(b.nights.join(",")),
    );
  return { checkIn: party.checkIn, checkOut: party.checkOut, guests };
}

/** Canonicalise a whole proposal (both parties for a modification). */
export function canonicalizeProposalSnapshot(
  snapshot: ExceptionProposalSnapshot,
): ExceptionProposalSnapshot {
  if (snapshot.kind === "NEW_BOOKING") {
    return {
      kind: "NEW_BOOKING",
      lodgeId: snapshot.lodgeId,
      proposed: canonicalizeProposalParty(snapshot.proposed),
    };
  }
  return {
    kind: "MODIFICATION",
    lodgeId: snapshot.lodgeId,
    bookingId: snapshot.bookingId,
    base: canonicalizeProposalParty(snapshot.base),
    proposed: canonicalizeProposalParty(snapshot.proposed),
  };
}

/**
 * Deterministic JSON with recursively sorted object keys. `JSON.stringify` alone
 * is insertion-ordered, so two objects with the same fields in a different order
 * would hash differently; this removes that as a source of false drift.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeysDeep(record[key]);
    }
    return out;
  }
  return value;
}

/**
 * The proposal hash: SHA-256 over the canonicalised proposal snapshot. A stored
 * request carries it, and approval recomputes it from the SAME frozen snapshot
 * to prove the row was not tampered with, and — for a modification — recomputes
 * the base party from the LIVE booking to prove the live booking has not drifted
 * (a mismatch keeps the request out of execution and forces a resubmission).
 *
 * 64 lowercase hex characters, which is why the column is VARCHAR(64).
 */
export function computeProposalHash(snapshot: ExceptionProposalSnapshot): string {
  const canonical = canonicalizeProposalSnapshot(snapshot);
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

// ---------------------------------------------------------------------------
// Provisional capacity reservation math (pure)
// ---------------------------------------------------------------------------

/** Per-night bed demand for one party: how many guests occupy each night. */
export function perNightBedDemand(party: ProposalParty): Map<string, number> {
  const demand = new Map<string, number>();
  for (const guest of party.guests) {
    for (const night of new Set(guest.nights)) {
      demand.set(night, (demand.get(night) ?? 0) + 1);
    }
  }
  return demand;
}

export interface NightReservation {
  /** NZ lodge night, YYYY-MM-DD. */
  night: string;
  /** Beds to reserve on that night (always >= 1 in the returned list). */
  beds: number;
}

function demandToReservations(demand: Map<string, number>): NightReservation[] {
  return [...demand.entries()]
    .filter(([, beds]) => beds > 0)
    .map(([night, beds]) => ({ night, beds }))
    .sort((a, b) => a.night.localeCompare(b.night));
}

/**
 * The provisional reservation a HELD request WOULD hold while pending — the pure
 * per-night bed math. (Whether a NEW_BOOKING request actually WRITES this
 * reservation is deferred to #2526; today only the MODIFICATION path in
 * `booking-exception-request-service.ts` persists a reservation. This function is
 * the shared math both paths compute against.)
 *
 *  - NEW_BOOKING computes the FULL proposal: there is no live booking holding any
 *    of these beds, so every proposed guest-night must be held.
 *  - MODIFICATION computes ONLY the incremental beds beyond the unchanged live
 *    booking — `max(0, proposed - live)` per night — WHEN the live booking is
 *    capacity-holding (it already holds its own footprint, and #2365 forbids
 *    touching it before approval). Nights where the proposal shrinks the party
 *    hold nothing; the live booking keeps holding those until the modification
 *    actually applies.
 *  - MODIFICATION with `baseHoldsCapacity: false` computes the FULL proposed
 *    footprint instead: a non-capacity-holding base (e.g. a DRAFT, a generic
 *    PENDING, an un-held PAYMENT_PENDING, or a WAITLISTED/BUMPED booking — all
 *    editable per `getBookingEditPolicy` yet outside `capacityHoldingBookingFilter`)
 *    contributes NOTHING to occupancy, so subtracting its beds would UNDER-reserve
 *    and let others take beds the proposal needs (#2525 FIX 7).
 */
export function computeProposalReservation(
  snapshot: ExceptionProposalSnapshot,
  opts?: { baseHoldsCapacity?: boolean },
): NightReservation[] {
  if (snapshot.kind === "NEW_BOOKING") {
    return demandToReservations(perNightBedDemand(snapshot.proposed));
  }
  // A non-holding base holds no beds of its own, so the request must hold the
  // FULL proposed footprint, not just the delta above a base that reserves nothing.
  if (opts?.baseHoldsCapacity === false) {
    return demandToReservations(perNightBedDemand(snapshot.proposed));
  }
  const proposed = perNightBedDemand(snapshot.proposed);
  const live = perNightBedDemand(snapshot.base);
  const incremental = new Map<string, number>();
  for (const [night, beds] of proposed) {
    const delta = beds - (live.get(night) ?? 0);
    if (delta > 0) incremental.set(night, delta);
  }
  return demandToReservations(incremental);
}

// ---------------------------------------------------------------------------
// Frozen evidence
// ---------------------------------------------------------------------------

/**
 * The immutable evidence a request freezes: the #2363 aggregate (every covered
 * structured violation plus the HOLD-if-any-HOLD capacity mode) enriched with
 * flat, derived fields the queue and the capacity path read without parsing the
 * violation array. Derived, never authored: the violations remain the source of
 * truth and these are recomputed from them.
 */
export interface FrozenPolicyExceptionEvidence extends AggregatedPolicyExceptions {
  /** Sorted, unique reason codes present in the aggregate. */
  reasonCodes: PolicyExceptionReasonCode[];
  /** One entry per covered policy, sorted. */
  policyRefs: Array<{
    reasonCode: PolicyExceptionReasonCode;
    policyId: string;
    policyVersion: number;
    capacityMode: PolicyExceptionCapacityMode;
  }>;
  /** Every affected NZ night across all violations, sorted and unique. */
  affectedNights: string[];
}

/**
 * Freeze a set of violations into the stored evidence. Refuses a non-allowlisted
 * reason code before anything is stored — a hard failure must never reach
 * exception review, and `aggregatePolicyExceptionViolations` already throws on
 * one, so this is defence in depth at the persistence boundary.
 */
export function freezePolicyExceptionEvidence(
  violations: PolicyExceptionViolation[],
): FrozenPolicyExceptionEvidence {
  const aggregate = aggregatePolicyExceptionViolations(violations);
  const reasonCodes = [
    ...new Set(aggregate.violations.map((violation) => violation.reasonCode)),
  ].sort() as PolicyExceptionReasonCode[];
  const policyRefs = aggregate.violations
    .map((violation) => ({
      reasonCode: violation.reasonCode,
      policyId: violation.policyId,
      policyVersion: violation.policyVersion,
      capacityMode: violation.capacityMode,
    }))
    .sort(
      (a, b) =>
        a.reasonCode.localeCompare(b.reasonCode) ||
        a.policyId.localeCompare(b.policyId) ||
        a.policyVersion - b.policyVersion,
    );
  const affectedNights = [
    ...new Set(aggregate.violations.flatMap((violation) => violation.affectedNights)),
  ].sort();
  return { ...aggregate, reasonCodes, policyRefs, affectedNights };
}

/**
 * Parse a stored `frozenEvidence` value back without trusting it. The column is
 * JSON, so a hand-edited or partially-written value is possible. Anything that
 * does not carry the fields the drift check reads is treated as "no evidence",
 * which fails an execution closed rather than approving against nonsense.
 */
export function parseFrozenEvidence(
  value: unknown,
): FrozenPolicyExceptionEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.violations)) return null;
  for (const violation of record.violations) {
    if (!violation || typeof violation !== "object") return null;
    const reasonCode = (violation as Record<string, unknown>).reasonCode;
    if (typeof reasonCode !== "string" || !isPolicyExceptionReasonCode(reasonCode)) {
      return null;
    }
  }
  return value as FrozenPolicyExceptionEvidence;
}

// ---------------------------------------------------------------------------
// Drift classification
// ---------------------------------------------------------------------------

/**
 * A stable identity+content fingerprint for one violation. Two evaluations that
 * produce the SAME fingerprint are the same hazard about the same rule at the
 * same revision; a different fingerprint is a materially different question that
 * an admin has not reviewed. The reason-specific tail is what makes "the hosting
 * hazard now covers a different guest-night" count as changed.
 */
export function violationFingerprint(violation: PolicyExceptionViolation): string {
  const head = `${violation.reasonCode}|${violation.policyId}|v${violation.policyVersion}|nights=${violation.affectedNights.join(",")}`;
  if (violation.reasonCode === "MINIMUM_STAY") {
    const req = violation.requirements;
    return `${head}|min=${req.minimumNights}|act=${req.actualNights}|days=${req.triggerDays.join(",")}`;
  }
  if (violation.reasonCode === "ADULT_MEMBER_HOSTING_REQUIRED") {
    const req = violation.requirements;
    const uncovered = req.uncovered
      .map((row) => `${row.night} ${row.guestRef}`)
      .join(";");
    return `${head}|uncovered=${uncovered}`;
  }
  // PAID_UP_ADULT_MEMBER_REQUIRED (#2543). The tail is the two counts, and
  // deliberately NOT the identity of who is unpaid: the hazard an admin reviewed
  // is "this party has nobody paid-up on it", and it is the SAME hazard whether
  // the unpaid member is Alice or Bob. Fingerprinting the identities would
  // reopen a decided review every time the party was re-saved with the same
  // shape, which is exactly what the fingerprint exists to prevent.
  const req = violation.requirements;
  return `${head}|repriced=${req.repricedUnpaidMemberCount}|party=${req.participantCount}`;
}

/** Identity (reason + policy) of a violation, ignoring content — for reporting. */
function violationIdentity(violation: PolicyExceptionViolation): {
  reasonCode: PolicyExceptionReasonCode;
  policyId: string;
} {
  return { reasonCode: violation.reasonCode, policyId: violation.policyId };
}

export interface PolicyExceptionDriftResult {
  /**
   * True only when every reviewed violation that STILL trips is byte-identical
   * to what was reviewed, and no new violation has appeared. When true the
   * execution may proceed, overriding exactly the reviewed violations that still
   * trip (see `clearedReviewed` for the ones it must NOT override).
   */
  executable: boolean;
  /**
   * Reviewed violations that no longer trip at all (the policy was switched off,
   * relaxed, or the proposal now satisfies it). Per #2365 the execution runs
   * WITHOUT an override for these and records the resolution — there is nothing
   * to override.
   */
  clearedReviewed: Array<{ reasonCode: PolicyExceptionReasonCode; policyId: string }>;
  /**
   * Reviewed violations that still trip but at a different revision or with
   * different content. A materially changed hazard is a new question the member
   * must resubmit; it is never silently overridden.
   */
  changedReviewed: Array<{ reasonCode: PolicyExceptionReasonCode; policyId: string }>;
  /** Violations present now that were never reviewed. Force a resubmission. */
  newViolations: Array<{ reasonCode: PolicyExceptionReasonCode; policyId: string }>;
  /**
   * Reviewed violations that still trip unchanged — the ones an approval MAY
   * override. Sorted, so the override set is deterministic.
   */
  overridable: Array<{ reasonCode: PolicyExceptionReasonCode; policyId: string }>;
}

/**
 * Classify how the CURRENT violations of the frozen proposal compare to the
 * violations that were reviewed. Both inputs are the result of evaluating the
 * SAME frozen proposal — reviewed at submit, current at approval — so a
 * difference is real, never snapshot noise. It is NOT proof a policy was edited:
 * the fingerprint covers the nights (`INV-EXCEPT-035`), so no refusal says so.
 *
 * This is the whole of #2365's "if a reviewed soft rule disappeared, execute
 * without override; new/materially-changed violations require resubmission",
 * expressed as pure set algebra over fingerprints.
 */
export function classifyPolicyExceptionDrift(
  reviewed: PolicyExceptionViolation[],
  current: PolicyExceptionViolation[],
): PolicyExceptionDriftResult {
  const reviewedByKey = new Map<string, PolicyExceptionViolation>();
  for (const violation of reviewed) {
    reviewedByKey.set(
      `${violation.reasonCode}|${violation.policyId}`,
      violation,
    );
  }
  const currentByKey = new Map<string, PolicyExceptionViolation>();
  for (const violation of current) {
    currentByKey.set(`${violation.reasonCode}|${violation.policyId}`, violation);
  }

  const clearedReviewed: PolicyExceptionDriftResult["clearedReviewed"] = [];
  const changedReviewed: PolicyExceptionDriftResult["changedReviewed"] = [];
  const overridable: PolicyExceptionDriftResult["overridable"] = [];

  for (const [key, reviewedViolation] of reviewedByKey) {
    const currentViolation = currentByKey.get(key);
    if (!currentViolation) {
      clearedReviewed.push(violationIdentity(reviewedViolation));
      continue;
    }
    if (
      violationFingerprint(reviewedViolation) !==
      violationFingerprint(currentViolation)
    ) {
      changedReviewed.push(violationIdentity(reviewedViolation));
      continue;
    }
    overridable.push(violationIdentity(reviewedViolation));
  }

  const newViolations: PolicyExceptionDriftResult["newViolations"] = [];
  for (const [key, currentViolation] of currentByKey) {
    if (!reviewedByKey.has(key)) {
      newViolations.push(violationIdentity(currentViolation));
    }
  }

  const byIdentity = (
    a: { reasonCode: string; policyId: string },
    b: { reasonCode: string; policyId: string },
  ) =>
    a.reasonCode.localeCompare(b.reasonCode) ||
    a.policyId.localeCompare(b.policyId);

  clearedReviewed.sort(byIdentity);
  changedReviewed.sort(byIdentity);
  newViolations.sort(byIdentity);
  overridable.sort(byIdentity);

  return {
    executable: changedReviewed.length === 0 && newViolations.length === 0,
    clearedReviewed,
    changedReviewed,
    newViolations,
    overridable,
  };
}

/**
 * Recompute the reviewed violations back out of stored evidence in the frozen
 * order, so a caller can pass them to `classifyPolicyExceptionDrift`.
 */
export function reviewedViolationsFromEvidence(
  evidence: FrozenPolicyExceptionEvidence,
): PolicyExceptionViolation[] {
  return sortPolicyExceptionViolations(evidence.violations);
}
