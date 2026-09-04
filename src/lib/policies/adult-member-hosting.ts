import { AgeTier } from "@prisma/client";

import type {
  AdultMemberHostingConsequence,
  AdultMemberHostingPolicyExceptionViolation,
  AdultMemberHostScope,
  PolicyExceptionCapacityMode,
  QualifyingHostsForNight,
  ResolvedPolicyScope,
  UncoveredGuestNight,
} from "@/lib/booking-policy-exceptions";
import { ADULT_MEMBER_HOST_SCOPES } from "@/lib/booking-policy-exceptions";

/**
 * The configurable adult-member hosting policy (#2364, epic decision D-R3).
 *
 * A club may require every non-member guest-night to overlap an adult member who
 * is actually staying on the same booking. This module is the pure evaluator:
 * it takes already-loaded policy rows and already-loaded participant facts and
 * returns either nothing or one frozen violation in the shape #2363 registered.
 * It performs no I/O, so it is deterministic and directly testable, and the
 * decision about WHICH client reads the rows belongs to `booking-policies.ts`.
 *
 * Three rules are load-bearing and easy to get wrong:
 *
 *  - **Booking ownership never proves attendance.** The owning member counts
 *    only through a participant row linked to them, and only on the nights that
 *    row actually covers. Nothing in this module is given `Booking.memberId`, so
 *    a caller cannot accidentally credit an owner who is not staying.
 *  - **The member link is the authority, not the `isMember` flag.** A guest row
 *    carries `isMember` as a pricing-time snapshot; whether somebody is a member
 *    ADULT in good standing today is a fact about the Member row. A row whose
 *    member cannot be resolved is treated as a non-member guest — the safe
 *    direction, because that means it needs hosting rather than provides it.
 *  - **A membership that has lapsed is not a membership.** APPLIED PRINCIPLE
 *    (review of #2364; reversible by the owner): the safe direction above is
 *    applied to a member who is resolvable but no longer in good standing.
 *    A participant whose Member row is inactive, cancelled or archived is judged
 *    exactly as a non-member guest: they cannot host, and their own nights need
 *    hosting. Without this they fell between the two predicates and escaped the
 *    rule entirely — the one shape in which the club's own rule protects the
 *    club's guests LESS than it would for a plain non-member. Deliberately keyed
 *    off standing only, never `ageTier`: a member CHILD or YOUTH still does not
 *    need hosting (the minors rule in `booking-review.ts` owns children), and an
 *    active `NOT_APPLICABLE` organisation member is treated exactly as before.
 *    If the club's position is instead that the member LINK alone is the
 *    authority, the reversal is to drop `active`/`cancelledAt`/`archivedAt` from
 *    `participantQualifiesAsHost` — not to narrow the predicate below.
 */

/** Mirrors the Prisma `AdultMemberHostingMode` enum without importing it. */
export type AdultMemberHostingMode =
  | "INHERIT"
  | "DISABLED"
  | "ADMIN_REVIEW_REQUIRED"
  | "ENFORCED";

/** The mode an evaluation can actually run under: INHERIT always resolves away. */
export type EffectiveAdultMemberHostingMode =
  | "DISABLED"
  | "ADMIN_REVIEW_REQUIRED"
  | "ENFORCED";

/**
 * The scopes a club or lodge has switched on (#2569 §2), as booleans rather than
 * a set, so the shape matches the independent checkboxes the owner asked for and
 * matches the columns one-for-one.
 *
 * THREE FIELDS since #3037: the lodge-wide scope was removed (#2575) and the
 * nominated-host scope was replaced by same-owner coverage (#2576), both before
 * either shipped, and `sameGroupTrip` was added by epic #2943. See
 * `ADULT_MEMBER_HOST_SCOPES`.
 */
export interface AdultMemberHostScopeSet {
  sameBooking: boolean;
  sameBookingOwner: boolean;
  /**
   * Optional Group Trip cover (#3037). OFF in the built-in default, OFF when the
   * column is NULL on a row that decided the rest of the set, and only ever on
   * because a club ticked the box.
   */
  sameGroupTrip: boolean;
}

/**
 * What a club that has never touched the second dimension gets: the pre-#2569
 * rule exactly (#2569 §15).
 *
 * This constant is the whole reason the upgrade moves nobody's behaviour. Every
 * existing policy row carries NULL host-scope columns, every NULL set resolves
 * here, and this set is "an eligible adult member on the same booking" — which is
 * what the rule has always meant. Widening it would silently broaden a policy the
 * club never reviewed, which §15 forbids in as many words.
 */
export const DEFAULT_ADULT_MEMBER_HOST_SCOPES: AdultMemberHostScopeSet =
  Object.freeze({
    sameBooking: true,
    sameBookingOwner: false,
    sameGroupTrip: false,
  });

/** Where the resolved value for one DIMENSION came from (#2569 §16 display). */
export type AdultMemberHostingSettingSource =
  | "LODGE"
  | "CLUB_WIDE"
  | "BUILT_IN_DEFAULT";

