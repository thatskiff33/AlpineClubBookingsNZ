import type {
  PaidUpAdultMemberPolicyExceptionViolation,
  ResolvedPolicyScope,
} from "@/lib/booking-policy-exceptions";
import {
  participantQualifiesAsHost,
  type HostingMemberFacts,
} from "@/lib/policies/adult-member-hosting";

/**
 * Subscription-lockout booking pricing + paid-up-adult presence (#2533).
 *
 * OWNER DECISION (2 Aug 2026), extending the #2364 lapsed-member framing (D-R3)
 * from "not in good standing" to "not paid up":
 *
 *   > A subscription-locked member can still book for others in their family,
 *   > but if that individual's subscription is not paid they get charged
 *   > **non-member rates** (and are **told why** this is the case), and there
 *   > still has to be **at least one paid-up adult member on the booking**.
 *
 * This module is the PURE evaluator for that rule, deliberately mirroring
 * `policies/adult-member-hosting.ts`: it takes already-loaded facts and returns
 * decisions and member-facing sentences. It performs no I/O, so it is
 * deterministic and directly testable, and the decision about WHICH client reads
 * the facts belongs to the booking paths that consume it.
 *
 * THE RELATIONSHIP TO #2364 IS DELIBERATE, NOT INCIDENTAL. #2364 already treats a
 * lapsed member (inactive/cancelled/archived) as a non-member for hosting: they
 * cannot host, and their own nights need hosting. #2533 adds the second half of
 * the same idea on the money axis — a member who is in good standing but whose
 * season subscription is unpaid is, for PRICING, treated as a non-member, and for
 * the "responsible adult present" test does not count as a qualifying adult.
 * `participantQualifiesAsHost` (the #2364 predicate) is REUSED here rather than
 * re-derived, so the standing/adult/operationally-present half can never drift;
 * #2533 only ANDs the subscription-settled fact on top.
 *
 * ENFORCEMENT IS NOW WIRED (#2543), UNDER ONE CLUB SETTING. The club's
 * `MembershipLockoutSettings.mode` picks between three regimes:
 *
 *  - `NO_BLOCK` — no subscription gate at all;
 *  - `HARD_BLOCK` — the historical 403 on the create, confirm-draft, group-join,
 *    guest-add and modify paths. The migration-safe DEFAULT, so no club moved;
 *  - `NON_MEMBER_PRICING` — this module's rule: the unpaid member is repriced,
 *    told why, and the booking must contain a paid-up adult member.
 *
 * This module stays PURE. It decides, it does not enforce: the mode is resolved
 * by `member-subscription-eligibility.ts`, the facts are loaded by
 * `subscription-lockout-facts.ts`, and `subscription-lockout-enforcement.ts` is
 * the one place the five booking write paths call. See
 * `docs/invariants/subscription-lockout-pricing.md` — the `INV-LOCKOUT` rules,
 * of which `INV-LOCKOUT-001` is the owner decision this module implements.
 */

// ---------------------------------------------------------------------------
// Requirement 1 — an unpaid member's own nights price at non-member rates.
// ---------------------------------------------------------------------------

export interface UnpaidSubscriptionPricingFacts {
  /**
   * The guest is a member (the pricing-time snapshot). A true non-member is not
   * this rule's concern — they already price at non-member rates.
   */
  isMember: boolean;
  /**
   * The booking-time subscription gate says this member owes a paid subscription
   * for the season (the result of `requiresPaidSubscriptionForMemberForBooking`,
   * which already folds in the Xero-off bypass, the membership-type opt-outs and
   * the per-age-tier rule). False means the lockout does not apply to them, so
   * their rate is never forced.
   */
  subscriptionRequired: boolean;
  /**
   * A PAID subscription row exists for the season (or a NOT_REQUIRED row
   * dominates). When `subscriptionRequired` is true and this is false, the member
   * is the "subscription-locked" case the owner's rule is about.
   */
  subscriptionPaid: boolean;
}

/**
 * Whether this member's nights must price at the built-in NON_MEMBER rate because
 * their season subscription is required but unpaid.
 *
 * Returns false for a non-member (they are already non-member-priced), for a
 * member the lockout does not apply to, and for a paid-up member. The caller
 * turns a `true` into the existing `rateSource: "TYPE_POLICY_FORCED"` →
 * NON_MEMBER resolution (`resolveGuestRateMembershipTypes`), which already routes
 * the correct non-member Xero item code, so no new pricing or invoicing path is
 * introduced.
 */
export function memberUnpaidSubscriptionForcesNonMemberRate(
  facts: UnpaidSubscriptionPricingFacts,
): boolean {
  return (
    facts.isMember === true &&
    facts.subscriptionRequired === true &&
    facts.subscriptionPaid === false
  );
}

// ---------------------------------------------------------------------------
// Requirement 3 — at least one paid-up adult member on the booking.
// ---------------------------------------------------------------------------