export interface AdultMemberHostingPolicyLike {
  id: string;
  scopeKey: string;
  lodgeId: string | null;
  mode: AdultMemberHostingMode;
  capacityMode: PolicyExceptionCapacityMode;
  version: number;
  /**
   * The host-qualification scope set, BOTH NULL TOGETHER meaning "this scope did
   * not decide" (the database CHECK holds them to all-null or all-set).
   * Optional on the interface as well as nullable, so a caller that reads a
   * narrowed select — or a test double written before #2569 — resolves the
   * built-in default rather than failing to compile.
   */
  hostScopeSameBooking?: boolean | null;
  hostScopeSameBookingOwner?: boolean | null;
  /**
   * The Group Trip scope (#3037). NOT part of the all-or-none pair above, and
   * that asymmetry is deliberate — see the schema comment and the migration: a
   * three-way CHECK would refuse a draining old colour's policy INSERT, which
   * names only the two columns it knows. So NULL here on a row that DID decide
   * the pair means OFF, not "inherit", and that is what keeps the upgrade a
   * no-op. Optional as well as nullable for the same reason its siblings are: a
   * narrowed select or a pre-#3037 test double resolves the built-in default
   * rather than failing to compile.
   */
  hostScopeSameGroupTrip?: boolean | null;
}

/**
 * The authoritative Member facts a participant row is judged by. Deliberately
 * the live columns rather than anything cached on the guest row: a member who
 * has since been made inactive, cancelled or archived stops hosting from that
 * moment AND starts needing a host themselves, and one who has aged down stops
 * hosting — which is what makes re-evaluation meaningful.
 */
export interface HostingMemberFacts {
  id: string;
  ageTier: AgeTier | string;
  active: boolean;
  cancelledAt: Date | null;
  archivedAt: Date | null;
}

export interface HostingParticipant {
  /** `BookingGuest.id`, or `guest:<index>` for a party that has no rows yet. */
  guestRef: string;
  guestName: string;
  /** Resolved Member row for a member-linked participant; null otherwise. */
  member: HostingMemberFacts | null;
  /** NZ lodge nights (YYYY-MM-DD) this participant's row actually covers. */
  nights: string[];
  /**
   * Whether this row is operationally present at the lodge (D-12). A member
   * guest whose invite is still `PENDING` is not: the kiosk, the arrival roster,
   * bed allocation and the arrival emails all leave them out, so they cannot be
   * the responsible adult either. Absent means present — the pre-persist create
   * path has no consent facts yet, and every other participant is a row that
   * really is coming.
   */
  operationallyPresent?: boolean;
  /**
   * Whether this member's season subscription is settled — PAID, or the season
   * gate says one is not required for them (#2543).
   *
   * ABSENT MEANS SETTLED, and that default is load-bearing: under the two modes
   * that are not `NON_MEMBER_PRICING` nobody is repriced, so nothing about
   * hosting changes and every existing caller keeps its pre-#2543 answer without
   * being touched. Only the booking-side loader that knows the club is in
   * `NON_MEMBER_PRICING` populates it, and only then can it be `false`.
   *
   * WHY IT DISQUALIFIES A HOST (owner decision, 2 Aug 2026, #2543): under
   * `NON_MEMBER_PRICING` an unpaid member is being CHARGED as a non-member, and
   * the club's position is that somebody the club is charging as a non-member is
   * not the responsible member the hosting rule asks for. Their non-member guests
   * therefore need a genuinely paid-up adult member present.
   *
   * WHY IT DOES NOT MAKE THEM A GUEST NEEDING HOSTING: deliberately asymmetric,
   * and narrower than the lapsed-member rule above. A lapsed membership is gone;
   * an unpaid subscription is a membership in good standing with a bill
   * outstanding. The owner's rule moves them on the money axis and on the
   * "counts as the responsible adult" axis only. `participantIsNonMemberGuest`
   * therefore does NOT read this field, so an unpaid member's own nights are not
   * suddenly uncovered guest-nights needing admin review — the paid-up-adult
   * requirement in `subscription-lockout-pricing.ts` is what covers the party.
   */
  subscriptionSettled?: boolean;
  /**
   * True for somebody who is staying with this party but is carried on a
   * SIBLING booking row — they can host, but their own nights are not this
   * booking's responsibility.
   *
   * This exists for the split-booking shape (#738): a mixed member/non-member
   * party awaiting payment is stored as a member booking plus a linked
   * non-member child. Judged in isolation the child contains no member at all,
   * so a rule about "an adult member on the same booking" would fire on every
   * single one of them while the member is demonstrably staying. The member is
   * therefore fed in as a host-only participant, and the child's own non-member
   * guests remain the ones that need covering. The parent, whose own guests are
   * all members, has nothing to cover and produces no violation — so one party
   * yields one hazard, not two.
   *
   * It is deliberately NOT how a group booking works: a group joiner's booking
   * belongs to a different member, so the organiser's adults never leak in and
   * "the same booking" keeps meaning what it says.
   */
  hostOnly?: boolean;
  /**
   * WHICH host scope this row supplies coverage under (#2569 §2). Absent means
   * `SAME_BOOKING`, and that default is what keeps every existing loader — and
   * every pre-#2569 test double — evaluating exactly as it did before.
   *
   * This is the seam the OR logic turns on: the evaluator counts a host only if
   * the club has that host's scope switched on, so a loader for a wider scope is
   * added by stamping its participants rather than by touching the rule. A #738
   * split sibling is deliberately `SAME_BOOKING`: a split pair is one party the
   * database happens to store as two rows, not a second booking at the lodge.
   */
  hostScope?: AdultMemberHostScope;
}

export interface ResolvedAdultMemberHostingPolicy {
  mode: EffectiveAdultMemberHostingMode;
  capacityMode: PolicyExceptionCapacityMode;
  /** Null only for the synthesised "no row configured" default. */
  policyId: string | null;
  policyVersion: number;
  resolvedScope: ResolvedPolicyScope;
  /**
   * The host-qualification scope set in force, resolved INDEPENDENTLY of `mode`
   * (#2569 §2). A lodge may override the consequence while inheriting the club's
   * scope set, or override the scope set while inheriting the consequence, so the
   * two dimensions can genuinely come from different rows — `resolvedScope`
   * describes where the CONSEQUENCE came from, `hostScopeSource` where this did.
   */
  hostScopes: AdultMemberHostScopeSet;
  hostScopeSource: AdultMemberHostingSettingSource;
}

/** Frozen onto every violation so a snapshot names the rule it came from. */
export const ADULT_MEMBER_HOSTING_POLICY_NAME = "Adult member hosting requirement";

/**
 * Identity used when no policy row exists for a scope at all. It can only ever
 * appear with `mode: "DISABLED"`, so it never reaches a violation snapshot; it
 * exists so `resolveAdultMemberHostingPolicy` always returns a total answer.
 */
export const UNCONFIGURED_ADULT_MEMBER_HOSTING_POLICY_ID = null;

/**
 * A scope that cannot be resolved is refused, never silently treated as
 * "disabled". Failing closed here means failing LOUDLY: the caller cannot tell
 * an unconfigured club (a real, permissive answer) from a lodge it could not
 * identify, and quietly picking the permissive one would drop a club's rule.
 */
export class UnknownAdultMemberHostingScopeError extends Error {
  constructor(readonly detail: string) {
    super(`Cannot resolve the adult-member hosting policy scope: ${detail}`);
    this.name = "UnknownAdultMemberHostingScopeError";
  }
}

/**
 * An ACTIVE hosting policy that enables no host scope at all (#2569 §2/§16).
 *
 * Unevaluatable rather than permissive: with nothing able to supply coverage,
 * every non-member guest-night is uncovered, so "review required" would flag
 * every single booking and "enforced" would refuse every single one. Neither is a
 * policy anybody chose, and the alternative reading — treat it as disabled —
 * would silently drop the club's rule.
 *
 * REACHED ONLY BY A MISCONFIGURATION THE API REFUSES. The admin route validates
 * the resolved combination for every affected scope before saving, and config
 * transfer refuses it in its dry run, so this exists for operator psql and for
 * any future writer: it fails loudly, naming the scope, rather than letting a
 * half-saved policy decide bookings.
 */
export class EmptyAdultMemberHostScopeSetError extends Error {
  constructor(readonly detail: string) {
    super(
      "The adult-member hosting policy is active but no adult members are set " +
        `to count, so it cannot be evaluated: ${detail}`,
    );
    this.name = "EmptyAdultMemberHostScopeSetError";
  }
}

/**
 * Whether a row decided the second dimension at all.
 *
 * THE PAIR DECIDES, AND `hostScopeSameGroupTrip` DELIBERATELY DOES NOT (#3037).
 * The database CHECK holds the two #2569 columns to all-null or all-set, so
 * either one being non-null means the row decided. Testing both and requiring
 * agreement would turn a constraint violation into a silent fall-through to the
 * club default; testing one would trust the constraint more than it is worth
 * here. Requiring BOTH to be set is the safe reading: a half-written row inherits
 * rather than asserting a scope set nobody chose.
 *
 * The Group Trip column is excluded because it can legitimately be NULL on a row
 * that HAS decided — every row a draining previous colour writes during a
 * blue/green window, and every row that predates the #3037 migration. Including
 * it here would make all of those rows suddenly inherit a scope set they had
 * overridden, which is the exact behaviour change the default-OFF promise
 * forbids. On a decided row NULL means OFF, and `rowHostScopes` reads it that way.
 */
function rowHasHostScopes(row: AdultMemberHostingPolicyLike): boolean {
  return (
    typeof row.hostScopeSameBooking === "boolean" &&
    typeof row.hostScopeSameBookingOwner === "boolean"
  );
}

function rowHostScopes(
  row: AdultMemberHostingPolicyLike,
): AdultMemberHostScopeSet {
  return {
    sameBooking: row.hostScopeSameBooking === true,
    sameBookingOwner: row.hostScopeSameBookingOwner === true,
    // `=== true` rather than a truthiness test, so NULL and undefined both read
    // as OFF (#3037). See `rowHasHostScopes` for why NULL is reachable here.
    sameGroupTrip: row.hostScopeSameGroupTrip === true,
  };
}

/** The enabled scopes as a sorted list, for the frozen snapshot and the UI. */
export function enabledHostScopeList(
  scopes: AdultMemberHostScopeSet,
): AdultMemberHostScope[] {
  // Iterating the canonical constant rather than Object.keys keeps the order
  // stable and independent of the object literal, which matters because this
  // list is frozen onto a snapshot that two evaluations must produce identically.
  return ADULT_MEMBER_HOST_SCOPES.filter((scope) =>
    hostScopeEnabled(scopes, scope),
  );
}

export function hostScopeSetIsEmpty(scopes: AdultMemberHostScopeSet): boolean {
  return (
    !scopes.sameBooking && !scopes.sameBookingOwner && !scopes.sameGroupTrip
  );
}