/**
 * The facts a participant is judged by for the paid-up-adult presence test. The
 * `member`/`operationallyPresent` pair is exactly `participantQualifiesAsHost`'s
 * input (#2364), reused verbatim; `subscriptionSettled` is the one fact #2533
 * adds.
 */
export interface PaidUpAdultParticipant {
  /** Resolved live Member row, or null for a non-member / unresolved guest. */
  member: HostingMemberFacts | null;
  /**
   * Whether this row is operationally present at the lodge (D-12). Absent means
   * present, matching #2364 — the pre-persist create path has no consent facts
   * yet and every other participant is a row that really is coming.
   */
  operationallyPresent?: boolean;
  /**
   * Whether this member's season subscription is settled: PAID, or the season
   * gate says a subscription is not required for them. False for a member who
   * owes an unpaid subscription. Only consulted once the #2364 host predicate
   * already passes, so a lapsed or non-member participant is excluded on standing
   * before this fact is even read.
   */
  subscriptionSettled: boolean;
}

/**
 * Whether this participant is a paid-up adult member: a qualifying #2364 host
 * (active, present, ADULT, in good standing) whose subscription is ALSO settled.
 *
 * The two dimensions are ANDed deliberately. A lapsed adult with a paid
 * subscription fails the standing half (via `participantQualifiesAsHost`); a
 * paid-up-membership adult whose *subscription* is unpaid fails the money half.
 * Only somebody clear on both counts is the "paid-up adult member" the owner's
 * rule requires to be present.
 */
export function participantIsPaidUpAdultMember(
  participant: PaidUpAdultParticipant,
): boolean {
  return (
    participantQualifiesAsHost(participant) &&
    participant.subscriptionSettled === true
  );
}

export interface PaidUpAdultPresenceResult {
  /** True when at least one participant is a paid-up adult member. */
  hasPaidUpAdult: boolean;
  /** The member-facing refusal sentence when none is present; null otherwise. */
  refusalReason: string | null;
}

/**
 * Evaluate whether a booking party contains at least one paid-up adult member.
 *
 * This is the "there still has to be at least one paid-up adult member on the
 * booking" half of the owner's rule, expressed as a pure predicate over the
 * party. A booking with no such member is refused; the reason names the two ways
 * to fix it (renew a subscription, or add a paid-up adult member) without naming
 * anyone, keeping it safe to render straight into a booking response.
 */
export function evaluatePaidUpAdultPresence(
  participants: readonly PaidUpAdultParticipant[],
): PaidUpAdultPresenceResult {
  const hasPaidUpAdult = participants.some(participantIsPaidUpAdultMember);
  return {
    hasPaidUpAdult,
    refusalReason: hasPaidUpAdult ? null : formatMissingPaidUpAdultRefusal(),
  };
}

// ---------------------------------------------------------------------------
// Requirement 2 — tell the member why.
// ---------------------------------------------------------------------------

/**
 * The member-facing sentence explaining that an unpaid subscription removes
 * member rates. Worded to be TRUE under both the current hard-block regime (an
 * unpaid member cannot book at member rates because they cannot book at all) and
 * the decided soft regime (they are charged non-member rates), so it can be
 * surfaced today without misdescribing behaviour: it never promises a booking,
 * only states that member rates are unavailable and how to restore them.
 *
 * PARTY-SCOPED, NOT SECOND-PERSON, and that distinction is the whole point. The
 * notice is emitted whenever ANYONE on the party is being repriced, and it is
 * rendered to whoever is reading the quote — which is very often not that person.
 * A paid-up adult member booking for their adult son, whose subscription is
 * unpaid, would otherwise be told "Your subscription isn't paid" about an account
 * in perfect standing, and the plausible response is to pay a subscription they
 * do not owe or to ring the club about a debt that is not theirs.
 *
 * The privacy constraint still holds: it names nobody, because it cannot know who
 * is reading. "Names nobody" and "asserts it is the reader" are different things,
 * and this wording is the first without being the second.
 */
export function formatUnpaidSubscriptionRateReason(seasonDisplay: string): string {
  return (
    `A membership subscription on this booking isn't paid for ${seasonDisplay}, ` +
    `so member rates aren't available for those nights — renewing it restores them.`
  );
}

/**
 * The member-facing sentence refusing a booking that has no paid-up adult member
 * on it. Names neither a person nor an amount — the two escape routes only.
 */
export function formatMissingPaidUpAdultRefusal(): string {
  return (
    "This booking needs at least one paid-up adult member staying on it. " +
    "Renew a subscription, or add an adult member whose subscription is paid, " +
    "and try again."
  );
}