/**
 * Whether the enabled set is EXACTLY the built-in one — `SAME_BOOKING` and
 * nothing else.
 *
 * ONE PREDICATE, TWO PIECES OF PROSE (`INV-SSOT-002`). The member-facing
 * refusal sentence and the public policy page each have a narrow
 * "on the same booking" wording that is only honest when no wider scope is on,
 * and each used to spell the condition out for itself. #3037 found the second
 * copy still branching on the #2569 pair alone: a club running `SAME_BOOKING`
 * plus `SAME_GROUP_TRIP` PUBLISHED a narrower rule than it applied. Spelling the
 * denial out a third time would only wait for the next scope, so both sites now
 * ask here.
 *
 * DERIVED FROM `ADULT_MEMBER_HOST_SCOPES`, not from a hand-written list of
 * denials. `enabledHostScopeList` filters the canonical constant through
 * `hostScopeEnabled`, whose switch is exhaustive over the scope union — so a
 * fourth scope is a typecheck error there, and until it is enabled this
 * predicate already reports `false` for it. An explicit `!scopes.someNewScope`
 * chain looks like it would make the same edit visible and does not: adding a
 * field to `AdultMemberHostScopeSet` type-checks clean at every site that simply
 * omits it, which is exactly how the public copy was missed.
 */
export function hostScopesAreSameBookingOnly(
  scopes: AdultMemberHostScopeSet,
): boolean {
  const enabled = enabledHostScopeList(scopes);
  return enabled.length === 1 && enabled[0] === "SAME_BOOKING";
}

/** Whether a resolved consequence actually evaluates the rule. */
export function hostingModeIsActive(
  mode: EffectiveAdultMemberHostingMode,
): mode is AdultMemberHostingConsequence {
  return mode === "ADMIN_REVIEW_REQUIRED" || mode === "ENFORCED";
}

/**
 * Can a same-owner stranding REFUSE the actor at this mode, or only escalate?
 * (#3232, `INV-HOST-050`.)
 *
 * A NARROWER QUESTION THAN `hostingModeIsActive`, and a separate one. That asks
 * whether the rule judges at all — `ADMIN_REVIEW_REQUIRED` does, which is why a
 * dependent read still runs there. This asks whether the answer can be a refusal,
 * and under `ADMIN_REVIEW_REQUIRED` it cannot: nothing there refuses and nothing
 * opens an incident.
 *
 * IT EXISTS SO THERE IS ONE SPELLING OF IT. There were three — the settle path's
 * early return on the literal `ADMIN_REVIEW_REQUIRED`, the read-only probe the
 * linked-move OFFER uses on `mode !== "ENFORCED"`, and the wider active pair the
 * plan they share gates on. They agree today, which is what makes it dangerous:
 * extend the refusal to `ADMIN_REVIEW_REQUIRED` in one of them and the probe
 * returns an empty list, so the caller raises a 409 naming nobody, the browser's
 * fail-closed reader discards it, and the member is handed a body no reader
 * matches — the "offer that named nobody" failure already fixed once here. With
 * one predicate, extending the refusal moves every reader with it.
 */
export function hostingModeCanRefuseStranding(
  mode: EffectiveAdultMemberHostingMode,
): boolean {
  return mode === "ENFORCED";
}

/**
 * Club-wide default with per-lodge override (ADR-001 resolved question 3), with
 * one difference from the minimum-stay policy SET: this policy is a single row
 * per scope, so a lodge overrides by holding a row whose mode is not INHERIT,
 * and says "use the club default" by holding an INHERIT row (or no row at all).
 *
 * `rows` may contain rows for other lodges; they are ignored. Order is
 * irrelevant — the club row and this lodge's row are each unique in the
 * database, and a duplicate reaching here is refused rather than picked between.
 */
export function resolveAdultMemberHostingPolicy(
  rows: readonly AdultMemberHostingPolicyLike[],
  effectiveLodgeId: string,
): ResolvedAdultMemberHostingPolicy {
  if (!effectiveLodgeId) {
    throw new UnknownAdultMemberHostingScopeError("no lodge was resolved");
  }

  const lodgeRows = rows.filter((row) => row.lodgeId === effectiveLodgeId);
  if (lodgeRows.length > 1) {
    throw new UnknownAdultMemberHostingScopeError(
      `lodge ${effectiveLodgeId} has ${lodgeRows.length} rows`,
    );
  }
  const clubRows = rows.filter((row) => row.lodgeId === null);
  if (clubRows.length > 1) {
    throw new UnknownAdultMemberHostingScopeError(
      `the club has ${clubRows.length} club-wide rows`,
    );
  }

  const lodgeRow = lodgeRows[0] ?? null;
  const clubRow = clubRows[0] ?? null;

  // The SECOND dimension, resolved BEFORE and INDEPENDENTLY of the consequence
  // (#2569 §2). A lodge may override the consequence while inheriting the club's
  // scope set, or override the scope set while inheriting the consequence, so a
  // lodge row that says INHERIT about its MODE can still carry a custom scope
  // set — which is why this cannot be folded into the branches below.
  const hostScopes = resolveHostScopes(lodgeRow, clubRow);

  if (lodgeRow && lodgeRow.mode !== "INHERIT") {
    return {
      mode: lodgeRow.mode,
      capacityMode: lodgeRow.capacityMode,
      policyId: lodgeRow.id,
      policyVersion: lodgeRow.version,
      resolvedScope: {
        kind: "LODGE",
        lodgeId: effectiveLodgeId,
        effectiveLodgeId,
      },
      ...hostScopes,
    };
  }

  if (clubRow) {
    if (clubRow.mode === "INHERIT") {
      // The migration's CHECK constraint forbids this, so reaching it means the
      // constraint is gone or the row came from somewhere that is not the
      // database. Refuse rather than loop or guess.
      throw new UnknownAdultMemberHostingScopeError(
        "the club-wide row is INHERIT, which has nothing to inherit from",
      );
    }
    return {
      mode: clubRow.mode,
      capacityMode: clubRow.capacityMode,
      policyId: clubRow.id,
      policyVersion: clubRow.version,
      resolvedScope: {
        kind: "CLUB_WIDE",
        lodgeId: null,
        effectiveLodgeId,
      },
      ...hostScopes,
    };
  }

  // Nothing configured anywhere. That is a real, deterministic answer — the
  // club has not turned the requirement on — and NOT the unknown-scope case
  // above. Capacity mode is meaningless while disabled; NO_HOLD is stated
  // rather than left undefined so the shape stays total.
  return {
    mode: "DISABLED",
    capacityMode: "NO_HOLD",
    policyId: UNCONFIGURED_ADULT_MEMBER_HOSTING_POLICY_ID,
    policyVersion: 0,
    resolvedScope: {
      kind: "CLUB_WIDE",
      lodgeId: null,
      effectiveLodgeId,
    },
    ...hostScopes,
  };
}

/**
 * Resolve the HOST-QUALIFICATION dimension on its own (#2569 §2).
 *
 * Lodge decision, else club decision, else the built-in default. "Decision"
 * means all three columns are set — a lodge that left them NULL is the explicit
 * `Inherit club host scopes` option, and a club that left them NULL never chose,
 * which is what keeps every pre-#2569 row on same-booking-only coverage (§15).
 *
 * Deliberately does NOT consult `mode`. The dimensions are independent, so a
 * lodge inheriting the consequence may still customise the scope set, and a lodge
 * whose consequence is DISABLED keeps its saved scope set for later reuse (§16)
 * rather than having it reset to the default on read.
 */
function resolveHostScopes(
  lodgeRow: AdultMemberHostingPolicyLike | null,
  clubRow: AdultMemberHostingPolicyLike | null,
): Pick<ResolvedAdultMemberHostingPolicy, "hostScopes" | "hostScopeSource"> {
  if (lodgeRow && rowHasHostScopes(lodgeRow)) {
    return { hostScopes: rowHostScopes(lodgeRow), hostScopeSource: "LODGE" };
  }
  if (clubRow && rowHasHostScopes(clubRow)) {
    return { hostScopes: rowHostScopes(clubRow), hostScopeSource: "CLUB_WIDE" };
  }
  return {
    hostScopes: DEFAULT_ADULT_MEMBER_HOST_SCOPES,
    hostScopeSource: "BUILT_IN_DEFAULT",
  };
}

/**
 * Whether the club still recognises this participant as a member in good
 * standing. The single fact both predicates below are built from, so the two can
 * never disagree about the same row and let somebody fall between them.
 */
function memberIsInGoodStanding(
  member: HostingMemberFacts | null,
): member is HostingMemberFacts {
  return (
    member !== null &&
    member.active === true &&
    member.cancelledAt === null &&
    member.archivedAt === null
  );
}

/**
 * Whether this participant's row lets them host a non-member guest tonight.
 *
 * Every clause is a live Member fact. `NOT_APPLICABLE` (organisations/schools,
 * #1440) is not an adult and deliberately does not qualify: the rule is about a
 * responsible adult being present, and an organisation is not a person. Nor does
 * a row that is not operationally present (D-12) — an unaccepted member-guest
 * invite is not a responsible adult at the lodge, and the arrival roster,
 * the kiosk and bed allocation all already agree. Nor does a member the club is
 * currently charging as a non-member because their subscription is unpaid
 * (#2543) — see `HostingParticipant.subscriptionSettled`, which is absent (and
 * so treated as settled) everywhere except under `NON_MEMBER_PRICING`.
 */
export function participantQualifiesAsHost(
  participant: Pick<
    HostingParticipant,
    "member" | "operationallyPresent" | "subscriptionSettled"
  >,
): boolean {
  if (participant.operationallyPresent === false) return false;
  if (participant.subscriptionSettled === false) return false;
  const member = participant.member;
  if (!memberIsInGoodStanding(member)) return false;
  return member.ageTier === AgeTier.ADULT;
}

/**
 * A participant the rule treats as a non-member guest: no resolvable Member row,
 * or one the club no longer recognises (inactive, cancelled or archived). See
 * the third load-bearing rule in the module header — this is the exact
 * complement of the standing test in `participantQualifiesAsHost`, so a lapsed
 * member cannot escape by being neither.
 *
 * `ageTier` is deliberately absent: a member CHILD or YOUTH in good standing
 * does not need hosting under THIS rule (the minors rule owns them), and an
 * active `NOT_APPLICABLE` organisation member is unchanged by this predicate.
 */
export function participantIsNonMemberGuest(
  participant: Pick<HostingParticipant, "member">,
): boolean {
  return !memberIsInGoodStanding(participant.member);
}

function uniqueSortedNights(nights: readonly string[]): string[] {
  return [...new Set(nights)].sort();
}

/**
 * Which adult members count, as a member-facing clause (#2569 §17: somebody told
 * their booking is uncovered must also be told what would cover it).
 *
 * Never names a person — the member is told coverage is missing, never who else
 * is or is not at the lodge. Under `SAME_BOOKING_OWNER` the other booking is the
 * member's OWN, so the clause may say so plainly (#2576 §11: the owner may see
 * that another booking on their own account supplies or depends on coverage).
 */