/**
 * The same refusal for the TWO WAITLIST paths — same-lodge `confirmWaitlistOffer`
 * and the cross-lodge promotion — which reject the offer WITHOUT consuming it.
 *
 * The extra sentence exists because the bare refusal, arriving in answer to
 * "confirm my offer", reads as though the member lost the offer AND their spot.
 * They lost neither: both paths revert the entry to WAITLISTED and keep its
 * `createdAt`, the join time its place in the queue is read from (#5402), so the
 * claim is literally true rather than reassuring padding. Worded like the two minimum-stay waitlist refusals it sits beside —
 * one short second-person sentence, appended last, saying where the member now is.
 *
 * SCOPED TO THOSE TWO PATHS, and shared between them so they cannot drift. A
 * booking-time refusal has no waitlist place to keep, so it must not claim one;
 * and one refusal that reads differently depending on which lodge the sweep
 * happened to offer is exactly the drift the shared wording exists to prevent.
 *
 * The frozen violation's own `message` is deliberately NOT changed: it is hashed
 * into exception-request snapshots and rendered to the reviewing officer, where
 * "you've kept your place on the waitlist" is neither true nor relevant. So the
 * two differ on purpose — this is the sentence the member reads, `violation.message`
 * is the sentence the policy records.
 *
 * ("...and try again" then the waitlist sentence is a slightly odd join, and it is
 * a deliberate trade: rewriting the shared sentence would move the frozen
 * violation message every booking path and every stored snapshot depends on.)
 */
export function formatMissingPaidUpAdultWaitlistRefusal(): string {
  return `${formatMissingPaidUpAdultRefusal()} You've kept your place on the waitlist.`;
}

// ---------------------------------------------------------------------------
// Requirement 3b — the refusal is exception-eligible (#2543 + #2363/#2365).
// ---------------------------------------------------------------------------

/**
 * Frozen onto the violation so a snapshot names the rule it came from.
 *
 * The subscription lockout is ONE club-wide singleton row with no per-lodge
 * override and no version column, so — unlike the minimum-stay and hosting
 * policies, which are versioned rows — the identity here is a constant. That is
 * honest rather than lazy: there is genuinely one policy, and inventing a
 * synthetic version from `updatedAt` would make two evaluations of unchanged
 * settings produce different snapshots and reopen reviews for no reason.
 * `PAID_UP_ADULT_MEMBER_POLICY_VERSION` versions the RULE SHAPE, so it moves
 * only if the rule itself is redefined.
 */
export const PAID_UP_ADULT_MEMBER_POLICY_ID = "membership-lockout-settings:default";
export const PAID_UP_ADULT_MEMBER_POLICY_VERSION = 1;
export const PAID_UP_ADULT_MEMBER_POLICY_NAME =
  "Paid-up adult member required (subscription lockout)";

/**
 * A pending admin override HOLDS the bed (owner decision 4, 2 Aug 2026).
 *
 * Not configurable, and deliberately so. The member is being refused for a
 * reason they may have no way to fix before the beds go — the club chose to
 * charge them non-member rates rather than turn them away — so making them race
 * for capacity while an admin reads their request would refuse them twice for
 * one problem. An approved override then consumes the held beds like any other
 * booking, so the club never oversells.
 */
export const PAID_UP_ADULT_MEMBER_CAPACITY_MODE = "HOLD" as const;

/**
 * Build the frozen #2363 violation for a party with no paid-up adult member.
 *
 * Pure: every field is a function of the arguments, so two evaluations of the
 * same party are byte-identical and the #2365 request machinery can freeze,
 * hash and re-evaluate it. `affectedNights` must already be canonical (sorted,
 * unique, NZ date-only `YYYY-MM-DD`) — `canonicalAffectedNights` is the shared
 * way to get there.
 */
export function buildPaidUpAdultMemberViolation(params: {
  /** Canonical, sorted, unique NZ lodge nights the party covers. */
  affectedNights: readonly string[];
  /** The lodge this club-wide rule was resolved for. */
  effectiveLodgeId: string;
  /** How many participants are being repriced as unpaid non-members. */
  repricedUnpaidMemberCount: number;
  /** Party size. */
  participantCount: number;
}): PaidUpAdultMemberPolicyExceptionViolation {
  const resolvedScope: ResolvedPolicyScope = {
    kind: "CLUB_WIDE",
    lodgeId: null,
    effectiveLodgeId: params.effectiveLodgeId,
  };
  return {
    reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED",
    policyId: PAID_UP_ADULT_MEMBER_POLICY_ID,
    policyVersion: PAID_UP_ADULT_MEMBER_POLICY_VERSION,
    policyName: PAID_UP_ADULT_MEMBER_POLICY_NAME,
    resolvedScope,
    affectedNights: [...params.affectedNights],
    requirements: {
      kind: "PAID_UP_ADULT_MEMBER",
      requiredPaidUpAdultMembers: 1,
      repricedUnpaidMemberCount: params.repricedUnpaidMemberCount,
      participantCount: params.participantCount,
    },
    exceptionEligible: true,
    capacityMode: PAID_UP_ADULT_MEMBER_CAPACITY_MODE,
    message: formatMissingPaidUpAdultRefusal(),
  };
}

/** Re-export so consumers can name the reused #2364 shapes from one import. */
export type { HostingMemberFacts };