function describeHostScopes(scopes: AdultMemberHostScopeSet): string {
  const parts: string[] = [];
  if (scopes.sameBooking) parts.push("an adult member staying on this booking");
  if (scopes.sameBookingOwner) {
    parts.push(
      "an adult member staying at the same lodge that night on another booking " +
        "on your account",
    );
  }
  if (scopes.sameGroupTrip) {
    // NAMES THE RULE, NEVER THE SOURCE (#3037, epic #2943). Unlike the same-owner
    // clause above, the other booking here may belong to SOMEBODY ELSE, so this
    // sentence says what the club counts and stops: it identifies no booking, no
    // organiser and no member. Which booking or adult actually supplied cover is
    // privileged information the epic keeps to the officer/hut-leader tier.
    parts.push(
      "an adult member staying at the same lodge that night on another booking " +
        "in the same Group Trip",
    );
  }
  if (parts.length === 0) return "an adult member";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/**
 * The member-facing sentence. Names the rule and the size of the problem, never
 * a guest — the guest/night evidence is in `requirements` for the admin screen
 * and the server log, and this string is rendered straight into a booking
 * response.
 *
 * TWO SENTENCES THAT DIFFER BY CONSEQUENCE (#2569 §1: "use clear
 * consequence-based wording"). Review mode tells the member the booking is made
 * and an admin will look; enforced mode tells them it cannot be confirmed as it
 * stands and names the four ways out the owner listed. Saying "an admin needs to
 * look at it" under enforced would be false — there is no booking yet.
 *
 * THE REVIEW-MODE SENTENCE IS UNCHANGED for a club on the built-in scope set, to
 * the byte. That is the migration promise in §15 reaching as far as the words the
 * member reads: a club that upgrades and changes nothing sees no difference
 * anywhere, including here.
 */
export function formatAdultMemberHostingMessage(
  uncoveredCount: number,
  affectedNightCount: number,
  consequence: AdultMemberHostingConsequence = "ADMIN_REVIEW_REQUIRED",
  scopes: AdultMemberHostScopeSet = DEFAULT_ADULT_MEMBER_HOST_SCOPES,
): string {
  const nights = `${affectedNightCount} night${affectedNightCount === 1 ? "" : "s"}`;
  const guestNights = `${uncoveredCount} guest night${uncoveredCount === 1 ? "" : "s"}`;

  if (
    consequence === "ADMIN_REVIEW_REQUIRED" &&
    // The narrow sentence is only true while `SAME_BOOKING` is the whole rule
    // (#3037). Asked through the shared predicate rather than denied scope by
    // scope here, because the public policy page needs the same question
    // answered the same way and the hand-written copy of it went stale.
    hostScopesAreSameBookingOnly(scopes)
  ) {
    return (
      "This club asks that an adult member stays on the same booking as any " +
      `non-member guest. On ${nights} of this booking, ${guestNights} have no ` +
      "adult member staying, so an admin needs to look at it."
    );
  }

  const rule =
    "This club asks that every night a non-member guest stays is covered by " +
    `${describeHostScopes(scopes)}.`;
  const size = `On ${nights} of this booking, ${guestNights} are not covered.`;

  return consequence === "ADMIN_REVIEW_REQUIRED"
    ? `${rule} ${size} An admin needs to look at it.`
    : `${rule} ${size} This booking cannot be confirmed as it stands. You can ` +
        "add adult member cover for those nights, change the guests or the " +
        "dates, choose another lodge, or ask a Booking Officer to approve an " +
        "exception.";
}

/**
 * The one sentence an UNAUTHENTICATED non-member group joiner is told when the
 * lodge's ENFORCED hosting rule refuses their join.
 *
 * GENERIC ON PURPOSE, and the only field that outcome carries — the same rule
 * `PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE` follows on the same route, and for the
 * same reason: a verified non-member join is confirmed from an emailed token with
 * no session behind it, so a body naming the club's consequence setting, the
 * enabled host scopes or the uncovered nights would turn that confirm into a
 * policy-configuration read for anyone holding a token. The frozen violation stays
 * in the server log line beside the refusal.
 *
 * No exception door either, and that is not an omission. The door is a
 * member-authenticated workflow (`/api/bookings/exception-requests`); a non-login
 * contact has no account to raise a request from, and the person who CAN fix this
 * — by covering the nights, or by asking a Booking Officer — is the organiser.
 * So the sentence points there.
 */
export const PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE =
  "This lodge asks that non-member guests are covered by an adult member for " +
  "every night they stay, and this sign-up would not be. Please contact the " +
  "organiser.";

/**
 * The WAITLIST-CONFIRM flavour of the enforced refusal.
 *
 * Both waitlist confirm paths — same-lodge and the cross-lodge promotion — refuse
 * without consuming the offer: the reconciler throws inside the claiming
 * transaction, so the claim rolls back and the booking is left exactly as it was,
 * still WAITLIST_OFFERED with its original expiry. The base sentence cannot say
 * that (a booking-time refusal has no offer behind it), and leaving it unsaid was
 * the #2543 lesson on this same pair of paths: a bare refusal reads as though the
 * member has lost the offer as well as the stay.
 *
 * ONE formatter for both paths, for the reason #2543's waitlist-refusal formatter
 * is one (`policies/subscription-lockout-pricing.ts` — named in prose rather than
 * as its identifier on purpose, because that suite's own tree-wide sweep asserts
 * which files reference it and a doc comment is not a caller): the answer must not
 * depend on which lodge the sweep happened to offer.
 * The structural sweep in `adult-member-hosting-call-sites.test.ts` pins the caller
 * set tree-wide, so a later lane cannot reach for this nicer-reading sentence on a
 * path with no waitlist entry behind it.
 */
export function formatAdultMemberHostingWaitlistRefusal(
  baseMessage: string,
): string {
  return `${baseMessage} Your waitlist offer has not been used — it stays open until it expires.`;
}

/**
 * Evaluate one booking's participants against an already-resolved policy.
 *
 * Returns `null` when the policy is disabled, when the party has no non-member
 * guest-nights, or when every such night is already covered. Otherwise the
 * frozen violation: policy identity and version, resolved scope, the affected
 * NZ nights, the exact uncovered guest+night pairs, the qualifying member ids
 * for every candidate night, eligibility and the policy's capacity mode.
 *
 * Determinism is a contract, not a nicety: `adultMemberHostingReviewChanged`
 * compares two snapshots to decide whether a pending review reopens, so an
 * unstable order would reopen reviews for no reason. Every list is sorted and
 * de-duplicated here rather than at the call sites.
 */
export function evaluateAdultMemberHostingWithPolicy(
  participants: readonly HostingParticipant[],
  resolved: ResolvedAdultMemberHostingPolicy,
): AdultMemberHostingPolicyExceptionViolation | null {
  if (!hostingModeIsActive(resolved.mode)) return null;
  const consequence = resolved.mode;
  const scopes = resolved.hostScopes;
  if (hostScopeSetIsEmpty(scopes)) {
    throw new EmptyAdultMemberHostScopeSetError(
      `policy ${resolved.policyId ?? "unconfigured"} at lodge ` +
        `${resolved.resolvedScope.effectiveLodgeId} is ${consequence}`,
    );
  }

  // Nights on which at least one qualifying adult member is staying UNDER AN
  // ENABLED SCOPE. This is the whole OR rule (#2569 §2): a host is counted only
  // where the club has that host's scope switched on, and a night is covered if
  // ANY enabled scope supplied a host for it. Different nights of one booking can
  // therefore be covered by different scopes and different members, because the
  // decision is taken per night rather than per booking.
  //
  // WHY SAME_BOOKING_OWNER NEEDED NO CHANGE HERE (#2576 §13). This loop is
  // scope-agnostic: it counts whatever `participant.hostScope` says. Same-owner
  // coverage therefore arrives as a LOADER — `loadSameBookingOwnerHosts` stamps the
  // qualifying adult members attending other bookings with the same
  // `Booking.memberId` as `hostScope: "SAME_BOOKING_OWNER"` participants — and not
  // as a second branch of the rule. That is exactly what §13 asks for: one
  // definition of a qualifying adult member, one exact-night test, one evidence
  // shape, with the scope deciding only WHOSE attendance is admissible.
  const hostsByNight = new Map<string, Set<string>>();
  const scopesByNight = new Map<string, Set<AdultMemberHostScope>>();
  for (const participant of participants) {
    const participantScope = participant.hostScope ?? "SAME_BOOKING";
    if (!hostScopeEnabled(scopes, participantScope)) continue;
    if (!participantQualifiesAsHost(participant)) continue;
    const memberId = participant.member?.id;
    if (!memberId) continue;
    for (const night of uniqueSortedNights(participant.nights)) {
      const hosts = hostsByNight.get(night) ?? new Set<string>();
      hosts.add(memberId);
      hostsByNight.set(night, hosts);
      const nightScopes =
        scopesByNight.get(night) ?? new Set<AdultMemberHostScope>();
      nightScopes.add(participantScope);
      scopesByNight.set(night, nightScopes);
    }
  }

  const uncovered: UncoveredGuestNight[] = [];
  const candidateNights = new Set<string>();
  for (const participant of participants) {
    if (participant.hostOnly === true) continue;
    if (!participantIsNonMemberGuest(participant)) continue;
    for (const night of uniqueSortedNights(participant.nights)) {
      candidateNights.add(night);
      if ((hostsByNight.get(night)?.size ?? 0) > 0) continue;
      uncovered.push({
        guestRef: participant.guestRef,
        guestName: participant.guestName,
        night,
      });
    }
  }

  if (uncovered.length === 0) return null;

  uncovered.sort(
    (a, b) =>
      a.night.localeCompare(b.night) || a.guestRef.localeCompare(b.guestRef),
  );

  const affectedNights = uniqueSortedNights(uncovered.map((row) => row.night));

  // Every night a non-member guest stays, covered or not: an admin reading the
  // snapshot needs to see which nights ARE hosted and by whom, and the uncovered
  // nights alone would always report an empty host list by construction.
  const qualifyingHostsByNight: QualifyingHostsForNight[] = [
    ...candidateNights,
  ]
    .sort()
    .map((night) => ({
      night,
      memberIds: [...(hostsByNight.get(night) ?? [])].sort(),
      // Which enabled scope actually supplied each night's cover (#2569 §11).
      // Sorted through the canonical constant, so two evaluations of the same
      // facts produce the identical snapshot.
      coveredByScopes: ADULT_MEMBER_HOST_SCOPES.filter((scope) =>
        scopesByNight.get(night)?.has(scope),
      ),
    }));

  return {
    reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
    consequence,
    // A resolved ADMIN_REVIEW_REQUIRED mode always came from a real row, so the
    // synthesised null id is unreachable here; the fallback keeps the frozen
    // shape total rather than leaving a `null` where a string is promised.
    policyId: resolved.policyId ?? "unconfigured",
    policyVersion: resolved.policyVersion,
    policyName: ADULT_MEMBER_HOSTING_POLICY_NAME,
    resolvedScope: resolved.resolvedScope,
    affectedNights,
    requirements: {
      kind: "ADULT_MEMBER_HOSTING",
      requiredAdultMemberParticipantsPerGuestNight: 1,
      uncoveredNonMemberGuestNights: uncovered.length,
      uncovered,
      qualifyingHostsByNight,
      enabledHostScopes: enabledHostScopeList(scopes),
    },
    exceptionEligible: true,
    capacityMode: resolved.capacityMode,
    message: formatAdultMemberHostingMessage(
      uncovered.length,
      affectedNights.length,
      consequence,
      scopes,
    ),
  };
}

/** Whether a club that enabled `scopes` counts a host offered under `scope`. */
export function hostScopeEnabled(
  scopes: AdultMemberHostScopeSet,
  scope: AdultMemberHostScope,
): boolean {
  switch (scope) {
    case "SAME_BOOKING":
      return scopes.sameBooking;
    case "SAME_BOOKING_OWNER":
      return scopes.sameBookingOwner;
    case "SAME_GROUP_TRIP":
      return scopes.sameGroupTrip;
  }
}

/**
 * The MATERIAL IDENTITY of one hazard, as a string.
 *
 * Exactly: the policy row, its revision, and the uncovered guest-night pairs in
 * the evaluator's deterministic order. Everything else a snapshot carries — a
 * renamed guest, a night that gained a second host, the qualifying-host lists,
 * the message — is evidence ABOUT the hazard rather than the hazard itself.
 *
 * ONE DEFINITION, TWO CONSUMERS, which is why it is extracted rather than
 * written twice. `adultMemberHostingReviewChanged` decides whether an officer's
 * existing decision still applies; #2576's compliance incident decides whether it
 * is looking at "the materially identical uncovered state" (§16) and whether the
 * booking owner has already been told about it. Those two must agree, or a
 * reconciliation that correctly leaves a decided review alone would still send a
 * fresh loss-of-cover email about a problem the member already knows about.
 */
export function adultMemberHostingStateKey(
  violation: AdultMemberHostingPolicyExceptionViolation,
): string {
  return [
    violation.policyId,
    String(violation.policyVersion),
    ...violation.requirements.uncovered.map(
      (row) => `${row.night} ${row.guestRef}`,
    ),
  ].join("|");
}

/**
 * Has the hazard materially changed between two snapshots?
 *
 * "Materially" is `adultMemberHostingStateKey`: a different policy row or
 * revision, or a different set of uncovered guest-nights. Everything else — a
 * renamed guest, a night that gained a second host, the qualifying-host lists —
 * is evidence about the same hazard and must not reopen a review an admin already
 * decided.
 *
 * `null` means "no hazard". null -> violation is a change (a new hazard
 * appeared); violation -> null is a change (it cleared).
 */
export function adultMemberHostingReviewChanged(
  previous: AdultMemberHostingPolicyExceptionViolation | null,
  next: AdultMemberHostingPolicyExceptionViolation | null,
): boolean {
  if (previous === null || next === null) return previous !== next;
  return (
    adultMemberHostingStateKey(previous) !== adultMemberHostingStateKey(next)
  );
}

/** Officer-facing label for one host scope, matching the settings checkboxes. */
export const ADULT_MEMBER_HOST_SCOPE_LABELS: Record<
  AdultMemberHostScope,
  string
> = {
  SAME_BOOKING: "Eligible adult member on the same booking",
  SAME_BOOKING_OWNER: "Another booking on the same account",
  SAME_GROUP_TRIP: "Another booking in the same Group Trip",
};

/**
 * The administrator-facing sentence under each checkbox (#2576 §12, the owner's
 * suggested wording). Beside the labels rather than in the component, because the
 * config-transfer guide and the settings card have to describe one scope set in one
 * set of words.
 */
export const ADULT_MEMBER_HOST_SCOPE_DESCRIPTIONS: Record<
  AdultMemberHostScope,
  string
> = {
  SAME_BOOKING:
    "Count a qualifying adult member who is staying on the booking itself for " +
    "the nights they are there.",
  SAME_BOOKING_OWNER:
    "Allow a qualifying adult member on another confirmed booking owned by the " +
    "same member account to provide coverage for the same lodge and nights.",
  SAME_GROUP_TRIP:
    "Allow a qualifying adult member on another confirmed booking in the same " +
    "Group Trip to provide coverage for the same lodge and nights, even when " +
    "that booking belongs to a different member. Off unless you turn it on.",
};

/**
 * The plain-English preview of a resolved policy (#2569 §16).
 *
 * One sentence for the consequence and one clause for the coverage, built from
 * the SAME resolved values the evaluator uses, so the preview cannot claim
 * something the rule does not do. Shared between the admin card and its tests
 * rather than written into the component, because a preview that drifts from the
 * rule is worse than no preview.
 */
export function describeAdultMemberHostingPolicy(
  mode: EffectiveAdultMemberHostingMode,
  scopes: AdultMemberHostScopeSet,
): string {
  if (mode === "DISABLED") {
    return "This lodge does not require non-member guests to be covered by an adult member.";
  }
  const consequence =
    mode === "ENFORCED"
      ? "This lodge stops bookings where non-member guests are not covered"
      : "This lodge allows the booking but sends it to a Booking Officer where non-member guests are not covered";
  return `${consequence}. Coverage may be supplied by ${describeHostScopes(scopes)}.`;
}
